package org.vodog.gateway.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.IceCandidateErrorEvent

class TurnIceDiagnosticsTest {
    @Test fun countsOnlyRelayCandidates() {
        val sdp = """
            v=0
            a=candidate:1 1 udp 1 192.0.2.2 1234 typ host
            a=candidate:2 1 tcp 1 203.0.113.9 16803 typ relay raddr 0.0.0.0 rport 0 tcptype passive
            a=end-of-candidates
        """.trimIndent()

        assertEquals(1, relayCandidateCount(sdp))
        assertEquals(0, relayCandidateCount("v=0\r\na=end-of-candidates\r\n"))
    }

    @Test fun recognisesARelayCandidateAsTheObserverDeliversIt() {
        // PeerConnection.Observer.onIceCandidate hands over the attribute value only: no `a=` prefix.
        assertTrue(isRelayCandidate("candidate:2 1 tcp 1 203.0.113.9 16803 typ relay raddr 0.0.0.0 rport 0"))
        assertTrue(isRelayCandidate("candidate:3 1 udp 1 203.0.113.9 16801 typ relay"))
        assertFalse(isRelayCandidate("candidate:1 1 udp 1 192.0.2.2 1234 typ host"))
        assertFalse(isRelayCandidate("candidate:4 1 udp 1 203.0.113.9 3478 typ srflx raddr 192.0.2.2 rport 1234"))
        assertFalse(isRelayCandidate(""))
    }

    @Test fun summarizesCertificateFailureWithoutRetainingSensitiveEventFields() {
        val event = IceCandidateErrorEvent(
            "192.0.2.2",
            16802,
            "turns:secret-user:secret-password@relay.example:16802?transport=tcp",
            701,
            "TLS certificate verify failed for relay.example",
        )

        val summary = summarizeIceFailure(event)

        assertEquals(701, summary.errorCode)
        assertEquals(IceFailureKind.TLS_CERTIFICATE, summary.kind)
        assertEquals("turns:relay.example:16802?transport=tcp", summary.url)
        assertFalse(summary.toString().contains("secret"))
        assertFalse(summary.toString().contains("192.0.2.2"))
    }

    @Test fun mediaFailedCarriesTheLastIceErrorInShortFields() {
        val summary = summarizeIceFailure(
            IceCandidateErrorEvent("192.0.2.2", 0, "turn:203.0.113.9:16801?transport=udp", 701, "STUN binding request timed out."),
        )

        assertEquals(
            mapOf(
                "iceErrorCode" to 701,
                "iceErrorText" to "STUN binding request timed out.",
                "iceUrl" to "turn:203.0.113.9:16801?transport=udp",
            ),
            iceFailureDiagFields(summary),
        )
        assertTrue(iceFailureDiagFields(null).isEmpty())
    }

    @Test fun terminalErrorExplainsTransportAndBoundedReason() {
        val error = RelayIceUnavailableException(
            IceTransport.TLS,
            IceFailureSummary(701, IceFailureKind.UNREACHABLE),
        )

        assertTrue(error.message.orEmpty().contains("TLS"))
        assertTrue(error.message.orEmpty().contains("701"))
    }
}
