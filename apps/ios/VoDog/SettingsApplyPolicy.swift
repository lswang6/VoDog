import Foundation

/// 设置页「SIM 与接听模式 → 应用状态」的全部判断。
///
/// A settings PUT only writes the *desired* version; the gateway confirms it a moment later by raising
/// `appliedVersion`. The PUT response is therefore always one step behind by design, so the page used to show
/// 「设置已保存，但设备尚未确认应用。」 forever — the pushed view kept its own copy of `settings` and never
/// re-read it. This policy is the pure half of the fix: the view polls `GET /sims` after a save and asks these
/// functions what the 应用状态 block should say.
///
/// The one rule that outranks everything: 应用成功 is only ever shown when the device really did confirm the
/// exact version we asked for (`appliedVersion == version`, both known). Anything else is 正在应用中… (while the
/// window is open) or the original orange warning.
enum SettingsApplyPolicy {
    /// Re-read `GET /sims` this often while a save is waiting for the gateway's ack.
    static let pollInterval: Duration = .seconds(2)
    /// After this long without an ack, stop polling and fall back to the orange 尚未确认 line.
    static let timeout: Duration = .seconds(30)

    enum State: Equatable, Sendable {
        /// Nothing saved in this screen yet — the block just reflects whatever the server last told us.
        case idle
        /// A PUT succeeded at `started`; waiting for `appliedVersion` to reach `target`.
        case applying(started: Date, target: Int)
        /// The gateway confirmed `target`. Stays until the next save.
        case applied
        /// A later client save advanced the current server version beyond this screen's submitted target.
        case superseded
        /// No ack within `timeout`. Stays until the next save.
        case timedOut
    }

    enum Tone: Equatable, Sendable {
        case pending
        case success
        case warning
        /// Nothing to say (no settings loaded at all).
        case none
    }

    static let pendingText = "正在应用中…"
    static let successText = "应用成功"
    static let warningText = "设置已保存，但设备尚未确认应用。"
    static let supersededText = "设置已被另一客户端的新版本替代，请刷新后查看。"

    /// The state machine driven by each poll tick. Only `.applying` ever moves; a fresh `.applying` is installed
    /// by the view when the user saves again, never here.
    static func next(_ state: State, now: Date, appliedVersion: Int?, version: Int?) -> State {
        guard case let .applying(started, target) = state else { return state }
        if let version, version > target { return .superseded }
        if version == target, let appliedVersion, appliedVersion >= target { return .applied }
        if Duration.seconds(now.timeIntervalSince(started)) >= timeout { return .timedOut }
        return .applying(started: started, target: target)
    }

    /// What the 应用状态 block says, and in which colour.
    ///
    /// While applying, the submitted target controls every label: a later server version is superseded, and only
    /// that exact current target with a matching-or-newer gateway ack is successful.
    static func label(_ state: State, appliedVersion: Int?, version: Int?) -> (text: String, tone: Tone) {
        if case .superseded = state { return (supersededText, .warning) }
        if case let .applying(_, target) = state {
            if let version, version > target { return (supersededText, .warning) }
            if version == target, let appliedVersion, appliedVersion >= target {
                return (successText, .success)
            }
            return (pendingText, .pending)
        }
        if let applied = appliedVersion, let expected = version, applied >= expected {
            return (successText, .success)
        }
        // `version == nil` means we never had settings for this SIM; there is nothing to be unconfirmed about.
        guard version != nil else { return ("", .none) }
        return (warningText, .warning)
    }

    /// The one-line subtitle form of the same rule, for a row that has no room for the full sentence.
    /// (iOS currently shows it nowhere — Android's SIM row does; kept here so the three clients share the words.)
    static func subtitle(appliedVersion: Int?, version: Int?) -> String {
        if let applied = appliedVersion, let expected = version, applied >= expected { return "网关已确认" }
        return "等待网关确认"
    }
}
