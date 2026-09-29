import AVFoundation

enum PhoneAudioRoutePolicy {
    enum SpeakerMutation: Equatable {
        case none
        case categoryOptions
        case portOverride
    }

    /// Never change category/mode on a live call — that restarts the voice-processing
    /// I/O unit and drops the WebRTC call. Speaker toggles always use port override.
    static func speakerMutation(ownsActivation: Bool, callKitAudioActive: Bool) -> SpeakerMutation {
        if callKitAudioActive || ownsActivation { return .portOverride }
        return .none
    }

    static func callCategoryOptions(speakerEnabled: Bool) -> AVAudioSession.CategoryOptions {
        speakerEnabled ? [.allowBluetoothHFP, .defaultToSpeaker] : [.allowBluetoothHFP]
    }

    static func portOverride(speakerEnabled: Bool) -> AVAudioSession.PortOverride {
        speakerEnabled ? .speaker : .none
    }
}
