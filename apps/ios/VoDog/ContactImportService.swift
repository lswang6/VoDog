import Contacts
import Foundation
import Observation
import UIKit

/// A device contact after it has left the Contacts framework.
///
/// `CNContact` is a reference type and is not `Sendable`, so the store read converts every record to this value
/// before it crosses back to the main actor. It also lets `ContactImportMapping` be unit-tested without granting
/// the test bundle contacts access.
struct DeviceContact: Sendable, Equatable {
    var identifier: String
    var givenName: String = ""
    var familyName: String = ""
    var organizationName: String = ""
    /// `CNContactFormatter` output; it already orders CJK and latin names correctly.
    var formattedName: String?
    var phones: [DeviceLabeledValue] = []
    var emails: [DeviceLabeledValue] = []
    var addresses: [DevicePostalAddress] = []
}

struct DeviceLabeledValue: Sendable, Equatable {
    var label: String?
    var value: String
}

struct DevicePostalAddress: Sendable, Equatable {
    var label: String?
    var formatted: String?
    var street: String?
    var city: String?
    var region: String?
    var postalCode: String?
    var country: String?
}

/// Stored labels stay the English type names imports carry (`mobile`, `home`, ...); only the screen shows Chinese.
/// Same words as the Android client `contactLabelText` (Formatting.kt) — Web `PHONE_LABELS` is a subset and
/// says 寻呼 for pager.
enum ContactLabelDisplay {
    /// Order matters for `stored`: the first key of a shared word (mobile before cell) is the one saved back.
    static let words: [(key: String, text: String)] = [
        ("mobile", "手机"), ("cell", "手机"), ("home", "住宅"), ("work", "工作"), ("main", "主要"),
        ("iphone", "iPhone"), ("work_mobile", "工作手机"), ("work mobile", "工作手机"),
        ("home_fax", "住宅传真"), ("home fax", "住宅传真"), ("work_fax", "工作传真"), ("work fax", "工作传真"),
        ("fax", "传真"), ("pager", "寻呼机"), ("company_main", "公司总机"), ("company main", "公司总机"),
        ("other", "其他"),
    ]

    static func text(_ stored: String?, fallback: String) -> String {
        guard let value = ContactImportMapping.trimmed(stored) else { return fallback }
        return words.first { $0.key == value.lowercased() }?.text ?? value
    }

    /// The editor shows `text`; saving maps a known word back so the stored value does not drift to Chinese.
    static func stored(_ edited: String?) -> String? {
        guard let value = ContactImportMapping.trimmed(edited) else { return nil }
        return words.first { $0.text == value }?.key ?? value
    }
}

/// S21 decision 2: the client formats and uploads, it never decides what is a duplicate. Everything here is
/// presentation-level normalisation — trimming, label decoration, dropping records the server could not use —
/// and the matching/merging stays in Control.
enum ContactImportMapping {
    static let source = "ios"
    /// §A: one import request carries at most 2000 contacts.
    static let maxBatchSize = 2000

    static func trimmed(_ value: String?) -> String? {
        guard let value else { return nil }
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? nil : result
    }

    /// `CNLabelPhoneNumberMobile` is the string `_$!<Mobile>!$_`. The decoration is an implementation detail of
    /// the Contacts framework and must not reach the server; a user's own label passes through unchanged.
    static func normalizedLabel(_ raw: String?) -> String? {
        guard var value = trimmed(raw) else { return nil }
        if value.hasPrefix("_$!<"), value.hasSuffix(">!$_") {
            value = String(value.dropFirst(4).dropLast(4))
        }
        guard let cleaned = trimmed(value) else { return nil }
        return String(cleaned.prefix(32)).lowercased()
    }

    /// Keeps the number as the user typed it — Control parses it with `phoneMatchKeys`, so stripping formatting
    /// here would only lose information. Runs of whitespace collapse, and a value with no digit at all is not a
    /// phone number and is dropped.
    static func normalizedRawNumber(_ raw: String) -> String? {
        let collapsed = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard let value = trimmed(collapsed), value.contains(where: \.isNumber) else { return nil }
        return String(value.prefix(64))
    }

    static func normalizedEmail(_ raw: String) -> String? {
        guard let value = trimmed(raw), value.contains("@") else { return nil }
        return String(value.prefix(254))
    }

