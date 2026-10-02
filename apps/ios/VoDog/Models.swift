import Foundation

struct User: Codable, Sendable { let id: String; let username: String; let role: String? }
struct LoginResponse: Codable, Sendable { let token: String; let refreshToken: String?; let expiresAt: String?; let user: User }
struct MeResponse: Codable, Sendable { let user: User }
struct ItemEnvelope<T: Codable & Sendable>: Codable, Sendable { let items: [T] }

/// S26: the paged form of `ItemEnvelope`. `GET calls`, `GET reports/calls` and `GET blocklist/interceptions`
/// answer `{items, page, pageSize, total, totalPages}` when a `page` is asked for; a Control that predates the
/// contract answers the bare `{items}` it always did. Every paging field is therefore optional and
/// `supported` — "this server really counted the pages" — is the single fact the pager is shown by.
struct PagedEnvelope<T: Decodable & Sendable>: Decodable, Sendable {
    let items: [T]
    let page: Int?
    let pageSize: Int?
    let total: Int?
    let totalPages: Int?

    var supported: Bool { totalPages != nil }
}

/// S89: keyset cursor of `GET sms`. An older Control omits `nextCursor`, which decodes as nil = last page.
struct SMSPageCursor: Codable, Sendable, Equatable { let before: String; let beforeId: String }
struct SMSPageEnvelope<T: Codable & Sendable>: Codable, Sendable { let items: [T]; let nextCursor: SMSPageCursor? }

/// S89: every SMS refresh walks the whole list from page one, then the caller replaces wholesale (S32/S88
/// "missing from the poll = deleted" depends on it). Any page error throws, so the caller keeps its last list.
/// ponytail: fetches everything on every poll; at ~2–3k rows or ~500 KB per refresh switch to a thread
/// summary endpoint + per-thread paging (or tombstone sync).
enum SMSFullListPolicy {
    static let pageLimit = 500
    static let maxPages = 20

    static func query(_ cursor: SMSPageCursor?) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(pageLimit))]
        if let cursor {  // URLComponents percent-encodes the ISO timestamp.
            items += [URLQueryItem(name: "before", value: cursor.before), URLQueryItem(name: "beforeId", value: cursor.beforeId)]
        }
        return items
    }

    /// Rollback safety: a pre-S89 Control answers 400 to `limit=500` on page one; then one `limit=100` request is
    /// the whole result, unpaged. Only that case falls back — any other error, or a 400 on a later page, throws.
    static let legacyQuery = [URLQueryItem(name: "limit", value: "100")]

    /// Page order, first occurrence of an id wins. `capped` = stopped at `maxPages` with a cursor still pending.
    /// `fetch` gets the exact query items of each request.
    static func fetchAll<T: Identifiable & Codable & Sendable>(
        fetch: ([URLQueryItem]) async throws -> SMSPageEnvelope<T>
    ) async throws -> (items: [T], capped: Bool) where T.ID: Hashable {
        var items: [T] = []
        var seen = Set<T.ID>()
        var cursor: SMSPageCursor?
        for pageIndex in 0..<maxPages {
            let page: SMSPageEnvelope<T>
            do {
                page = try await fetch(query(cursor))
            } catch APIError.server(400, _, _) where pageIndex == 0 {
                return (try await fetch(legacyQuery).items, false)
            }
            for item in page.items where seen.insert(item.id).inserted { items.append(item) }
            guard let next = page.nextCursor else { return (items, false) }
            cursor = next
        }
        return (items, true)
    }
}

/// S58：网关类型只用来选文字，不用来判断能力；缺失或未知一律按 Pixel。
enum GatewayKind: Equatable, Sendable {
    case pixel, dji4g
    init(_ raw: String?) { self = raw == "dji4g" ? .dji4g : .pixel }

    var deviceName: String { self == .dji4g ? "DJI 4G 模组" : "Pixel" }
    var shortPrefix: String { self == .dji4g ? "DJI-" : "PX-" }
    var directDialTitle: String { self == .dji4g ? "通过 DJI 4G 模组拨打" : "通过手机拨打" }
    var busyTitle: String { self == .dji4g ? "DJI 4G 模组通话中" : "手机通话中" }
    var archiveTitle: String { self == .dji4g ? "DJI 4G 原始归档" : "Pixel 原始归档" }
}

struct SIMChannel: Codable, Identifiable, Sendable {
    let id: String
    let gatewayId: String?
    let label: String?
    let phoneLabel: String?
    let slotIndex: Int?
    let online: Bool?
    let telephonyReady: Bool?
    let mediaReady: Bool?
    let smsReady: Bool?
    let version: Int?
    let present: Bool?
    let assignmentPending: Bool?
    let countryIso: String?
    let embedded: Bool?
    let timeZone: String?
    let settings: SIMSettings?
    /// S58：`pixel` | `dji4g`；旧 Control 不发。
    var gatewayKind: String? = nil
    /// S91：`gateways.name`；旧 Control 不发。
    var gatewayName: String? = nil
}

struct SIMSettings: Codable, Sendable, Equatable {
    let mode: String
    let timeoutSeconds: Int
    let version: Int
    let appliedVersion: Int?
    let availableModes: [String]?
    let aiUnavailableReason: String?

    /// Older servers did not advertise capabilities. Fail closed so a missing
    /// field can never make an AI mode appear usable.
    var effectiveAvailableModes: Set<String> {
        Set(availableModes ?? [ReceptionMode.normal.rawValue])
    }

    func isAvailable(_ mode: ReceptionMode) -> Bool {
        effectiveAvailableModes.contains(mode.rawValue)
    }

    func mergingCapabilities(from previous: SIMSettings?) -> SIMSettings {
        guard availableModes == nil, let previous else { return self }
        return SIMSettings(
            mode: mode,
            timeoutSeconds: timeoutSeconds,
            version: version,
            appliedVersion: appliedVersion,
            availableModes: previous.availableModes,
            aiUnavailableReason: aiUnavailableReason ?? previous.aiUnavailableReason
        )
    }
}

struct CallRecord: Codable, Identifiable, Sendable {
    let id: String
    let simId: String?
    let direction: String?
    let remoteNumber: String?
    let state: String?
    let startedAt: String?
    let answeredAt: String?
    let endedAt: String?
    let answeredByPlatform: String?
    let answeredByDevice: String?
    let originatingPlatform: String?
    /// S94b: 机主在 Pixel 本机接入了 AI 代接；缺失 = false。`var` + 默认值让既有成员初始化器不变。
    var ownerJoinedLocal: Bool? = nil
    let claimedByCurrentSession: Bool?
    let failureReason: String?
    let recordingStatus: String?
    let transcript: String?
    let gatewayTimeZone: String?
    /// S20 decision 6. Absent on older servers, so the clients keep their own derivation as the fallback.
    let occupancy: CallOccupancy?
    /// S21 decision 3: the contact match and the block state are decided by the server per page. All four are
    /// optional because a Control that predates S21 omits them entirely during the staged rollout.
    let contactId: String?
    let contactName: String?
    let blocked: Bool?
    let blockedEntryId: String?
    /// S22 decision 4. `mode_snapshot` as the server saw it when the call arrived: `normal` | `ai` | `timeout_ai`.
    /// Declared `var` so the memberwise initialiser defaults them to nil; like `SIMSettings.availableModes` they
    /// are absent on a Control that predates S22 and every derived rule must then fail closed (no suppression).
    var answerMode: String?
    /// Whether an AI run currently owns this ringing call. Nil on an older server, which means "not AI".
    var aiHandling: Bool?
    var aiTriggerAt: String?
    /// S38 决策：忙线冲突的处置结果 `rejected` | `ai_answered`。pre-S38 Control 不发这个字段。
    var conflictDisposition: String?
    /// S38：这通来电是被谁拦下的 `phone` | `gateway` | `control`。只有 `failureReason == "number_blocked"` 的行才有。
    var blockedSource: String?
    /// S58：这通电话所在 SIM 的网关类型，只决定文字。
    var gatewayKind: String?
    /// S67c：满足「待查看通话」规则。pre-S67c Control 不发，按 false 处理。
    var unseen: Bool?
    /// S72：同一 owner 的托管卡互打。pre-S72 Control 不发，按 false / nil。
    var `internal`: Bool?
    var peerSimId: String?
    var peerSimLabel: String?
    /// S81：被叫 SIM 显示名（备注，缺省号码）。pre-S81 Control 不发。
    var simLabel: String?

