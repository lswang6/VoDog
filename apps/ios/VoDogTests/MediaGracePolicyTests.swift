import XCTest
@testable import VoDog

final class MediaGracePolicyTests: XCTestCase {
    func testGraceIsThirtySeconds() {
        XCTAssertEqual(MediaGracePolicy.grace, .seconds(30))
        XCTAssertEqual(MediaGracePolicy.graceSeconds, 30)
        XCTAssertTrue(MediaGracePolicy.footnote.contains("30 秒"))
    }

    func testOrdinaryFailureHoldsTheCallForGrace() {
        XCTAssertEqual(MediaGracePolicy.plan(for: MediaSessionError.iceGatheringTimedOut(.tls)), .holdForGrace)
        XCTAssertEqual(MediaGracePolicy.plan(for: MediaSessionError.noRelayCandidate(.udp)), .holdForGrace)
        XCTAssertEqual(MediaGracePolicy.plan(for: APIError.server(503, "", "GATEWAY_OFFLINE")), .holdForGrace)
        XCTAssertEqual(MediaGracePolicy.plan(for: MediaSessionError.microphonePermissionDenied), .holdForGrace)
    }

    /// A call the server already ended must not show "重试音频" for 30 s.
    func testRevokedCallEndsImmediatelyWithoutGrace() {
        XCTAssertEqual(MediaGracePolicy.plan(for: APIError.server(409, "", "MEDIA_REVOKED")), .endImmediately)
        XCTAssertEqual(MediaGracePolicy.plan(for: APIError.server(410, "", "MEDIA_REVOKED")), .endImmediately)
    }

    func testGraceFiresExactlyOnce() {
        var tracker = MediaGraceTracker()
        tracker.begin(callID: "call-1")
        XCTAssertTrue(tracker.isPending)
        XCTAssertTrue(tracker.consume(callID: "call-1"))
        XCTAssertFalse(tracker.consume(callID: "call-1"))
        XCTAssertFalse(tracker.isPending)
    }

    func testStopCancelsThePendingGrace() {
        var tracker = MediaGraceTracker()
        tracker.begin(callID: "call-1")
        tracker.cancel()
        XCTAssertFalse(tracker.isPending)
        XCTAssertFalse(tracker.consume(callID: "call-1"))
    }

    /// A reconnect restarts the session, which cancels the grace; a late expiry must not end the recovered call.
    func testReconnectCancelsTheGrace() {
        var tracker = MediaGraceTracker()
        tracker.begin(callID: "call-1")
        tracker.cancel()
        tracker.begin(callID: "call-1")
        tracker.cancel()
        XCTAssertFalse(tracker.consume(callID: "call-1"))
    }

    func testGraceOfAnotherCallNeverEndsTheCurrentOne() {
        var tracker = MediaGraceTracker()
        tracker.begin(callID: "call-1")
        XCTAssertFalse(tracker.consume(callID: "call-2"))
        XCTAssertTrue(tracker.isPending)
        XCTAssertTrue(tracker.consume(callID: "call-1"))
    }

    func testANewFailureReplacesThePendingGrace() {
        var tracker = MediaGraceTracker()
        tracker.begin(callID: "call-1")
        tracker.begin(callID: "call-2")
        XCTAssertFalse(tracker.consume(callID: "call-1"))
        XCTAssertTrue(tracker.consume(callID: "call-2"))
    }
}
