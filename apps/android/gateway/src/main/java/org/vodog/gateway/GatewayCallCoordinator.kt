package org.vodog.gateway

import android.content.Context
import android.telecom.PhoneAccountHandle
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Production adapter around the durable state machine. The shared build approval gate is closed by default. */
class GatewayCallCoordinator(
    private val context: Context,
    private val runtime: GatewayRuntimeStore,
    private val api: GatewayApi,
    private val identity: GatewayCommandIdentity,
    private val approved: () -> Boolean = { GatewayCallExecutionApproval.READY },
    private val controller: GatewayTelecomController = AndroidGatewayTelecomController(context),
    private val commandJournal: CallCommandRepository = CallExecutionJournal(context),
    private val callJournal: DeviceCallJournal = DeviceCallJournal(context),
    private val mediaPrepared: () -> Boolean = { false },
    private val replayStore: GatewayReplayHorizonStore? = null,
) {
    private val bindings = GatewaySimBindingStore(context)
    private val outbox = CallAckOutbox(context, identity)
    /** S73i: server call IDs whose dial this coordinator (one heartbeat cycle) cancelled before placing it. */
    private val cancelledDials = mutableSetOf<String>()

    /** [hangupCallIds]: server call IDs with a hangup in the same command batch (S73i dial cancellation). */
    suspend fun handle(command: GatewayCommand, hangupCallIds: Set<String> = emptySet()): Boolean {
        val spec = try {
            CallCommandSpec.from(command)
        } catch (error: Exception) {
            if (command.kind != "hangup") throw error
            hangupSpecAllowingMissingDeviceCall(command) ?: throw error
        }
        if (!commandOwnerFenceAllows(
                runtime.enabled, runtime.activeCommandIdentity(), identity, spec.generation,
            )) return false
        if (spec.reconciliationOnly) {
            if (!callCommandFenceAllows(runtime.enabled, runtime.deviceEpoch, spec.generation)) return false
        } else if (!approved()) return false
        val machine = CallCommandMachine(commandJournal,
            cancellingDialValidator(hangupCallIds, cancelledDials, ::validate), ::applyEffect,
            beforeEffect = { replayStore?.markEffectStarted(it.commandId) })
        val decision = machine.execute(spec)
        if (spec.kind == CallCommandKind.DIAL && decision == CallExecutionDecision.Rejected(DIAL_CANCELLED_REASON) &&
            spec.serverCallId in cancelledDials) {
            GatewayDiag.log("dial.cancelled", mapOf("commandId" to spec.commandId), callId = spec.serverCallId)
        }
        if (decision is CallExecutionDecision.Deferred) return false
        outbox.enqueue(spec, decision, commandReplayFingerprint(identity.gatewayId, command))
        flushAcks()
        return true
    }

    fun flushAcks() {
        if (!commandOwnerFenceAllows(
                runtime.enabled, runtime.activeCommandIdentity(), identity, identity.generation,
            )) return
        var lastFailure: Exception? = null
        outbox.pending().forEach { ack ->
            try {
                commitCallAckDelivery(
                    ack = ack,
                    send = {
                        api.ackCallCommand(
                            ack.commandId,
                            ack.generation,
                            ack.status,
                            ack.result.toJson(),
                            ack.telecomState,
                            ack.replayFingerprint?.let { ReplayAckEvidence(ack.sequence, it) },
                            if (ack.replayFingerprint != null) replayStore else null,
                            ack.callId,
                        )
                    },
                    markEvidence = {
                        commandJournal.markAckDelivered(
                            ack.commandId,
                            ack.generation,
                            ack.commandFingerprint,
                            Instant.now().toString(),
                        )
                    },
                    removeOutbox = { outbox.markDelivered(ack.commandId) },
                )
            } catch (error: Exception) {
                outbox.markFailure(ack.commandId, classifyAckFailure(error))
                lastFailure = error
            }
        }
        lastFailure?.let { throw it }
    }

    private fun validate(spec: CallCommandSpec): CallValidation {
        if (!approved()) return CallValidation.Rejected("call_execution_not_approved")
        if (!runtime.enabled) return CallValidation.Rejected("control_disabled")
        if (spec.kind != CallCommandKind.HANG_UP && !mediaPrepared()) return CallValidation.Rejected("audio_handoff_not_ready")
        if (runtime.deviceEpoch != spec.generation) return CallValidation.Rejected("generation_mismatch")
        val deviceCallId = if (spec.kind == CallCommandKind.HANG_UP) {
            resolveHangupDeviceCallId(spec, callJournal.recordsForSnapshot())
                ?: return CallValidation.Rejected("call_not_found")
        } else spec.deviceCallId
        val gate = SystemTelecomGateState(context).read()
        val policyState = when (spec.kind) {
            CallCommandKind.ANSWER -> ActualTelecomState.RINGING
            CallCommandKind.HANG_UP -> ActualTelecomState.ACTIVE
            CallCommandKind.DIAL -> null
        }
        TelecomActionPolicy.authorize(spec.kind.action, gate, callPresent = true, callState = policyState).let {
            if (it is TelecomActionResult.Rejected) return CallValidation.Rejected(it.reason.lowercase())
        }
        return when (spec.kind) {
            CallCommandKind.DIAL -> validateDial(spec)
            CallCommandKind.ANSWER, CallCommandKind.HANG_UP -> validateExisting(spec, deviceCallId)
        }
    }

    private fun validateDial(spec: CallCommandSpec): CallValidation {
        val binding = bindings.bySimId(requireNotNull(spec.simId))
            ?: return CallValidation.Rejected("sim_not_found")
        if (!binding.routable || binding.phoneAccountHandle == null) {
            return CallValidation.Rejected("sim_not_routable")
        }
        val sims = DeviceStatusReader(context).activeSims().filter { sim ->
            sim.subscriptionId == binding.subscriptionId &&
                sim.iccidFingerprint == binding.iccidFingerprint &&
                sim.protectedPhoneAccountHandle == binding.phoneAccountHandle && sim.phoneAccountHandle != null
        }
        if (sims.size != 1) return CallValidation.Rejected("phone_account_not_unique")
        return CallValidation.Allowed(FrozenCallTarget.Dial(
            binding.simId, binding.assignmentVersion, binding.subscriptionId,
            binding.phoneAccountHandle, binding.iccidFingerprint,
        ))
    }

    private fun validateExisting(spec: CallCommandSpec, deviceCallId: String?): CallValidation {
        if (deviceCallId.isNullOrBlank()) return CallValidation.Rejected("call_not_found")
        val record = callJournal.find(deviceCallId) ?: return CallValidation.Rejected("call_not_found")
        if (record.serverCallId != spec.serverCallId) return CallValidation.Rejected("call_mapping_mismatch")
        val actual = controller.actualState(deviceCallId)
            ?: return if (record.state == DeviceCallState.ENDED) {
                CallValidation.Rejected("call_already_ended")
            } else {
                CallValidation.Deferred("telecom_call_not_registered")
            }
        return CallValidation.Allowed(FrozenCallTarget.Existing(deviceCallId, spec.serverCallId, actual.state))
    }

    private suspend fun applyEffect(spec: CallCommandSpec, target: FrozenCallTarget): CallEffectResult = when (target) {
        is FrozenCallTarget.Dial -> {
            val phoneAccount = resolvePhoneAccount(target)
                ?: return CallEffectResult.Rejected("phone_account_not_unique")
            val reservation = callJournal.reserveOutgoing(
                spec.serverCallId, target.protectedPhoneAccountHandle,
                requireNotNull(spec.remoteNumber), spec.expiresAt,
            )
            controller.dial(spec.remoteNumber, phoneAccount).also { outcome ->
                if (outcome is TelecomActionResult.Rejected) callJournal.markEnded(reservation.deviceCallId)
            }.toEffect(reservation.deviceCallId, ActualTelecomState.DIALING)
        }
        is FrozenCallTarget.Existing -> when (spec.kind) {
            CallCommandKind.ANSWER -> {
                // Durable before Telecom accepts: the call may reach ACTIVE - and the media
                // reconcile may read the record - before this coroutine resumes.
                callJournal.markAnswerRoute(target.deviceCallId, spec.answeredByAi)
                controller.answer(target.deviceCallId)
                    .toEffect(target.deviceCallId, ActualTelecomState.RINGING)
            }
            CallCommandKind.HANG_UP -> controller.hangUp(target.deviceCallId).also { outcome ->
                // A HANG_UP on a RINGING call is the decline; there is no separate reject command.
                if (outcome is TelecomActionResult.Executed) GatewayDiag.localEnd(target.deviceCallId,
                    spec.serverCallId, "command_hangup", mapOf("commandId" to spec.commandId, "state" to target.state.name))
            }.toEffect(target.deviceCallId, target.state)
            CallCommandKind.DIAL -> CallEffectResult.Rejected("call_target_mismatch")
        }
    }

    private fun resolvePhoneAccount(target: FrozenCallTarget.Dial): PhoneAccountHandle? =
        DeviceStatusReader(context).activeSims().filter { sim ->
            sim.subscriptionId == target.subscriptionId && sim.iccidFingerprint == target.iccidFingerprint &&
                sim.protectedPhoneAccountHandle == target.protectedPhoneAccountHandle
        }.mapNotNull(SimSnapshot::phoneAccountHandle).singleOrNull()
}