    var isInternal: Bool { `internal` == true }
    var directionTitle: String { direction == "incoming" ? "呼入" : "呼出" }
    var isBlocked: Bool { blocked == true }
    /// 没接通就结束的来电；被拦截的来电不算未接。
    var isMissedIncoming: Bool {
        direction == "incoming" && (answeredAt ?? "").isEmpty && (state == "ended" || state == "failed")
            && failureReason != "number_blocked" && !isInternal
    }
    /// 列表行的状态列：未接来电优先于原始状态；S72 忙线自动拒接单列「忙线未接」。
    var rowStateTitle: String {
        guard isMissedIncoming else { return callStateTitle(state) }
        return failureReason == "busy_auto_rejected" ? "忙线未接" : "未接来电"
    }
    /// S72：内部通话行首写「内部通话 A → B」，否则 nil（调用方照旧显示号码）。
    func internalTitle(in sims: [SIMChannel]) -> String? {
        guard isInternal else { return nil }
        return InternalCallTitle.text(direction: direction, thisSimLabel: simTitle(simId, in: sims), peerSimLabel: peerSimLabel)
    }
    /// 行首用的“号码”与联系人名：内部通话换成卡到卡的标题、不带联系人。
    func shownNumber(in sims: [SIMChannel]) -> String? { internalTitle(in: sims) ?? remoteNumber }
    var shownContactName: String? { isInternal ? nil : contactName }
    /// 列表/详情要不要画屏蔽标。`isBlocked` 是号码此刻还在不在黑名单上（决定“取消屏蔽”），被拦下的那通电话
    /// 就算号码后来解除了屏蔽，也仍旧是被拦截的通话，所以两者分开。
    var showsBlockedMark: Bool { isBlocked || failureReason == "number_blocked" }

    /// S38 三端合同：列表行与详情多出来的那一行手机侧事实。优先级是固定的——忙线处置说明这通电话为什么
    /// 这样收场，比“谁拨的”更重要。`failureReason` 单独出现时也算拒接，这样旧字段齐、新字段缺的行也有标签。
    var s38BadgeTitle: String? {
        // 拦截排在最前：被拦下的来电根本没有接通过，`originatingPlatform` 之类的字段说什么都不作数。
        if failureReason == "number_blocked" { return Interception.sourceTitle(blockedSource) ?? "已拦截" }
        if conflictDisposition == "rejected" || failureReason == "busy_auto_rejected" { return "忙线自动拒接" }
        if conflictDisposition == "ai_answered" { return "忙线 AI 代接" }
        return originatingPlatform == "pixel" ? GatewayKind(gatewayKind).directDialTitle : nil
    }

    /// S22 decision 4, the one condition all four clients share: an `ai` mode call an AI run is actually
    /// handling. `timeout_ai` keeps ringing until the AI takes over, so it is deliberately excluded.
    var suppressesRinging: Bool { answerMode == "ai" && aiHandling == true }
}

/// S20 decision 6: the server states who holds the gateway lock instead of each client deriving it differently.
///
/// Declared `Codable` rather than `Decodable` only because `CallRecord` is `Codable`; nothing encodes it. Every
/// field decodes defensively so a server that ships a partial object cannot fail the whole `/calls` response.
struct CallOccupancy: Codable, Sendable, Equatable {
    /// Whether this call currently holds a row in `gateway_call_locks`. Terminal calls report false.
    let holdsLock: Bool
    /// `gateway_call_locks.acquired_at`, RFC 3339. Nil when the lock predates the column or is not held.
    let lockedSince: String?
    /// `answeredByPlatform ?? originatingPlatform`: `ios` | `android` | `web` | `ai`.
    let occupantPlatform: String?
    let occupantDevice: String?
    /// Whether the calling session is the originator or the claim winner.
    let isCurrentSession: Bool
    /// Whether the caller is the snapshot owner and the call is still non-terminal.
    let canRelease: Bool

    init(
        holdsLock: Bool,
        lockedSince: String? = nil,
        occupantPlatform: String? = nil,
        occupantDevice: String? = nil,
        isCurrentSession: Bool = false,
        canRelease: Bool = false
    ) {
        self.holdsLock = holdsLock
        self.lockedSince = lockedSince
        self.occupantPlatform = occupantPlatform
        self.occupantDevice = occupantDevice
        self.isCurrentSession = isCurrentSession
        self.canRelease = canRelease
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        holdsLock = try container.decodeIfPresent(Bool.self, forKey: .holdsLock) ?? false
        lockedSince = try container.decodeIfPresent(String.self, forKey: .lockedSince)
        occupantPlatform = try container.decodeIfPresent(String.self, forKey: .occupantPlatform)
        occupantDevice = try container.decodeIfPresent(String.self, forKey: .occupantDevice)
        isCurrentSession = try container.decodeIfPresent(Bool.self, forKey: .isCurrentSession) ?? false
        canRelease = try container.decodeIfPresent(Bool.self, forKey: .canRelease) ?? false
    }
}

struct SMSMessage: Codable, Identifiable, Sendable {
    let id: String
    let simId: String?
    let remoteNumber: String?
    let conversationAddress: String?
    let replyNumber: String?
    let canReply: Bool?
    let direction: String?
    let body: String?
    let state: String?
    let missingParts: Bool?
    let createdAt: String?
    let receivedAt: String?
    let sentAt: String?
    let deliveredAt: String?
    let failureReason: String?
    /// S21 decision 3, same staged-rollout rule as `CallRecord`.
    let contactId: String?
    let contactName: String?
    let blocked: Bool?
    let blockedEntryId: String?
    /// S67c：未读来信。pre-S67c Control 不发，按 false 处理。
    var unread: Bool?
}

struct EmptyResponse: Codable, Sendable {}

struct PasskeyItem: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let createdAt: String
    let deviceType: String?
    let backedUp: Bool?
    let transports: [String]?
    /// S18 decision 7 additions. All optional: older servers (and older rows) return none of them.
    let label: String?
    let displayName: String?
    let aaguid: String?
    let clientPlatform: String?
    let authenticatorAttachment: String?
    let lastUsedAt: String?

    var deviceTypeTitle: String { deviceType?.isEmpty == false ? deviceType! : "Passkey" }
}

struct TranscriptEnvelope: Codable, Sendable { let transcript: TranscriptJob? }

struct TranscriptJob: Codable, Identifiable, Sendable {
    let id: String
    let callId: String
    let status: String
    let attempts: Int
    let nextAttemptAt: String?
    let error: TranscriptFailure?
    let result: TranscriptResult?
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
}

struct TranscriptFailure: Codable, Sendable {
    let code: String
    let message: String?
}

struct TranscriptResult: Codable, Sendable {
    let text: String
    let segments: [TranscriptSegment]
    let providers: [TranscriptProvider]
    let advertisingClassification: String
    let includeInReports: Bool
    let summary: String?
    let actionItems: [String]
    /// S22 classifier-v2 fields. Optional so historical transcript results remain decodable.
    let blockRecommended: Bool?
    let blockCategory: String?
    let blockReason: String?
}

struct TranscriptSegment: Codable, Identifiable, Sendable {
    var id: String { "\(track)-\(startMs ?? -1)-\(endMs ?? -1)-\(text)" }
    let track: String
    let speaker: String
    let text: String
    let startMs: Double?
    let endMs: Double?

    var speakerTitle: String {
        switch (track, speaker) {
        case ("remote_original", _), (_, "remote"): "对方"
        case ("caller_original", _), ("caller_uplink", _), (_, "vodog_user"): "本人"
        default: speaker
        }
    }

    var trackTitle: String {
        switch track {
        case "remote_original": "对方原声"
        case "caller_original": "我的原声"
        case "caller_uplink": "本机上行（含本机接入）"
        default: "其他声轨"
        }
    }

