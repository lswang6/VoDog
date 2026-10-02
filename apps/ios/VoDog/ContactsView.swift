import SwiftUI

/// §F 通讯录 tab: search, list (name + primary number + block badge), "导入本机通讯录", and a detail page that
/// can edit or delete. The server owns matching and de-duplication (S21 decision 2); this screen only presents.
struct ContactsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase
    @State private var contacts: [Contact] = []
    @State private var query = ""
    @State private var loaded = false
    @State private var error: String?
    @State private var importer = ContactImportService()
    @State private var creating = false
    @State private var loadGeneration = 0

    var body: some View {
        NavigationStack {
            List {
                if availability.reason != nil { Section { NetworkAvailabilityNotice() } }
                Section {
                    Button {
                        Task {
                            guard availability.canMutate else { return }
                            if await importer.importDeviceContacts(session: session) { await load() }
                        }
                    } label: {
                        HStack {
                            Label("导入本机通讯录", systemImage: "square.and.arrow.down")
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            if importer.busy { ProgressView() }
                        }
                    }
                    .disabled(importer.busy || !availability.canMutate)
                    .accessibilityIdentifier("contacts.import")
                    if let status = importer.statusText {
                        Text(status)
                            .font(.footnote)
                            .foregroundStyle(importFailed ? Color.callerDanger : .secondary)
                            .accessibilityIdentifier("contacts.importStatus")
                            .reportsError(importFailed ? importer.statusText : nil, screen: "contacts", site: "import")
                    }
                } footer: {
                    Text("姓名、公司、电话、邮箱和地址会上传到服务器用于来电匹配；系统备注字段不会被读取。")
                }
                Section("联系人") {
                    if !loaded {
                        HStack(spacing: 8) { ProgressView(); Text("正在读取通讯录…") }
                    } else if contacts.isEmpty {
                        Label(
                            query.isEmpty ? "通讯录还是空的，可先导入本机通讯录" : "没有匹配的联系人",
                            systemImage: "person.crop.circle"
                        ).foregroundStyle(.secondary)
                    }
                    ForEach(contacts) { contact in
                        NavigationLink {
                            ContactDetailView(contact: contact) { await load() }
                        } label: {
                            ContactRowLabel(contact: contact)
                        }
                    }
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(Color.callerDanger)
                            .reportsError(error, screen: "contacts", site: "list")
                    }
                }
            }
            .navigationTitle("通讯录")
            .toolbarTitleDisplayMode(.inlineLarge)
            .searchable(text: Binding(get: { query }, set: { if availability.canMutate { query = $0 } }), prompt: "搜索姓名或号码")
            .refreshable { await load() }
            .task(id: "\(query):\(navigation.tab):\(scenePhase)") {
                guard navigation.tab == .contacts, scenePhase == .active else { return }
                await load()
                while !Task.isCancelled, navigation.tab == .contacts, scenePhase == .active {
                    do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                    await load(debounced: false)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { creating = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("新建联系人")
                        .accessibilityIdentifier("contacts.new")
                }
            }
            .sheet(isPresented: $creating) {
                ContactEditView(mode: .create(prefillNumber: nil)) { _ in Task { await load() } }
            }
        }
    }

    private var importFailed: Bool {
        if case .failed = importer.phase { return true }
        return false
    }

    private func load(debounced: Bool = true) async {
        let requestedQuery = query
        guard let identity = session.sessionIdentity else { return }
        if debounced, !requestedQuery.isEmpty {
            do { try await Task.sleep(for: ContactLookupPolicy.debounce) } catch { return }
        }
        loadGeneration += 1
        let generation = loadGeneration
        do {
            let response: ItemEnvelope<Contact> = try await session.request(
                "contacts", requiredSessionIdentity: identity,
                queryItems: ContactLookupPolicy.listQuery(query: requestedQuery)
            )
            guard !Task.isCancelled, generation == loadGeneration,
                  query == requestedQuery, session.isCurrentSession(identity) else { return }
            contacts = response.items
            error = nil
            loaded = true
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == loadGeneration,
                  query == requestedQuery, session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
            loaded = true
        }
    }
}

