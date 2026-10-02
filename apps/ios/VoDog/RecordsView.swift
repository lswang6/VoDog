import SwiftUI
import UIKit

/// S22 decision 10. 记录 is three peer segments — 全部通话 / 报告 / 拦截记录 — instead of one list that opened
/// with a report block and buried 拦截记录 in a navigation row. iOS is the reference design for Android and
/// Web, so the layout is: a pinned segmented `Picker` under the 记录 title, then exactly one list per segment,
/// each owning its own search field, loading state and refresh.
struct RecordsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: RecordsTab = .calls

    // 全部通话
    @State private var calls: [CallRecord] = []
    @State private var callsLoaded = false
    @State private var callsError: String?
    @State private var callsSnapshotCaption: String?
    @State private var callQuery = ""
    /// S26. The three segments' paging state lives here, not in the lists: 拦截记录 is rebuilt from scratch on
    /// every segment switch, and 报告's list is too, so a page kept inside either would silently snap back to 1.
    @State private var callsPaging = RecordsPagingStore()
    @State private var reportPaging = RecordsPagingStore()
    @State private var interceptionsPaging = RecordsPagingStore()
    @State private var callsRequest = RecordsRequestKey()
    @State private var reportRequest = RecordsRequestKey()
    @State private var callsLoadGeneration = 0
    @State private var reportLoadGeneration = 0

    // 报告
    @State private var reportItems: [CallReportItem] = []
    @State private var reportLoaded = false
    @State private var reportLoading = false
    @State private var reportError: String?
    @State private var reportSnapshotCaption: String?
    @State private var reportQuery = ""
    @State private var preset: ReportDatePreset = ReportDateRangePolicy.default
    @State private var customFrom = Date()
    @State private var customTo = Date()
    @State private var blockBusyID: String?

    @State private var pendingBlock: PendingBlock?
    /// S30: the row waiting for 删除这条通话记录？. Its dialog hangs off the 全部通话 list rather than off the same
    /// view as the 屏蔽 one — two `confirmationDialog` modifiers on one view race, and only one of them wins.
    @State private var pendingDelete: CallRecord?
    @State private var deleteBusyID: String?
    @State private var media = CallMediaSession.shared
    @State private var sheetTarget: RecordSheet?
    /// S39 §E: the sheet's call was deleted elsewhere. Latched here rather than inside the sheet because the
    /// alert has to outlive the sheet it closes — and raised only in `onDismiss`, since SwiftUI drops an alert
    /// asked for while a sheet is still animating away.
    @State private var sheetDeletePending = false
    @State private var sheetDeletedElsewhere = false
    @State private var card: ContactCardTarget?

    /// The inline report shortcuts open the same sheets `RecordDetailView` does, keyed so switching rows re-presents.
    struct RecordSheet: Identifiable, Hashable {
        enum Kind: Hashable { case transcript, recording, aiConversation }
        let callID: String
        let kind: Kind
        let timeZone: String?
        var originatingPlatform: String? = nil
        var ownerJoinedLocal = false
        /// S58: 报告卡打开录音时也按网关类型标注设备归档（DJI 4G 而非 Pixel）。
        var gatewayKind: String? = nil
        var id: String { "\(callID)\u{001f}\(kind)" }
    }

    /// One confirmation for both surfaces: 全部通话 rows and 报告 cards block the same way, with the same
    /// wording, so they share one dialog rather than racing two `confirmationDialog` modifiers.
    private struct PendingBlock: Identifiable, Equatable {
        let id: String
        let remoteNumber: String
        let sourceCallID: String
        let fromReport: Bool
    }

    private var reportTimeZone: String {
        calls.compactMap(\.gatewayTimeZone).first { TimeZone(identifier: $0) != nil }
            ?? reportItems.compactMap(\.gatewayTimeZone).first { TimeZone(identifier: $0) != nil }
            ?? GatewayTimeDisplay.fallbackIANA
    }

    private var reportZone: TimeZone {
        GatewayTimeDisplay.resolvedTimeZone(callZone: reportTimeZone)
    }

    private var reportRange: (from: Date, to: Date) {
        ReportDateRangePolicy.range(for: preset, today: Date(), timeZone: reportZone)
            ?? ReportDateRangePolicy.ordered(from: customFrom, to: customTo)
    }

    /// What 全部通话 is listing, page aside. A change here — today only the debounced search text, plus the
    /// `simId` the server route already accepts — makes the current page meaningless and starts over at 1.
    private var callContentKey: String {
        RecordSearchPolicy.trimmed(callQuery)
    }

    /// Every input the report request depends on, so `.task(id:)` reloads on a preset, a custom date or a
    /// debounced search change and on nothing else.
    private var reportKey: String {
        let range = reportRange
        return [
            ReportDateRangePolicy.day(range.from, timeZone: reportZone),
            ReportDateRangePolicy.day(range.to, timeZone: reportZone),
            reportTimeZone,
            RecordSearchPolicy.trimmed(reportQuery),
        ].joined(separator: "\u{001f}")
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Text("全部号码 · 当前账号可查看的记录")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.top, 8)
                    .accessibilityIdentifier("records.scope")
                Picker("记录分类", selection: $tab) {
                    ForEach(RecordsTab.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .accessibilityIdentifier("records.tab")
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(uiColor: .systemGroupedBackground))
                switch tab {
                case .calls: callList
                case .reports: reportList
                case .interceptions: InterceptionsView(embedded: true, paging: interceptionsPaging)
                }
            }
            .navigationTitle("记录")
            .toolbarTitleDisplayMode(.inlineLarge)
            // The calls list is also what names the gateway time zone the report window is read in, so it loads
            // for every segment rather than only when 全部通话 is on screen.
            .task(id: callsRequest) { await loadCalls(debounced: callsRequest.debounced) }
            .task(id: "\(session.sessionIdentity?.uuidString ?? "none"):\(navigation.tab):\(scenePhase)") {
                guard navigation.tab == .records, scenePhase == .active else { return }
                await loadAll()
                while !Task.isCancelled, navigation.tab == .records, scenePhase == .active {
                    do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                    await loadAll()
                }
            }
            // S26: the content keys reset to page 1 and keep the 350 ms debounce; a page or page-size change
            // asks for the new page at once, which is why the flag is written into the key instead of derived.
            .onChange(of: callContentKey) { old, new in
                reloadCalls(content: new, reset: RecordsPagingPolicy.resetsPage(oldKey: old, newKey: new))
            }
            .onChange(of: callsPaging.page) { _, page in turnCallsPage(to: page) }
            .onChange(of: callsPaging.pageSize) { _, size in resizeCalls(to: size) }
            .onChange(of: reportKey) { old, new in
                reloadReport(reset: RecordsPagingPolicy.resetsPage(oldKey: old, newKey: new))
            }
            .onChange(of: reportPaging.page) { _, page in turnReportPage(to: page) }
            .onChange(of: reportPaging.pageSize) { _, size in resizeReport(to: size) }
            .confirmationDialog(
                HistoryRowActionPolicy.blockConfirmationTitle,
                isPresented: Binding(
                    get: { pendingBlock != nil },
                    set: { if !$0 { pendingBlock = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(HistoryRowActionPolicy.blockTitle, role: .destructive) {
                    if let pending = pendingBlock { Task { await block(pending) } }
                    pendingBlock = nil
                }
                .disabled(!availability.canMutate)
                Button("取消", role: .cancel) { pendingBlock = nil }
            } message: {
                Text(HistoryRowActionPolicy.blockConfirmationMessage)
                if let reason = availability.reason { Text(reason) }
            }
            .sheet(item: $card) { target in
                ContactCardView(target: target) { await loadAll() }
            }
            // Recording playback outlives the sheet unless it is stopped on dismiss, exactly as in the detail view.
            .sheet(item: $sheetTarget, onDismiss: {
                RecordingPlaybackController.shared.stop()
                if sheetDeletePending { sheetDeletePending = false; sheetDeletedElsewhere = true }
            }) { target in
                NavigationStack {
                    switch target.kind {
                    case .transcript:
                        TranscriptRecordView(callID: target.callID, gatewayTimeZone: target.timeZone)
                    case .recording:
                        RecordingRecordView(callID: target.callID, gatewayTimeZone: target.timeZone,
                                            gatewayKind: target.gatewayKind,
                                            originatingPlatform: target.originatingPlatform,
                                            ownerJoinedLocal: target.ownerJoinedLocal)
                    case .aiConversation:
                        AiConversationRecordView(callID: target.callID, gatewayTimeZone: target.timeZone)
                    }
                }
                // S39 §E: these three sheets have no by-id check of their own — this is it, for all three.
                .callExistenceGuard(callID: target.callID) {
                    RecordingPlaybackController.shared.stop()
                    sheetDeletePending = true
                    sheetTarget = nil
                }
            }
            .alert(CallExistencePolicy.deletedTitle, isPresented: $sheetDeletedElsewhere) {
                Button(CallExistencePolicy.deletedAcknowledgeButton, role: .cancel) {}
            } message: {
                Text(CallExistencePolicy.deletedMessage)
            }
            // S39 §F: an export whose share sheet was swiped away reports no completion; this is its sweep.
            .onAppear { ExportCleanupPolicy.prune() }
        }
    }

    // MARK: - 全部通话

    private var callList: some View {
        List {
            if let callsSnapshotCaption, RecordSearchPolicy.showsSnapshotCaption(
                query: callQuery, page: callsPaging.page, stale: callsError != nil || !availability.canMutate
            ) {
                Text(callsSnapshotCaption).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                if !callsLoaded {
                    HStack { ProgressView(); Text("正在读取通话记录…") }
                } else if calls.isEmpty, callsError == nil {
                    Label(
                        RecordSearchPolicy.trimmed(callQuery).isEmpty ? "暂无通话记录" : "没有匹配的通话",
                        systemImage: "clock"
                    ).foregroundStyle(.secondary)
                } else {
                    ForEach(calls) { call in
                        HStack(spacing: 0) {
                            NavigationLink { RecordDetailView(call: call) } label: { CallHistoryRow(call: call, sims: availability.sims) }
                                .accessibilityIdentifier("records.callDetail")
                            // §F: the "i" is a sibling of the link, not inside it, so it opens the card
                            // instead of pushing the detail page.
                            Button {
                                card = ContactCardTarget(call: call)
                            } label: {
                                Image(systemName: "info.circle")
                                    .font(.title3)
                                    .frame(width: 44, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("\(call.remoteNumber ?? "未知号码") 的联系人卡片")
                            .accessibilityIdentifier("records.contactCard")
                        }
                        .contextMenu { historyActions(for: call) }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) { historyActions(for: call) }
                    }
                }
                if let callsError {
                    Label(callsError, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Color.callerDanger)
                        .reportsError(callsError, screen: "records", site: "calls")
                }
            }
        }
        .searchable(text: Binding(get: { callQuery }, set: { if availability.canMutate { callQuery = $0 } }), prompt: RecordSearchPolicy.searchPrompt)
        // 下拉刷新 re-reads the page that is on screen; it is a refresh, not a jump back to the first page.
        .refreshable { await loadCalls(debounced: false) }
        .confirmationDialog(
            RecordDeletePolicy.confirmTitle,
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(RecordDeletePolicy.confirmButton, role: .destructive) {
                if let call = pendingDelete { Task { await deleteCall(call) } }
                pendingDelete = nil
            }
            .disabled(!availability.canMutate)
            Button(RecordDeletePolicy.cancelButton, role: .cancel) { pendingDelete = nil }
        } message: {
            Text(RecordDeletePolicy.confirmMessage)
            if let reason = availability.reason { Text(reason) }
        }
        .safeAreaInset(edge: .bottom) { PagerBar(store: callsPaging).disabled(!availability.canMutate || callsError != nil) }
    }
}

/// §F: a blocked row leads with the block icon, the number carries the matched contact name, and the state
/// stays on the right. `contactName` is absent on a pre-S21 Control, which simply prints the number alone.
///
/// Its own view so the paged list can be previewed without a session.
struct CallHistoryRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let call: CallRecord
    var sims: [SIMChannel] = []

    var body: some View {
        let unseen = UnreadDotPolicy.callUnseen(call, locallySeen: BadgeStore.shared.seenCallIDs)
        HStack(spacing: 12) {
            UnreadDot(visible: unseen)
            if call.showsBlockedMark {
                Image(systemName: ContactDisplay.blockedSymbol)
                    .foregroundStyle(Color.callerDanger).frame(width: 28)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: call.direction == "incoming" ? "phone.arrow.down.left" : "phone.arrow.up.right")
                    .foregroundStyle(call.state == "failed" ? Color.callerDanger : Color.accentColor).frame(width: 28)
            }
            VStack(alignment: .leading, spacing: 4) {
                // S36 C5-a: name on its own line, number below it — the accessibility label keeps the one-string form.
                RecentCallTitle(number: call.shownNumber(in: sims), contactName: call.shownContactName, nameFont: .headline)
                Text(gatewayClock(call.startedAt, zone: call.gatewayTimeZone)).font(.caption).foregroundStyle(.secondary)
                // S38: 通过手机拨打 / 忙线自动拒接 / 忙线 AI 代接 — 状态列写不下的那条手机侧事实。
                if let badge = call.s38BadgeTitle {
                    Text(badge).font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("records.callBadge")
                }
                if let line = callLineTitle(call.simId, in: sims) {
                    Text(line).font(.caption).foregroundStyle(.secondary)
                }
                // Accessibility sizes: the state moves under the text instead of squeezing it.
                if dynamicTypeSize.isAccessibilitySize { stateText }
            }
            Spacer()
            if !dynamicTypeSize.isAccessibilitySize { stateText }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(unseen ? "未查看，" : "")\(call.showsBlockedMark ? "已屏蔽，" : "")\(ContactDisplay.numberWithName(number: call.shownNumber(in: sims), contactName: call.shownContactName))，\(call.rowStateTitle)\(call.s38BadgeTitle.map { "，\($0)" } ?? "")\(callLineTitle(call.simId, in: sims).map { "，\($0)" } ?? "")"
        )
    }

    private var stateText: some View {
        Text(call.rowStateTitle).font(.caption).foregroundStyle(call.isMissedIncoming ? .red : .secondary)
    }
}