/**
 * S73i: Control queues a hangup with `deviceCallId:null` when the user cancels before the dial ACK
 * reached it. The dial's own reservation already maps that server call ID to the Telecom call, so the
 * hangup targets it instead of answering `call_not_found` while the callee keeps ringing.
 */
internal fun resolveHangupDeviceCallId(spec: CallCommandSpec, records: List<DeviceCallRecord>): String? =
    spec.deviceCallId?.takeIf(String::isNotBlank) ?: records.filter { it.serverCallId == spec.serverCallId }
        .let { matches -> matches.lastOrNull { it.state != DeviceCallState.ENDED } ?: matches.lastOrNull() }
        ?.deviceCallId

/** In Control's `safeNoEffectReasons` (replay-horizon.ts), so the cancelled dial never blocks the replay horizon. */
internal const val DIAL_CANCELLED_REASON = "call_already_ended"

/**
 * S73i: a dial whose hangup is already in the same batch is rejected before any effect (not placed),
 * and that hangup is then answered `call_already_ended` instead of `call_not_found`. Replays never reach
 * the validator (the journal answers first), so both ACKs stay idempotent.
 */
internal fun cancellingDialValidator(
    hangupCallIds: Set<String>,
    cancelledDials: MutableSet<String>,
    validate: (CallCommandSpec) -> CallValidation,
): (CallCommandSpec) -> CallValidation = { spec ->
    when {
        spec.kind == CallCommandKind.DIAL && spec.serverCallId in hangupCallIds -> {
            cancelledDials += spec.serverCallId
            CallValidation.Rejected(DIAL_CANCELLED_REASON)
        }
        spec.kind == CallCommandKind.HANG_UP && spec.serverCallId in cancelledDials ->
            CallValidation.Rejected(DIAL_CANCELLED_REASON)
        else -> validate(spec)
    }
}

