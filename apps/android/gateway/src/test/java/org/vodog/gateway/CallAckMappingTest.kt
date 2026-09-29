package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallAckMappingTest {
    private val spec = CallCommandSpec(
        "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
        4, 10, "2026-09-09T02:00:30Z", CallCommandKind.DIAL,
        "33333333-3333-4333-8333-333333333333", "+12025550101",
    )

    @Test fun submittedAckDoesNotClaimConnection() {
        val ack = CallExecutionDecision.Submitted(
            "device-a", ActualTelecomState.DIALING, "2026-09-09T02:00:00Z",
        ).toAck(spec)
        assertEquals("acked", ack.status)
        assertEquals("DIALING", ack.telecomState)
        assertEquals("submitted", ack.result.phase)
    }

    @Test fun unknownAckUsesServerLockPreservingContract() {
        val ack = CallExecutionDecision.Unknown(
            "TELECOM_RESULT_UNKNOWN", "2026-09-09T02:00:00Z",
        ).toAck(spec)
        assertEquals("rejected", ack.status)
        assertEquals("UNKNOWN", ack.telecomState)
        assertEquals("unknown", ack.result.phase)
        assertEquals("execution_unknown", ack.result.reason)
    }

    @Test fun definitePreEffectRejectionHasNoTelecomState() {
        val ack = CallExecutionDecision.Rejected("control_disabled").toAck(spec)
        assertEquals("rejected", ack.status)
        assertNull(ack.telecomState)
        assertEquals("not_executed", ack.result.phase)
        assertEquals(ack, pendingCallAckFromRoundTripFields(pendingCallAckRoundTripFields(ack)))
    }

    @Test fun persistedNullTelecomStateRoundTripsAsNullRatherThanLiteralNull() {
        val ack = CallExecutionDecision.Rejected("control_disabled").toAck(spec)
        val restored = pendingCallAckFromRoundTripFields(pendingCallAckRoundTripFields(ack))
        assertNull(restored.telecomState)
        assertEquals(ack, restored)
    }

    @Test fun ackFailureClassificationIsFinite() {
        assertEquals("http_4xx", classifyAckFailure(IllegalStateException("HTTP 400: bad state")))
        assertEquals("http_5xx", classifyAckFailure(IllegalStateException("HTTP 503")))
        assertEquals("transport_failure", classifyAckFailure(IllegalStateException("socket closed")))
    }

    @Test fun payloadCollisionAckCannotMarkTheOriginalExecutionAsDelivered() {
        val ack = CallExecutionDecision.Rejected("command_payload_collision").toAck(spec)
        assertNull(ack.commandFingerprint)
    }
}
