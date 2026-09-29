import AppKit
@preconcurrency import Contacts
import Foundation

struct ContactPhoneNumber: Identifiable, Codable, Hashable {
    var id = UUID()
    var label: String
    var value: String
}

struct ContactEmailAddress: Identifiable, Codable, Hashable {
    var id = UUID()
    var label: String
    var value: String
}

struct SystemContactRecord: Identifiable, Hashable {
    let id: String
    var formattedName: String
    var nickname: String
    var givenName: String
    var familyName: String
    var organizationName: String
    var phoneNumbers: [ContactPhoneNumber]
    var emailAddresses: [ContactEmailAddress]
    var groupIDs: Set<String>

    var displayName: String {
        if !formattedName.isEmpty { return formattedName }
        if !nickname.isEmpty { return nickname }
        let components = [familyName, givenName].filter { !$0.isEmpty }
        if !components.isEmpty { return components.joined() }
        if !organizationName.isEmpty { return organizationName }
        return phoneNumbers.first?.value ?? L10n.tr("未命名联系人")
    }

    var primaryPhoneNumber: String? {
        phoneNumbers.first?.value
    }
}

struct SystemContactGroup: Identifiable, Hashable {
    let id: String
    let name: String
}

struct SystemContactDraft: Equatable {
    var id: String?
    var givenName: String
    var familyName: String
    var organizationName: String
    var phoneNumbers: [ContactPhoneNumber]
    var emailAddresses: [ContactEmailAddress]
    var groupIDs: Set<String>

    init(contact: SystemContactRecord? = nil) {
        id = contact?.id
        givenName = contact?.givenName ?? ""
        familyName = contact?.familyName ?? ""
        organizationName = contact?.organizationName ?? ""
        phoneNumbers = contact?.phoneNumbers ?? [
            ContactPhoneNumber(label: L10n.tr("手机"), value: "")
        ]
        emailAddresses = contact?.emailAddresses ?? []
        groupIDs = contact?.groupIDs ?? []
    }

    var hasIdentity: Bool {
        !givenName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !familyName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !organizationName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            phoneNumbers.contains { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
}

@MainActor
final class SystemContactStore: ObservableObject {
    enum AuthorizationState: Equatable {
        case notDetermined
        case authorized
        case denied
        case restricted

        var canReadContacts: Bool {
            self == .authorized
        }
    }

    static let shared = SystemContactStore()

    @Published private(set) var authorizationState: AuthorizationState
    @Published private(set) var contacts: [SystemContactRecord] = []
    @Published private(set) var groups: [SystemContactGroup] = []
    @Published private(set) var isLoading = false
    @Published private(set) var lastError: String?
    @Published private(set) var resolutionRevision: UInt64 = 0

    private let store = CNContactStore()
    private var displayNameByNumber: [String: String] = [:]
    private var pendingNumberLookups: Set<String> = []
    private var completedNumberLookups: Set<String> = []
    private var contactStoreChangeObserver: NSObjectProtocol?
    private var reloadDebounceTask: Task<Void, Never>?
    private var reloadPending = false

    private init() {
        authorizationState = Self.authorizationState(
            from: CNContactStore.authorizationStatus(for: .contacts)
        )
        contactStoreChangeObserver = NotificationCenter.default.addObserver(
            forName: .CNContactStoreDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.scheduleReload()
            }
        }
        if authorizationState.canReadContacts {
            reload()
        }
    }

    deinit {
        reloadDebounceTask?.cancel()
        if let contactStoreChangeObserver {
            NotificationCenter.default.removeObserver(contactStoreChangeObserver)
        }
    }

    func requestAccess() {
        guard authorizationState == .notDetermined else {
            if authorizationState.canReadContacts { reload() }
            return
        }
        store.requestAccess(for: .contacts) { [weak self] granted, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.authorizationState = Self.authorizationState(
                    from: CNContactStore.authorizationStatus(for: .contacts)
                )
                self.lastError = error?.localizedDescription
                if granted, self.authorizationState.canReadContacts {
                    self.reload()
                }
            }
        }
    }

