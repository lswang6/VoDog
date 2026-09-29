import Foundation

struct SMSRecipient: Identifiable, Equatable, Sendable {
    let number: String
    let name: String?
    var id: String { number }
}

enum SMSRecipientPolicy {
    /// Reuse the client's dial normalization. Do not infer country codes or suffix-match:
    /// two distinct international numbers can share a suffix.
    static func adding(number: String, name: String? = nil, to recipients: [SMSRecipient]) -> [SMSRecipient] {
        let normalized = PhoneNumberText.normalized(number)
        guard !normalized.isEmpty, !recipients.contains(where: { $0.number == normalized }) else { return recipients }
        return recipients + [SMSRecipient(number: normalized, name: name)]
    }

    static func resolved(_ recipients: [SMSRecipient], manual: String) -> [SMSRecipient] {
        adding(number: manual, to: recipients)
    }

    static func matches(_ contact: Contact, query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty { return true }
        if contact.displayName.localizedStandardContains(query) { return true }
        let digits = PhoneNumberText.normalized(query)
        return contact.phones.contains {
            $0.displayNumber.localizedStandardContains(query)
                || $0.rawNumber.localizedStandardContains(query)
                || (!digits.isEmpty && (
                    PhoneNumberText.normalized($0.displayNumber).contains(digits)
                        || PhoneNumberText.normalized($0.rawNumber).contains(digits)
                ))
        }
    }
}

struct SMSBatchPayload: Codable, Equatable, Sendable {
    let simId: String
    let recipients: [String]
    let body: String
}

struct SMSBatchResponse: Decodable, Sendable {
    let batchId: String
    let intervalSeconds: Int
    let items: [SMSMessage]
}

enum SMSSubmission: Equatable, Sendable {
    case single(SMSOutboundPayload)
    case batch(SMSBatchPayload)

    init?(simID: String, recipients: [SMSRecipient], manual: String, body: String) {
        let numbers = SMSRecipientPolicy.resolved(recipients, manual: manual).map(\.number)
        let body = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...100).contains(numbers.count), !body.isEmpty else { return nil }
        if numbers.count == 1 {
            self = .single(SMSOutboundPayload(simId: simID, remoteNumber: numbers[0], body: body))
        } else {
            self = .batch(SMSBatchPayload(simId: simID, recipients: numbers, body: body))
        }
    }
}

enum SMSContactPagePolicy {
    static func query(query: String, offset: Int) -> [URLQueryItem] {
        ContactLookupPolicy.listQuery(query: query) + [URLQueryItem(name: "offset", value: String(offset))]
    }
}
