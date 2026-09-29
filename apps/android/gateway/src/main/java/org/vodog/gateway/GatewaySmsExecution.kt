package org.vodog.gateway

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.UUID

enum class SmsExecutionPhase { PREPARED, EFFECT_STARTED, SUBMITTED, SENT, DELIVERED, FAILED, UNKNOWN }
enum class SmsPartResult { PENDING, SUCCEEDED, FAILED }

data class SmsCommandSpec(
    val commandId: String,
    val smsId: String,
    val generation: Long,
    val sequence: Long,
    val expiresAt: String,
    val simId: String,
    val remoteNumber: String,
    val body: String,
) {
    val fingerprint: String = sha256(
        "$generation\u0000$sequence\u0000$expiresAt\u0000$smsId\u0000$simId\u0000$remoteNumber\u0000$body",
    )

    companion object {
        fun from(command: GatewayCommand): SmsCommandSpec {
            require(command.kind == "send_sms")
            require(command.generation > 0 && command.sequence > 0)
            UUID.fromString(command.commandId)
            val payload = JSONObject(command.payloadJson)
            val smsId = requireNotNull(command.smsId ?: payload.optString("smsId").takeIf(String::isNotBlank))
            UUID.fromString(smsId)
            val number = payload.getString("remoteNumber")
            // E.164, or a bare domestic/service number (10010, 1001298, 20-digit 106… short codes).
            require(number.matches(Regex("^(\\+[1-9][0-9]{5,14}|[0-9]{3,20})$"))) { "invalid SMS destination" }
            return SmsCommandSpec(
                command.commandId, smsId, command.generation, command.sequence,
                requireNotNull(command.expiresAt).also(Instant::parse),
                payload.getString("simId").also(UUID::fromString), number,
                payload.getString("body").also { require(it.isNotEmpty() && it.length <= 5_000) },
            )
        }
    }
}

data class SmsExecutionRecord(
    val spec: SmsCommandSpec,
    val commandFingerprint: String,
    val correlationId: String,
    val phase: SmsExecutionPhase,
    val effectStartedAt: String?,
    val partCount: Int,
    val sentParts: List<SmsPartResult>,
    val deliveredParts: List<SmsPartResult>,
    val failureReason: String?,
    val events: List<SmsUpstreamEvent>,
    val ackDelivered: Boolean,
    val terminalAt: String?,
    val tombstone: Boolean,
)

data class SmsUpstreamEvent(val eventId: String, val state: String, val failureReason: String?, val delivered: Boolean)
data class PendingSmsEvent(
    val commandId: String,
    val smsId: String,
    val generation: Long,
    val event: SmsUpstreamEvent,
)

sealed interface SmsExecutionDecision {
    data class Acked(val result: Map<String, String>) : SmsExecutionDecision
    data class Rejected(val reason: String, val executedAt: String?) : SmsExecutionDecision
}

interface SmsCommandRepository {
    fun find(commandId: String): SmsExecutionRecord?
    fun prepare(spec: SmsCommandSpec): SmsExecutionRecord
    fun markEffectStarted(commandId: String, partCount: Int, at: String): SmsExecutionRecord
    fun markSubmitted(commandId: String): SmsExecutionRecord
    fun markUnknown(commandId: String, reason: String): SmsExecutionRecord
    fun markRejected(commandId: String, reason: String): SmsExecutionRecord
}

interface SmsExecutor {
    fun divide(body: String): List<String>
    fun submit(spec: SmsCommandSpec, correlationId: String, parts: List<String>)
}

