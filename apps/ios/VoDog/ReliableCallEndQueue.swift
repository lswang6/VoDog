import Foundation
import UIKit

@MainActor
final class ReliableCallEndQueue {
    static let shared = ReliableCallEndQueue()

    private struct Entry {
        let sessionIdentity: UUID
        let constraint: ReliableCallEndConstraint
        let operationID: UUID
        let backgroundTask: UIBackgroundTaskIdentifier
        let task: Task<Void, Never>
    }
    private var entries: [String: Entry] = [:]

    func enqueue(
        callID: String,
        session: SessionStore,
        sessionIdentity: UUID,
        constraint: ReliableCallEndConstraint = .currentSessionOwner
    ) {
        let callID = callID.lowercased()
        if let existing = entries[callID], existing.sessionIdentity == sessionIdentity,
           existing.constraint.priority >= constraint.priority { return }
        if let replaced = entries.removeValue(forKey: callID) {
            replaced.task.cancel()
            UIApplication.shared.endBackgroundTask(replaced.backgroundTask)
        }
        let operationID = UUID()
        let backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "End call \(callID)") { [weak self] in
            Task { @MainActor in self?.finish(callID: callID, operationID: operationID) }
        }
        let task = Task { @MainActor [weak self, weak session] in
            guard let self, let session else { return }
            for delay in ReliableCallEndPolicy.retryDelays {
                guard !Task.isCancelled, session.isCurrentSession(sessionIdentity) else { break }
                if delay != .zero { try? await Task.sleep(for: delay) }
                guard !Task.isCancelled, session.isCurrentSession(sessionIdentity) else { break }
                do {
                    let response: EndEnvelope = try await session.request(
                        "calls/\(callID)/end", method: "POST",
                        body: constraint.body, timeoutInterval: ReliableCallEndPolicy.requestTimeout,
                        requiredSessionIdentity: sessionIdentity
                    )
                    if ReliableCallEndPolicy.isReleased(response.call.state) { break }
                } catch {
                    if ReliableCallEndPolicy.shouldStopRetrying(error) { break }
                    continue
                }
            }
            finish(callID: callID, operationID: operationID)
        }
        entries[callID] = Entry(
            sessionIdentity: sessionIdentity, constraint: constraint, operationID: operationID,
            backgroundTask: backgroundTask, task: task
        )
    }

    func flush(sessionIdentity: UUID, for duration: Duration = .seconds(6)) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: duration)
        while clock.now < deadline,
              entries.values.contains(where: { $0.sessionIdentity == sessionIdentity }) {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    func cancelAll() {
        entries.values.forEach {
            $0.task.cancel()
            UIApplication.shared.endBackgroundTask($0.backgroundTask)
        }
        entries.removeAll()
    }

    private func finish(callID: String, operationID: UUID) {
        guard let entry = entries[callID], entry.operationID == operationID else { return }
        entry.task.cancel()
        UIApplication.shared.endBackgroundTask(entry.backgroundTask)
        entries.removeValue(forKey: callID)
    }

    private struct EndEnvelope: Decodable, Sendable { let call: CallRecord }
}

struct SessionOwnedCallEndBody: Codable, Sendable, Equatable {
    let onlyIfCurrentSessionOwner: Bool
}

struct GuardedCallEndBody: Codable, Sendable, Equatable {
    let onlyIfCurrentSessionOwner: Bool?
    let onlyIfRinging: Bool?
}

/// Every constraint this queue can send carries a guard, and that is a requirement rather than a coincidence: the
/// queue retries for about 90 s, so an unguarded end could hang up a call a different device answered in between.
/// The one unguarded end the app makes — S20 decision 6's "结束该通话" — is issued once, off this queue.
enum ReliableCallEndConstraint: Sendable, Equatable {
    case ringingUnclaimed
    case currentSessionOwner

    fileprivate var priority: Int {
        switch self {
        case .ringingUnclaimed: 0
        case .currentSessionOwner: 1
        }
    }

    var body: GuardedCallEndBody {
        switch self {
        case .ringingUnclaimed:
            GuardedCallEndBody(onlyIfCurrentSessionOwner: nil, onlyIfRinging: true)
        case .currentSessionOwner:
            GuardedCallEndBody(onlyIfCurrentSessionOwner: true, onlyIfRinging: nil)
        }
    }
}

enum ReliableCallEndPolicy {
    /// Device evidence (S18): all four attempts hit the 4 s timeout (`-1001`) while the control service was slow, the
    /// queue gave up after ~7 s and the call stayed occupied until the user hung up two minutes later. The schedule
    /// now spans about 90 s of delays with a longer per-request timeout; the background task still bounds it.
    static let retryDelays: [Duration] = [
        .zero, .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(30)
    ]
    static let requestTimeout: TimeInterval = 8

    static var totalDelay: Duration { retryDelays.reduce(.zero, +) }

    static func isReleased(_ state: String?) -> Bool {
        ["ended", "failed"].contains(state ?? "")
    }

    static func shouldStopRetrying(_ error: Error) -> Bool {
        switch error {
        case APIError.unauthorized, SessionLifecycleError.staleSession:
            true
        case APIError.server(404, _, _):
            true
        case APIError.server(409, _, let code)
        where ["CALL_NOT_SESSION_OWNER", "CALL_NOT_RINGING"].contains(code ?? ""):
            true
        default:
            false
        }
    }
}

enum ClaimedCallPolicy {
    /// A cold-launched answer waits up to 5 × 1 s for session restoration before giving up.
    static let sessionWaitAttempts = 5
    static let sessionWaitInterval: Duration = .seconds(1)

    /// Why an answer cannot be claimed yet; nil when it can.
    static func answerBlocker(offered: Bool, authenticated: Bool) -> String? {
        guard offered else { return "not_offered" }
        return authenticated ? nil : "not_authenticated"
    }

    /// Only a missing session can still arrive; an offer that is gone stays gone.
    static func shouldWaitForSession(blocker: String?) -> Bool { blocker == "not_authenticated" }

    static func isOwnedAndAnswerable(_ call: CallRecord) -> Bool {
        call.claimedByCurrentSession == true && ["connecting", "active"].contains(call.state ?? "")
    }
}
