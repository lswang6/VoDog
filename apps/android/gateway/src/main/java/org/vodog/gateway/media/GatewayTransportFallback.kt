package org.vodog.gateway.media

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

/**
 * S24 decision 1. Cellular carriers (observed on China Telecom 5G, 2026-09-12) silently drop the
 * TURN UDP allocation to the media node: the AI leg activates in seconds while the gateway's data
 * channel never opens inside the whole negotiation budget. The same call over TURN TLS (tcp/16802)
 * is unaffected, so one bounded retry on the other transport is worth far more than a longer wait.
 */
internal const val MEDIA_NEGOTIATION_TIMEOUT_MS = 20_000L

/** Budget for an attempt that still has a fallback behind it; the last attempt keeps the full one. */
internal const val MEDIA_FALLBACK_ATTEMPT_TIMEOUT_MS = 8_000L

/** A relay allocation that has produced nothing by here will not produce anything useful later. */
internal const val MEDIA_RELAY_CANDIDATE_DEADLINE_MS = 3_000L

/**
 * S25 decision 9. A relay-only offer is already complete once one relay candidate sits in the local
 * description, but ICE gathering only ends after every TURN allocation on *every* interface has
 * finished or failed. On a Pixel holding Wi-Fi and 5G at once (observed 2026-09-12) the cellular
 * allocation takes 0.9-3.5 s to fail (`ice_candidate_error` 600 / 701) while the relay candidate
 * that actually carries the call arrives in 0.1-0.5 s, so waiting for COMPLETE delayed the offer -
 * and the caller's first AI audio - by whole seconds. This is the short grace window that still lets
 * a second interface's relay candidate join the same offer, not a wait for the whole gathering.
 */
internal const val MEDIA_RELAY_SETTLE_MS = 500L

/** Where one negotiation attempt was when its budget ran out. Bounded, content-free telemetry. */
internal enum class MediaTransportStage { OPTIONS, GATHERING, RELAY_CANDIDATE, OFFER, DATA_CHANNEL }

internal fun MediaTransportStage.timeoutReason(): String =
    if (this == MediaTransportStage.RELAY_CANDIDATE) "no_relay_candidate" else "${name.lowercase()}_timeout"

/**
 * One attempt of the plan. [relayCandidateDeadlineMs] is null on the final attempt: a slow but
 * working relay must never be cut short when there is nothing left to fall back to.
 */
internal data class MediaTransportAttempt(
    val transport: IceTransport,
    val ordinal: Int,
    val budgetMs: Long,
    val relayCandidateDeadlineMs: Long?,
) {
    init {
        require(ordinal >= 1 && budgetMs > 0)
        require(relayCandidateDeadlineMs == null || relayCandidateDeadlineMs in 1 until budgetMs)
    }
}

/** Deliberately not a CancellationException: an exhausted attempt is a retryable fact, not a cancel. */
internal class MediaTransportTimeoutException(
    val transport: IceTransport,
    val stage: MediaTransportStage,
    cause: Throwable? = null,
) : IllegalStateException(
    "media transport ${transport.wireValue} attempt exhausted at ${stage.name.lowercase()}",
    cause,
)

internal fun mediaTransportFallback(transport: IceTransport): IceTransport =
    if (transport == IceTransport.UDP) IceTransport.TLS else IceTransport.UDP

internal fun mediaTransportPlan(
    preferred: IceTransport,
    fallbackEnabled: Boolean,
    attemptBudgetMs: Long = MEDIA_FALLBACK_ATTEMPT_TIMEOUT_MS,
    finalBudgetMs: Long = MEDIA_NEGOTIATION_TIMEOUT_MS,
    relayCandidateDeadlineMs: Long = MEDIA_RELAY_CANDIDATE_DEADLINE_MS,
): List<MediaTransportAttempt> = if (!fallbackEnabled) {
    listOf(MediaTransportAttempt(preferred, 1, finalBudgetMs, null))
} else {
    listOf(
        MediaTransportAttempt(preferred, 1, attemptBudgetMs, relayCandidateDeadlineMs),
        MediaTransportAttempt(mediaTransportFallback(preferred), 2, finalBudgetMs, null),
    )
}

/**
 * S25 decision 9. The instant the offer may be sent, or null while no relay candidate has arrived:
 * a relay-only session has nothing worth offering without one, and the caller of this function is
 * expected to keep waiting (or to report [RelayIceUnavailableException] once gathering has ended
 * without producing a relay). Gathering completing inside the settle window wins over the timer -
 * nothing further can arrive after COMPLETE - and the settle window wins when gathering drags on.
 * Pure and clock-free on purpose: every timestamp is a caller-supplied monotonic reading.
 */