class SmsCommandMachine(
    private val repository: SmsCommandRepository,
    private val executor: SmsExecutor,
    private val now: () -> Instant = Instant::now,
    private val preEffectCheck: () -> String? = { null },
) {
    /** Diag rows carry smsId/parts/reason only — never the number or the body. */
    fun execute(spec: SmsCommandSpec): SmsExecutionDecision = decide(spec).also { decision ->
        if (decision is SmsExecutionDecision.Rejected) GatewayDiag.log(
            "sms.failed", mapOf("smsId" to spec.smsId, "result" to decision.reason), level = "warn",
        )
    }

    private fun decide(spec: SmsCommandSpec): SmsExecutionDecision = synchronized(EXECUTION_LOCK) {
        val prior = repository.find(spec.commandId)
        if (prior != null && prior.commandFingerprint != spec.fingerprint) {
            return SmsExecutionDecision.Rejected("command_payload_collision", prior.effectStartedAt)
        }
        val record = prior ?: repository.prepare(spec)
        when (record.phase) {
            SmsExecutionPhase.EFFECT_STARTED -> {
                val unknown = repository.markUnknown(spec.commandId, "PROCESS_INTERRUPTED_AFTER_EFFECT_START")
                return SmsExecutionDecision.Rejected("execution_unknown", unknown.effectStartedAt)
            }
            SmsExecutionPhase.SUBMITTED, SmsExecutionPhase.SENT, SmsExecutionPhase.DELIVERED ->
                return SmsExecutionDecision.Acked(ackResult(record))
            SmsExecutionPhase.FAILED -> return SmsExecutionDecision.Rejected(
                record.failureReason ?: "SMS_SEND_FAILED", record.effectStartedAt,
            )
            SmsExecutionPhase.UNKNOWN -> return SmsExecutionDecision.Rejected(
                "execution_unknown", record.effectStartedAt,
            )
            SmsExecutionPhase.PREPARED -> Unit
        }
        if (!now().isBefore(Instant.parse(spec.expiresAt))) {
            repository.markRejected(spec.commandId, "command_expired")
            return SmsExecutionDecision.Rejected("command_expired", null)
        }
        preEffectCheck()?.let { reason ->
            repository.markRejected(spec.commandId, reason)
            return SmsExecutionDecision.Rejected(reason, null)
        }
        val parts = try {
            executor.divide(spec.body).also { require(it.isNotEmpty()) }
        } catch (_: Exception) {
            repository.markRejected(spec.commandId, "sms_divide_failed")
            return SmsExecutionDecision.Rejected("sms_divide_failed", null)
        }
        preEffectCheck()?.let { reason ->
            repository.markRejected(spec.commandId, reason)
            return SmsExecutionDecision.Rejected(reason, null)
        }
        val startedAt = now().toString()
        repository.markEffectStarted(spec.commandId, parts.size, startedAt)
        // The durable uncertainty marker must precede this final check. A crash here becomes
        // unknown, while an observed OFF/SIM change is rejected without invoking SmsManager.
        preEffectCheck()?.let { reason ->
            repository.markRejected(spec.commandId, reason)
            logSmsFailed(spec, reason)
            return@synchronized SmsExecutionDecision.Rejected(reason, startedAt)
        }
        try {
            executor.submit(spec, record.correlationId, parts)
        } catch (error: Exception) {
            repository.markUnknown(spec.commandId, "submission_result_unknown")
            logSmsFailed(spec, "execution_unknown", error.javaClass.simpleName)
            return SmsExecutionDecision.Rejected("execution_unknown", startedAt)
        }
        val submitted = repository.markSubmitted(spec.commandId)
        GatewayDiag.log("sms.send", mapOf("smsId" to spec.smsId, "parts" to parts.size, "result" to "submitted",
            "ms" to Duration.between(Instant.parse(startedAt), now()).toMillis()))
        return@synchronized SmsExecutionDecision.Acked(ackResult(submitted))
    }

    /** S69: number yes (decision 6), body never. */
    private fun logSmsFailed(spec: SmsCommandSpec, result: String, errorType: String? = null) =
        GatewayDiag.log("sms.failed", mapOf("smsId" to spec.smsId, "result" to result,
            "toNumber" to spec.remoteNumber, "errorType" to errorType), level = "warn")

    private fun ackResult(record: SmsExecutionRecord) = mapOf(
        "phase" to "submitted",
        "parts" to record.partCount.toString(),
        "executedAt" to requireNotNull(record.effectStartedAt),
    )

    private companion object { val EXECUTION_LOCK = Any() }
}

class AndroidSmsExecutor(private val context: Context, private val subscriptionId: Int) : SmsExecutor {
    private val manager: SmsManager = if (Build.VERSION.SDK_INT >= 31) {
        context.getSystemService(SmsManager::class.java).createForSubscriptionId(subscriptionId)
    } else {
        @Suppress("DEPRECATION") SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
    }

