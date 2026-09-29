package org.vodog.gateway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.Call
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telecom.VideoProfile
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.IdentityHashMap
import java.util.UUID

enum class TelecomAction { DIAL, ANSWER, HANG_UP }
enum class ActualTelecomState { NEW, DIALING, RINGING, CONNECTING, ACTIVE, HOLDING, DISCONNECTING, DISCONNECTED, UNKNOWN }

data class TelecomCallSnapshot(
    val localId: String,
    val state: ActualTelecomState,
    val phoneAccountId: String?,
)

sealed interface TelecomActionResult {
    data object Executed : TelecomActionResult
    data class Rejected(val reason: String) : TelecomActionResult
    /** The Telecom call may have observed the request. The caller must never retry the side effect. */
    data class Unknown(val reason: String) : TelecomActionResult
}

data class TelecomGateState(
    val controlEnabled: Boolean,
    val privilegedTelephony: Boolean,
    val callPhoneGranted: Boolean,
    val answerPhoneCallsGranted: Boolean,
)

object TelecomActionPolicy {
    fun authorize(
        action: TelecomAction,
        gate: TelecomGateState,
        callPresent: Boolean = true,
        callState: ActualTelecomState? = null,
    ): TelecomActionResult = when {
        !gate.controlEnabled -> TelecomActionResult.Rejected("CONTROL_DISABLED")
        !gate.privilegedTelephony -> TelecomActionResult.Rejected("TELECOM_PRIVILEGE_MISSING")
        action == TelecomAction.DIAL && !gate.callPhoneGranted -> TelecomActionResult.Rejected("CALL_PHONE_MISSING")
        action == TelecomAction.ANSWER && !gate.answerPhoneCallsGranted -> TelecomActionResult.Rejected("ANSWER_PHONE_CALLS_MISSING")
        action != TelecomAction.DIAL && !callPresent -> TelecomActionResult.Rejected("CALL_NOT_FOUND")
        action == TelecomAction.ANSWER && callState != ActualTelecomState.RINGING ->
            TelecomActionResult.Rejected("CALL_NOT_RINGING")
        action == TelecomAction.HANG_UP && callState in setOf(
            ActualTelecomState.DISCONNECTING, ActualTelecomState.DISCONNECTED,
        ) -> TelecomActionResult.Rejected("CALL_NOT_ACTIONABLE")
        else -> TelecomActionResult.Executed
    }
}

interface GatewayTelecomController {
    suspend fun dial(dialNumber: String, phoneAccount: PhoneAccountHandle): TelecomActionResult
    suspend fun answer(localCallId: String): TelecomActionResult
    suspend fun hangUp(localCallId: String): TelecomActionResult
    fun actualState(): List<TelecomCallSnapshot>
    fun actualState(localCallId: String): TelecomCallSnapshot?
}