internal fun mediaOfferReadyAtMs(
    firstRelayAtMs: Long?,
    gatheringCompleteAtMs: Long?,
    settleMs: Long = MEDIA_RELAY_SETTLE_MS,
): Long? {
    require(settleMs >= 0) { "a settle window cannot be negative" }
    val relayAt = firstRelayAtMs ?: return null
    val settledAt = relayAt + settleMs
    val completedAt = gatheringCompleteAtMs ?: return settledAt
    // A COMPLETE that predates the relay candidate still cannot release the offer before it exists.
    return minOf(settledAt, maxOf(completedAt, relayAt))
}

/** [mediaOfferReadyAtMs] as the predicate the negotiation reads: may the offer go out at [nowMs]? */
internal fun mediaOfferReady(
    firstRelayAtMs: Long?,
    gatheringCompleteAtMs: Long?,
    nowMs: Long,
    settleMs: Long = MEDIA_RELAY_SETTLE_MS,
): Boolean = mediaOfferReadyAtMs(firstRelayAtMs, gatheringCompleteAtMs, settleMs)?.let { it <= nowMs } == true

/**
 * Only a transport-shaped failure earns the second attempt. An HTTP refusal, a capture-binding
 * conflict or a revoked authorization would fail the same way on the other transport, and Control
 * re-runs `authorizeGatewayMedia`/`ensureCaptureBinding` on every options request.
 */
internal fun mediaTransportFallbackReason(error: Throwable): String? = when (error) {
    is MediaTransportTimeoutException -> error.stage.timeoutReason()
    is RelayIceUnavailableException -> "relay_unavailable"
    else -> null
}

internal suspend fun <T> withMediaTransportFallback(
    plan: List<MediaTransportAttempt>,
    onFallback: (from: IceTransport, to: IceTransport, reason: String) -> Unit,
    attempt: suspend (MediaTransportAttempt) -> T,
): T {
    require(plan.isNotEmpty()) { "at least one transport attempt is required" }
    plan.forEachIndexed { index, current ->
        val next = plan.getOrNull(index + 1)
        try {
            return attempt(current)
        } catch (cancelled: CancellationException) {
            // A hangup, an ON-generation close or a network change owns this coroutine's death.
            throw cancelled
        } catch (error: Throwable) {
            val reason = (next?.let { mediaTransportFallbackReason(error) }) ?: throw error
            // Observability must never decide whether the fallback runs.
            runCatching { onFallback(current.transport, next.transport, reason) }
            coroutineContext.ensureActive()
        }
    }
    error("transport fallback plan produced no outcome")
}

/**
 * Remembers, per network generation, the transport that last opened a data channel. Process scoped
 * on purpose: a generation is minted fresh by [AndroidGatewayProbeGeneration] on every link change,
 * so a restart has nothing worth restoring and a stale preference can only cost one fallback.
 */
internal class MediaTransportMemory(private val capacity: Int = 8) {
    init { require(capacity in 1..64) }

    private val entries = object : LinkedHashMap<String, IceTransport>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, IceTransport>?) = size > capacity
    }

    @Synchronized
    fun preferred(networkGeneration: String?): IceTransport =
        networkGeneration?.let { entries[it] } ?: IceTransport.UDP

    @Synchronized
    fun remember(networkGeneration: String?, transport: IceTransport) {
        if (networkGeneration.isNullOrBlank()) return
        entries[networkGeneration] = transport
    }

    @Synchronized
    fun size(): Int = entries.size

    companion object { val INSTANCE = MediaTransportMemory() }
}

/** S73 D3: leg rejoin bounds. */
internal const val MEDIA_REJOIN_MAX_ATTEMPTS = 3
internal const val MEDIA_REJOIN_WINDOW_MS = 60_000L
/** Bridge still holds the old leg Connected (409, relayed by Control as 503 MEDIA_BRIDGE_UNAVAILABLE). */
internal const val MEDIA_REJOIN_CONFLICT_BACKOFF_MS = 2_000L
/** A fast failure (network still down) waits until this long after its attempt started. */
internal const val MEDIA_REJOIN_ATTEMPT_SPACING_MS = 15_000L
/** ICE DISCONNECTED on an established leg this long = transport lost (pion would wait 25 s). */
internal const val MEDIA_ICE_DISCONNECTED_GRACE_MS = 5_000L

