import Foundation

// VoDog 通话记录与报告的线上数据形状（S54 C3）。只依赖 Foundation，
// 自测 scripts/run_vodog_records_tests.sh 直接单独编译本文件。
// 标签函数返回中文键，由视图包 L10n.tr；新键登记在 Resources/Localization/pending/c3.tsv。
// 字段来源：iOS apps/ios/VoDog/Models.swift 与 Control app.ts / transcription/routes.ts。

enum CCRecords {
    /// `account.json` 返回字典；这里转回 Data 交给 JSONDecoder。
    static func decode<T: Decodable>(_ type: T.Type, from object: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(T.self, from: data)
    }
}

// MARK: - 通话

struct CCCallRecord: Decodable, Identifiable, Equatable {
    let id: String
    var simId: String?
    var direction: String?
    var remoteNumber: String?
    var state: String?
    var startedAt: String?
    var answeredAt: String?
    var endedAt: String?
    var answeredByPlatform: String?
    var answeredByDevice: String?
    var originatingPlatform: String?
    var failureReason: String?
    var recordingStatus: String?
    var gatewayTimeZone: String?
    var contactName: String?
    var blocked: Bool?
    var answerMode: String?
    var aiHandling: Bool?
    var conflictDisposition: String?
    var blockedSource: String?
    /// S58: `pixel` | `dji4g`, text only (missing → pixel).
    var gatewayKind: String?
    /// S67c: Control marks calls still counted by the calls badge (missing → false).
    var unseen: Bool?
    /// S72: same-owner managed SIMs calling each other; the peer is the other leg's own SIM.
    var `internal`: Bool?
    var peerSimId: String?
    var peerSimLabel: String?

    var isIncoming: Bool { direction == "incoming" }
    /// S67c row dot: server says unseen and this session has not opened it yet (optimistic removal).
    func showsUnseenDot(seen: Set<String>) -> Bool { unseen == true && !seen.contains(id) }
    var showsBlockedMark: Bool { blocked == true || failureReason == "number_blocked" }
    /// Web `missedIncomingCall`: 呼入、未接通、已结束或失败，且不是被拦截的来电。
    var isMissedIncoming: Bool {
        isIncoming && `internal` != true && (answeredAt ?? "").trimmingCharacters(in: .whitespaces).isEmpty
            && (state == "ended" || state == "failed") && failureReason != "number_blocked"
    }
    /// S67 client-side guess of "counted by the calls badge" (missed or AI-answered incoming), used only for
    /// the optimistic −1; `GET /badges` stays authoritative.
    var isBadgeCandidate: Bool {
        isMissedIncoming || (isIncoming && (state == "ended" || state == "failed") && failureReason != "number_blocked"
            && (aiHandling == true || conflictDisposition == "ai_answered"))
    }
}

struct CCPageInfo: Decodable, Equatable {
    var page: Int
    var pageSize: Int
    var total: Int
    var totalPages: Int
}

struct CCCallsPage: Decodable {
    let items: [CCCallRecord]
    let page: Int?
    let pageSize: Int?
    let total: Int?
    let totalPages: Int?
}

struct CCCallDetailEnvelope: Decodable { let call: CCCallRecord }

struct CCSimItem: Decodable, Identifiable, Equatable {
    let id: String
    var label: String?
    var phoneLabel: String?
    var slotIndex: Int?
    var gatewayId: String?
    var gatewayKind: String?

    var title: String {
        let name = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        return slotIndex.map { "SIM \($0 + 1)" } ?? "SIM"
    }

    /// 通话记录的线路行（Web `phoneLabel||label · gatewayShortLabel`）：`<号码或名称> · <Pixel|DJI 4G> · <网关 8 位>`。
    var lineText: String {
        let phone = (phoneLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let gateway = gatewayId.map { "\(gatewayKind == "dji4g" ? "DJI 4G" : "Pixel") · \($0.prefix(8))" }
        return [phone.isEmpty ? title : phone, gateway].compactMap { $0 }.joined(separator: " · ")
    }
}

struct CCSimList: Decodable { let items: [CCSimItem] }

// MARK: - 报告

struct CCReportSIM: Decodable, Equatable {
    var id: String?
    var label: String?
    var slotIndex: Int?
}

struct CCReportItem: Decodable, Identifiable {
    var id: String { callId }
    let callId: String
    var startedAt: String?
    var answeredAt: String?
    var endedAt: String?
    var direction: String?
    var remoteNumber: String?
    var contactName: String?
    var blocked: Bool?
    var sim: CCReportSIM?
    var gatewayTimeZone: String?
    var answerMode: String?
    var answeredByPlatform: String?
    var originatingPlatform: String?
    var conflictDisposition: String?
    var transcriptState: String?
    var transcriptError: CCTranscriptFailure?
    var summary: String?
    var actionItems: [String]?
    var classification: String?
    var blockRecommended: Bool?
    var blockCategory: String?
    var blockReason: String?
    var hasAiTranscript: Bool?
    /// S67c: same meaning as `CCCallRecord.unseen` (missing → false).
    var unseen: Bool?
    var `internal`: Bool?
    var peerSimId: String?
    var peerSimLabel: String?

