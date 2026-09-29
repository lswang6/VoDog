package org.vodog.gateway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.telecom.TelecomManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.Locale

internal fun normalizedSimCountryIso(value: String?): String? = value
    ?.trim()
    ?.takeIf { it.matches(Regex("[A-Za-z]{2}")) }
    ?.uppercase(Locale.ROOT)

internal data class ResolvedSimIdentity(
    val kind: SimIdentityKind,
    val fingerprint: String,
    val legacyFingerprint: String? = null,
)

/** S65: best-effort own number for `sims/sync`; anything not matching the contract is omitted. */
internal fun normalizedSimPhoneNumber(raw: String?): String? =
    raw?.replace(Regex("[\\s-]"), "")?.takeIf { it.matches(Regex("\\+?[0-9]{3,20}")) }

internal fun describeSimIdentity(slotIndex: Int, kind: SimIdentityKind?, fingerprint: String?): String {
    val kindLabel = kind?.wire ?: "none"
    val prefix = fingerprint?.take(8).orEmpty().ifBlank { "none" }
    return "slot=$slotIndex identityKind=$kindLabel fingerprint=$prefix"
}

/** One resolved SIM as the identity log sees it: the (slot, identityKind, fingerprint) triple. */
internal data class SimIdentityLogEntry(
    val slotIndex: Int,
    val kind: SimIdentityKind?,
    val fingerprint: String?,
) {
    fun describe(): String = describeSimIdentity(slotIndex, kind, fingerprint)
}

/** At most one heartbeat summary per five minutes when nothing about the SIMs has changed. */
internal const val SIM_IDENTITY_HEARTBEAT_MS = 300_000L

/**
 * S25 decision 1: `activeSims()` runs roughly once a second on the Pixel, and the unconditional
 * per-SIM Info line it used to emit was ~86 lines/minute — enough to flush the gateway's own media
 * logs out of logcat's ring buffer before anyone could read them. This gate keeps the exact same
 * line format but only lets it through when the (slot, identityKind, fingerprint) set actually
 * differs from the last thing printed, plus one compact heartbeat every [SIM_IDENTITY_HEARTBEAT_MS]
 * so a quiet log still proves the reader is alive.
 *
 * Keyed on the whole snapshot rather than per slot, so that a SIM disappearing is a change too.
 * Pure logic with an injected clock: no android.util.Log, no SystemClock, unit-testable as is.
 * Every call site builds a fresh [DeviceStatusReader], so the single instance lives in that class's
 * companion object and is therefore shared across threads — hence the synchronization.
 */
internal class SimIdentityLogGate(private val heartbeatMs: Long = SIM_IDENTITY_HEARTBEAT_MS) {
    private var lastPrinted: List<SimIdentityLogEntry>? = null
    private var lastPrintedAtMs: Long? = null

    /** The lines to emit for this observation; empty means "identical to last time, stay quiet". */
    fun linesFor(entries: List<SimIdentityLogEntry>, nowMs: Long): List<String> = observe(entries, nowMs).second

    /** S69: the same decision, plus whether it was a change (true) rather than the periodic heartbeat. */
    @Synchronized
    fun observe(entries: List<SimIdentityLogEntry>, nowMs: Long): Pair<Boolean, List<String>> {
        val snapshot = entries.sortedBy { it.slotIndex }
        if (snapshot != lastPrinted) {
            lastPrinted = snapshot
            lastPrintedAtMs = nowMs
            // Losing the last SIM is the most drastic change of all, so it may not be the one case
            // that prints nothing; an empty description list becomes an explicit line.
            return true to snapshot.map { it.describe() }.ifEmpty { listOf(NO_SIMS_LINE) }
        }
        val since = lastPrintedAtMs?.let { nowMs - it }
        // A negative delta can only mean the caller's clock went backwards; print and re-anchor.
        if (since != null && since < heartbeatMs && since >= 0L) return false to emptyList()
        lastPrintedAtMs = nowMs
        return false to listOf(
            "heartbeat sims=${snapshot.size}" +
                snapshot.joinToString(separator = "") { " [${it.describe()}]" }
        )
    }

    private companion object {
        const val NO_SIMS_LINE = "sims=0"
    }
}

/**
 * Domain-separated identity: portable ICCID SHA-256 (S65, plus the old HMAC as legacy), else physical UICC cardId, else hashed slot+subId fallback.
 * eSIM never uses cardId (that value names the eUICC, not the profile). Privileged Pixel skips
 * fallback so a missing ICCID stays fail-closed instead of minting a slot-based id.
 */
internal fun resolveSimIdentity(
    simSerialNumber: String?,
    iccId: String?,
    cardId: Int?,
    embedded: Boolean,
    slotIndex: Int,
    subscriptionId: Int,
    fingerprint: IccidFingerprint,
    allowFallback: Boolean,
): ResolvedSimIdentity? {
    val iccid = readableIccid(simSerialNumber) ?: readableIccid(iccId)
    if (iccid != null) {
        return runCatching {
            ResolvedSimIdentity(SimIdentityKind.ICCID, portableIccidFingerprint(iccid), fingerprint.derive(iccid))
        }.getOrNull()
    }
    if (cardId != null && cardId >= 0 && !embedded) {
        return runCatching {
            ResolvedSimIdentity(SimIdentityKind.CARD_ID, fingerprint.deriveCardId(cardId))
        }.getOrNull()
    }
    if (!allowFallback) return null
    return runCatching {
        ResolvedSimIdentity(
            SimIdentityKind.FALLBACK,
            fingerprint.deriveFallback(slotIndex, subscriptionId, iccId?.hashCode() ?: 0),
        )
    }.getOrNull()
}

