package org.vodog.gateway

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallJournalRetentionTest {
    private val commandId = "11111111-1111-4111-8111-111111111111"
    private val callId = "22222222-2222-4222-8222-222222222222"
    private val simId = "33333333-3333-4333-8333-333333333333"

    @Test fun rejectedRecordNeedsAckAndSevenDaysBeforeSensitiveTombstone() {
        val record = record(CallExecutionPhase.REJECTED).copy(
            reason = "command_expired",
            ackDeliveredAt = "2026-09-01T00:00:00Z",
        )
        assertEquals(
            CallRetentionState.FULL,
            compactCallRecords(listOf(record), Instant.parse("2026-09-07T23:59:59Z")).single().retentionState,
        )
        val compacted = compactCallRecords(
            listOf(record), Instant.parse("2026-09-08T00:00:00Z"),
        ).single()
        assertEquals(CallRetentionState.TOMBSTONE, compacted.retentionState)
        assertEquals(record.commandFingerprint, compacted.commandFingerprint)
        assertTrue(compacted.spec.remoteNumber != record.spec.remoteNumber)
        assertNull(compacted.target)
    }

    @Test fun submittedRecordRequiresAckAndAcceptedSnapshotEvidence() {
        val base = record(CallExecutionPhase.SUBMITTED).copy(
            effectStartedAt = "2026-08-31T23:59:59Z",
            deviceCallId = "device-a",
            telecomState = ActualTelecomState.DIALING,
            ackDeliveredAt = "2026-09-01T00:00:00Z",
        )
        val now = Instant.parse("2026-09-20T00:00:00Z")
        assertEquals(CallRetentionState.FULL, compactCallRecords(listOf(base), now).single().retentionState)
        val incomplete = base.copy(
            terminalConfirmedAt = "2026-09-02T00:00:00Z",
            terminalEvidenceKind = "untrusted_local_state",
            terminalSnapshotId = "44444444-4444-4444-8444-444444444444",
        )
        assertEquals(CallRetentionState.FULL, compactCallRecords(listOf(incomplete), now).single().retentionState)
        val proven = incomplete.copy(terminalEvidenceKind = "confirmed_absent_snapshot")
        assertEquals(CallRetentionState.TOMBSTONE, compactCallRecords(listOf(proven), now).single().retentionState)
    }

    @Test fun tombstoneDoesNotExpireByAgeWithoutReplayHorizon() {
        val tombstone = record(CallExecutionPhase.REJECTED).copy(
            reason = "command_expired",
            ackDeliveredAt = "2025-01-01T00:00:00Z",
            retentionState = CallRetentionState.TOMBSTONE,
            compactedAt = "2025-01-08T00:00:00Z",
        )
        assertEquals(
            listOf(tombstone),
            compactCallRecords(listOf(tombstone), Instant.parse("2026-09-10T00:00:00Z")),
        )
    }

    @Test fun ackCommitKeepsOutboxUntilExecutionEvidenceIsDurable() {
        val steps = mutableListOf<String>()
        val ack = pendingAck()
        commitCallAckDelivery(
            ack,
            send = { steps += "server" },
            markEvidence = { steps += "evidence" },
            removeOutbox = { steps += "remove" },
        )
        assertEquals(listOf("server", "evidence", "remove"), steps)

        steps.clear()
        runCatching {
            commitCallAckDelivery(
                ack,
                send = { steps += "server" },
                markEvidence = { steps += "evidence"; error("commit failed") },
                removeOutbox = { steps += "remove" },
            )
        }
        assertEquals(listOf("server", "evidence"), steps)
    }

    @Test fun snapshotCommitRemovesOutboxOnlyAfterBothJournalsCommit() {
        val steps = mutableListOf<String>()
        commitAcceptedTelecomSnapshot(
            markExecutionEvidence = { steps += "execution" },
            pruneDeviceCalls = { steps += "device" },
            removeSnapshotOutbox = { steps += "outbox" },
        )
        assertEquals(listOf("execution", "device", "outbox"), steps)

        steps.clear()
        runCatching {
            commitAcceptedTelecomSnapshot(
                markExecutionEvidence = { steps += "execution" },
                pruneDeviceCalls = { steps += "device"; error("commit failed") },
                removeSnapshotOutbox = { steps += "outbox" },
            )
        }
        assertEquals(listOf("execution", "device"), steps)
    }

    private fun record(phase: CallExecutionPhase): CallExecutionRecord {
        val spec = CallCommandSpec(
            commandId,
            callId,
            3,
            9,
            "2026-09-09T01:00:30Z",
            CallCommandKind.DIAL,
            simId,
            "+12025550101",
        )
        return CallExecutionRecord(spec, spec.fingerprint, phase, dialTarget(), null, null, null, null)
    }

    private fun dialTarget() = FrozenCallTarget.Dial(
        simId,
        7,
        1,
        "protected-phone-account",
        "protected-iccid-fingerprint",
    )

    private fun pendingAck() = PendingCallAck(
        commandId,
        3,
        "rejected",
        CallAckResult("not_executed", "command_expired"),
        null,
        commandFingerprint = record(CallExecutionPhase.REJECTED).commandFingerprint,
    )

    // S22: the journal cap must evict retired records instead of silently failing every call command.
    private fun retired(generation: Long, sequence: Long, id: String, expiresAt: String = "2026-09-01T00:00:30Z") =
        record(CallExecutionPhase.REJECTED).let { base ->
            base.copy(
                spec = base.spec.copy(commandId = id, generation = generation, sequence = sequence, expiresAt = expiresAt),
                reason = "call_not_found",
                ackDeliveredAt = "2026-09-01T00:00:01Z",
            )
        }

    @Test fun evictionDropsOldestRetiredRecordsAcrossGenerationsFirst() {
        val now = Instant.parse("2026-09-11T16:02:25Z")
        val gen2 = retired(2, 40, "a2000000-0000-4000-8000-000000000040")
        val gen3Old = retired(3, 6, "a3000000-0000-4000-8000-000000000006")
        val gen3New = retired(3, 1999, "a3000000-0000-4000-8000-000000001999")
        val live = record(CallExecutionPhase.SUBMITTED).copy(
            spec = record(CallExecutionPhase.SUBMITTED).spec.copy(
                commandId = "a3000000-0000-4000-8000-000000000005", sequence = 5,
            ),
            effectStartedAt = "2026-09-01T00:00:02Z",
            deviceCallId = "device-live",
            telecomState = ActualTelecomState.ACTIVE,
            ackDeliveredAt = "2026-09-01T00:00:03Z",
        )
        val retained = evictRetiredCallRecords(listOf(gen3New, live, gen3Old, gen2), now, 2)
        assertEquals(listOf(gen3New, live), retained)
    }

    @Test fun evictionNeverTouchesUnacknowledgedUnterminatedOrUnexpiredRecords() {
        val now = Instant.parse("2026-09-11T16:02:25Z")
        val unacked = retired(2, 1, "b2000000-0000-4000-8000-000000000001").copy(ackDeliveredAt = null)
        val effectStarted = retired(2, 2, "b2000000-0000-4000-8000-000000000002").copy(
            effectStartedAt = "2026-09-01T00:00:02Z",
        )
        val submittedUnconfirmed = retired(2, 3, "b2000000-0000-4000-8000-000000000003").copy(
            phase = CallExecutionPhase.SUBMITTED, reason = null, effectStartedAt = "2026-09-01T00:00:02Z",
        )
        val unexpired = retired(2, 4, "b2000000-0000-4000-8000-000000000004", expiresAt = "2026-09-11T16:02:26Z")
        val input = listOf(unacked, effectStarted, submittedUnconfirmed, unexpired)
        assertEquals(input, evictRetiredCallRecords(input, now, 1))
    }

    @Test fun evictionAcceptsTombstonesAndSnapshotConfirmedSubmissions() {
        val now = Instant.parse("2026-09-11T16:02:25Z")
        val tombstone = compactCallRecords(
            listOf(retired(3, 7, "c3000000-0000-4000-8000-000000000007")), Instant.parse("2026-09-09T00:00:00Z"),
        ).single()
        assertEquals(CallRetentionState.TOMBSTONE, tombstone.retentionState)
        val confirmed = retired(3, 8, "c3000000-0000-4000-8000-000000000008").copy(
            phase = CallExecutionPhase.SUBMITTED, reason = null, effectStartedAt = "2026-09-01T00:00:02Z",
            terminalConfirmedAt = "2026-09-01T00:01:00Z", terminalEvidenceKind = "confirmed_absent_snapshot",
            terminalSnapshotId = "44444444-4444-4444-8444-444444444444",
        )
        val keep = retired(3, 9, "c3000000-0000-4000-8000-000000000009", expiresAt = "2026-09-11T17:00:00Z")
        assertEquals(listOf(keep), evictRetiredCallRecords(listOf(keep, confirmed, tombstone), now, 1))
    }

    @Test fun evictionIsANoOpBelowTheCap() {
        val now = Instant.parse("2026-09-11T16:02:25Z")
        val input = listOf(retired(2, 1, "d2000000-0000-4000-8000-000000000001"))
        assertEquals(input, evictRetiredCallRecords(input, now, 1))
        assertEquals(input, evictRetiredCallRecords(input, now, 5))
    }
}