    override fun divide(body: String): List<String> = manager.divideMessage(body)

    override fun submit(spec: SmsCommandSpec, correlationId: String, parts: List<String>) {
        val sent = ArrayList(parts.indices.map { statusIntent(spec, correlationId, it, STATUS_SENT) })
        val delivered = ArrayList(parts.indices.map { statusIntent(spec, correlationId, it, STATUS_DELIVERED) })
        if (parts.size == 1) {
            manager.sendTextMessage(spec.remoteNumber, null, parts.single(), sent.single(), delivered.single())
        } else {
            manager.sendMultipartTextMessage(spec.remoteNumber, null, ArrayList(parts), sent, delivered)
        }
    }

    private fun statusIntent(spec: SmsCommandSpec, correlationId: String, partIndex: Int, status: String): PendingIntent {
        val intent = Intent(context, GatewaySmsStatusReceiver::class.java)
            .setAction(ACTION_STATUS)
            .setData(Uri.parse("vodog://sms/${spec.commandId}/$status/$partIndex"))
            .putExtra(EXTRA_COMMAND_ID, spec.commandId)
            .putExtra(EXTRA_CORRELATION_ID, correlationId)
            .putExtra(EXTRA_PART_INDEX, partIndex)
            .putExtra(EXTRA_STATUS, status)
        return PendingIntent.getBroadcast(
            context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        const val ACTION_STATUS = "org.vodog.gateway.SMS_STATUS"
        const val EXTRA_COMMAND_ID = "command_id"
        const val EXTRA_CORRELATION_ID = "correlation_id"
        const val EXTRA_PART_INDEX = "part_index"
        const val EXTRA_STATUS = "status"
        const val STATUS_SENT = "sent"
        const val STATUS_DELIVERED = "delivered"
    }
}

class SmsExecutionJournal(context: Context) : SmsCommandRepository {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(NAME, Context.MODE_PRIVATE)

    override fun find(commandId: String) = synchronized(LOCK) { read().firstOrNull { it.spec.commandId == commandId } }

    fun migrationUnknownCount(generation: Long): Int = synchronized(LOCK) {
        read().count { record ->
            record.spec.generation == generation && record.phase in setOf(
                SmsExecutionPhase.PREPARED, SmsExecutionPhase.EFFECT_STARTED, SmsExecutionPhase.SUBMITTED,
                SmsExecutionPhase.SENT, SmsExecutionPhase.UNKNOWN,
            )
        }
    }

    fun migrationPendingAckCount(generation: Long): Int = synchronized(LOCK) {
        read().count { it.spec.generation == generation && !it.ackDelivered }
    }

    override fun prepare(spec: SmsCommandSpec): SmsExecutionRecord = synchronized(LOCK) {
        find(spec.commandId)?.let { return@synchronized it }
        val record = SmsExecutionRecord(
            spec, spec.fingerprint, UUID.randomUUID().toString(), SmsExecutionPhase.PREPARED, null, 0,
            emptyList(), emptyList(), null, emptyList(), false, null, false,
        )
        update(record)
        record
    }

    override fun markEffectStarted(commandId: String, partCount: Int, at: String) = mutate(commandId) {
        it.copy(
            phase = SmsExecutionPhase.EFFECT_STARTED, effectStartedAt = at, partCount = partCount,
            sentParts = List(partCount) { SmsPartResult.PENDING },
            deliveredParts = List(partCount) { SmsPartResult.PENDING },
        )
    }

    override fun markSubmitted(commandId: String) = mutate(commandId) {
        if (it.phase == SmsExecutionPhase.EFFECT_STARTED) it.copy(phase = SmsExecutionPhase.SUBMITTED) else it
    }

    override fun markUnknown(commandId: String, reason: String) = mutate(commandId) {
        terminal(it, SmsExecutionPhase.UNKNOWN, "unknown", reason)
    }

    override fun markRejected(commandId: String, reason: String) = mutate(commandId) {
        it.copy(
            phase = SmsExecutionPhase.FAILED,
            failureReason = reason,
            terminalAt = it.terminalAt ?: Instant.now().toString(),
        )
    }

