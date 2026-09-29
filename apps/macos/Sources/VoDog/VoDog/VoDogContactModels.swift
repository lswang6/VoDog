import Foundation

// VoDog contacts / blocklist / interceptions DTOs and pure rules (spec S54, owner C2).
// Foundation-only so `scripts/run_vodog_contacts_tests.sh` compiles it without the app.
// Mirrors the iOS client (apps/ios/VoDog/Models.swift ContactDto, BlocklistClient, Interception).

struct VoDogContactPhone: Decodable, Identifiable, Equatable {
    let id: String
    let rawNumber: String
    let e164: String?
    let label: String?
    let isPrimary: Bool?
    /// Server annotation per phone (S21 §A addendum); absent on older Controls.
    let blocked: Bool?
    let blockedEntryId: String?

    var displayNumber: String { (e164?.isEmpty == false ? e164 : nil) ?? rawNumber }
    var isBlocked: Bool { blocked == true || blockedEntryId != nil }
}

struct VoDogContactEmail: Decodable, Identifiable, Equatable {
    let id: String
    let address: String
    let label: String?
}

struct VoDogContactAddress: Decodable, Identifiable, Equatable {
    let id: String
    let formatted: String?
    let label: String?
    let street: String?
    let city: String?
    let region: String?
    let postalCode: String?
    let country: String?

    var displayText: String {
        if let formatted, !formatted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return formatted }
        return [country, region, city, street, postalCode]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Verbatim write form. `PUT /contacts/:id` replaces addresses too, so an edit that does not
    /// touch them must send them back unchanged or they are erased.
    var body: [String: Any] {
        var out: [String: Any] = [:]
        for (key, value) in [("formatted", formatted), ("label", label), ("street", street), ("city", city),
                             ("region", region), ("postalCode", postalCode), ("country", country)] {
            if let value { out[key] = value }
        }
        return out
    }
}

struct VoDogContact: Decodable, Identifiable, Equatable {
    let id: String
    let version: Int
    let displayName: String
    let givenName: String?
    let familyName: String?
    let organization: String?
    let notes: String?
    let phones: [VoDogContactPhone]
    let emails: [VoDogContactEmail]
    let addresses: [VoDogContactAddress]
    let blocked: Bool?
    let blockedEntryId: String?

    var isBlocked: Bool { blocked == true || phones.contains(where: \.isBlocked) }
    var primaryPhone: VoDogContactPhone? { phones.first { $0.isPrimary == true } ?? phones.first }

    enum CodingKeys: String, CodingKey {
        case id, version, displayName, givenName, familyName, organization, notes, phones, emails, addresses
        case blocked, blockedEntryId
    }

    /// Tolerant like iOS: pre-S32 rows have no version, partial rows miss child arrays.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        givenName = try c.decodeIfPresent(String.self, forKey: .givenName)
        familyName = try c.decodeIfPresent(String.self, forKey: .familyName)
        organization = try c.decodeIfPresent(String.self, forKey: .organization)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        phones = try c.decodeIfPresent([VoDogContactPhone].self, forKey: .phones) ?? []
        emails = try c.decodeIfPresent([VoDogContactEmail].self, forKey: .emails) ?? []
        addresses = try c.decodeIfPresent([VoDogContactAddress].self, forKey: .addresses) ?? []
        blocked = try c.decodeIfPresent(Bool.self, forKey: .blocked)
        blockedEntryId = try c.decodeIfPresent(String.self, forKey: .blockedEntryId)
    }
}

struct VoDogBlockedNumber: Decodable, Identifiable, Equatable {
    let id: String
    let remoteNumber: String
    let createdAt: String?
    let contactName: String?
    var scope: String? = nil    // S66 "call" | "sms"; absent from pre-S66 Control
}

struct VoDogInterception: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String            // "call" | "sms"
    let simId: String?
    let simLabel: String?
    let gatewayTimeZone: String?
    let remoteNumber: String?
    let contactId: String?
    let contactName: String?
    let occurredAt: String?
    let bodyPreview: String?
    let blockedEntryId: String?
    let source: String?         // "phone" | "gateway" | "control"

    var isSMS: Bool { kind == "sms" }
}

/// `{items, page?, pageSize?, total?, totalPages?}`; paging keys only when `page` was asked for.
struct VoDogPage<T: Decodable>: Decodable {
    let items: [T]
    let page: Int?
    let total: Int?
    let totalPages: Int?
}

/// Editable form state for POST/PUT `/contacts`.
struct VoDogContactDraft: Equatable {
    struct Line: Identifiable, Equatable {
        let id = UUID()
        var label = ""
        var value = ""
    }

    var displayName = ""
    var givenName = ""
    var familyName = ""
    var organization = ""
    var notes = ""
    var phones: [Line] = [Line()]
    var emails: [Line] = []
    /// Carried through untouched (not editable on Mac yet).
    var addresses: [VoDogContactAddress] = []

    init() {}

    init(_ contact: VoDogContact) {
        displayName = contact.displayName
        givenName = contact.givenName ?? ""
        familyName = contact.familyName ?? ""
        organization = contact.organization ?? ""
        notes = contact.notes ?? ""
        phones = contact.phones.map { Line(label: $0.label ?? "", value: $0.rawNumber) }
        emails = contact.emails.map { Line(label: $0.label ?? "", value: $0.address) }
        addresses = contact.addresses
    }

