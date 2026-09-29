package org.vodog

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** S20 D5: how often the visible calls tab re-reads the account, and that it really stops. */
class ClientRefreshCadenceTest {
    private fun call(
        id: String,
        state: String,
        claimed: Boolean = false,
    ): JSONObject = JSONObject().put("id", id).put("state", state)
        .put("claimedByCurrentSession", claimed)

    @Test fun ownCallsInFlightPollFastAndSettledAccountsPollSlowly() {
        assertEquals(
            ClientRefreshCadence.IDLE_INTERVAL_MS,
            ClientRefreshCadence.intervalMs(emptyList(), CallMediaUiState()),
        )
        listOf("outgoing_pending", "connecting", "ending", "unknown").forEach { state ->
            assertEquals(
                "own $state must poll fast",
                ClientRefreshCadence.TRANSITION_INTERVAL_MS,
                ClientRefreshCadence.intervalMs(
                    listOf(call("call-1", state, claimed = true)),
                    CallMediaUiState(),
                ),
            )
        }
        // Ringing is answerable here before anybody claims it, so it counts without the claim flag.
        assertEquals(
            ClientRefreshCadence.TRANSITION_INTERVAL_MS,
            ClientRefreshCadence.intervalMs(
                listOf(call("call-2", "incoming_ringing")),
                CallMediaUiState(),
            ),
        )
        // Another session's in-flight call and our own answered call are both slow.
        assertEquals(
            ClientRefreshCadence.IDLE_INTERVAL_MS,
            ClientRefreshCadence.intervalMs(listOf(call("call-3", "connecting")), CallMediaUiState()),
        )
        assertEquals(
            ClientRefreshCadence.IDLE_INTERVAL_MS,
            ClientRefreshCadence.intervalMs(
                listOf(call("call-4", "active", claimed = true), call("call-5", "ended", claimed = true)),
                CallMediaUiState(),
            ),
        )
    }

    @Test fun connectingMediaPollsFastAndServiceReconciledCallsDoNotDoubleUp() {
        val active = listOf(call("call-1", "active", claimed = true))
        assertEquals(
            ClientRefreshCadence.TRANSITION_INTERVAL_MS,
            ClientRefreshCadence.intervalMs(
                active,
                CallMediaUiState("call-1", CallMediaPhase.CONNECTING),
            ),
        )
        assertEquals(
            ClientRefreshCadence.IDLE_INTERVAL_MS,
            ClientRefreshCadence.intervalMs(
                active,
                CallMediaUiState("call-1", CallMediaPhase.CONNECTED),
            ),
        )
        // OngoingCallService already polls this call (5 s ringing / 15 s ongoing); the page loop
        // must not request the same transition twice.
        assertEquals(
            ClientRefreshCadence.IDLE_INTERVAL_MS,
            ClientRefreshCadence.intervalMs(
                listOf(call("call-9", "incoming_ringing")),
                CallMediaUiState(),
                reconciledByService = setOf("call-9"),
            ),
        )
        assertEquals(
            ClientRefreshCadence.TRANSITION_INTERVAL_MS,
            ClientRefreshCadence.intervalMs(
                listOf(call("call-9", "incoming_ringing"), call("call-8", "outgoing_pending", claimed = true)),
                CallMediaUiState(),
                reconciledByService = setOf("call-9"),
            ),
        )
    }

    @Test fun loopStartsOnceTicksAtTheCurrentIntervalAndStopsIssuingRequests() = runBlocking {
        val gate = Channel<Unit>(Channel.RENDEZVOUS)
        val slept = mutableListOf<Long>()
        var refreshes = 0
        var interval = ClientRefreshCadence.TRANSITION_INTERVAL_MS
        val scope = CoroutineScope(Job() + Dispatchers.Unconfined)
        val loop = ClientRefreshLoop(
            scope = scope,
            intervalMs = { interval },
            refresh = { refreshes += 1 },
            sleep = { slept += it; gate.receive() },
        )

        assertFalse(loop.running)
        loop.start()
        assertTrue(loop.running)
        assertEquals(1, refreshes)
        assertEquals(listOf(2_000L), slept)

        interval = ClientRefreshCadence.IDLE_INTERVAL_MS
        gate.send(Unit)
        assertEquals(2, refreshes)
        assertEquals(listOf(2_000L, 5_000L), slept)

        loop.start()
        assertEquals("a second start must not add a second ticker", 2, refreshes)

        loop.stop()
        assertFalse(loop.running)
        assertTrue("a stopped loop has no receiver left", gate.trySend(Unit).isFailure)
        assertEquals(2, refreshes)

        loop.start()
        assertTrue("a stopped loop can be restarted when the tab comes back", loop.running)
        assertEquals(3, refreshes)
        loop.stop()
        scope.cancel()
    }

    @Test fun dialBurstPollsEvery500msUntilTheDialedCallLeavesPendingOrTheWindowCloses() {
        val burst = ClientRefreshCadence.DialBurst("call-1", untilMs = 15_000L)
        fun interval(calls: List<JSONObject>, now: Long) =
            ClientRefreshCadence.intervalMs(calls, CallMediaUiState(), emptySet(), burst, now)
        // Not listed yet (dial response came before the list reload) and still pending: burst.
        assertEquals(ClientRefreshCadence.DIAL_BURST_INTERVAL_MS, interval(emptyList(), 0L))
        assertEquals(
            ClientRefreshCadence.DIAL_BURST_INTERVAL_MS,
            interval(listOf(call("call-1", "outgoing_pending", claimed = true)), 14_999L),
        )
        // Left pending: back to the normal cadence at once.
        assertEquals(
            ClientRefreshCadence.TRANSITION_INTERVAL_MS,
            interval(listOf(call("call-1", "connecting", claimed = true)), 1_000L),
        )
        assertEquals(ClientRefreshCadence.IDLE_INTERVAL_MS, interval(listOf(call("call-1", "failed", claimed = true)), 1_000L))
        // Window closed while still pending: normal cadence.
        assertEquals(
            ClientRefreshCadence.TRANSITION_INTERVAL_MS,
            interval(listOf(call("call-1", "outgoing_pending", claimed = true)), 15_000L),
        )
        // Another call's pending state does not extend this burst; no burst means normal rule.
        assertFalse(ClientRefreshCadence.dialBurstActive(
            listOf(call("call-1", "active", claimed = true), call("call-2", "outgoing_pending")), burst, 1_000L,
        ))
        assertFalse(ClientRefreshCadence.dialBurstActive(emptyList(), null, 0L))
    }
}