class AndroidGatewayTelecomController(
    private val context: Context,
    private val gateState: () -> TelecomGateState = { SystemTelecomGateState(context).read() },
) : GatewayTelecomController {
    private val telecom = context.getSystemService(TelecomManager::class.java)
    private val telephony = context.getSystemService(TelephonyManager::class.java)

    override suspend fun dial(dialNumber: String, phoneAccount: PhoneAccountHandle): TelecomActionResult {
        val authorized = TelecomActionPolicy.authorize(TelecomAction.DIAL, gateState())
        if (authorized !is TelecomActionResult.Executed) return authorized
        GatewayDialNumberPolicy.rejectionReason(dialNumber, isEmergency = false)
            ?.let { return TelecomActionResult.Rejected(it) }
        if (!hasUniquePhoneAccount(phoneAccount)) {
            return TelecomActionResult.Rejected("PHONE_ACCOUNT_NOT_UNIQUE")
        }
        if (isEmergencyNumber(dialNumber, phoneAccount)) {
            return TelecomActionResult.Rejected("EMERGENCY_NUMBER_BLOCKED")
        }
        return withContext(Dispatchers.Main.immediate) {
            val finalAuthorization = TelecomActionPolicy.authorize(TelecomAction.DIAL, gateState())
            if (finalAuthorization !is TelecomActionResult.Executed) return@withContext finalAuthorization
            GatewayDialNumberPolicy.rejectionReason(dialNumber, isEmergency = false)
                ?.let { return@withContext TelecomActionResult.Rejected(it) }
            if (!hasUniquePhoneAccount(phoneAccount)) {
                return@withContext TelecomActionResult.Rejected("PHONE_ACCOUNT_NOT_UNIQUE")
            }
            if (isEmergencyNumber(dialNumber, phoneAccount)) {
                return@withContext TelecomActionResult.Rejected("EMERGENCY_NUMBER_BLOCKED")
            }
            try {
                telecom.placeCall(
                    Uri.fromParts("tel", dialNumber, null),
                    Bundle().apply { putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, phoneAccount) },
                )
                TelecomActionResult.Executed
            } catch (_: SecurityException) {
                TelecomActionResult.Rejected("TELECOM_PERMISSION_REVOKED")
            } catch (_: RuntimeException) {
                TelecomActionResult.Unknown("TELECOM_REQUEST_RESULT_UNKNOWN")
            }
        }
    }

    private fun hasUniquePhoneAccount(phoneAccount: PhoneAccountHandle): Boolean = try {
        telecom.callCapablePhoneAccounts.count { it == phoneAccount } == 1
    } catch (_: SecurityException) {
        false
    }

    private fun isEmergencyNumber(number: String, phoneAccount: PhoneAccountHandle): Boolean {
        if (GatewayDialNumberPolicy.isEmergencyFallback(number)) return true
        val subscriptionIds = runCatching {
            DeviceStatusReader(context).activeSims()
                .filter { it.phoneAccountHandle == phoneAccount }
                .map(SimSnapshot::subscriptionId)
                .distinct()
        }.getOrElse { return true }
        if (subscriptionIds.size != 1) return true
        return runCatching {
            telephony.createForSubscriptionId(subscriptionIds.single()).isEmergencyNumber(number)
        }.getOrDefault(true)
    }

    override suspend fun answer(localCallId: String): TelecomActionResult = actOnCall(
        TelecomAction.ANSWER, localCallId
    ) { it.answer(VideoProfile.STATE_AUDIO_ONLY) }

    override suspend fun hangUp(localCallId: String): TelecomActionResult = actOnCall(
        TelecomAction.HANG_UP, localCallId, Call::disconnect
    )

    override fun actualState(localCallId: String): TelecomCallSnapshot? =
        GatewayTelecomCallRegistry.snapshot(localCallId)

    override fun actualState(): List<TelecomCallSnapshot> = GatewayTelecomCallRegistry.snapshots()

    private suspend fun actOnCall(
        action: TelecomAction,
        localCallId: String,
        operation: (Call) -> Unit,
    ): TelecomActionResult {
        val initial = GatewayTelecomCallRegistry.snapshot(localCallId)
        val authorized = TelecomActionPolicy.authorize(action, gateState(), initial != null, initial?.state)
        if (authorized !is TelecomActionResult.Executed) return authorized
        return withContext(Dispatchers.Main.immediate) {
            val currentCall = GatewayTelecomCallRegistry.call(localCallId)
            val currentState = currentCall?.actualState()
            val finalAuthorization = TelecomActionPolicy.authorize(
                action, gateState(), currentCall != null, currentState,
            )
            if (finalAuthorization !is TelecomActionResult.Executed) return@withContext finalAuthorization
            try {
                operation(requireNotNull(currentCall))
                TelecomActionResult.Executed
            } catch (_: SecurityException) {
                TelecomActionResult.Rejected("TELECOM_PERMISSION_REVOKED")
            } catch (_: RuntimeException) {
                TelecomActionResult.Unknown("TELECOM_REQUEST_RESULT_UNKNOWN")
            }
        }
    }

}

internal object GatewayDialNumberPolicy {
    private val E164 = Regex("^\\+[1-9][0-9]{1,14}$")
    private val DOMESTIC_OR_SERVICE = Regex("^[0-9]{3,15}$")
    private val EMERGENCY_FALLBACK = setOf("112", "911")

    fun hasAllowedSyntax(number: String): Boolean =
        E164.matches(number) || DOMESTIC_OR_SERVICE.matches(number)

    fun isEmergencyFallback(number: String): Boolean = number in EMERGENCY_FALLBACK

