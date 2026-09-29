package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class IncomingSmsRetentionTest {
    @Test fun reportedReceiptKeepsBodySevenDaysThenLeavesIdempotencyTombstone() {
        val record = record(reported = true, reportedAt = "2026-09-01T00:00:00Z")
        assertEquals(
            "private body",
            compactIncomingSmsRecords(listOf(record), Instant.parse("2026-09-07T23:59:59Z")).single().body,
        )
        val tombstone = compactIncomingSmsRecords(
            listOf(record), Instant.parse("2026-09-08T00:00:00Z"),
        ).single()
        assertTrue(tombstone.tombstone)
        assertEquals("", tombstone.body)
        assertEquals(record.eventId, tombstone.eventId)
    }

    @Test fun unreportedReceiptIsNeverCompactedAndTombstoneExpiresAtThirtyDays() {
        val pending = record(reported = false, reportedAt = null)
        assertEquals(
            "private body",
            compactIncomingSmsRecords(listOf(pending), Instant.parse("2026-12-01T00:00:00Z")).single().body,
        )
        val tombstone = compactIncomingSmsRecords(
            listOf(record(true, "2026-08-01T00:00:00Z")), Instant.parse("2026-08-08T00:00:00Z"),
        ).single()
        assertTrue(compactIncomingSmsRecords(listOf(tombstone), Instant.parse("2026-08-30T23:59:59Z")).isNotEmpty())
        assertTrue(compactIncomingSmsRecords(listOf(tombstone), Instant.parse("2026-08-31T00:00:00Z")).isEmpty())
    }

    private fun record(reported: Boolean, reportedAt: String?) = IncomingSmsRecord(
        "11111111-1111-4111-8111-111111111111", 4,
        "22222222-2222-4222-8222-222222222222", 7, 2, "protected-handle",
        "fingerprint", "+12025550101", "private body", "2026-09-01T00:00:00Z",
        reported, reportedAt, false,
    )
}
