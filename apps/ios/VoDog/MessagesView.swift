import SwiftUI

struct MessagesView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase
    @State private var sims: [SIMChannel] = []
    @State private var messages: [SMSMessage] = []
    @State private var badges = BadgeStore.shared
    @State private var selectedSIM: String?
    @State private var composeRequest: HistoryComposeRequest?
    @State private var error: String?
    @State private var drafts = MessageDraftStore()
    @State private var loaded = false
    @State private var card: ContactCardTarget?
    /// S30. The two swipe actions confirm separately, and the two dialogs hang off two different views on
    /// purpose: two `confirmationDialog` modifiers on one view race and only one of them ever opens.
    @State private var pendingThreadDelete: MessageConversation?
    @State private var pendingThreadBlockDelete: MessageConversation?
    @State private var threadBusyID: String?
    @State private var blockedThreadDeleteKeys: Set<String> = []
    @State private var deletedMessageIDs: Set<String> = []
    @State private var operationFeedback: String?
    @State private var loadGeneration = 0
    @State private var transientStateSessionIdentity: UUID?

    private var conversations: [MessageConversation] {
        MessageConversation.grouped(messages, selectedSIMID: selectedSIM)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                SIMStrip(sims: sims, selectedID: $selectedSIM, loaded: loaded, badges: badges.counts.smsBySIM)
                NetworkAvailabilityNotice().padding(.horizontal)
                if !loaded {
                    // S20 decision 8: "暂无短信" before the first response is a guess, not an answer.
                    VStack(spacing: 10) { ProgressView(); Text("正在读取短信…").foregroundStyle(.secondary) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if conversations.isEmpty, error == nil {
                    LoadStateView(
                        icon: "message",
                        title: selectedSIM == nil ? "没有可用号码" : "暂无短信",
                        detail: selectedSIM == nil ? "账号尚未分配号码。" : "当前号码没有短信记录。"
                    )
                } else {
                    List(conversations) { conversation in
                        HStack(spacing: 0) {
                            NavigationLink {
                                ConversationView(
                                    conversation: conversation,
                                    messages: messages,
                                    sims: sims,
                                    drafts: drafts,
                                    onRefresh: { await load(requiredIdentity: session.sessionIdentity) }
                                )
                            } label: {
                                ConversationRow(conversation: conversation, sims: sims)
                            }
                            .accessibilityIdentifier("messages.conversation")
                            // §F: the same "i" the records list has — a sibling of the link, so it opens the
                            // card instead of pushing the thread.
                            Button {
                                card = ContactCardTarget(conversation: conversation)
                            } label: {
                                Image(systemName: "info.circle")
                                    .font(.title3)
                                    .frame(width: 44, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("\(conversation.displayTitle) 的联系人卡片")
                            .accessibilityIdentifier("messages.contactCard")
                        }
                        // S30: 删除 is declared first, which is what puts it against the trailing edge — SwiftUI
                        // lays trailing swipe buttons out from the edge inward in declaration order. 删除并屏蔽
                        // is therefore the inner, harder-to-hit one, which is the right way round for the action
                        // that also blocks the line.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            ForEach(
                                ThreadSwipeActionPolicy.actions(remoteNumber: conversation.blockNumber),
                                id: \.self
                            ) { action in
                                Button(role: .destructive) {
                                    switch action {
                                    case .delete: pendingThreadDelete = conversation
                                    case .deleteAndBlock: pendingThreadBlockDelete = conversation
                                    }
                                } label: {
                                    Text(ThreadSwipeActionPolicy.title(action))
                                }
                                // iOS 27 can inherit the app accent for swipe buttons even when the
                                // semantic role is destructive. Keep the role for accessibility and
                                // force the destructive fill to the product danger color.
                                .tint(Color.callerDanger)
                                .disabled(!availability.canMutate)
                                .accessibilityIdentifier(ThreadSwipeActionPolicy.accessibilityIdentifier(action))
                            }
                        }
                        .disabled(threadBusyID == conversation.id.id)
                    }
                    .listStyle(.insetGrouped)
                    .refreshable { await load(requiredIdentity: session.sessionIdentity) }
                    .confirmationDialog(
                        ThreadSwipeActionPolicy.deleteConfirmTitle,
                        isPresented: Binding(
                            get: { pendingThreadDelete != nil },
                            set: { if !$0 { pendingThreadDelete = nil } }
                        ),
                        titleVisibility: .visible
                    ) {
                        Button(ThreadSwipeActionPolicy.confirmButton, role: .destructive) {
                            if let thread = pendingThreadDelete { Task { await deleteThread(thread, block: false) } }
                            pendingThreadDelete = nil
                        }
                        .tint(Color.callerDanger)
                        .disabled(!availability.canMutate)
                        Button(ThreadSwipeActionPolicy.cancelTitle, role: .cancel) { pendingThreadDelete = nil }
                    } message: {
                        Text(ThreadSwipeActionPolicy.deleteConfirmMessage)
                        if let reason = availability.reason { Text(reason) }
                    }
                }
            }
            .confirmationDialog(
                ThreadSwipeActionPolicy.deleteAndBlockConfirmTitle,
                isPresented: Binding(
                    get: { pendingThreadBlockDelete != nil },
                    set: { if !$0 { pendingThreadBlockDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(ThreadSwipeActionPolicy.confirmButton, role: .destructive) {
                    if let thread = pendingThreadBlockDelete { Task { await deleteThread(thread, block: true) } }
                    pendingThreadBlockDelete = nil
                }
                .tint(Color.callerDanger)
                .disabled(!availability.canMutate)
                Button(ThreadSwipeActionPolicy.cancelTitle, role: .cancel) { pendingThreadBlockDelete = nil }
            } message: {
                Text(ThreadSwipeActionPolicy.deleteAndBlockConfirmMessage)
                if let reason = availability.reason { Text(reason) }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("短信")
            .toolbarTitleDisplayMode(.inlineLarge)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composeRequest = HistoryComposeRequest(simID: selectedSIM, remoteNumber: "", token: UUID()) } label: { Image(systemName: "square.and.pencil") }
                        .disabled(selectedSIM == nil)
                        .accessibilityLabel("新短信")
                }
            }
            .sheet(item: $card) { target in
                ContactCardView(target: target) { await load(requiredIdentity: session.sessionIdentity) }
            }
            .sheet(item: $composeRequest) { request in
                ComposeMessageView(
                    sims: sims, initialSIM: request.simID, initialNumber: request.remoteNumber, drafts: drafts
                ) {
                    await load(requiredIdentity: session.sessionIdentity)
                }
            }
            .onChange(of: navigation.pendingCompose, initial: true) { _, pending in
                guard let pending else { return }
                navigation.pendingCompose = nil
                if let simID = pending.simID { selectedSIM = simID }
                composeRequest = pending
            }
            .safeAreaInset(edge: .bottom) {
                if let message = operationFeedback ?? error {
                    ErrorBanner(screen: "messages", message: message) {
                        Task { await load(requiredIdentity: session.sessionIdentity) }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 6)
                }
            }
            .task(id: "\(session.sessionIdentity?.uuidString ?? "none"):\(navigation.tab):\(scenePhase)") {
                await poll()
            }
        }
    }

    private func poll() async {
        guard let identity = session.sessionIdentity else {
            resetSessionScopedTransientState(for: nil)
            return
        }
        resetSessionScopedTransientState(for: identity)
        guard navigation.tab == .messages, scenePhase == .active else { return }
        while !Task.isCancelled, session.isCurrentSession(identity), navigation.tab == .messages, scenePhase == .active {
            // S69: whether or not the push cancelled this task, an open thread's loop is the only one that polls.
            if !navigation.smsThreadOpen { await load(requiredIdentity: identity) }
            do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
        }
    }

    /// Tombstones and retry-only block success belong to one authenticated session. RootView normally destroys
    /// this view on logout; this explicit boundary also covers a future in-place session replacement.
    private func resetSessionScopedTransientState(for identity: UUID?) {
        guard transientStateSessionIdentity != identity else { return }
        transientStateSessionIdentity = identity
        loadGeneration += 1
        blockedThreadDeleteKeys.removeAll()
        deletedMessageIDs.removeAll()
        operationFeedback = nil
        error = nil
        pendingThreadDelete = nil
        pendingThreadBlockDelete = nil
        threadBusyID = nil
    }

    private func load(requiredIdentity identity: UUID?) async {
        guard let identity, session.isCurrentSession(identity) else { return }
        loadGeneration += 1
        let generation = loadGeneration
        do {
            async let simResult: ItemEnvelope<SIMChannel> = session.request("sims", requiredSessionIdentity: identity)
            async let smsResult = SMSFullListPolicy.fetchAll { query -> SMSPageEnvelope<SMSMessage> in
                try await session.request("sms", requiredSessionIdentity: identity, queryItems: query)
            }
            let result = try await (simResult, smsResult)
            guard session.isCurrentSession(identity), generation == loadGeneration else { return }
            if result.1.capped {
                Diag.shared.log("sms.list_capped", ["pages": SMSFullListPolicy.maxPages, "count": result.1.items.count])
            }
            sims = result.0.items
            messages = result.1.items.filter { !deletedMessageIDs.contains($0.id) }
            selectedSIM = SIMSelectionPolicy.preferredID(in: sims, current: selectedSIM)
            error = nil
            loaded = true
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            // Leaving the tab, pushing/popping a thread or ending a pull-to-refresh cancels the task that owns this
            // load; URLSession then throws -999 "cancelled", which is the app changing its mind, not a failure.
            guard !Task.isCancelled, session.isCurrentSession(identity), generation == loadGeneration else { return }
            self.error = error.localizedDescription
            loaded = true
        }
    }

    /// S30 §1.3. 删除并屏蔽 is two requests in a fixed order, not one endpoint: `POST /blocklist` first — it is
    /// idempotent, so 201 (new) and 200 (already blocked) are both success — then the thread delete. A refused
    /// block (400: emergency or non-dialable) stops there and leaves the thread alone, because deleting without
    /// blocking is not what the user asked for.
    private func deleteThread(_ conversation: MessageConversation, block: Bool) async {
        guard availability.canMutate else { return }
        guard let identity = session.sessionIdentity, session.isCurrentSession(identity) else { return }
        operationFeedback = nil
        threadBusyID = conversation.id.id
        defer { threadBusyID = nil }
        var blockSatisfied = blockedThreadDeleteKeys.contains(conversation.id.id)
        if block, !blockSatisfied {
            guard let remote = conversation.blockNumber,
                  ThreadSwipeActionPolicy.canBlock(remoteNumber: remote) else {
                error = ThreadSwipeActionPolicy.blockRejectedMessage
                return
            }
            do {
                let _: BlocklistItemEnvelope = try await session.request(
                    "blocklist", method: "POST",
                    body: BlocklistCreateBody(remoteNumber: remote, sourceCallId: nil, scope: .sms),
                    requiredSessionIdentity: identity
                )
                guard session.isCurrentSession(identity) else { return }
                blockedThreadDeleteKeys.insert(conversation.id.id)
                blockSatisfied = true
            } catch SessionLifecycleError.staleSession {
                return
            } catch {
                guard session.isCurrentSession(identity) else { return }
                self.error = ThreadSwipeActionPolicy.blockErrorMessage(error)
                return
            }
        }
        do {
            let response: SMSDeleteResponse = try await session.request(
                "sms/threads/delete", method: "POST",
                body: SMSThreadDeleteBody(
                    simId: conversation.id.simID, conversationAddress: conversation.threadAddress
                ),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            let requested = Set(conversation.messages.map(\.id))
            let accepted = ThreadDeleteResultPolicy.acceptedIDs(requested: requested, response: response)
            deletedMessageIDs.formUnion(accepted)
            messages = MessageSelectionPolicy.remaining(messages, deleting: accepted)
            error = nil
            operationFeedback = ThreadDeleteResultPolicy.feedback(response)
            blockedThreadDeleteKeys.remove(conversation.id.id)
            await load(requiredIdentity: identity)
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            if blockSatisfied {
                operationFeedback = ThreadSwipeActionPolicy.blockSucceededDeleteFailedMessage
                await load(requiredIdentity: identity)
            } else {
                self.error = error.localizedDescription
            }
        }
    }
}

private struct ConversationRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let conversation: MessageConversation
    let sims: [SIMChannel]
    private var unread: Bool {
        UnreadDotPolicy.conversationUnread(conversation.messages, locallyRead: BadgeStore.shared.readSMSIDs)
    }

    private var identity: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if conversation.blocked {
                Image(systemName: ContactDisplay.blockedSymbol)
                    .foregroundStyle(Color.callerDanger)
                    .accessibilityHidden(true)
            }
            // Keep the complete number/name readable when the date moves to its own line.
            Text(conversation.displayTitle)
                .font(.headline)
                .fontWeight(unread ? .bold : nil)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var date: some View {
        Text(displayDate(conversation.latest?.statusDate))
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private var stackedHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            identity
            date.fixedSize(horizontal: false, vertical: true)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            UnreadDot(visible: unread, label: "未读").padding(.top, 6)
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            if dynamicTypeSize >= .xxxLarge {
                stackedHeader
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline) {
                        identity.fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 8)
                        date.fixedSize(horizontal: true, vertical: false)
                    }
                    stackedHeader
                }
            }
            Text(conversation.latest?.body ?? "").lineLimit(2).foregroundStyle(.secondary)
            if let latest = conversation.latest {
                // Accessibility sizes stack the three facts; a shared line squeezed 收到 into 收/到.
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(spacing: 8))
                layout {
                    // S92: explicit style — inside AnyLayout the automatic style dropped the title and left only the arrow.
                    Label(latest.directionTitle, systemImage: latest.directionIcon).labelStyle(.titleAndIcon).lineLimit(1).fixedSize()
                    Text(simTitle(latest.simId, in: sims))
                    if let status = latest.statusTitleForRow { Text(status) }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            if conversation.latest?.missingParts == true {
                Label("短信缺少分段", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 3)
    }
}