    func showsUnseenDot(seen: Set<String>) -> Bool { asCallRecord.showsUnseenDot(seen: seen) }

    /// 报告行点开详情时，在 `GET /calls/:id` 返回前先用它画出事实卡。
    var asCallRecord: CCCallRecord {
        CCCallRecord(
            id: callId, simId: sim?.id, direction: direction, remoteNumber: remoteNumber, state: nil,
            startedAt: startedAt, answeredAt: answeredAt, endedAt: endedAt,
            answeredByPlatform: answeredByPlatform, answeredByDevice: nil,
            originatingPlatform: originatingPlatform, failureReason: nil, recordingStatus: nil,
            gatewayTimeZone: gatewayTimeZone, contactName: contactName, blocked: blocked,
            answerMode: answerMode, aiHandling: nil, conflictDisposition: conflictDisposition, blockedSource: nil,
            unseen: unseen, internal: `internal`, peerSimId: peerSimId, peerSimLabel: peerSimLabel
        )
    }
}

struct CCReportPage: Decodable {
    let items: [CCReportItem]
    let page: Int?
    let pageSize: Int?
    let total: Int?
    let totalPages: Int?
}

enum CCReportPeriod: String, CaseIterable, Identifiable {
    case week = "7d", month = "1m", halfYear = "6m", year = "1y"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .week: return "近 7 天"
        case .month: return "近 1 个月"
        case .halfYear: return "近 6 个月"
        case .year: return "近 1 年"
        }
    }
}

// MARK: - 转录与 AI 对话

struct CCTranscriptFailure: Decodable, Equatable {
    var code: String?
    var message: String?
}

struct CCTranscriptSegment: Decodable, Equatable {
    var track: String?
    var speaker: String?
    var text: String
    var startMs: Double?
    var endMs: Double?
}

struct CCTranscriptResult: Decodable {
    var text: String?
    var segments: [CCTranscriptSegment]?
    var summary: String?
    var actionItems: [String]?
    var blockRecommended: Bool?
    var blockReason: String?
}

struct CCTranscriptJob: Decodable {
    var callId: String?
    var status: String
    var nextAttemptAt: String?
    var error: CCTranscriptFailure?
    var result: CCTranscriptResult?
}

struct CCTranscriptEnvelope: Decodable { let transcript: CCTranscriptJob? }

/// 相邻同轨同说话人的分段合成一段显示。
struct CCTranscriptBlock: Equatable {
    var track: String
    var speaker: String
    var text: String
    var startMs: Double?

    static func blocks(from segments: [CCTranscriptSegment]) -> [CCTranscriptBlock] {
        var out: [CCTranscriptBlock] = []
        for segment in segments {
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let track = segment.track ?? "", speaker = segment.speaker ?? ""
            if let last = out.last, last.track == track, last.speaker == speaker {
                out[out.count - 1].text += " " + text
            } else {
                out.append(.init(track: track, speaker: speaker, text: text, startMs: segment.startMs))
            }
        }
        return out
    }
}

struct CCAiTranscriptSegment: Decodable, Equatable {
    var role: String
    var text: String
    var at: String?
}

struct CCAiTranscriptEnvelope: Decodable { let items: [CCAiTranscriptSegment] }

// MARK: - 录音

/// 宽松解析的录音清单：media_node v1（artifacts[].name）与 Pixel v2/v3（tracks[] + derivedTracks[]）。
/// ponytail: 不做 iOS 的 sha256/结构校验，服务器与 iOS 已校验；需要时再移植 `isValid(for:)`。
struct CCRecordingManifest: Decodable {
    struct Track: Equatable {
        var track: String
        var bytes: Int64
        var durationMs: Int64?
        var derived: Bool
    }

