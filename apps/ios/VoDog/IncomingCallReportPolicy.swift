import UIKit

enum IncomingCallReportPolicy {
    enum RingDecision: Equatable {
        case localRingtone
        case callKitOnly
    }

    static func shouldReportSynchronouslyOnPushCallback() -> Bool { true }

    static func ringDecision(applicationState: UIApplication.State) -> RingDecision {
        applicationState == .active ? .localRingtone : .callKitOnly
    }

    static func shouldPlayLocalRingtone(applicationState: UIApplication.State) -> Bool {
        ringDecision(applicationState: applicationState) == .localRingtone
    }

    static func shouldStopLocalRingtoneOnAnswerOrEnd() -> Bool { true }

    /// S44: the vibration is not the ringtone. The ringtone is foreground-only — it exists so a user already
    /// looking at the app hears something — while the vibration is for the case the report is *for*: the phone
    /// in a pocket, locked, CallKit ringing without a single buzz. So it runs for every offer that reached the
    /// screen, in any app state, and only there. Not when the owner is already in another call: S42 hands that
    /// one to the AI, and a phone held against an ear must not buzz into it.
    static func shouldVibrate(reportSucceeded: Bool, deviceBusy: Bool) -> Bool {
        reportSucceeded && !deviceBusy
    }
}
