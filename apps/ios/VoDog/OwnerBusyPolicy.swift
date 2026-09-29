import Foundation

/// S42 decision 5: a VoIP push can land while the iPhone is already in another call — its own cellular call,
/// FaceTime, or another CallKit app's. CallKit still shows the offer, the user still cannot take it, so the app
/// tells Control that the owner is busy and lets the AI answer after the grace period. The decision is kept here,
/// off the CallKit types, so it can be tested without a device in a call.
enum OwnerBusyPolicy {
    /// One `CXCall` reduced to the flags the decision reads.
    struct CallState: Equatable {
        let uuid: UUID
        let hasEnded: Bool
        let hasConnected: Bool
        let isOutgoing: Bool
        let isOnHold: Bool
    }

    /// Busy means another call is holding the phone: connected (on hold counts — it is still connected) or an
    /// outgoing leg still dialling. A second *incoming ringing* call is not busy: nothing owns the audio yet and
    /// the user is free to take either one. The incoming call's own leg is excluded by UUID — this runs before
    /// the CallKit report, but the exclusion keeps it correct if it ever runs after.
    static func isBusy(calls: [CallState], incomingCallUUID: UUID?) -> Bool {
        calls.contains { $0.uuid != incomingCallUUID && !$0.hasEnded && ($0.hasConnected || $0.isOutgoing) }
    }
}
