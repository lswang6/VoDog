import SwiftUI

/// Kept by the composer, so dismissing/reopening the picker offline retains downloaded contacts.
struct SMSContactPicker: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(\.dismiss) private var dismiss
    @Binding var recipients: [SMSRecipient]
    @Binding var cachedContacts: [Contact]
    @State private var selection: [SMSRecipient] = []
    @State private var initialized = false
    @State private var query = ""
    @State private var loaded = false
    @State private var error: String?
    @State private var nextOffset = 0
    @State private var hasMore = true
    @State private var isLoading = false
    @State private var requestToken = UUID()

    private var visibleContacts: [Contact] {
        cachedContacts.filter { SMSRecipientPolicy.matches($0, query: query) }
    }

    var body: some View {
        NavigationStack {
            List {
                Group {
                if availability.reason != nil { Section { NetworkAvailabilityNotice() } }
                if !loaded && cachedContacts.isEmpty && availability.canMutate {
                    ProgressView("正在读取通讯录…")
                }
                ForEach(visibleContacts) { contact in
                    Section {
                        if contact.phones.isEmpty {
                            Text("没有电话号码").foregroundStyle(.secondary)
                        }
                        ForEach(contact.phones) { phone in
                            let number = PhoneNumberText.normalized(phone.displayNumber)
                            let selected = selection.contains { $0.number == number }
                            Button {
                                if selected {
                                    selection.removeAll { $0.number == number }
                                } else {
                                    selection = SMSRecipientPolicy.adding(
                                        number: number, name: contact.displayName, to: selection
                                    )
                                }
                            } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(phone.displayNumber).foregroundStyle(.primary)
                                        if let label = phone.label, !label.isEmpty {
                                            Text(label).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(selected ? Color.callerAccent : Color.secondary)
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(number.isEmpty)
                            .accessibilityLabel("\(contact.displayName)，\(phone.displayNumber)")
                            .accessibilityValue(selected ? "已选择" : "未选择")
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .accessibilityIdentifier("compose.contactPhone.\(phone.id)")
                        }
                    } header: { Text(contact.displayName) }
                }
                if visibleContacts.isEmpty && (loaded || !availability.canMutate) {
                    Text(availability.canMutate ? "没有匹配的联系人" : "没有已缓存的匹配联系人；仍可手动输入号码。")
                        .foregroundStyle(.secondary)
                }
                if hasMore && availability.canMutate {
                    Button {
                        Task { await load(reset: false) }
                    } label: {
                        HStack {
                            Text(isLoading ? "正在载入…" : (error == nil ? "载入更多联系人" : "重试载入联系人"))
                            if isLoading { ProgressView() }
                        }.frame(minHeight: 44)
                    }
                    .disabled(isLoading)
                    .accessibilityIdentifier("compose.contacts.more")
                }
                if let error {
                    Text(error).font(.footnote).foregroundStyle(Color.callerDanger)
                        .reportsError(error, screen: "compose", site: "contact_picker")
                }
                Text("可选择多个联系人及每位联系人的多个号码。")
                    .font(.footnote).foregroundStyle(.secondary)
                }
                .listRowBackground(Signal.surface)
            }
            .signalList()
            .listStyle(.insetGrouped)
            .navigationTitle("选择收件人")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "搜索姓名或号码")
            .onAppear {
                if !initialized { selection = recipients; initialized = true }
            }
            // Native search can replace the navigation toolbar on iOS 27. Keep selection
            // actions in the content safe area so Done/Cancel remain reachable while searching.
            .safeAreaInset(edge: .top, spacing: 0) {
                SMSGlassControls {
                    HStack(spacing: 12) {
                        Button("取消") { dismiss() }
                            .frame(minHeight: 44)
                            .modifier(SMSGlassButton())
                            .accessibilityIdentifier("compose.contacts.cancel")
                        Spacer(minLength: 0)
                        Text("已选 \(selection.count) 个号码")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Button("完成") { recipients = selection; dismiss() }
                            .frame(minHeight: 44)
                            .modifier(SMSGlassButton(prominent: true))
                            .accessibilityIdentifier("compose.contacts.done")
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(Signal.bg)
            }
            .task(id: "\(session.sessionIdentity?.uuidString ?? "none"):\(query):\(availability.canMutate)") {
                await load(reset: true)
            }
        }
    }

    private func load(reset: Bool) async {
        guard availability.canMutate, let identity = session.sessionIdentity else { return }
        if !reset && isLoading { return }
        let token = UUID()
        requestToken = token
        if reset { nextOffset = 0; hasMore = true }
        let offset = nextOffset
        let requestedQuery = query
        isLoading = true
        defer { if requestToken == token { isLoading = false } }
        if !requestedQuery.isEmpty {
            do { try await Task.sleep(for: ContactLookupPolicy.debounce) } catch { return }
        }
        do {
            let response: ItemEnvelope<Contact> = try await session.request(
                "contacts", requiredSessionIdentity: identity,
                queryItems: SMSContactPagePolicy.query(query: requestedQuery, offset: offset)
            )
            guard !Task.isCancelled, requestToken == token, session.isCurrentSession(identity), query == requestedQuery else { return }
            // Search results augment the local snapshot; a failed refresh never clears it.
            for contact in response.items {
                if let index = cachedContacts.firstIndex(where: { $0.id == contact.id }) {
                    cachedContacts[index] = contact
                } else {
                    cachedContacts.append(contact)
                }
            }
            nextOffset = offset + response.items.count
            hasMore = response.items.count == ContactLookupPolicy.listLimit
            loaded = true
            error = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, requestToken == token, session.isCurrentSession(identity), query == requestedQuery else { return }
            loaded = true
            self.error = "通讯录暂时无法更新，已载入的联系人仍可选择。"
        }
    }
}

/// Group adjacent glass controls, without putting a second glass background behind them.
struct SMSGlassControls<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @ViewBuilder var content: Content
    var body: some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            GlassEffectContainer(spacing: 6) { content }
        } else {
            content
        }
    }
}

struct SMSGlassButton: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var prominent = false
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            if prominent { content.buttonStyle(.glassProminent) }
            else { content.buttonStyle(.glass) }
        } else {
            if prominent { content.buttonStyle(.borderedProminent) }
            else { content.buttonStyle(.bordered) }
        }
    }
}