    fun rejectionReason(number: String, isEmergency: Boolean): String? = when {
        !hasAllowedSyntax(number) -> "REMOTE_NUMBER_INVALID"
        isEmergency || isEmergencyFallback(number) -> "EMERGENCY_NUMBER_BLOCKED"
        else -> null
    }
}

class SystemTelecomGateState(private val context: Context) {
    fun read() = TelecomGateState(
        controlEnabled = GatewayRuntimeStore(context).enabled,
        privilegedTelephony = DeviceStatusReader(context).hasPrivilegedTelephonyPermissions(),
        callPhoneGranted = granted(Manifest.permission.CALL_PHONE),
        answerPhoneCallsGranted = Build.VERSION.SDK_INT < 26 || granted(Manifest.permission.ANSWER_PHONE_CALLS),
    )

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

internal object GatewayTelecomCallRegistry {
    private val callsById = linkedMapOf<String, Call>()
    private val idsByCall = IdentityHashMap<Call, String>()

    @Synchronized fun add(call: Call, deviceCallId: String = UUID.randomUUID().toString()) {
        if (idsByCall.containsKey(call)) return
        idsByCall[call] = deviceCallId
        callsById[deviceCallId] = call
    }

    @Synchronized fun stateChanged(call: Call) {
        if (!idsByCall.containsKey(call)) add(call)
    }

    @Synchronized fun remove(call: Call) {
        idsByCall.remove(call)?.let(callsById::remove)
    }

    @Synchronized fun id(call: Call): String? = idsByCall[call]

    @Synchronized fun deviceCallIds(): Set<String> = callsById.keys.toSet()

    @Synchronized fun clear() {
        callsById.clear()
        idsByCall.clear()
    }

    @Synchronized fun call(localId: String): Call? = callsById[localId]

    @Synchronized fun snapshot(localId: String): TelecomCallSnapshot? = callsById[localId]?.let { call ->
        TelecomCallSnapshot(localId, call.actualState(), call.details.accountHandle?.id)
    }

    @Synchronized fun snapshots(): List<TelecomCallSnapshot> = callsById.map { (localId, call) ->
        TelecomCallSnapshot(localId, call.actualState(), call.details.accountHandle?.id)
    }
}

private fun Call.actualState(): ActualTelecomState {
    val value = if (Build.VERSION.SDK_INT >= 31) details.state else @Suppress("DEPRECATION") state
    return when (value) {
        Call.STATE_NEW -> ActualTelecomState.NEW
        Call.STATE_DIALING -> ActualTelecomState.DIALING
        Call.STATE_RINGING -> ActualTelecomState.RINGING
        Call.STATE_CONNECTING -> ActualTelecomState.CONNECTING
        Call.STATE_ACTIVE -> ActualTelecomState.ACTIVE
        Call.STATE_HOLDING -> ActualTelecomState.HOLDING
        Call.STATE_DISCONNECTING -> ActualTelecomState.DISCONNECTING
        Call.STATE_DISCONNECTED -> ActualTelecomState.DISCONNECTED
        else -> ActualTelecomState.UNKNOWN
    }
}

internal fun PhoneAccountHandle.stableString() = "${componentName.flattenToShortString()}|$id"

internal fun Call.deviceDirection(): DeviceCallDirection = when (details.callDirection) {
    Call.Details.DIRECTION_INCOMING -> DeviceCallDirection.INCOMING
    Call.Details.DIRECTION_OUTGOING -> DeviceCallDirection.OUTGOING
    else -> DeviceCallDirection.UNKNOWN
}

internal fun Call.deviceState(): DeviceCallState = when (actualState()) {
    ActualTelecomState.RINGING -> DeviceCallState.RINGING
    ActualTelecomState.DIALING, ActualTelecomState.CONNECTING -> DeviceCallState.DIALING
    ActualTelecomState.ACTIVE, ActualTelecomState.HOLDING -> DeviceCallState.ACTIVE
    ActualTelecomState.DISCONNECTING, ActualTelecomState.DISCONNECTED -> DeviceCallState.ENDED
    else -> DeviceCallState.UNKNOWN
}

internal fun Call.remoteNumber(): String? = details.handle?.schemeSpecificPart
    ?.takeIf(String::isNotBlank)
    ?.take(MAX_REMOTE_NUMBER_LENGTH)

private const val MAX_REMOTE_NUMBER_LENGTH = 64