    var playbackCaption: String {
        guard let start = startMs, start >= 0 else { return trackTitle }
        return "\(trackTitle) · \(PlaybackClock.format(start / 1_000))"
    }
}

/// One readable transcript block: consecutive segments of the same track and speaker joined into running text.
struct TranscriptBlock: Identifiable, Sendable {
    var id: String { "\(track)|\(speaker)|\(startMs ?? -1)|\(text.prefix(24))" }
    let track: String
    let speaker: String
    let text: String
    let startMs: Double?

    var trackTitle: String {
        switch track {
        case "remote_original": "对方原声"
        case "caller_original": "我的原声"
        case "caller_uplink": "本机上行（含本机接入）"
        default: "其他声轨"
        }
    }
}

/// Transcripts used to store one segment per spoken word, so the record page showed one line per word with a
/// per-word timestamp. Display merges them into running text per track; stored segments are never rewritten.
enum TranscriptText {
    private static let noSpaceBefore = try? NSRegularExpression(pattern: #"^[\s,.;:!?%)}\]、。，！？；：]"#)
    private static let noSpaceAfter = try? NSRegularExpression(pattern: #"[\s({\[“「『、。，！？；：]$"#)
    private static let cjkEnd = try? NSRegularExpression(pattern: #"[\p{Han}\p{Hiragana}\p{Katakana}]$"#)
    private static let cjkStart = try? NSRegularExpression(pattern: #"^[\p{Han}\p{Hiragana}\p{Katakana}]"#)

    private static func matches(_ expression: NSRegularExpression?, _ value: String) -> Bool {
        guard let expression else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return expression.firstMatch(in: value, options: [], range: range) != nil
    }

    /// Joins transcript fragments with the same spacing rules the server uses for word annotations.
    static func join(_ parts: [String]) -> String {
        parts.reduce(into: "") { text, part in
            let word = part.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !word.isEmpty else { return }
            guard !text.isEmpty else { text = word; return }
            if matches(noSpaceBefore, word) || matches(noSpaceAfter, text) || (matches(cjkEnd, text) && matches(cjkStart, word)) {
                text += word
            } else {
                text += " " + word
            }
        }
    }

    /// Merges consecutive segments of the same track and speaker into one block, dropping per-word timing.
    static func blocks(from segments: [TranscriptSegment]) -> [TranscriptBlock] {
        var blocks: [TranscriptBlock] = []
        for segment in segments {
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            if let last = blocks.last, last.track == segment.track, last.speaker == segment.speaker {
                blocks[blocks.count - 1] = TranscriptBlock(track: last.track, speaker: last.speaker,
                    text: join([last.text, text]), startMs: last.startMs)
                continue
            }
            blocks.append(TranscriptBlock(track: segment.track, speaker: segment.speaker, text: text, startMs: segment.startMs))
        }
        return blocks
    }
}

struct TranscriptProvider: Codable, Sendable {
    let track: String
    let provider: String
    let model: String?
    let version: String?
}

struct CallReportEnvelope: Decodable, Sendable {
    let window: CallReportWindow
    let items: [CallReportItem]
    /// S26 paging, carried here rather than in `PagedEnvelope` because this route also returns its `window`.
    /// Optional for the same reason: an older Control answers `{window, items}` and gets one page.
    let page: Int?
    let pageSize: Int?
    let total: Int?
    let totalPages: Int?

    var supported: Bool { totalPages != nil }
}

struct CallReportWindow: Decodable, Sendable {
    /// S22: absent when the window came from an explicit `from`/`to` pair instead of a named period.
    let period: String?
    let timeZone: String
    let fromInclusive: String
    let toExclusive: String
}

struct ReportTranscriptError: Decodable, Sendable, Equatable {
    let code: String?
    let message: String?
}

/// S22 decision 10. Every call in the window now has a report row, so almost nothing here is guaranteed: a call
/// with no transcript has no summary, no URLs and no classification. Decoding is written by hand rather than
/// synthesised so that both a pre-S22 Control (which sends `advertisingClassification` and no
/// `transcriptState`) and the S22 contract decode into the same value without either failing the whole page.
struct CallReportItem: Decodable, Identifiable, Sendable {
    var id: String { callId }
    let callId: String
    let startedAt: String
    let answeredAt: String?
    let endedAt: String?
    let direction: String?
    let remoteNumber: String?
    let contactName: String?
    let contactId: String?
    /// Mutable so "立即屏蔽" can flip the card in place instead of reloading the whole report.
    var blocked: Bool?
    var blockedEntryId: String?
    let sim: ReportSIM
    let gatewayTimeZone: String?
    let answerMode: String?
    let answeredByPlatform: String?
    let recordingStatus: String?
    /// `none | queued | running | retry | succeeded | failed`, nil on a pre-S22 Control.
    let transcriptState: String?
    let transcriptError: ReportTranscriptError?
    let summary: String?
    let actionItems: [String]
    let classification: String?
    /// Nil for rows classified before S22's `classifierVersion: 2`; the card then says 未分类.
    let blockRecommended: Bool?
    let blockCategory: String?
    let blockReason: String?
    let hasAiTranscript: Bool?
    let transcriptCompletedAt: String?
    let callUrl: String?
    let transcriptUrl: String?
    let recordingUrl: String?
    let aiTranscriptUrl: String?
    /// S38 报告 DTO 已带；`pixel` = 设备上直拨，没有服务器录音。
    let originatingPlatform: String?
    /// S94b: 缺失 = false。
    let ownerJoinedLocal: Bool
    /// S58: `pixel | dji4g`，缺失按 Pixel；只换录音来源文字。
    let gatewayKind: String?
    /// Pre-S22 field, kept so an old server still round-trips; the UI no longer prints 纳入/排除 wording.
    let advertisingClassification: String?
    /// S67c: same pending rule as `/badges`; absent on a pre-S67c Control → false.
    let unseen: Bool
    /// S72：内部通话与忙线拒接原因；pre-S72 Control 不发 → false / nil。
    let isInternal: Bool
    let peerSimLabel: String?
    let failureReason: String?

    var isBlocked: Bool { blocked == true }
    /// 报告卡首行：内部通话写「内部通话 A → B」。
    var titleText: String {
        isInternal
            ? InternalCallTitle.text(direction: direction, thisSimLabel: sim.label, peerSimLabel: peerSimLabel)
            : ContactDisplay.nameWithNumber(number: remoteNumber, contactName: contactName)
    }
    var answerMethod: CallAnswerMethod {
        CallAnswerMethod.resolve(
            answerMode: answerMode, answeredByPlatform: answeredByPlatform, answeredAt: answeredAt,
            failureReason: failureReason, isInternal: isInternal
        )
    }
    var hasAiTranscriptText: Bool { hasAiTranscript == true }

    private enum CodingKeys: String, CodingKey {
        case callId, startedAt, answeredAt, endedAt, direction, remoteNumber, contactName, contactId
        case blocked, blockedEntryId, sim, gatewayTimeZone, answerMode, answeredByPlatform, recordingStatus
        case transcriptState, transcriptError, summary, actionItems, classification
        case blockRecommended, blockCategory, blockReason, hasAiTranscript, transcriptCompletedAt
        case callUrl, transcriptUrl, recordingUrl, aiTranscriptUrl, advertisingClassification, originatingPlatform, ownerJoinedLocal, gatewayKind, unseen
        case `internal`, peerSimLabel, failureReason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        callId = try c.decode(String.self, forKey: .callId)
        startedAt = try c.decode(String.self, forKey: .startedAt)
        sim = try c.decode(ReportSIM.self, forKey: .sim)
        answeredAt = try c.decodeIfPresent(String.self, forKey: .answeredAt)
        endedAt = try c.decodeIfPresent(String.self, forKey: .endedAt)
        direction = try c.decodeIfPresent(String.self, forKey: .direction)
        remoteNumber = try c.decodeIfPresent(String.self, forKey: .remoteNumber)
        contactName = try c.decodeIfPresent(String.self, forKey: .contactName)
        contactId = try c.decodeIfPresent(String.self, forKey: .contactId)
        blocked = try c.decodeIfPresent(Bool.self, forKey: .blocked)
        blockedEntryId = try c.decodeIfPresent(String.self, forKey: .blockedEntryId)
        gatewayTimeZone = try c.decodeIfPresent(String.self, forKey: .gatewayTimeZone)
        answerMode = try c.decodeIfPresent(String.self, forKey: .answerMode)
        answeredByPlatform = try c.decodeIfPresent(String.self, forKey: .answeredByPlatform)
        recordingStatus = try c.decodeIfPresent(String.self, forKey: .recordingStatus)
        transcriptState = try c.decodeIfPresent(String.self, forKey: .transcriptState)
        transcriptError = try c.decodeIfPresent(ReportTranscriptError.self, forKey: .transcriptError)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        actionItems = try c.decodeIfPresent([String].self, forKey: .actionItems) ?? []
        classification = try c.decodeIfPresent(String.self, forKey: .classification)
        blockRecommended = try c.decodeIfPresent(Bool.self, forKey: .blockRecommended)
        blockCategory = try c.decodeIfPresent(String.self, forKey: .blockCategory)
        blockReason = try c.decodeIfPresent(String.self, forKey: .blockReason)
        hasAiTranscript = try c.decodeIfPresent(Bool.self, forKey: .hasAiTranscript)
        transcriptCompletedAt = try c.decodeIfPresent(String.self, forKey: .transcriptCompletedAt)
        callUrl = try c.decodeIfPresent(String.self, forKey: .callUrl)
        transcriptUrl = try c.decodeIfPresent(String.self, forKey: .transcriptUrl)
        recordingUrl = try c.decodeIfPresent(String.self, forKey: .recordingUrl)
        aiTranscriptUrl = try c.decodeIfPresent(String.self, forKey: .aiTranscriptUrl)
        advertisingClassification = try c.decodeIfPresent(String.self, forKey: .advertisingClassification)
        originatingPlatform = try c.decodeIfPresent(String.self, forKey: .originatingPlatform)
        ownerJoinedLocal = try c.decodeIfPresent(Bool.self, forKey: .ownerJoinedLocal) ?? false
        gatewayKind = try c.decodeIfPresent(String.self, forKey: .gatewayKind)
        unseen = try c.decodeIfPresent(Bool.self, forKey: .unseen) ?? false
        isInternal = try c.decodeIfPresent(Bool.self, forKey: .`internal`) ?? false
        peerSimLabel = try c.decodeIfPresent(String.self, forKey: .peerSimLabel)
        failureReason = try c.decodeIfPresent(String.self, forKey: .failureReason)
    }
}

struct ReportSIM: Decodable, Sendable {
    let id: String
    let label: String
    let slotIndex: Int?

    private enum CodingKeys: String, CodingKey { case id, label, slotIndex }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        slotIndex = try c.decodeIfPresent(Int.self, forKey: .slotIndex)
    }
}

struct RecordingEnvelope: Decodable, Sendable { let recording: RecordingManifest? }

enum RecordingSource: String, CaseIterable, Sendable {
    case mediaNode = "media_node"
    case pixel
    func title(gatewayKind: String? = nil, ownerJoinedLocal: Bool = false) -> String {
        self == .mediaNode ? (ownerJoinedLocal ? "服务器录音（不含本机接入）" : "服务器录音") : GatewayKind(gatewayKind).archiveTitle
    }
    /// 设备上直拨的通话没有服务器录音，只有设备原始归档（`source=pixel`），默认直接打开它。
    /// S94b: 机主本机接入的通话，服务器录音不含机主声音，同样默认设备归档。
    static func defaultSource(originatingPlatform: String?, ownerJoinedLocal: Bool = false) -> RecordingSource {
        originatingPlatform == "pixel" || ownerJoinedLocal ? .pixel : .mediaNode
    }
}

struct RecordingManifest: Decodable, Sendable {
    let source: RecordingSource
    let version: Int
    let archiveId: String?
    let callId: String
    let finalizedAt: String
    let archiveComplete: Bool
    let captureComplete: Bool?
    let artifacts: [RecordingArtifact]
    let derivedArtifacts: [DerivedRecordingArtifact]
    /// S94: optional Pixel `uplinkTracks` (with `archiveVersion: 4`). Kept outside `RecordingTrack` so the
    /// two-original-track checks in `isValid` / `isEmptyCapture` stay unchanged.
    let uplinkArtifacts: [UplinkRecordingArtifact]

    var complete: Bool { archiveComplete }

    func artifact(for track: RecordingTrack) -> RecordingArtifact? { artifacts.first { $0.track == track } }

    /// The original pair is stable across manifest versions and is never
    /// substituted by a derived listening artifact.
    var combinedPlaybackArtifacts: [PlaybackArtifact] {
        guard let remote = artifact(for: .remoteOriginal), remote.bytes > 0,
              let caller = artifact(for: .callerOriginal), caller.bytes > 0 else { return [] }
        return [remote.playbackArtifact, caller.playbackArtifact]
    }

    /// Pixel v3 provides a second, explicitly derived convenience pair.
    var compensatedPlaybackArtifacts: [PlaybackArtifact] {
        guard source == .pixel, version == 3,
              let remote = artifact(for: .remoteOriginal), remote.bytes > 0,
              let callerPlayout = derivedArtifacts.first(where: { $0.track == "caller_playout" }),
              callerPlayout.bytes > 0 else { return [] }
        return [remote.playbackArtifact, callerPlayout.playbackArtifact]
    }

    /// S94: remote original + the gateway uplink capture, which also carries the owner speaking on the Pixel.
    var ownerJoinedPlaybackArtifacts: [PlaybackArtifact] {
        guard source == .pixel, let remote = artifact(for: .remoteOriginal), remote.bytes > 0,
              let uplink = uplinkArtifacts.first, uplink.bytes > 0 else { return [] }
        return [remote.playbackArtifact, uplink.playbackArtifact]
    }

    var defaultTogetherMode: RecordingPlaybackController.TogetherMode {
        ownerJoinedPlaybackArtifacts.isEmpty ? .originals : .ownerJoined
    }

    /// A WAV header is 44 bytes and the Ogg/Opus header pages the media node writes are 95; anything at or below
    /// this never carries a single audio frame. S22 decision 7 needs the distinction because "the capture flag is
    /// false" alone is also true of a call that merely dropped frames and is still worth listening to.
    static let headerOnlyByteCeiling: Int64 = 128

    /// S22 decision 7 / R1 §5.4: the archive exists but holds no audio at all — the media node never completed a
    /// manifest, or the Pixel capture failed — and every original track is header-only. This is not a manifest
    /// mismatch, so it must not borrow `invalidResponse`'s "来源或文件信息不一致" wording.
    var isEmptyCapture: Bool {
        let originals = RecordingTrack.allCases.compactMap { artifact(for: $0) }
        guard originals.count == RecordingTrack.allCases.count,
              originals.allSatisfy({ $0.bytes <= Self.headerOnlyByteCeiling }) else { return false }
        switch source {
        case .mediaNode: return !archiveComplete
        case .pixel: return captureComplete == false
        }
    }

    func isValid(for expectedCallID: String, requestedSource: RecordingSource? = nil) -> Bool {
        // R1 §5.1: the media node serialises Go's `RFC3339Nano`, so `finalizedAt` carries fractional seconds
        // whenever the nanosecond part is non-zero. A bare `ISO8601DateFormatter` rejects those outright.
        guard UUID(uuidString: callId) != nil, callId.caseInsensitiveCompare(expectedCallID) == .orderedSame,
              requestedSource.map({ $0 == source }) ?? true,
              GatewayTimeDisplay.parseISO(finalizedAt) != nil else { return false }
        let expectedTracks = Set(RecordingTrack.allCases)
        guard Set(artifacts.map(\.track)) == expectedTracks, artifacts.count == expectedTracks.count,
              artifacts.allSatisfy({ $0.isValid }) else { return false }
        switch source {
        case .mediaNode:
            return version == 1 && archiveId == nil && captureComplete == nil
                && derivedArtifacts.isEmpty && uplinkArtifacts.isEmpty
                && artifacts.allSatisfy { $0.mediaType == "audio/ogg" && $0.captureComplete == nil && $0.bytes <= 512 * 1024 * 1024 }
        case .pixel:
            return [2, 3].contains(version) && archiveId.flatMap(UUID.init(uuidString:)) != nil && archiveComplete
                && captureComplete == artifacts.allSatisfy { $0.captureComplete == true }
                && artifacts.allSatisfy { $0.mediaType == "audio/wav" && $0.bytes >= 44 && $0.captureComplete != nil }
                && (version == 2 ? derivedArtifacts.isEmpty : derivedArtifacts.count == 1 && derivedArtifacts.allSatisfy(\.isValid))
                && uplinkArtifacts.count <= 1 && uplinkArtifacts.allSatisfy(\.isValid)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case source, version, archiveId, callId, manifestSha256, finalizedAt, complete, archiveComplete, captureComplete
        case artifacts, tracks, derivedTracks, timeline, startedAt, endedAt, archiveVersion, uplinkTracks
    }
    private struct PixelTrack: Decodable {
        let track: RecordingTrack; let mediaType: String; let bytes: Int64; let sha256: String
        let sourceRole: String?
        let captureComplete: Bool; let gapCount: Int64; let droppedFrames: Int64
        let durationMs: Int64?
    }
    private struct Timeline: Decodable { let mediaType: String; let bytes: Int64; let sha256: String }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        callId = try c.decode(String.self, forKey: .callId)
        if version == 1 {
            let wireSource = try c.decodeIfPresent(String.self, forKey: .source)
            guard wireSource == nil || wireSource == RecordingSource.mediaNode.rawValue else {
                throw DecodingError.dataCorruptedError(forKey: .source, in: c, debugDescription: "v1 source mismatch")
            }
            source = .mediaNode; archiveId = nil; captureComplete = nil; derivedArtifacts = []; uplinkArtifacts = []
            finalizedAt = try c.decode(String.self, forKey: .finalizedAt)
            // An aborted media-node recording publishes `complete:false` (and older nodes omit the key). Both must
            // decode — `isEmptyCapture` then reports it as an empty recording instead of a manifest mismatch.
            archiveComplete = try c.decodeIfPresent(Bool.self, forKey: .complete) ?? false
            let legacy = try c.decode([RecordingArtifact].self, forKey: .artifacts)
            let expected = Set(["remote_original.ogg", "caller_original.ogg", "timeline.jsonl"])
            guard legacy.count == 3, Set(legacy.map(\.name)) == expected,
                  legacy.allSatisfy({ $0.isValid && $0.bytes <= 512 * 1024 * 1024 }) else {
                throw DecodingError.dataCorruptedError(forKey: .artifacts, in: c, debugDescription: "v1 artifacts mismatch")
            }
            artifacts = legacy.compactMap { item in
                RecordingTrack.allCases.first { item.name == "\($0.rawValue).ogg" }.map {
                    item.with(track: $0, mediaType: "audio/ogg")
                }
            }
        } else if version == 2 || version == 3 {
            guard try c.decode(String.self, forKey: .source) == RecordingSource.pixel.rawValue else {
                throw DecodingError.dataCorruptedError(forKey: .source, in: c, debugDescription: "v2 source mismatch")
            }
            source = .pixel
            archiveId = try c.decode(String.self, forKey: .archiveId)
            archiveComplete = try c.decode(Bool.self, forKey: .archiveComplete)
            captureComplete = try c.decode(Bool.self, forKey: .captureComplete)
            let startedAt = try c.decode(String.self, forKey: .startedAt)
            // R1 §5.1/§5.2: the gateway writes `appendInstant(3)`, so this string always carries three fractional
            // digits. Parsing it with a bare `ISO8601DateFormatter` failed every Pixel archive that ever shipped.
            guard GatewayTimeDisplay.parseISO(startedAt) != nil else {
                throw DecodingError.dataCorruptedError(forKey: .startedAt, in: c, debugDescription: "v2 start time mismatch")
            }
            finalizedAt = try c.decode(String.self, forKey: .endedAt)
            let tracks = try c.decode([PixelTrack].self, forKey: .tracks)
            if version == 3 {
                let manifestSHA = try c.decode(String.self, forKey: .manifestSha256)
                guard RecordingArtifact.validSHA(manifestSHA), tracks.allSatisfy({ $0.sourceRole == "original_capture" }) else {
                    throw DecodingError.dataCorruptedError(forKey: .manifestSha256, in: c, debugDescription: "v3 source roles or manifest fingerprint mismatch")
                }
            }
            artifacts = tracks.map { RecordingArtifact(
                name: "\($0.track.rawValue).wav", bytes: $0.bytes, sha256: $0.sha256,
                track: $0.track, mediaType: $0.mediaType, captureComplete: $0.captureComplete,
                gapCount: $0.gapCount, droppedFrames: $0.droppedFrames, durationMs: $0.durationMs
            ) }
            if version == 3 {
                derivedArtifacts = try c.decode([DerivedRecordingArtifact].self, forKey: .derivedTracks)
            } else {
                guard !c.contains(.derivedTracks) else {
                    throw DecodingError.dataCorruptedError(forKey: .derivedTracks, in: c, debugDescription: "v2 must not contain derived tracks")
                }
                derivedArtifacts = []
            }
            // S94: `archiveVersion: 4` and exactly one valid `uplinkTracks` entry appear together or not at all.
            let archiveVersion = try c.decodeIfPresent(Int.self, forKey: .archiveVersion)
            let uplinks = try c.decodeIfPresent([UplinkRecordingArtifact].self, forKey: .uplinkTracks)
            switch (archiveVersion, uplinks) {
            case (nil, nil): uplinkArtifacts = []
            case (4?, let uplinks?) where uplinks.count == 1 && uplinks.allSatisfy(\.isValid): uplinkArtifacts = uplinks
            default:
                throw DecodingError.dataCorruptedError(forKey: .uplinkTracks, in: c, debugDescription: "v4 uplink track mismatch")
            }
            let timeline = try c.decode(Timeline.self, forKey: .timeline)
            guard timeline.mediaType == "application/x-ndjson", timeline.bytes >= 0,
                  timeline.bytes <= 1024 * 1024 * 1024, RecordingArtifact.validSHA(timeline.sha256) else {
                throw DecodingError.dataCorruptedError(forKey: .timeline, in: c, debugDescription: "v2 timeline mismatch")
            }
        } else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: c, debugDescription: "unsupported recording version")
        }
    }
}

struct DerivedRecordingArtifact: Decodable, Sendable {
    let track: String
    let sourceRole: String
    let mediaType: String
    let bytes: Int64
    let sha256: String
    let playoutComplete: Bool
    let gapCount: Int64
    let recoveryFrames: Int64
    let durationMs: Int64?

