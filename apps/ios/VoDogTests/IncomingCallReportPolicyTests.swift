import UIKit
import XCTest
@testable import VoDog

final class IncomingCallReportPolicyTests: XCTestCase {
    func testReportsIncomingCallOnPushCallbackPath() {
        XCTAssertTrue(IncomingCallReportPolicy.shouldReportSynchronouslyOnPushCallback())
    }

    func testLocalRingtoneOnlyWhenAppIsForegroundActive() {
        XCTAssertEqual(IncomingCallReportPolicy.ringDecision(applicationState: .active), .localRingtone)
        XCTAssertTrue(IncomingCallReportPolicy.shouldPlayLocalRingtone(applicationState: .active))
        XCTAssertEqual(IncomingCallReportPolicy.ringDecision(applicationState: .background), .callKitOnly)
        XCTAssertFalse(IncomingCallReportPolicy.shouldPlayLocalRingtone(applicationState: .background))
        XCTAssertEqual(IncomingCallReportPolicy.ringDecision(applicationState: .inactive), .callKitOnly)
    }

    func testAnswerAndEndStopLocalRingtone() {
        XCTAssertTrue(IncomingCallReportPolicy.shouldStopLocalRingtoneOnAnswerOrEnd())
    }

    /// S44: unlike the ringtone, the vibration does not care about the app state — a locked phone is exactly the
    /// case it is for.
    func testVibratesForEveryShownOfferExceptWhileTheOwnerIsOnAnotherCall() {
        XCTAssertTrue(IncomingCallReportPolicy.shouldVibrate(reportSucceeded: true, deviceBusy: false))
        // S42 gives this one to the AI; buzzing into the ear of someone mid-call is not a notification.
        XCTAssertFalse(IncomingCallReportPolicy.shouldVibrate(reportSucceeded: true, deviceBusy: true))
        // Nothing was shown, so there is nothing to feel — a buzz with no call screen is unexplainable.
        XCTAssertFalse(IncomingCallReportPolicy.shouldVibrate(reportSucceeded: false, deviceBusy: false))
        XCTAssertFalse(IncomingCallReportPolicy.shouldVibrate(reportSucceeded: false, deviceBusy: true))
    }
}
