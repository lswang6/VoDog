import SwiftUI

// VoDog 通讯录 (spec S54, owner C2). Server-owned contacts; behaviour follows iOS S32:
// 404 = deleted elsewhere, 409/428 version conflict = keep draft locked until the user discards or
// loads the latest version into it, never auto-retry; destructive actions confirm first.

enum VoDogContactsUI {
    static func errorText(_ error: Error, file: String = #fileID, site: String = #function) -> String {
        VoDogErrorText.shown(text(for: error), error: error, file: file, site: site)
    }

    private static func text(for error: Error) -> String {
        if let api = error as? VoDogAPIError {
            if let message = api.message, !message.isEmpty { return L10n.tr("操作失败：%@", message) }
            return L10n.tr("操作失败：%@", "HTTP \(api.status) \(api.code ?? "")")
        }
        return L10n.tr("操作失败：%@", error.localizedDescription)
    }

    static func status(_ error: Error) -> Int? { (error as? VoDogAPIError)?.status }

    static func isVersionConflict(_ error: Error) -> Bool {
        guard let api = error as? VoDogAPIError else { return false }
        return VoDogContactsLogic.isVersionConflict(status: api.status, code: api.code)
    }
}

struct VoDogBlockedBadge: View {
    var body: some View {
        Label(L10n.tr("已屏蔽"), systemImage: "hand.raised.slash.fill")
            .font(.caption.weight(.medium))
            .foregroundStyle(.red)
    }
}

struct VoDogContactsView: View {
    @ObservedObject var account: VoDogAccount

    @State private var sidebarWidth = CommunicationUI.sidebarWidth
    @State private var search = ""
    @State private var contacts: [VoDogContact] = []
    @State private var hasMore = false
    @State private var loading = false
    @State private var listError: String?
    @State private var listGeneration = 0
    @State private var selectedID: String?
    @State private var detail: VoDogContact?
    @State private var detailError: String?
    @State private var notice: String?
    @State private var busy = false
    @State private var editor: EditorTarget?
    @State private var confirmingDelete: VoDogContact?
    @State private var deleteConflict = false
    @State private var blockTarget: VoDogContactPhone?
    @State private var unblockTarget: VoDogContactPhone?
    @State private var addingPhone = false
    @State private var newPhone = VoDogContactDraft.Line()

