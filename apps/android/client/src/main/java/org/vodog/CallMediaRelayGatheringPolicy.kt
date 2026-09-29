package org.vodog

/**
 * Decides when a relay-only ICE gathering has produced enough candidates to post the offer
 * (S19 port of the iOS `MediaRelayGatheringPolicy`).
 *
 * The device enumerates roughly eighteen interfaces (Wi-Fi, four cellular, ~ten IMS
 * `ipsec*`/`utun*` tunnels) and allocates a TURN port on every one of them; the tunnel
 * allocations never finish, so `IceGatheringState.COMPLETE` may never fire and waiting on it
 * means the offer is never posted at all. Waiting on the *candidates* instead is what makes the
 * handshake possible: proceed one settle window after the first relay candidate, and never wait
 * longer than the cap.
 */
object CallMediaRelayGatheringPolicy {
    /** Time granted after the first relay candidate for a second interface's candidate to join. */
    const val SETTLE_WINDOW_MS = 1_000L

    /** Hard cap on the whole gathering wait. */
    const val CAP_MS = 12_000L

    const val POLL_INTERVAL_MS = 50L

    enum class Decision { WAIT, PROCEED, NO_RELAY_CANDIDATE }

    fun decide(
        gatheringComplete: Boolean,
        relayCandidateCount: Int,
        elapsedMs: Long,
        sinceFirstRelayCandidateMs: Long? = null,
    ): Decision {
        if (gatheringComplete) {
            return if (relayCandidateCount > 0) Decision.PROCEED else Decision.NO_RELAY_CANDIDATE
        }
        if (relayCandidateCount > 0 && sinceFirstRelayCandidateMs != null &&
            sinceFirstRelayCandidateMs >= SETTLE_WINDOW_MS
        ) {
            return Decision.PROCEED
        }
        if (elapsedMs >= CAP_MS) {
            return if (relayCandidateCount > 0) Decision.PROCEED else Decision.NO_RELAY_CANDIDATE
        }
        return Decision.WAIT
    }
}
