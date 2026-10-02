import SwiftUI

/// §B 拦截记录。
///
/// These rows exist because a number is on the blocklist: incoming calls were declined by the gateway and SMS
/// was never filed as a message. The body preview is kept for the owner (decision 4), and tapping a row opens
/// the same contact card the records list uses, where 解除屏蔽 lives.
struct InterceptionsView: View {
    /// S22 decision 10: 拦截记录 is now the third segment of 记录 rather than a pushed page. Embedded it keeps
    /// its own list, filter, refresh and contact card but leaves the navigation title to the host.
    var embedded = false
    /// 设置页只需要账号级屏蔽名单。它复用这里的加载、失败保留和解除确认，不复制第二套删除逻辑。
    var blocklistOnly = false
    /// S26: the host owns the page and the 类型 filter, because switching segments throws this view's own
    /// `@State` away — a page kept here would snap back to 1 every time 记录 came back to 拦截记录.
    var paging: RecordsPagingStore?
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase
    @State private var items: [Interception] = []
    @State private var blockedNumbers: [BlocklistItem] = []
    @State private var numberSearch = ""
    /// S66: 来电黑名单 and 短信黑名单 are two lists; the embedded records link always counts the call list.
    @State private var scope: BlocklistScope = .call
    @State private var blocklistLoaded = false
    @State private var blocklistError: String?
    @State private var pendingUnblock: BlocklistItem?
    @State private var unblockBusyID: String?
    @State private var blocklistLoadGeneration = 0
    @State private var interceptionsLoadGeneration = 0
    @State private var loaded = false
    @State private var error: String?
    @State private var snapshotCaption: String?
    @State private var card: ContactCardTarget?
    @State private var dataSessionIdentity: UUID?
    /// The fallback for the standalone (pushed) presentation, which has no host to keep state for it.
    @State private var ownPaging = RecordsPagingStore()

    private var store: RecordsPagingStore { paging ?? ownPaging }

    init(embedded: Bool = false, blocklistOnly: Bool = false, paging: RecordsPagingStore? = nil,
         cachedBlocklist: [BlocklistItem]? = nil, cachedSessionIdentity: UUID? = nil) {
        self.embedded = embedded
        self.blocklistOnly = blocklistOnly
        self.paging = paging
        if let cachedBlocklist, let cachedSessionIdentity {
            _blockedNumbers = State(initialValue: cachedBlocklist)
            _blocklistLoaded = State(initialValue: true)
            _dataSessionIdentity = State(initialValue: cachedSessionIdentity)
        }
    }

