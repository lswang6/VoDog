package org.vodog.gateway

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Remains false until Telecom, media and BCP/BCR ownership have passed end-to-end review. */
object GatewayCallExecutionApproval {
    const val APPROVED = GatewayPhoneFeatureApproval.APPROVED
    const val MEDIA_AND_RECORDING_HANDOFF_READY = GatewayPhoneFeatureApproval.APPROVED
    const val READY = APPROVED && MEDIA_AND_RECORDING_HANDOFF_READY
}

enum class CallCommandKind { DIAL, ANSWER, HANG_UP }
enum class CallExecutionPhase { PREPARED, EFFECT_STARTED, SUBMITTED, REJECTED, UNKNOWN }
enum class CallRetentionState { FULL, TOMBSTONE }

data class CallCommandSpec(
    val commandId: String,
    val serverCallId: String,
    val generation: Long,
    val sequence: Long,
    val expiresAt: String,
    val kind: CallCommandKind,
    val simId: String? = null,
    val remoteNumber: String? = null,
    val deviceCallId: String? = null,
    /** Delivery metadata only. It is deliberately excluded from the immutable command fingerprint. */
    val reconciliationOnly: Boolean = false,
    /** Persisted tombstones may omit effect routing fields while retaining the original fingerprint. */
    val retentionRedacted: Boolean = false,
    /**
     * S22 decision 9: Control answers on the AI's behalf and tags that ANSWER with `answeredBy:"ai"`.
     *
     * It only selects a longer local media prebuffer window, so like [reconciliationOnly] it is
     * deliberately excluded from the immutable fingerprint: an in-flight command whose payload gains
     * the key must not read as a payload collision, and a journal replay that lost the key must still
     * match. The durable carrier for the media path is [DeviceCallRecord.answeredByAi], not this spec.
     */
    val answeredByAi: Boolean = false,
) {
    val fingerprint = callSha256(
        listOf(generation, sequence, expiresAt, kind, serverCallId, simId, remoteNumber, deviceCallId)
            .joinToString("\u0000"),
    )

    init {
        UUID.fromString(commandId); UUID.fromString(serverCallId)
        require(generation > 0 && sequence > 0); Instant.parse(expiresAt)
        if (retentionRedacted) {
            require(kind != CallCommandKind.DIAL || (simId == null && remoteNumber == null && deviceCallId == null))
        } else {
            when (kind) {
                CallCommandKind.DIAL -> {
                    UUID.fromString(requireNotNull(simId))
                    require(deviceCallId == null)
                }
                CallCommandKind.ANSWER -> {
                    require(!deviceCallId.isNullOrBlank()); require(simId == null && remoteNumber == null)
                }
                CallCommandKind.HANG_UP -> {
                    // Occupancy hangup of a never-bound call has a null/blank deviceCallId.
                    require(simId == null && remoteNumber == null)
                }
            }
        }
    }

    companion object {
        fun from(command: GatewayCommand): CallCommandSpec {
            val payload = JSONObject(command.payloadJson)
            val kind = when (command.kind) {
                "dial" -> CallCommandKind.DIAL
                "answer" -> CallCommandKind.ANSWER
                "hangup" -> CallCommandKind.HANG_UP
                else -> error("unsupported call command")
            }
            val callId = payload.getString("callId")
            require(command.callId == null || command.callId == callId) { "callId mismatch" }
            // Only an ANSWER carries an answer route. A dial/hangup that somehow carries the key is
            // left alone rather than thrown, so an unexpected tag can never stall the command loop.
            val answeredBy = if (kind != CallCommandKind.ANSWER || payload.isNull("answeredBy")) null else {
                payload.optString("answeredBy").takeIf(String::isNotBlank)
            }
            require(answeredBy == null || answeredBy == "ai") { "unsupported answeredBy" }
            return CallCommandSpec(
                command.commandId, callId, command.generation, command.sequence,
                requireNotNull(command.expiresAt), kind,
                payload.optString("simId").takeIf(String::isNotBlank),
                payload.optString("remoteNumber").takeIf(String::isNotBlank),
                payload.optString("deviceCallId").takeIf(String::isNotBlank),
                command.reconciliationOnly,
                answeredByAi = answeredBy == "ai",
            )
        }
    }
}