    var isValid: Bool {
        track == "caller_playout" && sourceRole == "derived_playout" && mediaType == "audio/wav"
            && bytes >= 44 && bytes <= 512 * 1024 * 1024 && RecordingArtifact.validSHA(sha256)
            && gapCount >= 0 && recoveryFrames >= 0
    }

    var playbackArtifact: PlaybackArtifact {
        .init(path: track, mediaType: mediaType, bytes: bytes, sha256: sha256, durationMs: durationMs)
    }
}

struct UplinkRecordingArtifact: Decodable, Sendable {
    let track: String
    let sourceRole: String
    let mediaType: String
    let bytes: Int64
    let sha256: String
    let captureComplete: Bool
    let gapCount: Int64
    let droppedFrames: Int64
    let durationMs: Int64?

    var isValid: Bool {
        track == "caller_uplink" && sourceRole == "uplink_capture" && mediaType == "audio/wav"
            && bytes >= 44 && bytes <= 512 * 1024 * 1024 && RecordingArtifact.validSHA(sha256)
            && gapCount >= 0 && droppedFrames >= 0
    }

    var playbackArtifact: PlaybackArtifact {
        .init(path: track, mediaType: mediaType, bytes: bytes, sha256: sha256, durationMs: durationMs)
    }
}

struct PlaybackArtifact: Sendable, Equatable {
    let path: String
    let mediaType: String
    let bytes: Int64
    let sha256: String
    let durationMs: Int64?
}

struct RecordingArtifact: Codable, Sendable {
    let name: String
    let bytes: Int64
    let sha256: String
    let track: RecordingTrack
    let mediaType: String
    let captureComplete: Bool?
    let gapCount: Int64
    let droppedFrames: Int64
    let durationMs: Int64?