    var source: String
    var version: Int
    var finalizedAt: String?
    var archiveComplete: Bool
    var captureComplete: Bool?
    var tracks: [Track]

    /// WAV 头 44 字节、Ogg/Opus 头页 95 字节；原始轨都不超过这个就是空录音。
    static let headerOnlyByteCeiling: Int64 = 128

    var originals: [Track] { tracks.filter { !$0.derived } }
    var isEmptyCapture: Bool {
        !originals.isEmpty && originals.allSatisfy { $0.bytes <= Self.headerOnlyByteCeiling }
    }

    private enum Keys: String, CodingKey {
        case source, version, finalizedAt, endedAt, complete, archiveComplete, captureComplete
        case artifacts, tracks, derivedTracks
    }
    private struct Artifact: Decodable { var name: String; var bytes: Int64?; var durationMs: Int64? }
    private struct PixelTrack: Decodable { var track: String; var bytes: Int64?; var durationMs: Int64? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "media_node"
        finalizedAt = try c.decodeIfPresent(String.self, forKey: .finalizedAt)
            ?? c.decodeIfPresent(String.self, forKey: .endedAt)
        archiveComplete = try c.decodeIfPresent(Bool.self, forKey: .archiveComplete)
            ?? c.decodeIfPresent(Bool.self, forKey: .complete) ?? false
        captureComplete = try c.decodeIfPresent(Bool.self, forKey: .captureComplete)
        var tracks: [Track] = []
        if let pixel = try c.decodeIfPresent([PixelTrack].self, forKey: .tracks) {
            tracks += pixel.map { Track(track: $0.track, bytes: $0.bytes ?? 0, durationMs: $0.durationMs, derived: false) }
        } else if let artifacts = try c.decodeIfPresent([Artifact].self, forKey: .artifacts) {
            for item in artifacts where item.name.hasSuffix(".ogg") || item.name.hasSuffix(".wav") {
                let name = String(item.name.split(separator: ".").first ?? "")
                tracks.append(Track(track: name, bytes: item.bytes ?? 0, durationMs: item.durationMs, derived: false))
            }
        }
        if let derived = try c.decodeIfPresent([PixelTrack].self, forKey: .derivedTracks) {
            tracks += derived.map { Track(track: $0.track, bytes: $0.bytes ?? 0, durationMs: $0.durationMs, derived: true) }
        }
        let order = ["remote_original", "caller_original", "caller_playout"]
        self.tracks = tracks.sorted { (order.firstIndex(of: $0.track) ?? 9) < (order.firstIndex(of: $1.track) ?? 9) }
    }
}

struct CCRecordingEnvelope: Decodable { let recording: CCRecordingManifest? }

// MARK: - 标签（返回中文键）

enum CCRecordLabels {
    static func state(_ state: String?) -> String {
        switch state {
        case "incoming_ringing": return "来电响铃"
        case "outgoing_pending": return "等待拨号"
        case "connecting": return "连接中"
        case "active": return "通话中"
        case "ending": return "正在结束"
        case "ended": return "已结束"
        case "failed": return "失败"
        default: return "状态待确认"
        }
    }

    static func direction(_ direction: String?) -> String {
        direction == "outgoing" ? "呼出" : "呼入"
    }

    /// S58: device-dialed source text by gateway kind; the wire value stays `pixel`.
    static func directDial(_ gatewayKind: String?) -> String {
        gatewayKind == "dji4g" ? "通过 DJI 4G 模组拨打" : "通过手机拨打"
    }

    static func platform(_ platform: String?, gatewayKind: String? = nil) -> String? {
        switch platform {
        case "ios": return "iPhone 端"
        case "android": return "Android 端"
        case "macos": return "Mac 端"
        case "web": return "网页端"
        case "ai": return "AI 接听"
        case "pixel": return directDial(gatewayKind)
        case "device": return "网关本机"   // S72: answered on the gateway itself, not through VoDog
        default: return nil
        }
    }

    static func blockedSource(_ source: String?) -> String? {
        switch source {
        case "phone": return "手机自动拦截"
        case "gateway": return "网关拦截"
        case "control": return "服务器拦截"
        default: return nil
        }
    }

