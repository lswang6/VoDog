import Foundation

/// S30. Deleting is the one action in this app that cannot be undone, so every rule it needs — may this row be
/// deleted at all, what the confirmation says, what the list and the pager look like afterwards — is a pure
/// function here rather than something each of the three clients re-derives in its own view code.
///
/// Control owns the real predicate (`state IN ('ended','failed')` plus half a dozen "still in use" tables, S30
/// §1.1) and answers 409 when it disagrees. This policy is only the cheap half: it greys out the button for a
/// call the client can already see is live, and it names the message shown when the server says 409 anyway.
enum RecordDeletePolicy {
    static let actionTitle = "删除"
    static let actionSymbol = "trash"
    static let accessibilityIdentifier = "records.delete"

    static let confirmTitle = "删除这条通话记录？"
    /// S39: the Pixel's own dialer log goes too, so the confirmation says so before the tap that cannot be undone.
    static let confirmMessage = "录音、转写、报告条目和网关设备上的通话记录会一起删除，无法恢复。"
    static let confirmButton = "删除"
    static let cancelButton = "取消"

    /// The 409 `CALL_IN_USE` answer, in the user's words rather than the server's code.
    static let inUseMessage = "通话仍在进行或处理中，稍后再删"
    static let inUseStatus = 409

    /// Control's own delete predicate on `call_records.state`.
    static let deletableStates: Set<String> = ["ended", "failed"]

    /// Every non-terminal state `callStateTitle` knows. A call in one of these is provably still running, so the
    /// row greys the button out instead of spending a round trip to be told 409.
    static let liveStates: Set<String> = [
        "incoming_ringing", "outgoing_pending", "connecting", "active", "ending",
    ]

    /// A state this client has never heard of — an older or a newer Control — is judged by `ended_at` alone:
    /// a call that has an end time is over, and one that does not is assumed live and stays undeletable.
    static func canDelete(state: String?, endedAt: String?) -> Bool {
        let normalized = (state ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if deletableStates.contains(normalized) { return true }
        if liveStates.contains(normalized) { return false }
        guard let endedAt = endedAt?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return !endedAt.isEmpty
    }

    static func canDelete(_ call: CallRecord) -> Bool {
        canDelete(state: call.state, endedAt: call.endedAt)
    }

    /// What the 全部通话 error line says. 409 is the only status with its own wording; everything else keeps the
    /// transport's own message rather than inventing one.
    static func errorMessage(_ error: Error) -> String {
        if case let APIError.server(status, _, _) = error, status == inUseStatus { return inUseMessage }
        return error.localizedDescription
    }

    // MARK: - The list and the pager after one row is gone

    static func callsAfterDelete(_ calls: [CallRecord], id: String) -> [CallRecord] {
        calls.filter { $0.id != id }
    }

    static func reportItemsAfterDelete(_ items: [CallReportItem], callID: String) -> [CallReportItem] {
        items.filter { $0.callId != callID }
    }

    /// One row fewer. A Control that does not page answers no `total` at all, and nil must stay nil rather than
    /// become 0 — that is what `RecordsPagingPolicy.showsPager` reads to decide the bar is unsupported.
    static func totalAfterDelete(_ total: Int?) -> Int? {
        guard let total else { return nil }
        return max(0, total - 1)
    }

    /// The page count recomputed from the new total, so deleting the only row on the last page removes the page
    /// instead of leaving the bar pointing at one that no longer exists. Never below page 1: an empty list still
    /// has a first page.
    static func totalPagesAfterDelete(total: Int?, totalPages: Int?, pageSize: Int) -> Int? {
        guard totalPages != nil else { return nil }
        guard let total else { return totalPages }
        let size = max(1, RecordsPagingPolicy.normalizedPageSize(pageSize))
        let pages = (total + size - 1) / size
        return max(RecordsPagingPolicy.firstPage, pages)
    }

    /// Where the list lands. Deleting the last row of page 4 of 4 rewinds to page 3 rather than showing an empty
    /// page 4; anything else stays where it was.
    static func pageAfterDelete(page: Int, totalPages: Int?) -> Int {
        RecordsPagingPolicy.clampPage(page, totalPages: totalPages)
    }
}

/// S30. 对话内容页的多选删除。Long-press picks the first message and turns the thread into a selection list; from
/// there a tap toggles. The set, the title and the "may I send this batch" test are pure so iOS, Android and Web
/// agree on what "已选 N 条" counts and on the 500-id ceiling `POST /sms/delete` enforces (S30 §1.2).
enum MessageSelectionPolicy {
    static let enterTitle = "选择"
    static let selectAllTitle = "全选"
    static let cancelTitle = "取消"
    static let deleteSelectedTitle = "删除所选"
    static let confirmTitle = "删除选中的短信？"
    static let confirmMessage = "选中的短信会被彻底删除，无法恢复。"
    static let confirmButton = "删除"