    init(name: String, bytes: Int64, sha256: String, track: RecordingTrack? = nil,
         mediaType: String? = nil, captureComplete: Bool? = nil, gapCount: Int64 = 0, droppedFrames: Int64 = 0,
         durationMs: Int64? = nil) {
        self.name = name; self.bytes = bytes; self.sha256 = sha256
        self.track = track ?? (name.hasPrefix("caller_original") ? .callerOriginal : .remoteOriginal)
        self.mediaType = mediaType ?? (name.hasSuffix(".wav") ? "audio/wav" : "audio/ogg")
        self.captureComplete = captureComplete; self.gapCount = gapCount; self.droppedFrames = droppedFrames
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey {
        case name, bytes, sha256, track, mediaType, captureComplete, gapCount, droppedFrames, durationMs
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = try c.decode(String.self, forKey: .name)
        self.init(
            name: name, bytes: try c.decode(Int64.self, forKey: .bytes), sha256: try c.decode(String.self, forKey: .sha256),
            track: try c.decodeIfPresent(RecordingTrack.self, forKey: .track),
            mediaType: try c.decodeIfPresent(String.self, forKey: .mediaType),
            captureComplete: try c.decodeIfPresent(Bool.self, forKey: .captureComplete),
            gapCount: try c.decodeIfPresent(Int64.self, forKey: .gapCount) ?? 0,
            droppedFrames: try c.decodeIfPresent(Int64.self, forKey: .droppedFrames) ?? 0,
            durationMs: try c.decodeIfPresent(Int64.self, forKey: .durationMs)
        )
    }

    var isValid: Bool {
        bytes >= 0 && bytes <= 1024 * 1024 * 1024 && Self.validSHA(sha256)
            && gapCount >= 0 && droppedFrames >= 0
    }
    var playbackArtifact: PlaybackArtifact {
        .init(path: track.rawValue, mediaType: mediaType, bytes: bytes, sha256: sha256, durationMs: durationMs)
    }
    fileprivate static func validSHA(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
    fileprivate func with(track: RecordingTrack, mediaType: String) -> Self {
        .init(name: name, bytes: bytes, sha256: sha256, track: track, mediaType: mediaType,
              captureComplete: captureComplete, gapCount: gapCount, droppedFrames: droppedFrames,
              durationMs: durationMs)
    }
}

enum RecordingTrack: String, CaseIterable, Codable, Sendable {
    case remoteOriginal = "remote_original"
    case callerOriginal = "caller_original"

    var title: String { self == .remoteOriginal ? "对方原声" : "我的原声" }
}

enum MediaTransport: String, Codable, Sendable {
    case udp, tls

    var label: String { self == .udp ? "UDP" : "TLS" }
}

struct MediaOptionsRequest: Codable, Sendable {
    let transport: MediaTransport
    let networkGeneration: String
}

struct MediaProbeOptionsRequest: Codable, Sendable { let networkGeneration: String }

struct MediaProbeNode: Codable, Sendable {
    let nodeId: String
    let probeUrl: String
    let expiresAt: String
    let grants: [String]
}

struct MediaProbeOptionsResponse: Codable, Sendable {
    let networkGeneration: String
    let expiresAt: String
    let nodes: [MediaProbeNode]
}

enum MediaProbeOutcome: String, Codable, Sendable { case ok, timeout, networkError = "network_error" }

struct MediaProbeSample: Codable, Sendable {
    let nodeId: String
    let outcome: MediaProbeOutcome
    let httpsRttMs: Double?
}

struct MediaProbeResultsRequest: Codable, Sendable {
    let networkGeneration: String
    let samples: [MediaProbeSample]
}

struct MediaProbeResultsResponse: Codable, Sendable {
    let accepted: Int
    let expiresAt: String
}

struct MediaIceServer: Codable, Sendable {
    let urls: [String]
    let username: String
    let credential: String
}

struct MediaOptionsResponse: Codable, Sendable {
    let iceServers: [MediaIceServer]
    let iceTransportPolicy: String
    /// Diagnostics only — the server returns the chosen media node so relay failures can be attributed to one node.
    let mediaNodeId: String?
    let mediaEpoch: Int?

    func validatedRelayURL(for transport: MediaTransport) throws -> MediaIceServer {
        guard iceTransportPolicy == "relay", iceServers.count == 1,
              let server = iceServers.first, server.urls.count == 1,
              let value = server.urls.first, !server.username.isEmpty, !server.credential.isEmpty else {
            throw MediaSessionError.invalidRelayOptions
        }
        let lowercased = value.lowercased()
        switch transport {
        case .udp:
            guard lowercased.hasPrefix("turn:"), lowercased.contains("transport=udp") else {
                throw MediaSessionError.invalidRelayOptions
            }
        case .tls:
            guard lowercased.hasPrefix("turns:"), lowercased.contains("transport=tcp") else {
                throw MediaSessionError.invalidRelayOptions
            }
        }
        return server
    }
}

struct MediaSessionDescription: Codable, Sendable {
    let type: String
    let sdp: String
}

/// The transport travels with the ICE failures so the message can name the path that failed — the production logs
/// showed "中继连接超时，可尝试 TLS" on a TLS attempt, which told the user to retry what had just failed.
enum MediaSessionError: LocalizedError, Equatable {
    case invalidRelayOptions
    case peerCreationFailed
    case missingLocalDescription
    case invalidAnswer
    case iceGatheringTimedOut(MediaTransport)
    case noRelayCandidate(MediaTransport)
    case iceConnectTimedOut(MediaTransport)
    case iceConnectionFailed(MediaTransport)
    case audioSessionConfigurationFailed
    case microphonePermissionDenied
    case callKitAudioTimedOut

    var errorDescription: String? {
        switch self {
        case .invalidRelayOptions: "服务器返回的中继配置无效"
        case .peerCreationFailed: "无法建立音频连接"
        case .missingLocalDescription: "无法生成本地音频协商信息"
        case .invalidAnswer: "服务器返回的音频协商信息无效"
        case let .iceGatheringTimedOut(transport): "未取得 \(transport.label) 中继候选，请检查网络或代理设置"
        case let .noRelayCandidate(transport): "未取得 \(transport.label) 中继候选，请检查网络或代理设置"
        case let .iceConnectTimedOut(transport): "\(transport.label) 中继已取得候选但未能连通，请重试音频"
        case let .iceConnectionFailed(transport): "\(transport.label) 音频中继连接失败"
        case .audioSessionConfigurationFailed: "无法配置通话音频"
        case .callKitAudioTimedOut: "系统通话音频未就绪，请重试"
        case .microphonePermissionDenied: "没有麦克风权限，通话无法传输声音。请在系统设置中允许 VoDog 使用麦克风。"
        }
    }
}

enum ReceptionMode: String, CaseIterable, Identifiable {
    case normal, ai, timeoutAI = "timeout_ai"
    var id: String { rawValue }
    var title: String {
        switch self { case .normal: "人工接听"; case .ai: "AI 即接"; case .timeoutAI: "超时转 AI" }
    }
}

// MARK: - S21 通讯录 / 拦截记录 / 网关总控 / AI 转写（合同见 docs/specs/S21-…md §A/§B/§D/§E）

/// One phone on a server-owned contact. `canonicalKey` is the server's match key; the client never derives it
/// (S21 decision 2: matching is Control's job).
struct ContactPhone: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let rawNumber: String
    let e164: String?
    let canonicalKey: String?
    let label: String?
    let isPrimary: Bool?
    /// S21 §A addendum: the server states the block entry per phone, because one contact can have a blocked
    /// number and a clean one. Optional — a Control that predates the addendum omits both.
    let blocked: Bool?
    let blockedEntryId: String?

    /// What a row prints: the dialable E.164 when the server could parse one, else exactly what was imported.
    var displayNumber: String {
        if let e164, !e164.isEmpty { return e164 }
        return rawNumber
    }

    init(id: String, rawNumber: String, e164: String? = nil, canonicalKey: String? = nil,
         label: String? = nil, isPrimary: Bool? = nil, blocked: Bool? = nil, blockedEntryId: String? = nil) {
        self.id = id; self.rawNumber = rawNumber; self.e164 = e164
        self.canonicalKey = canonicalKey; self.label = label; self.isPrimary = isPrimary
        self.blocked = blocked; self.blockedEntryId = blockedEntryId
    }
}

struct ContactEmail: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let address: String
    let label: String?

