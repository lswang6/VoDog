import XCTest
@testable import VoDog

final class MediaRelayGatheringPolicyTests: XCTestCase {
    private func decide(
        complete: Bool = false, candidates: Int = 0, elapsed: Duration = .zero, sinceFirst: Duration? = nil
    ) -> MediaRelayGatheringPolicy.Decision {
        MediaRelayGatheringPolicy.decide(
            gatheringComplete: complete, relayCandidateCount: candidates,
            elapsed: elapsed, sinceFirstRelayCandidate: sinceFirst
        )
    }

    func testWindowsAreOneAndTwelveSeconds() {
        XCTAssertEqual(MediaRelayGatheringPolicy.settleWindow, .seconds(1))
        XCTAssertEqual(MediaRelayGatheringPolicy.cap, .seconds(12))
    }

    func testCompleteWithCandidatesProceedsImmediately() {
        XCTAssertEqual(decide(complete: true, candidates: 2, elapsed: .milliseconds(300)), .proceed)
    }

    /// Relay-only policy: completing with nothing means there is no usable path at all.
    func testCompleteWithoutCandidatesFailsImmediately() {
        XCTAssertEqual(decide(complete: true, candidates: 0, elapsed: .milliseconds(300)), .noRelayCandidate)
    }

    func testFirstRelayCandidatePlusSettleWindowProceedsWithoutCompletion() {
        XCTAssertEqual(decide(candidates: 1, elapsed: .milliseconds(600), sinceFirst: .milliseconds(500)), .wait)
        XCTAssertEqual(decide(candidates: 2, elapsed: .milliseconds(1100), sinceFirst: .seconds(1)), .proceed)
        XCTAssertEqual(decide(candidates: 2, elapsed: .seconds(2), sinceFirst: .milliseconds(1900)), .proceed)
    }

    func testWaitsWhileNothingHasArrivedYet() {
        XCTAssertEqual(decide(elapsed: .milliseconds(50)), .wait)
        XCTAssertEqual(decide(elapsed: .seconds(11)), .wait)
    }

    func testCapWithoutAnyCandidateIsANoRelayCandidateFailure() {
        XCTAssertEqual(decide(elapsed: .seconds(12)), .noRelayCandidate)
        XCTAssertEqual(decide(elapsed: .seconds(13)), .noRelayCandidate)
    }

    /// A candidate that lands just before the cap is still offered rather than thrown away.
    func testCapWithALateCandidateProceeds() {
        XCTAssertEqual(decide(candidates: 1, elapsed: .seconds(12), sinceFirst: .milliseconds(400)), .proceed)
    }
}
