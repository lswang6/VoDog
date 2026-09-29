import Foundation

/// S41 decision 3: the remote party hangs up, Control marks the call `ended`/`failed`, and nothing on the
/// device takes the system call down — it kept counting for 7 分 38 秒 until the app was force-killed.
///
/// A CallKit-tracked id is ended only when the fetched list actually carries it in a finished state. An id the
/// list does not mention is *not* ended: a call reported a moment ago races the poll, and a genuinely missing
/// one is already handled by the offered-call 404 path in `IncomingCallManager.reconcileOnce`.
enum CallKitRemoteEndPolicy {
    static func isFinished(_ state: String?) -> Bool {
        guard let state else { return false }
        return ["ended", "failed"].contains(state.lowercased())
    }

    /// `CallCoordinator.activeCallIDs` are already lowercased; the list's ids come from the server as-is.
    static func idsToEnd(activeCallKitIDs: [String], calls: [(id: String, state: String?)]) -> [String] {
        let finished = Set(calls.filter { isFinished($0.state) }.map { $0.id.lowercased() })
        return activeCallKitIDs.filter { finished.contains($0.lowercased()) }
    }
}
