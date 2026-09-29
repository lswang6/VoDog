package org.vodog.gateway

import android.content.Context
import android.provider.CallLog
import android.telephony.PhoneNumberUtils
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * S39 §网关 删除同步.
 *
 * A call deleted from any client leaves one last trace the control service cannot reach: the row the
 * system dialler wrote into its own CallLog. Control queues that row (number + time window, kept at
 * most 7 days) and hands it over in the telecom snapshot response; this file deletes it and answers.
 *
 * Two rules keep the blast radius at exactly one row:
 *  - the match is the single row whose DATE is **nearest** `startedAt` among those that agree on
 *    number and direction, so a call back two minutes later is never collateral;
 *  - a purge whose first outcome is already remembered is never re-matched, only re-acked — a second
 *    pass over a shifted window could otherwise pick a different row.
 *
 * Nothing here throws: a revoked permission, a dead provider or a malformed queue entry must not
 * cost the heartbeat. A purge that could not be attempted is simply not acked, and Control re-sends
 * it on the next snapshot.
 */

/** One CallLog row reduced to the four columns matching needs. The number is never logged. */
internal data class CallLogRow(val id: Long, val number: String?, val dateMillis: Long, val type: Int)

/** Shared with [blockedCallLogDeviceCallId]: a device call id the CallLog backfill itself minted. */
internal const val CALL_LOG_DEVICE_CALL_PREFIX = "calllog:"

/** The clock on the Pixel and the one on control-node are not the same clock; both ends get 2 minutes. */
internal const val CALL_LOG_PURGE_GUARD_MS = 120_000L

/** An unfinished call row has no `ended_at`; 4 h is longer than any call this gateway can hold. */
internal const val CALL_LOG_PURGE_MAX_SPAN_MS = 4 * 60 * 60 * 1000L

/** A 4 h window on a phone that is also the household's dialler; 200 is far past any real count. */
internal const val CALL_LOG_PURGE_PAGE_SIZE = 200

/** The queue is at most 20 per snapshot; the memory only has to outlive a few failed acks. */
internal const val CALL_LOG_PURGE_MEMORY_LIMIT = 64

/** Deletes the queued rows and returns one ack per purge that produced an answer. */
internal fun purgeCallLogs(
    context: Context,
    purges: List<CallLogPurge>,
    memory: GatewayCallLogPurgeResultStore,
): List<CallLogPurgeAck> = purgeCallLogs(
    purges,
    rows = { from, to -> readCallLogRows(context, from, to) },
    delete = { id ->
        context.contentResolver.delete(
            CallLog.Calls.CONTENT_URI, "${CallLog.Calls._ID}=?", arrayOf(id.toString()),
        )
    },
    sameNumber = { candidate, expected ->
        candidate != null && PhoneNumberUtils.compare(context, candidate, expected)
    },
    remembered = memory::remembered,
    remember = memory::remember,
)

/**
 * The decision half, free of Android. [remember] runs the instant a delete returns, before the ack
 * leaves the device: the answer to "was this row already deleted" may not be lost to a crash.
 *
 * ponytail: the crash window between `delete` and `remember` cannot be closed — the result is not
 * knowable before the delete. Its cost is one wrong `not_found` ack, which only loses a diagnostic.
 */
internal fun purgeCallLogs(
    purges: List<CallLogPurge>,
    rows: (Long, Long) -> List<CallLogRow>,
    delete: (Long) -> Int,
    sameNumber: (String?, String) -> Boolean,
    remembered: (String) -> CallLogPurgeAck? = { null },
    remember: (CallLogPurgeAck) -> Unit = {},
): List<CallLogPurgeAck> = purges.mapNotNull { purge ->
    remembered(purge.purgeId) ?: try {
        val row = callLogRowToPurge(purge, rows, sameNumber)
        val deleted = if (row == null) 0 else delete(row).coerceAtLeast(0)
        CallLogPurgeAck(purge.purgeId, if (deleted > 0) "deleted" else "not_found", deleted)
            .also(remember)
    } catch (error: Exception) {
        // Denied (no WRITE_CALL_LOG), refused or dead provider: all three mean "not attempted", and
        // none may be acked — the 7 day queue window is the retry. One row per process, not per 2 s.
        if (purgeFailureLogged.compareAndSet(false, true)) {
            GatewayDiag.log(
                "calllog.purge_denied",
                mapOf(
                    "security" to (error is SecurityException),
                    "reason" to (error.message ?: error.javaClass.simpleName).take(120),
                ),
                level = "warn",
            )
        }
        null
    }
}

private val purgeFailureLogged = AtomicBoolean(false)

private fun callLogRowToPurge(
    purge: CallLogPurge,
    rows: (Long, Long) -> List<CallLogRow>,
    sameNumber: (String?, String) -> Boolean,
): Long? {
    callLogPurgeRowId(purge.deviceCallId)?.let { return it }
    // Without a number there is nothing to match on, and a window match alone would be a guess.
    val number = purge.remoteNumber ?: return null
    val startedAt = purge.startedAt ?: return null
    val window = callLogPurgeWindowMillis(startedAt, purge.endedAt)
    return selectCallLogRowToPurge(
        rows(window.first, window.last), startedAt.toEpochMilli(), purge.direction, number, sameNumber,
    )
}