sealed interface FrozenCallTarget {
    data class Dial(
        val simId: String,
        val assignmentVersion: Int,
        val subscriptionId: Int,
        val protectedPhoneAccountHandle: String,
        val iccidFingerprint: String,
    ) : FrozenCallTarget
    data class Existing(
        val deviceCallId: String,
        val serverCallId: String,
        val state: ActualTelecomState,
    ) : FrozenCallTarget
}

sealed interface CallValidation {
    data class Allowed(val target: FrozenCallTarget) : CallValidation
    /** The durable identity is valid, but Telecom has not exposed the live Call yet. */
    data class Deferred(val reason: String) : CallValidation
    data class Rejected(val reason: String) : CallValidation
}

sealed interface CallEffectResult {
    /** Request submitted only. Connection state must come from InCallService. */
    data class Submitted(val deviceCallId: String, val telecomState: ActualTelecomState) : CallEffectResult
    data class Rejected(val reason: String) : CallEffectResult
    data class Unknown(val reason: String) : CallEffectResult
}

data class CallExecutionRecord(
    val spec: CallCommandSpec,
    val commandFingerprint: String,
    val phase: CallExecutionPhase,
    val target: FrozenCallTarget?,
    val effectStartedAt: String?,
    val deviceCallId: String?,
    val telecomState: ActualTelecomState?,
    val reason: String?,
    val ackDeliveredAt: String? = null,
    val terminalConfirmedAt: String? = null,
    val terminalEvidenceKind: String? = null,
    val terminalSnapshotId: String? = null,
    val retentionState: CallRetentionState = CallRetentionState.FULL,
    val compactedAt: String? = null,
)

sealed interface CallExecutionDecision {
    data class Submitted(val deviceCallId: String, val telecomState: ActualTelecomState, val executedAt: String) : CallExecutionDecision
    data class Rejected(val reason: String) : CallExecutionDecision
    data class Unknown(val reason: String, val effectStartedAt: String?) : CallExecutionDecision
    /** No ACK and no side effect. The PREPARED command must be retried after Telecom changes. */
    data class Deferred(val reason: String) : CallExecutionDecision
}

interface CallCommandRepository {
    fun find(commandId: String): CallExecutionRecord?
    fun prepare(spec: CallCommandSpec): CallExecutionRecord
    fun markEffectStarted(commandId: String, target: FrozenCallTarget, at: String): CallExecutionRecord
    fun markSubmitted(commandId: String, result: CallEffectResult.Submitted): CallExecutionRecord
    fun markRejected(commandId: String, reason: String): CallExecutionRecord
    fun markUnknown(commandId: String, reason: String): CallExecutionRecord
    fun markDeferred(commandId: String): CallExecutionRecord
    fun markAckDelivered(
        commandId: String,
        generation: Long,
        commandFingerprint: String?,
        at: String,
    ): CallExecutionRecord?
    fun findTerminationIntent(serverCallId: String, deviceCallId: String, excludingCommandId: String): CallExecutionRecord?
}