extension RecordsView {
    @ViewBuilder fileprivate func historyActions(for call: CallRecord) -> some View {
        let mediaLive = HistoryRowActionPolicy.mediaIsLive(callID: media.callID, state: media.state)
        // S30: 删除 is declared first on purpose. A trailing `swipeActions` lays its buttons out from the edge
        // inward in declaration order, so first declared is the one against the screen edge — the position the
        // spec asks for. The same order puts it at the top of the context menu, which is the price of both
        // surfaces sharing one action list.
        Button(role: .destructive) {
            pendingDelete = call
        } label: {
            Text(RecordDeletePolicy.actionTitle)
        }
        .tint(Color.callerDanger)
        .disabled(!availability.canMutate || deleteBusyID == call.id || !RecordDeletePolicy.canDelete(call))
        .accessibilityIdentifier(RecordDeletePolicy.accessibilityIdentifier)
        Button {
            redial(remoteNumber: call.remoteNumber, simID: call.simId)
        } label: {
            Label(HistoryRowActionPolicy.redialTitle, systemImage: "phone.fill")
        }
        .disabled(!availability.canDial(on: call.simId) || !HistoryRowActionPolicy.canRedial(remoteNumber: call.remoteNumber, simId: call.simId, mediaLive: mediaLive))
        Button {
            composeSMS(call)
        } label: {
            Label(HistoryRowActionPolicy.smsTitle, systemImage: "message.fill")
        }
        .disabled(!HistoryRowActionPolicy.canSendSMS(remoteNumber: call.remoteNumber, simId: call.simId))
        Button(role: .destructive) {
            pendingBlock = pending(remoteNumber: call.remoteNumber, callID: call.id, fromReport: false)
        } label: {
            Text(HistoryRowActionPolicy.blockTitle)
        }
        .tint(Color.callerDanger)
        .disabled(!availability.canMutate || !HistoryRowActionPolicy.canBlock(remoteNumber: call.remoteNumber))
    }

    // MARK: - 报告

