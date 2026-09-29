import Foundation

struct BlocklistItem: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let remoteNumber: String
    let createdAt: String
    let sourceCallId: String?
    /// S21 §B: the server names the contact on each blocklist row. Optional during the staged rollout.
    let contactName: String?
    /// S55: "phone" = reported by the Pixel's own system blocklist. Absent on an older Control.
    let source: String?
    /// S66: "call" or "sms" — which of the two lists this row is on. Absent on an older Control (= call).
    let scope: String?

    init(id: String, remoteNumber: String, createdAt: String, sourceCallId: String? = nil, contactName: String? = nil,
         source: String? = nil, scope: String? = nil) {
        self.id = id; self.remoteNumber = remoteNumber; self.createdAt = createdAt
        self.sourceCallId = sourceCallId; self.contactName = contactName; self.source = source; self.scope = scope
    }
}

/// Two spellings of the same line. Control owns real matching (`phoneMatchKeys`); this is only used to line up
/// data the server already sent — a blocklist row, or a phone inside a `ContactDto` — with the number a card
/// is about. It never decides what to block.
enum PhoneDialKey {
    /// A shorter fragment than this cannot identify a line, so it is never treated as a match.
    static let minimumSignificantDigits = 7

    static func matches(_ lhs: String, _ rhs: String) -> Bool {
        let left = PhoneNumberText.normalized(lhs)
        let right = PhoneNumberText.normalized(rhs)
        guard !left.isEmpty, !right.isEmpty else { return false }
        if left == right { return true }
        // A stored "+12025550101" and a dialled "2025550101" are the same line.
        let leftDigits = left.filter(\.isNumber)
        let rightDigits = right.filter(\.isNumber)
        guard leftDigits.count >= minimumSignificantDigits, rightDigits.count >= minimumSignificantDigits else {
            return false
        }
        return leftDigits.hasSuffix(rightDigits) || rightDigits.hasSuffix(leftDigits)
    }
}

/// The fallback for a card whose source stated `blocked` but no entry id: scan `GET /blocklist`. `ContactDto`
/// now carries `blockedEntryId` per contact and per phone, so this runs only when the server omitted those.
enum BlocklistEntryLookup {
    static func entryID(for rawNumber: String, in items: [BlocklistItem]) -> String? {
        guard !PhoneNumberText.normalized(rawNumber).isEmpty else { return nil }
        if let exact = items.first(where: {
            PhoneNumberText.normalized($0.remoteNumber) == PhoneNumberText.normalized(rawNumber)
        }) { return exact.id }
        return items.first { PhoneDialKey.matches($0.remoteNumber, rawNumber) }?.id
    }
}

/// S66: the account keeps two lists. 来电黑名单 hangs up incoming calls; 短信黑名单 files SMS as interceptions.
enum BlocklistScope: String, CaseIterable, Identifiable, Sendable {
    case call, sms

    var id: String { rawValue }
    var title: String {
        switch self { case .call: "来电"; case .sms: "短信" }
    }
    var queryItems: [URLQueryItem] { [URLQueryItem(name: "scope", value: rawValue)] }
    var unblockConfirmMessage: String {
        switch self {
        case .call: ContactCardActionPolicy.unblockConfirmMessage
        case .sms: "解除后，这个号码的短信会恢复正常接收。"
        }
    }
}

/// S66: 设置 states both lists in one line.
enum BlocklistSummaryPolicy {
    static func summary(call: Int, sms: Int) -> String {
        call == 0 && sms == 0 ? "暂无" : "来电 \(call) · 短信 \(sms)"
    }
}

struct BlocklistCreateBody: Codable, Sendable, Equatable {
    let remoteNumber: String
    let sourceCallId: String?
    /// S66: omitted = call on the server; every current caller states it explicitly.
    let scope: String?

    init(remoteNumber: String, sourceCallId: String?, scope: BlocklistScope? = nil) {
        self.remoteNumber = remoteNumber; self.sourceCallId = sourceCallId; self.scope = scope?.rawValue
    }

    enum CodingKeys: String, CodingKey { case remoteNumber, sourceCallId, scope }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(remoteNumber, forKey: .remoteNumber)
        try container.encodeIfPresent(sourceCallId, forKey: .sourceCallId)
        try container.encodeIfPresent(scope, forKey: .scope)
    }
}

struct BlocklistItemEnvelope: Codable, Sendable, Equatable {
    let item: BlocklistItem
}

enum OwnerBlockedNumberKey {
    static func canonicalKey(_ raw: String, countryIso: String?) -> String {
        // Never guess country; control is the matching source of truth.
        _ = countryIso
        return PhoneNumberText.normalized(raw)
    }

    static func isEmergency(_ raw: String) -> Bool {
        let digits = raw.filter(\.isNumber)
        return digits == "112" || digits == "911"
    }
}