    static let selectModeAccessibilityIdentifier = "conversation.selectMode"
    static let selectAllAccessibilityIdentifier = "conversation.selectAll"
    static let cancelAccessibilityIdentifier = "conversation.cancelSelect"
    static let deleteSelectedAccessibilityIdentifier = "conversation.deleteSelected"

    static let selectedSymbol = "checkmark.circle.fill"
    static let unselectedSymbol = "circle"

    /// `POST /sms/delete` takes 1–500 ids. A 全选 over a longer thread is allowed to select them all — the count
    /// is the truth of what is selected — but the delete button then states the ceiling instead of failing at
    /// the server.
    static let maximumBatch = 500
    static let overLimitMessage = "一次最多删除 500 条，请分批选择。"

    static func title(count: Int) -> String { "已选 \(count) 条" }

    static func toggle(_ id: String, in selection: Set<String>) -> Set<String> {
        var result = selection
        if result.contains(id) { result.remove(id) } else { result.insert(id) }
        return result
    }

    static func selectAll(_ ids: [String]) -> Set<String> { Set(ids) }

    static func clear() -> Set<String> { [] }

    static func canDelete(_ selection: Set<String>) -> Bool {
        !selection.isEmpty && selection.count <= maximumBatch
    }

    static func isOverLimit(_ selection: Set<String>) -> Bool { selection.count > maximumBatch }

    /// The request body in the thread's own order, not `Set`'s. A stable body is what makes the contract test
    /// meaningful and keeps two identical taps producing one identical request.
    static func orderedIDs(_ selection: Set<String>, in messages: [SMSMessage]) -> [String] {
        messages.map(\.id).filter(selection.contains)
    }

    static func remaining(_ messages: [SMSMessage], deleting ids: Set<String>) -> [SMSMessage] {
        messages.filter { !ids.contains($0.id) }
    }

    /// Only what the server actually deleted disappears. A message it skipped as `in_flight` is still there, and
    /// hiding it would tell the user a lie the next reload would contradict.
    static func acceptedIDs(requested: [String], skipped: [SMSDeleteSkip]) -> [String] {
        let refused = Set(skipped.map(\.id))
        return requested.filter { !refused.contains($0) }
    }

    static func skippedMessage(_ skipped: [SMSDeleteSkip]) -> String? {
        guard !skipped.isEmpty else { return nil }
        return "\(skipped.count) 条正在发送中，暂时无法删除。"
    }
}

/// S30. 短信列表左滑出的两个动作。`删除` is declared first because a trailing `swipeActions` lays its buttons out
/// from the edge inward in declaration order — first declared is the outermost one, and the one a full swipe
/// would trigger. `删除并屏蔽` therefore sits inside it, which is also the safer of the two placements: the
/// harder-to-reach button is the one that also blocks the line.
enum ThreadSwipeActionPolicy {
    enum Action: String, CaseIterable, Sendable {
        case delete
        case deleteAndBlock
    }

    static let deleteTitle = "删除"
    static let deleteAndBlockTitle = "删除并屏蔽"
    static let blockSucceededDeleteFailedMessage = "号码已屏蔽，但对话删除失败，请重试"
    static let cancelTitle = "取消"
    static let confirmButton = "删除"

    static let deleteConfirmTitle = "删除这段对话？"
    static let deleteConfirmMessage = "这段对话里的短信会被彻底删除，无法恢复。"
    static let deleteAndBlockConfirmTitle = "删除并屏蔽此号码？"
    static let deleteAndBlockConfirmMessage = "这段对话会被彻底删除，之后不再接收这个号码的短信（来电不受影响）。"

    /// `POST /blocklist` answers 400 for an emergency or non-dialable number. The thread is then left alone —
    /// half of "删除并屏蔽" is not the action the user asked for.
    static let blockRejectedMessage = "这个号码不能屏蔽，对话没有删除。"

    /// 屏蔽 is the same judgement the 全部通话 row makes, so emergency numbers are excluded in exactly one place.
    static func canBlock(remoteNumber: String?) -> Bool {
        HistoryRowActionPolicy.canBlock(remoteNumber: remoteNumber)
    }