    private var reportList: some View {
        List {
            Section { dateControl.disabled(!availability.canMutate) }
            if let reportSnapshotCaption, RecordSearchPolicy.showsSnapshotCaption(
                query: reportQuery, page: reportPaging.page, stale: reportError != nil || !availability.canMutate
            ) {
                Text(reportSnapshotCaption).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                if reportLoading && !reportLoaded {
                    HStack { ProgressView(); Text("正在读取报告…") }
                } else if let reportError {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("报告读取失败", systemImage: "exclamationmark.triangle").foregroundStyle(Color.callerDanger)
                        Text(reportError).font(.footnote).foregroundStyle(.secondary)
                        Button("重试") { Task { await loadReport() } }
                            .frame(minHeight: 44)
                    }
                    .reportsError(reportError, screen: "records", site: "report")
                }
                if reportItems.isEmpty, reportError == nil, reportLoaded {
                    VStack(alignment: .leading, spacing: 5) {
                        Label(
                            RecordSearchPolicy.trimmed(reportQuery).isEmpty ? "当前范围暂无通话" : "没有匹配的通话",
                            systemImage: "chart.bar.xaxis"
                        ).foregroundStyle(.secondary)
                        // S22: every call in the window gets a report row, so an empty list means the window
                        // itself is empty — never that a call was filtered out of the report.
                        Text("这段时间内的每通电话都会出现在这里。").font(.footnote).foregroundStyle(.secondary)
                    }
                } else if !reportItems.isEmpty {
                    ForEach(reportItems) { item in reportCard(item) }
                }
            }
        }
        .searchable(text: Binding(get: { reportQuery }, set: { if availability.canMutate { reportQuery = $0 } }), prompt: RecordSearchPolicy.searchPrompt)
        .refreshable { await loadReport(debounced: false) }
        .task(id: reportRequest) { await loadReport(debounced: reportRequest.debounced) }
        .safeAreaInset(edge: .bottom) { PagerBar(store: reportPaging).disabled(!availability.canMutate || reportError != nil) }
    }

    @ViewBuilder private var dateControl: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Menu {
                    Picker("日期范围", selection: $preset) {
                        ForEach(ReportDatePreset.allCases) { Text($0.title).tag($0) }
                    }
                } label: {
                    Label(preset.title, systemImage: "calendar")
                        .frame(minHeight: 44)
                }
                .accessibilityIdentifier("records.reportRange")
                Spacer()
                Text(rangeCaption).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            if preset == .custom {
                HStack(spacing: 10) {
                    DatePicker("开始", selection: $customFrom, displayedComponents: .date)
                        .datePickerStyle(.compact).labelsHidden()
                        .accessibilityLabel("开始日期")
                        .accessibilityIdentifier("records.reportFrom")
                    Text("至").font(.caption).foregroundStyle(.secondary)
                    DatePicker("结束", selection: $customTo, displayedComponents: .date)
                        .datePickerStyle(.compact).labelsHidden()
                        .accessibilityLabel("结束日期")
                        .accessibilityIdentifier("records.reportTo")
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var rangeCaption: String {
        let range = reportRange
        let from = ReportDateRangePolicy.day(range.from, timeZone: reportZone)
        let to = ReportDateRangePolicy.day(range.to, timeZone: reportZone)
        return from == to ? from : "\(from) 至 \(to)"
    }

    /// The reference report card. Line 1 names the caller and the clock, line 2 states the four facts that
    /// identify the call, the pills carry the classifier's verdict, then the summary, the to-dos and the four
    /// actions the card exists for.
    @ViewBuilder private func reportCard(_ item: CallReportItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink {
                RecordDetailView(
                    callID: item.callId, initialCall: calls.first { $0.id == item.callId }, report: item
                )
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    UnreadDot(
                        visible: UnreadDotPolicy.reportUnseen(item, locallySeen: BadgeStore.shared.seenCallIDs),
                        label: "未查看"
                    ).padding(.top, 6)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.titleText)
                                .font(.headline)
                                .monospacedDigit()
                                .lineLimit(2)
                                .layoutPriority(1)
                            Spacer(minLength: 4)
                            Text(gatewayClock(item.startedAt, zone: item.gatewayTimeZone))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        Text(ReportCardFacts.line(
                            simLabel: item.sim.label,
                            direction: item.direction,
                            duration: CallDurationLabel.text(answeredAt: item.answeredAt, endedAt: item.endedAt),
                            answerMethod: item.answerMethod
                        ))
                        .font(.caption).foregroundStyle(.secondary)
                        reportBadges(item)
                        reportSummary(item)
                        if !item.actionItems.isEmpty {
                            VStack(alignment: .leading, spacing: 3) {
                                ForEach(item.actionItems, id: \.self) { entry in
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text("•").foregroundStyle(.secondary)
                                        Text(entry)
                                    }
                                    .font(.caption)
                                }
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("待办：\(item.actionItems.joined(separator: "，"))")
                        }
                    }
                }
                .padding(.vertical, 3)
            }
            Divider()
            reportActions(item)
        }
    }

    @ViewBuilder private func reportBadges(_ item: CallReportItem) -> some View {
        switch ReportBlockBadgePolicy.badge(blockRecommended: item.blockRecommended, blockReason: item.blockReason) {
        case let .recommended(reason):
            HStack(spacing: 6) {
                pill(ReportBlockBadgePolicy.recommendedTitle, emphasis: .danger)
                if let reason { pill(reason, emphasis: .neutral) }
            }
        case .unclassified:
            Text(ReportBlockBadgePolicy.unclassifiedTitle).font(.caption2).foregroundStyle(.secondary)
        case .none:
            EmptyView()
        }
    }

    @ViewBuilder private func reportSummary(_ item: CallReportItem) -> some View {
        let presentation = ReportSummaryPolicy.presentation(
            transcriptState: item.transcriptState,
            transcriptErrorCode: item.transcriptError?.code,
            summary: item.summary
        )
        Text(presentation.text)
            .font(.subheadline)
            .lineLimit(ReportSummaryPolicy.summaryLineLimit)
            .foregroundStyle(presentation.isPlaceholder ? Color.secondary : Color.primary)
    }

    /// Outside the row's `NavigationLink` and `.plain`, so tapping one never triggers the push.
    /// S67c: the transcript / recording sheets count as opening the call, like the detail page (which marks itself).
    private func markReportSeen(_ item: CallReportItem) {
        guard item.direction != "outgoing" else { return }
        Task { await BadgeStore.shared.markCallSeen(item.callId, simID: item.sim.id, session: session) }
    }

    @ViewBuilder private func reportActions(_ item: CallReportItem) -> some View {
        HStack(spacing: 0) {
            if item.isBlocked {
                pill(ReportBlockBadgePolicy.blockedTitle, emphasis: .dangerOutline)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("records.reportBlocked")
            } else {
                Button {
                    pendingBlock = pending(
                        remoteNumber: item.remoteNumber, callID: item.callId, fromReport: true
                    )
                } label: {
                    Text(ReportBlockBadgePolicy.blockNowTitle)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .foregroundStyle(Color.callerDanger)
                .disabled(!availability.canMutate || blockBusyID == item.callId || !HistoryRowActionPolicy.canBlock(remoteNumber: item.remoteNumber))
                .accessibilityIdentifier("records.reportBlock")
            }
            Spacer(minLength: 8)
            Button {
                markReportSeen(item)
                sheetTarget = RecordSheet(
                    callID: item.callId,
                    kind: ReportTranscriptDestination.resolve(
                        hasAiTranscript: item.hasAiTranscript, transcriptState: item.transcriptState
                    ) == .aiConversation ? .aiConversation : .transcript,
                    timeZone: item.gatewayTimeZone
                )
            } label: {
                Text("查看转录").frame(minHeight: 44).contentShape(Rectangle())
            }
            .accessibilityIdentifier("records.reportTranscript")
            Spacer(minLength: 8)
            Button {
                markReportSeen(item)
                sheetTarget = RecordSheet(callID: item.callId, kind: .recording, timeZone: item.gatewayTimeZone,
                                          originatingPlatform: item.originatingPlatform,
                                          ownerJoinedLocal: item.ownerJoinedLocal, gatewayKind: item.gatewayKind)
            } label: {
                Text("查看录音").frame(minHeight: 44).contentShape(Rectangle())
            }
            .accessibilityIdentifier("records.reportRecording")
            Spacer(minLength: 8)
            Button {
                redial(remoteNumber: item.remoteNumber, simID: item.sim.id)
            } label: {
                Text(HistoryRowActionPolicy.redialTitle).frame(minHeight: 44).contentShape(Rectangle())
            }
            .disabled(!availability.canDial(on: item.sim.id) || !HistoryRowActionPolicy.canRedial(
                remoteNumber: item.remoteNumber, simId: item.sim.id,
                mediaLive: HistoryRowActionPolicy.mediaIsLive(callID: media.callID, state: media.state)
            ))
            .accessibilityIdentifier("records.reportRedial")
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(Color.callerAccent)
        .buttonStyle(.plain)
    }

    private enum PillEmphasis { case danger, dangerOutline, neutral }

    private func pill(_ text: String, emphasis: PillEmphasis) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(emphasis == .danger ? Color.white : (emphasis == .dangerOutline ? Color.callerDanger : Color.primary))
            .background {
                switch emphasis {
                case .danger: Capsule().fill(Color.callerDanger)
                case .dangerOutline: Capsule().strokeBorder(Color.callerDanger.opacity(0.6), lineWidth: 1)
                case .neutral: Capsule().fill(Color.secondary.opacity(0.16))
                }
            }
    }

    // MARK: - Actions

    private func pending(remoteNumber: String?, callID: String, fromReport: Bool) -> PendingBlock? {
        guard HistoryRowActionPolicy.canBlock(remoteNumber: remoteNumber), let remote = remoteNumber else { return nil }
        return PendingBlock(id: callID, remoteNumber: remote, sourceCallID: callID, fromReport: fromReport)
    }

    private func redial(remoteNumber: String?, simID: String?) {
        guard availability.canDial(on: simID) else { return }
        let mediaLive = HistoryRowActionPolicy.mediaIsLive(callID: media.callID, state: media.state)
        guard HistoryRowActionPolicy.canRedial(remoteNumber: remoteNumber, simId: simID, mediaLive: mediaLive),
              let simID, let remote = remoteNumber else { return }
        navigation.tab = .calls
        navigation.pendingRedial = HistoryRedialRequest(
            simID: simID, remoteNumber: PhoneNumberText.normalized(remote), token: UUID()
        )
    }

    private func composeSMS(_ call: CallRecord) {
        guard HistoryRowActionPolicy.canSendSMS(remoteNumber: call.remoteNumber, simId: call.simId),
              let remote = call.remoteNumber else { return }
        navigation.tab = .messages
        navigation.pendingCompose = HistoryComposeRequest(
            simID: call.simId, remoteNumber: PhoneNumberText.normalized(remote), token: UUID()
        )
    }

    /// `POST /blocklist` is idempotent, but the card flips locally so the row states the new truth immediately
    /// instead of waiting for a whole report reload.
    private func block(_ pending: PendingBlock) async {
        guard availability.canMutate else { return }
        guard let identity = session.sessionIdentity else { return }
        blockBusyID = pending.sourceCallID
        defer {
            if session.isCurrentSession(identity), blockBusyID == pending.sourceCallID { blockBusyID = nil }
        }
        do {
            let _: BlocklistItemEnvelope = try await session.request(
                "blocklist", method: "POST",
                body: BlocklistCreateBody(remoteNumber: pending.remoteNumber, sourceCallId: pending.sourceCallID, scope: .call),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity), blockBusyID == pending.sourceCallID else { return }
            for index in reportItems.indices where PhoneDialKey.matches(reportItems[index].remoteNumber ?? "", pending.remoteNumber) {
                reportItems[index].blocked = true
            }
            await loadCalls(debounced: false)
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity), blockBusyID == pending.sourceCallID else { return }
            if pending.fromReport { reportError = error.localizedDescription }
            else { callsError = error.localizedDescription }
        }
    }

    /// S30 §1.1. `DELETE /calls/:id` answers 204 and takes the recording, the transcript and the report entry
    /// with it, so the row, the report card and the page count are all corrected locally before the reload — the
    /// list must not flash the deleted row back while the request that proves it is gone is in flight.
    private func deleteCall(_ call: CallRecord) async {
        guard availability.canMutate else { return }
        guard let identity = session.sessionIdentity else { return }
        let id = call.id
        deleteBusyID = id
        defer {
            if session.isCurrentSession(identity), deleteBusyID == id { deleteBusyID = nil }
        }
        do {
            let _: EmptyResponse = try await session.request(
                "calls/\(id)", method: "DELETE", requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity), deleteBusyID == id else { return }
            calls = RecordDeletePolicy.callsAfterDelete(calls, id: id)
            reportItems = RecordDeletePolicy.reportItemsAfterDelete(reportItems, callID: id)
            callsError = nil
            let total = RecordDeletePolicy.totalAfterDelete(callsPaging.total)
            let totalPages = RecordDeletePolicy.totalPagesAfterDelete(
                total: total, totalPages: callsPaging.totalPages, pageSize: callsPaging.pageSize
            )
            let before = callsPaging.page
            callsPaging.apply(
                page: RecordDeletePolicy.pageAfterDelete(page: before, totalPages: totalPages),
                total: total, totalPages: totalPages, requestedPage: before
            )
            // Deleting the last row of the last page rewinds a page, and `.onChange(of: callsPaging.page)` already
            // asks for the new one. Only an unchanged page still needs a reload of its own.
            if callsPaging.page == before { await loadCalls(debounced: false) }
            // 报告 is driven by `call_records`, so the deleted call is gone from it too. Dropping the card locally
            // is not enough: its own 共 N 条 would stay one too high until the next report request, so a report
            // that has already been read is re-read here — the same rule Android's `deleteCall` follows.
            if reportLoaded { await loadReport(debounced: false) }
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity), deleteBusyID == id else { return }
            callsError = RecordDeletePolicy.errorMessage(error)
        }
    }

    // MARK: - Loading

    private func loadAll() async { await loadCalls(debounced: false); await loadReport(debounced: false) }

    private func loadCalls(debounced: Bool = true) async {
        let requestedQuery = callQuery
        let requestedPageSize = callsPaging.pageSize
        guard let identity = session.sessionIdentity else { return }
        // The same debounce the contacts list uses: one request per pause, not per keystroke.
        if debounced, !RecordSearchPolicy.trimmed(requestedQuery).isEmpty {
            do { try await Task.sleep(for: RecordSearchPolicy.debounce) } catch { return }
        }
        let requestedPage = callsPaging.page
        callsLoadGeneration += 1
        let generation = callsLoadGeneration
        do {
            let result: PagedEnvelope<CallRecord> = try await session.request(
                "calls",
                requiredSessionIdentity: identity,
                queryItems: RecordSearchPolicy.callsQuery(
                    query: requestedQuery, page: requestedPage, pageSize: requestedPageSize
                )
            )
            guard !Task.isCancelled, generation == callsLoadGeneration, session.isCurrentSession(identity),
                  callQuery == requestedQuery, callsPaging.page == requestedPage,
                  callsPaging.pageSize == requestedPageSize else { return }
            // Rows first, paging second: `apply` can lower the page (page 9 of a result that shrank to 3), which
            // cancels this task and starts the next one — the rows it just showed must already be on screen.
            calls = result.items; callsError = nil; callsLoaded = true
            callsSnapshotCaption = "已加载：\(requestedQuery.isEmpty ? "全部通话" : requestedQuery) · 第 \(result.page ?? requestedPage) 页"
            callsPaging.apply(
                page: result.page, total: result.total, totalPages: result.totalPages, requestedPage: requestedPage
            )
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == callsLoadGeneration, session.isCurrentSession(identity),
                  callQuery == requestedQuery, callsPaging.page == requestedPage,
                  callsPaging.pageSize == requestedPageSize else { return }
            if calls.isEmpty { callsPaging.clearPaging() }
            callsError = error.localizedDescription; callsLoaded = true
        }
    }

    private func loadReport(debounced: Bool = true) async {
        let requestedKey = reportKey
        let requestedQuery = reportQuery
        let requestedPageSize = reportPaging.pageSize
        guard let identity = session.sessionIdentity else { return }
        if debounced, !RecordSearchPolicy.trimmed(requestedQuery).isEmpty {
            do { try await Task.sleep(for: RecordSearchPolicy.debounce) } catch { return }
        }
        reportLoading = true; reportError = nil
        defer {
            if !Task.isCancelled, session.isCurrentSession(identity) { reportLoading = false }
        }
        let range = reportRange
        let requestedPage = reportPaging.page
        reportLoadGeneration += 1
        let generation = reportLoadGeneration
        do {
            let result: CallReportEnvelope = try await session.request(
                "reports/calls",
                requiredSessionIdentity: identity,
                queryItems: RecordSearchPolicy.reportQuery(
                    from: ReportDateRangePolicy.day(range.from, timeZone: reportZone),
                    to: ReportDateRangePolicy.day(range.to, timeZone: reportZone),
                    timeZone: reportTimeZone,
                    query: requestedQuery,
                    page: requestedPage,
                    pageSize: requestedPageSize
                )
            )
            guard !Task.isCancelled, generation == reportLoadGeneration, session.isCurrentSession(identity),
                  reportKey == requestedKey, reportPaging.page == requestedPage,
                  reportPaging.pageSize == requestedPageSize else { return }
            // Same order as 全部通话: the cards land before `apply` is allowed to re-key the task.
            reportItems = result.items; reportLoaded = true
            reportSnapshotCaption = "已加载：\(ReportDateRangePolicy.day(range.from, timeZone: reportZone)) 至 \(ReportDateRangePolicy.day(range.to, timeZone: reportZone)) · \(requestedQuery.isEmpty ? "全部" : requestedQuery) · 第 \(result.page) 页"
            reportPaging.apply(
                page: result.page, total: result.total, totalPages: result.totalPages, requestedPage: requestedPage
            )
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == reportLoadGeneration, session.isCurrentSession(identity),
                  reportKey == requestedKey, reportPaging.page == requestedPage,
                  reportPaging.pageSize == requestedPageSize else { return }
            reportLoaded = true
            reportError = error.localizedDescription
        }
    }

    // MARK: - 分页

    /// A content change: back to page 1, and still debounced because it is usually a keystroke.
    private func reloadCalls(content: String, reset: Bool) {
        if reset { callsPaging.goToFirstPage() }
        callsRequest = RecordsRequestKey(
            content: content, page: callsPaging.page, pageSize: callsPaging.pageSize, debounced: true
        )
    }

    /// A page turn is a deliberate tap, so it goes out at once. The guard is what keeps the page-1 reset a
    /// content change just wrote from being re-sent undebounced.
    private func turnCallsPage(to page: Int) {
        guard page != callsRequest.page else { return }
        callsRequest = RecordsRequestKey(
            content: callContentKey, page: page, pageSize: callsPaging.pageSize, debounced: false
        )
    }

    private func resizeCalls(to pageSize: Int) {
        callsPaging.goToFirstPage()
        callsRequest = RecordsRequestKey(
            content: callContentKey, page: RecordsPagingPolicy.firstPage, pageSize: pageSize, debounced: false
        )
    }

    private func reloadReport(reset: Bool) {
        if reset { reportPaging.goToFirstPage() }
        reportRequest = RecordsRequestKey(
            content: reportKey, page: reportPaging.page, pageSize: reportPaging.pageSize, debounced: true
        )
    }

    private func turnReportPage(to page: Int) {
        guard page != reportRequest.page else { return }
        reportRequest = RecordsRequestKey(
            content: reportKey, page: page, pageSize: reportPaging.pageSize, debounced: false
        )
    }

    private func resizeReport(to pageSize: Int) {
        reportPaging.goToFirstPage()
        reportRequest = RecordsRequestKey(
            content: reportKey, page: RecordsPagingPolicy.firstPage, pageSize: pageSize, debounced: false
        )
    }
}

