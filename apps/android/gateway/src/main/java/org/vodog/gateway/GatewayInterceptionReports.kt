package org.vodog.gateway

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.util.UUID

/**
 * S21 §B "拦截即记录" — the durable one-shot interception report.
 *
 * The live blocking path is deliberately unchanged: a listed incoming call is still rejected with
 * DECLINED and still marked [DeviceCallJournal.suppressIncomingReport], so it never enters the
 * Telecom snapshot's `calls` array and never produces a terminal report; a listed SMS still never
 * reaches the incoming SMS journal's main table. What is new is a *separate* outbox entry that is
 * persisted before it is sent, retried until the control service answers 2xx, and then settled.
 *
 * The outbox is intentionally its own small store rather than a second use of the call/SMS journals:
 * those journals drive live reconciliation (snapshots, replay fences, retention), and an interception
 * must stay out of all of it.
 */
enum class InterceptionKind(val wire: String) { CALL("call"), SMS("sms") }

/**
 * One pending or settled report. `settled` covers both a delivered report and a retired one; the
 * entry is kept as a tombstone afterwards so the same block observed twice cannot be resent.
 */
data class InterceptionReport(
    val eventId: String,
    val kind: InterceptionKind,
    val payload: String,
    val createdAt: String,
    val attempts: Int = 0,
    val settled: Boolean = false,
    val delivered: Boolean = false,
    val settledAt: String? = null,
)

/**
 * Deterministic event IDs. Both use the same name-based UUID construction the incoming SMS journal
 * already uses for its own event identity ([UUID.nameUUIDFromBytes], RFC 4122 v3/MD5 over a
 * documented name), so repeating an observation — a re-delivered broadcast, a blocklist snapshot
 * applied twice, a crash between persist and send — always derives the same ID and the control
 * service can stay idempotent on `eventId`.
 *
 * The name is namespaced (`vodog:blocked-call:`), so a derived ID can never collide with the
 * journal's own randomly generated `incomingEventId` for the same call.
 */
internal fun blockedCallInterceptionEventId(deviceCallId: String): String =
    interceptionEventId("vodog:blocked-call:$deviceCallId")

/**
 * One protected SMS broadcast is one interception.
 *
 * `sourceDigest` is the identity of the message at the moment it was blocked, and it has two
 * documented sources:
 *  - the receiver path passes the broadcast digest, which covers every PDU, so a re-delivered
 *    broadcast derives the same ID;
 *  - the late-block path (the number was blocked *after* the message was already journaled) passes
 *    the journal's own `eventId`, because the journal record does not retain the broadcast digest.
 *
 * A message that somehow crossed both paths — journaled, then the process died before it was
 * reported, then the blocklist arrived — would therefore derive two IDs and could produce two
 * interception rows on the control side. That is accepted: each row is still idempotent by its own
 * `eventId`, and the alternative is retaining the digest in the journal for a case that requires a
 * crash inside a one-broadcast window.
 */
internal fun blockedSmsInterceptionEventId(
    generation: Long,
    iccidFingerprint: String,
    sourceDigest: String,
): String = interceptionEventId("vodog:blocked-sms:$generation:$iccidFingerprint:$sourceDigest")

private fun interceptionEventId(name: String): String =
    UUID.nameUUIDFromBytes(name.toByteArray(Charsets.UTF_8)).toString()

/** Same route and same field names as a normal incoming report, plus the `blockedLocally` marker. */
internal fun blockedCallInterceptionPayload(
    eventId: String,
    generation: Long,
    deviceCallId: String,
    simId: String,
    observedAt: String,
    remoteNumber: String?,
    blockSource: String? = null,
    screeningApp: String? = null,
): JSONObject = JSONObject()
    .put("eventId", eventId)
    .put("generation", generation)
    .put("deviceCallId", deviceCallId)
    .put("simId", simId)
    .put("observedAt", observedAt)
    .put("blockedLocally", true)
    // S38 §1: only the CallLog backfill sets this. An absent field stays the gateway's own block.
    .also { body -> blockSource?.takeIf(String::isNotBlank)?.let { body.put("blockSource", it) } }
    .also { body -> remoteNumber?.takeIf(String::isNotBlank)?.let { body.put("remoteNumber", it) } }
    // S86: set only for a CallLog row blocked by a third-party call-screening app.
    .also { body -> screeningApp?.takeIf(String::isNotBlank)?.let { body.put("screeningApp", it) } }

