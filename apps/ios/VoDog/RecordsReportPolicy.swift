import Foundation

/// S22 decision 10. The 记录 page is three peers — 全部通话 / 报告 / 拦截记录 — instead of one list with a
/// report block wedged on top. iOS is the reference design, so the wording and the ordering live here as
/// testable facts that Android and Web mirror rather than re-derive.
enum RecordsTab: String, CaseIterable, Identifiable, Sendable {
    case calls, reports, interceptions

    var id: String { rawValue }

    var title: String {
        switch self {
        case .calls: "全部通话"
        case .reports: "报告"
        case .interceptions: "拦截记录"
        }
    }
}

/// 接听方式 for a report row: derived, never sent as a label by the server.
///
/// The order matters. A call that was never answered is 未接 whatever its mode was; an AI-answered call is
/// `超时 AI` only when the SIM was in `timeout_ai` (a human who grabs a `timeout_ai` call before the timer
/// fires is still 真人).
enum CallAnswerMethod: String, CaseIterable, Sendable {
    case missed, busyMissed, notConnected, ai, timeoutAI, human

    var title: String {
        switch self {
        case .missed: "未接"
        case .busyMissed: "忙线未接"
        case .notConnected: "未接通"
        case .ai: "AI 接听"
        case .timeoutAI: "超时 AI"
        case .human: "真人"
        }
    }

    var symbol: String {
        switch self {
        case .missed, .busyMissed, .notConnected: "phone.down"
        case .ai, .timeoutAI: "sparkles"
        case .human: "person.wave.2"
        }
    }

    /// S72：忙线自动拒接是「忙线未接」；内部通话没接通不算未接，写「未接通」。
    static func resolve(
        answerMode: String?, answeredByPlatform: String?, answeredAt: String?,
        failureReason: String? = nil, isInternal: Bool = false
    ) -> CallAnswerMethod {
        let answered = (answeredAt ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !answered.isEmpty else {
            if isInternal { return .notConnected }
            return failureReason == "busy_auto_rejected" ? .busyMissed : .missed
        }
        guard answeredByPlatform == "ai" else { return .human }
        return answerMode == "timeout_ai" ? .timeoutAI : .ai
    }
}

/// S72：内部通话（同一 owner 的托管卡互打）的卡到卡标题。呼入腿 = 对端卡 → 本卡，呼出腿 = 本卡 → 对端卡。
enum InternalCallTitle {
    static func route(direction: String?, thisSimLabel: String?, peerSimLabel: String?) -> String {
        let this = label(thisSimLabel, fallback: "本卡"), peer = label(peerSimLabel, fallback: "另一张卡")
        return direction == "outgoing" ? "\(this) → \(peer)" : "\(peer) → \(this)"
    }

    static func text(direction: String?, thisSimLabel: String?, peerSimLabel: String?) -> String {
        "内部通话 " + route(direction: direction, thisSimLabel: thisSimLabel, peerSimLabel: peerSimLabel)
    }

    private static func label(_ value: String?, fallback: String) -> String {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }
}

/// The report tab's date control. 自定义 keeps whatever the two `DatePicker`s hold; the other three are
/// calendar days in the gateway's own time zone, inclusive of today.
enum ReportDatePreset: String, CaseIterable, Identifiable, Sendable {
    case today, sevenDays, thirtyDays, custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "今天"
        case .sevenDays: "7 天"
        case .thirtyDays: "30 天"
        case .custom: "自定义"
        }
    }

    /// How many calendar days the window spans, counting today. Nil for 自定义.
    var days: Int? {
        switch self {
        case .today: 1
        case .sevenDays: 7
        case .thirtyDays: 30
        case .custom: nil
        }
    }
}

enum ReportDateRangePolicy {
    static let `default`: ReportDatePreset = .sevenDays

    /// `yyyy-MM-dd` in the gateway's zone — the server reads these as owner-local calendar days.
    static func day(_ date: Date, timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// The inclusive `[from, to]` day pair for a preset. 自定义 returns nil so the pickers stay authoritative.
    static func range(for preset: ReportDatePreset, today: Date, timeZone: TimeZone) -> (from: Date, to: Date)? {
        guard let days = preset.days else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let end = calendar.startOfDay(for: today)
        let start = calendar.date(byAdding: .day, value: -(days - 1), to: end) ?? end
        return (start, end)
    }

    /// Guards against a start after the end, which the server would answer with an empty window.
    static func ordered(from: Date, to: Date) -> (from: Date, to: Date) {
        from <= to ? (from, to) : (to, from)
    }
}

/// Line 2 of a report card: the four facts that identify the call, in one order for all three clients.
enum ReportCardFacts {
    static let separator = " · "
    static let unknownSIM = "未知线路"