/// What one 全部通话 / 报告 request is made of.
///
/// It is written by the `.onChange` handlers instead of being computed from the view's state so that a page
/// turn can say "this one is not a keystroke, do not wait 350 ms" while a typed character still debounces.
struct RecordsRequestKey: Equatable, Sendable {
    var content: String = ""
    var page: Int = RecordsPagingPolicy.firstPage
    var pageSize: Int = RecordsPagingPolicy.defaultPageSize
    var debounced: Bool = false
}

struct RecordDetailView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(UIAvailabilityState.self) private var availability
    let callID: String
    @State private var call: CallRecord?
    @State private var detailError: String?
    @State private var showingTranscript = false
    @State private var showingRecording = false
    @State private var card: ContactCardTarget?
    @State private var aiTranscript: [AiTranscriptSegment] = []
    @State private var aiTranscriptError: String?
    @State private var reportTranscript: TranscriptJob?
    @State private var reportTranscriptError: String?
    @State private var hasObservedReportTranscript = false
    @State private var deletedElsewhere = false
    @State private var detailLoadGeneration = 0
    @State private var transcriptLoadGeneration = 0
    @State private var reportTranscriptLoadGeneration = 0

    /// S22: when the detail page is opened from a report card, the card's row comes with it so the same
    /// 接听方式/推荐拦截/摘要 facts are visible here without a second request.
    let report: CallReportItem?

    init(call: CallRecord) { callID = call.id; report = nil; _call = State(initialValue: call) }
    init(callID: String, initialCall: CallRecord? = nil, report: CallReportItem? = nil) {
        self.callID = callID; self.report = report; _call = State(initialValue: initialCall)
    }

    private var visibleReportTranscriptState: String? {
        hasObservedReportTranscript ? (reportTranscript?.status ?? "none") : report?.transcriptState
    }

    private var visibleReportTranscriptErrorCode: String? {
        hasObservedReportTranscript ? reportTranscript?.error?.code : report?.transcriptError?.code
    }

    private var visibleReportSummary: String? {
        guard hasObservedReportTranscript else { return report?.summary }
        return reportTranscript?.status == "succeeded" ? reportTranscript?.result?.summary : nil
    }

    private var visibleReportActionItems: [String] {
        guard hasObservedReportTranscript else { return report?.actionItems ?? [] }
        return reportTranscript?.status == "succeeded" ? (reportTranscript?.result?.actionItems ?? []) : []
    }

    private var visibleReportBlockRecommended: Bool? {
        guard hasObservedReportTranscript else { return report?.blockRecommended }
        guard reportTranscript?.status == "succeeded" else { return nil }
        return reportTranscript?.result?.blockRecommended
    }

    private var visibleReportBlockReason: String? {
        guard hasObservedReportTranscript else { return report?.blockReason }
        guard reportTranscript?.status == "succeeded" else { return nil }
        return reportTranscript?.result?.blockReason
    }

    var body: some View {
        List {
            // §F / user item 2.2: 拨打 / 短信 / 信息 sit above the facts, so the two things a record is usually
            // opened for do not need a scroll or a long press.
            Section {
                ContactActionRow(
                    number: call?.remoteNumber, simID: call?.simId, navigation: navigation
                ) {
                    if let call { card = ContactCardTarget(call: call) }
                }
                .disabled(call == nil)
            }
            if let call {
                Section("通话") {
                    LabeledContent("号码", value: ContactDisplay.numberWithName(
                        number: call.shownNumber(in: availability.sims), contactName: call.shownContactName
                    ))
                    if call.showsBlockedMark {
                        Label("已屏蔽", systemImage: ContactDisplay.blockedSymbol)
                            .font(.footnote).foregroundStyle(Color.callerDanger)
                    }
                    LabeledContent("状态", value: callStateTitle(call.state))
                    // S38 三端合同：标记独立成行，接听方式仍按 AI/真人/未接显示。
                    if let badge = call.s38BadgeTitle {
                        LabeledContent("标记", value: badge)
                            .accessibilityIdentifier("records.detailBadge")
                    }
                    // S22 decision 10: who actually picked up. `answerMode` is nil on a pre-S22 Control, which
                    // simply reads as 真人/未接 from the fields that have always been there.
                    LabeledContent("接听方式", value: CallAnswerMethod.resolve(
                        answerMode: call.answerMode ?? report?.answerMode,
                        answeredByPlatform: call.answeredByPlatform ?? report?.answeredByPlatform,
                        answeredAt: call.answeredAt ?? report?.answeredAt,
                        failureReason: call.failureReason, isInternal: call.isInternal
                    ).title)
                    LabeledContent("开始", value: gatewayClock(call.startedAt, zone: call.gatewayTimeZone))
                    LabeledContent("接通", value: gatewayClock(call.answeredAt, zone: call.gatewayTimeZone))
                    LabeledContent("结束", value: gatewayClock(call.endedAt, zone: call.gatewayTimeZone))
                    // S82: only once answered and ended; an in-progress call has no talk time yet.
                    if let duration = CallDurationLabel.text(answeredAt: call.answeredAt, endedAt: call.endedAt) {
                        LabeledContent("通话时长", value: duration)
                    }
                }
            } else if let detailError {
                Section {
                    Label(detailError, systemImage: "exclamationmark.triangle").foregroundStyle(Color.callerDanger)
                        .reportsError(detailError, screen: "record_detail", site: "detail")
                }
            } else {
                Section { HStack { ProgressView(); Text("正在读取通话详情…") } }
            }
            if !deletedElsewhere, report != nil {
                Section("报告") {
                    switch ReportBlockBadgePolicy.badge(
                        blockRecommended: visibleReportBlockRecommended, blockReason: visibleReportBlockReason
                    ) {
                    case let .recommended(reason):
                        Label(
                            [ReportBlockBadgePolicy.recommendedTitle, reason].compactMap { $0 }.joined(separator: " · "),
                            systemImage: "hand.raised.fill"
                        )
                        .font(.footnote.weight(.semibold)).foregroundStyle(Color.callerDanger)
                    case .unclassified:
                        Text(ReportBlockBadgePolicy.unclassifiedTitle).font(.footnote).foregroundStyle(.secondary)
                    case .none:
                        EmptyView()
                    }
                    let presentation = ReportSummaryPolicy.presentation(
                        transcriptState: visibleReportTranscriptState,
                        transcriptErrorCode: visibleReportTranscriptErrorCode,
                        summary: visibleReportSummary
                    )
                    Text(presentation.text)
                        .font(.subheadline)
                        .foregroundStyle(presentation.isPlaceholder ? Color.secondary : Color.primary)
                    ForEach(visibleReportActionItems, id: \.self) {
                        Label($0, systemImage: "checklist").font(.footnote)
                    }
                    if let reportTranscriptError {
                        refreshError(
                            title: "报告刷新失败",
                            message: reportTranscriptError,
                            identifier: "records.reportTranscriptRefreshError"
                        ) { await loadReportTranscript() }
                    }
                }
            }
            if !deletedElsewhere {
                Section {
                Button {
                    showingTranscript = true
                } label: {
                    Label("查看转录", systemImage: "text.bubble")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                .accessibilityIdentifier("records.viewTranscript")
                Button {
                    showingRecording = true
                } label: {
                    Label("查看录音", systemImage: "waveform")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                .accessibilityIdentifier("records.viewRecording")
                }
            }
            // §E: the AI's live transcript, which exists only for calls an AI run answered. The recorded
            // transcript above is a separate, post-call artefact and both can be present.
            if !aiTranscript.isEmpty || aiTranscriptError != nil {
                Section("AI 对话") {
                    if !aiTranscript.isEmpty {
                        AiTranscriptRows(segments: aiTranscript, gatewayTimeZone: call?.gatewayTimeZone)
                    }
                    if let aiTranscriptError {
                        refreshError(
                            title: "AI 对话刷新失败",
                            message: aiTranscriptError,
                            identifier: "records.aiTranscriptRefreshError"
                        ) { await loadAiTranscript() }
                    }
                }
            }
            if let call, let reason = FailureReasonDisplayPolicy.visibleReason(for: call) {
                Section("失败原因") { Text(reason) }
            }
        }
        .navigationTitle("通话详情").navigationBarTitleDisplayMode(.inline)
        // S67: opening the detail marks the call seen (outgoing calls are never pending).
        .task(id: callID) {
            guard (call?.direction ?? report?.direction) != "outgoing" else { return }
            await BadgeStore.shared.markCallSeen(callID, simID: call?.simId ?? report?.sim.id, session: session)
        }
        .task(id: "\(callID):\(navigation.tab):\(scenePhase)") {
            guard navigation.tab == .records, scenePhase == .active else { return }
            await load()
            guard !deletedElsewhere else { return }
            await loadAiTranscript(); await loadReportTranscript()
            while !Task.isCancelled, !deletedElsewhere, navigation.tab == .records, scenePhase == .active {
                do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                await load()
                guard !deletedElsewhere else { return }
                await loadAiTranscript(); await loadReportTranscript()
            }
        }
        .alert(CallExistencePolicy.deletedTitle, isPresented: $deletedElsewhere) {
            Button("返回记录") { dismiss() }
        } message: {
            Text(CallExistencePolicy.deletedMessage)
        }
        .sheet(item: $card) { target in
            ContactCardView(target: target) { await load() }
        }
        .sheet(isPresented: $showingTranscript) {
            NavigationStack {
                TranscriptRecordView(callID: callID, gatewayTimeZone: call?.gatewayTimeZone)
            }
        }
        .sheet(isPresented: $showingRecording, onDismiss: { RecordingPlaybackController.shared.stop() }) {
            NavigationStack {
                RecordingRecordView(callID: callID, gatewayTimeZone: call?.gatewayTimeZone, gatewayKind: call?.gatewayKind,
                                    originatingPlatform: call?.originatingPlatform,
                                    ownerJoinedLocal: call?.ownerJoinedLocal == true)
            }
        }
        .onDisappear { RecordingPlaybackController.shared.stop() }
    }

    @ViewBuilder private func refreshError(
        title: String, message: String, identifier: String, retry: @escaping @MainActor () async -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: "exclamationmark.triangle")
                .font(.footnote.weight(.semibold)).foregroundStyle(Color.callerDanger)
            Text(message).font(.caption).foregroundStyle(.secondary)
            Button("重试") { Task { await retry() } }.frame(minHeight: 44)
        }
        .accessibilityIdentifier(identifier)
        .reportsError(message, screen: "record_detail", site: identifier)
    }

    private func load() async {
        guard let identity = session.sessionIdentity else { return }
        detailLoadGeneration += 1
        let generation = detailLoadGeneration
        detailError = nil
        do {
            let detail: CallDetailEnvelope = try await session.request(
                "calls/\(callID)", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == detailLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            call = detail.call
        } catch APIError.server(404, _, _) {
            guard !Task.isCancelled, generation == detailLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            handleDeletedElsewhere()
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == detailLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            detailError = error.localizedDescription
        }
    }

    /// A report card can be opened while its transcript is still queued. The per-call transcript endpoint is
    /// the authoritative supported refresh source for the generated summary, actions and classifier fields.
    private func loadReportTranscript() async {
        guard report != nil, let identity = session.sessionIdentity else { return }
        reportTranscriptLoadGeneration += 1
        let generation = reportTranscriptLoadGeneration
        do {
            let response: TranscriptEnvelope = try await session.request(
                "calls/\(callID)/transcript", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == reportTranscriptLoadGeneration, !deletedElsewhere,
                  session.isCurrentSession(identity) else { return }
            reportTranscript = response.transcript
            hasObservedReportTranscript = true
            reportTranscriptError = nil
        } catch APIError.server(404, _, _) {
            guard !Task.isCancelled, generation == reportTranscriptLoadGeneration, !deletedElsewhere,
                  session.isCurrentSession(identity) else { return }
            reportTranscript = nil
            hasObservedReportTranscript = true
            reportTranscriptError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == reportTranscriptLoadGeneration, !deletedElsewhere,
                  session.isCurrentSession(identity) else { return }
            // Keep the last observed report facts on transient failures and make the refresh failure actionable.
            reportTranscriptError = error.localizedDescription
        }
    }

    private func handleDeletedElsewhere() {
        detailLoadGeneration += 1
        transcriptLoadGeneration += 1
        reportTranscriptLoadGeneration += 1
        call = nil
        detailError = nil
        aiTranscript = []
        aiTranscriptError = nil
        reportTranscript = nil
        reportTranscriptError = nil
        hasObservedReportTranscript = true
        card = nil
        showingTranscript = false
        showingRecording = false
        RecordingPlaybackController.shared.stop()
        deletedElsewhere = true
    }

    /// A call that no AI run answered returns an empty list, and an older Control has no route at all. Neither
    /// is an error the user needs to see — the section simply does not appear.
    private func loadAiTranscript() async {
        guard let identity = session.sessionIdentity else { return }
        transcriptLoadGeneration += 1
        let generation = transcriptLoadGeneration
        do {
            let response: ItemEnvelope<AiTranscriptSegment> = try await session.request(
                "calls/\(callID)/ai-transcript", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == transcriptLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            aiTranscript = response.items
            aiTranscriptError = nil
        } catch APIError.server(404, _, _) {
            guard !Task.isCancelled, generation == transcriptLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            aiTranscript = []
            aiTranscriptError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == transcriptLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            // Preserve the last successful transcript and expose a retry for this refresh failure.
            aiTranscriptError = error.localizedDescription
        }
    }
}

/// §E: the AI's live transcript. Shared by the detail page's inline section and the standalone sheet the
/// report card opens when the recorded transcript never succeeded.
private struct AiTranscriptRows: View {
    let segments: [AiTranscriptSegment]
    let gatewayTimeZone: String?

    var body: some View {
        ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(segment.roleTitle)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(segment.isAI ? Color.callerAccent : .secondary)
                    if let at = segment.at {
                        Text(gatewayClock(at, zone: gatewayTimeZone))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Text(segment.text).textSelection(.enabled)
            }
            .padding(.vertical, 2)
        }
        Text("AI 实时转写供参考，可对照录音核实。").font(.caption).foregroundStyle(.secondary)
    }
}

/// S39 §E. Polls `GET calls/<id>` for as long as it is on screen and the scene is active, and calls `onDeleted`
/// the first time Control answers 404 — the only answer that proves the call is gone. Everything else, including
/// the 404s the sheets' own content routes return for "nothing recorded", leaves the sheet alone.
///
/// `.task` is cancelled when the view goes away, which is what stops the poll on dismiss; keying it on the scene
/// phase is what stops it in the background.
private struct CallExistenceGuard: ViewModifier {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    let callID: String
    let onDeleted: () -> Void

    func body(content: Content) -> some View {
        content.task(id: "\(callID):\(scenePhase)") {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                guard let identity = session.sessionIdentity else { continue }
                do {
                    let _: CallDetailEnvelope = try await session.request(
                        "calls/\(callID)", requiredSessionIdentity: identity
                    )
                } catch {
                    guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
                    if CallExistencePolicy.shouldClose(error) { onDeleted(); return }
                }
            }
        }
    }
}

