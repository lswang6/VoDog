import SwiftUI

struct MessagesWindowView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var model: MessagesWindowModel
    @ObservedObject var contacts: SystemContactStore
    @Binding var sidebarWidth: CGFloat
    var focusFirstItemRequest = false
    var didHandleFocusFirstItemRequest: () -> Void = {}

    @State private var selectedConversationID: MessageConversation.ID?
    @State private var searchText = ""
    @State private var isComposingNew = false
    @State private var newDestination = ""
    @FocusState private var listFocused: Bool

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            conversationSidebar
        } detail: {
            Group {
                if isComposingNew {
                    NewConversationView(
                        destination: $newDestination,
                        contacts: contacts
                    ) { destination in
                        selectConversation(for: destination)
                    }
                    .environmentObject(appState)
                } else if let conversation = selectedConversation {
                    MessageThreadView(
                        conversation: conversation,
                        contactName: contacts.displayName(for: conversation.address),
                        scrollTargetMessageID: model.requestedMessageID,
                        didRouteMessage: selectConversation(for:)
                    )
                    .environmentObject(appState)
                } else {
                    ContentUnavailableView(
                        L10n.tr("选择一段对话"),
                        systemImage: "message",
                        description: Text(L10n.tr("选择左侧会话，或新建短信。"))
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .communicationDetailColumnStyle()
        }
        .onAppear {
            if contacts.authorizationState == .notDetermined {
                contacts.requestAccess()
            } else if contacts.authorizationState.canReadContacts {
                contacts.reload()
            }
            handlePresentationRequest()
            chooseDefaultConversationIfNeeded()
            handleFocusFirstItemRequest()
        }
        .onChange(of: model.requestSerial) { _, _ in
            handlePresentationRequest()
        }
        .onChange(of: model.composeSerial) { _, _ in
            beginNewMessage()
        }
        .onChange(of: focusFirstItemRequest) { _, requested in
            if requested { handleFocusFirstItemRequest() }
        }
        .onChange(of: conversations.map(\.id)) { _, _ in
            chooseDefaultConversationIfNeeded()
        }
        .onChange(of: selectedConversationID) { _, _ in
            isComposingNew = false
            markSelectedConversationRead()
        }
    }

    private var conversationSidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(L10n.tr("短信")).font(.headline)
                Spacer(minLength: 6)
                moduleMenu
                Button(action: beginNewMessage) {
                    Image(systemName: "square.and.pencil").frame(width: 28, height: 28)
                }
                .buttonStyle(.borderless)
                .help(L10n.tr("新短信"))
                .accessibilityLabel(L10n.tr("新短信"))
            }
            .signalToolbar()

            TextField(L10n.tr("搜索联系人、号码或短信"), text: $searchText)
                .communicationSearchField()
                .padding(.horizontal, 10)
                .padding(.top, 10)
                .padding(.bottom, 4)

            List {
                if filteredConversations.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                } else {
                    ForEach(filteredConversations) { conversation in
                        ConversationRow(
                            conversation: conversation,
                            displayName: contacts.displayName(for: conversation.address)
                        )
                        .communicationSelectionHighlight(selectedConversationID == conversation.id)
                        .contentShape(Rectangle())
                        .onTapGesture { selectedConversationID = conversation.id }
                        .accessibilityAddTraits(
                            selectedConversationID == conversation.id ? .isSelected : []
                        )
                        .tag(conversation.id)
                        .contextMenu {
                            if SMSPDUEncoder.isValidDestination(conversation.address) {
                                Button(L10n.tr("呼叫"), systemImage: "phone") {
                                    CommunicationWindowController.shared.showPhone(
                                        number: conversation.address
                                    )
                                }
                            }
                            Button(L10n.tr("全部标为已读"), systemImage: "envelope.open") {
                                markConversationRead(conversation)
                            }
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .communicationEmphasizedSelection()
            .communicationInitialListFocus($listFocused)
            .scrollContentBackground(.hidden)
            .communicationSidebarScrollEdgeEffect()
            .safeAreaInset(edge: .bottom) {
                if appState.unreadCount > 0 {
                    HStack {
                        Text(L10n.tr("%lld 条未读", Int64(appState.unreadCount)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button(L10n.tr("全部已读")) { appState.markAllRead() }
                            .buttonStyle(.borderless)
                            .controlSize(.small)
                    }
                    .padding(10)
                }
            }
        }
        .communicationSidebarColumnStyle()
    }

    /// Toolbar line popup: the module used for sending (same choice as the module status card).
    private var moduleMenu: some View {
        Menu {
            ForEach(appState.cellularModules) { module in
                Button {
                    appState.selectCommunicationModule(module.id)
                } label: {
                    Text(verbatim: [appState.lineName(for: module.id), module.localizedDisplayName,
                                    AiBadge.menuSuffix(appState.accountSIM(for: module.id)?.settings)]
                        .compactMap { $0 }.joined(separator: " · "))
                }
                .disabled(!module.isCommunicationEligible)
            }
        } label: {
            HStack(spacing: 6) {
                LineBlock(color: appState.lineColor(for: appState.currentCommunicationModuleID), size: 8)
                Text(verbatim: appState.currentCommunicationModule.map {
                    appState.lineName(for: $0.id) ?? $0.localizedDisplayName
                } ?? L10n.tr("没有可用模组"))
                .lineLimit(1)
                AiBadge(settings: appState.accountSIM(for: appState.currentCommunicationModuleID)?.settings)
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .padding(.horizontal, 8)
        .frame(height: 28)
        .background(Signal.surface2, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .disabled(appState.cellularModules.isEmpty)
        .help(L10n.tr("短信和拨号使用所选模组"))
    }

    private var conversations: [MessageConversation] {
        MessageConversation.grouped(from: appState.messages)
    }

    private var filteredConversations: [MessageConversation] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return conversations }
        return conversations.filter { conversation in
            let name = contacts.displayName(for: conversation.address) ?? ""
            return name.localizedCaseInsensitiveContains(query) ||
                conversation.address.localizedCaseInsensitiveContains(query) ||
                conversation.messages.contains {
                    $0.body.localizedCaseInsensitiveContains(query)
                }
        }
    }

    private var selectedConversation: MessageConversation? {
        guard let selectedConversationID else { return nil }
        return conversations.first { $0.id == selectedConversationID }
    }

    private func handlePresentationRequest() {
        if let messageID = model.requestedMessageID,
           let message = appState.messages.first(where: { $0.id == messageID }) {
            let conversationID = MessageConversation.conversationID(
                for: message.peerAddress,
                moduleID: message.moduleID
            )
            selectedConversationID = conversationID
            isComposingNew = false
            if let conversation = conversations.first(where: { $0.id == conversationID }) {
                markConversationRead(conversation)
            } else {
                appState.markRead(message)
            }
            return
        }
        if let destination = model.requestedDestination, !destination.isEmpty {
            selectConversation(for: destination)
        }
    }

    private func selectConversation(for destination: String) {
        let id = MessageConversation.conversationID(
            for: destination,
            moduleID: appState.currentCommunicationModuleID
        )
        if conversations.contains(where: { $0.id == id }) {
            selectedConversationID = id
            isComposingNew = false
        } else {
            newDestination = destination
            selectedConversationID = nil
            isComposingNew = true
        }
    }

    private func beginNewMessage() {
        newDestination = ""
        isComposingNew = true
        selectedConversationID = nil
    }

    private func chooseDefaultConversationIfNeeded() {
        guard !isComposingNew else { return }
        if let selectedConversationID,
           conversations.contains(where: { $0.id == selectedConversationID }) {
            return
        }
        selectedConversationID = conversations.first?.id
    }

    private func markSelectedConversationRead() {
        guard let selectedConversation else { return }
        markConversationRead(selectedConversation)
    }

    private func markConversationRead(_ conversation: MessageConversation) {
        appState.markRead(
            conversation.messages.filter { !$0.isOutgoing && !$0.isRead }
        )
    }

    private func handleFocusFirstItemRequest() {
        guard focusFirstItemRequest else { return }
        isComposingNew = false
        selectedConversationID = filteredConversations.first?.id
        didHandleFocusFirstItemRequest()
        listFocused = false
        DispatchQueue.main.async {
            listFocused = true
        }
    }
}

private struct ConversationRow: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.signalRowSelected) private var rowSelected
    let conversation: MessageConversation
    let displayName: String?

    var body: some View {
        HStack(spacing: 10) {
            MessageConversationAvatar(
                title: presentedIdentity,
                address: conversation.address,
                size: 34
            )

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(verbatim: presentedIdentity)
                        .font(.body.weight(conversation.unreadCount > 0 ? .semibold : .regular))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 6)
                    if let date = conversation.latestMessage?.timestamp {
                        Text(verbatim: CommunicationUI.listTimestamp(date))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: true, vertical: false)
                            .layoutPriority(1)
                    }
                }
                HStack(spacing: 5) {
                    if let moduleName {
                        Text(verbatim: moduleName)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    if conversation.latestMessage?.isOutgoing == true {
                        Image(systemName: "arrowshape.turn.up.right.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(.secondary)
                    }
                    Text(verbatim: conversation.latestMessage?.preview ?? "")
                        .font(.caption)
                        .foregroundStyle(conversation.unreadCount > 0 ? .primary : .secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if conversation.unreadCount > 0 {
                        Text("\(conversation.unreadCount)")
                            .font(.caption2.bold())
                            .foregroundStyle(rowSelected ? Signal.brand : .white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(rowSelected ? Color.white : Signal.dangerFill, in: Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 3)
    }

    private var moduleName: String? {
        guard let moduleID = conversation.moduleID else { return nil }
        return appState.cellularModules.first(where: { $0.id == moduleID })?.displayName
    }

    private var presentedIdentity: String {
        CommunicationUI.displayText(displayName, conversation.address)
    }
}

private struct MessageThreadView: View {
    @EnvironmentObject private var appState: AppState
    let conversation: MessageConversation
    let contactName: String?
    let scrollTargetMessageID: SMSMessage.ID?
    let didRouteMessage: (String) -> Void

    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            threadHeader
            messageHistory
            Divider().overlay(Signal.line)
            composer
        }
    }

    private var threadHeader: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: presentedIdentity)
                    .font(.headline)
                    .lineLimit(1)
                Text(verbatim: sourceLine)
                    .font(.caption)
                    .foregroundStyle(Signal.ink3)
                    .lineLimit(1)
            }
            Spacer()
            if SMSPDUEncoder.isValidDestination(conversation.address) {
                Button {
                    CommunicationWindowController.shared.showPhone(number: conversation.address)
                } label: {
                    Image(systemName: "phone").frame(width: 28, height: 28)
                }
                .buttonStyle(.borderless)
                .help(L10n.tr("呼叫 %@", presentedIdentity))
                .accessibilityLabel(L10n.tr("呼叫 %@", presentedIdentity))
            }
            Menu {
                Button(L10n.tr("复制")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(conversation.address, forType: .string)
                }
                Button(L10n.tr("全部标为已读")) {
                    appState.markRead(conversation.messages.filter { !$0.isOutgoing && !$0.isRead })
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help(L10n.tr("更多"))
            .accessibilityLabel(L10n.tr("更多"))
        }
        .padding(.horizontal, 6)
        .signalToolbar()
    }

    /// 「号码 · 通过 X 接收」: the number when a contact name is shown, and the receiving module.
    private var sourceLine: String {
        let module = conversation.moduleID.flatMap { id in appState.cellularModules.first { $0.id == id } }
        let via = module.map { L10n.tr("通过 %@ 接收", appState.lineName(for: $0.id) ?? $0.localizedDisplayName) }
        return [contactName != nil ? CommunicationUI.displayText(conversation.address) : nil, via]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private var messageHistory: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(Array(conversation.messages.enumerated()), id: \.element.id) { index, message in
                        if shouldShowDate(at: index) {
                            Text(verbatim: message.timestamp.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .padding(.vertical, 5)
                        }
                        MessageBubble(message: message)
                            .id(message.id)
                            .contextMenu {
                                Button(L10n.tr("复制"), systemImage: "doc.on.doc") {
                                    appState.copy(message)
                                }
                                if !message.isOutgoing,
                                   SMSPDUEncoder.isValidDestination(message.sender) {
                                    Button(L10n.tr("回复"), systemImage: "arrowshape.turn.up.left") {
                                        composerFocused = true
                                    }
                                }
                                if message.isOutgoing, message.deliveryState == .failed {
                                    Button(L10n.tr("重新发送"), systemImage: "arrow.clockwise") {
                                        appState.sendSMS(
                                            to: conversation.address,
                                            body: message.body
                                        ) { _ in
                                            didRouteMessage(conversation.address)
                                        }
                                    }
                                    .disabled(
                                        appState.isSendingMessage(via: nil) ||
                                            appState.moduleHasCall(nil)
                                    )
                                }
                                Divider()
                                Button(L10n.tr("删除"), systemImage: "trash", role: .destructive) {
                                    appState.delete(message)
                                }
                            }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 16)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .onAppear {
                if let target = validScrollTarget {
                    proxy.scrollTo(target, anchor: .center)
                } else if let last = conversation.messages.last?.id {
                    proxy.scrollTo(last, anchor: .bottom)
                }
            }
            .onChange(of: scrollTargetMessageID) { _, id in
                guard let id, conversation.messages.contains(where: { $0.id == id }) else {
                    return
                }
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(id, anchor: .center)
                }
            }
            .onChange(of: conversation.messages.last?.id) { _, id in
                guard let id else { return }
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(id, anchor: .bottom)
                }
            }
        }
    }

    private var validScrollTarget: SMSMessage.ID? {
        guard let scrollTargetMessageID,
              conversation.messages.contains(where: { $0.id == scrollTargetMessageID }) else {
            return nil
        }
        return scrollTargetMessageID
    }

    private var presentedIdentity: String {
        CommunicationUI.displayText(contactName, conversation.address)
    }

    private var composer: some View {
        VStack(spacing: 5) {
            HStack(alignment: .center, spacing: 10) {
                TextField(L10n.tr("输入短信"), text: $draft, axis: .vertical)
                    .font(.body)
                    .textFieldStyle(.plain)
                    .lineLimit(1 ... 5)
                    .focused($composerFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .overlay {
                        RoundedRectangle(cornerRadius: 17, style: .continuous).strokeBorder(Signal.line, lineWidth: 1)
                    }

                Button(action: send) {
                    Group {
                        if appState.isSendingMessage(via: nil) {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up")
                        }
                    }
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Signal.onBrand)
                    .frame(width: 34, height: 34)
                    .background(Signal.brand, in: Circle())
                    .opacity(canSend ? 1 : 0.45)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.tr("发送"))
                .keyboardShortcut(.return, modifiers: [.command])
                .disabled(!canSend)
                .help(appState.moduleHasCall(nil) ? L10n.tr("当前模组通话期间会保存草稿，但不能发送短信") : L10n.tr("发送（⌘Return）"))
            }

            HStack {
                Text(verbatim: compositionStatus)
                Spacer()
                Text(verbatim: currentCommunicationStatus)
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
    }

    private var canSend: Bool {
        appState.moduleIsConnected(nil) &&
            !appState.moduleHasCall(nil) &&
            !appState.isSendingMessage(via: nil) &&
            !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            SMSPDUEncoder.segmentCount(destination: conversation.address, body: draft) != nil
    }

    private var compositionStatus: String {
        let count = draft.utf16.count
        guard let segments = SMSPDUEncoder.segmentCount(
            destination: conversation.address,
            body: draft
        ) else { return L10n.tr("%lld 个 UCS-2 单元", Int64(count)) }
        return L10n.tr("%lld 个单元 · %lld 条短信", Int64(count), Int64(segments))
    }

    private func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !body.isEmpty else { return }
        draft = ""
        appState.sendSMS(to: conversation.address, body: body) { _ in
            didRouteMessage(conversation.address)
        }
    }

    private var currentCommunicationStatus: String {
        guard let module = appState.currentCommunicationModule else {
            return L10n.tr("未选择通信模组")
        }
        return module.isCommunicationEligible
            ? L10n.tr("通过 %@ 发送", module.displayName)
            : L10n.tr("当前模组未就绪")
    }

    private func shouldShowDate(at index: Int) -> Bool {
        guard index > 0 else { return true }
        let current = conversation.messages[index].timestamp
        let previous = conversation.messages[index - 1].timestamp
        return current.timeIntervalSince(previous) > 15 * 60 ||
            !Calendar.current.isDate(current, inSameDayAs: previous)
    }
}

private struct MessageBubble: View {
    @EnvironmentObject private var appState: AppState
    let message: SMSMessage

    var body: some View {
        HStack(alignment: .bottom, spacing: 7) {
            if message.isOutgoing { Spacer(minLength: 70) }

            VStack(alignment: message.isOutgoing ? .trailing : .leading, spacing: 4) {
                Text(verbatim: (message.body.isEmpty ? L10n.tr("（空短信）") : message.body))
                    .textSelection(.enabled)
                    .signalBubble(outgoing: message.isOutgoing)

                if let code = message.verificationCode, !message.isOutgoing {
                    CopyCodeButton(code: code)
                }

                if message.isOutgoing {
                    Label {
                        Text(verbatim: deliveryText)
                    } icon: {
                        Image(systemName: deliveryIcon)
                    }
                        .font(.caption2)
                        .foregroundStyle(deliveryColor)
                        .help(message.localizedDeliveryDetail ?? deliveryText)
                }

                Text(message.timestamp.formatted(Date.FormatStyle(date: .omitted, time: .shortened)
                    .locale(AppLanguage.storedPreference.locale)))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if !message.isOutgoing { Spacer(minLength: 70) }
        }
        .frame(maxWidth: .infinity)
    }

    private var deliveryText: String {
        switch message.deliveryState {
        case .sending: return L10n.tr("发送中")
        case .sent: return L10n.tr("已发送")
        case .failed: return L10n.tr("发送失败")
        case .uncertain: return L10n.tr("状态未知")
        case .none: return L10n.tr("已发送")
        }
    }

    private var deliveryIcon: String {
        switch message.deliveryState {
        case .sending: return "clock"
        case .sent, .none: return "checkmark"
        case .failed: return "exclamationmark.circle.fill"
        case .uncertain: return "questionmark.circle.fill"
        }
    }

    private var deliveryColor: Color {
        switch message.deliveryState {
        case .failed: return .red
        case .uncertain: return .orange
        case .sending, .sent, .none: return .secondary
        }
    }
}

struct MessageConversationAvatar: View {
    let title: String
    let address: String
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(Signal.surface3)

            Text(verbatim: initial)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(Signal.ink2)
                .minimumScaleFactor(0.8)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var initial: String {
        title.first.map(String.init) ?? "?"
    }
}

private struct NewConversationView: View {
    @EnvironmentObject private var appState: AppState
    @Binding var destination: String
    @ObservedObject var contacts: SystemContactStore
    let didSend: (String) -> Void

    @State private var bodyText = ""
    @FocusState private var recipientFocused: Bool
    @FocusState private var bodyFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(L10n.tr("收件人："))
                    .foregroundStyle(.secondary)
                Group {
                    TextField(L10n.tr("姓名或电话号码"), text: $destination)
                }
                    .textFieldStyle(.plain)
                    .focused($recipientFocused)
            }
            .padding(14)

            if !contactSuggestions.isEmpty, !destination.isEmpty {
                HStack {
                    ForEach(contactSuggestions.prefix(3)) { contact in
                        Button {
                            destination = contact.primaryPhoneNumber ?? ""
                            bodyFocused = true
                        } label: {
                            Label {
                                Text(verbatim: CommunicationUI.displayText(contact.displayName, contact.primaryPhoneNumber, fallback: L10n.tr("未命名联系人")))
                            } icon: {
                                Image(systemName: "person.crop.circle")
                            }
                        }
                        .adaptiveGlassButton()
                    }
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
            }

            Divider()

            Spacer()

            VStack(spacing: 6) {
                HStack(alignment: .center, spacing: 10) {
                    TextField(L10n.tr("输入短信"), text: $bodyText, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1 ... 5)
                        .focused($bodyFocused)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .adaptiveGlassSurface(
                            cornerRadius: 17,
                            treatment: .clear,
                            isInteractive: true
                        )
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .frame(width: 18, height: 18)
                    }
                    .adaptiveGlassButton(.accented)
                    .buttonBorderShape(.circle)
                    .controlSize(.small)
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(!canSend)
                }
                HStack {
                    Text(L10n.tr("%lld 个 UCS-2 单元", Int64(bodyText.utf16.count)))
                    Spacer()
                    Text(L10n.tr("通过当前 SIM 卡发送"))
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
            .padding(16)
        }
        .onAppear { recipientFocused = destination.isEmpty }
    }

    private var contactSuggestions: [SystemContactRecord] {
        let query = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        return contacts.contacts.filter { contact in
            contact.displayName.localizedCaseInsensitiveContains(query) ||
                contact.phoneNumbers.contains { $0.value.localizedCaseInsensitiveContains(query) }
        }
    }

    private var canSend: Bool {
        appState.moduleIsConnected(nil) &&
            !appState.currentCommunicationModuleHasCall &&
            !appState.isSendingMessageOnCurrentModule &&
            SMSPDUEncoder.segmentCount(destination: destination, body: bodyText) != nil &&
            !bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let body = bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        bodyText = ""
        let recipient = destination
        appState.sendSMS(to: recipient, body: body) { _ in
            didSend(recipient)
        }
    }
}
