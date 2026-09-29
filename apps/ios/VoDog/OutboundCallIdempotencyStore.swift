import CryptoKit
import Foundation

struct OutboundCallPayload: Codable, Sendable, Equatable {
    let simId: String
    let remoteNumber: String
}

/// Stores only a digest, random key and creation time. An ambiguous network
/// result survives relaunch for the same account and payload.
@MainActor
final class OutboundCallIdempotencyStore {
    static let shared = OutboundCallIdempotencyStore()
    private static let maximumPending = 128

    private struct Pending: Codable, Equatable {
        let idempotencyKey: String
        let createdAt: TimeInterval?
    }

    private let defaults: UserDefaults
    private let storageKey: String
    private var pending: [String: Pending]

    init(defaults: UserDefaults = .standard, storageKey: String = "call-pending-idempotency-v1") {
        self.defaults = defaults
        self.storageKey = storageKey
        pending = defaults.data(forKey: storageKey)
            .flatMap { try? JSONDecoder().decode([String: Pending].self, from: $0) } ?? [:]
        if trimIfNeeded() { persist() }
    }

    func key(accountID: String, payload: OutboundCallPayload) -> String {
        let fingerprint = Self.fingerprint(accountID: accountID, payload: payload)
        if let existing = pending[fingerprint] { return existing.idempotencyKey }
        let key = UUID().uuidString.lowercased()
        pending[fingerprint] = Pending(idempotencyKey: key, createdAt: Date().timeIntervalSince1970)
        _ = trimIfNeeded()
        persist()
        return key
    }

    func markSucceeded(accountID: String, payload: OutboundCallPayload, idempotencyKey: String) {
        let fingerprint = Self.fingerprint(accountID: accountID, payload: payload)
        guard pending[fingerprint]?.idempotencyKey == idempotencyKey else { return }
        pending.removeValue(forKey: fingerprint)
        persist()
    }

    @discardableResult private func trimIfNeeded() -> Bool {
        guard pending.count > Self.maximumPending else { return false }
        for key in pending.sorted(by: { ($0.value.createdAt ?? 0) < ($1.value.createdAt ?? 0) })
            .prefix(pending.count - Self.maximumPending).map(\.key) {
            pending.removeValue(forKey: key)
        }
        return true
    }

    private func persist() {
        if pending.isEmpty { defaults.removeObject(forKey: storageKey) }
        else if let data = try? JSONEncoder().encode(pending) { defaults.set(data, forKey: storageKey) }
    }

    private static func fingerprint(accountID: String, payload: OutboundCallPayload) -> String {
        digest([accountID, payload.simId, PhoneNumberText.normalized(payload.remoteNumber)])
    }

    private static func digest(_ fields: [String]) -> String {
        var canonical = Data()
        for field in fields {
            let value = Data(field.utf8)
            var length = UInt64(value.count).bigEndian
            withUnsafeBytes(of: &length) { canonical.append(contentsOf: $0) }
            canonical.append(value)
        }
        return SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined()
    }
}
