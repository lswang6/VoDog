package org.vodog.gateway

/**
 * S20 D4 — the command doorbell, expressed as pure decisions so the coroutine in
 * [GatewayForegroundService] holds no policy of its own.
 *
 * Commands are the only hop in the whole chain that is pure polling. The doorbell is an extra cheap
 * hanging request that the control service answers early when the gateway has undelivered work, so
 * dial/answer/hangup arrive in about one RTT instead of one poll interval. It is strictly additive:
 * a doorbell failure must never touch [GatewayConnectionTracker]'s failure or hysteresis counters,
 * and must never publish a connection state.
 */
internal enum class CommandDoorbellDisplayState(val label: String) {
    /** The heartbeat never announced a hold window, or the control switch is off. */
    DISABLED("未启用"),
    /** The loop is alive between two holds. */
    RUNNING("运行中"),
    /** A hanging request is in flight on the server. */
    HOLDING("挂起中"),
    /** The last attempt failed; the loop is waiting out its backoff. */
    BACKOFF("退避中"),
}

/** Everything the loop carries between rounds. All of it is displayed, none of it is persisted logic. */
internal data class CommandDoorbellState(
    val consecutiveFailures: Int = 0,
    val lastWakeWallClockMs: Long? = null,
    /** The heartbeat cycle count observed when the last `wake=true` was consumed. */
    val wakeCycle: Long? = null,
)

/** What the loop should do for one round. */
internal data class CommandDoorbellPlan(
    val run: Boolean,
    val holdMs: Int = 0,
    val backoffMs: Long = 0L,
)

internal object CommandDoorbellPolicy {
    /** The control service's own hard ceiling (`GATEWAY_COMMAND_DOORBELL_MAX_MS`). */
    const val MAX_HOLD_MS = 8_000
    const val INITIAL_BACKOFF_MS = 5_000L
    const val MAX_BACKOFF_MS = 30_000L

    /**
     * The gateway must not re-ring straight after a wake: the server answers `wake=true` while any
     * command is still un-ACKed, so ringing again before the heartbeat loop has drained that command
     * would spin at one request per RTT. This is the longest the doorbell waits for that cycle.
     */
    const val POST_WAKE_SETTLE_MS = 3_000L

    /**
     * `maxHoldMs` is whatever the last heartbeat announced (absent or 0 = closed); `controlEnabled`
     * is the local master switch. Both must hold for the loop to run at all.
     */
    fun plan(
        maxHoldMs: Int,
        controlEnabled: Boolean,
        state: CommandDoorbellState,
    ): CommandDoorbellPlan {
        if (!controlEnabled || maxHoldMs <= 0) return CommandDoorbellPlan(run = false)
        return CommandDoorbellPlan(
            run = true,
            holdMs = minOf(maxHoldMs, MAX_HOLD_MS),
            backoffMs = backoffMs(state.consecutiveFailures),
        )
    }

    /** 5 s, 10 s, 20 s, then capped at 30 s. A success or a wake returns to zero. */
    fun backoffMs(consecutiveFailures: Int): Long {
        if (consecutiveFailures <= 0) return 0L
        val steps = (consecutiveFailures - 1).coerceIn(0, 16)
        return (INITIAL_BACKOFF_MS shl steps).coerceAtMost(MAX_BACKOFF_MS)
    }

    /** A 2xx response, woken or not, clears the backoff. Only a wake records a timestamp. */
    fun onSuccess(
        state: CommandDoorbellState,
        wake: Boolean,
        nowWallClockMs: Long,
        heartbeatCycle: Long,
    ): CommandDoorbellState = CommandDoorbellState(
        consecutiveFailures = 0,
        lastWakeWallClockMs = if (wake) nowWallClockMs else state.lastWakeWallClockMs,
        wakeCycle = if (wake) heartbeatCycle else null,
    )

    fun onFailure(state: CommandDoorbellState): CommandDoorbellState =
        state.copy(consecutiveFailures = (state.consecutiveFailures + 1).coerceAtMost(MAX_COUNTED_FAILURES))

    /**
     * True while the heartbeat loop has not yet completed a cycle since the last wake. The caller
     * waits (bounded by [POST_WAKE_SETTLE_MS]) instead of issuing another hold.
     */
    fun shouldWaitForHeartbeat(state: CommandDoorbellState, heartbeatCycle: Long): Boolean =
        state.wakeCycle?.let { heartbeatCycle <= it } == true

    /**
     * The server answers `{wake:false, heldMs:0}` only when its own doorbell switch is off, because a
     * genuine timeout always reports roughly the held window. The gateway's announcement is then
     * stale — the operator turned the doorbell off between two heartbeats — so the loop pauses rather
     * than spinning at one request per round trip until the next heartbeat corrects it.
     */
    fun serverClosedDoorbell(result: DoorbellResult): Boolean = !result.wake && result.heldMs <= 0L

    /**
     * The announcement that opens the doorbell comes from an *accepted* heartbeat; a failing one
     * announces nothing.
     *
     * This matters because the server answers `wake=true` while any command is undelivered, and some
     * heartbeat failures happen after a 2xx and are sticky — a quarantined replay horizon or a fence
     * mismatch never drains the command. Without this pause the pair would ring and wake each other
     * at about two requests per round trip, which is exactly the behaviour S18's failure backoff
     * exists to prevent. The doorbell resumes on the next accepted heartbeat.
     */
    fun shouldPauseForHeartbeat(lastHeartbeatFailed: Boolean): Boolean = lastHeartbeatFailed

    private const val MAX_COUNTED_FAILURES = 1_000_000
}