    init(id: String, address: String, label: String? = nil) {
        self.id = id; self.address = address; self.label = label
    }
}

struct ContactAddress: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let formatted: String?
    let label: String?
    let street: String?
    let city: String?
    let region: String?
    let postalCode: String?
    let country: String?

    init(id: String, formatted: String? = nil, label: String? = nil, street: String? = nil,
         city: String? = nil, region: String? = nil, postalCode: String? = nil, country: String? = nil) {
        self.id = id; self.formatted = formatted; self.label = label; self.street = street
        self.city = city; self.region = region; self.postalCode = postalCode; self.country = country
    }

    /// `formatted` when the server produced one, otherwise the parts it did send, so a partially filled
    /// address is still readable instead of blank.
    var displayText: String {
        if let formatted, !formatted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return formatted }
        let parts = [country, region, city, street, postalCode]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? "地址未填写" : parts.joined(separator: " ")
    }
}

/// `ContactDto` (§A). The three child arrays decode with `[]` defaults so a partial object can never fail the
/// whole `/contacts` page.
struct Contact: Codable, Identifiable, Sendable, Equatable {
    let id: String
    /// Optimistic-concurrency version. Pre-S32 responses decode as version 1.
    let version: Int
    let displayName: String
    let givenName: String?
    let familyName: String?
    let organization: String?
    let notes: String?
    let source: String?
    let sourceDeviceId: String?
    let sourceContactId: String?
    let phones: [ContactPhone]
    let emails: [ContactEmail]
    let addresses: [ContactAddress]
    let blocked: Bool?
    /// S21 §A addendum: the contact-level blocklist entry, when the server states one.
    let blockedEntryId: String?
    let createdAt: String?
    let updatedAt: String?