struct ConversationView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase
    let conversation: MessageConversation
    let messages: [SMSMessage]
    let sims: [SIMChannel]
    let drafts: MessageDraftStore
    let onRefresh: () async -> Void
    @State private var replyBody = ""
    @State private var error: String?
    @State private var isSending = false
    @State private var sendFeedback = 0
    @State private var card: ContactCardTarget?
    /// S30: 长按气泡进入选择状态. The deleted ids are kept locally because `messages` is the parent's state — the
    /// bubbles must go the moment the server confirms, not one 5 s poll later.
    @State private var selecting = false
    @State private var selectedIDs: Set<String> = []
    @State private var deletedIDs: Set<String> = []
    @State private var confirmingDelete = false
    @State private var isDeleting = false
    /// Only so 发送 can hand the keyboard back after a successful send; nothing else drives it.
    @FocusState private var replyFocused: Bool
    @State private var restoreReplyFocus = false
    /// S67: incoming ids already sent to `POST /sms/read` while this thread is open.
    @State private var readRequested: Set<String> = []
    /// S83: the message whose body is open in the 选择文字 sheet.
    @State private var textSelectionMessage: SMSMessage?

    private var currentMessages: [SMSMessage] {
        // The `??` fallback matters after a whole thread is deleted: `grouped` no longer contains this id, so the
        // view would otherwise fall back to the snapshot it was pushed with and show the deleted bubbles again.
        // The local filter is applied after the fallback, never only to the grouped result.
        let thread = MessageConversation.grouped(messages, selectedSIMID: conversation.id.simID)
            .first(where: { $0.id == conversation.id })?.messages ?? conversation.messages
        return MessageSelectionPolicy.remaining(thread, deleting: deletedIDs)
    }

    private var canReply: Bool {
        availability.canSendSMS(on: conversation.id.simID)
            && conversation.canReply && conversation.replyNumber != nil
            && SIMSelectionPolicy.canSendSMS(on: conversation.id.simID, sims: availability.sims)
    }

    var body: some View {
        ScrollViewReader { proxy in
          // S92: a thread shorter than the screen was bottom-aligned by `defaultScrollAnchor` with a negative
          // offset, which sometimes fired the pull-to-refresh on open (spinner + a full SMS reload, no pull).
          // Filling at least the viewport and aligning to the bottom keeps the offset at zero.
          GeometryReader { viewport in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if let caption = ConversationLineCaption.text(sim: sims.first { $0.id == conversation.id.simID }) {
                        Text(caption)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(currentMessages) { message in
                        MessageBubble(
                            message: message, sims: sims,
                            selecting: selecting, selected: selectedIDs.contains(message.id),
                            onSelectText: { textSelectionMessage = message },
                            onMultiSelect: message.id.isEmpty ? nil : { beginSelection(with: message.id) }
                        )
                        .id(message.id)
                        .accessibilityIdentifier("conversation.messageBubble")
                        .contentShape(Rectangle())
                        // S83: long press belongs to the bubble's context menu (复制 / 选择文字 / 多选); the tap only
                        // toggles while selecting.
                        .onTapGesture {
                            guard selecting else { return }
                            selectedIDs = MessageSelectionPolicy.toggle(message.id, in: selectedIDs)
                        }
                        .accessibilityElement(children: selecting ? .combine : .contain)
                        .accessibilityAddTraits(selecting && selectedIDs.contains(message.id) ? .isSelected : [])
                        .accessibilityAction(named: Text(selecting ? (selectedIDs.contains(message.id) ? "取消选择" : "选择短信") : "进入选择模式")) {
                            if selecting {
                                selectedIDs = MessageSelectionPolicy.toggle(message.id, in: selectedIDs)
                            } else {
                                beginSelection(with: message.id)
                            }
                        }
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, minHeight: viewport.size.height, alignment: .bottom)
            }
            // Open at the newest message (and keep it in view when the reply keyboard shrinks the viewport). A
            // scrollTo in onAppear ran before the LazyVStack laid out the last row, so threads opened at the top.
            .defaultScrollAnchor(.bottom)
            .background(Color(uiColor: .systemGroupedBackground))
            // Scrolling the transcript away is the natural way to put the reply keyboard down.
            .scrollDismissesKeyboard(.interactively)
            .refreshable { Diag.shared.log("sms.thread_refresh", [:]); await onRefresh() }
            .onAppear {
                if let accountID = session.user?.id { replyBody = drafts.reply(accountID: accountID, conversation: conversation.id) }
            }
            .onChange(of: currentMessages.count) { _, _ in
                if let id = currentMessages.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
            }
          }
        }
        .navigationTitle(conversation.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if selecting {
                ToolbarItem(placement: .principal) {
                    Text(MessageSelectionPolicy.title(count: selectedIDs.count))
                        .font(.headline)
                        .accessibilityIdentifier("conversation.selectionTitle")
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button(MessageSelectionPolicy.selectAllTitle) {
                        selectedIDs = MessageSelectionPolicy.selectAll(currentMessages.map(\.id))
                    }
                    .accessibilityIdentifier(MessageSelectionPolicy.selectAllAccessibilityIdentifier)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(MessageSelectionPolicy.cancelTitle) { exitSelection() }
                        .accessibilityIdentifier(MessageSelectionPolicy.cancelAccessibilityIdentifier)
                }
            } else {
                // 长按气泡 is the gesture the spec asks for; this button is the same door with a label on it, and
                // it is what UI automation can actually find.
                ToolbarItem(placement: .topBarTrailing) {
                    Button(MessageSelectionPolicy.enterTitle) { selecting = true; selectedIDs = [] }
                        .disabled(currentMessages.isEmpty)
                        .accessibilityIdentifier(MessageSelectionPolicy.selectModeAccessibilityIdentifier)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { card = ContactCardTarget(conversation: conversation) } label: {
                        Image(systemName: "info.circle")
                    }
                    .accessibilityLabel("联系人卡片")
                    .accessibilityIdentifier("conversation.contactCard")
                }
            }
        }
        .sheet(item: $card) { target in
            ContactCardView(target: target) { await onRefresh() }
        }
        .sheet(item: $textSelectionMessage) { message in
            MessageTextSelectionSheet(text: message.body ?? "")
        }
        .safeAreaInset(edge: .bottom) { if selecting { selectionBar } else { replyBar } }
        // S67: opening the thread, and each incoming message that lands while it is open, marks them read.
        .task(id: currentMessages.filter { $0.direction == "incoming" }.map(\.id)) {
            let ids = currentMessages.filter { $0.direction == "incoming" && !readRequested.contains($0.id) }.map(\.id)
            guard !ids.isEmpty else { return }
            readRequested.formUnion(ids)
            // ponytail: a failed POST retries on the next incoming message or on reopening the thread.
            if !(await BadgeStore.shared.markSMSRead(ids, simID: conversation.id.simID, session: session)) {
                readRequested.subtract(ids)
            }
        }
        .onAppear { navigation.smsThreadOpen = true }
        .onDisappear { navigation.smsThreadOpen = false }
        .task(id: "\(session.sessionIdentity?.uuidString ?? "none"):\(navigation.tab):\(scenePhase)") {
            guard let identity = session.sessionIdentity else { return }
            guard navigation.tab == .messages, scenePhase == .active else { return }
            while !Task.isCancelled, session.isCurrentSession(identity),
                  navigation.tab == .messages, scenePhase == .active {
                await onRefresh()
                do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
            }
        }
    }

    /// S30. What the reply bar turns into in selection mode: one destructive button, disabled at zero, plus the
    /// 500-id ceiling `POST /sms/delete` enforces stated in place rather than discovered at the server.
    private var selectionBar: some View {
        VStack(spacing: 6) {
            if let error {
                Text(error).font(.caption).foregroundStyle(Color.callerDanger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .reportsError(error, screen: "conversation", site: "selection")
            }
            if MessageSelectionPolicy.isOverLimit(selectedIDs) {
                Text(MessageSelectionPolicy.overLimitMessage)
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button(role: .destructive) { confirmingDelete = true } label: {
                Label(MessageSelectionPolicy.deleteSelectedTitle, systemImage: "trash")
                    .frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.callerDanger)
            .disabled(!availability.canMutate || !MessageSelectionPolicy.canDelete(selectedIDs) || isDeleting)
            .accessibilityIdentifier(MessageSelectionPolicy.deleteSelectedAccessibilityIdentifier)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
        .confirmationDialog(
            MessageSelectionPolicy.confirmTitle, isPresented: $confirmingDelete, titleVisibility: .visible
        ) {
            Button(MessageSelectionPolicy.confirmButton, role: .destructive) { Task { await deleteSelected() } }
                .disabled(!availability.canMutate)
            Button(MessageSelectionPolicy.cancelTitle, role: .cancel) {}
        } message: {
            Text(MessageSelectionPolicy.confirmMessage)
            if let reason = availability.reason { Text(reason) }
        }
    }

    private func beginSelection(with id: String) {
        if !selecting {
            selecting = true
            selectedIDs = MessageSelectionPolicy.clear()
        }
        selectedIDs = MessageSelectionPolicy.toggle(id, in: selectedIDs)
    }

    private func exitSelection() {
        selecting = false
        selectedIDs = MessageSelectionPolicy.clear()
    }

    /// S30 §1.2. `POST /sms/delete {ids}` answers `{deleted, skipped}`; only the ids the server did not skip are
    /// hidden locally, so a message it refused as `in_flight` stays on screen instead of reappearing on the next
    /// poll.
    private func deleteSelected() async {
        guard availability.canMutate else { return }
        guard let identity = session.sessionIdentity, session.isCurrentSession(identity) else { return }
        let ids = MessageSelectionPolicy.orderedIDs(selectedIDs, in: currentMessages)
        guard MessageSelectionPolicy.canDelete(Set(ids)) else { return }
        isDeleting = true
        defer { isDeleting = false }
        do {
            let result: SMSDeleteResponse = try await session.request(
                "sms/delete", method: "POST", body: SMSDeleteBody(ids: ids),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            deletedIDs.formUnion(MessageSelectionPolicy.acceptedIDs(requested: ids, skipped: result.skipped))
            error = MessageSelectionPolicy.skippedMessage(result.skipped)
            exitSelection()
            await onRefresh()
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }

    private var replyBar: some View {
        VStack(spacing: 4) {
            NetworkAvailabilityNotice()
            if availability.reason == nil, !canReply {
                Text("当前号码暂不能发送，草稿仍可编辑。").font(.caption).foregroundStyle(.secondary)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(Color.callerDanger).frame(maxWidth: .infinity, alignment: .leading)
                    .reportsError(error, screen: "conversation", site: "reply")
            }
            SMSGlassControls {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("短信", text: $replyBody, axis: .vertical)
                    .lineLimit(2...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(minHeight: 56)
                    .modifier(ReplyComposerSurface())
                    .accessibilityIdentifier("conversation.replyBody")
                    .disabled(isSending)
                    .focused($replyFocused)
                    .onChange(of: replyBody) { _, value in
                        guard let accountID = session.user?.id else { return }
                        drafts.saveReply(value, accountID: accountID, conversation: conversation.id)
                    }
                // Messages.app behaviour: one message sent leaves the keyboard up for the next. The focus is
                // read before the send because by then it is gone — `.disabled(isSending)` resigns it — and it
                // is only asked for again once that flag has been applied to the view tree (see the
                // `.onChange(of: isSending)` below). Re-asserting from the main queue instead loses the race
                // against SwiftUI's update and silently does nothing: measured, not assumed.
                Button {
                    let wasFocused = replyFocused
                    sendFeedback += 1
                    Task {
                        let sent = await reply()
                        restoreReplyFocus = ReplyFocusPolicy.shouldRestoreFocus(
                            wasFocused: wasFocused, sendSucceeded: sent
                        )
                    }
                } label: {
                    Image(systemName: "arrow.up").font(.title3.weight(.semibold))
                        .frame(minWidth: 44, minHeight: 44)
                }
                .disabled(!canReply || replyBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
                .modifier(SMSGlassButton(prominent: true))
                .accessibilityLabel("发送回复")
            }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemGroupedBackground))
        .sensoryFeedback(.success, trigger: sendFeedback)
        // The field is only focusable again once `isSending` is false *in the rendered tree*, so the re-assert
        // rides that update rather than racing it.
        .onChange(of: isSending) { _, sending in
            guard !sending, restoreReplyFocus else { return }
            restoreReplyFocus = false
            replyFocused = true
        }
    }

    /// Returns whether the message actually went out, which is the only condition under which the reply bar
    /// takes the keyboard back.
    @discardableResult
    private func reply() async -> Bool {
        guard let accountID = session.user?.id,
              let identity = session.sessionIdentity,
              session.isCurrentSession(identity), canReply else { return false }
        let body = replyBody.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return false }
        guard let replyNumber = conversation.replyNumber else { return false }
        let payload = SMSOutboundPayload(simId: conversation.id.simID, remoteNumber: replyNumber, body: body)
        isSending = true
        defer { isSending = false }
        do {
            let key = try SMSIdempotencyStore.shared.key(accountID: accountID, payload: payload)
            let _: SMSResponse = try await session.request(
                "sms/outbound", method: "POST", body: payload, idempotencyKey: key,
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return false }
            SMSIdempotencyStore.shared.markSucceeded(accountID: accountID, payload: payload, idempotencyKey: key)
            drafts.saveReply("", accountID: accountID, conversation: conversation.id)
            replyBody = ""
            error = nil
            await onRefresh()
            return true
        } catch SessionLifecycleError.staleSession {
            return false
        } catch {
            guard session.isCurrentSession(identity) else { return false }
            self.error = error.localizedDescription
            return false
        }
    }
}

private struct MessageBubble: View {
    let message: SMSMessage
    let sims: [SIMChannel]
    /// S30: the selection tick leads the whole row — on the left for an incoming bubble and for an outgoing one
    /// alike — so the column of ticks reads as one list rather than following each bubble's alignment.
    var selecting = false
    var selected = false
    var onSelectText: () -> Void = {}
    var onMultiSelect: (() -> Void)?
    /// S87: a tapped link waits here for 「打开」. `.alert`, not `confirmationDialog` (see the S30 note at the top).
    @State private var pendingLink: URL?

    private var textColor: Color { message.direction == "outgoing" ? Color.callerOnAccent : Color.primary }

    var body: some View {
        HStack(spacing: 8) {
            if selecting {
                Image(
                    systemName: selected
                        ? MessageSelectionPolicy.selectedSymbol
                        : MessageSelectionPolicy.unselectedSymbol
                )
                .font(.title3)
                .foregroundStyle(selected ? Color.callerAccent : Color.secondary)
                .accessibilityHidden(true)
            }
            bubble
        }
    }

    private var bubble: some View {
        HStack {
            if message.direction == "outgoing" { Spacer(minLength: 50) }
            VStack(alignment: message.direction == "outgoing" ? .trailing : .leading, spacing: 4) {
                // S87: selection mode renders plain text so a tap on a link still only toggles.
                Text(SMSLinkPolicy.attributed(message.body ?? "", color: textColor, linked: !selecting))
                    .tint(textColor)
                    .environment(\.openURL, OpenURLAction { url in
                        pendingLink = url
                        return .handled
                    })
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(message.direction == "outgoing" ? Color.callerAccent : Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 17))
                    .foregroundStyle(textColor)
                    // S83: the menu sits on the bubble itself so the lift preview is just the bubble. Selection
                    // mode leaves the builder empty, which shows no menu, so the tap toggle is the only gesture.
                    .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 17))
                    .contextMenu { if !selecting { menuItems } }
                Text(([message.directionTitle, simTitle(message.simId, in: sims)] + [message.statusTitleForRow].compactMap { $0 }).joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary)
                Text(displayDate(message.statusDate)).font(.caption2).foregroundStyle(.secondary)
                if let reason = message.failureReason, !reason.isEmpty {
                    Text(reason).font(.caption2).foregroundStyle(Color.callerDanger)
                }
            }
            if message.direction != "outgoing" { Spacer(minLength: 50) }
        }
        .alert(
            "打开链接？",
            isPresented: Binding(get: { pendingLink != nil }, set: { if !$0 { pendingLink = nil } }),
            presenting: pendingLink
        ) { url in
            Button("打开") { if SMSLinkPolicy.isOpenable(url) { UIApplication.shared.open(url) } }
            Button("取消", role: .cancel) {}
        } message: { url in
            Text(url.absoluteString)
        }
    }

    @ViewBuilder private var menuItems: some View {
        if let text = message.body, !text.isEmpty {
            Button("复制", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
            Button("选择文字", systemImage: "selection.pin.in.out", action: onSelectText)
        }
        if let onMultiSelect {
            Button("多选", systemImage: "checkmark.circle", action: onMultiSelect)
        }
    }
}

/// S83: SwiftUI `textSelection(.enabled)` on iOS only copies the whole text, so partial selection with native
/// handles needs a read-only `UITextView`.
private struct MessageTextSelectionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let text: String

    var body: some View {
        NavigationStack {
            SelectableTextView(text: text)
                .navigationTitle("选择文字")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                }
        }
    }
}

