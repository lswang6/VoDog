enum CallKitAudioSessionPolicy {
    enum RecoverAction: Equatable {
        case none
        case reenableAudioOnly
        case setActiveAndEnable
    }

    enum MicrophonePermission: Equatable {
        case undetermined, granted, denied, unknown
    }

    static func shouldRequestRecordPermission(_ permission: MicrophonePermission) -> Bool {
        permission == .undetermined
    }

    static func shouldFulfillBeforeStartingWebRTC() -> Bool { true }

    static func shouldEnableAudioOnActivate(hasCallAttempt: Bool) -> Bool {
        hasCallAttempt
    }

    static func shouldApplyPortOverrideOnActivate() -> Bool { false }

    static func prefersSampleRateOverride(managedByCallKit: Bool) -> Bool {
        !managedByCallKit
    }

    static var ignoresPreferredAttributeConfigurationErrors: Bool { true }

    static func recoverAction(
        hasCallAttempt: Bool,
        managedByCallKit: Bool,
        callKitAudioActive: Bool,
        ownsActivation: Bool
    ) -> RecoverAction {
        if managedByCallKit {
            return callKitAudioActive ? .reenableAudioOnly : .none
        }
        guard hasCallAttempt, ownsActivation else { return .none }
        return .setActiveAndEnable
    }
}