extension View {
    func callExistenceGuard(callID: String, onDeleted: @escaping () -> Void) -> some View {
        modifier(CallExistenceGuard(callID: callID, onDeleted: onDeleted))
    }
}

/// S22 decision 10: "查看转录" on an AI call whose recorded transcript failed (RECORDING_EMPTY is the common
/// case) lands here instead of on an empty transcript page, because this is the only readable record left.
private struct AiConversationRecordView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let callID: String
    let gatewayTimeZone: String?
    @State private var segments: [AiTranscriptSegment] = []
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                if !loaded {
                    HStack { ProgressView(); Text("正在读取 AI 对话…") }
                }
                if let error {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("AI 对话读取失败", systemImage: "exclamationmark.triangle").foregroundStyle(Color.callerDanger)
                        Text(error).font(.footnote).foregroundStyle(.secondary)
                        Button("重试") { Task { await load() } }.frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("records.aiTranscriptError")
                    .reportsError(error, screen: "ai_transcript", site: "refresh")
                }
                if loaded, segments.isEmpty, error == nil {
                    Label("这通电话没有 AI 对话记录", systemImage: "sparkles").foregroundStyle(.secondary)
                } else if !segments.isEmpty {
                    AiTranscriptRows(segments: segments, gatewayTimeZone: gatewayTimeZone)
                }
            }
        }
        .navigationTitle("AI 对话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { recordSheetDoneButton }
        .task(id: callID) { await load() }
    }

    private var recordSheetDoneButton: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("完成") { dismiss() }.accessibilityIdentifier("records.sheetDone")
        }
    }

    private func load() async {
        guard let identity = session.sessionIdentity else { return }
        error = nil
        do {
            let response: ItemEnvelope<AiTranscriptSegment> = try await session.request(
                "calls/\(callID)/ai-transcript", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            segments = response.items; loaded = true; error = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            // A Control that predates §E has no route at all; an empty page is the truthful presentation.
            if case APIError.server(404, _, _) = error { segments = []; self.error = nil }
            else { self.error = error.localizedDescription }
            loaded = true
        }
    }
}

