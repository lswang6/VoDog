package org.vodog

import org.vodog.CallMediaRelayGatheringPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Test

class CallMediaRelayGatheringPolicyTest {
    private fun decide(
        complete: Boolean = false,
        candidates: Int = 0,
        elapsed: Long,
        sinceFirst: Long? = null,
    ) = CallMediaRelayGatheringPolicy.decide(complete, candidates, elapsed, sinceFirst)

    @Test fun windowsAreOneAndTwelveSeconds() {
        assertEquals(1_000L, CallMediaRelayGatheringPolicy.SETTLE_WINDOW_MS)
        assertEquals(12_000L, CallMediaRelayGatheringPolicy.CAP_MS)
        assertEquals(50L, CallMediaRelayGatheringPolicy.POLL_INTERVAL_MS)
    }

    @Test fun completeWithCandidatesProceedsImmediately() {
        assertEquals(Decision.PROCEED, decide(complete = true, candidates = 2, elapsed = 300))
    }

    @Test fun completeWithoutCandidatesFailsImmediately() {
        assertEquals(Decision.NO_RELAY_CANDIDATE, decide(complete = true, candidates = 0, elapsed = 300))
    }

    @Test fun firstRelayCandidatePlusSettleWindowProceedsWithoutCompletion() {
        assertEquals(Decision.WAIT, decide(candidates = 1, elapsed = 600, sinceFirst = 500))
        assertEquals(Decision.PROCEED, decide(candidates = 2, elapsed = 1_100, sinceFirst = 1_000))
        assertEquals(Decision.PROCEED, decide(candidates = 2, elapsed = 2_000, sinceFirst = 1_900))
    }

    @Test fun waitsWhileNothingHasArrivedYet() {
        assertEquals(Decision.WAIT, decide(elapsed = 50))
        // Past the cap only the cap branch decides; a still-gathering peer with no candidate at
        // 11 s keeps waiting for the last second.
        assertEquals(Decision.WAIT, decide(elapsed = 11_000))
    }

    @Test fun capWithoutAnyCandidateIsANoRelayCandidateFailure() {
        assertEquals(Decision.NO_RELAY_CANDIDATE, decide(elapsed = 12_000))
        assertEquals(Decision.NO_RELAY_CANDIDATE, decide(elapsed = 13_000))
    }

    @Test fun capWithALateCandidateProceeds() {
        assertEquals(Decision.PROCEED, decide(candidates = 1, elapsed = 12_000, sinceFirst = 400))
    }
}