    /// S38 行徽标：拦截 > 忙线处置 > Pixel 直拨。
    static func badge(failureReason: String?, blockedSource: String?, conflictDisposition: String?,
                      originatingPlatform: String?, gatewayKind: String? = nil) -> String? {
        if failureReason == "number_blocked" { return self.blockedSource(blockedSource) ?? "已拦截" }
        if conflictDisposition == "rejected" || failureReason == "busy_auto_rejected" { return "忙线未接" }
        if conflictDisposition == "ai_answered" { return "忙线 AI 代接" }
        return originatingPlatform == "pixel" ? directDial(gatewayKind) : nil
    }

    static func badge(_ call: CCCallRecord) -> String? {
        badge(failureReason: call.failureReason, blockedSource: call.blockedSource,
              conflictDisposition: call.conflictDisposition, originatingPlatform: call.originatingPlatform,
              gatewayKind: call.gatewayKind)
    }

    /// S72 内部通话「A → B」（主叫卡 → 被叫卡）：呼入腿 = 对端 → 本卡，呼出腿 = 本卡 → 对端。nil = 非内部。
    static func internalRoute(_ call: CCCallRecord, ownSIM: String?) -> (from: String, to: String)? {
        guard call.internal == true else { return nil }
        let trim = { (v: String?) in v.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } }
        let peer = trim(call.peerSimLabel) ?? trim(call.remoteNumber) ?? "—"
        let own = trim(ownSIM) ?? "—"
        return call.isIncoming ? (peer, own) : (own, peer)
    }

    /// S72 占用文案「通话中 · 由 {端/设备名} 接听 · 自 hh:mm」的参数；非通话中返回 nil。
    static func occupancy(_ call: CCCallRecord) -> (owner: (isKey: Bool, text: String), since: String)? {
        guard call.state == "active", let owner = owner(call) else { return nil }
        let clock = CCTime.gatewayClock(call.answeredAt ?? call.startedAt, zone: call.gatewayTimeZone)
        return (owner, String(clock.suffix(5)))   // "yyyy-MM-dd HH:mm" → "HH:mm"; "—" stays
    }

    /// 接听方式：未接 / AI 接听 / 超时 AI / 真人。
    static func answerMethod(answerMode: String?, answeredByPlatform: String?, answeredAt: String?) -> String {
        guard !(answeredAt ?? "").trimmingCharacters(in: .whitespaces).isEmpty else { return "未接" }
        guard answeredByPlatform == "ai" else { return "真人" }
        return answerMode == "timeout_ai" ? "超时 AI" : "AI 接听"
    }

    /// 接听端：设备名优先，其次平台标签（接听端缺省时退到发起端）。返回 (是否为键, 文本)。
    static func owner(_ call: CCCallRecord) -> (isKey: Bool, text: String)? {
        if let device = call.answeredByDevice?.trimmingCharacters(in: .whitespaces), !device.isEmpty {
            return (false, device)
        }
        let platform = call.answeredByPlatform ?? call.originatingPlatform
        if let key = self.platform(platform, gatewayKind: call.gatewayKind) { return (true, key) }
        return platform.map { (false, $0) }
    }

    /// AI 代接状态（实际处理中 / 模式）。
    static func aiHandling(_ call: CCCallRecord) -> String? {
        if call.aiHandling == true { return "AI 正在处理" }
        switch call.answerMode {
        case "ai": return "AI 即接模式"
        case "timeout_ai": return "超时转 AI 模式"
        default: return nil
        }
    }

    static func track(_ track: String) -> String {
        switch track {
        case "remote_original": return "对方原声"
        case "caller_original": return "我的原声"
        case "caller_playout": return "手机播放"
        case "conversation": return "双方混音"
        default: return "其他声轨"
        }
    }

    static func speaker(track: String, speaker: String) -> String {
        if track == "remote_original" || speaker == "remote" { return "对方" }
        if track == "caller_original" || speaker == "vodog_user" { return "本人" }
        return speaker.isEmpty ? "其他声轨" : speaker
    }

    static func aiRole(_ role: String) -> String { role == "ai" ? "AI 助理" : "对方" }

    static func recordingSource(_ source: String, gatewayKind: String? = nil) -> String {
        guard source == "pixel" else { return "服务器录音" }
        return gatewayKind == "dji4g" ? "DJI 4G 原始归档" : "Pixel 原始归档"
    }

    /// 报告摘要位：有摘要显示摘要，否则说明原因。返回 (是否占位, 文本；占位时为键)。
    static func reportSummary(transcriptState: String?, errorCode: String?, summary: String?) -> (placeholder: Bool, text: String) {
        let text = (summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return (false, text) }
        switch transcriptState {
        case "queued", "running", "retry": return (true, "转录处理中…")
        case "none": return (true, "无转录：录音为空")
        case "failed": return (true, errorCode == "RECORDING_EMPTY" ? "无转录：录音为空" : "转录失败，原始录音仍可查看")
        default: return (true, "暂无摘要")
        }
    }

    enum BlockBadge: Equatable { case recommended(reason: String?), unclassified, none }

    static func blockBadge(blockRecommended: Bool?, blockReason: String?) -> BlockBadge {
        switch blockRecommended {
        case .some(true):
            let reason = (blockReason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return .recommended(reason: reason.isEmpty ? nil : reason)
        case .some(false): return .none
        case nil: return .unclassified
        }
    }
}

