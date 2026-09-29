package org.vodog

import org.webrtc.PeerConnection

/**
 * Post-answer ICE connect budget and the meaning of each ICE connection state
 * (S19 port of the iOS `MediaIceWaitPolicy`).
 *
 * `DISCONNECTED` is deliberately [Progress.WAITING], not [Progress.FAILED]: mid-handshake it can
 * still recover, and after the call is up it is governed by [DISCONNECT_GRACE_MS] instead of an
 * immediate teardown.
 */
object CallMediaIceWaitPolicy {
    const val CONNECT_POLL_INTERVAL_MS = 100L
    const val CONNECT_POLL_COUNT = 120
    const val CONNECT_TIMEOUT_MS = 12_000L
    const val DISCONNECT_GRACE_MS = 5_000L

    enum class Progress { CONNECTED, WAITING, FAILED }

    /** A null state means "not observed yet / unknown", which keeps waiting. */
    fun progress(state: PeerConnection.IceConnectionState?): Progress = when (state) {
        PeerConnection.IceConnectionState.CONNECTED,
        PeerConnection.IceConnectionState.COMPLETED -> Progress.CONNECTED
        PeerConnection.IceConnectionState.FAILED,
        PeerConnection.IceConnectionState.CLOSED -> Progress.FAILED
        PeerConnection.IceConnectionState.NEW,
        PeerConnection.IceConnectionState.CHECKING,
        PeerConnection.IceConnectionState.DISCONNECTED,
        null -> Progress.WAITING
    }

    fun isUsable(state: PeerConnection.IceConnectionState?): Boolean = progress(state) == Progress.CONNECTED
}

/**
 * iOS MediaReceivePolicy port: bursty cellular delivery pushed NetEq's target to 0.5–0.9 s (Wi-Fi ~0.1 s).
 * 25 packets ≈ 500 ms of 20 ms Opus caps the buffer (NetEq keeps its target under ~3/4 of it) and fast
 * accelerate flushes a post-stall backlog instead of replaying it ~1 s late. Call PeerConnection only.
 */
object CallMediaReceivePolicy {
    const val FAST_ACCELERATE = true
    const val MAX_PACKETS = 25
}
