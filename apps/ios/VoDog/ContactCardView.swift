import SwiftUI

/// What a contact card was opened for. Records, messages, interceptions and the contacts list all produce one,
/// which is why the card itself never needs to know where it came from.
///
/// `token` makes every presentation distinct, so tapping "i" on a second row while the sheet's item binding is
/// still settling re-presents instead of silently reusing the previous card.
struct ContactCardTarget: Identifiable, Equatable, Sendable {
    var rawNumber: String?
    var simId: String?
    var sourceCallId: String?
    var contactId: String?
    var contactName: String?
    var blocked = false
    var blockedEntryId: String?
    /// Set when the caller already holds the whole contact (the contacts list), so the card skips the lookup.
    var contact: Contact?
    var token = UUID()

    var id: String { token.uuidString }
}

extension ContactCardTarget {
    init(call: CallRecord) {
        self.init(
            rawNumber: call.remoteNumber, simId: call.simId, sourceCallId: call.id,
            contactId: call.contactId, contactName: call.contactName,
            blocked: call.isBlocked, blockedEntryId: call.blockedEntryId
        )
    }

    init(message: SMSMessage) {
        self.init(
            rawNumber: message.remoteNumber ?? message.conversationAddress, simId: message.simId,
            contactId: message.contactId, contactName: message.contactName
        )
    }

    /// A call interception exists because the number is on 来电黑名单, so the card opens straight into 解除屏蔽.
    /// S66: the card's 屏蔽 is the call list only, so an SMS interception (短信黑名单) seeds nothing and the card
    /// reads the call list itself.
    init(interception: Interception) {
        self.init(
            rawNumber: interception.remoteNumber, simId: interception.simId,
            contactId: interception.contactId, contactName: interception.contactName,
            blocked: !interception.isSMS, blockedEntryId: interception.isSMS ? nil : interception.blockedEntryId
        )
    }

    init(contact: Contact) {
        let number = contact.primaryPhone?.displayNumber
        let state = ContactBlockState.resolve(
            number: number, contact: contact,
            current: ContactBlockState(blocked: contact.isBlocked, entryID: contact.blockedEntryId)
        )
        self.init(
            rawNumber: number, contactId: contact.id, contactName: contact.displayName,
            blocked: state.blocked, blockedEntryId: state.entryID, contact: contact
        )
    }

    /// §F: the "i" on a 短信 thread. Built from the thread's newest message, with the thread-level contact layered
    /// on top so an older message that predates S21 cannot blank out a known name. S66: the thread's `blocked` is
    /// the SMS list, the card's is the call list, so it is not carried over.
    init?(conversation: MessageConversation) {
        guard let latest = conversation.latest else { return nil }
        var target = ContactCardTarget(message: latest)
        if target.rawNumber?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            target.rawNumber = conversation.replyNumber ?? conversation.displayNumber
        }
        target.simId = conversation.id.simID
        target.contactId = conversation.contactId ?? target.contactId
        target.contactName = conversation.contactName ?? target.contactName
        self = target
    }
}

/// Whether the number a card is about is blocked, and which blocklist row would release it.
///
/// S21 §A addendum: `ContactDto` states this per phone and per contact, and those readings win over the
/// `GET /blocklist` scan. A per-phone reading is only adopted for the phone that actually matches the card's
/// number — a contact with one blocked number and one clean number must not mark both.
struct ContactBlockState: Equatable, Sendable {
    var blocked: Bool
    var entryID: String?

    static func resolve(number: String?, contact: Contact?, current: Self) -> Self {
        guard let contact else { return current }
        if let number, let phone = contact.phones.first(where: {
            PhoneDialKey.matches($0.displayNumber, number) || PhoneDialKey.matches($0.rawNumber, number)
        }), phone.blocked != nil || phone.blockedEntryId != nil {
            // An entry id without an explicit flag still means blocked; a stated `false` wins over a stale row.
            let blocked = phone.blocked ?? (phone.blockedEntryId != nil)
            // A clean number must never carry another number's entry id — releasing it would unblock the wrong line.
            guard blocked else { return Self(blocked: false, entryID: nil) }
            return Self(blocked: true, entryID: phone.blockedEntryId ?? contact.blockedEntryId ?? current.entryID)
        }
        // No per-phone statement: keep what the call/SMS row said about *this* number, and only borrow the
        // contact-level id, which is what the `GET /blocklist` scan would otherwise have had to find.
        if current.blocked, current.entryID == nil, let contactEntry = contact.blockedEntryId {
            return Self(blocked: true, entryID: contactEntry)
        }
        return current
    }
}

