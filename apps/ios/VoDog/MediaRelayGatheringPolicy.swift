import Foundation

/// Decides when the gathered ICE candidates are good enough to send the offer.
///
/// Device evidence (S18): the iPhone produced its relay candidates within 90–480 ms on both UDP and TLS, but
/// `iceGatheringState` never reached `.complete` — libwebrtc enumerated 18 interfaces (Wi-Fi, four cellular and ~ten
/// `ipsec*`/`utun*` IMS tunnels) and the TURN allocations on the IMS tunnels never finish. With `gatherOnce` the
/// completion event therefore never fires, so waiting for `.complete` meant the app never POSTed `media/offer` at all.
/// The wait now ends on the first usable relay candidates and only uses `.complete` as an early exit.
enum MediaRelayGatheringPolicy {
    /// Time granted after the first relay candidate so a second interface's candidate can join the offer.
    static let settleWindow: Duration = .seconds(1)
    /// Hard cap on the whole wait.
    static let cap: Duration = .seconds(12)
    static let pollInterval: Duration = .milliseconds(50)

    enum Decision: Equatable {
        case wait
        case proceed
        case noRelayCandidate
    }

    static func decide(
        gatheringComplete: Bool,
        relayCandidateCount: Int,
        elapsed: Duration,
        sinceFirstRelayCandidate: Duration?
    ) -> Decision {
        if gatheringComplete { return relayCandidateCount > 0 ? .proceed : .noRelayCandidate }
        if relayCandidateCount > 0, let sinceFirstRelayCandidate, sinceFirstRelayCandidate >= settleWindow {
            return .proceed
        }
        if elapsed >= cap {
            // Candidates that arrived just before the cap are still worth offering; nothing at all is a failure.
            return relayCandidateCount > 0 ? .proceed : .noRelayCandidate
        }
        return .wait
    }
}
