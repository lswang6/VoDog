import AppKit
import SwiftUI

// VoDog 记录与报告（S54 C3）。参照 iOS RecordsView.swift：左栏为通话记录 / 报告两种模式的分页列表，
// 右栏为同一个通话详情（事实、转录、AI 对话、录音播放与 mp3 导出、删除）。

struct VoDogRecordsView: View {
    @ObservedObject var account: VoDogAccount
    @StateObject private var player = VoDogRecordingPlayer()

    @Binding var sidebarWidth: CGFloat
    /// S67: the rail 通话 route keeps its 拨打新号码 button (nil in VoDog → 记录与报告).
    var onDial: (() -> Void)? = nil
    @State private var mode = 0 // 0 通话记录，1 报告
    @State private var query = ""
    @State private var simFilter = ""
    @State private var period: CCReportPeriod = .week
    @State private var sims: [CCSimItem] = []

    @State private var calls: [CCCallRecord] = []
    @State private var callsPage = 1
    @State private var callsTotalPages = 1
    @State private var reports: [CCReportItem] = []
    @State private var reportPage = 1
    @State private var reportTotalPages = 1
    @State private var loading = false
    @State private var listError: String?
    @State private var reloadToken = 0

    @State private var selectedID: String?

    private static let pageSize = 50

    private struct RequestKey: Equatable {
        var mode: Int, query: String, sim: String, period: CCReportPeriod, page: Int, token: Int
    }