internal fun hangupSpecAllowingMissingDeviceCall(command: GatewayCommand): CallCommandSpec? = runCatching {
    val payload = JSONObject(command.payloadJson)
    val callId = payload.optString("callId").takeIf(String::isNotBlank) ?: command.callId
    CallCommandSpec(
        command.commandId,
        requireNotNull(callId),
        command.generation,
        command.sequence,
        requireNotNull(command.expiresAt),
        CallCommandKind.HANG_UP,
        deviceCallId = payload.optString("deviceCallId").takeIf(String::isNotBlank),
    )
}.getOrNull()

internal fun callCommandFenceAllows(runtimeEnabled: Boolean, deviceEpoch: Long, commandGeneration: Long) =
    runtimeEnabled && deviceEpoch > 0 && deviceEpoch == commandGeneration

internal fun commandOwnerFenceAllows(
    runtimeEnabled: Boolean,
    active: GatewayCommandIdentity?,
    owner: GatewayCommandIdentity,
    commandGeneration: Long,
): Boolean = runtimeEnabled && active == owner && commandGeneration == owner.generation

internal fun commitCallAckDelivery(
    ack: PendingCallAck,
    send: () -> Unit,
    markEvidence: (PendingCallAck) -> Unit,
    removeOutbox: (PendingCallAck) -> Unit,
) {
    send()
    markEvidence(ack)
    removeOutbox(ack)
}

