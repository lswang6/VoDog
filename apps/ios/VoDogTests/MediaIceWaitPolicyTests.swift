import XCTest
@testable import VoDog

final class MediaIceWaitPolicyTests: XCTestCase {
    func testConnectWaitIsTwelveSecondsAndGraceIsFive() {
        XCTAssertEqual(MediaIceWaitPolicy.connectTimeout, .seconds(12))
        XCTAssertEqual(MediaIceWaitPolicy.disconnectGrace, .seconds(5))
        XCTAssertEqual(MediaIceWaitPolicy.callKitAudioTimeout, .seconds(8))
        XCTAssertEqual(
            MediaIceWaitPolicy.connectPollInterval * MediaIceWaitPolicy.connectPollCount,
            MediaIceWaitPolicy.connectTimeout
        )
    }

    func testConnectedAndCompletedAreUsable() {
        XCTAssertEqual(MediaIceWaitPolicy.progress(for: .connected), .connected)
        XCTAssertEqual(MediaIceWaitPolicy.progress(for: .completed), .connected)
        XCTAssertTrue(MediaIceWaitPolicy.isUsable(.connected))
        XCTAssertTrue(MediaIceWaitPolicy.isUsable(.completed))
    }

    func testFailedAndClosedAreFailures() {
        XCTAssertEqual(MediaIceWaitPolicy.progress(for: .failed), .failed)
        XCTAssertEqual(MediaIceWaitPolicy.progress(for: .closed), .failed)
        XCTAssertFalse(MediaIceWaitPolicy.isUsable(.failed))
        XCTAssertFalse(MediaIceWaitPolicy.isUsable(.closed))
    }

    /// `disconnected` can recover, so it never fails the wait on its own — the 5 s grace decides.
    func testCheckingNewAndDisconnectedKeepWaiting() {
        XCTAssertEqual(MediaIceWaitPolicy.progress(for: .new), .waiting)
        XCTAssertEqual(MediaIceWaitPolicy.progress(for: .checking), .waiting)
        XCTAssertEqual(MediaIceWaitPolicy.progress(for: .disconnected), .waiting)
        XCTAssertEqual(MediaIceWaitPolicy.progress(for: .unknown), .waiting)
        XCTAssertFalse(MediaIceWaitPolicy.isUsable(.checking))
    }

    func testMediaDropTriggersCallStateCheck() {
        for state in [MediaIceState.disconnected, .failed, .closed] {
            XCTAssertTrue(MediaIceWaitPolicy.warrantsCallStateCheck(state))
        }
        for state in [MediaIceState.new, .checking, .connected, .completed, .unknown] {
            XCTAssertFalse(MediaIceWaitPolicy.warrantsCallStateCheck(state))
        }
    }
}