    fun recordStatus(commandId: String, correlationId: String, partIndex: Int, status: String, resultCode: Int) =
        mutate(commandId) { record ->
            if (record.correlationId != correlationId || partIndex !in 0 until record.partCount) return@mutate record
            mergeSmsPartStatus(record, partIndex, status, resultCode == Activity.RESULT_OK).also { merged ->
                smsStatusDiag(record, merged, partIndex, status, resultCode, Instant.now())
                    ?.let { (event, fields) -> GatewayDiag.log(event, fields, level = if (event == "sms.failed") "warn" else "info") }
            }
        }

    fun pendingEvents(): List<PendingSmsEvent> = synchronized(LOCK) {
        read().flatMap { record ->
            record.events.filterNot(SmsUpstreamEvent::delivered).map {
                PendingSmsEvent(record.spec.commandId, record.spec.smsId, record.spec.generation, it)
            }
        }
    }

    fun markEventDelivered(commandId: String, eventId: String) = mutate(commandId) {
        it.copy(events = it.events.map { event ->
            if (event.eventId == eventId) event.copy(delivered = true) else event
        })
    }

    fun markAckDelivered(commandId: String) = mutate(commandId) { it.copy(ackDelivered = true) }

    fun clear() = synchronized(LOCK) { prefs.edit().clear().commit() }

    fun pruneBeforeCommitted(floor: Long, generation: Long) = synchronized(LOCK) {
        require(floor > 0 && generation > 0)
        val retained = read().filterNot { record ->
            record.spec.generation == generation && record.spec.sequence < floor &&
                smsExecutionSafeToRetire(record)
        }
        val array = JSONArray().also { output -> retained.forEach { output.put(it.toJson()) } }
        check(prefs.edit().putString(KEY, array.toString()).commit()) { "SMS execution journal commit failed" }
    }

    private fun terminal(record: SmsExecutionRecord, phase: SmsExecutionPhase, state: String, reason: String) =
        appendSmsEvent(record.copy(phase = phase, failureReason = reason), state, reason)

    private fun mutate(commandId: String, transform: (SmsExecutionRecord) -> SmsExecutionRecord) = synchronized(LOCK) {
        val existing = requireNotNull(read().firstOrNull { it.spec.commandId == commandId })
        transform(existing).also(::update)
    }

    private fun update(record: SmsExecutionRecord) {
        val records = compactSmsRecords(read(), Instant.now()).toMutableList()
        records.removeAll { it.spec.commandId == record.spec.commandId }
        records += record
        check(records.count { !it.tombstone } <= MAX_FULL_RECORDS && records.size <= MAX_TOTAL_RECORDS) {
            "SMS execution journal capacity exhausted"
        }
        val array = JSONArray().also { output -> records.forEach { output.put(it.toJson()) } }
        check(prefs.edit().putString(KEY, array.toString()).commit()) { "SMS execution journal commit failed" }
    }

    private fun read(): List<SmsExecutionRecord> = try {
        val array = JSONArray(prefs.getString(KEY, "[]"))
        List(array.length()) { array.getJSONObject(it).toSmsRecord() }
    } catch (_: Exception) {
        throw IllegalStateException("SMS execution journal is unreadable")
    }

