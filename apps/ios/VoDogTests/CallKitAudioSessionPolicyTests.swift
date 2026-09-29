import AVFoundation
import XCTest
@testable import VoDog

final class CallKitAudioSessionPolicyTests: XCTestCase {
    func testRequestsRecordPermissionOnlyWhenUndetermined() {
        XCTAssertTrue(CallKitAudioSessionPolicy.shouldRequestRecordPermission(.undetermined))
        XCTAssertFalse(CallKitAudioSessionPolicy.shouldRequestRecordPermission(.granted))
        XCTAssertFalse(CallKitAudioSessionPolicy.shouldRequestRecordPermission(.denied))
        XCTAssertFalse(CallKitAudioSessionPolicy.shouldRequestRecordPermission(.unknown))
    }

    func testFulfillHappensBeforeWebRTC() {
        XCTAssertTrue(CallKitAudioSessionPolicy.shouldFulfillBeforeStartingWebRTC())
    }

    func testActivateEnablesAudioWhenAttemptExistsWithoutCallKitGate() {
        XCTAssertTrue(CallKitAudioSessionPolicy.shouldEnableAudioOnActivate(hasCallAttempt: true))
        XCTAssertFalse(CallKitAudioSessionPolicy.shouldEnableAudioOnActivate(hasCallAttempt: false))
        XCTAssertFalse(CallKitAudioSessionPolicy.shouldApplyPortOverrideOnActivate())
    }

    func testCallKitManagedIgnoresPreferredSampleRate() {
        XCTAssertFalse(CallKitAudioSessionPolicy.prefersSampleRateOverride(managedByCallKit: true))
        XCTAssertTrue(CallKitAudioSessionPolicy.prefersSampleRateOverride(managedByCallKit: false))
        XCTAssertTrue(CallKitAudioSessionPolicy.ignoresPreferredAttributeConfigurationErrors)
    }

    func testRecoverReenablesAudioOnlyWhileCallKitManagedAndActive() {
        XCTAssertEqual(
            CallKitAudioSessionPolicy.recoverAction(
                hasCallAttempt: true, managedByCallKit: true, callKitAudioActive: true, ownsActivation: false
            ),
            .reenableAudioOnly
        )
        XCTAssertEqual(
            CallKitAudioSessionPolicy.recoverAction(
                hasCallAttempt: true, managedByCallKit: true, callKitAudioActive: false, ownsActivation: false
            ),
            .none
        )
        XCTAssertEqual(
            CallKitAudioSessionPolicy.recoverAction(
                hasCallAttempt: true, managedByCallKit: false, callKitAudioActive: false, ownsActivation: true
            ),
            .setActiveAndEnable
        )
        XCTAssertEqual(
            CallKitAudioSessionPolicy.recoverAction(
                hasCallAttempt: false, managedByCallKit: false, callKitAudioActive: false, ownsActivation: true
            ),
            .none
        )
    }

    func testMuteRoutesThroughCallKitOnlyForTrackedCallKitCalls() {
        XCTAssertTrue(CallKitMutePolicy.routesThroughCallKit(managedByCallKit: true, tracked: true))
        XCTAssertFalse(CallKitMutePolicy.routesThroughCallKit(managedByCallKit: true, tracked: false))
        XCTAssertFalse(CallKitMutePolicy.routesThroughCallKit(managedByCallKit: false, tracked: true))
        XCTAssertFalse(CallKitMutePolicy.routesThroughCallKit(managedByCallKit: false, tracked: false))
    }
}
