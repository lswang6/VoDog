package org.vodog.gateway

import android.provider.CallLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * S39 §网关: the CallLog purge queue. Every rule that decides which row disappears from the user's
 * own dialler is exercised here — the Android side is only the three lambdas these tests replace.
 */
class GatewayCallLogPurgeTest {
    private val startedAt = Instant.parse("2026-09-18T10:00:00Z")
    private val start = startedAt.toEpochMilli()

    private fun purge(
        purgeId: String = "p-1",
        deviceCallId: String? = null,
        remoteNumber: String? = "19900000103",
        direction: String? = "incoming",
        startedAt: Instant? = this.startedAt,
        endedAt: Instant? = this.startedAt.plusSeconds(180),
    ) = CallLogPurge("$purgeId", "c-1", deviceCallId, remoteNumber, direction, startedAt, endedAt)

    /** The Pixel's own comparison is number-shape aware; the tests only need "same digits". */
    private val sameNumber: (String?, String) -> Boolean = { candidate, expected ->
        candidate != null && candidate.takeLast(8) == expected.takeLast(8)
    }

    @Test fun onlyTheRowNearestTheCallStartIsDeleted() {
        val rows = listOf(
            CallLogRow(10, "19900000103", start - 90_000, CallLog.Calls.INCOMING_TYPE),
            CallLogRow(11, "19900000103", start + 1_500, CallLog.Calls.INCOMING_TYPE),
            CallLogRow(12, "19900000103", start + 120_000, CallLog.Calls.INCOMING_TYPE),
        )
        val deleted = mutableListOf<Long>()
        val acks = purgeCallLogs(
            listOf(purge()),
            rows = { _, _ -> rows },
            delete = { id -> deleted.add(id); 1 },
            sameNumber = sameNumber,
        )
        assertEquals(listOf(11L), deleted)
        assertEquals(listOf(CallLogPurgeAck("p-1", "deleted", 1)), acks)
    }

    @Test fun aDifferentNumberInTheWindowIsNeverTouchedAndAnswersNotFound() {
        val deleted = mutableListOf<Long>()
        val acks = purgeCallLogs(
            listOf(purge()),
            rows = { _, _ -> listOf(CallLogRow(10, "19900000101", start, CallLog.Calls.INCOMING_TYPE)) },
            delete = { id -> deleted.add(id); 1 },
            sameNumber = sameNumber,
        )
        assertEquals(emptyList<Long>(), deleted)
        assertEquals(listOf(CallLogPurgeAck("p-1", "not_found", 0)), acks)
    }

    @Test fun theTypeMustAgreeWithTheDirectionUnlessTheDirectionIsUnknown() {
        val rows = listOf(
            CallLogRow(10, "19900000103", start, CallLog.Calls.OUTGOING_TYPE),
            CallLogRow(11, "19900000103", start + 30_000, CallLog.Calls.MISSED_TYPE),
        )
        val incoming = mutableListOf<Long>()
        purgeCallLogs(listOf(purge()), { _, _ -> rows }, { incoming.add(it); 1 }, sameNumber)
        assertEquals(listOf(11L), incoming)

        val outgoing = mutableListOf<Long>()
        purgeCallLogs(listOf(purge(direction = "outgoing")), { _, _ -> rows }, { outgoing.add(it); 1 }, sameNumber)
        assertEquals(listOf(10L), outgoing)

        val unknown = mutableListOf<Long>()
        purgeCallLogs(listOf(purge(direction = null)), { _, _ -> rows }, { unknown.add(it); 1 }, sameNumber)
        assertEquals(listOf(10L), unknown)

        // Every incoming shape Telecom writes, including the two the interception paths produce.
        listOf(
            CallLog.Calls.INCOMING_TYPE, CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE,
            CallLog.Calls.BLOCKED_TYPE, CallLog.Calls.VOICEMAIL_TYPE,
        ).forEach { assertTrue("$it", callLogTypeMatchesDirection(it, "incoming")) }
        assertEquals(false, callLogTypeMatchesDirection(CallLog.Calls.OUTGOING_TYPE, "incoming"))
        assertEquals(false, callLogTypeMatchesDirection(CallLog.Calls.INCOMING_TYPE, "outgoing"))
    }

    @Test fun theBackfillsOwnRowIsDeletedByIdWithoutQueryingAtAll() {
        var queried = false
        val deleted = mutableListOf<Long>()
        val acks = purgeCallLogs(
            listOf(purge(deviceCallId = blockedCallLogDeviceCallId(488L), remoteNumber = null)),
            rows = { _, _ -> queried = true; emptyList() },
            delete = { id -> deleted.add(id); 1 },
            sameNumber = sameNumber,
        )
        assertEquals(false, queried)
        assertEquals(listOf(488L), deleted)
        assertEquals("deleted", acks.single().status)
        // A row the dialler already dropped answers not_found rather than retrying forever.
        assertEquals(
            "not_found",
            purgeCallLogs(
                listOf(purge(deviceCallId = "calllog:488")), { _, _ -> emptyList() }, { 0 }, sameNumber,
            ).single().status,
        )
        assertEquals(488L, callLogPurgeRowId("calllog:488"))
        assertNull(callLogPurgeRowId("calllog:zero"))
        assertNull(callLogPurgeRowId("11111111-1111-4111-8111-111111111111"))
    }