    /// Edge first. A thread whose number cannot be blocked offers 删除 alone rather than a button that would be
    /// refused with 400.
    static func actions(remoteNumber: String?) -> [Action] {
        canBlock(remoteNumber: remoteNumber) ? [.delete, .deleteAndBlock] : [.delete]
    }

    static func title(_ action: Action) -> String {
        switch action {
        case .delete: deleteTitle
        case .deleteAndBlock: deleteAndBlockTitle
        }
    }

    static func confirmTitle(_ action: Action) -> String {
        switch action {
        case .delete: deleteConfirmTitle
        case .deleteAndBlock: deleteAndBlockConfirmTitle
        }
    }

    static func confirmMessage(_ action: Action) -> String {
        switch action {
        case .delete: deleteConfirmMessage
        case .deleteAndBlock: deleteAndBlockConfirmMessage
        }
    }

    static func accessibilityIdentifier(_ action: Action) -> String {
        switch action {
        case .delete: "threads.delete"
        case .deleteAndBlock: "threads.deleteAndBlock"
        }
    }

    static func symbol(_ action: Action) -> String {
        switch action {
        case .delete: "trash"
        case .deleteAndBlock: "hand.raised.slash"
        }
    }

    /// A 400 from `POST /blocklist` is the one failure with its own wording; everything else keeps the
    /// transport's message.
    static func blockErrorMessage(_ error: Error) -> String {
        if case let APIError.server(status, _, _) = error, status == 400 { return blockRejectedMessage }
        return error.localizedDescription
    }
}

/// Applies a partial thread-delete result before any follow-up refresh.
enum ThreadDeleteResultPolicy {
    static func acceptedIDs(requested: Set<String>, response: SMSDeleteResponse) -> Set<String> {
        Set(MessageSelectionPolicy.acceptedIDs(requested: Array(requested), skipped: response.skipped))
    }

    static func feedback(_ response: SMSDeleteResponse) -> String? {
        MessageSelectionPolicy.skippedMessage(response.skipped)
    }
}

enum ContactConcurrencyPolicy {
    static func isConflict(_ error: Error) -> Bool {
        guard case let APIError.server(status, _, code) = error else { return false }
        return (status == 409 && code == "CONTACT_VERSION_CONFLICT")
            || (status == 428 && code == "CONTACT_VERSION_REQUIRED")
    }

    static let editConflictMessage = "联系人已在其他客户端更新。当前草稿已保留；只有明确载入最新内容后，才能核对并再次保存。"
    static let deleteConflictMessage = "联系人已在其他客户端更新，未执行删除。请刷新后核对最新版本。"

    static func deleteQuery(expectedVersion: Int) -> [URLQueryItem] {
        [URLQueryItem(name: "expectedVersion", value: String(expectedVersion))]
    }
}

/// The alert's presentation state is deliberately separate: dismissing the alert must not unlock a stale draft.
struct ContactDraftConflictGate: Equatable, Sendable {
    private(set) var isLocked = false

    mutating func recordConflict() { isLocked = true }
    mutating func acceptFreshVersion() { isLocked = false }
}

enum SIMDraftConcurrencyPolicy {
    static func isConflict(_ error: Error) -> Bool {
        guard case let APIError.server(status, _, code) = error else { return false }
        return (status == 409 && code == "VERSION_CONFLICT")
            || (status == 428 && code == "VERSION_REQUIRED")
    }

    static func hasExternalChange(currentVersion: Int?, baseVersion: Int?, draftIsDirty: Bool) -> Bool {
        draftIsDirty && currentVersion != nil && baseVersion != nil && currentVersion != baseVersion
    }

    static let settingsConflictMessage = "接听设置已在其他客户端更新，当前草稿已保留。请载入并确认最新设置后再保存。"
    static let notesConflictMessage = "号码备注已在其他客户端更新，当前草稿已保留。请载入并确认最新备注后再保存。"
}

enum ProviderConcurrencyPolicy {
    static func isConflict(_ error: Error) -> Bool {
        guard case let APIError.server(status, _, code) = error else { return false }
        return (status == 409 && code == "PROVIDER_VERSION_CONFLICT")
            || (status == 428 && code == "PROVIDER_VERSION_REQUIRED")
    }

    static let conflictMessage = "AI 语音服务已在其他客户端更新。服务器当前选择会继续刷新；请先载入并确认最新配置，再重新选择。"