private val CallCommandKind.action get() = when (this) {
    CallCommandKind.DIAL -> TelecomAction.DIAL
    CallCommandKind.ANSWER -> TelecomAction.ANSWER
    CallCommandKind.HANG_UP -> TelecomAction.HANG_UP
}

private fun TelecomActionResult.toEffect(deviceCallId: String, state: ActualTelecomState) = when (this) {
    TelecomActionResult.Executed -> CallEffectResult.Submitted(deviceCallId, state)
    is TelecomActionResult.Rejected -> CallEffectResult.Rejected(reason)
    is TelecomActionResult.Unknown -> CallEffectResult.Unknown(reason)
}

data class PendingCallAck(
    val commandId: String,
    val generation: Long,
    val status: String,
    val result: CallAckResult,
    val telecomState: String?,
    val attemptCount: Int = 0,
    val lastFailureCode: String? = null,
    val commandFingerprint: String? = null,
    val sequence: Long = 0,
    val replayFingerprint: String? = null,
    /** S75: diag only (`command.ack_failed`); not part of the ACK body or [samePayload]. */
    val callId: String? = null,
)

data class CallAckResult(
    val phase: String,
    val reason: String? = null,
    val detail: String? = null,
    val executedAt: String? = null,
    val deviceCallId: String? = null,
)

/** ACK delivery is independent of Telecom execution and survives process/network interruption. */
class CallAckOutbox(context: Context, identity: GatewayCommandIdentity) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(gatewayIdentityPreferenceName("gateway_call_ack_outbox", identity), Context.MODE_PRIVATE)

    fun enqueue(spec: CallCommandSpec, decision: CallExecutionDecision, replayFingerprint: String? = null) = synchronized(LOCK) {
        val records = read().toMutableList()
        val ack = decision.toAck(spec).copy(sequence = spec.sequence, replayFingerprint = replayFingerprint,
            callId = spec.serverCallId.takeIf(String::isNotBlank))
        records.singleOrNull { it.commandId == spec.commandId }?.let {
            check(it.samePayload(ack)) { "call ACK collision" }
            return@synchronized
        }
        records += ack
        check(records.size <= 128) { "call ACK outbox capacity exhausted" }
        write(records)
    }

    fun pending(): List<PendingCallAck> = synchronized(LOCK) { read() }
    fun markDelivered(commandId: String) = synchronized(LOCK) { write(read().filterNot { it.commandId == commandId }) }
    fun markFailure(commandId: String, code: String) = synchronized(LOCK) {
        write(read().map { if (it.commandId == commandId) it.copy(
            attemptCount = (it.attemptCount + 1).coerceAtMost(Int.MAX_VALUE), lastFailureCode = code,
        ) else it })
    }

    private fun read(): List<PendingCallAck> = try {
        val array = JSONArray(prefs.getString("records", "[]"))
        List(array.length()) { index -> array.getJSONObject(index).let { item -> PendingCallAck(
            item.getString("commandId"), item.getLong("generation"), item.getString("status"),
            item.getJSONObject("result").toCallAckResult(),
            if (item.isNull("telecomState")) null else item.getString("telecomState").takeIf(String::isNotBlank),
            item.optInt("attemptCount"),
            if (item.isNull("lastFailureCode")) null else item.optString("lastFailureCode").takeIf(String::isNotBlank),
            if (item.isNull("commandFingerprint")) null else item.optString("commandFingerprint").takeIf(String::isNotBlank),
            item.optLong("sequence"),
            if (item.isNull("replayFingerprint")) null else item.optString("replayFingerprint").takeIf(String::isNotBlank),
            if (item.isNull("callId")) null else item.optString("callId").takeIf(String::isNotBlank),
        ) } }
    } catch (_: Exception) { throw IllegalStateException("call ACK outbox is unreadable") }

    private fun write(records: List<PendingCallAck>) {
        val array = JSONArray(); records.forEach { ack -> array.put(JSONObject()
            .put("commandId", ack.commandId).put("generation", ack.generation).put("status", ack.status)
            .put("result", ack.result.toJson()).put("telecomState", ack.telecomState ?: JSONObject.NULL)
            .put("attemptCount", ack.attemptCount).put("lastFailureCode", ack.lastFailureCode ?: JSONObject.NULL)
            .put("commandFingerprint", ack.commandFingerprint ?: JSONObject.NULL)
            .put("sequence", ack.sequence).put("replayFingerprint", ack.replayFingerprint ?: JSONObject.NULL)
            .put("callId", ack.callId ?: JSONObject.NULL)) }
        check(prefs.edit().putString("records", array.toString()).commit()) { "call ACK outbox commit failed" }
    }
    private companion object { val LOCK = Any() }
}

