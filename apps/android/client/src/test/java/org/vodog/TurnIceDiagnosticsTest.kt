package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.IceCandidateErrorEvent

class TurnIceDiagnosticsTest {
    @Test fun classifiesTlsCertificateErrorWithoutCopyingEventSecrets() {
        val event = IceCandidateErrorEvent(
            "192.0.2.2",
            16802,
            "turns:private@relay.example:16802?transport=tcp",
            701,
            "SSL certificate verification failed",
        )

        val summary = summarizeCallIceFailure(event)

        assertEquals(CallIceFailureSummary(701, CallIceFailureKind.TLS_CERTIFICATE), summary)
        assertFalse(summary.toString().contains("private"))
        assertFalse(summary.toString().contains("192.0.2.2"))
        assertTrue(callRelayUnavailableMessage(CallMediaTransport.TLS, summary).contains("安全验证"))
    }

    @Test fun detectsEmptyRelayGatheringAndProvidesTransportSpecificRecovery() {
        val hostOnly = "v=0\r\na=candidate:1 1 udp 1 192.0.2.2 1234 typ host\r\n"

        assertEquals(0, callRelayCandidateCount(hostOnly))
        assertTrue(callRelayUnavailableMessage(CallMediaTransport.TLS, null).contains("改用 UDP"))
        assertTrue(callRelayUnavailableMessage(CallMediaTransport.UDP, null).contains("改用 TLS"))
    }
}