// MARK: - 时间

enum CCTime {
    static func parseISO(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    static func zone(_ identifier: String?) -> TimeZone {
        identifier.flatMap(TimeZone.init(identifier:)) ?? .current
    }

    /// 网关时区下的 `yyyy-MM-dd HH:mm`。
    static func gatewayClock(_ value: String?, zone identifier: String?) -> String {
        guard let date = parseISO(value) else { return "—" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone(identifier)
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    static func talkSeconds(answeredAt: String?, endedAt: String?) -> Int? {
        guard let start = parseISO(answeredAt), let end = parseISO(endedAt), end >= start else { return nil }
        return Int(end.timeIntervalSince(start).rounded(.down))
    }

    static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded(.down))
        if total >= 3600 { return String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60) }
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// 通话时长（S82 统一短格式：「48 秒」/「2 分 05 秒」）；未接通返回 nil（不显示 0）。
    static func duration(answeredAt: String?, endedAt: String?) -> String? {
        talkSeconds(answeredAt: answeredAt, endedAt: endedAt).map {
            $0 < 60 ? "\($0) 秒" : String(format: "%d 分 %02d 秒", $0 / 60, $0 % 60)
        }
    }
}

// MARK: - 播放决策与加载看门狗

enum CCPlaybackPolicy {
    enum Action: Equatable { case pause, resume, restart }

    /// 点同一条轨：有播放器才暂停/继续；加载中（可能卡住）或失败都重新加载，旋转指示永远可以点掉。
    static func action(isCurrent: Bool, hasPlayer: Bool, isPlaying: Bool) -> Action {
        guard isCurrent, hasPlayer else { return .restart }
        return isPlaying ? .pause : .resume
    }

    static let loadTimeoutSeconds: Double = 30
}

struct CCTimeoutError: Error, Equatable {}

enum CCAsync {
    /// 在 `seconds` 内没完成就取消 `operation` 并抛 `CCTimeoutError`。先完成的一方胜出，不等待被取消的一方收尾：
    /// 不响应取消的操作（例如卡在单飞刷新上的请求）也不会让调用者永远挂住。
    static func withTimeout<T: Sendable>(_ seconds: Double, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let race = Race<T>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                race.start(continuation, work: Task {
                    do { race.finish(.success(try await operation())) } catch { race.finish(.failure(error)) }
                }, timer: Task {
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    race.finish(.failure(CCTimeoutError()))
                })
            }
        } onCancel: {
            race.finish(.failure(CancellationError()))
        }
    }

    private final class Race<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<T, Error>?
        private var pending: Result<T, Error>?
        private var tasks: [Task<Void, Never>] = []
        private var done = false

        func start(_ continuation: CheckedContinuation<T, Error>, work: Task<Void, Never>, timer: Task<Void, Never>) {
            lock.lock()
            tasks = [work, timer]
            if let pending { lock.unlock(); tasks.forEach { $0.cancel() }; continuation.resume(with: pending); return }
            self.continuation = continuation
            lock.unlock()
        }

        func finish(_ result: Result<T, Error>) {
            lock.lock()
            guard !done else { lock.unlock(); return }
            done = true
            let continuation = self.continuation
            self.continuation = nil
            if continuation == nil { pending = result }
            let tasks = self.tasks
            lock.unlock()
            tasks.forEach { $0.cancel() }
            continuation?.resume(with: result)
        }
    }
}
