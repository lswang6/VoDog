import Foundation
import Observation
import UserNotifications

/// S67 `GET /badges`. `sims` lists only nonzero SIMs, so an absent SIM means 0.
struct BadgeCounts: Decodable, Equatable, Sendable {
    struct SIM: Decodable, Equatable, Sendable {
        let simId: String
        let calls: Int
        let sms: Int
    }
    var calls = 0
    var sms = 0
    var sims: [SIM] = []

    var callsBySIM: [String: Int] { Dictionary(sims.map { ($0.simId, $0.calls) }, uniquingKeysWith: +) }
    var smsBySIM: [String: Int] { Dictionary(sims.map { ($0.simId, $0.sms) }, uniquingKeysWith: +) }

    init(calls: Int = 0, sms: Int = 0, sims: [SIM] = []) { self.calls = calls; self.sms = sms; self.sims = sims }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        calls = try c.decodeIfPresent(Int.self, forKey: .calls) ?? 0
        sms = try c.decodeIfPresent(Int.self, forKey: .sms) ?? 0
        sims = try c.decodeIfPresent([SIM].self, forKey: .sims) ?? []
    }
    private enum CodingKeys: String, CodingKey { case calls, sms, sims }

    /// Local optimistic step after `POST /calls/:id/seen`; the refresh that follows restores server truth.
    mutating func decrementCall(simID: String?) {
        calls = max(0, calls - 1)
        if let i = sims.firstIndex(where: { $0.simId == simID }), sims[i].calls > 0 {
            sims[i] = SIM(simId: sims[i].simId, calls: sims[i].calls - 1, sms: sims[i].sms)
        }
    }

    mutating func decrementSMS(simID: String?, by n: Int) {
        guard n > 0 else { return }
        sms = max(0, sms - n)
        if let i = sims.firstIndex(where: { $0.simId == simID }) {
            sims[i] = SIM(simId: sims[i].simId, calls: sims[i].calls, sms: max(0, sims[i].sms - n))
        }
    }
}

/// S67c row dots: server flag, minus what this session already opened (the optimistic step before the POST lands).
enum UnreadDotPolicy {
    static func callUnseen(_ call: CallRecord, locallySeen: Set<String>) -> Bool {
        !call.isInternal && call.unseen == true && !locallySeen.contains(call.id)
    }

    static func reportUnseen(_ item: CallReportItem, locallySeen: Set<String>) -> Bool {
        !item.isInternal && item.unseen && !locallySeen.contains(item.callId)
    }

    static func conversationUnread(_ messages: [SMSMessage], locallyRead: Set<String>) -> Bool {
        messages.contains { $0.unread == true && !locallyRead.contains($0.id) }
    }
}

enum BadgeLabelPolicy {
    /// 0 hides the badge; above 99 reads `99+`.
    static func text(_ n: Int) -> String? { n <= 0 ? nil : (n > 99 ? "99+" : String(n)) }
    static func accessibility(_ n: Int) -> String? { n <= 0 ? nil : "\(n) 条未读" }
}

/// S67 decision 4: these only shape the app-icon badge; in-app badges always show.
enum BadgePreferences {
    static let enabledKey = "badge.enabled", callsKey = "badge.calls", smsKey = "badge.sms"

    struct Values: Equatable { var enabled = true, calls = true, sms = true }

    static func current(_ defaults: UserDefaults = .standard) -> Values {
        func read(_ key: String) -> Bool { defaults.object(forKey: key) as? Bool ?? true }
        return Values(enabled: read(enabledKey), calls: read(callsKey), sms: read(smsKey))
    }

    static func iconValue(_ counts: BadgeCounts, _ prefs: Values) -> Int {
        guard prefs.enabled else { return 0 }
        return (prefs.calls ? counts.calls : 0) + (prefs.sms ? counts.sms : 0)
    }

    /// What `PUT /push/registrations` carries: master off = both false.
    static func push(_ prefs: Values) -> (calls: Bool, sms: Bool) {
        (prefs.enabled && prefs.calls, prefs.enabled && prefs.sms)
    }
}

@MainActor @Observable
final class BadgeStore {
    static let shared = BadgeStore()
    private(set) var counts = BadgeCounts()
    /// S67c: ids opened this session. Seen/read is one-way on the server, so keeping them is safe; a failed POST
    /// removes its ids so the next poll can show the dot again.
    private(set) var seenCallIDs: Set<String> = []
    private(set) var readSMSIDs: Set<String> = []
    private var lastIcon: Int?
    /// A pre-S67 Control answers 404; stop asking for the rest of that session instead of logging every 5 s.
    private var unsupportedIdentity: UUID?

    func refresh(session: SessionStore) async {
        guard let identity = session.sessionIdentity, unsupportedIdentity != identity else { return }
        do {
            let value: BadgeCounts = try await session.request("badges", requiredSessionIdentity: identity)
            guard session.isCurrentSession(identity) else { return }
            counts = value
            applyIcon()
        } catch {
            // Errors keep the last value; badges never surface an error.
            if case APIError.server(404, _, _) = error { unsupportedIdentity = identity }
        }
    }

    func markCallSeen(_ callID: String, simID: String?, session: SessionStore) async {
        guard let identity = session.sessionIdentity else { return }
        let inserted = seenCallIDs.insert(callID).inserted
        do {
            let _: EmptyResponse = try await session.request(
                "calls/\(callID)/seen", method: "POST", requiredSessionIdentity: identity
            )
        } catch {
            if inserted { seenCallIDs.remove(callID) }
            return
        }
        // ponytail: the client can't tell whether this call was pending, so step down only while a count remains
        // on its SIM (or the total when the SIM is unknown); the immediate refresh corrects any overshoot.
        if simID.map({ (counts.callsBySIM[$0] ?? 0) > 0 }) ?? (counts.calls > 0) {
            counts.decrementCall(simID: simID)
            applyIcon()
        }
        await refresh(session: session)
    }

    /// False when a chunk failed, so the caller can retry those ids.
    @discardableResult
    func markSMSRead(_ ids: [String], simID: String?, session: SessionStore) async -> Bool {
        guard let identity = session.sessionIdentity, !ids.isEmpty else { return true }
        let fresh = Set(ids).subtracting(readSMSIDs)
        readSMSIDs.formUnion(fresh)
        var updated = 0
        for start in stride(from: 0, to: ids.count, by: 500) {
            let chunk = Array(ids[start..<min(start + 500, ids.count)])
            struct Body: Encodable, Sendable { let ids: [String] }
            struct Result: Decodable, Sendable { let updated: Int? }
            guard let result: Result = try? await session.request(
                "sms/read", method: "POST", body: Body(ids: chunk), requiredSessionIdentity: identity
            ) else {
                readSMSIDs.subtract(fresh.intersection(ids[start...]))
                counts.decrementSMS(simID: simID, by: updated)
                return false
            }
            updated += result.updated ?? 0
        }
        counts.decrementSMS(simID: simID, by: updated)
        applyIcon()
        await refresh(session: session)
        return true
    }

    func applyIcon() {
        let value = BadgePreferences.iconValue(counts, BadgePreferences.current())
        guard value != lastIcon else { return }
        lastIcon = value
        // Fails silently without `.badge` authorization; the poller never prompts.
        UNUserNotificationCenter.current().setBadgeCount(value) { _ in }
    }

    func reset() {
        counts = BadgeCounts()
        seenCallIDs = []
        readSMSIDs = []
        unsupportedIdentity = nil
        applyIcon()
    }
}