    /// The formatter's full name wins; otherwise family+given, the organisation, or — for a nameless entry that
    /// still has a number — the number itself, because `displayName` is required by `POST /contacts`.
    static func displayName(_ contact: DeviceContact) -> String? {
        if let formatted = trimmed(contact.formattedName) { return String(formatted.prefix(200)) }
        let joined = [trimmed(contact.familyName), trimmed(contact.givenName)]
            .compactMap { $0 }.joined(separator: " ")
        if let name = trimmed(joined) { return String(name.prefix(200)) }
        if let organization = trimmed(contact.organizationName) { return String(organization.prefix(200)) }
        if let number = contact.phones.compactMap({ normalizedRawNumber($0.value) }).first { return number }
        return nil
    }

    /// `nil` for a record the server has nothing to store: no usable name, or neither a phone nor an email.
    /// Those are reported separately from the server's own `skipped` so the summary stays honest.
    static func body(for contact: DeviceContact) -> ContactUpsertBody? {
        var seenPhoneKeys = Set<String>()
        var phones: [ContactPhoneBody] = []
        for phone in contact.phones {
            guard let rawNumber = normalizedRawNumber(phone.value) else { continue }
            let key = rawNumber.filter { $0.isNumber || $0 == "+" }
            guard seenPhoneKeys.insert(key).inserted else { continue }
            phones.append(ContactPhoneBody(rawNumber: rawNumber, label: normalizedLabel(phone.label)))
        }
        var seenEmails = Set<String>()
        var emails: [ContactEmailBody] = []
        for email in contact.emails {
            guard let address = normalizedEmail(email.value) else { continue }
            guard seenEmails.insert(address.lowercased()).inserted else { continue }
            emails.append(ContactEmailBody(address: address, label: normalizedLabel(email.label)))
        }
        let addresses = contact.addresses.compactMap { address -> ContactAddressBody? in
            let body = ContactAddressBody(
                formatted: trimmed(address.formatted), label: normalizedLabel(address.label),
                street: trimmed(address.street), city: trimmed(address.city), region: trimmed(address.region),
                postalCode: trimmed(address.postalCode), country: trimmed(address.country)
            )
            let empty = body.formatted == nil && body.street == nil && body.city == nil
                && body.region == nil && body.postalCode == nil && body.country == nil
            return empty ? nil : body
        }
        guard !phones.isEmpty || !emails.isEmpty, let displayName = displayName(contact) else { return nil }
        return ContactUpsertBody(
            sourceContactId: trimmed(contact.identifier),
            displayName: displayName,
            givenName: trimmed(contact.givenName),
            familyName: trimmed(contact.familyName),
            organization: trimmed(contact.organizationName),
            // `notes` stays nil: `CNContactNoteKey` needs the restricted `com.apple.developer.contacts.notes`
            // entitlement, and asking for it without one fails the entire fetch.
            notes: nil,
            phones: phones, emails: emails, addresses: addresses
        )
    }

    static func bodies(for contacts: [DeviceContact]) -> [ContactUpsertBody] {
        contacts.compactMap(body(for:))
    }

    static func batches(_ bodies: [ContactUpsertBody], size: Int = maxBatchSize) -> [[ContactUpsertBody]] {
        guard size > 0, !bodies.isEmpty else { return [] }
        return stride(from: 0, to: bodies.count, by: size).map {
            Array(bodies[$0..<min($0 + size, bodies.count)])
        }
    }
}

enum ContactImportSummary {
    static func text(_ result: ContactImportResult, locallySkipped: Int) -> String {
        var parts = [
            "共 \(result.total) 条",
            "新增 \(result.created)",
            "更新 \(result.updated)",
            "合并 \(result.merged)",
            "跳过 \(result.skipped)",
        ]
        if result.phonesSkipped > 0 { parts.append("号码跳过 \(result.phonesSkipped)") }
        if locallySkipped > 0 { parts.append("本机跳过 \(locallySkipped)") }
        return parts.joined(separator: " · ")
    }

    static func accessDeniedMessage(_ status: CNAuthorizationStatus) -> String? {
        switch status {
        case .denied: "已拒绝通讯录权限。请在「设置 › VoDog › 通讯录」中允许后重试。"
        case .restricted: "本设备的通讯录访问被限制，无法导入。"
        default: nil
        }
    }
}

/// Reads the device address book and uploads it in ≤ 2000-contact batches.
@MainActor @Observable
final class ContactImportService {
    enum Phase: Equatable {
        case idle
        case running(String)
        case done(String)
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var busy = false

    var statusText: String? {
        switch phase {
        case .idle: nil
        case let .running(text), let .done(text), let .failed(text): text
        }
    }

    func reset() { phase = .idle }