class CallCommandMachine(
    private val repository: CallCommandRepository,
    private val validate: (CallCommandSpec) -> CallValidation,
    private val effect: suspend (CallCommandSpec, FrozenCallTarget) -> CallEffectResult,
    private val now: () -> Instant = Instant::now,
    private val beforeEffect: (CallCommandSpec) -> Unit = {},
) {
    suspend fun execute(spec: CallCommandSpec): CallExecutionDecision = EXECUTION_LOCK.withLock {
        val prior = repository.find(spec.commandId)
        if (prior != null && prior.commandFingerprint != spec.fingerprint) {
            return@withLock CallExecutionDecision.Rejected("command_payload_collision")
        }
        var record = prior ?: repository.prepare(spec)
        if (spec.reconciliationOnly) {
            return@withLock when (record.phase) {
                CallExecutionPhase.SUBMITTED -> record.submittedDecision()
                CallExecutionPhase.REJECTED -> CallExecutionDecision.Rejected(requireNotNull(record.reason))
                CallExecutionPhase.UNKNOWN -> CallExecutionDecision.Unknown(
                    requireNotNull(record.reason),
                    record.effectStartedAt,
                )
                CallExecutionPhase.EFFECT_STARTED -> {
                    record = repository.markUnknown(spec.commandId, "PROCESS_INTERRUPTED_AFTER_EFFECT_START")
                    CallExecutionDecision.Unknown(requireNotNull(record.reason), record.effectStartedAt)
                }
                CallExecutionPhase.PREPARED -> {
                    record = repository.markRejected(spec.commandId, "command_expired")
                    CallExecutionDecision.Rejected(requireNotNull(record.reason))
                }
            }
        }
        when (record.phase) {
            CallExecutionPhase.SUBMITTED -> return@withLock record.submittedDecision()
            CallExecutionPhase.REJECTED -> return@withLock CallExecutionDecision.Rejected(requireNotNull(record.reason))
            CallExecutionPhase.UNKNOWN -> return@withLock CallExecutionDecision.Unknown(requireNotNull(record.reason), record.effectStartedAt)
            CallExecutionPhase.EFFECT_STARTED -> {
                record = repository.markUnknown(spec.commandId, "PROCESS_INTERRUPTED_AFTER_EFFECT_START")
                return@withLock CallExecutionDecision.Unknown(requireNotNull(record.reason), record.effectStartedAt)
            }
            CallExecutionPhase.PREPARED -> Unit
        }
        if (!now().isBefore(Instant.parse(spec.expiresAt))) {
            repository.markRejected(spec.commandId, "command_expired")
            return@withLock CallExecutionDecision.Rejected("command_expired")
        }
        if (spec.kind == CallCommandKind.DIAL &&
            !GatewayDialNumberPolicy.hasAllowedSyntax(spec.remoteNumber.orEmpty())) {
            return@withLock reject(spec, "remote_number_invalid")
        }
        val first = validate(spec)
        if (first is CallValidation.Deferred) return@withLock CallExecutionDecision.Deferred(first.reason)
        if (first is CallValidation.Rejected) return@withLock reject(spec, first.reason)
        val frozen = (first as CallValidation.Allowed).target
        // S73i: a hangup sent before Control saw the dial ACK carries no deviceCallId; the validator resolves
        // it from the device journal, so the frozen target (not the payload) names the Telecom call.
        if (spec.kind == CallCommandKind.HANG_UP && frozen is FrozenCallTarget.Existing) {
            repository.findTerminationIntent(
                spec.serverCallId,
                frozen.deviceCallId,
                spec.commandId,
            )?.let { priorTermination ->
                val fence = validate(spec)
                if (fence is CallValidation.Deferred) {
                    return@withLock CallExecutionDecision.Deferred(fence.reason)
                }
                if (fence !is CallValidation.Allowed || !fence.target.sameCallIdentity(frozen)) {
                    return@withLock reject(
                        spec,
                        (fence as? CallValidation.Rejected)?.reason ?: "execution_route_changed",
                    )
                }
                return@withLock reuseTerminationIntent(spec, frozen, priorTermination)
            }
        }
        validateTargetForAction(spec, frozen)?.let { return@withLock reject(spec, it) }
        val second = validate(spec)
        if (second is CallValidation.Deferred) return@withLock CallExecutionDecision.Deferred(second.reason)
        if (second !is CallValidation.Allowed || second.target != frozen) {
            return@withLock reject(spec, (second as? CallValidation.Rejected)?.reason ?: "execution_route_changed")
        }
        val startedAt = now().toString()
        repository.markEffectStarted(spec.commandId, frozen, startedAt)
        beforeEffect(spec)
        // Marker is durable before the last gate/epoch/SIM/Call check. A crash after this point is UNKNOWN.
        val finalCheck = validate(spec)
        if (finalCheck is CallValidation.Deferred) {
            repository.markDeferred(spec.commandId)
            return@withLock CallExecutionDecision.Deferred(finalCheck.reason)
        }
        if (finalCheck !is CallValidation.Allowed || finalCheck.target != frozen) {
            val reason = (finalCheck as? CallValidation.Rejected)?.reason ?: "execution_route_changed"
            repository.markRejected(spec.commandId, reason)
            return@withLock CallExecutionDecision.Rejected(reason)
        }
        when (val result = try { effect(spec, frozen) } catch (_: Exception) {
            CallEffectResult.Unknown("TELECOM_RESULT_UNKNOWN")
        }) {
            is CallEffectResult.Submitted -> {
                record = repository.markSubmitted(spec.commandId, result)
                record.submittedDecision()
            }
            is CallEffectResult.Rejected -> reject(spec, result.reason)
            is CallEffectResult.Unknown -> {
                record = repository.markUnknown(spec.commandId, result.reason)
                CallExecutionDecision.Unknown(result.reason, record.effectStartedAt)
            }
        }
    }

    private fun reject(spec: CallCommandSpec, reason: String): CallExecutionDecision.Rejected {
        repository.markRejected(spec.commandId, reason)
        return CallExecutionDecision.Rejected(reason)
    }

    private fun reuseTerminationIntent(
        spec: CallCommandSpec,
        target: FrozenCallTarget,
        prior: CallExecutionRecord,
    ): CallExecutionDecision {
        repository.markEffectStarted(spec.commandId, target, now().toString())
        return when (prior.phase) {
            CallExecutionPhase.SUBMITTED -> {
                val result = CallEffectResult.Submitted(
                    requireNotNull(prior.deviceCallId),
                    requireNotNull(prior.telecomState),
                )
                repository.markSubmitted(spec.commandId, result).submittedDecision()
            }
            CallExecutionPhase.EFFECT_STARTED, CallExecutionPhase.UNKNOWN -> {
                val reason = "PRIOR_TERMINATION_RESULT_UNKNOWN"
                val record = repository.markUnknown(spec.commandId, reason)
                CallExecutionDecision.Unknown(reason, record.effectStartedAt)
            }
            else -> error("non-terminal intent returned")
        }
    }

    private fun FrozenCallTarget.sameCallIdentity(other: FrozenCallTarget): Boolean =
        this is FrozenCallTarget.Existing && other is FrozenCallTarget.Existing &&
            deviceCallId == other.deviceCallId && serverCallId == other.serverCallId

    private fun validateTargetForAction(spec: CallCommandSpec, target: FrozenCallTarget): String? = when (spec.kind) {
        CallCommandKind.DIAL -> if (target is FrozenCallTarget.Dial && target.simId == spec.simId) null else "sim_route_mismatch"
        CallCommandKind.ANSWER -> if (target is FrozenCallTarget.Existing &&
            target.deviceCallId == spec.deviceCallId && target.serverCallId == spec.serverCallId &&
            target.state == ActualTelecomState.RINGING) null else "call_not_ringing"
        CallCommandKind.HANG_UP -> if (target is FrozenCallTarget.Existing &&
            (spec.deviceCallId == null || target.deviceCallId == spec.deviceCallId) &&
            target.serverCallId == spec.serverCallId &&
            target.state !in setOf(ActualTelecomState.DISCONNECTING, ActualTelecomState.DISCONNECTED)) null
        else "call_not_actionable"
    }

    private fun CallExecutionRecord.submittedDecision() = CallExecutionDecision.Submitted(
        requireNotNull(deviceCallId), requireNotNull(telecomState), requireNotNull(effectStartedAt),
    )

    private companion object { val EXECUTION_LOCK = Mutex() }
}