    companion object {
        private const val NAME = "gateway_sms_execution_journal"
        private const val KEY = "records"
        private const val MAX_FULL_RECORDS = 512
        private const val MAX_TOTAL_RECORDS = 2_048
        private val LOCK = Any()
    }
}

internal fun mergeSmsPartStatus(
    record: SmsExecutionRecord,
    partIndex: Int,
    status: String,
    success: Boolean,
): SmsExecutionRecord {
    if (record.phase == SmsExecutionPhase.FAILED || partIndex !in 0 until record.partCount) return record
    return when (status) {
        AndroidSmsExecutor.STATUS_SENT -> {
            if (!success && (record.phase == SmsExecutionPhase.DELIVERED ||
                    record.sentParts[partIndex] == SmsPartResult.SUCCEEDED)
            ) return record
            val values = record.sentParts.toMutableList().also {
                it[partIndex] = if (success) SmsPartResult.SUCCEEDED else SmsPartResult.FAILED
            }
            when {
                !success -> appendSmsEvent(
                    record.copy(phase = SmsExecutionPhase.FAILED, sentParts = values, failureReason = "SMS_PART_SEND_FAILED"),
                    "failed", "SMS_PART_SEND_FAILED",
                )
                values.all { it == SmsPartResult.SUCCEEDED } -> {
                    val nextPhase = if (record.phase == SmsExecutionPhase.DELIVERED) {
                        SmsExecutionPhase.DELIVERED
                    } else SmsExecutionPhase.SENT
                    val sent = appendSmsEvent(record.copy(sentParts = values, phase = nextPhase), "sent", null)
                    if (sent.deliveredParts.all { it == SmsPartResult.SUCCEEDED }) {
                        appendSmsEvent(sent.copy(phase = SmsExecutionPhase.DELIVERED), "delivered", null)
                    } else sent
                }
                else -> record.copy(sentParts = values)
            }
        }
        AndroidSmsExecutor.STATUS_DELIVERED -> {
            if (!success) return record
            val values = record.deliveredParts.toMutableList().also { it[partIndex] = SmsPartResult.SUCCEEDED }
            if (values.all { it == SmsPartResult.SUCCEEDED }) {
                appendSmsEvent(record.copy(deliveredParts = values, phase = SmsExecutionPhase.DELIVERED), "delivered", null)
            } else record.copy(deliveredParts = values)
        }
        else -> record
    }
}

/** One row per SENT/DELIVERED callback; a new upstream `failed` event turns it into `sms.failed`. */
internal fun smsStatusDiag(
    before: SmsExecutionRecord, after: SmsExecutionRecord, partIndex: Int, status: String, resultCode: Int, now: Instant,
): Pair<String, Map<String, Any?>>? {
    val ok = resultCode == Activity.RESULT_OK
    val event = when {
        after.events.any { it.state == "failed" } && before.events.none { it.state == "failed" } -> "sms.failed"
        !ok && status == AndroidSmsExecutor.STATUS_SENT -> "sms.failed"
        status == AndroidSmsExecutor.STATUS_SENT -> "sms.sent"
        status == AndroidSmsExecutor.STATUS_DELIVERED -> "sms.delivered"
        else -> return null
    }
    return event to mapOf(
        "smsId" to before.spec.smsId, "part" to partIndex, "parts" to before.partCount,
        "result" to if (ok) "ok" else "error", "errorCode" to resultCode.takeUnless { ok },
        "ms" to before.effectStartedAt?.let { Duration.between(Instant.parse(it), now).toMillis() },
    )
}

/** A delivered phase may precede late SENT callbacks that can still create an upstream event. */
internal fun smsExecutionSafeToRetire(record: SmsExecutionRecord): Boolean {
    if (!record.ackDelivered || record.events.any { !it.delivered }) return false
    return when (record.phase) {
        SmsExecutionPhase.DELIVERED -> record.partCount > 0 &&
            record.sentParts.size == record.partCount && record.deliveredParts.size == record.partCount &&
            record.sentParts.all { it == SmsPartResult.SUCCEEDED } &&
            record.deliveredParts.all { it == SmsPartResult.SUCCEEDED }
        // A local validation rejection has no Android PendingIntent correlations. A failure after
        // effect start retains the row because some SENT/DELIVERED callbacks can remain live.
        SmsExecutionPhase.FAILED -> record.effectStartedAt == null
        else -> false
    }
}

private fun appendSmsEvent(record: SmsExecutionRecord, state: String, reason: String?): SmsExecutionRecord {
    if (record.events.any { it.state == state }) return record
    return record.copy(
        events = record.events + SmsUpstreamEvent(UUID.randomUUID().toString(), state, reason, false),
        failureReason = if (state == "sent" || state == "delivered") null else reason ?: record.failureReason,
        terminalAt = record.terminalAt ?: Instant.now().toString(),
    )
}

/** SMS execution reviewed for the authorized Pixel acceptance build; local OFF still gates every effect. */
object SmsExecutionApproval {
    const val APPROVED = true
}

class GatewaySmsCoordinator(
    private val context: Context,
    private val runtime: GatewayRuntimeStore,
    private val api: GatewayApi,
    private val identity: GatewayCommandIdentity? = null,
    private val replayStore: GatewayReplayHorizonStore? = null,
) {
    private val journal = SmsExecutionJournal(context)
    private val replayJournal: SmsCommandRepository = object : SmsCommandRepository by journal {
        override fun markEffectStarted(commandId: String, partCount: Int, at: String): SmsExecutionRecord {
            val record = journal.markEffectStarted(commandId, partCount, at)
            replayStore?.markEffectStarted(commandId)
            return record
        }
    }

    fun handle(command: GatewayCommand) {
        val replayEvidence = identity?.let { ReplayAckEvidence(command.sequence, commandReplayFingerprint(it.gatewayId, command)) }
        val spec = runCatching { SmsCommandSpec.from(command) }.getOrElse { error ->
            // Fixed strings only: a parse error message can echo payload content.
            GatewayDiag.log("sms.failed", mapOf("smsId" to command.smsId, "result" to "invalid_sms_command",
                "errorCode" to if (error.message == "invalid SMS destination") "invalid_destination" else error.javaClass.simpleName),
                level = "warn")
            api.ackCommand(command, "rejected", JSONObject().put("phase", "not_executed")
                .put("reason", "invalid_sms_command"), replayEvidence, replayStore)
            return
        }
        var frozenBinding: ServerSimBinding? = null
        fun validateFrozenRoute(): String? {
            val candidate = frozenBinding ?: binding(spec) ?: return "sim_not_routable"
            val failure = validate(spec, candidate)
            if (failure == null && frozenBinding == null) frozenBinding = candidate
            return failure
        }
        val lazyExecutor = object : SmsExecutor {
            val delegate by lazy {
                AndroidSmsExecutor(context, requireNotNull(frozenBinding).subscriptionId)
            }
            override fun divide(body: String) = delegate.divide(body)
            override fun submit(spec: SmsCommandSpec, correlationId: String, parts: List<String>) =
                delegate.submit(spec, correlationId, parts)
        }
        val decision = SmsCommandMachine(
            replayJournal, lazyExecutor, preEffectCheck = ::validateFrozenRoute,
        ).execute(spec)
        // An unknown side effect event is durable and goes first; ACK loss can then safely replay.
        flushEvents()
        when (decision) {
            is SmsExecutionDecision.Acked -> api.ackCommand(
                command, "acked", JSONObject(decision.result), replayEvidence, replayStore,
            )
            is SmsExecutionDecision.Rejected -> api.ackCommand(
                command,
                "rejected",
                JSONObject().put("reason", decision.reason).also {
                    decision.executedAt?.let { at -> it.put("executedAt", at) }
                },
                replayEvidence,
                replayStore,
            )
        }
        journal.markAckDelivered(spec.commandId)
    }

    fun flushEvents() {
        journal.pendingEvents().forEach { pending ->
            val body = JSONObject()
                .put("eventId", pending.event.eventId)
                .put("generation", pending.generation)
                .put("state", pending.event.state)
            pending.event.failureReason?.let { body.put("failureReason", it) }
            val response = api.reportSmsEvent(pending.smsId, body)
            check(response.optBoolean("accepted")) { "SMS event not accepted" }
            journal.markEventDelivered(pending.commandId, pending.event.eventId)
        }
        flushIncoming()
        flushObservedOutgoing()
    }

    private fun flushIncoming() {
        if (!SmsExecutionApproval.APPROVED) return
        val incoming = IncomingSmsJournal(context)
        val bindings = GatewaySimBindingStore(context)
        val blocklist = GatewayNumberBlocklistStore(context)
        incoming.pending().forEach { record ->
            val simIdAtReceipt = record.simIdAtReceipt ?: return@forEach
            val assignmentVersionAtReceipt = record.assignmentVersionAtReceipt ?: return@forEach
            val binding = bindings.bySimId(simIdAtReceipt) ?: return@forEach
            if (shouldDropIncomingSms(
                    runtime.enabled,
                    blocklist.isSmsListed(simIdAtReceipt, record.remoteNumber, binding.countryIso),
                )) {
                // S21 §B: the number was blocked after this message was journaled. It still never
                // reaches the main SMS table, but the block is recorded once and the receipt is
                // suppressed instead of staying pending forever.
                enqueueBlockedSmsInterception(
                    context,
                    generation = record.generation,
                    simId = simIdAtReceipt,
                    assignmentVersion = assignmentVersionAtReceipt,
                    iccidFingerprint = record.iccidFingerprint,
                    sourceDigest = record.eventId,
                    remoteNumber = record.remoteNumber,
                    body = record.body,
                    receivedAt = record.receivedAt,
                )
                incoming.markReported(record.eventId)
                return@forEach
            }
            if (!eligibleIncomingBinding(record, binding, runtime.deviceEpoch)) return@forEach
            val response = api.reportIncomingSms(
                JSONObject()
                    .put("eventId", record.eventId)
                    .put("generation", record.generation)
                    .put("simId", simIdAtReceipt)
                    .put("assignmentVersion", assignmentVersionAtReceipt)
                    .put("remoteNumber", record.remoteNumber)
                    .put("body", record.body)
                    .put("receivedAt", record.receivedAt),
            )
            check(response.optBoolean("accepted")) { "incoming SMS event not accepted" }
            incoming.markReported(record.eventId)
        }
    }

    private fun flushObservedOutgoing() {
        if (!SmsExecutionApproval.APPROVED || !runtime.enabled) return
        val journal = OutgoingSmsObservationJournal(context)
        val bindings = GatewaySimBindingStore(context)
        // One bad record must not block the rest; the first failure is rethrown so the heartbeat sees it.
        var failure: Exception? = null
        journal.pending().forEach { record ->
            val binding = bindings.bySimId(record.simId)
            if (!eligibleOutgoingSmsBinding(record, binding, runtime.deviceEpoch)) return@forEach
            try {
                val response = api.reportOutgoingSmsObserved(
                    JSONObject()
                        .put("eventId", record.eventId)
                        .put("generation", record.generation)
                        .put("simId", record.simId)
                        .put("assignmentVersion", record.assignmentVersion)
                        .put("remoteNumber", record.remoteNumber)
                        .put("body", record.body)
                        .put("sentAt", record.sentAt),
                )
                check(response.accepted) { "outgoing SMS observation not accepted" }
                journal.markReported(record.eventId)
            } catch (error: GatewayApiHttpError) {
                // Control already owns this event id: retrying the same record can never succeed.
                if (error.code == "EVENT_ID_REUSED") journal.markReported(record.eventId)
                else if (failure == null) failure = error
            } catch (error: Exception) {
                if (failure == null) failure = error
            }
        }
        failure?.let { throw it }
    }

    private fun validate(spec: SmsCommandSpec, expected: ServerSimBinding): String? {
        if (!SmsExecutionApproval.APPROVED) return "sms_execution_not_approved"
        if (!runtime.enabled) return "control_disabled"
        if (runtime.deviceEpoch != spec.generation) return "fence_rejected"
        if (context.checkSelfPermission(android.Manifest.permission.SEND_SMS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return "send_sms_permission_missing"
        }
        val binding = binding(spec) ?: return "sim_not_routable"
        if (!binding.routable) return "sim_not_routable"
        if (!sameExecutionRoute(binding, expected)) return "sim_identity_changed"
        val current = DeviceStatusReader(context).activeSims().singleOrNull {
            it.subscriptionId == binding.subscriptionId &&
                it.iccidFingerprint == binding.iccidFingerprint &&
                it.protectedPhoneAccountHandle == binding.phoneAccountHandle
        } ?: return "sim_identity_changed"
        return null
    }

    private fun binding(spec: SmsCommandSpec) = GatewaySimBindingStore(context).bySimId(spec.simId)
}

internal fun sameExecutionRoute(current: ServerSimBinding, expected: ServerSimBinding): Boolean =
    current.simId == expected.simId && current.assignmentVersion == expected.assignmentVersion &&
        current.subscriptionId == expected.subscriptionId &&
        current.phoneAccountHandle == expected.phoneAccountHandle &&
        current.iccidFingerprint == expected.iccidFingerprint && current.routable == expected.routable

/** Current routing only decides whether to contact the server; receipt-time version is never replaced. */
internal fun eligibleIncomingBinding(
    record: IncomingSmsRecord,
    current: ServerSimBinding,
    deviceEpoch: Long,
): Boolean = record.generation == deviceEpoch && record.simIdAtReceipt == current.simId &&
    record.assignmentVersionAtReceipt != null && current.routable &&
    record.iccidFingerprint == current.iccidFingerprint && record.phoneAccountHandle == current.phoneAccountHandle

private fun SmsExecutionRecord.toJson() = JSONObject()
    .put("spec", JSONObject().put("commandId", spec.commandId).put("smsId", spec.smsId)
        .put("generation", spec.generation).put("sequence", spec.sequence).put("expiresAt", spec.expiresAt)
        .put("simId", spec.simId).put("remoteNumber", spec.remoteNumber).put("body", spec.body))
    .put("commandFingerprint", commandFingerprint)
    .put("correlationId", correlationId).put("phase", phase.name)
    .put("effectStartedAt", effectStartedAt ?: JSONObject.NULL).put("partCount", partCount)
    .put("sentParts", JSONArray(sentParts.map(Enum<*>::name)))
    .put("deliveredParts", JSONArray(deliveredParts.map(Enum<*>::name)))
    .put("failureReason", failureReason ?: JSONObject.NULL)
    .put("events", JSONArray().also { array -> events.forEach { event ->
        array.put(JSONObject().put("eventId", event.eventId).put("state", event.state)
            .put("failureReason", event.failureReason ?: JSONObject.NULL).put("delivered", event.delivered))
    } })
    .put("ackDelivered", ackDelivered)
    .put("terminalAt", terminalAt ?: JSONObject.NULL)
    .put("tombstone", tombstone)

private fun JSONObject.toSmsRecord(): SmsExecutionRecord {
    val value = getJSONObject("spec")
    val spec = SmsCommandSpec(
        value.getString("commandId"), value.getString("smsId"), value.getLong("generation"),
        value.getLong("sequence"), value.getString("expiresAt"), value.getString("simId"),
        value.getString("remoteNumber"), value.getString("body"),
    )
    fun parts(key: String) = getJSONArray(key).let { array ->
        List(array.length()) { SmsPartResult.valueOf(array.getString(it)) }
    }
    val eventsJson = optJSONArray("events") ?: JSONArray()
    val events = List(eventsJson.length()) { index ->
        eventsJson.getJSONObject(index).let {
            SmsUpstreamEvent(
                it.getString("eventId"), it.getString("state"), it.smsNullableString("failureReason"),
                it.optBoolean("delivered"),
            )
        }
    }
    return SmsExecutionRecord(
        spec, optString("commandFingerprint", spec.fingerprint), getString("correlationId"),
        SmsExecutionPhase.valueOf(getString("phase")),
        smsNullableString("effectStartedAt"), getInt("partCount"), parts("sentParts"), parts("deliveredParts"),
        smsNullableString("failureReason"), events, optBoolean("ackDelivered"),
        smsNullableString("terminalAt"), optBoolean("tombstone"),
    )
}

internal fun compactSmsRecords(records: List<SmsExecutionRecord>, now: Instant): List<SmsExecutionRecord> =
    records.mapNotNull { record ->
        val terminalAt = record.terminalAt?.let(Instant::parse) ?: return@mapNotNull record
        val ageSeconds = java.time.Duration.between(terminalAt, now).seconds
        val terminal = record.phase in setOf(
            SmsExecutionPhase.SENT, SmsExecutionPhase.DELIVERED,
            SmsExecutionPhase.FAILED, SmsExecutionPhase.UNKNOWN,
        )
        if (!record.tombstone && terminal && record.ackDelivered &&
            record.events.all(SmsUpstreamEvent::delivered) && ageSeconds >= FULL_RETENTION_SECONDS
        ) {
            record.copy(
                spec = record.spec.copy(remoteNumber = "", body = ""),
                correlationId = "", sentParts = emptyList(), deliveredParts = emptyList(),
                events = emptyList(), tombstone = true,
            )
        } else record
    }

private const val FULL_RETENTION_SECONDS = 7L * 24 * 60 * 60

private fun sha256(value: String) = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

private fun JSONObject.smsNullableString(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)