    private var requestKey: RequestKey {
        RequestKey(mode: mode, query: query, sim: simFilter, period: period,
                   page: mode == 0 ? callsPage : reportPage, token: reloadToken)
    }

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            sidebar
        } detail: {
            detail.frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await loadSims() }
        .task(id: requestKey) { await loadList(debounce: true) }
        .onChange(of: query) { _, _ in callsPage = 1; reportPage = 1 }
        .onChange(of: simFilter) { _, _ in callsPage = 1; reportPage = 1 }
        .onChange(of: period) { _, _ in reportPage = 1 }
        .onDisappear { player.stop() }
    }

    // MARK: 左栏

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField(L10n.tr("搜索姓名或号码"), text: $query)
                    .communicationSearchField()
                if let onDial {
                    CommunicationIconActionButton(systemImage: "phone", accessibilityLabel: L10n.tr("拨打新号码"), tint: .green, action: onDial)
                }
            }
                .padding(.horizontal, 14)
                .padding(.bottom, 10)

            CommunicationGlassTabs(items: [(0, "通话记录"), (1, "报告")], selection: $mode)
                .overlay {
                    // S67: calls badge on the 通话记录 half (the two tabs are equal width).
                    HStack(spacing: 0) {
                        Color.clear.overlay(alignment: .topTrailing) {
                            VoDogBadgeCount(store: account.badges, kind: .calls).offset(x: -2, y: -6)
                        }
                        Color.clear
                    }
                    .allowsHitTesting(false)
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 8)

            HStack(spacing: 8) {
                Picker(L10n.tr("线路"), selection: $simFilter) {
                    Text(L10n.tr("全部线路")).tag("")
                    ForEach(sims) { Text($0.title).tag($0.id) }
                }
                .labelsHidden()
                if mode == 1 {
                    Picker(L10n.tr("时间范围"), selection: $period) {
                        ForEach(CCReportPeriod.allCases) { Text(L10n.tr($0.title)).tag($0) }
                    }
                    .labelsHidden()
                }
            }
            .controlSize(.small)
            .padding(.horizontal, 14)
            .padding(.bottom, 8)

            listBody

            pager.padding(.horizontal, 14).padding(.vertical, 8)
        }
        .communicationSidebarColumnStyle()
    }

    @ViewBuilder private var listBody: some View {
        let empty = mode == 0 ? calls.isEmpty : reports.isEmpty
        if let listError, empty {
            VStack(spacing: 10) {
                Label(listError, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                Button(L10n.tr("重试")) { reloadToken += 1 }.adaptiveGlassButton()
            }
            .font(.callout)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        } else if empty {
            VStack(spacing: 8) {
                if loading { ProgressView().controlSize(.small) }
                Text(L10n.tr(loading ? "正在读取…"
                    : !query.trimmingCharacters(in: .whitespaces).isEmpty ? "没有匹配的通话"
                    : mode == 0 ? "暂无通话记录" : "当前范围暂无通话"))
                    .font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                if mode == 0 {
                    ForEach(calls) { call in
                        VoDogBadgeReader(store: account.badges) { badges in
                            let unseen = call.showsUnseenDot(seen: badges.seenCalls)
                            // A Button so a cua-driver AX press selects the row exactly like a click.
                            Button { select(call.id) } label: {
                                VoDogCallRow(call: call, simTitle: simLine(call.simId), ownSIM: simTitle(call.simId), unseen: unseen)
                                    .communicationSelectionHighlight(selectedID == call.id)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel((unseen ? L10n.tr("未查看") + "，" : "")
                                + rowLabel(number: call.remoteNumber, name: call.internal == true ? recordTitle(call, ownSIM: simTitle(call.simId)) : call.contactName,
                                           state: call.isMissedIncoming ? "未接来电" : CCRecordLabels.state(call.state)))
                            .accessibilityAddTraits(selectedID == call.id ? .isSelected : [])
                        }
                        .listRowInsets(CommunicationUI.listRowInsets)
                    }
                } else {
                    ForEach(reports) { item in
                        VoDogBadgeReader(store: account.badges) { badges in
                            let unseen = item.showsUnseenDot(seen: badges.seenCalls)
                            Button { select(item.callId) } label: {
                                VoDogReportRow(item: item, simTitle: item.sim?.label ?? simTitle(item.sim?.id), unseen: unseen)
                                    .communicationSelectionHighlight(selectedID == item.callId)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel((unseen ? L10n.tr("未查看") + "，" : "")
                                + rowLabel(number: item.remoteNumber, name: item.internal == true ? recordTitle(item.asCallRecord, ownSIM: item.sim?.label) : item.contactName, state: nil))
                            .accessibilityAddTraits(selectedID == item.callId ? .isSelected : [])
                        }
                        .listRowInsets(CommunicationUI.listRowInsets)
                    }
                }
                if let listError {
                    Label(listError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .communicationSidebarScrollEdgeEffect()
        }
    }

    private var pager: some View {
        let page = mode == 0 ? callsPage : reportPage
        let total = mode == 0 ? callsTotalPages : reportTotalPages
        return HStack {
            Button { turnPage(-1) } label: { Image(systemName: "chevron.left") }
                .disabled(page <= 1 || loading)
                .help(L10n.tr("上一页"))
            Spacer()
            if loading { ProgressView().controlSize(.mini) }
            Text(L10n.tr("第 %lld / %lld 页", Int64(page), Int64(max(total, 1))))
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            Spacer()
            Button { turnPage(1) } label: { Image(systemName: "chevron.right") }
                .disabled(page >= total || loading)
                .help(L10n.tr("下一页"))
        }
        .buttonStyle(.borderless)
    }

    /// S67: selecting a call opens its detail and marks it seen directly (a `.task(id:)` would cancel the
    /// in-flight POST when another row is clicked quickly, leaving the first call unmarked).
    private func select(_ id: String) {
        selectedID = id
        let call = calls.first { $0.id == id } ?? reports.first { $0.callId == id }?.asCallRecord
        Task { await account.badges.markCallSeen(id, simID: call?.simId, pending: call?.unseen ?? call?.isBadgeCandidate ?? false) }
    }

    private func rowLabel(number: String?, name: String?, state: String?) -> String {
        var parts = [callerTitle(number: number, name: name)]
        if let name, !name.isEmpty, let number { parts.append(number) }
        if let state { parts.append(L10n.tr(state)) }
        return parts.joined(separator: "，")
    }

    private func turnPage(_ delta: Int) {
        if mode == 0 { callsPage = max(1, callsPage + delta) } else { reportPage = max(1, reportPage + delta) }
    }

    // MARK: 右栏

    @ViewBuilder private var detail: some View {
        if let selectedID {
            VoDogRecordDetail(
                account: account,
                player: player,
                callId: selectedID,
                seed: calls.first { $0.id == selectedID } ?? reports.first { $0.callId == selectedID }?.asCallRecord,
                report: reports.first { $0.callId == selectedID },
                simTitle: { simLine($0) },
                onBlocked: { reloadToken += 1 },
                onDeleted: {
                    calls.removeAll { $0.id == selectedID }
                    reports.removeAll { $0.callId == selectedID }
                    self.selectedID = nil
                    reloadToken += 1
                }
            )
            .id(selectedID)
        } else {
            PhoneEmptyState(
                title: "选择一条通话",
                detail: "可查看转录、AI 对话，播放或导出录音。",
                systemImage: mode == 0 ? "clock" : "chart.bar.xaxis"
            )
        }
    }

    // MARK: 数据

    private func simTitle(_ id: String?) -> String? {
        guard let id else { return nil }
        return sims.first { $0.id == id }?.title
    }

    /// 通话记录用：这通电话走的是哪张卡、哪台网关。
    private func simLine(_ id: String?) -> String? {
        guard let id else { return nil }
        return sims.first { $0.id == id }?.lineText
    }

    private func loadSims() async {
        await account.refreshSIMs()
        sims = account.sims.map { CCSimItem(id: $0.id, label: $0.label, phoneLabel: $0.phoneLabel, slotIndex: $0.slotIndex,
                                        gatewayId: $0.gatewayId, gatewayKind: $0.gatewayKind) }
    }

    private func loadList(debounce: Bool) async {
        let key = requestKey
        if debounce, !query.isEmpty {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
        }
        loading = true
        defer { if requestKey == key { loading = false } }
        var params = ["page": String(key.page), "pageSize": String(Self.pageSize)]
        let text = key.query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { params["query"] = String(text.prefix(64)) }
        if !key.sim.isEmpty { params["simId"] = key.sim }
        do {
            if key.mode == 0 {
                // S38：拦截掉的来电也要出现在记录里，否则服务器默认把它们藏起来。
                params["includeBlocked"] = "true"
                let page = try CCRecords.decode(CCCallsPage.self, from: try await account.json("GET", "/calls", query: params))
                guard !Task.isCancelled else { return }
                calls = page.items
                callsTotalPages = max(page.totalPages ?? 1, 1)
            } else {
                params["period"] = key.period.rawValue
                params["timeZone"] = TimeZone.current.identifier
                let page = try CCRecords.decode(CCReportPage.self, from: try await account.json("GET", "/reports/calls", query: params))
                guard !Task.isCancelled else { return }
                reports = page.items
                reportTotalPages = max(page.totalPages ?? 1, 1)
            }
            listError = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            listError = VoDogRecordsError.message(error)
        }
    }
}

// MARK: - 行

private struct VoDogCallRow: View {
    let call: CCCallRecord
    let simTitle: String?
    let ownSIM: String?
    let unseen: Bool

    var body: some View {
        HStack(spacing: 11) {
            VoDogUnreadDot(visible: unseen).padding(.trailing, -6)
            Image(systemName: call.showsBlockedMark ? "hand.raised.slash.fill"
                : call.isIncoming ? "phone.arrow.down.left" : "phone.arrow.up.right")
                .font(.system(size: 14, weight: .semibold))
                .selectionTint(call.showsBlockedMark || call.isMissedIncoming || call.state == "failed" ? Signal.danger : Signal.brand)
                .frame(width: 30, height: 30)
                .selectionBackground(Signal.brand, opacity: 0.10, in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(recordTitle(call, ownSIM: ownSIM))
                    .font(.callout.weight(.medium)).lineLimit(1)
                if let name = call.contactName, !name.isEmpty, let number = call.remoteNumber {
                    Text(number).font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(metaLine).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if !tags.isEmpty {
                    Text(tags.joined(separator: " · ")).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            Text(stateText)
                .font(.caption)
                .selectionTint(call.isMissedIncoming ? AnyShapeStyle(Signal.danger) : AnyShapeStyle(.secondary))
                .fixedSize()
        }
        .padding(.vertical, 4)
    }

    private var metaLine: String {
        var parts = [CCTime.gatewayClock(call.startedAt, zone: call.gatewayTimeZone)]
        if let simTitle { parts.append(simTitle) }
        if let duration = CCTime.duration(answeredAt: call.answeredAt, endedAt: call.endedAt) { parts.append(duration) }
        return parts.joined(separator: " · ")
    }

    private var tags: [String] { callTags(call) }

    /// S72: an active call reads "通话中 · 由 {端/设备名} 接听 · 自 hh:mm" (VoDog has no occupancy bar, S70c).
    private var stateText: String {
        if let occ = CCRecordLabels.occupancy(call) {
            return L10n.tr("通话中 · 由 %@ 接听 · 自 %@", occ.owner.isKey ? L10n.tr(occ.owner.text) : occ.owner.text, occ.since)
        }
        return L10n.tr(call.isMissedIncoming ? "未接来电" : CCRecordLabels.state(call.state))
    }
}

private struct VoDogReportRow: View {
    let item: CCReportItem
    let simTitle: String?
    let unseen: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 5) {
            VoDogUnreadDot(visible: unseen).padding(.top, 5)  // centred on the callout title line
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    Text(recordTitle(item.asCallRecord, ownSIM: item.sim?.label ?? simTitle))
                        .font(.callout.weight(.medium)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(CCTime.gatewayClock(item.startedAt, zone: item.gatewayTimeZone))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary).fixedSize()
                }
                Text(reportFacts(item, simTitle: simTitle)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                ReportBadges(item: item)
                let summary = CCRecordLabels.reportSummary(
                    transcriptState: item.transcriptState, errorCode: item.transcriptError?.code, summary: item.summary)
                Text(summary.placeholder ? L10n.tr(summary.text) : summary.text)
                    .font(.caption)
                    .foregroundStyle(summary.placeholder ? .secondary : .primary)
                    .lineLimit(3)
                ForEach(Array((item.actionItems ?? []).prefix(3).enumerated()), id: \.offset) { _, entry in
                    Text("• \(entry)").font(.caption2).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct ReportBadges: View {
    let item: CCReportItem

    var body: some View {
        HStack(spacing: 5) {
            switch CCRecordLabels.blockBadge(blockRecommended: item.blockRecommended, blockReason: item.blockReason) {
            case let .recommended(reason):
                pill(L10n.tr("推荐拦截"), color: .red)
                if let reason { pill(reason, color: .secondary) }
            case .unclassified:
                pill(L10n.tr("未分类"), color: .secondary)
            case .none:
                EmptyView()
            }
            if item.blocked == true { pill(L10n.tr("已屏蔽"), color: .red) }
            if item.hasAiTranscript == true { pill(L10n.tr("AI 对话"), color: .accentColor) }
        }
    }

    private func pill(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .selectionTint(color)
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .selectionBackground(color, opacity: 0.12, in: Capsule())
            .lineLimit(1)
    }
}

private func callerTitle(number: String?, name: String?) -> String {
    if let name = name?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return name }
    if let number = number?.trimmingCharacters(in: .whitespaces), !number.isEmpty { return number }
    return L10n.tr("未知号码")
}

/// S72: internal calls read "内部通话 A → B" (caller SIM → callee SIM) instead of a number.
private func recordTitle(_ call: CCCallRecord, ownSIM: String?) -> String {
    if let route = CCRecordLabels.internalRoute(call, ownSIM: ownSIM) {
        return L10n.tr("内部通话 %@ → %@", route.from, route.to)
    }
    return callerTitle(number: call.remoteNumber, name: call.contactName)
}

/// 接听端 / 来源 / AI 标签，列表与详情共用。
private func callTags(_ call: CCCallRecord) -> [String] {
    var tags: [String] = []
    if let badge = CCRecordLabels.badge(call) { tags.append(L10n.tr(badge)) }
    if let owner = CCRecordLabels.owner(call), call.answeredAt != nil || call.originatingPlatform != nil {
        let text = owner.isKey ? L10n.tr(owner.text) : owner.text
        if !tags.contains(text) { tags.append(text) }
    }
    if let ai = CCRecordLabels.aiHandling(call) { tags.append(L10n.tr(ai)) }
    return tags
}

private func reportFacts(_ item: CCReportItem, simTitle: String?) -> String {
    var parts = [simTitle.flatMap { $0.isEmpty ? nil : $0 } ?? L10n.tr("未知线路"),
                 L10n.tr(CCRecordLabels.direction(item.direction))]
    if let duration = CCTime.duration(answeredAt: item.answeredAt, endedAt: item.endedAt) { parts.append(duration) }
    parts.append(L10n.tr(CCRecordLabels.answerMethod(
        answerMode: item.answerMode, answeredByPlatform: item.answeredByPlatform, answeredAt: item.answeredAt)))
    return parts.joined(separator: " · ")
}

// MARK: - 详情

private struct VoDogRecordDetail: View {
    @ObservedObject var account: VoDogAccount
    @ObservedObject var player: VoDogRecordingPlayer
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var calls = VoDogCallStore.shared
    @AppStorage("VoDogPhone.sim.v1") private var storedSIM = ""
    let callId: String
    let seed: CCCallRecord?
    let report: CCReportItem?
    let simTitle: (String?) -> String?
    let onBlocked: () -> Void
    let onDeleted: () -> Void

    @State private var call: CCCallRecord?
    @State private var callError: String?
    @State private var transcript: CCTranscriptJob?
    @State private var transcriptLoaded = false
    @State private var transcriptError: String?
    @State private var aiItems: [CCAiTranscriptSegment] = []
    @State private var manifest: CCRecordingManifest?
    @State private var recordingLoaded = false
    @State private var recordingError: String?
    @State private var confirmingDelete = false
    @State private var confirmingBlock = false
    @State private var blocking = false
    @State private var deleting = false
    @State private var actionError: String?
    @State private var exporting: String?

    private var shown: CCCallRecord? { call ?? seed }

    var body: some View {
        ScrollView {
            AdaptiveGlassContainer(spacing: 16) {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if let report { reportCard(report) }
                    transcriptCard
                    if !aiItems.isEmpty { aiCard }
                    recordingCard
                    if let actionError {
                        Label(actionError, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
                .padding(24)
                .frame(maxWidth: 940, alignment: .leading)
            }
            .frame(maxWidth: .infinity)
        }
        .scrollContentBackground(.hidden)
        .communicationDetailColumnStyle()
        .task { await loadCall() }
        .task { await loadTranscript() }
        .task { await loadAi() }
        .task { await loadRecording() }
        .onDisappear { player.stop() }
        .confirmationDialog(L10n.tr("删除这条通话记录？"), isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(L10n.tr("删除"), role: .destructive) { Task { await deleteCall() } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: {
            Text(L10n.tr("通话记录、录音与转录将从服务器永久删除，所有设备同步消失。"))
        }
        .confirmationDialog(L10n.tr("屏蔽这个号码？"), isPresented: $confirmingBlock, titleVisibility: .visible) {
            Button(L10n.tr("屏蔽"), role: .destructive) { Task { await blockNumber() } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: {
            Text(L10n.tr("屏蔽后，%@ 的来电会被直接挂断。", remoteNumber))
        }
    }

    private var remoteNumber: String { (shown?.remoteNumber ?? "").trimmingCharacters(in: .whitespaces) }

    // 头部：号码、方向、时间、删除

    // 头部三层：图标与号码、整行操作按钮（与号码同行会被挤掉文字）、占满卡片宽度的事实表（放在号码列里会被挤成一字一行）。
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: shown?.showsBlockedMark == true ? "hand.raised.slash.fill"
                    : shown?.isIncoming == true ? "phone.arrow.down.left" : "phone.arrow.up.right")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(shown?.showsBlockedMark == true ? Color.red : Color.accentColor)
                    .frame(width: 54, height: 54)
                    .background(Circle().fill(Color.accentColor.opacity(0.12)))

                VStack(alignment: .leading, spacing: 4) {
                    Text(shown.map { call in recordTitle(call, ownSIM: account.sims.first { $0.id == call.simId }?.displayName) }
                         ?? callerTitle(number: nil, name: nil))
                        .font(.title3.weight(.semibold)).lineLimit(1).textSelection(.enabled)
                    if let name = shown?.contactName, !name.isEmpty, let number = shown?.remoteNumber {
                        Text(number).font(.callout.monospacedDigit()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                .layoutPriority(1)
            }
            // 放得下就一行，放不下两两换行，按钮文字始终完整。
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { callActions; manageActions }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) { callActions }
                    HStack(spacing: 8) { manageActions }
                }
            }
            .controlSize(.small)
            if let shown { facts(shown) }
            if let callError {
                Text(callError).font(.caption).foregroundStyle(.orange)
            }
        }
        .adaptiveGlassSurface(cornerRadius: 20, padding: 16)
    }

    @ViewBuilder private var callActions: some View {
        Button { Task { await redial() } } label: { Label(L10n.tr("拨打"), systemImage: "phone") }
            .adaptiveGlassButton()
            .disabled(remoteNumber.isEmpty || shown?.simId == nil || calls.active != nil || calls.busy)
        Button(action: openSMS) { Label(L10n.tr("发短信"), systemImage: "message") }
            .adaptiveGlassButton()
            .disabled(remoteNumber.isEmpty || shown?.simId == nil)
    }

    @ViewBuilder private var manageActions: some View {
        if shown?.blocked != true {
            Button { confirmingBlock = true } label: { Label(L10n.tr("屏蔽"), systemImage: "hand.raised") }
                .adaptiveGlassButton()
                .disabled(remoteNumber.isEmpty || blocking)
        }
        Button(role: .destructive) { confirmingDelete = true } label: {
            Label(L10n.tr("删除"), systemImage: "trash")
        }
        .adaptiveGlassButton()
        .tint(.red)
        .disabled(deleting)
    }

    @ViewBuilder private func facts(_ call: CCCallRecord) -> some View {
        let grid: [(String, String)] = {
            var rows: [(String, String)] = [
                (L10n.tr("方向"), L10n.tr(CCRecordLabels.direction(call.direction))),
                (L10n.tr("开始"), CCTime.gatewayClock(call.startedAt, zone: call.gatewayTimeZone)),
            ]
            if call.state != nil {
                rows.append((L10n.tr("状态"), L10n.tr(call.isMissedIncoming ? "未接来电" : CCRecordLabels.state(call.state))))
            }
            if let sim = simTitle(call.simId) { rows.append((L10n.tr("线路"), sim)) }
            rows.append((L10n.tr("时长"), CCTime.duration(answeredAt: call.answeredAt, endedAt: call.endedAt) ?? L10n.tr("未接通")))
            rows.append((L10n.tr("接听方式"), L10n.tr(CCRecordLabels.answerMethod(
                answerMode: call.answerMode, answeredByPlatform: call.answeredByPlatform, answeredAt: call.answeredAt))))
            let tags = callTags(call)
            if !tags.isEmpty { rows.append((L10n.tr("来源"), tags.joined(separator: " · "))) }
            if let zone = call.gatewayTimeZone { rows.append((L10n.tr("网关时区"), zone)) }
            return rows
        }()
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 3) {
            ForEach(Array(grid.enumerated()), id: \.offset) { _, row in
                GridRow {
                    Text(row.0).foregroundStyle(.secondary).fixedSize()
                    Text(row.1).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .font(.caption)
        .padding(.top, 4)
    }

    // 报告卡：分类与屏蔽建议

    private func reportCard(_ item: CCReportItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            cardTitle("报告", systemImage: "chart.bar.xaxis")
            ReportBadges(item: item)
            if let category = item.blockCategory, !category.isEmpty {
                Text(L10n.tr("分类：%@", category)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlassSurface(cornerRadius: 18, padding: 14)
    }

    // 转录

    private var transcriptCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            cardTitle("转录", systemImage: "text.bubble")
            if !transcriptLoaded {
                ProgressView().controlSize(.small)
            } else if let transcriptError {
                Label(transcriptError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
            } else if let transcript {
                transcriptStatus(transcript)
            } else {
                Text(L10n.tr("尚未生成转录")).font(.callout).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlassSurface(cornerRadius: 18, padding: 14)
    }

    @ViewBuilder private func transcriptStatus(_ job: CCTranscriptJob) -> some View {
        switch job.status {
        case "queued", "running":
            Label(L10n.tr("转录处理中"), systemImage: "hourglass").foregroundStyle(.secondary)
        case "retry":
            Label(L10n.tr("转录暂时失败，稍后会自动重试"), systemImage: "arrow.clockwise").foregroundStyle(.orange)
            if let next = job.nextAttemptAt {
                Text(L10n.tr("下次尝试：%@", CCTime.gatewayClock(next, zone: shown?.gatewayTimeZone)))
                    .font(.caption).foregroundStyle(.secondary)
            }
        case "failed":
            Label(L10n.tr("转录失败"), systemImage: "xmark.circle").foregroundStyle(.red)
                .reportsVoDogError(L10n.tr("转录失败"))
        case "succeeded":
            if let result = job.result { transcriptResult(result) }
            else {
                Label(L10n.tr("转录结果无效"), systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                    .reportsVoDogError(L10n.tr("转录结果无效"))
            }
        default:
            EmptyView()  // unknown server status: no raw enum on screen
        }
    }

    @ViewBuilder private func transcriptResult(_ result: CCTranscriptResult) -> some View {
        if let summary = result.summary, !summary.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text(L10n.tr("摘要")).font(.caption).foregroundStyle(.secondary)
                Text(summary).textSelection(.enabled)
            }
        }
        if let items = result.actionItems, !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.tr("待办")).font(.caption).foregroundStyle(.secondary)
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Label(item, systemImage: "checklist").textSelection(.enabled)
                }
            }
        }
        let blocks = CCTranscriptBlock.blocks(from: result.segments ?? [])
        if blocks.isEmpty {
            Text(result.text ?? "").textSelection(.enabled)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(L10n.tr(CCRecordLabels.speaker(track: block.track, speaker: block.speaker)))
                                .font(.caption.weight(.semibold))
                            if let start = block.startMs {
                                Text(CCTime.clock(start / 1000)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        Text(block.text).textSelection(.enabled)
                    }
                }
            }
        }
        Text(L10n.tr("机器转录供参考，可对照原始录音核实。")).font(.caption2).foregroundStyle(.secondary)
    }

    // AI 对话

    private var aiCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            cardTitle("AI 对话", systemImage: "sparkles")
            ForEach(Array(aiItems.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(L10n.tr(CCRecordLabels.aiRole(line.role)))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(line.role == "ai" ? Color.accentColor : Color.primary)
                        .frame(width: 64, alignment: .leading)
                    Text(line.text).textSelection(.enabled)
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlassSurface(cornerRadius: 18, padding: 14)
    }

    // 录音

    private var recordingCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            cardTitle("录音", systemImage: "waveform")
            if !recordingLoaded {
                ProgressView().controlSize(.small)
            } else if let recordingError {
                Label(recordingError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
            } else if let manifest {
                Text("\(L10n.tr(CCRecordLabels.recordingSource(manifest.source, gatewayKind: shown?.gatewayKind))) · \(CCTime.gatewayClock(manifest.finalizedAt, zone: shown?.gatewayTimeZone))")
                    .font(.caption).foregroundStyle(.secondary)
                if manifest.isEmptyCapture {
                    Label(L10n.tr("录音为空或采集失败，暂无法播放"), systemImage: "waveform.slash").foregroundStyle(.secondary)
                } else {
                    if !manifest.archiveComplete {
                        Label(L10n.tr("归档尚未完整发布。"), systemImage: "waveform.badge.exclamationmark")
                            .font(.caption).foregroundStyle(.orange)
                    } else if manifest.captureComplete == false {
                        Label(L10n.tr("录制期间存在缺音，仍可试听已保存内容。"), systemImage: "waveform.badge.exclamationmark")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if manifest.originals.count >= 2 {
                        trackRow("conversation", durationMs: nil, source: manifest.source,
                                 caption: L10n.tr("服务器按时间轴混合双方原声"))
                    }
                    ForEach(manifest.tracks.filter { $0.bytes > CCRecordingManifest.headerOnlyByteCeiling }, id: \.track) { track in
                        trackRow(track.track, durationMs: track.durationMs, source: manifest.source,
                                 caption: track.derived ? L10n.tr("派生听取轨，可能含补偿帧") : nil)
                    }
                    if let error = player.error {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                }
            } else {
                Text(L10n.tr("尚未生成录音")).font(.callout).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlassSurface(cornerRadius: 18, padding: 14)
    }

    private func trackRow(_ track: String, durationMs: Int64?, source: String, caption: String?) -> some View {
        let key = VoDogRecordingPlayer.Key(callId: callId, track: track, source: source)
        let active = player.isCurrent(key)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Button { player.toggle(key, account: account) } label: {
                    Image(systemName: active && player.isPlaying ? "pause.fill" : "play.fill")
                        .frame(width: 18, height: 18)
                }
                .adaptiveGlassButton(active ? .prominent : .regular)
                .help(L10n.tr("播放或暂停"))

                VStack(alignment: .leading, spacing: 1) {
                    Text(L10n.tr(CCRecordLabels.track(track))).font(.callout.weight(.medium))
                    if let caption { Text(caption).font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 8)
                if active && player.loading { ProgressView().controlSize(.small) }
                Text(active && player.duration > 0
                     ? "\(CCTime.clock(player.currentTime)) / \(CCTime.clock(player.duration))"
                     : durationMs.map { CCTime.clock(Double($0) / 1000) } ?? "")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Button {
                    Task { await export(track, source: source) }
                } label: {
                    Label(L10n.tr("导出 MP3"), systemImage: "square.and.arrow.down")
                }
                .adaptiveGlassButton()
                .controlSize(.small)
                .disabled(exporting != nil)
            }
            if active && player.duration > 0 {
                Slider(value: Binding(get: { player.currentTime }, set: { player.seek(to: $0) }),
                       in: 0 ... player.duration)
                    .controlSize(.small)
                    .accessibilityLabel(L10n.tr("播放进度"))
            }
        }
    }

    private func cardTitle(_ key: String, systemImage: String) -> some View {
        Label(L10n.tr(key), systemImage: systemImage).font(.headline)
    }

    // 数据

    private func loadCall() async {
        do {
            call = try CCRecords.decode(CCCallDetailEnvelope.self, from: try await account.json("GET", "/calls/\(callId)")).call
            callError = nil
        } catch is CancellationError {
        } catch {
            callError = VoDogRecordsError.message(error)
        }
    }

    private func loadTranscript() async {
        while !Task.isCancelled {
            do {
                transcript = try CCRecords.decode(
                    CCTranscriptEnvelope.self, from: try await account.json("GET", "/calls/\(callId)/transcript")
                ).transcript
                transcriptError = nil
            } catch is CancellationError {
                return
            } catch let error as VoDogAPIError where error.status == 404 {
                transcript = nil
            } catch {
                transcriptError = VoDogRecordsError.message(error)
            }
            transcriptLoaded = true
            // 处理中每 5 秒刷新一次，直到出结果或离开详情。
            guard let status = transcript?.status, ["queued", "running", "retry"].contains(status) else { return }
            try? await Task.sleep(for: .seconds(5))
        }
    }

    private func loadAi() async {
        guard let response = try? await account.json("GET", "/calls/\(callId)/ai-transcript"),
              let envelope = try? CCRecords.decode(CCAiTranscriptEnvelope.self, from: response) else { return }
        aiItems = envelope.items
    }

    /// 先取 Pixel 原始归档；503 / 404 / 空清单都退到媒体节点。
    private func loadRecording() async {
        var lastError: Error?
        for source in ["pixel", "media_node"] {
            do {
                let envelope = try CCRecords.decode(
                    CCRecordingEnvelope.self,
                    from: try await account.json("GET", "/calls/\(callId)/recordings", query: ["source": source])
                )
                if let recording = envelope.recording, !recording.tracks.isEmpty {
                    manifest = recording
                    recordingLoaded = true
                    return
                }
                lastError = nil
            } catch is CancellationError {
                return
            } catch {
                lastError = error
            }
        }
        if let error = lastError as? VoDogAPIError, error.status != 404, error.status != 503 {
            recordingError = VoDogRecordsError.message(error)
        } else if let error = lastError, !(error is VoDogAPIError) {
            recordingError = VoDogRecordsError.message(error)
        }
        recordingLoaded = true
    }

    private func export(_ track: String, source: String) async {
        exporting = track
        defer { exporting = nil }
        do {
            _ = try await VoDogRecordingExport.export(callId: callId, track: track, source: source, account: account)
            actionError = nil
        } catch {
            actionError = VoDogRecordsError.message(error)
        }
    }

    /// 同拨号盘：本机模组承载这张卡就直拨，否则经 Control 外呼；通话浮层随 `calls.active` 出现。
    private func redial() async {
        guard let simId = shown?.simId, !remoteNumber.isEmpty else { return }
        if let module = appState.localDialModuleID(simID: simId) {
            appState.dial(remoteNumber, moduleID: module)
            return
        }
        calls.bind(account)
        await calls.dial(simId: simId, number: remoteNumber)
        actionError = calls.active == nil ? calls.error : nil
    }

    /// 切到这张卡的短信页，由短信页打开这个号码的对话（没有就新建）。先写卡：换卡会清空已选对话。
    private func openSMS() {
        guard let simId = shown?.simId, !remoteNumber.isEmpty else { return }
        storedSIM = simId
        VoDogMessagesView.pendingRecipient = remoteNumber
        appState.showPhoneWindow(section: .messages)
    }

    private func blockNumber() async {
        blocking = true
        defer { blocking = false }
        do {
            _ = try await account.json("POST", "/blocklist",
                                       body: ["remoteNumber": String(remoteNumber.prefix(64)), "sourceCallId": callId,
                                              "scope": "call"])
            actionError = nil
            await loadCall()
            onBlocked()
        } catch let error as VoDogAPIError where error.status == 400 {
            actionError = VoDogErrorText.shown(L10n.tr("这个号码不能屏蔽。"), error: error)
        } catch {
            actionError = VoDogRecordsError.message(error)
        }
    }

    private func deleteCall() async {
        deleting = true
        defer { deleting = false }
        do {
            // DELETE 返回 204 无正文，用 data() 避免 JSON 解析。
            _ = try await account.data("DELETE", "/calls/\(callId)")
            player.stop()
            account.diag("records.delete", callId: callId)
            onDeleted()
        } catch {
            actionError = VoDogRecordsError.message(error)
        }
    }
}
