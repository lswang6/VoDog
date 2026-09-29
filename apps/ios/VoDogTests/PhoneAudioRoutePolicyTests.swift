import AVFoundation
import XCTest
@testable import VoDog

final class PhoneAudioRoutePolicyTests: XCTestCase {
    func testCallCategoryOptionsPreferReceiverAndBluetoothWithoutDefaultToSpeaker() {
        let options = PhoneAudioRoutePolicy.callCategoryOptions(speakerEnabled: false)
        XCTAssertFalse(options.contains(.defaultToSpeaker))
        XCTAssertTrue(options.contains(.allowBluetoothHFP))
    }

    func testSpeakerOnAddsDefaultToSpeakerWithoutPortOverride() {
        let options = PhoneAudioRoutePolicy.callCategoryOptions(speakerEnabled: true)
        XCTAssertTrue(options.contains(.defaultToSpeaker))
        XCTAssertTrue(options.contains(.allowBluetoothHFP))
    }

    func testLiveCallKitSpeakerToggleUsesPortOverrideNotCategoryChange() {
        XCTAssertEqual(
            PhoneAudioRoutePolicy.speakerMutation(ownsActivation: false, callKitAudioActive: true),
            .portOverride
        )
        XCTAssertEqual(
            PhoneAudioRoutePolicy.speakerMutation(ownsActivation: true, callKitAudioActive: true),
            .portOverride
        )
        XCTAssertNotEqual(
            PhoneAudioRoutePolicy.speakerMutation(ownsActivation: true, callKitAudioActive: true),
            .categoryOptions
        )
        XCTAssertEqual(PhoneAudioRoutePolicy.portOverride(speakerEnabled: true), .speaker)
        XCTAssertEqual(PhoneAudioRoutePolicy.portOverride(speakerEnabled: false), .none)
    }

    func testOwnedNonCallKitSpeakerToggleUsesPortOverrideNotCategoryChange() {
        XCTAssertEqual(
            PhoneAudioRoutePolicy.speakerMutation(ownsActivation: true, callKitAudioActive: false),
            .portOverride
        )
        XCTAssertEqual(
            PhoneAudioRoutePolicy.speakerMutation(ownsActivation: false, callKitAudioActive: false),
            .none
        )
    }
}