private struct SelectableTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        if uiView.text != text { uiView.text = text }
    }
}

struct ComposeMessageView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(\.dismiss) private var dismiss
    let sims: [SIMChannel]
    let initialSIM: String?
    var initialNumber: String = ""
    let drafts: MessageDraftStore
    let onSent: () async -> Void
    @State private var selectedSIM: String?
    @State private var number = ""
    @State private var messageBody = ""
    @State private var error: String?
    @State private var isSending = false
    @State private var loaded = false
    @State private var prefillConsumed = false
    @State private var recipients: [SMSRecipient] = []
    @State private var choosingContacts = false
    @State private var cachedContacts: [Contact] = []
    @State private var draftAccountID: String?
    @State private var draftSessionIdentity: UUID?
    @State private var bodyEdited = false
    /// SwiftUI ignores `.disabled()` inside a `Picker`, so the choice is validated after the fact and bounced back.
    @State private var pickerSelection: String?
    @State private var sendFeedback = 0

    var body: some View {
        NavigationStack {
            Form {
                if availability.reason != nil { Section { NetworkAvailabilityNotice() } }
                Section("发送号码") {
                    Picker("号码", selection: $pickerSelection) {
                        ForEach(sims) { sim in
                            Text(pickerLabel(sim)).tag(Optional(sim.id))
                        }
                    }
                    .pickerStyle(.navigationLink)
                    .accessibilityIdentifier("compose.sim")
                    if let sim = sims.first(where: { $0.id == selectedSIM }) { SIMIdentityDetail(sim: sim) }
                }
                Section("收件人") {
                    ForEach(recipients) { recipient in
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 3) {
                                if let name = recipient.name, !name.isEmpty { Text(name).font(.subheadline.weight(.semibold)) }
                                Text(recipient.number).font(.subheadline).monospacedDigit()
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Button {
                                recipients.removeAll { $0.id == recipient.id }
                            } label: { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("移除收件人 \(recipient.name ?? "") \(recipient.number)")
                            .accessibilityIdentifier("compose.removeRecipient.\(recipient.number)")
                        }
                        .padding(.leading, 12)
                        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 16))
                        // Keep identifiers on leaf controls: a container identifier propagates
                        // to its children on iOS 27 and masks each remove button's number.
                    }
                    HStack(spacing: 8) {
                        TextField("电话号码", text: $number)
                            .keyboardType(.phonePad).monospacedDigit()
                            .accessibilityIdentifier("compose.recipient")
                        Button {
                            choosingContacts = true
                        } label: { Image(systemName: "plus").frame(minWidth: 44, minHeight: 44) }
                        .modifier(SMSGlassButton())
                        .accessibilityLabel("从通讯录添加收件人")
                        .accessibilityHint("可选择多个联系人和电话号码")
                        .accessibilityIdentifier("compose.addContacts")
                    }
                    if !PhoneNumberText.normalized(number).isEmpty {
                        Button("添加此号码") {
                            recipients = SMSRecipientPolicy.resolved(recipients, manual: number)
                            number = ""
                        }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("compose.addManual")
                    }
                }
                Section("内容") {
                    TextField("短信内容", text: Binding(get: { messageBody }, set: { messageBody = $0; bodyEdited = true }), axis: .vertical)
                        .lineLimit(4...10)
                        .padding(14)
                        .modifier(ReplyComposerSurface())
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("compose.body")
                }
                if recipientCount > 1 {
                    Section {
                        Text("将分别向 \(recipientCount) 个号码发送。提交后进入队列，由号码设备依次发送，不会建立群聊。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if recipientCount > 100 {
                    Section {
                        Text("每次最多选择 100 个号码，请移除多余收件人。").foregroundStyle(Color.callerDanger)
                            .reportsError(true, message: "每次最多选择 100 个号码，请移除多余收件人。", screen: "compose", site: "recipientLimit")
                    }
                }
                if availability.reason == nil, !availability.canSendSMS(on: selectedSIM) {
                    Section { Text("号码设备离线或短信能力未就绪，草稿仍可编辑。").font(.footnote).foregroundStyle(.secondary) }
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(Color.callerDanger)
                            .reportsError(error, screen: "compose", site: "send")
                    }
                }
            }
            .disabled(isSending)
            .scrollDismissesKeyboard(.interactively)
            .sheet(isPresented: $choosingContacts) {
                SMSContactPicker(recipients: $recipients, cachedContacts: $cachedContacts)
            }
            .navigationTitle("新短信")
            .navigationBarTitleDisplayMode(.inline)
            // 收件人 is a `.phonePad`, which has no return key: without a 完成 above it the keyboard had no
            // escape of its own.
            .keyboardDoneToolbar()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { saveCurrentDraft(); dismiss() }.disabled(isSending).accessibilityIdentifier("compose.cancel") }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSending ? "正在提交…" : (recipientCount > 1 ? "发送（\(recipientCount)）" : "发送")) { Task { await send() } }
                        .accessibilityIdentifier("compose.send")
                        .disabled(!canSend)
                }
            }
            .interactiveDismissDisabled(isSending)
            .onChange(of: session.sessionIdentity) { _, _ in
                loaded = false
                cachedContacts = []
                recipients = []
                number = ""
                messageBody = ""
                dismiss()
            }
            .onAppear {
                if !prefillConsumed {
                    draftAccountID = session.user?.id
                    draftSessionIdentity = session.sessionIdentity
                    number = ComposeMessagePrefillPolicy.number(initialNumber: initialNumber, draftNumber: number)
                    prefillConsumed = true
                }
                initializeDraft()
            }
            .onChange(of: sims.map(\.id)) { _, _ in initializeDraft() }
            // The bounce writes `pickerSelection`, never `selectedSIM`, so the draft store below never sees the
            // rejected SIM and cannot file the previous SIM's text under it.
            .onChange(of: pickerSelection) { oldValue, newValue in
                guard loaded else { return }
                let resolved = SIMPickerFallbackPolicy.resolveSMS(selected: newValue, previous: oldValue, sims: sims)
                if resolved != newValue {
                    error = SIMPickerFallbackPolicy.unavailableSMSMessage
                    pickerSelection = resolved
                    return
                }
                error = nil
                guard resolved != selectedSIM else { return }
                saveDraft(for: selectedSIM)
                let recipient = number
                selectedSIM = resolved
                loadDraft(for: resolved)
                number = recipient
            }
            .sensoryFeedback(.success, trigger: sendFeedback)
            .onChange(of: number) { _, _ in saveCurrentDraft() }
            .onChange(of: messageBody) { _, _ in saveCurrentDraft() }
            .onDisappear { saveCurrentDraft() }
        }
    }

    private func initializeDraft() {
        guard !loaded, !sims.isEmpty else { return }
        selectedSIM = SIMSelectionPolicy.preferredID(in: sims, current: initialSIM)
        pickerSelection = selectedSIM
        let editedNumber = number
        let editedBody = messageBody
        loadDraft(for: selectedSIM)
        number = editedNumber
        if bodyEdited { messageBody = editedBody }
        loaded = true
    }

    private func pickerLabel(_ sim: SIMChannel) -> String {
        SIMSelectionPolicy.canSendSMS(on: sim.id, sims: sims)
            ? simDisplayName(sim)
            : simDisplayName(sim) + SIMPickerFallbackPolicy.unavailableSuffix
    }

    private var recipientCount: Int { SMSRecipientPolicy.resolved(recipients, manual: number).count }

    private var canSend: Bool {
        loaded && session.sessionIdentity == draftSessionIdentity
            && availability.canSendSMS(on: selectedSIM)
            && SIMSelectionPolicy.canSendSMS(on: selectedSIM, sims: availability.sims)
            && (1...100).contains(recipientCount)
            && !messageBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSending
    }

    private func loadDraft(for simID: String?) {
        guard let accountID = draftAccountID, let simID else { messageBody = ""; return }
        let draft = drafts.compose(accountID: accountID, simID: simID)
        messageBody = draft.body
    }

    private func saveDraft(for simID: String?) {
        guard loaded, session.sessionIdentity == draftSessionIdentity, let accountID = draftAccountID, let simID else { return }
        drafts.saveCompose(.init(remoteNumber: "", body: messageBody), accountID: accountID, simID: simID)
    }

    private func saveCurrentDraft() { saveDraft(for: selectedSIM) }

    private func send() async {
        guard canSend, let simId = selectedSIM, let accountID = session.user?.id,
              let identity = session.sessionIdentity else { return }
        guard let submission = SMSSubmission(
            simID: simId, recipients: recipients, manual: number, body: messageBody
        ) else { return }
        isSending = true
        error = nil
        defer { isSending = false }
        do {
            switch submission {
            case .single(let payload):
                let key = try SMSIdempotencyStore.shared.key(accountID: accountID, payload: payload)
                let _: SMSResponse = try await session.request(
                    "sms/outbound", method: "POST", body: payload, idempotencyKey: key,
                    requiredSessionIdentity: identity
                )
                guard session.isCurrentSession(identity) else { return }
                SMSIdempotencyStore.shared.markSucceeded(accountID: accountID, payload: payload, idempotencyKey: key)
            case .batch(let payload):
                let key = try SMSIdempotencyStore.shared.key(accountID: accountID, payload: payload)
                let _: SMSBatchResponse = try await session.request(
                    "sms/batch", method: "POST", body: payload, idempotencyKey: key,
                    requiredSessionIdentity: identity
                )
                guard session.isCurrentSession(identity) else { return }
                SMSIdempotencyStore.shared.markSucceeded(accountID: accountID, payload: payload, idempotencyKey: key)
            }
            // Acknowledged enqueue is final for this attempt. Refresh errors cannot re-enqueue it.
            drafts.clearCompose(accountID: accountID, simID: simId)
            number = ""; recipients = []; messageBody = ""; loaded = false
            sendFeedback += 1
            await onSent()
            guard session.isCurrentSession(identity) else { return }
            dismiss()
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }
}