/** S73 D3: attempt 1 retries the failed leg's transport, later attempts switch; relay mode is TLS only. */
internal fun mediaRejoinTransport(attempt: Int, original: IceTransport, relay: Boolean): IceTransport = when {
    relay -> IceTransport.TLS
    attempt >= 2 -> mediaTransportFallback(original)
    else -> original
}

internal enum class MediaRejoinFailure { CONFLICT, RETRY, FATAL }

/** 409 / 503 MEDIA_BRIDGE_UNAVAILABLE = old leg still up; other 4xx = call gone or revoked, stop rejoining. */
internal fun classifyMediaRejoinFailure(error: Throwable): MediaRejoinFailure = when {
    error !is GatewayMediaHttpException -> MediaRejoinFailure.RETRY
    error.status == 409 || (error.status == 503 && error.code == "MEDIA_BRIDGE_UNAVAILABLE") -> MediaRejoinFailure.CONFLICT
    error.status in 400..499 -> MediaRejoinFailure.FATAL
    else -> MediaRejoinFailure.RETRY
}

/**
 * S73b: a failure while the device has no usable network is not the leg's fault. No default network
 * with INTERNET, or DNS/connect refused on an unvalidated one. VALIDATED alone is not required:
 * a working network may never validate (Google's probe is unreachable from China).
 */
internal fun isOfflineRejoinFailure(error: Throwable, hasNetwork: Boolean, validated: Boolean): Boolean =
    !hasNetwork || (!validated && generateSequence(error) { it.cause }.take(8)
        .any { it is java.net.UnknownHostException || it is java.net.ConnectException })

/**
 * S73 D3 loop: up to [MEDIA_REJOIN_MAX_ATTEMPTS] single-transport negotiations inside
 * [MEDIA_REJOIN_WINDOW_MS]. Returns null when the budget is spent or Control refused for good.
 * [onAttempt] gets (attempt, transport, ok, error, this attempt's ms). S73b: an [offline] failure spends no attempt;
 * [awaitNetwork] (budget ms, false = window over) blocks until a network is back, then the same attempt reruns.
 */
internal suspend fun <T> rejoinMediaLeg(
    original: IceTransport,
    relay: Boolean,
    nowMs: () -> Long,
    sleep: suspend (Long) -> Unit,
    onAttempt: (Int, IceTransport, Boolean, Throwable?, Long) -> Unit,
    offline: (Throwable) -> Boolean = { false },
    awaitNetwork: suspend (Long) -> Boolean = { true },
    connect: suspend (IceTransport, Long) -> T,
): T? {
    val startMs = nowMs()
    var attempt = 1
    while (attempt <= MEDIA_REJOIN_MAX_ATTEMPTS) {
        val remaining = MEDIA_REJOIN_WINDOW_MS - (nowMs() - startMs)
        if (remaining <= 0) return null
        val transport = mediaRejoinTransport(attempt, original, relay)
        val attemptStartMs = nowMs()
        try {
            return connect(transport, minOf(remaining, MEDIA_NEGOTIATION_TIMEOUT_MS)).also {
                runCatching { onAttempt(attempt, transport, true, null, nowMs() - attemptStartMs) }
            }
        } catch (error: Throwable) {
            // Only our own cancellation (hangup / teardown) ends the loop; an inner timeout is a failure.
            coroutineContext.ensureActive()
            runCatching { onAttempt(attempt, transport, false, error, nowMs() - attemptStartMs) }
            val kind = classifyMediaRejoinFailure(error)
            if (kind == MediaRejoinFailure.FATAL) return null
            val windowLeft = MEDIA_REJOIN_WINDOW_MS - (nowMs() - startMs)
            if (offline(error)) {
                if (windowLeft <= 0 || !awaitNetwork(windowLeft)) return null
                continue
            }
            if (attempt == MEDIA_REJOIN_MAX_ATTEMPTS) return null
            val waitMs = if (kind == MediaRejoinFailure.CONFLICT) MEDIA_REJOIN_CONFLICT_BACKOFF_MS
            else attemptStartMs + MEDIA_REJOIN_ATTEMPT_SPACING_MS - nowMs()
            if (waitMs >= windowLeft) return null
            if (waitMs > 0) sleep(waitMs)
            attempt++
        }
    }
    return null
}