    static func directionTitle(_ direction: String?) -> String {
        direction == "outgoing" ? "呼出" : "呼入"
    }

    static func line(
        simLabel: String?, direction: String?, duration: String?, answerMethod: CallAnswerMethod
    ) -> String {
        let sim = (simLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var parts = [sim.isEmpty ? unknownSIM : sim, directionTitle(direction)]
        if let duration, !duration.isEmpty { parts.append(duration) }
        parts.append(answerMethod.title)
        return parts.joined(separator: separator)
    }
}

/// 通话时长 (S82 short format: "48 秒" / "2 分 05 秒"). A call that was never answered has no talk time at all,
/// which is why the slot is dropped rather than printed as 0.
enum CallDurationLabel {
    static func text(answeredAt: String?, endedAt: String?) -> String? {
        guard let seconds = GatewayTimeDisplay.talkSeconds(answeredAt: answeredAt, endedAt: endedAt) else {
            return nil
        }
        return seconds < 60 ? "\(seconds) 秒" : String(format: "%d 分 %02d 秒", seconds / 60, seconds % 60)
    }
}

/// Query shapes for the two searchable tabs. Both debounce on `ContactLookupPolicy.debounce` (350 ms) so a
/// typed number costs one request per pause, exactly as the contacts list already does.
enum RecordSearchPolicy {
    static let debounce: Duration = ContactLookupPolicy.debounce
    static let searchPrompt = "搜索姓名或号码"
    /// `GET /calls` caps `limit` at 100; `GET /reports/calls` at 200.
    static let callsLimit = 100
    static let reportLimit = 200
    /// `GET /blocklist/interceptions` caps `limit` at 100 too.
    static let interceptionsLimit = 100

    static func trimmed(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 「已加载：…」 only when it tells the user something the screen does not: an active search, a page after the
    /// first, or a cached snapshot kept on screen while offline or after a failed refresh (S46). Web and Android
    /// show no caption on the default first page.
    static func showsSnapshotCaption(query: String, page: Int, stale: Bool) -> Bool {
        stale || page > 1 || !trimmed(query).isEmpty
    }

    /// S26: `page` is what switches the route into its paged form, so `limit` is dropped whenever one is sent —
    /// the two would otherwise state two different window sizes for the same request. Without a `page` the
    /// query is the S22 one plus `includeBlocked`, which is what a Control that predates paging still answers.
    /// S38: 全部通话要连拦截掉的来电一起显示，`/calls` 默认把 `failure_reason='number_blocked'` 的行藏起来，
    /// 所以每一条列表请求（搜索、分页、按线路筛）都带上 `includeBlocked=true`。
    static func callsQuery(
        query: String, simId: String? = nil, page: Int? = nil, pageSize: Int? = nil
    ) -> [URLQueryItem] {
        var items: [URLQueryItem] = []
        let text = trimmed(query)
        if !text.isEmpty { items.append(URLQueryItem(name: "query", value: text)) }
        if let simId, !trimmed(simId).isEmpty {
            items.append(URLQueryItem(name: "simId", value: trimmed(simId)))
        }
        items.append(URLQueryItem(name: "includeBlocked", value: "true"))
        items.append(contentsOf: pageItems(page: page, pageSize: pageSize, limit: callsLimit))
        return items
    }

    /// `from`/`to` are owner-local calendar days and take precedence over the legacy `period` parameter, which
    /// is no longer sent.
    static func reportQuery(
        from: String, to: String, timeZone: String, query: String,
        page: Int? = nil, pageSize: Int? = nil, simId: String? = nil
    ) -> [URLQueryItem] {
        var items = [
            URLQueryItem(name: "timeZone", value: timeZone),
            URLQueryItem(name: "from", value: from),
            URLQueryItem(name: "to", value: to),
        ]
        items.append(contentsOf: pageItems(page: page, pageSize: pageSize, limit: reportLimit))
        let text = trimmed(query)
        if !text.isEmpty { items.append(URLQueryItem(name: "query", value: text)) }
        if let simId, !trimmed(simId).isEmpty {
            items.append(URLQueryItem(name: "simId", value: trimmed(simId)))
        }
        return items
    }

    /// 拦截记录 has no search and no SIM filter — only the page. Without one it keeps the S21 `limit=100`.
    static func interceptionsQuery(page: Int? = nil, pageSize: Int? = nil) -> [URLQueryItem] {
        pageItems(page: page, pageSize: pageSize, limit: interceptionsLimit)
    }

    /// Either `page`+`pageSize` or the legacy `limit`, never both.
    private static func pageItems(page: Int?, pageSize: Int?, limit: Int) -> [URLQueryItem] {
        guard let page else { return [URLQueryItem(name: "limit", value: String(limit))] }
        return [
            URLQueryItem(name: "page", value: String(RecordsPagingPolicy.clampPage(page, totalPages: nil))),
            URLQueryItem(
                name: "pageSize",
                value: String(RecordsPagingPolicy.normalizedPageSize(pageSize ?? RecordsPagingPolicy.defaultPageSize))
            ),
        ]
    }
}

/// What the summary slot of a report card shows. A row without a transcript still gets a report row under
/// S22, so the slot explains why rather than being blank.
enum ReportSummaryPresentation: Equatable, Sendable {
    case summary(String)
    case placeholder(String)

