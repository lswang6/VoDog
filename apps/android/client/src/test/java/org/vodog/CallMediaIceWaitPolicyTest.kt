package org.vodog

import org.vodog.CallMediaIceWaitPolicy.Progress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.PeerConnection.IceConnectionState

class CallMediaIceWaitPolicyTest {
    @Test fun connectWaitIsTwelveSecondsAndGraceIsFive() {
        assertEquals(12_000L, CallMediaIceWaitPolicy.CONNECT_TIMEOUT_MS)
        assertEquals(5_000L, CallMediaIceWaitPolicy.DISCONNECT_GRACE_MS)
        assertEquals(
            CallMediaIceWaitPolicy.CONNECT_TIMEOUT_MS,
            CallMediaIceWaitPolicy.CONNECT_POLL_INTERVAL_MS * CallMediaIceWaitPolicy.CONNECT_POLL_COUNT,
        )
    }

    @Test fun connectedAndCompletedAreUsable() {
        assertEquals(Progress.CONNECTED, CallMediaIceWaitPolicy.progress(IceConnectionState.CONNECTED))
        assertEquals(Progress.CONNECTED, CallMediaIceWaitPolicy.progress(IceConnectionState.COMPLETED))
        assertTrue(CallMediaIceWaitPolicy.isUsable(IceConnectionState.CONNECTED))
        assertTrue(CallMediaIceWaitPolicy.isUsable(IceConnectionState.COMPLETED))
    }

    @Test fun failedAndClosedAreFailures() {
        assertEquals(Progress.FAILED, CallMediaIceWaitPolicy.progress(IceConnectionState.FAILED))
        assertEquals(Progress.FAILED, CallMediaIceWaitPolicy.progress(IceConnectionState.CLOSED))
        assertFalse(CallMediaIceWaitPolicy.isUsable(IceConnectionState.FAILED))
        assertFalse(CallMediaIceWaitPolicy.isUsable(IceConnectionState.CLOSED))
    }

    @Test fun checkingNewAndDisconnectedKeepWaiting() {
        assertEquals(Progress.WAITING, CallMediaIceWaitPolicy.progress(IceConnectionState.NEW))
        assertEquals(Progress.WAITING, CallMediaIceWaitPolicy.progress(IceConnectionState.CHECKING))
        assertEquals(Progress.WAITING, CallMediaIceWaitPolicy.progress(IceConnectionState.DISCONNECTED))
        assertEquals(Progress.WAITING, CallMediaIceWaitPolicy.progress(null))
        assertFalse(CallMediaIceWaitPolicy.isUsable(IceConnectionState.CHECKING))
        assertFalse(CallMediaIceWaitPolicy.isUsable(IceConnectionState.DISCONNECTED))
    }
}
