package org.vodog.gateway

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayIdentityChangePolicyTest {
    @Test fun allowsOnlyCompletelyIdleReadableState() {
        assertNull(GatewayIdentityChangePolicy.blockedBy(IdentityChangeEvidence()))
    }

    @Test fun serviceAndOwnedAudioCleanupBlockBeforeIdentityMutation() {
        assertEquals(IdentityChangeBlock.SERVICE_RUNNING, blocked(serviceRunning = true))
        assertEquals(IdentityChangeBlock.AUDIO_SESSION_ACTIVE, blocked(audioSessionActive = true))
        assertEquals(IdentityChangeBlock.AUDIO_HANDOFF_PENDING, blocked(audioHandoffPending = true))
        assertEquals(IdentityChangeBlock.MUTE_RESTORE_PENDING, blocked(muteRestorePending = true))
    }

    @Test fun authoritativeTelecomAndRegistryMustBothBeIdle() {
        assertEquals(IdentityChangeBlock.TELECOM_BUSY, blocked(telecomBusy = true))
        assertEquals(IdentityChangeBlock.TELECOM_REGISTRY_BUSY, blocked(telecomRegistryBusy = true))
    }

    @Test fun everyUnconfirmedCallSmsOrOutboxEvidenceBlocks() {
        assertEquals(IdentityChangeBlock.DEVICE_CALL_PENDING, blocked(deviceCallPending = true))
        assertEquals(
            IdentityChangeBlock.CALL_EXECUTION_RECONCILIATION_REQUIRED,
            blocked(callExecutionReconciliationRequired = true),
        )
        assertEquals(IdentityChangeBlock.CALL_ACK_PENDING, blocked(callAckPending = true))
        assertEquals(IdentityChangeBlock.COMMAND_RESULT_PENDING, blocked(commandResultPending = true))
        assertEquals(IdentityChangeBlock.SNAPSHOT_PENDING, blocked(snapshotPending = true))
        assertEquals(IdentityChangeBlock.SMS_EXECUTION_PENDING, blocked(smsExecutionPending = true))
        assertEquals(IdentityChangeBlock.INCOMING_SMS_PENDING, blocked(incomingSmsPending = true))
        assertEquals(IdentityChangeBlock.OUTGOING_SMS_PENDING, blocked(outgoingSmsPending = true))
    }

    @Test fun corruptEvidenceFailsClosedWithUserFacingReason() {
        val block = blocked(evidenceUnreadable = true)
        assertEquals(IdentityChangeBlock.EVIDENCE_UNREADABLE, block)
        assertEquals(
            "本机执行记录无法安全核验，暂不能更换设备身份",
            GatewayIdentityChangePolicy.message(requireNotNull(block)),
        )
    }

    @Test fun waitsForAsynchronousServiceCleanupThenAllows() {
        val reads = ArrayDeque(listOf(
            IdentityChangeEvidence(serviceRunning = true),
            IdentityChangeEvidence(audioSessionActive = true),
            IdentityChangeEvidence(),
        ))
        var pauses = 0
        val gate = GatewayIdentityChangeGate(
            readEvidence = { reads.removeFirst() },
            pause = { pauses++ },
            nowNanos = { 0L },
        )
        gate.awaitResidualCleanup(timeoutNanos = 10L, pollMillis = 1L)
        assertEquals(2, pauses)
    }

    @Test fun freshCheckPreventsPairRequestWhenStateChangesAfterInitialIdleRead() {
        val reads = ArrayDeque(listOf(
            IdentityChangeEvidence(),
            IdentityChangeEvidence(telecomBusy = true),
        ))
        val gate = GatewayIdentityChangeGate(readEvidence = { reads.removeFirst() })
        gate.awaitResidualCleanup(timeoutNanos = 10L, pollMillis = 1L)
        var remoteMutationRan = false
        assertThrows(IdentityChangeBlockedException::class.java) {
            gate.runAfterFreshCheck { remoteMutationRan = true }
        }
        assertFalse(remoteMutationRan)
    }

    @Test fun freshIdleCheckRunsMutationExactlyOnce() {
        val gate = GatewayIdentityChangeGate(readEvidence = { IdentityChangeEvidence() })
        var count = 0
        assertEquals("paired", gate.runAfterFreshCheck { count++; "paired" })
        assertEquals(1, count)
        assertTrue(GatewayIdentityChangePolicy.message(IdentityChangeBlock.CONTROL_ENABLED).contains("关闭"))
    }

    @Test fun smsEvidenceRequiresTerminalAckAndEveryEventDelivery() {
        fun record(phase: String, acked: Boolean, eventDelivered: Boolean = true) = JSONObject()
            .put("phase", phase).put("ackDelivered", acked).put("tombstone", false)
            .put("events", JSONArray().put(JSONObject().put("delivered", eventDelivered)))
        assertTrue(smsExecutionEvidencePending(JSONArray().put(record("SUBMITTED", true))))
        assertTrue(smsExecutionEvidencePending(JSONArray().put(record("DELIVERED", false))))
        assertTrue(smsExecutionEvidencePending(JSONArray().put(record("FAILED", true, false))))
        assertFalse(smsExecutionEvidencePending(JSONArray().put(record("DELIVERED", true))))
        assertFalse(smsExecutionEvidencePending(JSONArray().put(record("FAILED", true))))
    }

    @Test fun incomingEvidenceRequiresReportedOrExistingTombstone() {
        assertTrue(incomingSmsEvidencePending(JSONArray().put(
            JSONObject().put("reported", false).put("tombstone", false),
        )))
        assertFalse(incomingSmsEvidencePending(JSONArray().put(
            JSONObject().put("reported", true).put("tombstone", false),
        )))
        assertFalse(incomingSmsEvidencePending(JSONArray().put(
            JSONObject().put("reported", false).put("tombstone", true),
        )))
    }

    @Test fun callExecutionEvidenceNeedsDurableProofAndNeverInfersFromCurrentIdle() {
        fun record(
            phase: String,
            ackAt: String? = null,
            terminalAt: String? = null,
            retention: String = "FULL",
        ) = JSONObject().put("phase", phase).put("retentionState", retention)
            .put("ackDeliveredAt", ackAt ?: JSONObject.NULL)
            .put("terminalConfirmedAt", terminalAt ?: JSONObject.NULL)
            .put("terminalEvidenceKind", if (terminalAt == null) JSONObject.NULL else "confirmed_absent_snapshot")
            .put("terminalSnapshotId", if (terminalAt == null) JSONObject.NULL else "00000000-0000-4000-8000-000000000001")
        assertTrue(callExecutionEvidenceRequiresReconciliation(JSONArray().put(record("PREPARED"))))
        assertTrue(callExecutionEvidenceRequiresReconciliation(JSONArray().put(record("REJECTED"))))
        assertTrue(callExecutionEvidenceRequiresReconciliation(JSONArray().put(
            record("SUBMITTED", "2026-09-10T00:00:00Z"),
        )))
        assertFalse(callExecutionEvidenceRequiresReconciliation(JSONArray().put(
            record("REJECTED", "2026-09-10T00:00:00Z"),
        )))
        assertFalse(callExecutionEvidenceRequiresReconciliation(JSONArray().put(
            record("SUBMITTED", "2026-09-10T00:00:00Z", "2026-09-10T00:01:00Z"),
        )))
        assertFalse(callExecutionEvidenceRequiresReconciliation(JSONArray().put(
            record("UNKNOWN", retention = "TOMBSTONE"),
        )))
    }

    private fun blocked(
        serviceRunning: Boolean = false,
        audioSessionActive: Boolean = false,
        audioHandoffPending: Boolean = false,
        muteRestorePending: Boolean = false,
        telecomBusy: Boolean = false,
        telecomRegistryBusy: Boolean = false,
        deviceCallPending: Boolean = false,
        callExecutionReconciliationRequired: Boolean = false,
        callAckPending: Boolean = false,
        commandResultPending: Boolean = false,
        snapshotPending: Boolean = false,
        smsExecutionPending: Boolean = false,
        incomingSmsPending: Boolean = false,
        outgoingSmsPending: Boolean = false,
        evidenceUnreadable: Boolean = false,
    ) = GatewayIdentityChangePolicy.blockedBy(IdentityChangeEvidence(
        serviceRunning = serviceRunning,
        audioSessionActive = audioSessionActive,
        audioHandoffPending = audioHandoffPending,
        muteRestorePending = muteRestorePending,
        telecomBusy = telecomBusy,
        telecomRegistryBusy = telecomRegistryBusy,
        deviceCallPending = deviceCallPending,
        callExecutionReconciliationRequired = callExecutionReconciliationRequired,
        callAckPending = callAckPending,
        commandResultPending = commandResultPending,
        snapshotPending = snapshotPending,
        smsExecutionPending = smsExecutionPending,
        incomingSmsPending = incomingSmsPending,
        outgoingSmsPending = outgoingSmsPending,
        evidenceUnreadable = evidenceUnreadable,
    ))
}
