package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SmsJournalRetentionTest {
    @Test fun completeRecordKeepsBodyForSevenDaysThenLeavesReplayTombstone() {
        val record = record("2026-09-01T00:00:00Z")
        val before = compactSmsRecords(listOf(record), Instant.parse("2026-09-07T23:59:59Z")).single()
        assertEquals("sensitive body", before.spec.body)
        val after = compactSmsRecords(listOf(record), Instant.parse("2026-09-08T00:00:00Z")).single()
        assertTrue(after.tombstone)
        assertEquals("", after.spec.body)
        assertEquals(record.commandFingerprint, after.commandFingerprint)
    }

    @Test fun pendingUnknownOrUnacknowledgedRecordIsNeverCompacted() {
        val unknownPendingEvent = record("2026-08-01T00:00:00Z").copy(
            phase = SmsExecutionPhase.UNKNOWN,
            events = listOf(SmsUpstreamEvent("event", "unknown", null, false)),
        )
        val notAcked = record("2026-08-01T00:00:00Z").copy(ackDelivered = false)
        val now = Instant.parse("2026-09-09T00:00:00Z")
        assertEquals("sensitive body", compactSmsRecords(listOf(unknownPendingEvent), now).single().spec.body)
        assertEquals("sensitive body", compactSmsRecords(listOf(notAcked), now).single().spec.body)
    }

    @Test fun tombstoneIsNeverRemovedByAgeBeforeCommittedFloor() {
        val tombstone = compactSmsRecords(
            listOf(record("2026-08-01T00:00:00Z")), Instant.parse("2026-08-08T00:00:00Z"),
        ).single()
        assertTrue(compactSmsRecords(listOf(tombstone), Instant.parse("2026-08-30T23:59:59Z")).isNotEmpty())
        assertTrue(compactSmsRecords(listOf(tombstone), Instant.parse("2027-08-31T00:00:00Z")).isNotEmpty())
    }

    @Test fun deliveredEventDoesNotPermitGcBeforeEverySentCorrelationArrives() {
        val earlyDelivered = record("2026-09-01T00:00:00Z").copy(
            phase = SmsExecutionPhase.DELIVERED,
            sentParts = listOf(SmsPartResult.PENDING),
            deliveredParts = listOf(SmsPartResult.SUCCEEDED),
            events = listOf(SmsUpstreamEvent("delivered", "delivered", null, true)),
        )
        assertTrue(!smsExecutionSafeToRetire(earlyDelivered))
        assertTrue(smsExecutionSafeToRetire(earlyDelivered.copy(
            sentParts = listOf(SmsPartResult.SUCCEEDED),
        )))
    }

    @Test fun failedAfterEffectRetainsLivePendingIntentCorrelations() {
        val failedAfterEffect = record("2026-09-01T00:00:00Z").copy(
            phase = SmsExecutionPhase.FAILED,
            effectStartedAt = "2026-09-01T00:00:00Z",
            events = listOf(SmsUpstreamEvent("failed", "failed", "send failed", true)),
        )
        assertTrue(!smsExecutionSafeToRetire(failedAfterEffect))
        assertTrue(smsExecutionSafeToRetire(failedAfterEffect.copy(effectStartedAt = null)))
    }

    private fun record(terminalAt: String): SmsExecutionRecord {
        val spec = SmsCommandSpec(
            "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
            1, 1, "2026-09-10T00:00:00Z", "33333333-3333-4333-8333-333333333333",
            "+12025550101", "sensitive body",
        )
        return SmsExecutionRecord(
            spec, spec.fingerprint, "correlation", SmsExecutionPhase.SENT, terminalAt, 1,
            listOf(SmsPartResult.SUCCEEDED), listOf(SmsPartResult.PENDING), null,
            listOf(SmsUpstreamEvent("event", "sent", null, true)), true, terminalAt, false,
        )
    }
}