private struct SMSResponse: Decodable { let sms: SMSMessage }

func simTitle(_ simID: String?, in sims: [SIMChannel]) -> String {
    guard let simID else { return "SIM 未知" }
    guard let sim = sims.first(where: { $0.id == simID }) else { return "SIM \(simID.prefix(6))" }
    return sim.label ?? sim.phoneLabel ?? "SIM \((sim.slotIndex ?? 0) + 1)"
}

/// 通话行上“用的是自己哪条线”：号码（或名称）· 网关短标识。未接来电就是被叫的那条线。
func callLineTitle(_ simID: String?, in sims: [SIMChannel]) -> String? {
    guard let simID, let sim = sims.first(where: { $0.id == simID }) else { return nil }
    let name = [sim.phoneLabel, sim.label]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty } ?? "未命名号码"
    return "\(name) · \(simGatewayIdentity(sim, shortened: true))"
}

enum ConversationLineCaption {
    /// One-line SIM label for a conversation thread. No device/SIM ids and no info-circle banner.
    static func text(sim: SIMChannel?) -> String? {
        sim.map(simDisplayName)
    }
}

extension SMSMessage {
    var directionTitle: String {
        switch direction?.lowercased() {
        case "incoming": "收到"
        case "outgoing": "发出"
        default: "方向未知"
        }
    }

