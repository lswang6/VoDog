import SwiftUI

/// S57 VoDog SMS for the signed-in Phone window: `GET /sms` grouped into threads of the selected
/// SIM (iOS `MessageConversation.grouped`); send via `POST /sms/outbound`, several recipients via
/// `POST /sms/batch`, both with an `Idempotency-Key`. A send only claims "queued" until the server says more.
struct VoDogMessagesView: View {
    @ObservedObject var account: VoDogAccount
    @Binding var sidebarWidth: CGFloat
    @AppStorage("VoDogPhone.sim.v1") private var storedSIM = ""
    @State private var messages: [VoDogSMSMessage] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var selectedThread: String?
    @State private var composing = false
    @State private var recipients = ""
    @State private var draft = ""
    @State private var sending = false
    @State private var sendError: String?
    // S66 deletion (iOS MessagesView / ConversationView).
    @State private var pendingThreadDelete: VoDogConversation?
    @State private var pendingThreadBlockDelete: VoDogConversation?
    @State private var threadBusyID: String?
    @State private var blockedThreadDeleteKeys: Set<String> = []
    @State private var actionMessage: String?
    @State private var selecting = false
    @State private var selectedMessageIDs: Set<String> = []
    @State private var confirmingSelectionDelete = false
    @State private var deletingSelection = false
    @State private var searchText = ""

    private struct SMSList: Decodable { var items: [VoDogSMSMessage] }

    /// 通话记录「发短信」留下的号码；短信页读完第一页后打开它的对话，没有就新建。
    @MainActor static var pendingRecipient: String?

    private var selection: Binding<String?> {
        Binding(get: { storedSIM.isEmpty ? nil : storedSIM }, set: { storedSIM = $0 ?? "" })
    }

    private var threads: [VoDogConversation] {
        VoDogPhonePolicy.conversations(messages, simID: selection.wrappedValue)
    }

    private var thread: VoDogConversation? { threads.first { $0.id == selectedThread } }

