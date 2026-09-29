import CryptoKit
import Foundation

struct SMSOutboundPayload: Codable, Sendable, Equatable {
    let simId: String
    let remoteNumber: String
    let body: String
}

/// Persists only SHA-256 digests and random idempotency keys. Pending operations
/// survive app/session restarts for the same account, while a different account
/// always gets a separate namespace. A confirmed 2xx response removes the key.
@MainActor
final class SMSIdempotencyStore {
    static let shared = SMSIdempotencyStore()
    private static let maximumPending = 128

    private struct Pending: Codable, Equatable {
        let idempotencyKey: String
        let createdAt: TimeInterval?
    }

    private let defaults: UserDefaults
    private let storageKey: String
    private var pending: [String: Pending]

    init(defaults: UserDefaults = .standard, storageKey: String = "sms-pending-idempotency-v1") {
        self.defaults = defaults
        self.storageKey = storageKey
        pending = defaults.data(forKey: storageKey)
            .flatMap { try? JSONDecoder().decode([String: Pending].self, from: $0) } ?? [:]
    }

    func key(accountID: String, payload: SMSOutboundPayload) throws -> String {
        try key(fingerprint: Self.fingerprint(accountID: accountID, payload: payload))
    }

    func key(accountID: String, payload: SMSBatchPayload) throws -> String {
        try key(fingerprint: Self.batchFingerprint(accountID: accountID, payload: payload))
    }

    private func key(fingerprint: String) throws -> String {
        if let existing = pending[fingerprint] { return existing.idempotencyKey }
        guard pending.count < Self.maximumPending else { throw SMSPendingCapacityError.full }
        let key = UUID().uuidString.lowercased()
        pending[fingerprint] = Pending(idempotencyKey: key, createdAt: Date().timeIntervalSince1970)
        persist()
        return key
    }

    func markSucceeded(accountID: String, payload: SMSOutboundPayload, idempotencyKey: String) {
        let fingerprint = Self.fingerprint(accountID: accountID, payload: payload)
        guard pending[fingerprint]?.idempotencyKey == idempotencyKey else { return }
        pending.removeValue(forKey: fingerprint)
        persist()
    }

    func markSucceeded(accountID: String, payload: SMSBatchPayload, idempotencyKey: String) {
        let fingerprint = Self.batchFingerprint(accountID: accountID, payload: payload)
        guard pending[fingerprint]?.idempotencyKey == idempotencyKey else { return }
        pending.removeValue(forKey: fingerprint)
        persist()
    }

    private static func batchFingerprint(accountID: String, payload: SMSBatchPayload) -> String {
        // Preserve order: retries must send the exact same payload, not a newly sorted batch.
        digest(["sms/batch", accountID, payload.simId, payload.body] + payload.recipients)
    }

    private func persist() {
        if pending.isEmpty {
            defaults.removeObject(forKey: storageKey)
        } else if let data = try? JSONEncoder().encode(pending) {
            defaults.set(data, forKey: storageKey)
        }
    }

    private static func fingerprint(accountID: String, payload: SMSOutboundPayload) -> String {
        digest([accountID, payload.simId, payload.remoteNumber, payload.body])
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


enum SMSPendingCapacityError: LocalizedError {
    case full
    var errorDescription: String? {
        "待确认短信请求已达上限。请先确认或重试原请求，当前草稿已保留。"
    }
}