    var isBlocked: Bool { blocked == true }

    /// The number a list row and the card header show: the primary phone when one is flagged, else the first.
    var primaryPhone: ContactPhone? {
        phones.first { $0.isPrimary == true } ?? phones.first
    }

    init(
        id: String, displayName: String, version: Int = 1, givenName: String? = nil, familyName: String? = nil,
        organization: String? = nil, notes: String? = nil, source: String? = nil,
        sourceDeviceId: String? = nil, sourceContactId: String? = nil,
        phones: [ContactPhone] = [], emails: [ContactEmail] = [], addresses: [ContactAddress] = [],
        blocked: Bool? = nil, blockedEntryId: String? = nil,
        createdAt: String? = nil, updatedAt: String? = nil
    ) {
        self.id = id; self.version = version; self.displayName = displayName; self.givenName = givenName
        self.familyName = familyName; self.organization = organization; self.notes = notes
        self.source = source; self.sourceDeviceId = sourceDeviceId; self.sourceContactId = sourceContactId
        self.phones = phones; self.emails = emails; self.addresses = addresses
        self.blocked = blocked; self.blockedEntryId = blockedEntryId
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        givenName = try c.decodeIfPresent(String.self, forKey: .givenName)
        familyName = try c.decodeIfPresent(String.self, forKey: .familyName)
        organization = try c.decodeIfPresent(String.self, forKey: .organization)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        sourceDeviceId = try c.decodeIfPresent(String.self, forKey: .sourceDeviceId)
        sourceContactId = try c.decodeIfPresent(String.self, forKey: .sourceContactId)
        phones = try c.decodeIfPresent([ContactPhone].self, forKey: .phones) ?? []
        emails = try c.decodeIfPresent([ContactEmail].self, forKey: .emails) ?? []
        addresses = try c.decodeIfPresent([ContactAddress].self, forKey: .addresses) ?? []
        blocked = try c.decodeIfPresent(Bool.self, forKey: .blocked)
        blockedEntryId = try c.decodeIfPresent(String.self, forKey: .blockedEntryId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

struct ContactEnvelope: Codable, Sendable { let item: Contact }
/// `GET /contacts/lookup?number=` answers `{item: ContactDto|null}`.
struct ContactLookupEnvelope: Codable, Sendable { let item: Contact? }

// MARK: 写入体

struct ContactPhoneBody: Codable, Sendable, Equatable {
    let rawNumber: String
    let label: String?

    enum CodingKeys: String, CodingKey { case rawNumber, label }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(rawNumber, forKey: .rawNumber)
        try c.encodeIfPresent(label, forKey: .label)
    }
}

struct ContactEmailBody: Codable, Sendable, Equatable {
    let address: String
    let label: String?

    enum CodingKeys: String, CodingKey { case address, label }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(address, forKey: .address)
        try c.encodeIfPresent(label, forKey: .label)
    }
}

struct ContactAddressBody: Codable, Sendable, Equatable {
    let formatted: String?
    let label: String?
    let street: String?
    let city: String?
    let region: String?
    let postalCode: String?
    let country: String?

    enum CodingKeys: String, CodingKey { case formatted, label, street, city, region, postalCode, country }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(formatted, forKey: .formatted)
        try c.encodeIfPresent(label, forKey: .label)
        try c.encodeIfPresent(street, forKey: .street)
        try c.encodeIfPresent(city, forKey: .city)
        try c.encodeIfPresent(region, forKey: .region)
        try c.encodeIfPresent(postalCode, forKey: .postalCode)
        try c.encodeIfPresent(country, forKey: .country)
    }
}

/// Body of `POST /contacts` and `PUT /contacts/:id`, and — with `sourceContactId` — one element of the
/// import payload. Optional keys are omitted rather than sent as `null`: the server's zod schemas mark them
/// `.optional()`, so a literal null would be rejected.
struct ContactUpsertBody: Codable, Sendable, Equatable {
    let sourceContactId: String?
    let expectedVersion: Int?
    let displayName: String
    let givenName: String?
    let familyName: String?
    let organization: String?
    let notes: String?
    let phones: [ContactPhoneBody]
    let emails: [ContactEmailBody]
    let addresses: [ContactAddressBody]

    init(
        sourceContactId: String? = nil, expectedVersion: Int? = nil, displayName: String, givenName: String? = nil,
        familyName: String? = nil, organization: String? = nil, notes: String? = nil,
        phones: [ContactPhoneBody] = [], emails: [ContactEmailBody] = [], addresses: [ContactAddressBody] = []
    ) {
        self.sourceContactId = sourceContactId; self.expectedVersion = expectedVersion; self.displayName = displayName
        self.givenName = givenName; self.familyName = familyName
        self.organization = organization; self.notes = notes
        self.phones = phones; self.emails = emails; self.addresses = addresses
    }

    enum CodingKeys: String, CodingKey {
        case sourceContactId, expectedVersion, displayName, givenName, familyName, organization, notes, phones, emails, addresses
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(sourceContactId, forKey: .sourceContactId)
        try c.encodeIfPresent(expectedVersion, forKey: .expectedVersion)
        try c.encode(displayName, forKey: .displayName)
        try c.encodeIfPresent(givenName, forKey: .givenName)
        try c.encodeIfPresent(familyName, forKey: .familyName)
        try c.encodeIfPresent(organization, forKey: .organization)
        try c.encodeIfPresent(notes, forKey: .notes)
        try c.encode(phones, forKey: .phones)
        if !emails.isEmpty { try c.encode(emails, forKey: .emails) }
        if !addresses.isEmpty { try c.encode(addresses, forKey: .addresses) }
    }
}

struct ContactImportRequest: Codable, Sendable, Equatable {
    let source: String
    let sourceDeviceId: String?
    let contacts: [ContactUpsertBody]

    enum CodingKeys: String, CodingKey { case source, sourceDeviceId, contacts }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(source, forKey: .source)
        try c.encodeIfPresent(sourceDeviceId, forKey: .sourceDeviceId)
        try c.encode(contacts, forKey: .contacts)
    }
}