/** The body travels with it: a blocked message still belongs to the owner (§B). */
internal fun blockedSmsInterceptionPayload(
    eventId: String,
    generation: Long,
    simId: String,
    assignmentVersion: Int,
    remoteNumber: String,
    body: String,
    receivedAt: String,
): JSONObject = JSONObject()
    .put("eventId", eventId)
    .put("generation", generation)
    .put("simId", simId)
    .put("assignmentVersion", assignmentVersion)
    .put("remoteNumber", remoteNumber)
    .put("body", body)
    .put("receivedAt", receivedAt)
    .put("blockedLocally", true)

/** After this many failed rounds the report is retired: the call was blocked either way. */
internal const val MAX_INTERCEPTION_ATTEMPTS = 24
internal const val MAX_INTERCEPTION_RECORDS = 256
internal val INTERCEPTION_TOMBSTONE_RETENTION: Duration = Duration.ofDays(7)

/**
 * A 4xx means the control service refused this payload and will refuse it again; retrying it on every
 * 2 s heartbeat would be a permanent request amplifier. The three recoverable ones are kept.
 */
internal fun interceptionRetryable(status: Int): Boolean =
    status !in 400..499 || status in setOf(408, 409, 425, 429)

internal fun shouldRetireInterception(attempts: Int, retryable: Boolean): Boolean =
    !retryable || attempts >= MAX_INTERCEPTION_ATTEMPTS

/** Idempotent by `eventId`, including against a settled entry: one block is reported exactly once. */
internal fun upsertInterception(
    records: List<InterceptionReport>,
    next: InterceptionReport,
): List<InterceptionReport> =
    if (records.any { it.eventId == next.eventId }) records else records + next

internal fun recordInterceptionAttempt(
    records: List<InterceptionReport>,
    eventId: String,
): List<InterceptionReport> = records.map {
    if (it.eventId == eventId && !it.settled) it.copy(attempts = it.attempts + 1) else it
}

internal fun settleInterception(
    records: List<InterceptionReport>,
    eventId: String,
    delivered: Boolean,
    now: Instant,
): List<InterceptionReport> = records.map {
    if (it.eventId == eventId) {
        it.copy(settled = true, delivered = delivered, settledAt = now.toString())
    } else it
}

/**
 * Drops settled tombstones once the retention window has passed, then enforces the capacity bound by
 * evicting oldest-settled first. Capacity is never a crash here: this store sits on the InCallService
 * path where a blocked call is already handled, so losing the oldest report beats losing the reject.
 */
internal fun compactInterceptions(
    records: List<InterceptionReport>,
    now: Instant,
    maxRecords: Int = MAX_INTERCEPTION_RECORDS,
): List<InterceptionReport> {
    val retained = records.filterNot { record ->
        val settledAt = record.settledAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        record.settled && settledAt != null &&
            Duration.between(settledAt, now) >= INTERCEPTION_TOMBSTONE_RETENTION
    }
    if (retained.size <= maxRecords) return retained
    val excess = retained.size - maxRecords
    val evicted = retained.asSequence().withIndex()
        .sortedWith(compareBy({ !it.value.settled }, { it.index }))
        .take(excess).map { it.index }.toSet()
    return retained.filterIndexed { index, _ -> index !in evicted }
}

/**
 * Device-protected outbox. Unlike the call/SMS journals an unreadable file is not treated as a fence:
 * an interception report is evidence for the owner, never an execution obligation, so a corrupt store
 * resets rather than throwing into the InCallService.
 */
class GatewayInterceptionOutbox(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun enqueue(report: InterceptionReport): Boolean = synchronized(LOCK) {
        val current = records()
        val next = compactInterceptions(upsertInterception(current, report), Instant.now())
        if (next == current) return@synchronized false
        write(next)
        next.any { it.eventId == report.eventId && !it.settled }
    }

    fun pending(): List<InterceptionReport> = synchronized(LOCK) { records().filterNot { it.settled } }

    fun recordAttempt(eventId: String) = synchronized(LOCK) {
        write(recordInterceptionAttempt(records(), eventId))
    }

    fun settle(eventId: String, delivered: Boolean) = synchronized(LOCK) {
        write(settleInterception(records(), eventId, delivered, Instant.now()))
    }

    fun all(): List<InterceptionReport> = synchronized(LOCK) { records() }

    fun clear() = synchronized(LOCK) { prefs.edit().clear().commit() }

    private fun records(): List<InterceptionReport> = runCatching {
        val array = JSONArray(prefs.getString(KEY_RECORDS, "[]"))
        List(array.length()) { index ->
            val item = array.getJSONObject(index)
            InterceptionReport(
                eventId = item.getString("eventId"),
                kind = InterceptionKind.entries.first { it.wire == item.getString("kind") },
                payload = item.getString("payload"),
                createdAt = item.getString("createdAt"),
                attempts = item.optInt("attempts"),
                settled = item.optBoolean("settled"),
                delivered = item.optBoolean("delivered"),
                settledAt = if (item.isNull("settledAt")) null else item.optString("settledAt")
                    .takeIf(String::isNotBlank),
            )
        }
    }.getOrDefault(emptyList())

    private fun write(records: List<InterceptionReport>) {
        val array = JSONArray()
        records.forEach { record ->
            array.put(JSONObject()
                .put("eventId", record.eventId)
                .put("kind", record.kind.wire)
                .put("payload", record.payload)
                .put("createdAt", record.createdAt)
                .put("attempts", record.attempts)
                .put("settled", record.settled)
                .put("delivered", record.delivered)
                .put("settledAt", record.settledAt ?: JSONObject.NULL))
        }
        prefs.edit().putString(KEY_RECORDS, array.toString()).commit()
    }

    private companion object {
        const val NAME = "gateway_interception_outbox"
        const val KEY_RECORDS = "records"
        val LOCK = Any()
    }
}