    static func trimmed(_ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// Same rule as iOS `ContactImportMapping.normalizedRawNumber`: keep what was typed, require a digit.
    static func phoneNumber(_ raw: String) -> String? {
        let collapsed = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard let value = trimmed(collapsed), value.contains(where: \.isNumber) else { return nil }
        return String(value.prefix(64))
    }

    static func email(_ raw: String) -> String? {
        guard let value = trimmed(raw), value.contains("@") else { return nil }
        return String(value.prefix(320))
    }

    var validPhones: [[String: Any]] {
        phones.compactMap { line in
            guard let number = Self.phoneNumber(line.value) else { return nil }
            var out: [String: Any] = ["rawNumber": number]
            if let label = Self.trimmed(line.label) { out["label"] = String(label.prefix(60)) }
            return out
        }
    }

    var validEmails: [[String: Any]] {
        emails.compactMap { line in
            guard let address = Self.email(line.value) else { return nil }
            var out: [String: Any] = ["address": address]
            if let label = Self.trimmed(line.label) { out["label"] = String(label.prefix(60)) }
            return out
        }
    }

    /// displayName plus at least one phone or email (server answers 400 otherwise).
    var isValid: Bool {
        Self.trimmed(displayName) != nil && (!validPhones.isEmpty || !validEmails.isEmpty)
    }

    /// Optional keys are omitted, never sent as null.
    func body(expectedVersion: Int?) -> [String: Any] {
        var out: [String: Any] = [
            "displayName": String((Self.trimmed(displayName) ?? "").prefix(200)),
            "phones": validPhones,
            "emails": validEmails,
            "addresses": addresses.map(\.body)
        ]
        if let expectedVersion { out["expectedVersion"] = expectedVersion }
        for (key, value) in [("givenName", givenName), ("familyName", familyName),
                             ("organization", organization), ("notes", notes)] {
            if let text = Self.trimmed(value) { out[key] = text }
        }
        return out
    }
}

enum VoDogContactsLogic {
    static let contactsPageSize = 200
    static let interceptionsPageSize = 50

    /// `[String: Any]` from `VoDogAccount.json` into a Codable DTO.
    static func decode<T: Decodable>(_ type: T.Type, from object: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(type, from: data)
    }

    /// Optimistic-concurrency refusal for contacts. `IDEMPOTENCY_CONFLICT` is not one.
    static func isVersionConflict(status: Int, code: String?) -> Bool {
        (status == 409 && code == "CONTACT_VERSION_CONFLICT") || (status == 428 && code == "CONTACT_VERSION_REQUIRED")
    }

    /// Control refuses 112/911 (`isEmergencyServiceNumber`); the UI never offers blocking them.
    static func isEmergency(_ raw: String) -> Bool {
        let digits = raw.filter(\.isNumber)
        return digits == "112" || digits == "911"
    }

    static func canBlock(_ raw: String?) -> Bool {
        guard let raw, !PhoneNumberNormalizer.normalized(raw).isEmpty else { return false }
        return !isEmergency(raw)
    }

    /// Fallback when the server omitted `blockedEntryId`: find the row in `GET /blocklist`.
    /// Exact normalized match first, then a ≥7-digit suffix match ("+12025550123" vs "2025550123").
    static func blockedEntryID(for number: String, in items: [VoDogBlockedNumber]) -> String? {
        let target = PhoneNumberNormalizer.normalized(number)
        guard !target.isEmpty else { return nil }
        if let exact = items.first(where: { PhoneNumberNormalizer.normalized($0.remoteNumber) == target }) {
            return exact.id
        }
        let targetDigits = target.filter(\.isNumber)
        guard targetDigits.count >= 7 else { return nil }
        return items.first { item in
            let digits = PhoneNumberNormalizer.normalized(item.remoteNumber).filter(\.isNumber)
            return digits.count >= 7 && (digits.hasSuffix(targetDigits) || targetDigits.hasSuffix(digits))
        }?.id
    }

    /// Chinese source key for `L10n.tr`; unknown values print nothing rather than a raw code.
    static func sourceTitleKey(_ source: String?) -> String? {
        switch source {
        case "phone": "手机自动拦截"
        case "gateway": "网关拦截"
        case "control": "服务器拦截"
        default: nil
        }
    }

    static func parseISO(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    /// Interception time in the gateway's zone (fallback Asia/Shanghai, as iOS).
    static func gatewayTime(_ value: String?, timeZone identifier: String?) -> String {
        guard let date = parseISO(value) else { return "—" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = identifier.flatMap(TimeZone.init(identifier:))
            ?? TimeZone(identifier: "Asia/Shanghai") ?? .current
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    static func interceptionsQuery(page: Int, kind: String) -> [String: String] {
        ["page": String(max(1, page)), "pageSize": String(interceptionsPageSize), "kind": kind]
    }

    static func contactsQuery(search: String, offset: Int) -> [String: String] {
        var query = ["limit": String(contactsPageSize), "offset": String(offset)]
        if let text = VoDogContactDraft.trimmed(search) { query["query"] = String(text.prefix(120)) }
        return query
    }
}