struct ContactDetailView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var contact: Contact
    private let onChanged: () async -> Void
    @State private var editing = false
    @State private var card: ContactCardTarget?
    @State private var confirmingDelete = false
    @State private var pendingDeleteVersion: Int?
    @State private var error: String?
    @State private var busy = false
    @State private var deletingLocally = false
    @State private var deletedElsewhere = false
    @State private var showingDeleteConflict = false
    @State private var detailGeneration = 0

    init(contact: Contact, onChanged: @escaping () async -> Void = {}) {
        _contact = State(initialValue: contact)
        self.onChanged = onChanged
    }

    private var primaryNumber: String? { contact.primaryPhone?.displayNumber }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 5) {
                    Text(contact.displayName.isEmpty ? "未命名联系人" : contact.displayName)
                        .font(.title3.weight(.semibold))
                    if let organization = contact.organization, !organization.isEmpty {
                        Text(organization).font(.subheadline).foregroundStyle(.secondary)
                    }
                    if contact.isBlocked {
                        Label("已屏蔽", systemImage: "hand.raised.slash.fill")
                            .font(.footnote.weight(.medium)).foregroundStyle(Color.callerDanger)
                    }
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }
            Section { ContactActionRow(number: primaryNumber, simID: nil, navigation: navigation, dismiss: { dismiss() }) { card = ContactCardTarget(contact: contact) } }
            if !contact.phones.isEmpty {
                Section("电话") {
                    ForEach(contact.phones) { phone in
                        LabeledContent(ContactLabelDisplay.text(phone.label, fallback: "电话")) {
                            Text(phone.displayNumber).monospacedDigit().textSelection(.enabled)
                        }
                    }
                }
            }
            if !contact.emails.isEmpty {
                Section("邮箱") {
                    ForEach(contact.emails) { email in
                        LabeledContent(ContactLabelDisplay.text(email.label, fallback: "邮箱")) { Text(email.address).textSelection(.enabled) }
                    }
                }
            }
            if !contact.addresses.isEmpty {
                Section("地址") {
                    ForEach(contact.addresses) { address in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(ContactLabelDisplay.text(address.label, fallback: "地址")).font(.caption).foregroundStyle(.secondary)
                            Text(address.displayText).textSelection(.enabled)
                        }
                    }
                }
            }
            if let notes = contact.notes, !notes.isEmpty {
                Section("备注") { Text(notes).textSelection(.enabled) }
            }
            Section {
                Button("删除联系人", role: .destructive) {
                    pendingDeleteVersion = contact.version
                    confirmingDelete = true
                }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .disabled(busy || !availability.canMutate)
                    .accessibilityIdentifier("contactDetail.delete")
            }
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(Color.callerDanger)
                        .reportsError(error, screen: "contact_detail", site: "detail")
                }
            }
        }
        .navigationTitle("联系人")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑") { editing = true }.accessibilityIdentifier("contactDetail.edit")
            }
        }
        .sheet(isPresented: $editing) {
            ContactEditView(mode: .edit(contact)) { saved in
                contact = saved
                Task { await onChanged() }
            }
        }
        .task(id: "\(navigation.tab):\(scenePhase):\(editing):\(confirmingDelete):\(deletingLocally)") {
            guard navigation.tab == .contacts, scenePhase == .active,
                  !editing, !confirmingDelete, !deletingLocally else { return }
            await loadDetail()
            while !Task.isCancelled, navigation.tab == .contacts, scenePhase == .active,
                  !editing, !confirmingDelete, !deletingLocally {
                do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                await loadDetail()
            }
        }
        .alert("联系人已被删除", isPresented: $deletedElsewhere) {
            Button("返回通讯录") { dismiss() }
        } message: {
            Text("这个联系人已在其他客户端删除，详情已关闭。")
        }
        .reportsError(showingDeleteConflict, message: ContactConcurrencyPolicy.deleteConflictMessage, screen: "contact_detail", site: "delete_conflict")
        .alert("联系人版本已变化", isPresented: $showingDeleteConflict) {
            Button("刷新并查看") { Task { await loadDetail() } }
            Button("取消", role: .cancel) { }
        } message: {
            Text(ContactConcurrencyPolicy.deleteConflictMessage)
        }
        .sheet(item: $card) { target in
            ContactCardView(target: target) { await onChanged() }
        }
        .confirmationDialog("删除这个联系人？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                if let expectedVersion = pendingDeleteVersion {
                    Task { await delete(expectedVersion: expectedVersion) }
                }
                pendingDeleteVersion = nil
            }
            .disabled(!availability.canMutate)
            Button("取消", role: .cancel) { pendingDeleteVersion = nil }
        } message: {
            Text("删除后，通话和短信记录里不再显示这个名字。已有的屏蔽设置不受影响。")
            if let reason = availability.reason { Text(reason) }
        }
    }

    private func delete(expectedVersion: Int) async {
        guard availability.canMutate else { return }
        guard !busy, !deletingLocally, let identity = session.sessionIdentity else { return }
        busy = true
        deletingLocally = true
        deletedElsewhere = false
        detailGeneration += 1
        var didDelete = false
        defer {
            if session.isCurrentSession(identity) {
                busy = false
                if !didDelete { deletingLocally = false }
            }
        }
        do {
            let _: EmptyResponse = try await session.request(
                "contacts/\(contact.id)", method: "DELETE",
                requiredSessionIdentity: identity,
                queryItems: ContactConcurrencyPolicy.deleteQuery(expectedVersion: expectedVersion)
            )
            guard session.isCurrentSession(identity) else { return }
            didDelete = true
            dismiss()
            await onChanged()
        } catch SessionLifecycleError.staleSession {
            return
        } catch where ContactConcurrencyPolicy.isConflict(error) {
            guard session.isCurrentSession(identity) else { return }
            self.error = ContactConcurrencyPolicy.deleteConflictMessage
            showingDeleteConflict = true
        } catch {
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }

    private func loadDetail() async {
        guard !deletingLocally, let identity = session.sessionIdentity else { return }
        let requestedID = contact.id
        detailGeneration += 1
        let generation = detailGeneration
        do {
            let response: ContactEnvelope = try await session.request(
                "contacts/\(requestedID)", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == detailGeneration,
                  session.isCurrentSession(identity), !editing, !confirmingDelete, !deletingLocally,
                  contact.id == requestedID else { return }
            contact = response.item
            error = nil
        } catch APIError.server(404, _, _) {
            guard !Task.isCancelled, generation == detailGeneration,
                  session.isCurrentSession(identity), !deletingLocally else { return }
            deletedElsewhere = true
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == detailGeneration,
                  session.isCurrentSession(identity), !deletingLocally else { return }
            self.error = error.localizedDescription
        }
    }
}

/// 拨打 / 短信 / 信息 — the same three the record detail page shows, so both entry points behave identically.
struct ContactActionRow: View {
    @Environment(UIAvailabilityState.self) private var availability
    let number: String?
    let simID: String?
    let navigation: AppNavigation
    var dismiss: (() -> Void)?
    let onInfo: () -> Void

    private var normalized: String? {
        guard let number else { return nil }
        let value = PhoneNumberText.normalized(number)
        return value.isEmpty ? nil : value
    }

    var body: some View {
        HStack(spacing: 12) {
            Button {
                guard availability.canDial(on: simID ?? SIMSelectionPolicy.preferredID(in: availability.sims, current: nil)), let normalized else { return }
                navigation.tab = .calls
                // S36 C5-b: one request, whether or not this screen knows a SIM. The dialer owns the SIM list,
                // so it resolves the SIM, confirms, and dials — this screen no longer decides.
                navigation.pendingDialPrefill = DialPrefillRequest(
                    simID: simID, remoteNumber: normalized, token: UUID(), confirm: true
                )
                dismiss?()
            } label: {
                Label("拨打", systemImage: "phone.fill").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(normalized == nil || !availability.canDial(on: simID ?? SIMSelectionPolicy.preferredID(in: availability.sims, current: nil)))
            .accessibilityIdentifier("contactActions.call")

            Button {
                guard let normalized else { return }
                navigation.tab = .messages
                navigation.pendingCompose = HistoryComposeRequest(simID: simID, remoteNumber: normalized, token: UUID())
                dismiss?()
            } label: {
                Label("短信", systemImage: "message.fill").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(normalized == nil)
            .accessibilityIdentifier("contactActions.sms")

            Button(action: onInfo) {
                Label("信息", systemImage: "info.circle").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("contactActions.info")
        }
        .labelStyle(.titleAndIcon)
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
    }
}

// MARK: - 编辑

struct ContactEditView: View {
    enum Mode: Equatable {
        case create(prefillNumber: String?)
        case edit(Contact)
    }

    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(\.dismiss) private var dismiss

    let mode: Mode
    let onSaved: (Contact) -> Void

    @State private var displayName: String
    @State private var givenName: String
    @State private var familyName: String
    @State private var organization: String
    @State private var notes: String
    @State private var phones: [EditablePhone]
    @State private var emails: [EditableEmail]
    @State private var addresses: [EditableAddress]
    @State private var saving = false
    @State private var error: String?
    @State private var conflictGate = ContactDraftConflictGate()
    @State private var showingVersionConflict = false
    @State private var observedVersion: Int

    struct EditablePhone: Identifiable, Equatable { let id = UUID(); var label = ""; var rawNumber = "" }
    struct EditableEmail: Identifiable, Equatable { let id = UUID(); var label = ""; var address = "" }
    /// Editing keeps the imported structured parts: `PUT` replaces the whole array, so a row whose text was not
    /// touched is sent back exactly as it arrived instead of collapsing to a single formatted line.
    struct EditableAddress: Identifiable, Equatable {
        let id = UUID()
        var label = ""
        var text = ""
        var original: ContactAddressBody?
        var originalText = ""
    }

    init(mode: Mode, onSaved: @escaping (Contact) -> Void) {
        self.mode = mode
        self.onSaved = onSaved
        switch mode {
        case let .create(prefillNumber):
            _observedVersion = State(initialValue: 1)
            _displayName = State(initialValue: "")
            _givenName = State(initialValue: "")
            _familyName = State(initialValue: "")
            _organization = State(initialValue: "")
            _notes = State(initialValue: "")
            _phones = State(initialValue: [EditablePhone(label: ContactLabelDisplay.text("mobile", fallback: ""), rawNumber: prefillNumber ?? "")])
            _emails = State(initialValue: [])
            _addresses = State(initialValue: [])
        case let .edit(contact):
            _observedVersion = State(initialValue: contact.version)
            _displayName = State(initialValue: contact.displayName)
            _givenName = State(initialValue: contact.givenName ?? "")
            _familyName = State(initialValue: contact.familyName ?? "")
            _organization = State(initialValue: contact.organization ?? "")
            _notes = State(initialValue: contact.notes ?? "")
            _phones = State(initialValue: contact.phones.map {
                EditablePhone(label: ContactLabelDisplay.text($0.label, fallback: ""), rawNumber: $0.rawNumber)
            })
            _emails = State(initialValue: contact.emails.map {
                EditableEmail(label: ContactLabelDisplay.text($0.label, fallback: ""), address: $0.address)
            })
            _addresses = State(initialValue: contact.addresses.map { address in
                let original = ContactAddressBody(
                    formatted: address.formatted, label: address.label, street: address.street,
                    city: address.city, region: address.region, postalCode: address.postalCode,
                    country: address.country
                )
                return EditableAddress(
                    label: ContactLabelDisplay.text(address.label, fallback: ""), text: address.displayText,
                    original: original, originalText: address.displayText
                )
            })
        }
    }

    private var isEditing: Bool { if case .edit = mode { return true }; return false }

    private var body_: ContactUpsertBody {
        ContactUpsertBody(
            expectedVersion: isEditing ? observedVersion : nil,
            displayName: ContactImportMapping.trimmed(displayName) ?? "",
            givenName: ContactImportMapping.trimmed(givenName),
            familyName: ContactImportMapping.trimmed(familyName),
            organization: ContactImportMapping.trimmed(organization),
            notes: ContactImportMapping.trimmed(notes),
            phones: phones.compactMap { phone in
                guard let number = ContactImportMapping.normalizedRawNumber(phone.rawNumber) else { return nil }
                return ContactPhoneBody(rawNumber: number, label: ContactLabelDisplay.stored(phone.label))
            },
            emails: emails.compactMap { email in
                guard let address = ContactImportMapping.normalizedEmail(email.address) else { return nil }
                return ContactEmailBody(address: address, label: ContactLabelDisplay.stored(email.label))
            },
            addresses: addresses.compactMap { entry in
                guard let text = ContactImportMapping.trimmed(entry.text) else { return nil }
                if text == entry.originalText, let original = entry.original { return original }
                return ContactAddressBody(
                    formatted: text, label: ContactLabelDisplay.stored(entry.label),
                    street: nil, city: nil, region: nil, postalCode: nil, country: nil
                )
            }
        )
    }

    private var canSave: Bool {
        let body = body_
        return availability.canMutate && !saving && !conflictGate.isLocked && !body.displayName.isEmpty
            && (!body.phones.isEmpty || !body.emails.isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                if availability.reason != nil { Section { NetworkAvailabilityNotice() } }
                Section("姓名") {
                    TextField("显示名称", text: $displayName).frame(minHeight: 44)
                    TextField("名", text: $givenName).frame(minHeight: 44)
                    TextField("姓", text: $familyName).frame(minHeight: 44)
                    TextField("公司", text: $organization).frame(minHeight: 44)
                }
                Section("电话") {
                    ForEach($phones) { $phone in
                        VStack(spacing: 4) {
                            TextField("号码", text: $phone.rawNumber)
                                .keyboardType(.phonePad).monospacedDigit().frame(minHeight: 44)
                            TextField("标签（可留空）", text: $phone.label)
                                .textInputAutocapitalization(.never).font(.caption).frame(minHeight: 32)
                        }
                    }
                    .onDelete { phones.remove(atOffsets: $0) }
                    Button("添加号码", systemImage: "plus.circle") { phones.append(EditablePhone()) }
                        .frame(minHeight: 44)
                }
                Section("邮箱") {
                    ForEach($emails) { $email in
                        VStack(spacing: 4) {
                            TextField("邮箱地址", text: $email.address)
                                .keyboardType(.emailAddress).textInputAutocapitalization(.never)
                                .autocorrectionDisabled().frame(minHeight: 44)
                            TextField("标签（可留空）", text: $email.label)
                                .textInputAutocapitalization(.never).font(.caption).frame(minHeight: 32)
                        }
                    }
                    .onDelete { emails.remove(atOffsets: $0) }
                    Button("添加邮箱", systemImage: "plus.circle") { emails.append(EditableEmail()) }
                        .frame(minHeight: 44)
                }
                Section("地址") {
                    ForEach($addresses) { $address in
                        VStack(spacing: 4) {
                            TextField("地址", text: $address.text, axis: .vertical)
                                .lineLimit(1...4).frame(minHeight: 44)
                                .accessibilityLabel("地址")
                                .accessibilityIdentifier("contactEdit.address")
                            TextField("标签（可留空）", text: $address.label)
                                .textInputAutocapitalization(.never).font(.caption).frame(minHeight: 32)
                        }
                    }
                    .onDelete { addresses.remove(atOffsets: $0) }
                    Button("添加地址", systemImage: "plus.circle") { addresses.append(EditableAddress()) }
                        .frame(minHeight: 44)
                }
                Section("备注") {
                    TextField("备注", text: $notes, axis: .vertical)
                        .lineLimit(1...6).frame(minHeight: 44)
                        .accessibilityLabel("备注")
                        .accessibilityIdentifier("contactEdit.notes")
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(Color.callerDanger)
                            .reportsError(error, screen: "contact_edit", site: "form")
                    }
                }
                if conflictGate.isLocked {
                    Section {
                        Button("载入最新内容（替换当前草稿）") { Task { await loadLatest() } }
                            .disabled(saving)
                            .accessibilityIdentifier("contactEdit.reloadConflict")
                        Text("保存仍处于锁定状态；载入成功后请重新检查内容，再保存。")
                            .font(.footnote).foregroundStyle(.secondary)
                    } header: {
                        Text("版本冲突")
                    }
                }
            }
            .disabled(saving)
            .navigationTitle(isEditing ? "编辑联系人" : "新建联系人")
            .navigationBarTitleDisplayMode(.inline)
            // 号码 is a `.phonePad` with no return key. One toolbar for the whole sheet rather than one per
            // `ForEach` row, so several phone fields cannot declare several toolbars.
            .keyboardDoneToolbar()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }
                        .disabled(!canSave)
                        .accessibilityIdentifier("contactEdit.save")
                }
            }
            .overlay { if saving { ProgressView().controlSize(.large) } }
            .reportsError(showingVersionConflict, message: ContactConcurrencyPolicy.editConflictMessage, screen: "contact_edit", site: "version_conflict")
            .alert("联系人已更新", isPresented: $showingVersionConflict) {
                Button("载入最新内容（替换当前草稿）") { Task { await loadLatest() } }
                Button("保留草稿", role: .cancel) { }
            } message: {
                Text(ContactConcurrencyPolicy.editConflictMessage)
            }
        }
    }

    private func save() async {
        guard canSave, let identity = session.sessionIdentity else { return }
        saving = true
        defer { if session.isCurrentSession(identity) { saving = false } }
        do {
            let response: ContactEnvelope
            switch mode {
            case .create:
                response = try await session.request(
                    "contacts", method: "POST", body: body_, idempotencyKey: UUID().uuidString,
                    requiredSessionIdentity: identity
                )
            case let .edit(contact):
                response = try await session.request(
                    "contacts/\(contact.id)", method: "PUT", body: body_,
                    requiredSessionIdentity: identity
                )
            }
            guard session.isCurrentSession(identity) else { return }
            onSaved(response.item)
            dismiss()
        } catch SessionLifecycleError.staleSession {
            return
        } catch where ContactConcurrencyPolicy.isConflict(error) {
            guard session.isCurrentSession(identity) else { return }
            self.error = ContactConcurrencyPolicy.editConflictMessage
            conflictGate.recordConflict()
            showingVersionConflict = true
        } catch {
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }

    private func loadLatest() async {
        guard case let .edit(original) = mode,
              let identity = session.sessionIdentity else { return }
        saving = true
        defer { if session.isCurrentSession(identity) { saving = false } }
        do {
            let response: ContactEnvelope = try await session.request(
                "contacts/\(original.id)", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            apply(response.item)
            observedVersion = response.item.version
            conflictGate.acceptFreshVersion()
            error = nil
        } catch APIError.server(404, _, _) {
            guard session.isCurrentSession(identity) else { return }
            error = "联系人已在其他客户端删除，请取消编辑并返回通讯录。"
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }

    private func apply(_ contact: Contact) {
        displayName = contact.displayName
        givenName = contact.givenName ?? ""
        familyName = contact.familyName ?? ""
        organization = contact.organization ?? ""
        notes = contact.notes ?? ""
        phones = contact.phones.map { EditablePhone(label: ContactLabelDisplay.text($0.label, fallback: ""), rawNumber: $0.rawNumber) }
        emails = contact.emails.map { EditableEmail(label: ContactLabelDisplay.text($0.label, fallback: ""), address: $0.address) }
        addresses = contact.addresses.map { address in
            let original = ContactAddressBody(
                formatted: address.formatted, label: address.label, street: address.street,
                city: address.city, region: address.region, postalCode: address.postalCode,
                country: address.country
            )
            return EditableAddress(
                label: ContactLabelDisplay.text(address.label, fallback: ""), text: address.displayText,
                original: original, originalText: address.displayText
            )
        }
    }
}