    func reload() {
        authorizationState = Self.authorizationState(
            from: CNContactStore.authorizationStatus(for: .contacts)
        )
        guard authorizationState.canReadContacts else {
            contacts = []
            groups = []
            displayNameByNumber = [:]
            pendingNumberLookups = []
            completedNumberLookups = []
            return
        }
        guard !isLoading else {
            reloadPending = true
            return
        }
        isLoading = true
        lastError = nil

        let contactStore = store
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let groups = try contactStore.groups(matching: nil)
                var memberships: [String: Set<String>] = [:]
                for group in groups {
                    let predicate = CNContact.predicateForContactsInGroup(withIdentifier: group.identifier)
                    let members = try contactStore.unifiedContacts(
                        matching: predicate,
                        keysToFetch: [CNContactIdentifierKey as CNKeyDescriptor]
                    )
                    for member in members {
                        memberships[member.identifier, default: []].insert(group.identifier)
                    }
                }

                var records: [SystemContactRecord] = []
                let request = CNContactFetchRequest(keysToFetch: Self.contactKeys)
                request.sortOrder = .userDefault
                request.unifyResults = true
                try contactStore.enumerateContacts(with: request) { contact, _ in
                    records.append(Self.record(from: contact, groupIDs: memberships[contact.identifier] ?? []))
                }

                DispatchQueue.main.async {
                    guard let self else { return }
                    let sortedRecords = records.sorted {
                        $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
                    }
                    self.contacts = sortedRecords
                    self.displayNameByNumber = Self.makeDisplayNameIndex(
                        from: sortedRecords
                    )
                    self.pendingNumberLookups = []
                    self.completedNumberLookups = []
                    self.groups = groups
                        .map { SystemContactGroup(id: $0.identifier, name: $0.name) }
                        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                    self.isLoading = false
                    self.performPendingReloadIfNeeded()
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.lastError = error.localizedDescription
                    self.isLoading = false
                    self.performPendingReloadIfNeeded()
                }
            }
        }
    }

    func save(_ draft: SystemContactDraft, completion: @escaping (Bool) -> Void) {
        guard authorizationState.canReadContacts, draft.hasIdentity else {
            completion(false)
            return
        }
        isLoading = true
        lastError = nil
        let contactStore = store
        let existingRecord = draft.id.flatMap { id in contacts.first { $0.id == id } }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let mutableContact: CNMutableContact
                if let id = draft.id {
                    let contact = try contactStore.unifiedContact(
                        withIdentifier: id,
                        keysToFetch: Self.contactKeys
                    )
                    guard let copy = contact.mutableCopy() as? CNMutableContact else {
                        throw ContactStoreError.cannotEditContact
                    }
                    mutableContact = copy
                } else {
                    mutableContact = CNMutableContact()
                }

                mutableContact.givenName = draft.givenName.trimmingCharacters(in: .whitespacesAndNewlines)
                mutableContact.familyName = draft.familyName.trimmingCharacters(in: .whitespacesAndNewlines)
                mutableContact.organizationName = draft.organizationName.trimmingCharacters(in: .whitespacesAndNewlines)
                mutableContact.phoneNumbers = draft.phoneNumbers.compactMap { item in
                    let value = item.value.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !value.isEmpty else { return nil }
                    return CNLabeledValue(
                        label: Self.systemPhoneLabel(from: item.label),
                        value: CNPhoneNumber(stringValue: value)
                    )
                }
                mutableContact.emailAddresses = draft.emailAddresses.compactMap { item in
                    let value = item.value.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !value.isEmpty else { return nil }
                    return CNLabeledValue(
                        label: Self.systemEmailLabel(from: item.label),
                        value: value as NSString
                    )
                }

                let request = CNSaveRequest()
                if draft.id == nil {
                    request.add(mutableContact, toContainerWithIdentifier: nil)
                } else {
                    request.update(mutableContact)
                }

                let originalGroupIDs = existingRecord?.groupIDs ?? []
                let allGroupIDs = originalGroupIDs.union(draft.groupIDs)
                let groups = try contactStore.groups(
                    matching: CNGroup.predicateForGroups(withIdentifiers: Array(allGroupIDs))
                )
                for group in groups {
                    if draft.groupIDs.contains(group.identifier),
                       !originalGroupIDs.contains(group.identifier) {
                        request.addMember(mutableContact, to: group)
                    } else if originalGroupIDs.contains(group.identifier),
                              !draft.groupIDs.contains(group.identifier) {
                        request.removeMember(mutableContact, from: group)
                    }
                }

                try contactStore.execute(request)
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.isLoading = false
                    self.reload()
                    completion(true)
                }
            } catch {
                DispatchQueue.main.async {
                    self?.lastError = error.localizedDescription
                    self?.isLoading = false
                    completion(false)
                }
            }
        }
    }

    func delete(_ contact: SystemContactRecord, completion: @escaping (Bool) -> Void) {
        guard authorizationState.canReadContacts else {
            completion(false)
            return
        }
        isLoading = true
        lastError = nil
        let contactStore = store
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let existing = try contactStore.unifiedContact(
                    withIdentifier: contact.id,
                    keysToFetch: Self.contactKeys
                )
                guard let mutable = existing.mutableCopy() as? CNMutableContact else {
                    throw ContactStoreError.cannotEditContact
                }
                let request = CNSaveRequest()
                request.delete(mutable)
                try contactStore.execute(request)
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.isLoading = false
                    self.reload()
                    completion(true)
                }
            } catch {
                DispatchQueue.main.async {
                    self?.lastError = error.localizedDescription
                    self?.isLoading = false
                    completion(false)
                }
            }
        }
    }

    func createGroup(named name: String, completion: @escaping (Bool) -> Void) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard authorizationState.canReadContacts, !trimmed.isEmpty else {
            completion(false)
            return
        }
        let contactStore = store
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let group = CNMutableGroup()
                group.name = trimmed
                let request = CNSaveRequest()
                request.add(group, toContainerWithIdentifier: nil)
                try contactStore.execute(request)
                DispatchQueue.main.async {
                    self?.reload()
                    completion(true)
                }
            } catch {
                DispatchQueue.main.async {
                    self?.lastError = error.localizedDescription
                    completion(false)
                }
            }
        }
    }

    func displayName(for phoneNumber: String) -> String? {
        let normalized = Self.normalizedPhoneNumber(phoneNumber)
        guard !normalized.isEmpty else { return nil }
        if let displayName = displayNameByNumber[normalized] {
            return displayName
        }
        scheduleSystemLookup(for: phoneNumber, normalized: normalized)
        return nil
    }

    func openPrivacySettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
        ) else { return }
        NSWorkspace.shared.open(url)
    }

    nonisolated static func normalizedPhoneNumber(_ value: String) -> String {
        PhoneNumberNormalizer.normalized(value)
    }

    // Keep this list limited to fields available under ordinary Contacts
    // authorization. CNContactNoteKey requires a separate restricted
    // entitlement and raises an Objective-C exception when accessed without it.
    nonisolated(unsafe) static let contactKeys: [CNKeyDescriptor] = [
        CNContactIdentifierKey as CNKeyDescriptor,
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactNicknameKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName)
    ]

    private static func authorizationState(from status: CNAuthorizationStatus) -> AuthorizationState {
        switch status {
        case .notDetermined: return .notDetermined
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        @unknown default: return .restricted
        }
    }

    nonisolated private static func record(
        from contact: CNContact,
        groupIDs: Set<String>
    ) -> SystemContactRecord {
        SystemContactRecord(
            id: contact.identifier,
            formattedName: (
                CNContactFormatter.string(from: contact, style: .fullName) ?? ""
            ).trimmingCharacters(in: .whitespacesAndNewlines),
            nickname: contact.nickname.trimmingCharacters(in: .whitespacesAndNewlines),
            givenName: contact.givenName,
            familyName: contact.familyName,
            organizationName: contact.organizationName,
            phoneNumbers: contact.phoneNumbers.map {
                ContactPhoneNumber(
                    label: localizedLabel($0.label, fallback: L10n.tr("电话")),
                    value: $0.value.stringValue
                )
            },
            emailAddresses: contact.emailAddresses.map {
                ContactEmailAddress(
                    label: localizedLabel($0.label, fallback: L10n.tr("电子邮件")),
                    value: $0.value as String
                )
            },
            groupIDs: groupIDs
        )
    }

    nonisolated private static func contactDisplayName(
        from contact: CNContact
    ) -> String? {
        let formattedName = (
            CNContactFormatter.string(from: contact, style: .fullName) ?? ""
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        if !formattedName.isEmpty { return formattedName }

        let nickname = contact.nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        if !nickname.isEmpty { return nickname }

        let organization = contact.organizationName.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        return organization.isEmpty ? nil : organization
    }

    private func scheduleReload() {
        reloadDebounceTask?.cancel()
        reloadDebounceTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: 350_000_000)
            } catch {
                return
            }
            self?.reload()
        }
    }

    private func scheduleSystemLookup(
        for phoneNumber: String,
        normalized: String
    ) {
        guard authorizationState.canReadContacts,
              !pendingNumberLookups.contains(normalized),
              !completedNumberLookups.contains(normalized) else {
            return
        }
        pendingNumberLookups.insert(normalized)

        let contactStore = store
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let displayName: String?
            do {
                let predicate = CNContact.predicateForContacts(
                    matching: CNPhoneNumber(stringValue: phoneNumber)
                )
                let matches = try contactStore.unifiedContacts(
                    matching: predicate,
                    keysToFetch: Self.contactKeys
                )
                displayName = matches.first.flatMap(Self.contactDisplayName)
            } catch {
                displayName = nil
            }

            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingNumberLookups.remove(normalized)
                self.completedNumberLookups.insert(normalized)
                guard let displayName, !displayName.isEmpty else { return }
                self.displayNameByNumber[normalized] = displayName
                self.resolutionRevision &+= 1
            }
        }
    }

    private func performPendingReloadIfNeeded() {
        guard reloadPending else { return }
        reloadPending = false
        reload()
    }

    private static func makeDisplayNameIndex(
        from contacts: [SystemContactRecord]
    ) -> [String: String] {
        var index: [String: String] = [:]
        for contact in contacts {
            for phoneNumber in contact.phoneNumbers {
                let normalized = normalizedPhoneNumber(phoneNumber.value)
                guard !normalized.isEmpty, index[normalized] == nil else { continue }
                index[normalized] = contact.displayName
            }
        }
        return index
    }

    nonisolated private static func localizedLabel(_ label: String?, fallback: String) -> String {
        guard let label else { return fallback }
        return CNLabeledValue<NSString>.localizedString(forLabel: label)
    }

    nonisolated private static func systemPhoneLabel(from label: String) -> String {
        if label == L10n.tr("手机") || label == L10n.tr("移动电话") {
            return CNLabelPhoneNumberMobile
        }
        if label == L10n.tr("住宅") || label == L10n.tr("家庭") {
            return CNLabelHome
        }
        if label == L10n.tr("工作") { return CNLabelWork }
        if label == L10n.tr("主要") { return CNLabelPhoneNumberMain }
        switch label {
        case "手机", "移动电话": return CNLabelPhoneNumberMobile
        case "住宅", "家庭": return CNLabelHome
        case "工作": return CNLabelWork
        case "iPhone": return CNLabelPhoneNumberiPhone
        case "主要": return CNLabelPhoneNumberMain
        default: return label
        }
    }

    nonisolated private static func systemEmailLabel(from label: String) -> String {
        if label == L10n.tr("住宅") || label == L10n.tr("家庭") {
            return CNLabelHome
        }
        if label == L10n.tr("工作") { return CNLabelWork }
        switch label {
        case "住宅", "家庭": return CNLabelHome
        case "工作": return CNLabelWork
        default: return label
        }
    }
}

private enum ContactStoreError: LocalizedError {
    case cannotEditContact

    var errorDescription: String? {
        L10n.tr("无法编辑这个系统联系人。")
    }
}