    @Test fun aQueueEntryWithoutANumberOrAStartIsAnsweredNotFoundWithoutQuerying() {
        var queried = false
        val rows: (Long, Long) -> List<CallLogRow> = { _, _ -> queried = true; emptyList() }
        assertEquals("not_found", purgeCallLogs(listOf(purge(remoteNumber = null)), rows, { 1 }, sameNumber).single().status)
        assertEquals("not_found", purgeCallLogs(listOf(purge(startedAt = null)), rows, { 1 }, sameNumber).single().status)
        assertEquals(false, queried)
    }

    @Test fun aRememberedOutcomeIsReplayedAndTheRowIsNeverMatchedASecondTime() {
        val memory = mutableMapOf("p-1" to CallLogPurgeAck("p-1", "deleted", 1))
        var queried = false
        val deleted = mutableListOf<Long>()
        val acks = purgeCallLogs(
            listOf(purge()),
            rows = { _, _ -> queried = true; listOf(CallLogRow(99, "19900000103", start, CallLog.Calls.INCOMING_TYPE)) },
            delete = { id -> deleted.add(id); 1 },
            sameNumber = sameNumber,
            remembered = memory::get,
        )
        // The call back two minutes later must survive a re-sent purge: no query, no delete.
        assertEquals(false, queried)
        assertEquals(emptyList<Long>(), deleted)
        assertEquals(listOf(CallLogPurgeAck("p-1", "deleted", 1)), acks)
    }

    @Test fun aFreshOutcomeIsRememberedBeforeTheAckLeavesTheDevice() {
        val remembered = mutableListOf<CallLogPurgeAck>()
        val acks = purgeCallLogs(
            listOf(purge()),
            rows = { _, _ -> listOf(CallLogRow(7, "19900000103", start, CallLog.Calls.INCOMING_TYPE)) },
            delete = { 1 },
            sameNumber = sameNumber,
            remember = remembered::add,
        )
        assertEquals(acks, remembered)
    }

    @Test fun aDeniedOrRefusedProviderIsNeverAckedAndNeverThrows() {
        assertEquals(
            emptyList<CallLogPurgeAck>(),
            purgeCallLogs(listOf(purge()), { _, _ -> throw SecurityException("denied") }, { 1 }, sameNumber),
        )
        assertEquals(
            emptyList<CallLogPurgeAck>(),
            purgeCallLogs(
                listOf(purge()),
                { _, _ -> listOf(CallLogRow(7, "19900000103", start, CallLog.Calls.INCOMING_TYPE)) },
                { throw IllegalStateException("provider is gone") },
                sameNumber,
            ),
        )
        // One denied entry does not cost the others their answer.
        var first = true
        val acks = purgeCallLogs(
            listOf(purge("p-1"), purge("p-2")),
            rows = { _, _ -> listOf(CallLogRow(7, "19900000103", start, CallLog.Calls.INCOMING_TYPE)) },
            delete = { if (first) { first = false; throw SecurityException("denied") } else 1 },
            sameNumber = sameNumber,
        )
        assertEquals(listOf(CallLogPurgeAck("p-2", "deleted", 1)), acks)
    }

    @Test fun theWindowGuardsBothClocksAndCapsAnUnfinishedCall() {
        val window = callLogPurgeWindowMillis(startedAt, startedAt.plusSeconds(180))
        assertEquals(start - 120_000, window.first)
        assertEquals(start + 180_000 + 120_000, window.last)
        val open = callLogPurgeWindowMillis(startedAt, null)
        assertEquals(start + 4 * 3_600_000 + 120_000, open.last)
        // An ended_at before started_at is bad data, not a negative window.
        assertEquals(start + 120_000, callLogPurgeWindowMillis(startedAt, startedAt.minusSeconds(60)).last)
    }

    @Test fun theResultMemoryRoundTripsAndEvictsTheOldestFirst() {
        val ack = CallLogPurgeAck("p-1", "deleted", 1)
        assertEquals(ack, decodeCallLogPurgeResult("p-1", encodeCallLogPurgeResult(ack, 9L)))
        assertEquals("deleted|1|9", encodeCallLogPurgeResult(ack, 9L))
        assertNull(decodeCallLogPurgeResult("p-1", "deleted|1"))
        assertNull(decodeCallLogPurgeResult("p-1", "denied|1|9"))
        assertNull(decodeCallLogPurgeResult("p-1", "deleted|x|9"))

        val entries = (1..CALL_LOG_PURGE_MEMORY_LIMIT + 2).associate { "p-$it" to "not_found|0|$it" }
        assertEquals(setOf("p-1", "p-2"), evictedCallLogPurgeResults(entries))
        assertEquals(emptySet<String>(), evictedCallLogPurgeResults(entries.entries.take(2).associate { it.toPair() }))
    }
}