class DeviceStatusReader(private val context: Context) {
    fun hasPhonePermission(): Boolean = ContextCompat.checkSelfPermission(
        context, Manifest.permission.READ_PHONE_STATE
    ) == PackageManager.PERMISSION_GRANTED

    fun hasPrivilegedTelephonyPermissions(): Boolean = PRIVILEGED_PERMISSIONS.all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

    fun hasActionRuntimePermissions(): Boolean = ACTION_RUNTIME_PERMISSIONS.all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

    fun hasValidatedNetwork(): Boolean {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    @Suppress("MissingPermission")
    fun activeSims(): List<SimSnapshot> {
        if (!hasPhonePermission()) return emptyList()
        val manager = context.getSystemService(SubscriptionManager::class.java)
        val telephony = context.getSystemService(TelephonyManager::class.java)
        val telecom = context.getSystemService(TelecomManager::class.java)
        val canReadIccid = ContextCompat.checkSelfPermission(
            context, READ_PRIVILEGED_PHONE_STATE
        ) == PackageManager.PERMISSION_GRANTED
        val hmac = IccidFingerprint()
        val snapshots = manager.activeSubscriptionInfoList.orEmpty()
            .sortedBy { it.simSlotIndex }
            .map { info ->
                val subscriptionTelephony = telephony.createForSubscriptionId(info.subscriptionId)
                val handle = runCatching {
                    when {
                        Build.VERSION.SDK_INT >= 31 -> subscriptionTelephony.phoneAccountHandle
                        Build.VERSION.SDK_INT >= 30 -> telecom.callCapablePhoneAccounts.firstOrNull {
                            telephony.getSubscriptionId(it) == info.subscriptionId
                        }
                        else -> null
                    }
                }.getOrNull()
                val simSerial = if (canReadIccid) {
                    runCatching { subscriptionTelephony.simSerialNumber?.takeIf(String::isNotBlank) }.getOrNull()
                } else {
                    null
                }
                val identity = resolveSimIdentity(
                    simSerialNumber = simSerial,
                    iccId = runCatching { info.iccId }.getOrNull(),
                    cardId = runCatching { info.cardId }.getOrNull(),
                    embedded = info.isEmbedded,
                    slotIndex = info.simSlotIndex,
                    subscriptionId = info.subscriptionId,
                    fingerprint = hmac,
                    allowFallback = !canReadIccid,
                )
                val protectedPhoneAccount = handle?.let {
                    runCatching { hmac.derivePhoneAccount(it.stableString()) }.getOrNull()
                }
                SimSnapshot(
                    slotIndex = info.simSlotIndex,
                    subscriptionId = info.subscriptionId,
                    carrierName = info.carrierName?.toString().orEmpty(),
                    displayName = info.displayName?.toString().orEmpty(),
                    phoneAccountHandle = handle,
                    protectedPhoneAccountHandle = protectedPhoneAccount,
                    iccidFingerprint = identity?.fingerprint,
                    legacyIccidFingerprint = identity?.legacyFingerprint,
                    phoneNumber = normalizedSimPhoneNumber(runCatching {
                        if (Build.VERSION.SDK_INT >= 33) manager.getPhoneNumber(info.subscriptionId)
                        else @Suppress("DEPRECATION") info.number
                    }.getOrNull()),
                    countryIso = normalizedSimCountryIso(info.countryIso),
                    embedded = info.isEmbedded,
                    identityKind = identity?.kind,
                )
            }
        // S25 decision 1: same line, same content, only when it says something new.
        val (changed, lines) = SIM_IDENTITY_LOG_GATE.observe(
            snapshots.map { SimIdentityLogEntry(it.slotIndex, it.identityKind, it.iccidFingerprint) },
            SystemClock.elapsedRealtime(),
        )
        lines.forEach { Log.i(SIM_IDENTITY_TAG, it) }
        // S69: same gate as the logcat line (so also once per process start). Full number per decision 6.
        if (changed) {
            if (snapshots.isEmpty()) GatewayDiag.log("sim.changed", mapOf("sims" to 0), level = "warn")
            snapshots.forEach { sim ->
                GatewayDiag.log("sim.changed", mapOf(
                    "slot" to sim.slotIndex,
                    "subscriptionId" to sim.subscriptionId,
                    "identityKind" to sim.identityKind?.name,
                    "iccidFp" to sim.iccidFingerprint,
                    "number" to sim.phoneNumber,
                ))
            }
        }
        return snapshots
    }

    companion object {
        private const val SIM_IDENTITY_TAG = "GatewaySimIdentity"

        /** Process-wide: every call site builds a throwaway [DeviceStatusReader]. */
        private val SIM_IDENTITY_LOG_GATE = SimIdentityLogGate()
        val PRIVILEGED_PERMISSIONS = listOf(
            "android.permission.CONTROL_INCALL_EXPERIENCE",
            Manifest.permission.MODIFY_PHONE_STATE,
            Manifest.permission.CAPTURE_AUDIO_OUTPUT,
            READ_PRIVILEGED_PHONE_STATE,
        )
        val ACTION_RUNTIME_PERMISSIONS = listOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_PHONE_NUMBERS,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.ANSWER_PHONE_CALLS,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.RECORD_AUDIO,
        )
        const val READ_PRIVILEGED_PHONE_STATE = "android.permission.READ_PRIVILEGED_PHONE_STATE"
    }
}