    var body: some View {
        if embedded {
            content
        } else {
            content
                .navigationTitle(blocklistOnly ? "已屏蔽号码" : "拦截记录")
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var content: some View {
        @Bindable var store = store
        return List {
            Group {
            if availability.reason != nil { Section { NetworkAvailabilityNotice() } }
            if blocklistOnly {
                Section {
                    Picker("名单", selection: $scope) {
                        ForEach(BlocklistScope.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .disabled(unblockBusyID != nil)
                    .accessibilityIdentifier("blocklist.scope")
                    TextField("搜索号码", text: $numberSearch)
                        .keyboardType(.phonePad)
                        .accessibilityIdentifier("blocklist.numberSearch")
                }
            }
            Section("已屏蔽号码") {
                if embedded && !blocklistOnly {
                    NavigationLink {
                        InterceptionsView(blocklistOnly: true,
                                          cachedBlocklist: blocklistLoaded ? blockedNumbers : nil,
                                          cachedSessionIdentity: dataSessionIdentity)
                    } label: {
                        if blocklistLoaded {
                            Text("管理已屏蔽号码（\(blockedNumbers.count)）")
                        } else {
                            HStack {
                                Text("管理已屏蔽号码")
                                Spacer()
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .accessibilityIdentifier("interceptions.blocklist")
                } else {
                    if !blocklistLoaded {
                        HStack(spacing: 8) { ProgressView(); Text("正在读取屏蔽名单…") }
                    } else if blockedNumbers.isEmpty, blocklistError == nil {
                        Text("暂无已屏蔽号码").foregroundStyle(.secondary)
                    }
                    ForEach(visibleBlockedNumbers) { item in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(ContactDisplay.numberWithName(number: item.remoteNumber, contactName: item.contactName))
                                    .monospacedDigit()
                                Text((item.source == "phone" ? "手机屏蔽 · " : "") + "屏蔽于 \(GatewayTimeDisplay.compact(item.createdAt, timeZone: GatewayTimeDisplay.resolvedTimeZone(callZone: nil)))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if unblockBusyID == item.id { ProgressView() }
                            else {
                                Button("解除", role: .destructive) { pendingUnblock = item }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(Color.callerDanger)
                                    .disabled(!availability.canMutate)
                                    .accessibilityIdentifier("blocklist.unblock")
                            }
                        }
                    }
                }
                if let blocklistError {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(blocklistError, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(Color.callerDanger)
                            .reportsError(blocklistError, screen: "interceptions", site: "blocklist")
                        Button("重试") { Task { await loadAll() } }.frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("blocklist.refreshError")
                }
            }
            if !blocklistOnly {
                Section {
                    Picker("类型", selection: $store.kind) {
                        ForEach(InterceptionKindFilter.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("interceptions.kind")
                } footer: {
                    Text("类型仅筛选本页已加载的记录，不改变全部号码范围。")
                }
                Section {
                    if let snapshotCaption, RecordSearchPolicy.showsSnapshotCaption(
                        query: "", page: store.page, stale: error != nil || !availability.canMutate
                    ) {
                        Text(snapshotCaption).font(.caption).foregroundStyle(.secondary)
                        if error != nil || !availability.canMutate {
                            Text("当前显示缓存内容；请求：第 \(store.page) 页 · 每页 \(store.pageSize) 条")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if !loaded {
                        HStack(spacing: 8) { ProgressView(); Text("正在读取拦截记录…") }
                    } else if visibleItems.isEmpty {
                        ContentUnavailableView {
                            Label("暂无拦截记录", systemImage: "hand.raised.slash")
                        } description: {
                            Text("被黑名单拦下的来电和短信会出现在这里。")
                        }
                    }
                    ForEach(visibleItems) { item in
                        Button { card = ContactCardTarget(interception: item) } label: { row(item) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("interceptions.row")
                    }
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(Color.callerDanger)
                            .reportsError(error, screen: "interceptions", site: "list")
                    }
                }
            }
            }
            .listRowBackground(Signal.surface)
        }
        .signalList()
        .keyboardDoneToolbar()
        .refreshable { await loadAll() }
        .onChange(of: scope) {
            // The other list's rows must not linger under this segment while its GET is in flight.
            blocklistLoadGeneration += 1
            blockedNumbers = []
            blocklistLoaded = false
            blocklistError = nil
            pendingUnblock = nil
            guard let identity = session.sessionIdentity else { return }
            Task { await loadBlocklist(requiredIdentity: identity) }
        }
        // S26: the page is part of the identity of what is being read, so turning one re-runs the load; the
        // 类型 filter is not, because the server has no such parameter and it stays a filter over the page.
        .task(id: RecordsRequestKey(page: store.page, pageSize: store.pageSize)) { await loadAll() }
        .task(id: "\(session.sessionIdentity?.uuidString ?? "none"):\(navigation.tab):\(scenePhase)") {
            guard (blocklistOnly ? navigation.tab == .settings : navigation.tab == .records),
                  scenePhase == .active else { return }
            await loadAll()
            while !Task.isCancelled,
                  (blocklistOnly ? navigation.tab == .settings : navigation.tab == .records),
                  scenePhase == .active {
                do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                await loadAll()
            }
        }
        .safeAreaInset(edge: .bottom) {
            if !blocklistOnly { PagerBar(store: store).disabled(!availability.canMutate || error != nil) }
        }
        .sheet(item: $card) { target in
            ContactCardView(target: target) { await loadAll() }
        }
        .confirmationDialog("解除屏蔽这个号码？", isPresented: Binding(
            get: { pendingUnblock != nil },
            set: { if !$0 { pendingUnblock = nil } }
        ), titleVisibility: .visible) {
            Button("解除屏蔽", role: .destructive) {
                if let item = pendingUnblock { Task { await unblock(item) } }
                pendingUnblock = nil
            }
            .disabled(!availability.canMutate)
            Button("取消", role: .cancel) { pendingUnblock = nil }
        } message: {
            Text(scope.unblockConfirmMessage)
            if let reason = availability.reason { Text(reason) }
        }
    }

    private var visibleBlockedNumbers: [BlocklistItem] {
        let query = PhoneNumberText.normalized(numberSearch)
        return query.isEmpty ? blockedNumbers : blockedNumbers.filter {
            PhoneNumberText.normalized($0.remoteNumber).contains(query)
        }
    }

    private var visibleItems: [Interception] {
        InterceptionKindFilter.apply(store.kind, to: items)
    }

    @ViewBuilder private func row(_ item: Interception) -> some View {
        HStack(spacing: 12) {
            Image(systemName: item.kindSymbol)
                .foregroundStyle(Color.callerDanger).frame(width: 26)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(ContactDisplay.numberWithName(number: item.remoteNumber, contactName: item.contactName))
                    .font(.body.weight(.medium)).monospacedDigit().lineLimit(1)
                Text(interceptionContext(item))
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("interceptions.simContext")
                if let preview = item.bodyPreview, !preview.isEmpty {
                    Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "info.circle").foregroundStyle(Color.callerAccent)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [
                ContactDisplay.numberWithName(number: item.remoteNumber, contactName: item.contactName),
                interceptionContext(item),
            ].filter { !$0.isEmpty }.joined(separator: "，")
        )
        .accessibilityHint("打开联系人卡片，可解除屏蔽")
    }

    private func interceptionContext(_ item: Interception) -> String {
        let time = GatewayTimeDisplay.compact(
            item.occurredAt,
            timeZone: GatewayTimeDisplay.resolvedTimeZone(callZone: item.gatewayTimeZone)
        )
        let label = item.simLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        return [item.kindTitle, item.sourceTitle, label, time]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func load(requiredIdentity identity: UUID) async {
        let requestedPage = store.page
        let requestedPageSize = store.pageSize
        interceptionsLoadGeneration += 1
        let generation = interceptionsLoadGeneration
        do {
            let response: PagedEnvelope<Interception> = try await session.request(
                "blocklist/interceptions",
                requiredSessionIdentity: identity,
                queryItems: RecordSearchPolicy.interceptionsQuery(page: requestedPage, pageSize: requestedPageSize)
            )
            guard !Task.isCancelled, generation == interceptionsLoadGeneration, session.isCurrentSession(identity),
                  store.page == requestedPage, store.pageSize == requestedPageSize else { return }
            // Rows first: `apply` may lower the page and re-key the `.task`, cancelling this one.
            items = response.items
            snapshotCaption = response.supported
                ? "已加载：第 \(response.page ?? requestedPage) 页 · 每页 \(response.pageSize ?? requestedPageSize) 条"
                : "已加载：全部拦截记录（未分页）"
            store.apply(
                page: response.page, total: response.total, totalPages: response.totalPages,
                requestedPage: requestedPage
            )
            error = nil
            loaded = true
        } catch APIError.server(404, _, _) {
            guard !Task.isCancelled, generation == interceptionsLoadGeneration, session.isCurrentSession(identity),
                  store.page == requestedPage, store.pageSize == requestedPageSize else { return }
            items = []
            snapshotCaption = nil
            store.clearPaging()
            error = nil
            loaded = true
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == interceptionsLoadGeneration, session.isCurrentSession(identity),
                  store.page == requestedPage, store.pageSize == requestedPageSize else { return }
            if items.isEmpty { store.clearPaging() }
            self.error = error.localizedDescription
            loaded = true
        }
    }

    private func loadAll() async {
        guard let identity = session.sessionIdentity else {
            clearSessionData()
            return
        }
        if dataSessionIdentity != identity {
            clearSessionData()
            dataSessionIdentity = identity
        }
        if !blocklistOnly { await load(requiredIdentity: identity) }
        await loadBlocklist(requiredIdentity: identity)
    }

    private func loadBlocklist(requiredIdentity identity: UUID) async {
        guard unblockBusyID == nil else { return }
        blocklistLoadGeneration += 1
        let generation = blocklistLoadGeneration
        let requestedScope = scope
        do {
            let response: ItemEnvelope<BlocklistItem> = try await session.request(
                "blocklist", requiredSessionIdentity: identity, queryItems: requestedScope.queryItems
            )
            guard !Task.isCancelled, generation == blocklistLoadGeneration, requestedScope == scope,
                  session.isCurrentSession(identity), unblockBusyID == nil else { return }
            blockedNumbers = response.items
            blocklistLoaded = true
            blocklistError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == blocklistLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            blocklistLoaded = true
            blocklistError = error.localizedDescription
        }
    }

    private func unblock(_ item: BlocklistItem) async {
        guard availability.canMutate else { return }
        guard unblockBusyID == nil, let identity = session.sessionIdentity else { return }
        // Invalidate a GET that may already be in flight so it cannot restore the removed row after this finishes.
        blocklistLoadGeneration += 1
        unblockBusyID = item.id
        do {
            let _: EmptyResponse = try await session.request(
                "blocklist/\(item.id)", method: "DELETE", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            blockedNumbers.removeAll { $0.id == item.id }
            blocklistError = nil
            unblockBusyID = nil
            if !blocklistOnly { await load(requiredIdentity: identity) }
        } catch APIError.server(404, _, _) {
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            blockedNumbers.removeAll { $0.id == item.id }
            blocklistError = nil
            unblockBusyID = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            blocklistError = error.localizedDescription
            unblockBusyID = nil
        }
    }

    private func clearSessionData() {
        blocklistLoadGeneration += 1
        interceptionsLoadGeneration += 1
        dataSessionIdentity = nil
        items = []
        snapshotCaption = nil
        blockedNumbers = []
        blocklistLoaded = false
        blocklistError = nil
        pendingUnblock = nil
        unblockBusyID = nil
        loaded = false
        error = nil
        card = nil
        store.clearPaging()
    }
}

enum InterceptionKindFilter: String, CaseIterable, Identifiable, Sendable {
    case all, call, sms

    var id: String { rawValue }
    var title: String {
        switch self { case .all: "全部"; case .call: "来电"; case .sms: "短信" }
    }

    static func apply(_ filter: Self, to items: [Interception]) -> [Interception] {
        switch filter {
        case .all: items
        case .call: items.filter { !$0.isSMS }
        case .sms: items.filter(\.isSMS)
        }
    }
}