internal fun CallExecutionDecision.toAck(spec: CallCommandSpec): PendingCallAck = when (this) {
    is CallExecutionDecision.Submitted -> PendingCallAck(spec.commandId, spec.generation, "acked",
        CallAckResult("submitted", executedAt = executedAt, deviceCallId = deviceCallId), telecomState.name,
        commandFingerprint = spec.fingerprint)
    is CallExecutionDecision.Rejected -> PendingCallAck(spec.commandId, spec.generation, "rejected",
        CallAckResult("not_executed", reason = reason), null,
        commandFingerprint = spec.fingerprint.takeUnless { reason == "command_payload_collision" })
    is CallExecutionDecision.Unknown -> PendingCallAck(spec.commandId, spec.generation, "rejected",
        CallAckResult("unknown", "execution_unknown", reason, effectStartedAt),
        ActualTelecomState.UNKNOWN.name, commandFingerprint = spec.fingerprint)
    is CallExecutionDecision.Deferred -> error("deferred call commands must not be ACKed")
}

private fun CallAckResult.toJson() = JSONObject().put("phase", phase)
    .put("reason", reason ?: JSONObject.NULL).put("detail", detail ?: JSONObject.NULL)
    .put("executedAt", executedAt ?: JSONObject.NULL).put("deviceCallId", deviceCallId ?: JSONObject.NULL)

private fun JSONObject.toCallAckResult() = CallAckResult(
    getString("phase"), nullableAckString("reason"), nullableAckString("detail"),
    nullableAckString("executedAt"), nullableAckString("deviceCallId"),
)

private fun JSONObject.nullableAckString(key: String) =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

private fun PendingCallAck.samePayload(other: PendingCallAck) =
    commandId == other.commandId && generation == other.generation && status == other.status &&
        result == other.result && telecomState == other.telecomState &&
        commandFingerprint == other.commandFingerprint && sequence == other.sequence &&
        replayFingerprint == other.replayFingerprint

internal fun classifyAckFailure(error: Exception): String = when {
    error.message?.startsWith("HTTP 4") == true -> "http_4xx"
    error.message?.startsWith("HTTP 5") == true -> "http_5xx"
    else -> "transport_failure"
}

internal fun pendingCallAckRoundTripFields(ack: PendingCallAck): Map<String, String?> = mapOf(
    "commandId" to ack.commandId,
    "generation" to ack.generation.toString(),
    "status" to ack.status,
    "phase" to ack.result.phase,
    "reason" to ack.result.reason,
    "detail" to ack.result.detail,
    "executedAt" to ack.result.executedAt,
    "deviceCallId" to ack.result.deviceCallId,
    "telecomState" to ack.telecomState,
    "attemptCount" to ack.attemptCount.toString(),
    "lastFailureCode" to ack.lastFailureCode,
    "commandFingerprint" to ack.commandFingerprint,
    "sequence" to ack.sequence.toString(),
    "replayFingerprint" to ack.replayFingerprint,
    "callId" to ack.callId,
)

internal fun pendingCallAckFromRoundTripFields(fields: Map<String, String?>) = PendingCallAck(
    requireNotNull(fields["commandId"]), requireNotNull(fields["generation"]).toLong(),
    requireNotNull(fields["status"]), CallAckResult(
        requireNotNull(fields["phase"]), fields["reason"], fields["detail"],
        fields["executedAt"], fields["deviceCallId"],
    ), fields["telecomState"], requireNotNull(fields["attemptCount"]).toInt(), fields["lastFailureCode"],
    fields["commandFingerprint"], fields["sequence"]?.toLong() ?: 0L, fields["replayFingerprint"], fields["callId"],
)