/** The backfill's own rows name their CallLog `_id`, so they need no matching at all. */
internal fun callLogPurgeRowId(deviceCallId: String?): Long? = deviceCallId
    ?.takeIf { it.startsWith(CALL_LOG_DEVICE_CALL_PREFIX) }
    ?.removePrefix(CALL_LOG_DEVICE_CALL_PREFIX)
    ?.toLongOrNull()
    ?.takeIf { it > 0 }

internal fun callLogPurgeWindowMillis(startedAt: Instant, endedAt: Instant?): LongRange {
    val start = startedAt.toEpochMilli()
    val end = (endedAt?.toEpochMilli() ?: (start + CALL_LOG_PURGE_MAX_SPAN_MS)).coerceAtLeast(start)
    return (start - CALL_LOG_PURGE_GUARD_MS)..(end + CALL_LOG_PURGE_GUARD_MS)
}

/** An unknown direction matches any type: Control owns the vocabulary, not this side. */
internal fun callLogTypeMatchesDirection(type: Int, direction: String?): Boolean =
    when (direction?.lowercase()) {
        "incoming" -> type in INCOMING_CALL_LOG_TYPES
        "outgoing" -> type == CallLog.Calls.OUTGOING_TYPE
        else -> true
    }

/** Rejected and blocked rows are incoming calls too — S38 §1 reports exactly those. */
private val INCOMING_CALL_LOG_TYPES = setOf(
    CallLog.Calls.INCOMING_TYPE,
    CallLog.Calls.MISSED_TYPE,
    CallLog.Calls.REJECTED_TYPE,
    CallLog.Calls.BLOCKED_TYPE,
    CallLog.Calls.VOICEMAIL_TYPE,
)

/** Exactly one row, or none. Ties keep the first row of the DATE-ascending query. */
internal fun selectCallLogRowToPurge(
    rows: List<CallLogRow>,
    startedAtMillis: Long,
    direction: String?,
    remoteNumber: String,
    sameNumber: (String?, String) -> Boolean,
): Long? = rows
    .filter { callLogTypeMatchesDirection(it.type, direction) && sameNumber(it.number, remoteNumber) }
    .minByOrNull { abs(it.dateMillis - startedAtMillis) }
    ?.id

private fun readCallLogRows(context: Context, fromMillis: Long, toMillis: Long): List<CallLogRow> =
    context.contentResolver.query(
        callLogPageUri(CALL_LOG_PURGE_PAGE_SIZE),
        arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.TYPE),
        "${CallLog.Calls.DATE} BETWEEN ? AND ?",
        arrayOf(fromMillis.toString(), toMillis.toString()),
        "${CallLog.Calls.DATE} ASC",
    )?.use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                add(CallLogRow(
                    id = cursor.getLong(0),
                    number = cursor.getString(1)?.takeIf(String::isNotBlank),
                    dateMillis = cursor.getLong(2),
                    type = cursor.getInt(3),
                ))
            }
        }
    }.orEmpty()

/**
 * The first outcome per purge, so a lost ack is re-sent with the original answer instead of the
 * `not_found` a second match would produce. Device-protected, like every other gateway store.
 */
internal class GatewayCallLogPurgeResultStore(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_call_log_purge_results", Context.MODE_PRIVATE)

    fun remembered(purgeId: String): CallLogPurgeAck? =
        prefs.getString(purgeId, null)?.let { decodeCallLogPurgeResult(purgeId, it) }

    fun remember(ack: CallLogPurgeAck) {
        val sequence = prefs.getLong(KEY_SEQUENCE, 0L) + 1L
        val editor = prefs.edit()
            .putLong(KEY_SEQUENCE, sequence)
            .putString(ack.purgeId, encodeCallLogPurgeResult(ack, sequence))
        val kept = prefs.all.keys.filterNot { it == KEY_SEQUENCE || it == ack.purgeId }
            .associateWith { prefs.getString(it, "").orEmpty() } + (ack.purgeId to "|0|$sequence")
        evictedCallLogPurgeResults(kept).forEach(editor::remove)
        editor.apply()
    }

    fun forget(purgeId: String) = prefs.edit().remove(purgeId).apply()

    private companion object {
        /** `#` cannot occur in a purge id, which is a uuid. */
        const val KEY_SEQUENCE = "#seq"
    }
}

internal fun encodeCallLogPurgeResult(ack: CallLogPurgeAck, sequence: Long): String =
    "${ack.status}|${ack.deletedRows.coerceAtLeast(0)}|$sequence"

internal fun decodeCallLogPurgeResult(purgeId: String, value: String): CallLogPurgeAck? {
    val parts = value.split('|')
    if (parts.size != 3) return null
    val status = parts[0].takeIf { it == "deleted" || it == "not_found" } ?: return null
    val rows = parts[1].toIntOrNull()?.takeIf { it >= 0 } ?: return null
    return CallLogPurgeAck(purgeId, status, rows)
}

/** Oldest out first, by the write sequence carried in each value. */
internal fun evictedCallLogPurgeResults(
    entries: Map<String, String>,
    cap: Int = CALL_LOG_PURGE_MEMORY_LIMIT,
): Set<String> {
    if (entries.size <= cap) return emptySet()
    return entries.entries
        .sortedByDescending { it.value.substringAfterLast('|').toLongOrNull() ?: 0L }
        .drop(cap)
        .map { it.key }
        .toSet()
}
