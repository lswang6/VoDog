package org.vodog

enum class CallMediaPhase { IDLE, CONNECTING, CONNECTED, FAILED }

data class CallMediaUiState(
    val callId: String? = null,
    val phase: CallMediaPhase = CallMediaPhase.IDLE,
    val transport: CallMediaTransport = CallMediaTransport.UDP,
    val message: String = "音频未连接",
    val speakerEnabled: Boolean = false,
    val microphoneMuted: Boolean = false,
    /**
     * When the handshake failed, as wall-clock millis. The recovery card counts the grace window down
     * from here (iOS shows a live countdown, R4 Part B must-fix); a value that is absent or already
     * past simply shows the window's full length rather than a negative number.
     */
    val failedAtMillis: Long? = null,
    /** S73 D7: a dropped leg is being rejoined; the call stays up and shows [CallMediaRejoinPolicy.MESSAGE]. */
    val rejoining: Boolean = false,
)

/** Seconds left of [CallMediaGracePolicy.GRACE_SECONDS]; clamped so the label never goes negative. */
internal fun mediaGraceRemainingSeconds(failedAtMillis: Long?, now: Long): Int {
    failedAtMillis ?: return CallMediaGracePolicy.GRACE_SECONDS
    val elapsed = ((now - failedAtMillis) / 1000L).toInt()
    return (CallMediaGracePolicy.GRACE_SECONDS - elapsed).coerceIn(0, CallMediaGracePolicy.GRACE_SECONDS)
}

/** The footnote the recovery card shows while the grace window runs. */
internal fun mediaGraceCountdownFootnote(remainingSeconds: Int): String =
    "未恢复音频将在 $remainingSeconds 秒后自动结束通话"

internal class CallMediaStateMachine(
    private val cleanup: () -> Unit,
    private val publish: (CallMediaUiState) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var generation = 0L
    private var state = CallMediaUiState()

    @Synchronized
    fun begin(callId: String, transport: CallMediaTransport): Long {
        generation += 1
        cleanup()
        state = CallMediaUiState(
            callId = callId,
            phase = CallMediaPhase.CONNECTING,
            transport = transport,
            message = "正在通过 ${transport.label} 连接音频…",
        )
        publish(state)
        return generation
    }

    @Synchronized
    fun isCurrent(token: Long): Boolean = token == generation

    @Synchronized
    fun withCurrent(token: Long, block: () -> Unit): Boolean {
        if (token != generation) return false
        block()
        return true
    }

    @Synchronized
    fun current(): CallMediaUiState = state

    /**
     * S73: replaces the live leg [token] with a new rejoin attempt over [transport], keeping the
     * call's mute and speaker. Null when [token] is stale or the session is no longer live, so
     * racing triggers start one rejoin. [cleanup] closes the old leg off this lock (S70d).
     */
    @Synchronized
    fun rejoin(token: Long, transport: CallMediaTransport): Long? {
        if (token != generation || state.phase !in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)) return null
        generation += 1
        cleanup()
        state = state.copy(
            phase = CallMediaPhase.CONNECTING,
            transport = transport,
            message = CallMediaRejoinPolicy.MESSAGE,
            rejoining = true,
        )
        publish(state)
        return generation
    }

    @Synchronized
    fun connected(token: Long) {
        if (token != generation || state.phase != CallMediaPhase.CONNECTING) return
        state = state.copy(
            phase = CallMediaPhase.CONNECTED,
            message = "音频已通过 ${state.transport.label} 连接",
            rejoining = false,
        )
        publish(state)
    }

    /**
     * Returns true only when this call actually moved the session into FAILED, so a caller can
     * report the terminal failure (grace timer, auto-end) exactly once even when both the
     * handshake and a WebRTC observer callback race to report it.
     */
    @Synchronized
    fun failed(token: Long, message: String): Boolean {
        if (token != generation || state.phase == CallMediaPhase.FAILED || state.phase == CallMediaPhase.IDLE) {
            return false
        }
        state = state.copy(phase = CallMediaPhase.FAILED, message = message, failedAtMillis = now(), rejoining = false)
        cleanup()
        publish(state)
        return true
    }

    @Synchronized
    fun setSpeaker(enabled: Boolean) {
        if (state.phase !in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)) return
        state = state.copy(speakerEnabled = enabled)
        publish(state)
    }

    @Synchronized
    fun setMuted(muted: Boolean) {
        if (state.phase !in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)) return
        state = state.copy(microphoneMuted = muted)
        publish(state)
    }

    @Synchronized
    fun reconcile(callStates: Map<String, String>) {
        val callId = state.callId ?: return
        val remoteState = callStates[callId]
        if (remoteState == null || remoteState in TERMINAL_STATES) stop()
    }

    @Synchronized
    fun stop() {
        generation += 1
        cleanup()
        state = CallMediaUiState()
        publish(state)
    }

    companion object {
        private val TERMINAL_STATES = setOf("ending", "ended", "failed", "unknown")
    }
}
