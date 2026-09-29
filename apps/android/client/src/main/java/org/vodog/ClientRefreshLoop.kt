package org.vodog

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

internal enum class ClientRefreshScope {
    CALLS,
    SMS,
    CONTACTS,
    HISTORY_CALLS,
    HISTORY_REPORTS,
    HISTORY_INTERCEPTIONS,
    SETTINGS,
}

/**
 * S20 D5 — how fast the calls tab re-reads `/calls` + `/sims` while it is visible.
 *
 * Fast (2 s) only while this session owns a call that is still moving (dialing, ringing, answering,
 * ending, or with media still connecting); otherwise 5 s, matching iOS. Calls that
 * [OngoingCallService] is already polling — its ringing/ongoing reconcile loop, see
 * [ReconcilingCalls] — never raise the cadence, so a ringing call is not requested twice from two
 * places at once.
 */
internal object ClientRefreshCadence {
    const val TRANSITION_INTERVAL_MS = 2_000L
    const val IDLE_INTERVAL_MS = 5_000L

    /** Non-terminal and not yet `active`; `unknown` is included because it still needs resolving. */
    internal val TRANSITIONAL_STATES =
        setOf("incoming_ringing", "outgoing_pending", "connecting", "ending", "unknown")

    /** S70e: right after a dial, poll every 500 ms so `connecting` (S56 ringback) starts media at once. */
    const val DIAL_BURST_INTERVAL_MS = 500L
    const val DIAL_BURST_WINDOW_MS = 15_000L

    /** The call this session just dialed and the (monotonic) time its fast-refresh burst gives up. */
    data class DialBurst(val callId: String?, val untilMs: Long)

    fun intervalMs(
        calls: List<JSONObject>,
        media: CallMediaUiState,
        reconciledByService: Set<String> = emptySet(),
        dialBurst: DialBurst? = null,
        nowMs: Long = 0L,
    ): Long = when {
        dialBurstActive(calls, dialBurst, nowMs) -> DIAL_BURST_INTERVAL_MS
        calls.any { transitionalForThisSession(it, media, reconciledByService) } -> TRANSITION_INTERVAL_MS
        else -> IDLE_INTERVAL_MS
    }

    /** Until the window closes, or the dialed call is listed in any state other than `outgoing_pending`. */
    fun dialBurstActive(calls: List<JSONObject>, burst: DialBurst?, nowMs: Long): Boolean {
        if (burst == null || nowMs >= burst.untilMs) return false
        val state = calls.firstOrNull { it.optString("id") == burst.callId }?.optString("state")
        return state == null || state == "outgoing_pending"
    }

    private fun transitionalForThisSession(
        call: JSONObject,
        media: CallMediaUiState,
        reconciledByService: Set<String>,
    ): Boolean {
        val id = call.optString("id")
        if (id.isBlank() || id in reconciledByService) return false
        val state = call.optString("state")
        // A ringing call is offered to this account and still answerable here, so it counts as ours
        // even before anybody claims it; every other state has to be claimed by this session.
        val mine = state == "incoming_ringing" || call.optBoolean("claimedByCurrentSession")
        if (!mine) return false
        val connectingMedia = media.callId == id && media.phase == CallMediaPhase.CONNECTING
        return state in TRANSITIONAL_STATES || connectingMedia
    }
}

/**
 * S52: a [ClientCallLiveness] event (claimed / media up / ended) re-reads `/calls` right away
 * instead of waiting for the next 2–5 s tick — but only while a screen's ticker is running, so a
 * backgrounded app still issues no periodic requests (S20 D5). RINGING is left to the push path.
 */
internal fun livenessTriggersRefresh(phase: ClientCallLivenessPhase, foregroundActive: Boolean): Boolean =
    foregroundActive && phase != ClientCallLivenessPhase.RINGING

/**
 * A start/stop refresh ticker owned by the view model and driven by the calls tab's lifecycle:
 * started while the tab is STARTED, stopped when it leaves or the app goes to the background.
 *
 * [sleep] is injectable so the cadence can be unit tested without a real clock; each tick asks
 * [intervalMs] again, so the interval follows the call list without restarting the loop.
 */
internal class ClientRefreshLoop(
    private val scope: CoroutineScope,
    private val intervalMs: () -> Long,
    private val refresh: () -> Unit,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private var job: Job? = null

    val running: Boolean get() = job?.isActive == true

    /** Idempotent: a second start while running keeps the existing ticker. */
    fun start() {
        if (running) return
        job = scope.launch {
            while (isActive) {
                refresh()
                sleep(intervalMs())
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    /** Cut the current sleep short so a new [intervalMs] applies now; a stopped ticker stays stopped. */
    fun kick() {
        if (!running) return
        stop()
        start()
    }
}