private struct TranscriptRecordView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let callID: String
    let gatewayTimeZone: String?
    @State private var transcript: TranscriptJob?
    @State private var transcriptLoaded = false
    @State private var transcriptError: String?

    var body: some View {
        List {
            Section {
                if !transcriptLoaded {
                    HStack { ProgressView(); Text("正在读取转录…") }
                }
                if let transcriptError {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("转录读取失败", systemImage: "exclamationmark.triangle").foregroundStyle(Color.callerDanger)
                        Text(transcriptError).font(.footnote).foregroundStyle(.secondary)
                        Button("重试") { Task { await loadTranscript() } }
                            .frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("records.transcriptRefreshError")
                    .reportsError(transcriptError, screen: "transcript", site: "refresh")
                }
                if let transcript {
                    transcriptStatus(transcript)
                } else if transcriptLoaded, transcriptError == nil {
                    Label("尚未生成转录", systemImage: "text.bubble").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("转录")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { recordSheetDoneButton }
        .task(id: callID) { await loadTranscript() }
    }

    private var recordSheetDoneButton: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("完成") { dismiss() }.accessibilityIdentifier("records.sheetDone")
        }
    }

    @ViewBuilder private func transcriptStatus(_ job: TranscriptJob) -> some View {
        switch job.status {
        case "queued", "running":
            Label("转录处理中", systemImage: "hourglass").foregroundStyle(.secondary)
        case "retry":
            VStack(alignment: .leading, spacing: 4) {
                Label("转录暂时失败，稍后会自动重试", systemImage: "arrow.clockwise").foregroundStyle(.orange)
                if let next = job.nextAttemptAt {
                    Text("下次尝试：\(gatewayClock(next, zone: gatewayTimeZone))").font(.caption).foregroundStyle(.secondary)
                }
            }
        case "failed":
            VStack(alignment: .leading, spacing: 4) {
                Label("转录失败", systemImage: "xmark.circle").foregroundStyle(Color.callerDanger)
                if let message = job.error?.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
        case "succeeded":
            if let result = job.result { transcriptResult(result) }
            else { Label("转录结果无效", systemImage: "exclamationmark.triangle").foregroundStyle(Color.callerDanger) }
        default: LabeledContent("转录状态", value: job.status)
        }
    }

    @ViewBuilder private func transcriptResult(_ result: TranscriptResult) -> some View {
        // S22 decision 10: every call has a report row now, so there is no 纳入/排除 status left to print. The
        // classifier's verdict is shown as 推荐拦截 on the report card instead of as a report-membership line.
        if let summary = result.summary, !summary.isEmpty {
            VStack(alignment: .leading, spacing: 3) { Text("摘要").font(.caption).foregroundStyle(.secondary); Text(summary) }
        }
        if !result.actionItems.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                Text("待办").font(.caption).foregroundStyle(.secondary)
                ForEach(result.actionItems, id: \.self) { Label($0, systemImage: "checklist") }
            }
        }
        if result.segments.isEmpty {
            Text(result.text).textSelection(.enabled)
        } else {
            ForEach(TranscriptText.blocks(from: result.segments)) { block in
                VStack(alignment: .leading, spacing: 4) {
                    Text(block.trackTitle).font(.subheadline.weight(.semibold))
                    Text(block.text).textSelection(.enabled)
                }.padding(.vertical, 3)
            }
        }
        if !result.providers.isEmpty {
            Text(result.providers.map { [$0.provider, $0.model, $0.version].compactMap { $0 }.joined(separator: " · ") }.joined(separator: " / "))
                .font(.caption2).foregroundStyle(.secondary)
        }
        Text("机器转录供参考，可对照原始录音核实。").font(.caption).foregroundStyle(.secondary)
    }

    private func loadTranscript() async {
        guard let identity = session.sessionIdentity else { return }
        if transcript == nil { transcriptLoaded = false }
        transcriptError = nil
        while !Task.isCancelled {
            do {
                let response: TranscriptEnvelope = try await session.request(
                    "calls/\(callID)/transcript", requiredSessionIdentity: identity
                )
                guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
                if let item = response.transcript, item.callId.lowercased() != callID.lowercased() { throw APIError.invalidResponse }
                transcript = response.transcript
                transcriptLoaded = true
                transcriptError = nil
                guard let status = response.transcript?.status, TranscriptPollPolicy.shouldPoll(status) else { return }
                try await Task.sleep(for: TranscriptPollPolicy.interval)
            } catch is CancellationError {
                return
            } catch APIError.server(404, _, _) {
                guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
                transcript = nil
                transcriptLoaded = true
                transcriptError = nil
                return
            } catch SessionLifecycleError.staleSession {
                return
            } catch {
                guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
                transcriptLoaded = true
                transcriptError = error.localizedDescription
                return
            }
        }
    }
}