/** Device-protected command journal. Unproven records are never evicted; proven records only lose sensitive fields. */
class CallExecutionJournal(context: Context) : CallCommandRepository {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_call_execution_journal", Context.MODE_PRIVATE)

    override fun find(commandId: String) = synchronized(LOCK) { read().firstOrNull { it.spec.commandId == commandId } }

    fun migrationUnknownCount(generation: Long): Int = synchronized(LOCK) {
        read().count { record ->
            record.spec.generation == generation && when (record.phase) {
                CallExecutionPhase.PREPARED, CallExecutionPhase.EFFECT_STARTED, CallExecutionPhase.UNKNOWN -> true
                CallExecutionPhase.SUBMITTED -> record.terminalConfirmedAt == null
                CallExecutionPhase.REJECTED -> false
            }
        }
    }
    override fun prepare(spec: CallCommandSpec) = mutateOrCreate(spec.commandId) {
        CallExecutionRecord(spec, spec.fingerprint, CallExecutionPhase.PREPARED, null, null, null, null, null)
    }
    override fun markEffectStarted(commandId: String, target: FrozenCallTarget, at: String) = mutate(commandId) {
        check(it.phase == CallExecutionPhase.PREPARED); it.copy(phase = CallExecutionPhase.EFFECT_STARTED, target = target, effectStartedAt = at)
    }
    override fun markSubmitted(commandId: String, result: CallEffectResult.Submitted) = mutate(commandId) {
        check(it.phase == CallExecutionPhase.EFFECT_STARTED); it.copy(phase = CallExecutionPhase.SUBMITTED,
            deviceCallId = result.deviceCallId, telecomState = result.telecomState)
    }
    override fun markRejected(commandId: String, reason: String) = mutate(commandId) {
        check(it.phase in setOf(CallExecutionPhase.PREPARED, CallExecutionPhase.EFFECT_STARTED));
        it.copy(phase = CallExecutionPhase.REJECTED, reason = reason)
    }
    override fun markUnknown(commandId: String, reason: String) = mutate(commandId) {
        check(it.phase in setOf(CallExecutionPhase.EFFECT_STARTED, CallExecutionPhase.UNKNOWN));
        it.copy(phase = CallExecutionPhase.UNKNOWN, reason = reason)
    }
    override fun markDeferred(commandId: String) = mutate(commandId) {
        check(it.phase in setOf(CallExecutionPhase.PREPARED, CallExecutionPhase.EFFECT_STARTED))
        it.copy(phase = CallExecutionPhase.PREPARED, target = null, effectStartedAt = null)
    }
    override fun markAckDelivered(
        commandId: String,
        generation: Long,
        commandFingerprint: String?,
        at: String,
    ) = mutateMatching(commandId, generation, commandFingerprint) {
        Instant.parse(at)
        if (it.ackDeliveredAt == null) it.copy(ackDeliveredAt = at) else it
    }

