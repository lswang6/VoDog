package org.vodog.gateway

/**
 * Durable heartbeat outcome with the displayed connection state. `lastSuccessAtMs` is an
 * elapsedRealtime reading, so a reboot invalidates it; the caller drops it before seeding.
 */
internal data class GatewayConnectionSnapshot(
    val connection: ServerConnection,
    val consecutiveFailures: Int,
    val lastSuccessAtMs: Long?,
    val nextPollMs: Long,
)

/**
 * Connection hysteresis. Control runs on one VPS and systemd restarts it within ~5 s, so a single
 * lost heartbeat must never be displayed as a disconnection: only ≥3 consecutive failures AND ≥20 s
 * without a success are. Backoff stays bounded so a restart cannot push `last_seen_at` past the
 * server's 30 s offline window, and stays tighter while a call or audio session is alive.
 */
internal object GatewayConnectionTracker {
    const val NORMAL_POLL_MS = 2_000L
    /** S20 D4: while a call or audio session is alive the command poll tightens to one second. */
    const val ACTIVE_CALL_POLL_MS = 1_000L
    const val MAX_FAILURE_BACKOFF_MS = 8_000L
    const val ACTIVE_CALL_FAILURE_BACKOFF_MS = 3_000L
    const val OFFLINE_FAILURE_THRESHOLD = 3
    const val OFFLINE_SILENCE_MS = 20_000L
    const val MAX_ERROR_CHARS = 180

    fun initial(
        lastSuccessAtMs: Long?,
        consecutiveFailures: Int,
        persisted: ServerConnection,
    ): GatewayConnectionSnapshot = GatewayConnectionSnapshot(
        connection = if (lastSuccessAtMs == null) ServerConnection.CONNECTING else persisted,
        consecutiveFailures = consecutiveFailures.coerceAtLeast(0),
        lastSuccessAtMs = lastSuccessAtMs,
        nextPollMs = NORMAL_POLL_MS,
    )

    fun onSuccess(
        previous: GatewayConnectionSnapshot,
        nowMs: Long,
        callOrAudioActive: Boolean,
    ) = previous.copy(
        connection = ServerConnection.ONLINE,
        consecutiveFailures = 0,
        lastSuccessAtMs = nowMs,
        nextPollMs = if (callOrAudioActive) ACTIVE_CALL_POLL_MS else NORMAL_POLL_MS,
    )

    fun onFailure(
        previous: GatewayConnectionSnapshot,
        nowMs: Long,
        callOrAudioActive: Boolean,
    ): GatewayConnectionSnapshot {
        val failures = (previous.consecutiveFailures + 1).coerceAtMost(MAX_COUNTED_FAILURES)
        val lastSuccess = previous.lastSuccessAtMs
        val silentMs = lastSuccess?.let { (nowMs - it).coerceAtLeast(0L) }
        val connection = when {
            // Nothing has ever answered since the gateway was enabled: this is still the first connect.
            lastSuccess == null -> ServerConnection.CONNECTING
            failures >= OFFLINE_FAILURE_THRESHOLD && silentMs != null &&
                silentMs >= OFFLINE_SILENCE_MS -> ServerConnection.OFFLINE
            else -> ServerConnection.DEGRADED
        }
        val cap = if (callOrAudioActive) ACTIVE_CALL_FAILURE_BACKOFF_MS else MAX_FAILURE_BACKOFF_MS
        return previous.copy(
            connection = connection,
            consecutiveFailures = failures,
            nextPollMs = backoffMs(failures, cap),
        )
    }

    /** Bounded exponential backoff from the normal 2 s cadence. */
    fun backoffMs(consecutiveFailures: Int, capMs: Long): Long {
        val steps = (consecutiveFailures - 1).coerceIn(0, 16)
        val raw = NORMAL_POLL_MS shl steps
        return raw.coerceAtMost(capMs).coerceAtLeast(minOf(NORMAL_POLL_MS, capMs))
    }

    /**
     * The headline for a cycle that never reached the control service. OFFLINE and DEGRADED must not
     * read alike: one is a sustained outage, the other is a retry in progress. The hero card shows
     * this line on its own, so the wording lives here rather than being duplicated in the UI.
     */
    fun failureHeadline(connection: ServerConnection, consecutiveFailures: Int): String = when (connection) {
        ServerConnection.OFFLINE -> "控制服务连接失败（已重试 $consecutiveFailures 次）"
        else -> "控制通道重试中（第 $consecutiveFailures 次）"
    }

    /** The detail line for a cycle that never reached the control service. */
    fun failureDetail(connection: ServerConnection, consecutiveFailures: Int, error: String): String =
        "${failureHeadline(connection, consecutiveFailures)}：$error".take(MAX_ERROR_CHARS)

    private const val MAX_COUNTED_FAILURES = 1_000_000
}