    /// `true` when the import wrote something, so the caller can reload its list.
    @discardableResult
    func importDeviceContacts(session: SessionStore) async -> Bool {
        guard !busy, let identity = session.sessionIdentity else { return false }
        busy = true
        defer { busy = false }
        phase = .running("正在请求通讯录权限…")

        if let message = ContactImportSummary.accessDeniedMessage(CNContactStore.authorizationStatus(for: .contacts)) {
            phase = .failed(message)
            return false
        }
        guard await Self.requestAccess() else {
            guard session.isCurrentSession(identity) else { return false }
            phase = .failed(ContactImportSummary.accessDeniedMessage(.denied) ?? "没有通讯录权限")
            return false
        }
        guard session.isCurrentSession(identity) else { return false }

        phase = .running("正在读取本机通讯录…")
        let deviceContacts: [DeviceContact]
        do {
            deviceContacts = try await Task.detached(priority: .userInitiated) {
                try Self.readDeviceContacts()
            }.value
        } catch {
            guard session.isCurrentSession(identity) else { return false }
            phase = .failed("读取本机通讯录失败：\(error.localizedDescription)")
            return false
        }
        guard !Task.isCancelled, session.isCurrentSession(identity) else { return false }

        let bodies = ContactImportMapping.bodies(for: deviceContacts)
        let locallySkipped = deviceContacts.count - bodies.count
        guard !bodies.isEmpty else {
            phase = .done("本机通讯录没有可导入的联系人（需要至少一个电话或邮箱）。")
            return false
        }

        let deviceID = UIDevice.current.identifierForVendor?.uuidString
        let batches = ContactImportMapping.batches(bodies)
        var total = ContactImportResult()
        var uploaded = 0
        for (index, batch) in batches.enumerated() {
            guard session.isCurrentSession(identity) else { return false }
            phase = .running("正在上传第 \(index + 1)/\(batches.count) 批（共 \(bodies.count) 条）…")
            do {
                let result: ContactImportResult = try await session.request(
                    "contacts/import", method: "POST",
                    body: ContactImportRequest(
                        source: ContactImportMapping.source, sourceDeviceId: deviceID, contacts: batch
                    ),
                    timeoutInterval: 120, requiredSessionIdentity: identity
                )
                guard session.isCurrentSession(identity) else { return false }
                total = total + result
                uploaded += batch.count
            } catch SessionLifecycleError.staleSession {
                return false
            } catch {
                guard session.isCurrentSession(identity) else { return false }
                phase = .failed(
                    uploaded == 0
                        ? "导入失败：\(error.localizedDescription)"
                        : "已导入 \(uploaded) 条后失败：\(error.localizedDescription)"
                )
                return uploaded > 0
            }
        }
        guard session.isCurrentSession(identity) else { return false }
        phase = .done(ContactImportSummary.text(total, locallySkipped: locallySkipped))
        return true
    }

    private nonisolated static func requestAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            CNContactStore().requestAccess(for: .contacts) { granted, _ in
                continuation.resume(returning: granted)
            }
        }
    }

    /// Runs off the main actor. Deliberately does not ask for `CNContactNoteKey`: since iOS 13 that key needs
    /// the `com.apple.developer.contacts.notes` entitlement, and requesting it without one makes the whole
    /// enumeration fail rather than just omitting notes.
    private nonisolated static func readDeviceContacts() throws -> [DeviceContact] {
        var keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactPostalAddressesKey as CNKeyDescriptor,
        ]
        keys.append(CNContactFormatter.descriptorForRequiredKeys(for: .fullName))
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.sortOrder = .userDefault
        let formatter = CNPostalAddressFormatter()
        var results: [DeviceContact] = []
        try CNContactStore().enumerateContacts(with: request) { contact, _ in
            results.append(DeviceContact(
                identifier: contact.identifier,
                givenName: contact.givenName,
                familyName: contact.familyName,
                organizationName: contact.organizationName,
                formattedName: CNContactFormatter.string(from: contact, style: .fullName),
                phones: contact.phoneNumbers.map {
                    DeviceLabeledValue(label: $0.label, value: $0.value.stringValue)
                },
                emails: contact.emailAddresses.map {
                    DeviceLabeledValue(label: $0.label, value: $0.value as String)
                },
                addresses: contact.postalAddresses.map { entry in
                    DevicePostalAddress(
                        label: entry.label,
                        formatted: formatter.string(from: entry.value),
                        street: entry.value.street, city: entry.value.city, region: entry.value.state,
                        postalCode: entry.value.postalCode, country: entry.value.country
                    )
                }
            ))
        }
        return results
    }
}