    fun markTerminalConfirmed(
        serverCallIds: Set<String>,
        generation: Long,
        snapshotId: String,
        at: String,
    ) = synchronized(LOCK) {
        UUID.fromString(snapshotId)
        Instant.parse(at)
        val records = read()
        val updated = records.map { record ->
            if (record.spec.generation == generation && record.spec.serverCallId in serverCallIds &&
                record.phase in setOf(
                    CallExecutionPhase.EFFECT_STARTED,
                    CallExecutionPhase.SUBMITTED,
                    CallExecutionPhase.UNKNOWN,
                )
            ) {
                if (record.terminalConfirmedAt == null) record.copy(
                    terminalConfirmedAt = at,
                    terminalEvidenceKind = TERMINAL_CONFIRMED_ABSENT,
                    terminalSnapshotId = snapshotId,
                ) else record
            } else record
        }
        write(updated)
    }

    fun pruneBeforeCommitted(floor: Long, generation: Long) = synchronized(LOCK) {
        require(floor > 0 && generation > 0)
        val retained = read().filterNot { record ->
            record.spec.generation == generation && record.spec.sequence < floor && record.acknowledgedTerminal()
        }
        write(retained)
    }
    override fun findTerminationIntent(
        serverCallId: String,
        deviceCallId: String,
        excludingCommandId: String,
    ) = synchronized(LOCK) {
        read().firstOrNull {
            it.spec.commandId != excludingCommandId &&
                it.spec.kind == CallCommandKind.HANG_UP &&
                it.spec.serverCallId == serverCallId &&
                it.hangupDeviceCallId() == deviceCallId &&
                it.phase in setOf(
                    CallExecutionPhase.EFFECT_STARTED,
                    CallExecutionPhase.SUBMITTED,
                    CallExecutionPhase.UNKNOWN,
                )
        }
    }