    static func attemptedChoiceMessage(_ conflict: ProviderConflictState) -> String {
        "你刚才尝试选择：\(conflict.attemptedProviderLabel)"
    }
}

/// A provider CAS conflict is an operation result, not a polling error. Keep the attempted choice latched while
/// background refreshes continue to show server truth; only an explicit successful reload clears it.
struct ProviderConflictState: Equatable, Sendable {
    let attemptedProviderID: String
    let attemptedProviderLabel: String
}

enum ForegroundRefreshPolicy {
    static let interval: Duration = .seconds(5)
}

/// S39 §E. A 录音 / 转写 / AI 对话 sheet opened straight from a report card outlives the call it belongs to: the
/// detail page's own by-id check never ran, so another client's delete left the sheet sitting on content that no
/// longer exists. These are the two halves the sheets share — what closes them, and what the user is then told.
///
/// Only `GET calls/<id>` answering 404 proves the call is gone. The sheets' own routes
/// (`ai-transcript` / `transcript` / `recordings`) answer 404 for legitimately empty content, so their 404s are
/// not an existence signal and must never reach this function.
enum CallExistencePolicy {
    static let deletedTitle = "通话记录已被删除"
    static let deletedMessage = "这条通话记录已在其他客户端删除，相关报告和详情已关闭。"
    static let deletedAcknowledgeButton = "好"

    static func shouldClose(_ error: Error) -> Bool {
        if case APIError.server(404, _, _) = error { return true }
        return false
    }
}

/// S39 §F. An exported MP3 is a copy made for one share sheet. It lands in its own `exports/` directory so the
/// sweep can never touch a playback temp file, is deleted when the share sheet reports back, and — for the
/// dismissal that reports nothing, a swipe-down — is swept an hour later the next time 记录 appears.
enum ExportCleanupPolicy {
    static let directoryName = "exports"
    static let maximumAge: TimeInterval = 3600

    static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(directoryName, isDirectory: true)
    }

    /// Strictly older than an hour. A file exactly at the boundary is kept — the share sheet it belongs to may
    /// still be on screen, and one more sweep costs nothing.
    static func expired(_ files: [(url: URL, modifiedAt: Date)], now: Date) -> [URL] {
        files.filter { now.timeIntervalSince($0.modifiedAt) > maximumAge }.map(\.url)
    }

    static func prune(now: Date = Date()) {
        let manager = FileManager.default
        guard let entries = try? manager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]
        ) else { return }
        let dated = entries.compactMap { url -> (url: URL, modifiedAt: Date)? in
            guard let modified = try? url.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate else { return nil }
            return (url, modified)
        }
        for url in expired(dated, now: now) { try? manager.removeItem(at: url) }
    }
}

extension MessageConversation {
    /// What `POST /sms/threads/delete` is keyed by: the thread's `conversationAddress ?? remoteNumber` exactly as
    /// the server sent it (S30 §1.3 normalises both sides, so `2025550103` and `+12025550103` still meet).
    /// `displayNumber` is already that value, with the grouping key as the last-resort fallback.
    var threadAddress: String { displayNumber }

    /// The raw line to block — `sms_messages.remote_number`, never the normalised grouping key, because Control
    /// matches a blocklist entry against the number it stored.
    var blockNumber: String? {
        for message in messages.reversed() {
            if let number = message.remoteNumber?.trimmingCharacters(in: .whitespacesAndNewlines), !number.isEmpty {
                return number
            }
        }
        let fallback = displayNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback.isEmpty ? nil : fallback
    }
}

// MARK: - Wire shapes

struct SMSDeleteBody: Codable, Sendable, Equatable {
    let ids: [String]
}

struct SMSThreadDeleteBody: Codable, Sendable, Equatable {
    let simId: String
    let conversationAddress: String
}

/// `{deleted, skipped:[{id, reason}]}`. Every field decodes defensively so a server that answers a bare `{}` —
/// or adds a field — cannot fail a delete the user already watched succeed.
struct SMSDeleteResponse: Decodable, Sendable, Equatable {
    let deleted: Int
    let skipped: [SMSDeleteSkip]

    init(deleted: Int = 0, skipped: [SMSDeleteSkip] = []) {
        self.deleted = deleted
        self.skipped = skipped
    }

    enum CodingKeys: String, CodingKey { case deleted, skipped }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        deleted = try container.decodeIfPresent(Int.self, forKey: .deleted) ?? 0
        skipped = try container.decodeIfPresent([SMSDeleteSkip].self, forKey: .skipped) ?? []
    }
}

struct SMSDeleteSkip: Decodable, Sendable, Equatable {
    let id: String
    let reason: String

    init(id: String, reason: String) {
        self.id = id
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey { case id, reason }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        reason = try container.decodeIfPresent(String.self, forKey: .reason) ?? ""
    }
}