    struct EditorTarget: Identifiable {
        let id = UUID()
        let contact: VoDogContact?
    }

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            sidebar.communicationSidebarColumnStyle()
        } detail: {
            detailPane.communicationDetailColumnStyle()
        }
        .task(id: search) {
            if !search.isEmpty {
                do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            }
            await loadList(reset: true)
        }
        .onChange(of: selectedID) { _, _ in Task { await loadDetail() } }
        .sheet(item: $editor) { target in
            VoDogContactEditor(account: account, original: target.contact) { saved in
                selectedID = saved.id
                detail = saved
                Task { await loadList(reset: true) }
            } onDeleted: {
                removeLocally(target.contact?.id)
            }
        }
        .confirmationDialog(
            L10n.tr("删除这个联系人？"),
            isPresented: Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } }),
            titleVisibility: .visible,
            presenting: confirmingDelete
        ) { contact in
            Button(L10n.tr("删除"), role: .destructive) { Task { await delete(contact) } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: { _ in
            Text(L10n.tr("删除后，通话和短信记录里不再显示这个名字。已有的屏蔽设置不受影响。"))
        }
        .alert(L10n.tr("联系人版本已变化"), isPresented: $deleteConflict) {
            Button(L10n.tr("刷新")) { Task { await loadDetail() } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: {
            Text(L10n.tr("联系人已在其他客户端更新，未执行删除。请刷新后核对最新版本。"))
        }
        .confirmationDialog(
            L10n.tr("屏蔽这个号码？"),
            isPresented: Binding(get: { blockTarget != nil }, set: { if !$0 { blockTarget = nil } }),
            titleVisibility: .visible,
            presenting: blockTarget
        ) { phone in
            Button(L10n.tr("屏蔽"), role: .destructive) { Task { await block(phone) } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: { phone in
            Text(L10n.tr("屏蔽后，%@ 的来电会被直接挂断。", phone.displayNumber))
        }
        .confirmationDialog(
            L10n.tr("解除屏蔽这个号码？"),
            isPresented: Binding(get: { unblockTarget != nil }, set: { if !$0 { unblockTarget = nil } }),
            titleVisibility: .visible,
            presenting: unblockTarget
        ) { phone in
            Button(L10n.tr("解除屏蔽")) { Task { await unblock(phone) } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: { phone in
            Text(L10n.tr("解除后，%@ 的来电会恢复正常接收。", phone.displayNumber))
        }
        .sheet(isPresented: $addingPhone) { addPhoneSheet }
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                TextField(L10n.tr("搜索姓名、号码或公司"), text: $search)
                    .communicationSearchField()
                CommunicationIconActionButton(systemImage: "person.badge.plus",
                                              accessibilityLabel: L10n.tr("新建联系人")) {
                    editor = EditorTarget(contact: nil)
                }
            }
            .padding(.horizontal, 12)

            if let listError {
                Label(listError, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red)
                    .padding(.horizontal, 12)
            }

            List(selection: $selectedID) {
                ForEach(contacts) { contact in
                    row(contact).tag(contact.id)
                }
                if hasMore {
                    Button(L10n.tr("加载更多")) { Task { await loadList(reset: false) } }
                        .buttonStyle(.borderless)
                        .disabled(loading)
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .communicationSidebarScrollEdgeEffect()
            .overlay {
                if contacts.isEmpty && !loading && listError == nil {
                    PhoneEmptyState(title: search.isEmpty ? "没有联系人" : "没有匹配的联系人",
                                    detail: "新建的联系人会同步到所有 VoDog 客户端。",
                                    systemImage: "person.crop.circle")
                } else if contacts.isEmpty && loading {
                    ProgressView()
                }
            }
        }
    }

    private func row(_ contact: VoDogContact) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: displayName(contact))
                    .font(.body.weight(.medium)).lineLimit(1)
                Text(verbatim: contact.primaryPhone?.displayNumber ?? contact.emails.first?.address ?? "")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if contact.isBlocked {
                Image(systemName: "hand.raised.slash.fill")
                    .foregroundStyle(.red)
                    .help(L10n.tr("已屏蔽"))
                    .accessibilityLabel(L10n.tr("已屏蔽"))
            }
        }
        .padding(.vertical, 3)
    }

    private func displayName(_ contact: VoDogContact) -> String {
        contact.displayName.isEmpty ? L10n.tr("未命名联系人") : contact.displayName
    }

    // MARK: Detail

    @ViewBuilder
    private var detailPane: some View {
        if let contact = detail, contact.id == selectedID {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header(contact)
                    if let notice {
                        Label(notice, systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.red)
                    }
                    if !contact.phones.isEmpty {
                        section("电话号码") {
                            ForEach(contact.phones) { phone in phoneRow(phone) }
                        }
                    }
                    if !contact.emails.isEmpty {
                        section("电子邮件") {
                            ForEach(contact.emails) { email in
                                labeled(email.label ?? L10n.tr("邮箱"), email.address)
                            }
                        }
                    }
                    if !contact.addresses.isEmpty {
                        section("地址") {
                            ForEach(contact.addresses) { address in
                                labeled(address.label ?? L10n.tr("地址"), address.displayText)
                            }
                        }
                    }
                    if let notes = contact.notes, !notes.isEmpty {
                        section("备注") {
                            Text(verbatim: notes).textSelection(.enabled)
                        }
                    }
                    Button(L10n.tr("删除联系人"), role: .destructive) { confirmingDelete = contact }
                        .buttonStyle(.borderless)
                        .disabled(busy)
                }
                .padding(28)
                .frame(maxWidth: 620, alignment: .leading)
            }
        } else if let detailError {
            PhoneEmptyState(title: "无法显示联系人", detail: detailError, systemImage: "person.crop.circle.badge.exclamationmark")
        } else if selectedID != nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            PhoneEmptyState(title: "选择一个联系人", detail: "联系人详情会显示在这里。", systemImage: "person.crop.circle")
        }
    }

    private func header(_ contact: VoDogContact) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 16) {
                ZStack {
                    Circle().fill(.quaternary)
                    Image(systemName: "person.fill")
                        .font(.system(size: 30, weight: .medium)).foregroundStyle(.secondary)
                }
                .frame(width: 78, height: 78)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: displayName(contact)).font(.largeTitle.weight(.semibold)).lineLimit(2)
                    if let organization = contact.organization, !organization.isEmpty {
                        Text(verbatim: organization).foregroundStyle(.secondary)
                    }
                    if contact.isBlocked { VoDogBlockedBadge() }
                }
                Spacer()
            }
            HStack(spacing: 10) {
                Button { editor = EditorTarget(contact: contact) } label: {
                    Label(L10n.tr("编辑"), systemImage: "pencil")
                }
                .adaptiveGlassButton()
                Button {
                    newPhone = VoDogContactDraft.Line()
                    addingPhone = true
                } label: {
                    Label(L10n.tr("添加号码"), systemImage: "plus")
                }
                .adaptiveGlassButton()
            }
            .disabled(busy)
        }
    }

    private func phoneRow(_ phone: VoDogContactPhone) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: phone.label?.isEmpty == false ? phone.label! : L10n.tr("电话"))
                    .font(.caption).foregroundStyle(.secondary)
                Text(verbatim: phone.displayNumber)
                    .font(.body.monospacedDigit()).textSelection(.enabled)
            }
            if phone.isBlocked { VoDogBlockedBadge() }
            Spacer()
            if phone.isBlocked {
                Button(L10n.tr("解除屏蔽")) { unblockTarget = phone }
                    .buttonStyle(.borderless)
            } else if VoDogContactsLogic.canBlock(phone.rawNumber) {
                Button(L10n.tr("屏蔽")) { blockTarget = phone }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.red)
            }
        }
        .disabled(busy)
        .padding(.vertical, 4)
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: label).font(.caption).foregroundStyle(.secondary)
            Text(verbatim: value).textSelection(.enabled)
        }
        .padding(.vertical, 3)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n.tr(title)).font(.headline)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .adaptiveGlassSurface(cornerRadius: 18, treatment: .clear)
    }

    private var addPhoneSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.tr("添加号码")).font(.headline)
            TextField(L10n.tr("号码"), text: $newPhone.value).textFieldStyle(.roundedBorder)
            TextField(L10n.tr("标签（可留空）"), text: $newPhone.label).textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button(L10n.tr("取消"), role: .cancel) { addingPhone = false }
                    .keyboardShortcut(.cancelAction)
                Button(L10n.tr("添加")) {
                    addingPhone = false
                    Task { await addPhone() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(VoDogContactDraft.phoneNumber(newPhone.value) == nil)
            }
        }
        .padding(20)
        .frame(width: 340)
    }

    // MARK: Actions

    private func loadList(reset: Bool) async {
        let query = search
        listGeneration += 1
        let generation = listGeneration
        loading = true
        defer { if generation == listGeneration { loading = false } }
        do {
            let object = try await account.json("GET", "/contacts",
                query: VoDogContactsLogic.contactsQuery(search: query, offset: reset ? 0 : contacts.count))
            let page = try VoDogContactsLogic.decode(VoDogPage<VoDogContact>.self, from: object)
            guard generation == listGeneration, query == search else { return }
            contacts = reset ? page.items : contacts + page.items.filter { item in !contacts.contains { $0.id == item.id } }
            hasMore = page.items.count >= VoDogContactsLogic.contactsPageSize
            listError = nil
            if selectedID == nil || !contacts.contains(where: { $0.id == selectedID }) && reset {
                selectedID = contacts.first?.id
            }
        } catch is CancellationError {
            return
        } catch {
            guard generation == listGeneration else { return }
            listError = VoDogContactsUI.errorText(error)
        }
    }

    private func loadDetail() async {
        guard let id = selectedID else { detail = nil; return }
        detailError = nil
        do {
            let object = try await account.json("GET", "/contacts/\(id)")
            guard let item = object["item"] else { return }
            let contact = try VoDogContactsLogic.decode(VoDogContact.self, from: item)
            guard selectedID == id else { return }
            detail = contact
            if let index = contacts.firstIndex(where: { $0.id == id }) { contacts[index] = contact }
        } catch is CancellationError {
            return
        } catch {
            guard selectedID == id else { return }
            if VoDogContactsUI.status(error) == 404 {
                removeLocally(id)
                notice = nil
                detailError = VoDogErrorText.shown(L10n.tr("这个联系人已在其他客户端删除。"), error: error)
            } else if detail?.id == id {
                notice = VoDogContactsUI.errorText(error)
            } else {
                detailError = VoDogContactsUI.errorText(error)
            }
        }
    }

    private func removeLocally(_ id: String?) {
        guard let id else { return }
        contacts.removeAll { $0.id == id }
        if detail?.id == id { detail = nil }
        // Clear rather than jump to a neighbour, so a "deleted elsewhere" message stays visible.
        if selectedID == id { selectedID = nil }
    }

    private func delete(_ contact: VoDogContact) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await account.json("DELETE", "/contacts/\(contact.id)",
                                       query: ["expectedVersion": String(contact.version)])
            removeLocally(contact.id)
        } catch where VoDogContactsUI.status(error) == 404 {
            removeLocally(contact.id)
        } catch where VoDogContactsUI.isVersionConflict(error) {
            VoDogErrorText.shown(L10n.tr("联系人版本已变化"), error: error)
            deleteConflict = true
        } catch is CancellationError {
            return
        } catch {
            notice = VoDogContactsUI.errorText(error)
        }
    }

    private func addPhone() async {
        guard let contact = detail, let number = VoDogContactDraft.phoneNumber(newPhone.value) else { return }
        busy = true
        defer { busy = false }
        var body: [String: Any] = ["rawNumber": number]
        if let label = VoDogContactDraft.trimmed(newPhone.label) { body["label"] = label }
        do {
            let object = try await account.json("POST", "/contacts/\(contact.id)/phones", body: body)
            if let item = object["item"] {
                let updated = try VoDogContactsLogic.decode(VoDogContact.self, from: item)
                detail = updated
                if let index = contacts.firstIndex(where: { $0.id == updated.id }) { contacts[index] = updated }
            }
            notice = nil
        } catch where VoDogContactsUI.status(error) == 404 {
            removeLocally(contact.id)
            detailError = VoDogErrorText.shown(L10n.tr("这个联系人已在其他客户端删除。"), error: error)
        } catch where VoDogContactsUI.status(error) == 400 {
            notice = VoDogErrorText.shown(L10n.tr("号码无效，请检查后重试。"), error: error)
        } catch is CancellationError {
            return
        } catch {
            notice = VoDogContactsUI.errorText(error)
        }
    }

    private func block(_ phone: VoDogContactPhone) async {
        guard VoDogContactsLogic.canBlock(phone.rawNumber) else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await account.json("POST", "/blocklist", body: ["remoteNumber": phone.rawNumber, "scope": "call"])
            notice = nil
        } catch where VoDogContactsUI.status(error) == 400 {
            notice = VoDogErrorText.shown(L10n.tr("这个号码不能屏蔽。"), error: error)
        } catch is CancellationError {
            return
        } catch {
            notice = VoDogContactsUI.errorText(error)
        }
        await loadDetail()
    }

    private func unblock(_ phone: VoDogContactPhone) async {
        busy = true
        defer { busy = false }
        do {
            var entryID = phone.blockedEntryId
            if entryID == nil {
                let object = try await account.json("GET", "/blocklist", query: ["scope": "call"])
                let list = try VoDogContactsLogic.decode(VoDogPage<VoDogBlockedNumber>.self, from: object)
                entryID = VoDogContactsLogic.blockedEntryID(for: phone.rawNumber, in: list.items)
            }
            if let entryID {
                do {
                    _ = try await account.json("DELETE", "/blocklist/\(entryID)")
                } catch where VoDogContactsUI.status(error) == 404 {
                    // Already removed elsewhere; the refresh below shows the real state.
                }
                notice = nil
            } else {
                notice = VoDogErrorText.shown(L10n.tr("屏蔽名单里没有找到这个号码，请刷新后再试。"))
            }
        } catch is CancellationError {
            return
        } catch {
            notice = VoDogContactsUI.errorText(error)
        }
        await loadDetail()
    }
}