    private fun mutateOrCreate(commandId: String, create: () -> CallExecutionRecord) = synchronized(LOCK) {
        val existing = read(); existing.firstOrNull { it.spec.commandId == commandId }?.let { return@synchronized it }
        val records = evictRetiredCallRecords(existing, Instant.now(), MAX_CALL_RECORDS - 1)
        create().also {
            records += it
            check(records.size <= MAX_CALL_RECORDS) { "call execution journal capacity exhausted" }
            write(records)
        }
    }
    private fun mutate(commandId: String, transform: (CallExecutionRecord) -> CallExecutionRecord) = synchronized(LOCK) {
        val records = read().toMutableList(); val index = records.indexOfFirst { it.spec.commandId == commandId }
        check(index >= 0) { "call command absent" }; transform(records[index]).also { records[index] = it; write(records) }
    }
    private fun mutateMatching(
        commandId: String,
        generation: Long,
        commandFingerprint: String?,
        transform: (CallExecutionRecord) -> CallExecutionRecord,
    ): CallExecutionRecord? = synchronized(LOCK) {
        if (commandFingerprint == null) return@synchronized null
        val records = read().toMutableList()
        val index = records.indexOfFirst {
            it.spec.commandId == commandId && it.spec.generation == generation &&
                it.commandFingerprint == commandFingerprint
        }
        check(index >= 0) { "call ACK has no exact execution record" }
        transform(records[index]).also { records[index] = it; write(records) }
    }
    private fun read(): List<CallExecutionRecord> = try {
        val array = JSONArray(prefs.getString("records", "[]")); List(array.length()) { array.getJSONObject(it).toCallRecord() }
    } catch (_: Exception) { throw IllegalStateException("call execution journal is unreadable") }
    private fun write(records: List<CallExecutionRecord>) {
        val compacted = compactCallRecords(records, Instant.now())
        val array = JSONArray(); compacted.forEach { array.put(it.toJson()) }
        check(prefs.edit().putString("records", array.toString()).commit()) { "call execution journal commit failed" }
    }
    private companion object {
        const val TERMINAL_CONFIRMED_ABSENT = "confirmed_absent_snapshot"
        const val MAX_CALL_RECORDS = 128
        val LOCK = Any()
    }
}

/** S73i: the Telecom call a hangup acted on; a hangup sent before the dial ACK has it only in its target. */
internal fun CallExecutionRecord.hangupDeviceCallId(): String? =
    (target as? FrozenCallTarget.Existing)?.deviceCallId ?: spec.deviceCallId

/** Control accepted the ACK and the command can no longer act: the same predicate the replay floor prunes with. */
internal fun CallExecutionRecord.acknowledgedTerminal(): Boolean =
    ackDeliveredAt != null && (terminalConfirmedAt != null ||
        (phase == CallExecutionPhase.REJECTED && effectStartedAt == null))

