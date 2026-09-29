import SwiftUI

// VoDog 屏蔽与拦截 (spec S54, owner C2): blocked numbers on the left, the interception
// feed (`GET /blocklist/interceptions`) on the right. Unblock always confirms; 404 on DELETE means
// it was already removed elsewhere; emergency numbers (112/911) are never offered for blocking.

struct VoDogBlocklistView: View {
    @ObservedObject var account: VoDogAccount

    @State private var sidebarWidth: CGFloat = 300
    @State private var scope = "call"      // S66: 来电 / 短信 lists
    @State private var numbers: [VoDogBlockedNumber] = []
    @State private var numberSearch = ""
    @State private var numbersError: String?
    @State private var numbersLoaded = false

    @State private var kind = "all"
    @State private var page = 1
    @State private var totalPages: Int?
    @State private var interceptions: [VoDogInterception] = []
    @State private var feedError: String?
    @State private var feedLoaded = false
    @State private var feedGeneration = 0

    @State private var busy = false
    @State private var pendingUnblock: PendingUnblock?
    @State private var adding = false
    @State private var newNumber = ""
    @State private var addError: String?

    struct PendingUnblock: Identifiable {
        let id: String          // blocklist entry id
        let number: String
        let scope: String
    }

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            blockedPane.communicationSidebarColumnStyle()
        } detail: {
            feedPane.communicationDetailColumnStyle()
        }
        .task(id: scope) { await loadNumbers() }
        .task(id: "\(kind):\(page)") { await loadFeed() }
        .confirmationDialog(
            L10n.tr("解除屏蔽这个号码？"),
            isPresented: Binding(get: { pendingUnblock != nil }, set: { if !$0 { pendingUnblock = nil } }),
            titleVisibility: .visible,
            presenting: pendingUnblock
        ) { item in
            Button(L10n.tr("解除屏蔽")) { Task { await unblock(item.id) } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: { item in
            Text(item.scope == "sms" ? L10n.tr("解除后，%@ 的短信会恢复正常接收。", item.number)
                 : L10n.tr("解除后，%@ 的来电会恢复正常接收。", item.number))
        }
        .sheet(isPresented: $adding) { addSheet }
    }

    // MARK: Blocked numbers

    private var filteredNumbers: [VoDogBlockedNumber] {
        let query = numberSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return numbers }
        let digits = PhoneNumberNormalizer.normalized(query)
        return numbers.filter { item in
            (!digits.isEmpty && PhoneNumberNormalizer.normalized(item.remoteNumber).contains(digits))
                || item.remoteNumber.localizedCaseInsensitiveContains(query)
                || (item.contactName?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    private var blockedPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(L10n.tr("已屏蔽号码")).font(.headline)
                Spacer()
                CommunicationIconActionButton(systemImage: "plus", accessibilityLabel: L10n.tr("添加屏蔽号码")) {
                    newNumber = ""
                    addError = nil
                    adding = true
                }
            }
            .padding(.horizontal, 12)
            Picker(L10n.tr("已屏蔽号码"), selection: $scope) {
                Text(L10n.tr("来电")).tag("call")
                Text(L10n.tr("短信")).tag("sms")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .onChange(of: scope) { _, _ in
                numbers = []
                numbersLoaded = false
                numbersError = nil
            }
            TextField(L10n.tr("搜索号码或联系人"), text: $numberSearch)
                .communicationSearchField()
                .padding(.horizontal, 12)
            if let numbersError {
                Label(numbersError, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red)
                    .padding(.horizontal, 12)
            }
            List {
                ForEach(filteredNumbers) { item in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: item.remoteNumber).font(.body.monospacedDigit()).lineLimit(1)
                            let subtitle = [item.contactName, item.createdAt.map { localTime($0) }]
                                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                            if !subtitle.isEmpty {
                                Text(verbatim: subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                        Button(L10n.tr("解除屏蔽")) {
                            pendingUnblock = PendingUnblock(id: item.id, number: item.remoteNumber, scope: item.scope ?? scope)
                        }
                        .buttonStyle(.borderless)
                    }
                    .padding(.vertical, 3)
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .communicationSidebarScrollEdgeEffect()
            .disabled(busy)
            .overlay {
                if numbersLoaded && filteredNumbers.isEmpty && numbersError == nil {
                    PhoneEmptyState(title: numbers.isEmpty ? "没有屏蔽的号码" : "没有匹配的号码",
                                    detail: scope == "sms" ? "被屏蔽号码的短信会记录在右侧拦截记录中。"
                                        : "被屏蔽号码的来电会被直接挂断，并记录在右侧拦截记录中。",
                                    systemImage: "hand.raised")
                } else if !numbersLoaded {
                    ProgressView()
                }
            }
        }
    }

    private var addSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(scope == "sms" ? L10n.tr("添加到短信黑名单") : L10n.tr("添加到来电黑名单")).font(.headline)
            TextField(L10n.tr("号码"), text: $newNumber).textFieldStyle(.roundedBorder)
            if VoDogContactsLogic.isEmergency(newNumber) {
                Text(L10n.tr("急救号码不能屏蔽。")).font(.caption).foregroundStyle(.red)
                    .reportsVoDogError(L10n.tr("急救号码不能屏蔽。"))
            }
            if let addError {
                Text(verbatim: addError).font(.caption).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button(L10n.tr("取消"), role: .cancel) { adding = false }
                    .keyboardShortcut(.cancelAction)
                Button(L10n.tr("屏蔽")) { Task { await addNumber() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || !VoDogContactsLogic.canBlock(newNumber))
            }
        }
        .padding(20)
        .frame(width: 340)
    }

    // MARK: Interceptions

    private var feedPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(L10n.tr("拦截记录")).font(.title2.weight(.semibold))
                Spacer()
                Button {
                    Task { await loadFeed(); await loadNumbers() }
                } label: {
                    Label(L10n.tr("刷新"), systemImage: "arrow.clockwise")
                }
                .adaptiveGlassButton()
            }
            CommunicationGlassTabs(items: [("all", "全部"), ("call", "来电"), ("sms", "短信")], selection: $kind)
                .frame(maxWidth: 320)
                .onChange(of: kind) { _, _ in page = 1 }
            if let feedError {
                Label(feedError, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.red)
            }
            if feedLoaded && interceptions.isEmpty && feedError == nil {
                PhoneEmptyState(title: "没有拦截记录", detail: "被屏蔽号码的来电和短信会显示在这里。",
                                systemImage: "shield.lefthalf.filled")
            } else if !feedLoaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(interceptions) { item in interceptionRow(item) }
                    .listStyle(.inset)
                    .scrollContentBackground(.hidden)
            }
            if let totalPages, totalPages > 1 {
                HStack {
                    Button { page -= 1 } label: { Image(systemName: "chevron.left") }
                        .disabled(page <= 1)
                        .accessibilityLabel(L10n.tr("上一页"))
                    Text(L10n.tr("第 %lld / %lld 页", Int64(page), Int64(totalPages)))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Button { page += 1 } label: { Image(systemName: "chevron.right") }
                        .disabled(page >= totalPages)
                        .accessibilityLabel(L10n.tr("下一页"))
                }
                .buttonStyle(.borderless)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(20)
    }

    private func interceptionRow(_ item: VoDogInterception) -> some View {
        let number = item.remoteNumber ?? L10n.tr("未知号码")
        let title = item.contactName.map { "\($0) · \(number)" } ?? number
        let context = [
            L10n.tr(item.isSMS ? "短信" : "来电"),
            VoDogContactsLogic.sourceTitleKey(item.source).map { L10n.tr($0) },
            item.simLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
            VoDogContactsLogic.gatewayTime(item.occurredAt, timeZone: item.gatewayTimeZone)
        ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.isSMS ? "message.badge.filled.fill" : "phone.down.fill")
                .foregroundStyle(.red).frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: title).font(.body.weight(.medium).monospacedDigit()).lineLimit(1)
                Text(verbatim: context).font(.caption).foregroundStyle(.secondary)
                if let preview = item.bodyPreview, !preview.isEmpty {
                    Text(verbatim: preview).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if let entryID = item.blockedEntryId {
                Button(L10n.tr("解除屏蔽")) {
                    pendingUnblock = PendingUnblock(id: entryID, number: number, scope: item.isSMS ? "sms" : "call")
                }
                .buttonStyle(.borderless)
                .disabled(busy)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private func localTime(_ iso: String) -> String {
        guard let date = VoDogContactsLogic.parseISO(iso) else { return "" }
        return CommunicationUI.listTimestamp(date)
    }

    // MARK: Actions

    private func loadNumbers() async {
        do {
            let requested = scope
            let object = try await account.json("GET", "/blocklist", query: ["scope": requested])
            guard requested == scope else { return }
            numbers = try VoDogContactsLogic.decode(VoDogPage<VoDogBlockedNumber>.self, from: object).items
            numbersError = nil
        } catch is CancellationError {
            return
        } catch {
            numbersError = VoDogContactsUI.errorText(error)
        }
        numbersLoaded = true
    }

    private func loadFeed() async {
        feedGeneration += 1
        let generation = feedGeneration
        let requestedKind = kind
        let requestedPage = page
        do {
            let object = try await account.json("GET", "/blocklist/interceptions",
                query: VoDogContactsLogic.interceptionsQuery(page: requestedPage, kind: requestedKind))
            let result = try VoDogContactsLogic.decode(VoDogPage<VoDogInterception>.self, from: object)
            guard generation == feedGeneration else { return }
            interceptions = result.items
            totalPages = result.totalPages
            if let totalPages = result.totalPages, requestedPage > max(1, totalPages) { page = max(1, totalPages) }
            feedError = nil
        } catch is CancellationError {
            return
        } catch {
            guard generation == feedGeneration else { return }
            feedError = VoDogContactsUI.errorText(error)
        }
        feedLoaded = true
    }

    private func unblock(_ entryID: String) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await account.json("DELETE", "/blocklist/\(entryID)")
            numbersError = nil
        } catch where VoDogContactsUI.status(error) == 404 {
            numbersError = nil      // already removed elsewhere
        } catch is CancellationError {
            return
        } catch {
            numbersError = VoDogContactsUI.errorText(error)
            return
        }
        numbers.removeAll { $0.id == entryID }
        await loadNumbers()
        await loadFeed()
    }

    private func addNumber() async {
        let number = newNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard VoDogContactsLogic.canBlock(number) else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await account.json("POST", "/blocklist", body: ["remoteNumber": String(number.prefix(64)), "scope": scope])
            adding = false
            await loadNumbers()
            await loadFeed()
        } catch where VoDogContactsUI.status(error) == 400 {
            addError = VoDogErrorText.shown(L10n.tr("这个号码不能屏蔽。"), error: error)
        } catch is CancellationError {
            return
        } catch {
            addError = VoDogContactsUI.errorText(error)
        }
    }
}