private struct RecordingRecordView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let callID: String
    let gatewayTimeZone: String?
    var gatewayKind: String? = nil
    @State private var manifest: RecordingManifest?
    @State private var recordingLoaded = false
    @State private var recordingError: String?
    @State private var recordingRetryAllowed = true
    @State private var recordingSource: RecordingSource
    @State private var player = RecordingPlaybackController.shared
    @State private var shareBusy = false
    @State private var shareError: String?
    @State private var shareItems: [URL] = []
    @State private var showingShare = false

    private let ownerJoinedLocal: Bool

    init(callID: String, gatewayTimeZone: String?, gatewayKind: String? = nil, originatingPlatform: String? = nil,
         ownerJoinedLocal: Bool = false) {
        self.callID = callID
        self.ownerJoinedLocal = ownerJoinedLocal
        self.gatewayTimeZone = gatewayTimeZone
        self.gatewayKind = gatewayKind
        _recordingSource = State(initialValue: .defaultSource(originatingPlatform: originatingPlatform,
                                                                          ownerJoinedLocal: ownerJoinedLocal))
    }

    var body: some View {
        List {
            Section {
                Picker("录音副本", selection: $recordingSource) {
                    ForEach(RecordingSource.allCases, id: \.rawValue) { Text($0.title(gatewayKind: gatewayKind, ownerJoinedLocal: ownerJoinedLocal)).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("records.recordingSource")
            }
            Section("录音") { recordingRows }
        }
        .navigationTitle("录音")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { recordSheetDoneButton }
        .task(id: "\(callID):\(recordingSource.rawValue)") { await loadRecording(recordingSource) }
        .onChange(of: recordingSource) { _, _ in player.stop() }
        .onDisappear { player.stop() }
        .sheet(isPresented: $showingShare) {
            ActivityShareView(items: shareItems)
        }
    }

    private var recordSheetDoneButton: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("完成") { dismiss() }.accessibilityIdentifier("records.sheetDone")
        }
    }

    @ViewBuilder private var recordingRows: some View {
        if !recordingLoaded {
            HStack { ProgressView(); Text("正在读取录音清单…") }
        } else if let recordingError {
            Label(recordingError, systemImage: "exclamationmark.triangle").foregroundStyle(Color.callerDanger)
                .reportsError(recordingError, screen: "recording", site: "manifest")
            if recordingRetryAllowed {
                Button("重试") { Task { await loadRecording(recordingSource) } }
                    .frame(minHeight: 44)
            }
        } else if let manifest {
            LabeledContent("当前副本", value: manifest.source.title(gatewayKind: gatewayKind))
            Text(gatewayClock(manifest.finalizedAt, zone: gatewayTimeZone)).font(.caption).foregroundStyle(.secondary)
            if manifest.source == .mediaNode, manifest.version == 1 {
                Label("这是媒体节点 Ogg 原始副本；双方音轨只能各自从文件开头播放，不代表精确同步或已生成混音。", systemImage: "info.circle")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if !manifest.archiveComplete {
                Label("归档尚未完整发布。", systemImage: "waveform.badge.exclamationmark").font(.footnote).foregroundStyle(.orange)
            } else if manifest.captureComplete == false {
                Label("录制期间存在缺音，仍可试听已保存内容。", systemImage: "waveform.badge.exclamationmark").font(.footnote).foregroundStyle(.orange)
            }
            // S94: when the Pixel archive carries the uplink capture, it is the default pair (listed first).
            if manifest.defaultTogetherMode == .ownerJoined {
                togetherPlayback(
                    title: "通话双方（含本机接入）",
                    detail: "对方原声 + 本机上行（含机主在本机接入后说的话）；可能存在时间偏差。",
                    mode: .ownerJoined,
                    playable: manifest.ownerJoinedPlaybackArtifacts,
                    source: manifest.source
                )
            }
            togetherPlayback(
                title: "双向原声一起播放",
                detail: "同时开始双方原始声轨，可能存在时间偏差；需要核对时请分别播放原声。",
                mode: .originals,
                playable: manifest.combinedPlaybackArtifacts,
                source: manifest.source
            )
            if manifest.source == .pixel, !manifest.compensatedPlaybackArtifacts.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Label("补偿播放轨可用", systemImage: "waveform.badge.plus")
                    if let derived = manifest.derivedArtifacts.first {
                        Text("这是派生的听取轨，不是额外的原始录音。补偿帧 \(derived.recoveryFrames) · 剩余缺口 \(derived.gapCount)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                togetherPlayback(
                    title: "补偿后双向播放",
                    detail: "对方原声 + 本人补偿播放轨（派生）；不代表原始录音完整或已生成混音。",
                    mode: .compensated,
                    playable: manifest.compensatedPlaybackArtifacts,
                    source: manifest.source
                )
            }
            DisclosureGroup("分别播放原声") {
                ForEach(RecordingTrack.allCases, id: \.rawValue) { track in recordingRow(track, manifest: manifest) }
            }
            if manifest.source == .pixel, !manifest.derivedArtifacts.isEmpty {
                DisclosureGroup("含补偿") {
                    Text("这是独立的播放轨，可能含 PLC/FEC 补偿；它不会覆盖原声缺口或改变原声完整性。")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(manifest.derivedArtifacts, id: \.sha256) { derived in
                        derivedRow(derived)
                    }
                }
            }
            if let shareError {
                Text(shareError).font(.footnote).foregroundStyle(Color.callerDanger)
                    .reportsError(shareError, screen: "recording", site: "share")
            }
        } else {
            Label("尚未生成录音", systemImage: "waveform.slash").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func togetherPlayback(
        title: String,
        detail: String,
        mode: RecordingPlaybackController.TogetherMode,
        playable: [PlaybackArtifact],
        source: RecordingSource
    ) -> some View {
        let isActive = {
            switch player.state {
            case .loadingTogether(let active), .playingTogether(let active): active == mode
            default: false
            }
        }()
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold))
            Text(detail).font(.caption).foregroundStyle(.secondary)
            durationOverlay(durationMs: playable.compactMap(\.durationMs).max(), isActive: isActive)
            HStack(spacing: 12) {
                switch player.state {
                case .loadingTogether(let activeMode) where activeMode == mode:
                    ProgressView().frame(minHeight: 44)
                case .playingTogether(let activeMode) where activeMode == mode:
                    Button("停止", role: .destructive) { player.stop() }
                        .frame(minHeight: 44)
                default:
                    Button("播放") {
                        player.startTogether(mode: mode, artifacts: playable, source: source, callID: callID, session: session)
                    }
                    .disabled(playable.count != 2)
                    .frame(minHeight: 44)
                }
                Button {
                    // S36 C4: the export is the server-side mix (`conversation`), not the two raw tracks.
                    Task { await share(paths: ["conversation"]) }
                } label: {
                    Label(shareBusy ? "正在保存…" : "下载对话 MP3", systemImage: "square.and.arrow.up")
                }
                .disabled(playable.count != 2 || shareBusy)
                .frame(minHeight: 44)
            }
            // A List row gives automatic-style sibling buttons one shared row tap. Borderless keeps
            // play/stop and download as independent controls without changing either action.
            .buttonStyle(.borderless)
            Text("双方声音按时间对齐混音为一个 MP3；需单独原声请用下方各轨下载")
                .font(.caption).foregroundStyle(.secondary)
            if playable.count != 2 {
                Text("双方声轨尚未齐全，请分别播放可用原声。").font(.footnote).foregroundStyle(.secondary)
            } else if case let .failedTogether(failedMode, message) = player.state, failedMode == mode {
                Text(message).font(.footnote).foregroundStyle(Color.callerDanger)
                    .reportsError(message, screen: "recording", site: "playback_together")
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func recordingRow(_ track: RecordingTrack, manifest: RecordingManifest) -> some View {
        if let artifact = manifest.artifact(for: track), artifact.bytes > 0 {
            singleTrackControls(
                title: track.title,
                durationMs: artifact.durationMs,
                detail: ByteCountFormatter.string(fromByteCount: artifact.bytes, countStyle: .file),
                warning: artifact.gapCount > 0 || artifact.droppedFrames > 0
                    ? "缺口 \(artifact.gapCount) · 丢帧 \(artifact.droppedFrames)" : nil,
                isLoading: { if case .loading(track) = player.state { return true }; return false }(),
                isPlaying: { if case .playing(track) = player.state { return true }; return false }(),
                failedMessage: {
                    if case let .failed(failedTrack, message) = player.state, failedTrack == track { return message }
                    return nil
                }(),
                play: { player.start(track: track, artifact: artifact, source: manifest.source, callID: callID, session: session) },
                sharePath: track.rawValue
            )
        } else {
            LabeledContent(track.title, value: "无可播放内容").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func derivedRow(_ derived: DerivedRecordingArtifact) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("通话播放声（含补偿）")
            Text("派生播放轨 · 补偿帧 \(derived.recoveryFrames) · 缺口 \(derived.gapCount)")
                .font(.caption).foregroundStyle(.secondary)
            durationOverlay(durationMs: derived.durationMs, isActive: false)
            if !derived.playoutComplete {
                Text("播放轨不完整").font(.caption2).foregroundStyle(.orange)
            }
            Text("播放请使用上方“补偿后双向播放”；此处可单独下载该派生轨。")
                .font(.caption).foregroundStyle(.secondary)
            Button {
                Task { await share(paths: [derived.track]) }
            } label: {
                Label(shareBusy ? "正在保存…" : "下载", systemImage: "square.and.arrow.up")
            }
            .disabled(shareBusy)
            .frame(minHeight: 44)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func singleTrackControls(
        title: String,
        durationMs: Int64?,
        detail: String,
        warning: String?,
        isLoading: Bool,
        isPlaying: Bool,
        failedMessage: String?,
        play: @escaping () -> Void,
        sharePath: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
            Text(detail).font(.caption).foregroundStyle(.secondary)
            durationOverlay(durationMs: durationMs, isActive: isPlaying || isLoading)
            if let warning {
                Text(warning).font(.caption2).foregroundStyle(.orange)
            }
            HStack(spacing: 12) {
                if isLoading {
                    ProgressView().frame(minHeight: 44)
                } else if isPlaying {
                    Button("停止", role: .destructive) { player.stop() }
                        .frame(minHeight: 44)
                } else {
                    Button("播放", action: play)
                        .frame(minHeight: 44)
                }
                Button {
                    Task { await share(paths: [sharePath]) }
                } label: {
                    Label(shareBusy ? "正在保存…" : "下载", systemImage: "square.and.arrow.up")
                }
                .disabled(shareBusy)
                .frame(minHeight: 44)
            }
            .buttonStyle(.borderless)
            if let failedMessage {
                Text(failedMessage).font(.footnote).foregroundStyle(Color.callerDanger)
                    .reportsError(failedMessage, screen: "recording", site: "playback")
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func durationOverlay(durationMs: Int64?, isActive: Bool) -> some View {
        if let total = PlaybackClock.formatMilliseconds(durationMs) {
            Text(isActive ? "\(PlaybackClock.format(player.currentTime)) / \(total)" : total)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .accessibilityLabel("时长 \(total)")
            // S36 C5-c: one slider for both single-track and paired playback — this overlay is the shared piece.
            // `seek(to:)` clamps and ignores itself when nothing is playing, so a zero-length track just disables it.
            if isActive {
                Slider(
                    value: Binding(get: { player.currentTime }, set: { player.seek(to: $0) }),
                    in: 0...max(player.duration, 0.01)
                ) { editing in
                    // The 200 ms progress tick would otherwise drag the knob back under the finger.
                    if editing { player.pause() } else { player.resume() }
                }
                .disabled(player.duration <= 0)
                .accessibilityLabel("播放进度")
                .accessibilityValue("\(PlaybackClock.format(player.currentTime)) / \(total)")
            }
        }
    }

    private func loadRecording(_ source: RecordingSource) async {
        recordingLoaded = false; recordingError = nil; recordingRetryAllowed = true
        guard let sessionIdentity = session.sessionIdentity else { return }
        do {
            let response: RecordingEnvelope = try await session.request(
                "calls/\(callID)/recordings", requiredSessionIdentity: sessionIdentity,
                queryItems: [.init(name: "source", value: source.rawValue)]
            )
            guard !Task.isCancelled, session.isCurrentSession(sessionIdentity) else { return }
            guard response.recording?.isValid(for: callID, requestedSource: source) != false else { throw APIError.invalidResponse }
            // S22 decision 7: an archive that published nothing but headers is empty, not inconsistent. Saying
            // "来源或文件信息不一致" here sent people looking for a data-integrity problem that is not there.
            if response.recording?.isEmptyCapture == true { throw RecordingPresentationError.emptyCapture }
            manifest = response.recording; recordingLoaded = true
        } catch {
            guard !Task.isCancelled, session.isCurrentSession(sessionIdentity) else { return }
            let presentation = recordingErrorPresentation(error, source: source, gatewayKind: gatewayKind)
            manifest = nil; recordingLoaded = true; recordingError = presentation.message
            recordingRetryAllowed = presentation.canRetry
        }
    }

    private func share(paths: [String]) async {
        guard !paths.isEmpty, !shareBusy else { return }
        guard let sessionIdentity = session.sessionIdentity else { return }
        shareBusy = true
        shareError = nil
        defer { shareBusy = false }
        do {
            var files: [URL] = []
            for path in paths {
                // S36 C4: an exported file leaves the app as MP3 so it opens anywhere; playback keeps the original.
                let download = try await session.download(
                    "calls/\(callID)/recordings/\(path)",
                    source: recordingSource,
                    requiredSessionIdentity: sessionIdentity,
                    disposition: "attachment",
                    format: "mp3"
                )
                let name = RecordingAttachmentName.filename(
                    callID: callID, source: recordingSource, track: path, header: download.contentDisposition,
                    format: "mp3"
                )
                // S39 §F: exports get their own directory so the hourly sweep can never reach a playback temp file.
                try FileManager.default.createDirectory(
                    at: ExportCleanupPolicy.directory, withIntermediateDirectories: true
                )
                let dest = ExportCleanupPolicy.directory.appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: dest.path) {
                    try FileManager.default.removeItem(at: dest)
                }
                try FileManager.default.copyItem(at: download.url, to: dest)
                try? FileManager.default.removeItem(at: download.url)
                files.append(dest)
            }
            guard session.isCurrentSession(sessionIdentity) else { return }
            shareItems = files
            showingShare = true
        } catch {
            guard session.isCurrentSession(sessionIdentity) else { return }
            shareError = error.localizedDescription
        }
    }
}

private struct ActivityShareView: UIViewControllerRepresentable {
    let items: [URL]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        // S39 §F: by the time the share sheet reports back, whoever took the file has its own copy. A swipe-down
        // reports nothing at all, which is what `ExportCleanupPolicy.prune()` is for.
        let exported = items
        controller.completionWithItemsHandler = { _, _, _, _ in
            for url in exported { try? FileManager.default.removeItem(at: url) }
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private struct CallDetailEnvelope: Decodable, Sendable { let call: CallRecord }

private func gatewayClock(_ value: String?, zone: String?) -> String {
    GatewayTimeDisplay.compact(value, timeZone: GatewayTimeDisplay.resolvedTimeZone(callZone: zone))
}

func recordingErrorPresentation(_ error: Error, source: RecordingSource, gatewayKind: String? = nil) -> (message: String, canRetry: Bool) {
    if source == .pixel, case APIError.server(503, _, _) = error {
        return ("\(GatewayKind(gatewayKind).archiveTitle)尚未开启。你仍可切换到“服务器录音”播放已保存的录音。", false)
    }
    if case APIError.unauthorized = error {
        return ("录音访问权限已过期，请重新登录。", false)
    }
    if case APIError.server(404, _, _) = error {
        return (source == .pixel ? "这份 \(GatewayKind(gatewayKind).deviceName) 录音尚未上传或暂不可访问。" : "媒体节点上尚未生成这份录音。", true)
    }
    if case APIError.server(416, _, _) = error {
        return ("录音文件已变化，请重新打开通话详情后再播放。", false)
    }
    if error is URLError {
        return ("录音节点暂时不可用，请检查网络后重试。", true)
    }
    if case RecordingPresentationError.emptyCapture = error {
        // Retrying cannot conjure audio that was never captured, so the row offers no 重试 button.
        return (RecordingErrorCopy.emptyCapture, false)
    }
    if case APIError.invalidResponse = error {
        return (RecordingErrorCopy.inconsistentManifest, true)
    }
    // A manifest the app cannot decode is the same class of problem as one that fails validation, and it must
    // not leak Foundation's English `DecodingError` description to the user (R1 §5.2).
    if error is DecodingError {
        return (RecordingErrorCopy.inconsistentManifest, true)
    }
    return (error.localizedDescription, true)
}

#if DEBUG
/// S26 preview: 全部通话 on page 2 of 4, 60 rows and the pager, rendered without a session or a login.
private struct PagedCallListPreviewHost: View {
    @State private var store = RecordsPagingStore(page: 2, pageSize: 50, total: 187, totalPages: 4)
    private let calls = PreviewCallRecords.make(60)

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(calls) { call in
                        HStack(spacing: 0) {
                            CallHistoryRow(call: call)
                            Image(systemName: "info.circle")
                                .font(.title3).frame(width: 44, height: 44)
                                .foregroundStyle(Color.callerAccent)
                        }
                    }
                }
            }
            .navigationTitle("记录")
            .toolbarTitleDisplayMode(.inlineLarge)
            .safeAreaInset(edge: .bottom) { PagerBar(store: store) }
        }
    }
}

private enum PreviewCallRecords {
    /// Built by decoding rather than by the 24-argument memberwise initialiser, which also proves the preview
    /// rows are shaped exactly like the ones `GET /calls` sends.
    static func make(_ count: Int) -> [CallRecord] {
        (0..<count).compactMap { index in
            let minute = String(format: "%02d", index % 60)
            let hour = String(format: "%02d", 8 + index % 12)
            let json = """
            {"id":"preview-call-\(index)","simId":"sim-1","direction":"\(index.isMultiple(of: 3) ? "outgoing" : "incoming")",\
            "remoteNumber":"1866692\(String(format: "%04d", 1000 + index))",\
            "state":"\(index.isMultiple(of: 7) ? "failed" : "completed")",\
            "startedAt":"2026-09-12T\(hour):\(minute):00Z","gatewayTimeZone":"Asia/Shanghai",\
            "contactName":\(index.isMultiple(of: 4) ? "\"张三\"" : "null"),\
            "blocked":\(index.isMultiple(of: 9) ? "true" : "false")}
            """
            return try? JSONDecoder().decode(CallRecord.self, from: Data(json.utf8))
        }
    }
}

#Preview("全部通话 第 2 页") {
    PagedCallListPreviewHost()
}
#endif
