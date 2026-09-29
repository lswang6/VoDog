package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class CallMediaRejoinPolicyTest {
    private val udp = CallMediaTransport.UDP
    private val tls = CallMediaTransport.TLS

    @Test fun offlineEpisodeRestartsFromUdpAfterTheNetworkReturns() {
        // Dropped TLS, attempt 1 failed offline and reruns once the network is back: UDP, then TLS (switch once, as today).
        assertEquals(udp, CallMediaRejoinPolicy.transport(1, tls, relay = false, offlineAttempt = 1))
        assertEquals(tls, CallMediaRejoinPolicy.transport(2, tls, relay = false, offlineAttempt = 1))
        assertEquals(tls, CallMediaRejoinPolicy.transport(3, tls, relay = false, offlineAttempt = 1))
        // Attempt 1 failed online (UDP after dropped TLS), attempt 2 went offline: its rerun is UDP.
        assertEquals(udp, CallMediaRejoinPolicy.transport(2, tls, relay = false, offlineAttempt = 2))
        assertEquals(tls, CallMediaRejoinPolicy.transport(3, tls, relay = false, offlineAttempt = 2))
        // Never offline: unchanged. Relay: always TLS.
        assertEquals(tls, CallMediaRejoinPolicy.transport(1, tls, relay = false, offlineAttempt = 0))
        for (attempt in 1..3) {
            assertEquals(tls, CallMediaRejoinPolicy.transport(attempt, udp, relay = true, offlineAttempt = 1))
        }
    }

    @Test fun firstAttemptKeepsTransportLaterAttemptsSwitchRelayAlwaysTls() {
        assertEquals(udp, CallMediaRejoinPolicy.transport(1, udp, relay = false))
        assertEquals(tls, CallMediaRejoinPolicy.transport(2, udp, relay = false))
        assertEquals(tls, CallMediaRejoinPolicy.transport(3, udp, relay = false))
        assertEquals(tls, CallMediaRejoinPolicy.transport(1, tls, relay = false))
        assertEquals(udp, CallMediaRejoinPolicy.transport(2, tls, relay = false))
        for (attempt in 1..3) for (dropped in CallMediaTransport.entries) {
            assertEquals(tls, CallMediaRejoinPolicy.transport(attempt, dropped, relay = true))
        }
    }

    @Test fun conflictBacksOffTwoSecondsAndCounts() {
        val conflict = ApiError(409, "MEDIA_LEG_CONNECTED", "busy")
        val viaControl = ApiError(503, "MEDIA_BRIDGE_UNAVAILABLE", "bridge refused")
        assertEquals(2_000L, CallMediaRejoinPolicy.nextDelayMs(1, conflict, attemptMs = 300, elapsedMs = 300))
        assertEquals(2_000L, CallMediaRejoinPolicy.nextDelayMs(2, viaControl, attemptMs = 300, elapsedMs = 3_000))
        assertNull(CallMediaRejoinPolicy.nextDelayMs(3, conflict, attemptMs = 300, elapsedMs = 6_000))
    }

    @Test fun fastFailuresArePacedSlowOnesRetryAtOnce() {
        val offline = IOException("network down")
        assertEquals(14_000L, CallMediaRejoinPolicy.nextDelayMs(1, offline, attemptMs = 1_000, elapsedMs = 1_000))
        assertEquals(0L, CallMediaRejoinPolicy.nextDelayMs(1, offline, attemptMs = 20_000, elapsedMs = 20_000))
    }

    @Test fun stopsAtThreeAttemptsTheSixtySecondWindowOrAnUnfixableRefusal() {
        val offline = IOException("network down")
        assertNull(CallMediaRejoinPolicy.nextDelayMs(3, offline, attemptMs = 1_000, elapsedMs = 30_000))
        assertNull(CallMediaRejoinPolicy.nextDelayMs(2, offline, attemptMs = 1_000, elapsedMs = 50_000))
        assertNull(CallMediaRejoinPolicy.nextDelayMs(1, ApiError(403, "MEDIA_REVOKED", "revoked"), 100, 100))
        assertNull(CallMediaRejoinPolicy.nextDelayMs(1, ApiError(404, "NOT_FOUND", "gone"), 100, 100))
    }

    @Test fun offlineNeedsNoNetworkOrAnUnvalidatedDnsOrConnectFailure() {
        val timeout = CallMediaSessionException(CallMediaFailureKind.ICE_CONNECT_TIMED_OUT, udp)
        val dns = IOException("options", java.net.UnknownHostException("api"))
        val refused = java.net.ConnectException("refused")
        assertTrue(CallMediaRejoinPolicy.isOffline(timeout, hasNetwork = false, validated = false))
        assertTrue(CallMediaRejoinPolicy.isOffline(dns, hasNetwork = true, validated = false))
        assertTrue(CallMediaRejoinPolicy.isOffline(refused, hasNetwork = true, validated = false))
        assertFalse(CallMediaRejoinPolicy.isOffline(dns, hasNetwork = true, validated = true))
        assertFalse(CallMediaRejoinPolicy.isOffline(timeout, hasNetwork = true, validated = false))
        assertFalse("an HTTP answer proves the network works",
            CallMediaRejoinPolicy.isOffline(ApiError(503, "MEDIA_BRIDGE_UNAVAILABLE", "x"), hasNetwork = false, validated = false))
    }

    @Test fun setupFailureOfflineRejoinsFromTheUnfailedFirstAttempt() {
        // iOS 919e1740 shape: ICE timed out on the first connect, TLS fallback died on DNS, device offline.
        val iceTimeout = CallMediaSessionException(CallMediaFailureKind.ICE_CONNECT_TIMED_OUT, udp)
        val probeDns = CallMediaProbeException(java.net.UnknownHostException("api"))
        assertTrue(CallMediaRejoinPolicy.isOffline(iceTimeout, hasNetwork = false, validated = false))
        assertTrue(CallMediaRejoinPolicy.isOffline(probeDns, hasNetwork = true, validated = false))
        assertFalse("online setup failures keep the terminal path",
            CallMediaRejoinPolicy.isOffline(iceTimeout, hasNetwork = true, validated = true))
        assertEquals("setup_offline", CallMediaRejoinPolicy.SETUP_OFFLINE_REASON)
        // S73h: setup_offline starts at offlineAttempt 1, so attempt 1 is UDP even when TLS was requested.
        assertEquals(udp, CallMediaRejoinPolicy.transport(1, tls, relay = false, offlineAttempt = 1))
        assertEquals(tls, CallMediaRejoinPolicy.transport(2, tls, relay = false, offlineAttempt = 1))

        // A failed setup attempt never calls failed(), so its CONNECTING token can still rejoin.
        val machine = CallMediaStateMachine({}, {})
        val first = machine.begin("call-1", udp)
        val retry = machine.rejoin(first, udp)
        assertEquals(CallMediaPhase.CONNECTING, machine.current().phase)
        assertTrue(machine.current().rejoining)
        assertTrue(retry != null && machine.isCurrent(retry))
    }

    @Test fun stateMachineRejoinKeepsCallMuteSpeakerAndRejectsStaleTokens() {
        val states = mutableListOf<CallMediaUiState>()
        var cleanups = 0
        val machine = CallMediaStateMachine({ cleanups++ }, states::add)
        val first = machine.begin("call-1", udp)
        machine.connected(first)
        machine.setMuted(true)
        machine.setSpeaker(true)
        val cleanupsBefore = cleanups

        val second = machine.rejoin(first, tls)!!
        assertEquals(cleanupsBefore + 1, cleanups)
        val rejoining = states.last()
        assertEquals(CallMediaPhase.CONNECTING, rejoining.phase)
        assertTrue(rejoining.rejoining)
        assertEquals(CallMediaRejoinPolicy.MESSAGE, rejoining.message)
        assertEquals("call-1", rejoining.callId)
        assertEquals(tls, rejoining.transport)
        assertTrue(rejoining.microphoneMuted && rejoining.speakerEnabled)
        assertNull("the dropped leg's second trigger must not start another rejoin", machine.rejoin(first, tls))

        val third = machine.rejoin(second, udp)!!
        machine.connected(third)
        assertEquals(CallMediaPhase.CONNECTED, states.last().phase)
        assertFalse(states.last().rejoining)
        assertTrue(states.last().microphoneMuted)

        val fourth = machine.rejoin(third, udp)!!
        assertTrue(machine.failed(fourth, "UDP 音频中继连接失败"))
        assertFalse(states.last().rejoining)
        assertNull("a failed session is not rejoined", machine.rejoin(fourth, udp))
        machine.stop()
        assertNull(machine.rejoin(fourth, udp))
    }
}
