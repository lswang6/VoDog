package org.vodog

import org.vodog.CallMediaGracePolicy.Plan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallMediaGracePolicyTest {
    @Test fun graceIsThirtySeconds() {
        assertEquals(30, CallMediaGracePolicy.GRACE_SECONDS)
        assertEquals(30_000L, CallMediaGracePolicy.GRACE_MILLIS)
        assertTrue(CallMediaGracePolicy.FOOTNOTE.contains("30 秒"))
    }

    @Test fun ordinaryFailureHoldsTheCallForGrace() {
        assertEquals(
            Plan.HOLD_FOR_GRACE,
            CallMediaGracePolicy.plan(
                CallMediaSessionException(CallMediaFailureKind.ICE_GATHERING_TIMED_OUT, CallMediaTransport.TLS),
            ),
        )
        assertEquals(
            Plan.HOLD_FOR_GRACE,
            CallMediaGracePolicy.plan(
                CallMediaSessionException(CallMediaFailureKind.NO_RELAY_CANDIDATE, CallMediaTransport.UDP),
            ),
        )
        assertEquals(Plan.HOLD_FOR_GRACE, CallMediaGracePolicy.plan(ApiError(503, "GATEWAY_OFFLINE", "")))
        assertEquals(
            Plan.HOLD_FOR_GRACE,
            CallMediaGracePolicy.plan(
                CallMediaSessionException(CallMediaFailureKind.MICROPHONE_PERMISSION_DENIED, CallMediaTransport.UDP),
            ),
        )
    }

    @Test fun revokedCallEndsImmediatelyWithoutGrace() {
        // Code-only, status-agnostic: the server already let the call go.
        assertEquals(Plan.END_IMMEDIATELY, CallMediaGracePolicy.plan(ApiError(409, "MEDIA_REVOKED", "")))
        assertEquals(Plan.END_IMMEDIATELY, CallMediaGracePolicy.plan(ApiError(410, "MEDIA_REVOKED", "")))
        assertEquals(setOf("MEDIA_REVOKED"), CallMediaGracePolicy.SERVER_ENDED_CODES)
    }

    @Test fun graceFiresExactlyOnce() {
        val tracker = CallMediaGraceTracker()
        tracker.begin("call-1")
        assertTrue(tracker.isPending())
        assertTrue(tracker.consume("call-1"))
        assertFalse(tracker.consume("call-1"))
        assertFalse(tracker.isPending())
    }

    @Test fun stopCancelsThePendingGrace() {
        val tracker = CallMediaGraceTracker()
        tracker.begin("call-1")
        tracker.cancel()
        assertFalse(tracker.isPending())
        assertFalse(tracker.consume("call-1"))
    }

    @Test fun reconnectCancelsTheGrace() {
        val tracker = CallMediaGraceTracker()
        tracker.begin("call-1")
        tracker.cancel()
        tracker.begin("call-1")
        tracker.cancel()
        assertFalse(tracker.consume("call-1"))
    }

    @Test fun graceOfAnotherCallNeverEndsTheCurrentOne() {
        val tracker = CallMediaGraceTracker()
        tracker.begin("call-1")
        assertFalse(tracker.consume("call-2"))
        assertTrue(tracker.isPending())
        assertTrue(tracker.consume("call-1"))
    }

    @Test fun aNewFailureReplacesThePendingGrace() {
        val tracker = CallMediaGraceTracker()
        tracker.begin("call-1")
        tracker.begin("call-2")
        assertFalse(tracker.consume("call-1"))
        assertTrue(tracker.consume("call-2"))
    }
}