enum ContactCardAction: String, CaseIterable, Sendable {
    case call, sms, createContact, addToExisting, block, unblock
}

/// §F: which actions a card offers. Split out from the view so "a matched, blocked number offers 解除屏蔽 and
/// never 新建联系人" is a fact a test can assert.
enum ContactCardActionPolicy {
    static let blockConfirmTitle = "屏蔽此号码？"
    static let blockConfirmMessage = "屏蔽后，该号码的来电会被直接挂断，短信不受影响。"
    static let unblockConfirmTitle = "解除屏蔽？"
    static let unblockConfirmMessage = "解除后，该号码的来电会恢复正常接听。"
    static let missingEntryMessage = "未找到该号码的屏蔽记录，请下拉刷新后重试。"

    /// `canBlock` is `HistoryRowActionPolicy.canBlock` — emergency numbers are never offered.
    static func actions(hasNumber: Bool, hasContact: Bool, blocked: Bool, canBlock: Bool) -> [ContactCardAction] {
        guard hasNumber else { return [] }
        var actions: [ContactCardAction] = [.call, .sms]
        if !hasContact { actions.append(contentsOf: [.createContact, .addToExisting]) }
        if blocked { actions.append(.unblock) }
        else if canBlock { actions.append(.block) }
        return actions
    }

    static func title(_ action: ContactCardAction) -> String {
        switch action {
        case .call: "拨打电话"
        case .sms: "发送短信"
        case .createContact: "新建联系人"
        case .addToExisting: "添加到现有联系人"
        case .block: "屏蔽此号码"
        case .unblock: "解除屏蔽"
        }
    }

    static func symbol(_ action: ContactCardAction) -> String {
        switch action {
        case .call: "phone.fill"
        case .sms: "message.fill"
        case .createContact: "person.crop.circle.badge.plus"
        case .addToExisting: "person.crop.circle.badge.checkmark"
        case .block: "hand.raised.fill"
        case .unblock: "hand.raised.slash.fill"
        }
    }
}

