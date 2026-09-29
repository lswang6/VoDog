package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CallMediaBehaviorTest {
    @Test fun signalingRequiresOneRelayMatchingTheExplicitTransport() {
        val requests = mutableListOf<ClientRequest>()
        val sessions = SessionCoordinator(Session("access", "refresh", "alice"))
        val api = ClientApi(sessions, ClientTransport { request ->
            requests += request
            when {
                request.path.endsWith("/media/options") -> options("turn:relay.test:16801?transport=udp")
                request.path.endsWith("/media/offer") -> JSONObject().put("type", "answer").put("sdp", "v=0\r\n")
                else -> error("unexpected ${request.path}")
            }
        })

        val relay = api.mediaOptions("call/id", CallMediaTransport.UDP, "network-7")
        val answer = api.mediaOffer("call/id", "v=0\r\n")

        assertEquals("turn:relay.test:16801?transport=udp", relay.iceServer.url)
        assertEquals("relay", relay.iceTransportPolicy)
        assertEquals("/calls/call%2Fid/media/options", requests[0].path)
        assertEquals("udp", requests[0].body!!.getString("transport"))
        assertEquals("network-7", requests[0].body!!.getString("networkGeneration"))
        assertEquals("offer", requests[1].body!!.getString("type"))
        assertEquals("v=0\r\n", requests[1].body!!.getString("sdp"))
        assertEquals("answer", answer.type)

        assertThrows(IllegalArgumentException::class.java) {
            CallMediaOptions.parse(options("turn:relay.test:16801?transport=udp"), CallMediaTransport.TLS)
        }
        val twoUrls = options("turn:one?transport=udp")
        twoUrls.getJSONArray("iceServers").getJSONObject(0)
            .put("urls", JSONArray().put("turn:one?transport=udp").put("turn:two?transport=udp"))
        assertThrows(IllegalArgumentException::class.java) {
            CallMediaOptions.parse(twoUrls, CallMediaTransport.UDP)
        }
    }

    @Test fun opusOfferDropsOtherCodecsAndForcesMonoVoiceParameters() {
        val source = listOf(
            "v=0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8",
            "a=rtpmap:111 opus/48000/2",
            "a=fmtp:111 minptime=10;useinbandfec=1",
            "a=rtcp-fb:111 transport-cc",
            "a=rtpmap:0 PCMU/8000",
            "a=rtpmap:8 PCMA/8000",
            "",
        ).joinToString("\r\n")

        val result = opusOnlyVoiceSdp(source)

        assertTrue("m=audio 9 UDP/TLS/RTP/SAVPF 111" in result)
        assertTrue("a=rtpmap:111 opus/48000/2" in result)
        assertTrue("stereo=0" in result)
        assertTrue("sprop-stereo=0" in result)
        assertTrue("useinbandfec=1" in result)
        // S20 D1: one bitrate for all three clients, and no DTX — silence gaps reset the Pixel decoder.
        assertTrue("maxaveragebitrate=32000" in result)
        assertEquals(32000, OPUS_MAX_AVERAGE_BITRATE)
        assertFalse("usedtx" in result)
        assertFalse("maxaveragebitrate=16000" in result)
        assertFalse("PCMU" in result)
        assertFalse("PCMA" in result)
        // S70: the full shared line, spelled out so drift from Web/iOS/Voice/bridge fails here.
        assertTrue(
            "a=fmtp:111 minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;" +
                "maxplaybackrate=16000;sprop-maxcapturerate=16000\r\n" in result,
        )
        assertEquals("maxplaybackrate=16000;sprop-maxcapturerate=16000", OPUS_WIDEBAND_LIMIT)
    }

    @Test fun terminalStateFailureAndNewAttemptAlwaysCleanupWhileStaleCallbacksAreIgnored() {
        var cleanups = 0
        val states = mutableListOf<CallMediaUiState>()
        val machine = CallMediaStateMachine({ cleanups++ }, states::add)

        val first = machine.begin("call-1", CallMediaTransport.UDP)
        machine.connected(first)
        assertEquals(CallMediaPhase.CONNECTED, states.last().phase)
        machine.setMuted(true)
        assertTrue(states.last().microphoneMuted)
        machine.reconcile(mapOf("call-1" to "active"))
        assertEquals(1, cleanups)

        val second = machine.begin("call-2", CallMediaTransport.TLS)
        assertFalse(states.last().microphoneMuted)
        machine.connected(first)
        assertEquals(CallMediaPhase.CONNECTING, states.last().phase)
        machine.failed(second, "relay failed")
        assertEquals(CallMediaPhase.FAILED, states.last().phase)
        assertEquals(3, cleanups)

        val third = machine.begin("call-3", CallMediaTransport.UDP)
        machine.reconcile(mapOf("call-3" to "unknown"))
        assertEquals(CallMediaPhase.IDLE, states.last().phase)
        assertFalse(states.last().microphoneMuted)
        assertEquals(5, cleanups)
        machine.connected(third)
        assertEquals(CallMediaPhase.IDLE, states.last().phase)
    }

    /**
     * `failed()` reports whether it actually moved the session, which is what lets the runtime start
     * the grace timer and the auto-end exactly once even when the handshake and a WebRTC observer
     * callback race to report the same failure.
     */
    @Test fun onlyTheFirstFailureReportIsTerminalAndAStaleTokenReportsNothing() {
        var cleanups = 0
        val states = mutableListOf<CallMediaUiState>()
        val machine = CallMediaStateMachine({ cleanups++ }, states::add)

        val token = machine.begin("call-1", CallMediaTransport.UDP)
        assertTrue(machine.failed(token, "UDP 音频中继连接失败"))
        assertFalse(machine.failed(token, "TLS 音频中继连接失败"))
        assertEquals("UDP 音频中继连接失败", states.last().message)

        val replacement = machine.begin("call-2", CallMediaTransport.TLS)
        assertFalse(machine.failed(token, "stale"))
        assertEquals(CallMediaPhase.CONNECTING, states.last().phase)
        assertTrue(machine.failed(replacement, "TLS 音频中继连接失败"))
    }

    /**
     * Cancelling the pending grace is driven entirely by the published phase, so every exit from a
     * media failure — stop, a reconcile to a terminal call state, and a reconnect — has to leave
     * FAILED behind.
     */
    @Test fun stopReconcileAndReconnectAllLeaveTheFailedPhaseThatHoldsTheGrace() {
        val published = mutableListOf<CallMediaUiState>()
        val tracker = CallMediaGraceTracker()
        // Named `publish`: the state machine also takes a clock last (S22 grace countdown), so a
        // trailing lambda would bind to that instead.
        val machine = CallMediaStateMachine({ }, publish = { state ->
            published += state
            if (state.phase != CallMediaPhase.FAILED) tracker.cancel()
        })

        // A failure holds the call: the phase stays FAILED, so the grace survives.
        val first = machine.begin("call-1", CallMediaTransport.UDP)
        machine.failed(first, "UDP 音频中继连接失败")
        tracker.begin("call-1")
        assertTrue(tracker.isPending())

        // stop() publishes IDLE.
        machine.stop()
        assertEquals(CallMediaPhase.IDLE, published.last().phase)
        assertFalse(tracker.isPending())
        assertFalse(tracker.consume("call-1"))

        // A reconcile to a terminal call state publishes IDLE the same way.
        val second = machine.begin("call-2", CallMediaTransport.UDP)
        machine.failed(second, "UDP 音频中继连接失败")
        tracker.begin("call-2")
        machine.reconcile(mapOf("call-2" to "ended"))
        assertEquals(CallMediaPhase.IDLE, published.last().phase)
        assertFalse(tracker.consume("call-2"))

        // A retry republishes CONNECTING, then CONNECTED; neither is FAILED.
        val third = machine.begin("call-3", CallMediaTransport.UDP)
        machine.failed(third, "UDP 音频中继连接失败")
        tracker.begin("call-3")
        val retry = machine.begin("call-3", CallMediaTransport.TLS)
        assertEquals(CallMediaPhase.CONNECTING, published.last().phase)
        assertFalse(tracker.isPending())
        machine.connected(retry)
        assertEquals(CallMediaPhase.CONNECTED, published.last().phase)
        assertFalse(tracker.consume("call-3"))
    }

    @Test fun relayCandidatesAreCountedFromTheCandidateLineTheObserverSees() {
        // The session counts " typ relay" incrementally in onIceCandidate; the same marker has to
        // match the a=candidate form the final SDP carries.
        val relay = "candidate:1 1 udp 41885439 203.0.113.9 16801 typ relay raddr 0.0.0.0 rport 0"
        val host = "candidate:2 1 udp 2122260223 192.0.2.2 46123 typ host generation 0"
        assertTrue(" typ relay" in relay)
        assertFalse(" typ relay" in host)
        assertEquals(1, callRelayCandidateCount("v=0\r\na=$relay\r\na=$host\r\n"))
    }

    private fun options(url: String) = JSONObject()
        .put("iceTransportPolicy", "relay")
        .put(
            "iceServers",
            JSONArray().put(
                JSONObject()
                    .put("urls", JSONArray().put(url))
                    .put("username", "expires:alice")
                    .put("credential", "signed-secret"),
            ),
        )
}
