package org.vodog.gateway.media

import org.junit.Assert.assertEquals
import org.junit.Test
import org.webrtc.PeerConnection

/**
 * The fatal set is the whole fix: a transient DISCONNECTED must not tear a live call down, because
 * libwebrtc escalates a dead pair to FAILED itself. Enumerating the enums keeps a future libwebrtc
 * state from silently joining either set.
 */
class GatewayDataChannelTransportStateTest {

    @Test fun onlyFailedAndClosedIceStatesAreFatal() {
        assertEquals(
            setOf(PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.CLOSED),
            PeerConnection.IceConnectionState.values().filter(::isFatalIceState).toSet(),
        )
    }

    @Test fun onlyFailedAndClosedPeerStatesAreFatal() {
        assertEquals(
            setOf(PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED),
            PeerConnection.PeerConnectionState.values().filter(::isFatalPeerState).toSet(),
        )
    }
}