    /// Client-side filter over the loaded threads only: number, contact name, message bodies.
    private var visibleThreads: [VoDogConversation] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return threads }
        return threads.filter { thread in
            thread.displayNumber.localizedCaseInsensitiveContains(query)
                || (thread.contactName?.localizedCaseInsensitiveContains(query) ?? false)
                || thread.messages.contains { $0.body?.localizedCaseInsensitiveContains(query) ?? false }
        }
    }

    /// S67: incoming ids of the open conversation; re-sent when a new one arrives while it is open.
    private var openIncomingIDs: [String] {
        composing ? [] : thread?.messages.filter { $0.direction == "incoming" }.map(\.id) ?? []
    }

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            sidebar.communicationSidebarColumnStyle()
        } detail: {
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .communicationDetailColumnStyle()
        }
        .task {
            // ponytail: 5 s poll of the latest 100 while the page is on screen; no push on macOS.
            while !Task.isCancelled, account.user != nil {
                await load()
                openPendingRecipient()
                await VoDogPollCadence.sleep()
            }
        }
        .onChange(of: storedSIM) { _, _ in selectedThread = nil }
        .task(id: openIncomingIDs) { await account.badges.markSMSRead(openIncomingIDs) }
        .onChange(of: selectedThread) { _, _ in
            selecting = false
            selectedMessageIDs = []
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(L10n.tr("短信")).font(.headline)
                Spacer(minLength: 6)
                VoDogSIMMenu(account: account, selection: selection)
                Button {
                    composing = true
                    selectedThread = nil
                } label: {
                    Image(systemName: "square.and.pencil").frame(width: 28, height: 28)
                }
                .buttonStyle(.borderless)
                .help(L10n.tr("新短信"))
                .accessibilityLabel(L10n.tr("新短信"))
                .disabled(selection.wrappedValue == nil)
            }
            .signalToolbar()
            TextField(L10n.tr("搜索联系人、号码或短信"), text: $searchText)
                .communicationSearchField()
                .padding(.horizontal, 10)
                .padding(.top, 10)
                .padding(.bottom, 4)
            List {
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if threads.isEmpty {
                    Text(L10n.tr("这个号码还没有短信")).foregroundStyle(.secondary)
                } else if visibleThreads.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                }
                ForEach(visibleThreads) { thread in
                    let selected = selectedThread == thread.id
                    VoDogBadgeReader(store: account.badges) { badges in
                        let unread = thread.hasUnread(excluding: badges.readSMS)
                        // A Button so a cua-driver AX press opens the conversation exactly like a click.
                        Button { open(thread) } label: {
                            HStack(alignment: .center, spacing: 10) {
                                MessageConversationAvatar(title: thread.contactName ?? thread.displayNumber,
                                                          address: thread.displayNumber, size: 36)
                                    .overlay(alignment: .topLeading) {
                                        VoDogUnreadDot(visible: unread).offset(x: -3, y: -1)
                                    }
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(thread.contactName ?? thread.displayNumber)
                                            .font(.body.weight(unread ? .bold : .semibold)).lineLimit(1)
                                        Spacer(minLength: 6)
                                        if let date = CCTime.parseISO(thread.latest?.statusDateString) {
                                            Text(CommunicationUI.listTimestamp(date)).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Text(thread.latest?.body ?? "").font(.callout).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            .padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .communicationSelectionHighlight(selected)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel((unread ? L10n.tr("未读") + "，" : "")
                            + (thread.contactName.map { "\($0)，\(thread.displayNumber)" } ?? thread.displayNumber))
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                    .contextMenu {
                        Button(L10n.tr("删除"), role: .destructive) { pendingThreadDelete = thread }
                        if VoDogContactsLogic.canBlock(thread.blockNumber) {
                            Button(L10n.tr("删除并屏蔽"), role: .destructive) { pendingThreadBlockDelete = thread }
                        }
                    }
                    .disabled(threadBusyID == thread.id)
                    .listRowInsets(CommunicationUI.listRowInsets)
                    .listRowSeparator(.hidden)
                }
                if let actionMessage { VoDogErrorLine(text: actionMessage) }
                if let loadError { VoDogErrorLine(text: loadError) }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .confirmationDialog(L10n.tr("删除这段对话？"),
                                isPresented: Binding(get: { pendingThreadDelete != nil },
                                                     set: { if !$0 { pendingThreadDelete = nil } }),
                                titleVisibility: .visible, presenting: pendingThreadDelete) { thread in
                Button(L10n.tr("删除"), role: .destructive) { Task { await deleteThread(thread, block: false) } }
                Button(L10n.tr("取消"), role: .cancel) {}
            } message: { _ in
                Text(L10n.tr("这段对话里的短信会被彻底删除，无法恢复。"))
            }
        }
        .confirmationDialog(L10n.tr("删除并屏蔽此号码？"),
                            isPresented: Binding(get: { pendingThreadBlockDelete != nil },
                                                 set: { if !$0 { pendingThreadBlockDelete = nil } }),
                            titleVisibility: .visible, presenting: pendingThreadBlockDelete) { thread in
            Button(L10n.tr("删除"), role: .destructive) { Task { await deleteThread(thread, block: true) } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: { _ in
            Text(L10n.tr("这段对话会被彻底删除，之后不再接收这个号码的短信。"))
        }
    }

    /// S67: opening a conversation marks its incoming messages read right away; the `.task(id: openIncomingIDs)`
    /// below repeats it for messages that arrive while it is open (the server skips already-read ids).
    private func open(_ thread: VoDogConversation) {
        selectedThread = thread.id
        composing = false
        let ids = thread.messages.filter { $0.direction == "incoming" }.map(\.id)
        Task { await account.badges.markSMSRead(ids) }
    }

    @ViewBuilder
    private var detail: some View {
        if composing {
            VStack(alignment: .leading, spacing: 12) {
                Text(L10n.tr("新短信")).font(.title2.bold())
                TextField(L10n.tr("收件人（多个号码用逗号分隔）"), text: $recipients).textFieldStyle(.roundedBorder)
                composer
                Spacer()
            }
            .padding(22)
        } else if let thread {
            let chosen = VoDogSMSDeletePolicy.orderedIDs(selectedMessageIDs, in: thread.messages)
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(thread.contactName ?? thread.displayNumber)
                            .font(.headline)
                            .lineLimit(1)
                        Text(verbatim: sourceLine(thread))
                            .font(.caption)
                            .foregroundStyle(Signal.ink3)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if selecting {
                        Text(L10n.tr("已选 %lld 条", Int64(chosen.count))).font(.callout).foregroundStyle(.secondary)
                        Button(L10n.tr("全选")) { selectedMessageIDs = Set(thread.messages.map(\.id)) }
                        Button(L10n.tr("取消")) {
                            selecting = false
                            selectedMessageIDs = []
                        }
                    } else {
                        if VoDogContactsLogic.canBlock(thread.blockNumber) {
                            Button { pendingThreadBlockDelete = thread } label: {
                                Image(systemName: "nosign").frame(width: 28, height: 28)
                            }
                            .buttonStyle(.borderless)
                            .help(L10n.tr("删除并屏蔽"))
                            .accessibilityLabel(L10n.tr("删除并屏蔽"))
                        }
                        Menu {
                            Button(L10n.tr("选择")) { selecting = true }
                                .disabled(thread.messages.isEmpty)
                            Divider()
                            Button(L10n.tr("删除会话"), role: .destructive) { pendingThreadDelete = thread }
                                .accessibilityLabel(L10n.tr("删除会话"))
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .help(L10n.tr("更多"))
                        .accessibilityLabel(L10n.tr("更多"))
                    }
                }
                .disabled(threadBusyID == thread.id)
                .padding(.horizontal, 6)
                .signalToolbar()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(thread.messages) { message in
                                selectableBubble(message).id(message.id)
                            }
                        }
                        .padding(16)
                    }
                    .defaultScrollAnchor(.bottom)
                    .onAppear { if let id = thread.latest?.id { proxy.scrollTo(id, anchor: .bottom) } }
                    .onChange(of: thread.latest?.id) { _, id in if let id { proxy.scrollTo(id, anchor: .bottom) } }
                }
                Divider()
                if selecting {
                    HStack {
                        if chosen.count > VoDogSMSDeletePolicy.maximumBatch {
                            Text(L10n.tr("一次最多删除 500 条，请分批选择。")).font(.caption).foregroundStyle(.red)
                                .reportsVoDogError(L10n.tr("一次最多删除 500 条，请分批选择。"))
                        }
                        Spacer()
                        Button(L10n.tr("删除所选"), role: .destructive) { confirmingSelectionDelete = true }
                            .disabled(deletingSelection || !VoDogSMSDeletePolicy.canDelete(chosen))
                    }
                    .padding(12)
                    .confirmationDialog(L10n.tr("删除选中的短信？"), isPresented: $confirmingSelectionDelete,
                                        titleVisibility: .visible) {
                        Button(L10n.tr("删除"), role: .destructive) { Task { await deleteSelected(chosen) } }
                        Button(L10n.tr("取消"), role: .cancel) {}
                    } message: {
                        Text(L10n.tr("选中的短信会被彻底删除，无法恢复。"))
                    }
                } else if thread.canReply, thread.replyNumber != nil {
                    composer.padding(.horizontal, 16).padding(.vertical, 12)
                } else {
                    Text(L10n.tr("这个发件人不能回复")).font(.caption).foregroundStyle(.secondary).padding(12)
                }
            }
        } else {
            ContentUnavailableView(L10n.tr("选择一段对话"), systemImage: "message",
                                   description: Text(L10n.tr("选择左侧会话，或新建短信。")))
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(L10n.tr("短信内容"), text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .overlay {
                        RoundedRectangle(cornerRadius: 17, style: .continuous).strokeBorder(Signal.line, lineWidth: 1)
                    }
                Button {
                    Task { await send() }
                } label: {
                    Group {
                        if sending { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.up") }
                    }
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Signal.onBrand)
                    .frame(width: 34, height: 34)
                    .background(Signal.brand, in: Circle())
                    .opacity(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
                }
                .buttonStyle(.plain)
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(L10n.tr("发送"))
            }
            if let sendError { VoDogErrorLine(text: sendError) }
        }
    }

    @ViewBuilder
    private func selectableBubble(_ message: VoDogSMSMessage) -> some View {
        if selecting {
            let chosen = selectedMessageIDs.contains(message.id)
            HStack(spacing: 10) {
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(chosen ? Color.accentColor : Color.secondary)
                    .accessibilityHidden(true)
                bubble(message).allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .onTapGesture { selectedMessageIDs = VoDogSMSDeletePolicy.toggle(message.id, in: selectedMessageIDs) }
            .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        } else {
            bubble(message)
        }
    }

    private func bubble(_ message: VoDogSMSMessage) -> some View {
        let outgoing = message.direction == "outgoing"
        return VStack(alignment: outgoing ? .trailing : .leading, spacing: 3) {
            Text(message.body ?? "")
                .textSelection(.enabled)
                .signalBubble(outgoing: outgoing)
            if !outgoing, !selecting, let code = SMSVerificationCodeExtractor.extract(from: message.body ?? "") {
                CopyCodeButton(code: code)
            }
            // iOS bubble captions: direction · SIM · delivery, then the absolute time.
            Text([outgoing ? L10n.tr("发出") : L10n.tr("收到"),
                  account.sims.first { $0.id == message.simId }?.displayName,
                  outgoing ? VoDogPhonePolicy.deliveryKey(message.state).map { L10n.tr($0) } : nil]
                .compactMap { $0 }.joined(separator: " · "))
                .font(.caption2).foregroundStyle(message.state == "failed" ? .red : .secondary)
            if let date = CCTime.parseISO(message.statusDateString) {
                Text(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened)
                    .locale(AppLanguage.storedPreference.locale)))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: outgoing ? .trailing : .leading)
    }

    /// 「号码 · 通过 <SIM> 接收」 (number only when a contact name is the title).
    private func sourceLine(_ thread: VoDogConversation) -> String {
        let sim = account.sims.first { $0.id == thread.latest?.simId }?.displayName
        return [thread.contactName != nil ? thread.displayNumber : nil, sim.map { L10n.tr("通过 %@ 接收", $0) }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private func openPendingRecipient() {
        guard let number = Self.pendingRecipient else { return }
        Self.pendingRecipient = nil
        if let thread = threads.first(where: { $0.id == VoDogPhonePolicy.addressKey(number) }) {
            selectedThread = thread.id
            composing = false
        } else {
            selectedThread = nil
            recipients = number
            composing = true
        }
    }

    private func load() async {
        do {
            let list = try await account.decode(SMSList.self, "GET", "/sms", query: ["limit": "100"])
            messages = list.items
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            loadError = VoDogErrorText.message(error)
        }
        loaded = true
    }

    /// iOS `deleteThread(_:block:)`: 删除并屏蔽 blocks first (SMS list); a 400 aborts before anything is
    /// deleted. A block that succeeded before a failed delete is remembered so the retry does not block again.
    private func deleteThread(_ thread: VoDogConversation, block: Bool) async {
        guard let simId = selection.wrappedValue, threadBusyID == nil else { return }
        let key = VoDogSMSDeletePolicy.threadKey(simID: simId, threadID: thread.id)
        actionMessage = nil
        threadBusyID = thread.id
        defer { threadBusyID = nil }
        var blockSatisfied = blockedThreadDeleteKeys.contains(key)
        if block, !blockSatisfied {
            guard let remote = thread.blockNumber, VoDogContactsLogic.canBlock(remote) else {
                actionMessage = VoDogErrorText.shown(L10n.tr("这个号码不能屏蔽，对话没有删除。"))
                return
            }
            do {
                _ = try await account.json("POST", "/blocklist",
                                           body: ["remoteNumber": String(remote.prefix(64)), "scope": "sms"])
                blockedThreadDeleteKeys.insert(key)
                blockSatisfied = true
            } catch is CancellationError {
                return
            } catch let error as VoDogAPIError where error.status == 400 {
                actionMessage = VoDogErrorText.shown(L10n.tr("这个号码不能屏蔽，对话没有删除。"), error: error)
                return
            } catch {
                actionMessage = VoDogErrorText.message(error)
                return
            }
        }
        do {
            let response = try await account.json("POST", "/sms/threads/delete",
                                                  body: ["simId": simId, "conversationAddress": thread.threadAddress])
            blockedThreadDeleteKeys.remove(key)
            account.diag("sms.thread_delete", fields: ["simId": simId, "blocked": block])
            actionMessage = skippedMessage(response)
            if selectedThread == thread.id, actionMessage == nil { selectedThread = nil }
        } catch is CancellationError {
            return
        } catch {
            actionMessage = blockSatisfied ? VoDogErrorText.shown(L10n.tr("号码已屏蔽，但对话删除失败，请重试"), error: error)
                : VoDogErrorText.message(error)
        }
        await load()
    }

    private func deleteSelected(_ ids: [String]) async {
        guard VoDogSMSDeletePolicy.canDelete(ids), !deletingSelection else { return }
        deletingSelection = true
        defer { deletingSelection = false }
        do {
            let response = try await account.json("POST", "/sms/delete", body: ["ids": ids])
            account.diag("sms.delete", fields: ["count": ids.count])
            actionMessage = skippedMessage(response)
            selecting = false
            selectedMessageIDs = []
        } catch is CancellationError {
            return
        } catch {
            actionMessage = VoDogErrorText.message(error)
        }
        await load()
    }

    private func skippedMessage(_ response: [String: Any], site: String = #function) -> String? {
        let skipped = VoDogSMSDeletePolicy.skippedCount(response)
        return skipped == 0 ? nil : VoDogErrorText.shown(L10n.tr("%lld 条正在发送中，暂时无法删除。", Int64(skipped)), site: site)
    }

    private func send() async {
        guard !sending, let simId = selection.wrappedValue else { return }
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let targets = composing ? VoDogPhonePolicy.recipients(recipients) : [thread?.replyNumber].compactMap { $0 }
        guard !body.isEmpty, !targets.isEmpty else { return }
        sending = true
        sendError = nil
        defer { sending = false }
        do {
            if targets.count == 1 {
                _ = try await account.json("POST", "/sms/outbound", body: ["simId": simId, "remoteNumber": targets[0], "body": body],
                                           idempotent: true)
            } else {
                _ = try await account.json("POST", "/sms/batch", body: ["simId": simId, "recipients": targets, "body": body],
                                           idempotent: true)
            }
            account.diag("sms.outbound", fields: ["simId": simId, "recipients": targets.count, "length": body.count])
            draft = ""
            if composing {
                composing = false
                recipients = ""
                selectedThread = targets.count == 1 ? VoDogPhonePolicy.addressKey(targets[0]) : nil
            }
            await load()
        } catch is CancellationError {
            return
        } catch {
            sendError = VoDogErrorText.message(error)
        }
    }
}