/**
 * S22 forensic fix. The journal used to stop at a bare `check(records.size <= 128)` inside
 * `mutateOrCreate`, which runs before any validation. Because the replay horizon on the paired
 * gateway never advanced past sequence 5 (Control's continuous safe prefix halts on device
 * rejections such as `call_not_found` and on server-side finalizations that carry no receipt), and
 * because records from an earlier generation can never be covered by the current floor,
 * `pruneBeforeCommitted` retired nothing. On 2026-09-11 16:02 UTC the 129th record (30 gen-2 +
 * 98 gen-3) made every later dial/answer/hangup throw "Check failed." on every heartbeat while
 * heartbeats themselves kept succeeding.
 *
 * Only records that are (1) acknowledged by Control, (2) terminal and (3) past their own
 * `expiresAt` are evicted, oldest first by (generation, sequence). Control never redelivers an
 * acknowledged command, and even a replayed copy is rejected as `command_expired` by `execute`
 * before any effect, so dropping such a record cannot re-run anything. Everything else is kept and
 * the capacity check still fails loudly when nothing is evictable.
 */
internal fun evictRetiredCallRecords(
    records: List<CallExecutionRecord>,
    now: Instant,
    maxRetained: Int,
): MutableList<CallExecutionRecord> {
    require(maxRetained >= 0)
    if (records.size <= maxRetained) return records.toMutableList()
    val evictable = records.filter { it.retiredBefore(now) }
        .sortedWith(compareBy({ it.spec.generation }, { it.spec.sequence }))
        .take(records.size - maxRetained)
        .map { it.spec.commandId }
        .toSet()
    return records.filterNot { it.spec.commandId in evictable }.toMutableList()
}

private fun CallExecutionRecord.retiredBefore(now: Instant): Boolean {
    if (!acknowledgedTerminal()) return false
    val expiresAt = runCatching { Instant.parse(spec.expiresAt) }.getOrNull() ?: return false
    return !now.isBefore(expiresAt)
}

private fun CallExecutionRecord.toJson() = JSONObject().put("spec", JSONObject()
    .put("commandId", spec.commandId).put("serverCallId", spec.serverCallId).put("generation", spec.generation)
    .put("sequence", spec.sequence).put("expiresAt", spec.expiresAt).put("kind", spec.kind.name)
    .put("simId", spec.simId ?: JSONObject.NULL).put("remoteNumber", spec.remoteNumber ?: JSONObject.NULL)
    .put("deviceCallId", spec.deviceCallId ?: JSONObject.NULL)
    .put("retentionRedacted", spec.retentionRedacted))
    .put("fingerprint", commandFingerprint).put("phase", phase.name)
    .put("target", target?.toJson() ?: JSONObject.NULL).put("effectStartedAt", effectStartedAt ?: JSONObject.NULL)
    .put("deviceCallId", deviceCallId ?: JSONObject.NULL).put("telecomState", telecomState?.name ?: JSONObject.NULL)
    .put("reason", reason ?: JSONObject.NULL)
    .put("ackDeliveredAt", ackDeliveredAt ?: JSONObject.NULL)
    .put("terminalConfirmedAt", terminalConfirmedAt ?: JSONObject.NULL)
    .put("terminalEvidenceKind", terminalEvidenceKind ?: JSONObject.NULL)
    .put("terminalSnapshotId", terminalSnapshotId ?: JSONObject.NULL)
    .put("retentionState", retentionState.name)
    .put("compactedAt", compactedAt ?: JSONObject.NULL)