/// `{total, created, updated, merged, skipped, phonesSkipped}`. Every counter defaults to 0 so a server that
/// omits one cannot fail the whole import response after the write already happened.
struct ContactImportResult: Codable, Sendable, Equatable {
    let total: Int
    let created: Int
    let updated: Int
    let merged: Int
    let skipped: Int
    let phonesSkipped: Int

    init(total: Int = 0, created: Int = 0, updated: Int = 0, merged: Int = 0, skipped: Int = 0, phonesSkipped: Int = 0) {
        self.total = total; self.created = created; self.updated = updated
        self.merged = merged; self.skipped = skipped; self.phonesSkipped = phonesSkipped
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        created = try c.decodeIfPresent(Int.self, forKey: .created) ?? 0
        updated = try c.decodeIfPresent(Int.self, forKey: .updated) ?? 0
        merged = try c.decodeIfPresent(Int.self, forKey: .merged) ?? 0
        skipped = try c.decodeIfPresent(Int.self, forKey: .skipped) ?? 0
        phonesSkipped = try c.decodeIfPresent(Int.self, forKey: .phonesSkipped) ?? 0
    }

    /// Import runs in batches of ≤ 2000, so the per-batch counters are summed for one summary line.
    static func + (lhs: Self, rhs: Self) -> Self {
        Self(
            total: lhs.total + rhs.total, created: lhs.created + rhs.created,
            updated: lhs.updated + rhs.updated, merged: lhs.merged + rhs.merged,
            skipped: lhs.skipped + rhs.skipped, phonesSkipped: lhs.phonesSkipped + rhs.phonesSkipped
        )
    }
}

// MARK: 拦截记录（§B）

struct Interception: Codable, Identifiable, Sendable, Equatable {
    let id: String
    /// `call` | `sms`.
    let kind: String
    let simId: String?
    /// Server-resolved row context. Optional keeps compatibility with Controls older than S33.
    let simLabel: String?
    let gatewayTimeZone: String?
    let remoteNumber: String?
    let contactId: String?
    let contactName: String?
    let occurredAt: String?
    let bodyPreview: String?
    let blockedEntryId: String?
    /// `gateway` | `control` | `phone`（S38：拦截猫在手机上直接拦下的来电）。
    let source: String?

    var isSMS: Bool { kind == "sms" }

    /// S38：拦截来源文字。未知枚举值印不出来，也不泄漏原始代码。通话行的拦截标记共用这一份文案。
    static func sourceTitle(_ source: String?) -> String? {
        switch source {
        case "phone": "手机自动拦截"
        case "gateway": "网关拦截"
        case "control": "服务器拦截"
        default: nil
        }
    }
    var sourceTitle: String? { Self.sourceTitle(source) }
    var kindTitle: String { isSMS ? "短信" : "来电" }
    var kindSymbol: String { isSMS ? "message.badge.filled.fill" : "phone.down.fill" }
}

// MARK: 网关总控（§D）

struct GatewayPowerResult: Codable, Sendable, Equatable {
    let desired: String?
    let ok: Bool
    let reason: String?
    let at: String?

    init(desired: String? = nil, ok: Bool = true, reason: String? = nil, at: String? = nil) {
        self.desired = desired; self.ok = ok; self.reason = reason; self.at = at
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        desired = try c.decodeIfPresent(String.self, forKey: .desired)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        at = try c.decodeIfPresent(String.self, forKey: .at)
    }
}

/// `GatewayPowerDto`. Every boolean defaults to the conservative value so a partial object reads as
/// "离线 / 未允许" rather than inviting a remote power action that cannot succeed.
struct GatewayPower: Codable, Identifiable, Sendable, Equatable {
    var id: String { gatewayId }
    let gatewayId: String
    let name: String?
    let controlEnabled: Bool
    let online: Bool
    let lastSeenAt: String?
    let standbyOnline: Bool
    let standbySeenAt: String?
    let remotePowerAllowed: Bool
    let desiredPower: String?
    let desiredPowerRequestedAt: String?
    let lastPowerResult: GatewayPowerResult?
    let occupied: Bool
    /// S58：`pixel` | `dji4g`，缺失按 Pixel。
    let kind: String?

    init(
        gatewayId: String, name: String? = nil, controlEnabled: Bool = false, online: Bool = false,
        lastSeenAt: String? = nil, standbyOnline: Bool = false, standbySeenAt: String? = nil,
        remotePowerAllowed: Bool = false, desiredPower: String? = nil, desiredPowerRequestedAt: String? = nil,
        lastPowerResult: GatewayPowerResult? = nil, occupied: Bool = false, kind: String? = nil
    ) {
        self.kind = kind
        self.gatewayId = gatewayId; self.name = name; self.controlEnabled = controlEnabled
        self.online = online; self.lastSeenAt = lastSeenAt; self.standbyOnline = standbyOnline
        self.standbySeenAt = standbySeenAt; self.remotePowerAllowed = remotePowerAllowed
        self.desiredPower = desiredPower; self.desiredPowerRequestedAt = desiredPowerRequestedAt
        self.lastPowerResult = lastPowerResult; self.occupied = occupied
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        gatewayId = try c.decode(String.self, forKey: .gatewayId)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        controlEnabled = try c.decodeIfPresent(Bool.self, forKey: .controlEnabled) ?? false
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
        standbyOnline = try c.decodeIfPresent(Bool.self, forKey: .standbyOnline) ?? false
        standbySeenAt = try c.decodeIfPresent(String.self, forKey: .standbySeenAt)
        remotePowerAllowed = try c.decodeIfPresent(Bool.self, forKey: .remotePowerAllowed) ?? false
        desiredPower = try c.decodeIfPresent(String.self, forKey: .desiredPower)
        desiredPowerRequestedAt = try c.decodeIfPresent(String.self, forKey: .desiredPowerRequestedAt)
        lastPowerResult = try c.decodeIfPresent(GatewayPowerResult.self, forKey: .lastPowerResult)
        occupied = try c.decodeIfPresent(Bool.self, forKey: .occupied) ?? false
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
    }
}

struct GatewayPowerEnvelope: Codable, Sendable { let item: GatewayPower }
struct GatewayPowerBody: Codable, Sendable, Equatable { let desired: String }

// MARK: AI 实时转写（§E）

/// One line of `GET /calls/:id/ai-transcript`. Not `Identifiable`: two identical lines are legal, so the views
/// iterate by offset instead of inventing a key.
struct AiTranscriptSegment: Codable, Sendable, Equatable {
    /// `ai` | `caller`.
    let role: String
    let text: String
    let at: String?

    var isAI: Bool { role == "ai" }
    var roleTitle: String { isAI ? "AI 助理" : "对方" }
}

// MARK: AI 语音服务供应商（S24 决策 3）

/// One entry of `GET /api/v1/ai/voice-providers`.
///
/// Both booleans default to `false` when absent, the same conservative direction `GatewayPower` uses: a
/// partial object reads as "未配置" and stays unselectable rather than inviting a switch the server refuses.
struct VoiceProvider: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let label: String?
    let configured: Bool
    let online: Bool

    init(id: String, label: String? = nil, configured: Bool = false, online: Bool = false) {
        self.id = id; self.label = label; self.configured = configured; self.online = online
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        configured = try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
    }
}

/// The shared body of `GET /ai/voice-providers` and `PUT /ai/voice-provider`: the same shape, so a successful
/// switch refreshes the whole section from one response.
struct VoiceProviderList: Codable, Sendable, Equatable {
    let items: [VoiceProvider]
    let selected: String?
    let configVersion: Int

    init(items: [VoiceProvider] = [], selected: String? = nil, configVersion: Int = 1) {
        self.items = items; self.selected = selected; self.configVersion = configVersion
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([VoiceProvider].self, forKey: .items) ?? []
        selected = try c.decodeIfPresent(String.self, forKey: .selected)
        configVersion = try c.decodeIfPresent(Int.self, forKey: .configVersion) ?? 1
    }
}

struct VoiceProviderBody: Codable, Sendable, Equatable {
    let provider: String
    let expectedVersion: Int
}