    var directionIcon: String { direction?.lowercased() == "incoming" ? "arrow.down.left" : "arrow.up.right" }

    var deliveryTitle: String {
        switch state?.lowercased() {
        case "queued", "pending":
            failureReason == "sms_gateway_execution_unresolved"
                ? "等待上一条短信状态确认" : "等待发送"
        case "sending": "发送中"
        case "sent": "已发送"
        // 已送达 only means something for what we sent; an incoming row in `delivered` reads 已收到 (Android Formatting.kt).
        case "delivered": direction?.lowercased() == "incoming" ? "已收到" : "已送达"
        case "received": "已接收"
        case "failed":
            switch failureReason {
            case "sms_not_dispatched": "短信未下发"
            case "sms_route_changed_before_release": "发送线路已变更，短信未下发"
            default: "发送失败"
            }
        case "unknown":
            failureReason == "sms_execution_unresolved"
                ? "发送结果待确认，请勿重复发送" : "状态待确认"
        case let value?: value
        case nil: "状态未知"
        }
    }

    /// S92: 「收到」 already says it arrived, so an incoming delivered/received row drops the state; anything else shows.
    var statusTitleForRow: String? {
        let delivered = ["delivered", "received"].contains(state?.lowercased() ?? "")
        return direction?.lowercased() == "incoming" && delivered ? nil : deliveryTitle
    }

    var statusDate: String? { deliveredAt ?? sentAt ?? receivedAt ?? createdAt }
}

private struct ReplyComposerSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
        } else if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 22))
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
        }
    }
}
