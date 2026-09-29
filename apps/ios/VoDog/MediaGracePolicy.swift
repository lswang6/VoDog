import Foundation

/// S18 decision 6: a terminal media failure no longer hangs the call up immediately. Audio failing is not the same
/// as the call failing — the gateway leg is still up — so the call is held while the user can retry audio, and only
/// a grace period without media ends it.
enum MediaGracePolicy {
    static let grace: Duration = .seconds(30)
    static let graceSeconds = 30
    static let footnote = "30 秒内未恢复音频将自动结束通话"

    enum Plan: Equatable {
        /// The call is already over server-side: end it now, without a misleading retry affordance.
        case endImmediately
        /// Keep the call and give the user the grace period to retry audio.
        case holdForGrace
    }

    /// Codes that mean the server already ended (or revoked) this call. Any status carries the same meaning, so the
    /// code alone decides; `media/offer` can return it as well as `media/options`.
    static let serverEndedCodes: Set<String> = ["MEDIA_REVOKED"]

    static func plan(for error: Error) -> Plan {
        if let code = (error as? APIError)?.serverCode, serverEndedCodes.contains(code) { return .endImmediately }
        return .holdForGrace
    }

    /// S20 decision 8: the grace is a deadline, not a static sentence. `Text(timerInterval:)` renders it; VoiceOver
    /// reads this instead, because an accessibility value is not re-read as the timer ticks on its own.
    static func deadline(from start: Date) -> Date {
        start.addingTimeInterval(TimeInterval(graceSeconds))
    }

    static func remainingSeconds(deadline: Date, now: Date) -> Int {
        max(0, Int(deadline.timeIntervalSince(now).rounded(.up)))
    }

    static func remainingDescription(deadline: Date, now: Date) -> String {
        "剩余 \(remainingSeconds(deadline: deadline, now: now)) 秒"
    }
}

/// Tracks the single in-flight grace period so the end handler runs exactly once per failure, and so a stop, a
/// manual end or a successful reconnect cancels it.
struct MediaGraceTracker: Equatable {
    private(set) var pendingCallID: String?

    var isPending: Bool { pendingCallID != nil }

    mutating func begin(callID: String) { pendingCallID = callID }

    mutating func cancel() { pendingCallID = nil }

    /// Returns true only for the first expiry of a grace started for `callID`.
    mutating func consume(callID: String) -> Bool {
        guard pendingCallID == callID else { return false }
        pendingCallID = nil
        return true
    }
}