    var text: String {
        switch self {
        case let .summary(value), let .placeholder(value): value
        }
    }

    var isPlaceholder: Bool {
        if case .placeholder = self { return true }
        return false
    }
}

enum ReportSummaryPolicy {
    static let recordingEmptyCode = "RECORDING_EMPTY"
    static let emptyRecording = "无转录：录音为空"
    static let running = "转录处理中…"
    static let failed = "转录失败，原始录音仍可查看"
    static let noSummary = "暂无摘要"
    /// S22 removes every "已纳入报告 / 不纳入报告" line: each call now has a report row unconditionally and the
    /// classifier only annotates it.
    static let summaryLineLimit = 3

    static func presentation(
        transcriptState: String?, transcriptErrorCode: String?, summary: String?
    ) -> ReportSummaryPresentation {
        let text = (summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return .summary(text) }
        switch transcriptState {
        case "queued", "running", "retry": return .placeholder(running)
        case "none": return .placeholder(emptyRecording)
        case "failed":
            return .placeholder(transcriptErrorCode == recordingEmptyCode ? emptyRecording : failed)
        default: return .placeholder(noSummary)
        }
    }
}

/// The two pills on a report card. `blockRecommended == nil` means the row was classified before S22's
/// `classifierVersion: 2` and simply has no verdict — that is 未分类, not "not recommended".
enum ReportBlockBadgePolicy {
    static let recommendedTitle = "推荐拦截"
    static let unclassifiedTitle = "未分类"
    static let blockedTitle = "已屏蔽"
    static let blockNowTitle = "立即屏蔽"

    enum Badge: Equatable, Sendable {
        case recommended(reason: String?)
        case unclassified
        case none
    }

    static func badge(blockRecommended: Bool?, blockReason: String?) -> Badge {
        switch blockRecommended {
        case .some(true):
            let reason = (blockReason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return .recommended(reason: reason.isEmpty ? nil : reason)
        case .some(false): return .none
        case nil: return .unclassified
        }
    }
}

/// "查看转录" has two destinations now. A call the AI answered whose ASR transcript never succeeded still has
/// the live AI conversation, which is the only readable record of it.
enum ReportTranscriptDestination: Equatable, Sendable {
    case transcript
    case aiConversation

    static func resolve(hasAiTranscript: Bool?, transcriptState: String?) -> ReportTranscriptDestination {
        hasAiTranscript == true && transcriptState != "succeeded" ? .aiConversation : .transcript
    }
}

/// S22 decision 7: an archive that exists but holds no audio is its own outcome, not a manifest mismatch.
enum RecordingPresentationError: LocalizedError, Equatable {
    case emptyCapture
    var errorDescription: String? { RecordingErrorCopy.emptyCapture }
}

enum RecordingErrorCopy {
    static let emptyCapture = "录音为空或采集失败，暂无法播放"
    /// Reserved for a manifest whose identity, tracks or fingerprints really do not line up.
    static let inconsistentManifest = "录音来源或文件信息不一致，请刷新后重试。"
}