private fun FrozenCallTarget.toJson() = when (this) {
    is FrozenCallTarget.Dial -> JSONObject().put("type", "dial").put("simId", simId)
        .put("assignmentVersion", assignmentVersion).put("subscriptionId", subscriptionId)
        .put("phoneAccount", protectedPhoneAccountHandle).put("iccid", iccidFingerprint)
    is FrozenCallTarget.Existing -> JSONObject().put("type", "existing").put("deviceCallId", deviceCallId)
        .put("serverCallId", serverCallId).put("state", state.name)
}

private fun JSONObject.toCallRecord(): CallExecutionRecord {
    val s = getJSONObject("spec")
    val spec = CallCommandSpec(s.getString("commandId"), s.getString("serverCallId"), s.getLong("generation"),
        s.getLong("sequence"), s.getString("expiresAt"), CallCommandKind.valueOf(s.getString("kind")),
        s.nullableCallString("simId"), s.nullableCallString("remoteNumber"), s.nullableCallString("deviceCallId"),
        reconciliationOnly = false,
        retentionRedacted = s.optBoolean("retentionRedacted", false),
    )
    val target = if (isNull("target")) null else getJSONObject("target").let { t -> when (t.getString("type")) {
        "dial" -> FrozenCallTarget.Dial(t.getString("simId"), t.getInt("assignmentVersion"),
            t.getInt("subscriptionId"), t.getString("phoneAccount"), t.getString("iccid"))
        else -> FrozenCallTarget.Existing(t.getString("deviceCallId"), t.getString("serverCallId"),
            ActualTelecomState.valueOf(t.getString("state")))
    } }
    return CallExecutionRecord(spec, getString("fingerprint"), CallExecutionPhase.valueOf(getString("phase")), target,
        nullableCallString("effectStartedAt"), nullableCallString("deviceCallId"),
        nullableCallString("telecomState")?.let(ActualTelecomState::valueOf), nullableCallString("reason"),
        nullableCallString("ackDeliveredAt"), nullableCallString("terminalConfirmedAt"),
        nullableCallString("terminalEvidenceKind"), nullableCallString("terminalSnapshotId"),
        optString("retentionState").takeIf(String::isNotBlank)?.let(CallRetentionState::valueOf)
            ?: CallRetentionState.FULL,
        nullableCallString("compactedAt"),
    )
}

internal fun compactCallRecords(records: List<CallExecutionRecord>, now: Instant): List<CallExecutionRecord> =
    records.map { record ->
        if (record.retentionState == CallRetentionState.TOMBSTONE) return@map record
        val ackAt = record.ackDeliveredAt?.let(Instant::parse) ?: return@map record
        val eligibleAt = when (record.phase) {
            CallExecutionPhase.REJECTED -> ackAt
            CallExecutionPhase.SUBMITTED, CallExecutionPhase.UNKNOWN -> {
                val terminalAt = record.terminalConfirmedAt?.let(Instant::parse) ?: return@map record
                if (record.terminalEvidenceKind != "confirmed_absent_snapshot" || record.terminalSnapshotId == null) {
                    return@map record
                }
                maxOf(ackAt, terminalAt)
            }
            CallExecutionPhase.PREPARED, CallExecutionPhase.EFFECT_STARTED -> return@map record
        }
        if (java.time.Duration.between(eligibleAt, now).seconds < CALL_FULL_RETENTION_SECONDS) return@map record
        record.copy(
            spec = record.spec.redactedForTombstone(),
            target = null,
            retentionState = CallRetentionState.TOMBSTONE,
            compactedAt = now.toString(),
        )
    }

private fun CallCommandSpec.redactedForTombstone(): CallCommandSpec = when (kind) {
    CallCommandKind.DIAL -> copy(
        simId = null,
        remoteNumber = null,
        retentionRedacted = true,
    )
    CallCommandKind.ANSWER, CallCommandKind.HANG_UP -> copy(retentionRedacted = true)
}

private const val CALL_FULL_RETENTION_SECONDS = 7L * 24 * 60 * 60

private fun JSONObject.nullableCallString(key: String) = if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)
private fun callSha256(value: String) = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
