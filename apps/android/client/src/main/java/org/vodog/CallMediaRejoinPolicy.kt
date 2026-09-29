package org.vodog

/**
 * S73 D3: an established call whose ICE stays DISCONNECTED for
 * [CallMediaIceWaitPolicy.DISCONNECT_GRACE_MS] or goes FAILED rejoins the same bridge room with a
 * fresh PeerConnection (options + offer), at most [MAX_ATTEMPTS] times within [WINDOW_MS]. Attempt 1
 * reuses the dropped leg's transport, later attempts switch UDP↔TLS; [relay] (S73b: the last media-options
 * response had `relay: true`, i.e. the room sits on the relay node reached via the TLS-only tunnel) is always TLS.
 * Only after this budget does the pre-S73 failure/grace path run.
 */
object CallMediaRejoinPolicy {
    const val MAX_ATTEMPTS = 3
    const val WINDOW_MS = 60_000L
    /** The bridge still holds the old leg as Connected (409) — it notices within seconds. */
    const val CONFLICT_BACKOFF_MS = 2_000L
    /**
     * An attempt that fails fast (the network is still down) waits until this long after it started,
     * so the three attempts span a 20–30 s outage instead of burning out within a second.
     */
    const val MIN_ATTEMPT_SPACING_MS = 15_000L
    const val MESSAGE = "网络波动，正在重新连接…"
    /** `media.rejoin.reason` when the first connect failed offline and waits for the network. */
    const val SETUP_OFFLINE_REASON = "setup_offline"

    /**
     * [offlineAttempt] > 0 (S73h): the episode went offline and [offlineAttempt] is the attempt that
     * reran once the network came back. From there the rule restarts as if UDP dropped (iOS prod: TLS reused
     * after every offline cost 1–2 s on cellular): UDP, then TLS; relay mode stays TLS.
     */
    fun transport(attempt: Int, dropped: CallMediaTransport, relay: Boolean, offlineAttempt: Int = 0): CallMediaTransport = when {
        relay -> CallMediaTransport.TLS
        offlineAttempt > 0 -> transport(attempt - offlineAttempt + 1, CallMediaTransport.UDP, relay = false)
        attempt <= 1 -> dropped
        dropped == CallMediaTransport.UDP -> CallMediaTransport.TLS
        else -> CallMediaTransport.UDP
    }

    /**
     * The bridge's 409 (old leg still Connected) reaches the client through Control's user offer
     * route as 503 `MEDIA_BRIDGE_UNAVAILABLE`, so both count as "retry shortly".
     */
    fun isConflict(error: Throwable): Boolean =
        error is ApiError && (error.status == 409 || error.code == "MEDIA_BRIDGE_UNAVAILABLE")

    /** Poll interval while an offline rejoin waits for a default network with INTERNET. */
    const val NETWORK_POLL_MS = 500L

    /**
     * S73c (mirrors the gateway's S73b rule): a failure while the device has no usable network is not
     * the leg's fault, so it spends no attempt and keeps the transport. No default network with
     * INTERNET, or DNS/connect refused on an unvalidated one (a working network may never validate:
     * Google's probe is unreachable from China). An HTTP answer ([ApiError]) proves the network works.
     */
    fun isOffline(error: Throwable, hasNetwork: Boolean, validated: Boolean): Boolean =
        error !is ApiError && (!hasNetwork || (!validated && generateSequence(error) { it.cause }.take(8)
            .any { it is java.net.UnknownHostException || it is java.net.ConnectException }))

    /** Delay before the next attempt, or null when the rejoin gives up and the failure path takes over. */
    fun nextDelayMs(attempt: Int, error: Throwable, attemptMs: Long, elapsedMs: Long): Long? {
        if (attempt >= MAX_ATTEMPTS) return null
        // Auth, revocation, not-found: another offer cannot fix these.
        if (error is ApiError && error.status in 400..499 && !isConflict(error)) return null
        val wait = if (isConflict(error)) CONFLICT_BACKOFF_MS else (MIN_ATTEMPT_SPACING_MS - attemptMs).coerceAtLeast(0)
        return wait.takeIf { elapsedMs + it < WINDOW_MS }
    }
}