// MARK: - Editor

private struct VoDogContactEditor: View {
    @ObservedObject var account: VoDogAccount
    let original: VoDogContact?
    let onSaved: (VoDogContact) -> Void
    let onDeleted: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: VoDogContactDraft
    @State private var expectedVersion: Int?
    @State private var saving = false
    @State private var error: String?
    /// Stays locked after a conflict until the latest version is loaded; dismissing the alert keeps it.
    @State private var conflictLocked = false
    @State private var showingConflict = false

    init(account: VoDogAccount, original: VoDogContact?,
         onSaved: @escaping (VoDogContact) -> Void, onDeleted: @escaping () -> Void) {
        self.account = account
        self.original = original
        self.onSaved = onSaved
        self.onDeleted = onDeleted
        _draft = State(initialValue: original.map(VoDogContactDraft.init) ?? VoDogContactDraft())
        _expectedVersion = State(initialValue: original?.version)
    }

    var body: some View {
        VStack(spacing: 0) {
            Text(L10n.tr(original == nil ? "新建联系人" : "编辑联系人"))
                .font(.headline)
                .padding(.top, 16)
            Form {
                Section(L10n.tr("姓名")) {
                    TextField(L10n.tr("显示名称"), text: $draft.displayName)
                    TextField(L10n.tr("名"), text: $draft.givenName)
                    TextField(L10n.tr("姓"), text: $draft.familyName)
                    TextField(L10n.tr("公司"), text: $draft.organization)
                }
                Section(L10n.tr("电话")) {
                    ForEach($draft.phones) { $line in
                        lineRow(value: $line.value, label: $line.label, placeholder: "号码") {
                            draft.phones.removeAll { $0.id == line.id }
                        }
                    }
                    Button(L10n.tr("添加号码"), systemImage: "plus.circle") {
                        draft.phones.append(.init())
                    }
                    .buttonStyle(.borderless)
                }
                Section(L10n.tr("邮箱")) {
                    ForEach($draft.emails) { $line in
                        lineRow(value: $line.value, label: $line.label, placeholder: "邮箱地址") {
                            draft.emails.removeAll { $0.id == line.id }
                        }
                    }
                    Button(L10n.tr("添加邮箱"), systemImage: "plus.circle") {
                        draft.emails.append(.init())
                    }
                    .buttonStyle(.borderless)
                }
                if !draft.addresses.isEmpty {
                    Section(L10n.tr("地址")) {
                        ForEach(draft.addresses) { address in
                            Text(verbatim: address.displayText).foregroundStyle(.secondary)
                        }
                        Text(L10n.tr("地址会原样保留，可在 iPhone 上编辑。"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section(L10n.tr("备注")) {
                    TextField(L10n.tr("备注"), text: $draft.notes, axis: .vertical)
                        .lineLimit(2...6)
                }
                if !draft.isValid {
                    Text(L10n.tr("需要填写显示名称，并至少填写一个号码或邮箱。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.red)
                }
                if conflictLocked {
                    Section(L10n.tr("版本冲突")) {
                        Text(L10n.tr("保存仍处于锁定状态；载入成功后请重新检查内容，再保存。"))
                            .font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button(L10n.tr("放弃修改")) { dismiss() }
                            Button(L10n.tr("载入最新内容（替换当前草稿）")) { Task { await loadLatest() } }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .disabled(saving)

            HStack {
                if saving { ProgressView().controlSize(.small) }
                Spacer()
                Button(L10n.tr("取消"), role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(L10n.tr("保存")) { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!draft.isValid || saving || conflictLocked)
            }
            .padding(16)
        }
        .frame(minWidth: 460, idealWidth: 500, minHeight: 520, idealHeight: 640)
        .alert(L10n.tr("联系人已更新"), isPresented: $showingConflict) {
            Button(L10n.tr("载入最新内容（替换当前草稿）")) { Task { await loadLatest() } }
            Button(L10n.tr("放弃修改"), role: .destructive) { dismiss() }
            Button(L10n.tr("保留草稿"), role: .cancel) {}
        } message: {
            Text(L10n.tr("联系人已在其他客户端更新。当前草稿已保留；只有明确载入最新内容后，才能核对并再次保存。"))
        }
    }

    private func lineRow(value: Binding<String>, label: Binding<String>, placeholder: String,
                         remove: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            TextField(L10n.tr(placeholder), text: value)
            TextField(L10n.tr("标签（可留空）"), text: label)
                .frame(width: 120)
            Button(action: remove) { Image(systemName: "minus.circle.fill").foregroundStyle(.red) }
                .buttonStyle(.borderless)
                .accessibilityLabel(L10n.tr("移除"))
        }
    }

    private func save() async {
        guard draft.isValid, !conflictLocked else { return }
        saving = true
        defer { saving = false }
        do {
            let object: [String: Any]
            if let original {
                object = try await account.json("PUT", "/contacts/\(original.id)",
                                                body: draft.body(expectedVersion: expectedVersion ?? original.version))
            } else {
                object = try await account.json("POST", "/contacts", body: draft.body(expectedVersion: nil),
                                                idempotent: true)
            }
            guard let item = object["item"] else { dismiss(); return }
            onSaved(try VoDogContactsLogic.decode(VoDogContact.self, from: item))
            dismiss()
        } catch where VoDogContactsUI.isVersionConflict(error) {
            conflictLocked = true
            VoDogErrorText.shown(L10n.tr("联系人已更新"), error: error)
            showingConflict = true
            self.error = nil
        } catch where original != nil && VoDogContactsUI.status(error) == 404 {
            onDeleted()
            self.error = VoDogErrorText.shown(L10n.tr("这个联系人已在其他客户端删除，请取消编辑。"), error: error)
        } catch is CancellationError {
            return
        } catch {
            self.error = VoDogContactsUI.errorText(error)
        }
    }

    private func loadLatest() async {
        guard let original else { return }
        saving = true
        defer { saving = false }
        do {
            let object = try await account.json("GET", "/contacts/\(original.id)")
            guard let item = object["item"] else { return }
            let latest = try VoDogContactsLogic.decode(VoDogContact.self, from: item)
            draft = VoDogContactDraft(latest)
            expectedVersion = latest.version
            conflictLocked = false
            error = nil
        } catch where VoDogContactsUI.status(error) == 404 {
            onDeleted()
            self.error = VoDogErrorText.shown(L10n.tr("这个联系人已在其他客户端删除，请取消编辑。"), error: error)
        } catch is CancellationError {
            return
        } catch {
            self.error = VoDogContactsUI.errorText(error)
        }
    }
}