/**
 * Persists one blocked incoming call. Never throws: it runs inside `onCallAdded`, where an exception
 * would take the InCallService down while the phone is ringing, and the reject must always win.
 */
internal fun enqueueBlockedCallInterception(
    context: Context,
    deviceCallId: String,
    simId: String?,
    generation: Long,
    remoteNumber: String?,
    observedAt: String = Instant.now().toString(),
    blockSource: String? = null,
    screeningApp: String? = null,
): Boolean = runCatching {
    val sim = simId?.takeIf(String::isNotBlank) ?: return@runCatching false
    if (generation <= 0) return@runCatching false
    val eventId = blockedCallInterceptionEventId(deviceCallId)
    GatewayInterceptionOutbox(context).enqueue(InterceptionReport(
        eventId = eventId,
        kind = InterceptionKind.CALL,
        payload = blockedCallInterceptionPayload(
            eventId, generation, deviceCallId, sim, observedAt, remoteNumber, blockSource,
            screeningApp,
        ).toString(),
        createdAt = Instant.now().toString(),
    ))
}.getOrDefault(false)

/** Same contract for a blocked SMS: the broadcast receiver must finish even if the store is unusable. */
internal fun enqueueBlockedSmsInterception(
    context: Context,
    generation: Long,
    simId: String?,
    assignmentVersion: Int?,
    iccidFingerprint: String,
    sourceDigest: String,
    remoteNumber: String,
    body: String,
    receivedAt: String,
): Boolean = runCatching {
    val sim = simId?.takeIf(String::isNotBlank) ?: return@runCatching false
    val version = assignmentVersion ?: return@runCatching false
    if (generation <= 0) return@runCatching false
    val eventId = blockedSmsInterceptionEventId(generation, iccidFingerprint, sourceDigest)
    GatewayInterceptionOutbox(context).enqueue(InterceptionReport(
        eventId = eventId,
        kind = InterceptionKind.SMS,
        payload = blockedSmsInterceptionPayload(
            eventId, generation, sim, version, remoteNumber, body, receivedAt,
        ).toString(),
        createdAt = Instant.now().toString(),
    ))
}.getOrDefault(false)

/**
 * Flushes the outbox once per heartbeat cycle. Every step is individually guarded: a failing
 * interception report is evidence that is worth retrying, never a reason to fail a heartbeat cycle or
 * to delay command handling.
 */
internal class GatewayInterceptionReporter(
    private val context: Context,
    private val api: GatewayApi,
) {
    fun flush(): Int {
        val outbox = runCatching { GatewayInterceptionOutbox(context) }.getOrNull() ?: return 0
        var delivered = 0
        val pending = runCatching { outbox.pending() }.getOrDefault(emptyList())
        for (report in pending) {
            val payload = runCatching { JSONObject(report.payload) }.getOrNull()
            if (payload == null) {
                runCatching { outbox.settle(report.eventId, delivered = false) }
                continue
            }
            runCatching { outbox.recordAttempt(report.eventId) }
            val outcome = runCatching {
                when (report.kind) {
                    InterceptionKind.CALL -> api.reportBlockedIncomingCall(payload)
                    InterceptionKind.SMS -> api.reportBlockedIncomingSms(payload)
                }
            }
            if (outcome.isSuccess) {
                runCatching { outbox.settle(report.eventId, delivered = true) }
                delivered++
                continue
            }
            // A disabled gateway or a transport error keeps the entry; only a refused payload or an
            // exhausted attempt budget retires it.
            val retryable = (outcome.exceptionOrNull() as? GatewayApiHttpError)
                ?.let { interceptionRetryable(it.status) } ?: true
            if (shouldRetireInterception(report.attempts + 1, retryable)) {
                runCatching { outbox.settle(report.eventId, delivered = false) }
            }
        }
        return delivered
    }
}