struct ContactCardView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    let target: ContactCardTarget
    /// Lets the presenting list refresh once the card blocked, unblocked or created something.
    var onChanged: () async -> Void = {}

    @State private var contact: Contact?
    @State private var loaded: Bool
    @State private var blocked: Bool
    @State private var blockedEntryId: String?
    @State private var error: String?
    @State private var busy = false
    @State private var confirming: ContactCardAction?
    @State private var creating = false
    @State private var picking = false
    @State private var deletedElsewhere = false
    @State private var refreshGeneration = 0

    init(target: ContactCardTarget, onChanged: @escaping () async -> Void = {}) {
        self.target = target
        self.onChanged = onChanged
        _contact = State(initialValue: target.contact)
        _loaded = State(initialValue: target.contact != nil)
        _blocked = State(initialValue: target.blocked)
        _blockedEntryId = State(initialValue: target.blockedEntryId)
    }

    private var displayNumber: String? {
        guard let raw = target.rawNumber, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return raw
    }
    private var displayName: String? {
        contact?.displayName ?? target.contactName
    }
    private var canBlock: Bool { HistoryRowActionPolicy.canBlock(remoteNumber: displayNumber) }
    private var actions: [ContactCardAction] {
        ContactCardActionPolicy.actions(
            hasNumber: displayNumber != nil, hasContact: contact != nil || target.contactId != nil,
            blocked: blocked, canBlock: canBlock
        )
    }

    var body: some View {
        NavigationStack {
            List {
                Group {
                if availability.reason != nil { Section { NetworkAvailabilityNotice() } }
                Section { header }
                if !actions.isEmpty { Section { primaryActions } }
                if let contact { contactDetail(contact) }
                if !loaded {
                    Section { HStack(spacing: 8) { ProgressView(); Text("正在匹配联系人…") } }
                }
                if !secondaryActions.isEmpty { Section("操作") { ForEach(secondaryActions, id: \.rawValue, content: secondaryRow) } }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(Color.callerDanger)
                            .reportsError(error, screen: "contact_card", site: "card")
                    }
                }
                }
                .listRowBackground(Signal.surface)
            }
            .signalList()
            .navigationTitle("联系人")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            // S67: a card opened for a specific call marks that call seen.
            .task(id: target.sourceCallId) {
                guard let callID = target.sourceCallId else { return }
                await BadgeStore.shared.markCallSeen(callID, simID: target.simId, session: session)
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                await refreshCard()
                while !Task.isCancelled, scenePhase == .active {
                    do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                    await refreshCard()
                }
            }
            .alert("联系人已被删除", isPresented: $deletedElsewhere) {
                Button("关闭") { dismiss() }
            } message: {
                Text("这个联系人已在其他客户端删除，联系人卡片已关闭。")
            }
            .confirmationDialog(
                confirming == .unblock ? ContactCardActionPolicy.unblockConfirmTitle : ContactCardActionPolicy.blockConfirmTitle,
                isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                titleVisibility: .visible
            ) {
                if confirming == .unblock {
                    Button(ContactCardActionPolicy.title(.unblock), role: .destructive) {
                        confirming = nil
                        Task { await unblock() }
                    }
                    .disabled(!availability.canMutate)
                } else {
                    Button(ContactCardActionPolicy.title(.block), role: .destructive) { confirming = nil; Task { await block() } }
                        .disabled(!availability.canMutate)
                }
                Button("取消", role: .cancel) { confirming = nil }
            } message: {
                Text(confirming == .unblock ? ContactCardActionPolicy.unblockConfirmMessage : ContactCardActionPolicy.blockConfirmMessage)
                if let reason = availability.reason { Text(reason) }
            }
            .sheet(isPresented: $creating) {
                ContactEditView(mode: .create(prefillNumber: displayNumber)) { saved in
                    contact = saved
                    applyContactBlockState()
                    loaded = true
                    Task { await onChanged() }
                }
            }
            .sheet(isPresented: $picking) {
                ContactPickerView { chosen in
                    Task { await addNumber(to: chosen) }
                }
            }
        }
    }

    @ViewBuilder private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(displayName ?? displayNumber ?? "未知号码")
                .font(.title2.weight(.semibold))
                .lineLimit(2)
            if displayName != nil, let displayNumber {
                Text(displayNumber).font(.subheadline).monospacedDigit().foregroundStyle(.secondary)
            }
            if let organization = contact?.organization, !organization.isEmpty {
                Text(organization).font(.subheadline).foregroundStyle(.secondary)
            }
            if blocked {
                Label("已屏蔽", systemImage: "hand.raised.slash.fill")
                    .font(.footnote.weight(.medium)).foregroundStyle(Color.callerDanger)
            } else if loaded, contact == nil {
                Text("通讯录中没有这个号码").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// 拨打电话 / 发送短信 sit above everything else: §F makes them the card's reason to exist (user item 2.2).
    @ViewBuilder private var primaryActions: some View {
        HStack(spacing: 12) {
            Button {
                dial()
            } label: {
                Label(ContactCardActionPolicy.title(.call), systemImage: ContactCardActionPolicy.symbol(.call))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(displayNumber == nil || !availability.canDial(on: target.simId ?? SIMSelectionPolicy.preferredID(in: availability.sims, current: nil)))
            .accessibilityIdentifier("contactCard.call")

            Button {
                composeSMS()
            } label: {
                Label(ContactCardActionPolicy.title(.sms), systemImage: ContactCardActionPolicy.symbol(.sms))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(displayNumber == nil)
            .accessibilityIdentifier("contactCard.sms")
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
    }

    private var secondaryActions: [ContactCardAction] {
        actions.filter { $0 != .call && $0 != .sms }
    }

    @ViewBuilder private func secondaryRow(_ action: ContactCardAction) -> some View {
        let changesBlocking = action == .block || action == .unblock
        Button(role: changesBlocking ? .destructive : nil) {
            switch action {
            case .createContact: creating = true
            case .addToExisting: picking = true
            case .block, .unblock: confirming = action
            case .call, .sms: break
            }
        } label: {
            HStack {
                Label(ContactCardActionPolicy.title(action), systemImage: ContactCardActionPolicy.symbol(action))
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                if busy, action == .block || action == .unblock { ProgressView() }
            }
        }
        .disabled(busy || (changesBlocking && !availability.canMutate))
        .foregroundStyle(changesBlocking ? Color.callerDanger : Color.accentColor)
        .accessibilityIdentifier("contactCard.\(action.rawValue)")
    }

    @ViewBuilder private func contactDetail(_ contact: Contact) -> some View {
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
    }

    // MARK: - Actions

    /// S36 C5-b: the same jump 记录 uses — hand the number (and the SIM when the card knows one) to the dialer,
    /// which resolves the SIM, confirms "用 <号码> 拨打 <number>？" and dials.
    private func dial() {
        guard availability.canDial(on: target.simId ?? SIMSelectionPolicy.preferredID(in: availability.sims, current: nil)) else { return }
        guard let number = displayNumber else { return }
        let normalized = PhoneNumberText.normalized(number)
        guard !normalized.isEmpty else { return }
        navigation.tab = .calls
        navigation.pendingDialPrefill = DialPrefillRequest(
            simID: target.simId, remoteNumber: normalized, token: UUID(), confirm: true
        )
        dismiss()
    }

    private func composeSMS() {
        guard let number = displayNumber else { return }
        let normalized = PhoneNumberText.normalized(number)
        guard !normalized.isEmpty else { return }
        navigation.tab = .messages
        navigation.pendingCompose = HistoryComposeRequest(
            simID: target.simId, remoteNumber: normalized, token: UUID()
        )
        dismiss()
    }

    private func refreshCard() async {
        guard !busy else { return }
        refreshGeneration += 1
        let generation = refreshGeneration
        await loadContact(generation: generation)
        await loadBlockState(generation: generation)
    }

    private func loadContact(generation: Int) async {
        guard let identity = session.sessionIdentity else { return }
        do {
            let refreshed: Contact?
            if let contactID = target.contactId ?? contact?.id {
                let response: ContactEnvelope = try await session.request(
                    "contacts/\(contactID)", requiredSessionIdentity: identity
                )
                refreshed = response.item
            } else if let number = displayNumber {
                let response: ContactLookupEnvelope = try await session.request(
                    "contacts/lookup", requiredSessionIdentity: identity,
                    queryItems: [URLQueryItem(name: "number", value: number)]
                )
                refreshed = response.item
            } else {
                loaded = true
                return
            }
            guard !Task.isCancelled, generation == refreshGeneration,
                  session.sessionIdentity == identity, !busy else { return }
            contact = refreshed
            applyContactBlockState()
            loaded = true
        } catch APIError.server(404, _, _) where target.contactId != nil || contact != nil {
            guard !Task.isCancelled, generation == refreshGeneration,
                  session.isCurrentSession(identity) else { return }
            deletedElsewhere = true
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == refreshGeneration,
                  session.isCurrentSession(identity) else { return }
            // A lookup failure must not hide 拨打/短信/屏蔽; it only means the name is unknown.
            loaded = true
        }
    }

    /// Adopts what the loaded `ContactDto` says about this number, so 解除屏蔽 can skip the `GET /blocklist` scan.
    private func applyContactBlockState() {
        let current = contact.map {
            ContactBlockState(blocked: $0.isBlocked, entryID: $0.blockedEntryId)
        } ?? ContactBlockState(blocked: blocked, entryID: blockedEntryId)
        let resolved = ContactBlockState.resolve(
            number: displayNumber, contact: contact,
            current: current
        )
        blocked = resolved.blocked
        blockedEntryId = resolved.entryID
    }

    private func loadBlockState(generation: Int) async {
        guard let number = displayNumber, let identity = session.sessionIdentity else { return }
        do {
            let response: ItemEnvelope<BlocklistItem> = try await session.request(
                "blocklist", requiredSessionIdentity: identity, queryItems: BlocklistScope.call.queryItems
            )
            guard !Task.isCancelled, generation == refreshGeneration,
                  session.sessionIdentity == identity, !busy else { return }
            blockedEntryId = BlocklistEntryLookup.entryID(for: number, in: response.items)
            blocked = blockedEntryId != nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            // Keep the last successful snapshot; the card's contact lookup still refreshes independently.
        }
    }

    private func block() async {
        guard availability.canMutate else { return }
        guard let number = displayNumber, canBlock, !busy,
              let identity = session.sessionIdentity else { return }
        refreshGeneration += 1
        busy = true
        defer { if session.isCurrentSession(identity) { busy = false } }
        do {
            let response: BlocklistItemEnvelope = try await session.request(
                "blocklist", method: "POST",
                body: BlocklistCreateBody(remoteNumber: number, sourceCallId: target.sourceCallId, scope: .call),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            blocked = true
            blockedEntryId = response.item.id
            error = nil
            await onChanged()
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }

    private func unblock() async {
        guard availability.canMutate else { return }
        guard !busy, let identity = session.sessionIdentity else { return }
        refreshGeneration += 1
        busy = true
        defer { if session.isCurrentSession(identity) { busy = false } }
        do {
            var entryID = blockedEntryId
            if entryID == nil, let number = displayNumber {
                let list: ItemEnvelope<BlocklistItem> = try await session.request(
                    "blocklist", requiredSessionIdentity: identity, queryItems: BlocklistScope.call.queryItems
                )
                guard session.isCurrentSession(identity) else { return }
                entryID = BlocklistEntryLookup.entryID(for: number, in: list.items)
            }
            guard let entryID else {
                error = ContactCardActionPolicy.missingEntryMessage
                return
            }
            let _: EmptyResponse = try await session.request(
                "blocklist/\(entryID)", method: "DELETE", requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            blocked = false
            blockedEntryId = nil
            error = nil
            await onChanged()
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }

    private func addNumber(to chosen: Contact) async {
        guard availability.canMutate else { return }
        guard let number = displayNumber, !busy,
              let identity = session.sessionIdentity else { return }
        refreshGeneration += 1
        busy = true
        defer { if session.isCurrentSession(identity) { busy = false } }
        do {
            let response: ContactEnvelope = try await session.request(
                "contacts/\(chosen.id)/phones", method: "POST",
                body: ContactPhoneBody(rawNumber: number, label: "mobile"),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            contact = response.item
            applyContactBlockState()
            loaded = true
            error = nil
            await onChanged()
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }
}

/// "添加到现有联系人": the searchable list the card pushes before it posts the number.
struct ContactPickerView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(\.dismiss) private var dismiss
    let onPick: (Contact) -> Void

    @State private var contacts: [Contact] = []
    @State private var query = ""
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Group {
                NetworkAvailabilityNotice()
                if !loaded {
                    HStack(spacing: 8) { ProgressView(); Text("正在读取通讯录…") }
                } else if contacts.isEmpty {
                    Label(query.isEmpty ? "通讯录还是空的" : "没有匹配的联系人", systemImage: "person.crop.circle")
                        .foregroundStyle(.secondary)
                }
                ForEach(contacts) { contact in
                    Button {
                        onPick(contact)
                        dismiss()
                    } label: {
                        ContactRowLabel(contact: contact)
                    }
                    .buttonStyle(.plain)
                    .disabled(!availability.canMutate)
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(Color.callerDanger)
                        .reportsError(error, screen: "contact_card", site: "picker")
                }
                }
                .listRowBackground(Signal.surface)
            }
            .signalList()
            .navigationTitle("选择联系人")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: Binding(get: { query }, set: { if availability.canMutate { query = $0 } }), prompt: "搜索姓名或号码")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .task(id: query) { await load() }
        }
    }

    private func load() async {
        guard let identity = session.sessionIdentity else { return }
        // The same debounce the dialer uses: one request per pause, not per keystroke.
        if !query.isEmpty {
            do { try await Task.sleep(for: ContactLookupPolicy.debounce) } catch { return }
        }
        do {
            let response: ItemEnvelope<Contact> = try await session.request(
                "contacts", requiredSessionIdentity: identity,
                queryItems: ContactLookupPolicy.listQuery(query: query)
            )
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            contacts = response.items
            error = nil
            loaded = true
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
            loaded = true
        }
    }
}

/// Name + primary number + block badge — the row shape §F asks for, shared by the contacts list and the picker.
struct ContactRowLabel: View {
    let contact: Contact

    var body: some View {
        HStack(spacing: 12) {
            if contact.isBlocked {
                Image(systemName: "hand.raised.slash.fill")
                    .foregroundStyle(Color.callerDanger).frame(width: 22)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(contact.displayName.isEmpty ? "未命名联系人" : contact.displayName)
                    .font(.body.weight(.medium)).lineLimit(1)
                Text(contact.primaryPhone?.displayNumber ?? contact.emails.first?.address ?? "没有号码")
                    .font(.caption).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if contact.phones.count > 1 {
                Text("\(contact.phones.count) 个号码").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(contact.displayName)，\(contact.primaryPhone?.displayNumber ?? "没有号码")\(contact.isBlocked ? "，已屏蔽" : "")"
        )
    }
}

enum ContactLookupPolicy {
    /// Long enough that a full number typed on the dialpad costs one request, short enough to feel immediate.
    static let debounce: Duration = .milliseconds(350)
    /// `phoneMatchKeys` needs something to work with; a 2-digit prefix would match half the address book.
    static let minimumLookupDigits = 3
    static let listLimit = 200

    static func shouldLookup(_ number: String) -> Bool {
        PhoneNumberText.normalized(number).filter(\.isNumber).count >= minimumLookupDigits
    }

    static func listQuery(query: String) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(listLimit))]
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { items.insert(URLQueryItem(name: "query", value: trimmed), at: 0) }
        return items
    }
}
