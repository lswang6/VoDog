import Foundation

struct MessageConversationID: Hashable, Identifiable, Sendable {
    let simID: String
    let remoteNumber: String

    var id: String { "\(simID)\u{001f}\(remoteNumber)" }

    init?(message: SMSMessage) {
        guard let simID = message.simId, !simID.isEmpty,
              let rawNumber = message.conversationAddress ?? message.remoteNumber else { return nil }
        let normalized = ConversationAddress.key(rawNumber)
        guard !normalized.isEmpty else { return nil }
        self.simID = simID
        remoteNumber = normalized
    }

    init?(simID: String?, remoteNumber: String) {
        guard let simID, !simID.isEmpty else { return nil }
        let normalized = ConversationAddress.key(remoteNumber)
        guard !normalized.isEmpty else { return nil }
        self.simID = simID
        self.remoteNumber = normalized
    }
}

/// S21 decision 3: the server decides the contact match and the block state per message. A thread adopts the
/// newest value the server stated, so an older page that predates S21 can neither blank out a known name nor
/// keep a number looking blocked after it was released.
struct ConversationContactSummary: Equatable, Sendable {
    var contactId: String?
    var contactName: String?
    var blocked = false
    var blockedEntryId: String?

    /// `messages` is the thread in ascending time order, exactly as `MessageConversation` stores it.
    static func from(_ messages: [SMSMessage]) -> Self {
        var summary = Self()
        var decidedBlocked = false
        for message in messages.reversed() {
            if summary.contactId == nil { summary.contactId = message.contactId }
            if summary.contactName == nil,
               let name = message.contactName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                summary.contactName = name
            }
            if summary.blockedEntryId == nil { summary.blockedEntryId = message.blockedEntryId }
            if !decidedBlocked, let blocked = message.blocked {
                summary.blocked = blocked
                decidedBlocked = true
            }
        }
        return summary
    }
}

struct MessageConversation: Identifiable, Sendable {
    let id: MessageConversationID
    let displayNumber: String
    let replyNumber: String?
    let canReply: Bool
    let messages: [SMSMessage]
    var contact = ConversationContactSummary()

    var latest: SMSMessage? { messages.last }
    var contactId: String? { contact.contactId }
    var contactName: String? { contact.contactName }
    var blocked: Bool { contact.blocked }
    var blockedEntryId: String? { contact.blockedEntryId }
    /// §F: `186…1768 · 张三` for the thread row and the thread title.
    var displayTitle: String {
        ContactDisplay.numberWithName(number: displayNumber, contactName: contactName)
    }

    static func grouped(_ messages: [SMSMessage], selectedSIMID: String?) -> [Self] {
        guard let selectedSIMID else { return [] }
        let eligible = messages.compactMap { message -> (MessageConversationID, SMSMessage)? in
            guard let id = MessageConversationID(message: message), id.simID == selectedSIMID else { return nil }
            return (id, message)
        }
        return Dictionary(grouping: eligible, by: { $0.0 })
            .map { id, values in
                let sorted = values.map(\.1).sorted { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
                let latest = sorted.last
                let display = [latest?.conversationAddress, latest?.remoteNumber]
                    .compactMap { $0 }.first(where: { !$0.isEmpty }) ?? id.remoteNumber
                let explicitlyReplyable = latest?.canReply
                let rawFallback = latest?.remoteNumber ?? nil
                let rawReply = latest?.replyNumber ?? nil
                let fallbackReply = rawFallback.map(PhoneNumberText.normalized).flatMap { $0.isEmpty ? nil : $0 }
                let replyNumber = rawReply.map(PhoneNumberText.normalized).flatMap { $0.isEmpty ? nil : $0 }
                    ?? (explicitlyReplyable == nil ? fallbackReply : nil)
                return Self(
                    id: id,
                    displayNumber: display,
                    replyNumber: replyNumber,
                    canReply: explicitlyReplyable ?? (replyNumber != nil),
                    messages: sorted,
                    contact: ConversationContactSummary.from(sorted)
                )
            }
            .sorted { ($0.latest?.createdAt ?? "") > ($1.latest?.createdAt ?? "") }
    }
}

enum PhoneNumberText {
    static let dialCharacters = Set("0123456789*#+")

    static func normalized(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        var result = ""
        for character in trimmed where dialCharacters.contains(character) {
            if character == "+" && !result.isEmpty { continue }
            result.append(character)
        }
        return result
    }

    static func appending(_ character: String, to value: String) -> String {
        guard character.count == 1, let scalar = character.first, dialCharacters.contains(scalar) else { return value }
        if scalar == "+" && !value.isEmpty { return value }
        return value + character
    }

    static func deletingLast(from value: String) -> String {
        value.isEmpty ? value : String(value.dropLast())
    }

    /// Mirrors Control's `outboundCallNumber` (services/control/src/app.ts) on the already-`normalized` number,
    /// so a number the server answers 400 INVALID_REQUEST for is never submitted.
    static func isDialable(_ normalized: String) -> Bool {
        normalized.wholeMatch(of: #/\+[1-9][0-9]{1,14}|[0-9]{3,15}/#) != nil && normalized != "112" && normalized != "911"
    }
}

enum ConversationAddress {
    private static let phoneFormatting = Set("0123456789*#+-(). \t")

    static func key(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.allSatisfy({ phoneFormatting.contains($0) }) {
            return PhoneNumberText.normalized(trimmed)
        }
        // A canonical address can be an alphabetic sender. Keep it visible as
        // an opaque identity rather than deleting it as a malformed number.
        return trimmed
    }
}

enum SIMSelectionPolicy {
    static func preferredID(in sims: [SIMChannel], current: String?) -> String? {
        if let current, sims.contains(where: { $0.id == current }) { return current }
        return sims.first(where: { $0.online == true })?.id ?? sims.first?.id
    }

    /// S36 C5-b: the SIM a 拨打 request from another screen lands on. The SIM the request named wins while it
    /// still exists; otherwise the dialer's own selection, and failing that the preferred one.
    static func dialSIM(requested: String?, current: String?, sims: [SIMChannel]) -> String? {
        if let requested, sims.contains(where: { $0.id == requested }) { return requested }
        return preferredID(in: sims, current: current)
    }

    static func isOnline(_ simID: String?, sims: [SIMChannel]) -> Bool {
        guard let simID, let sim = sims.first(where: { $0.id == simID }) else { return false }
        return sim.online == true
    }

    static func canSendSMS(on simID: String?, sims: [SIMChannel]) -> Bool {
        guard let simID, let sim = sims.first(where: { $0.id == simID }) else { return false }
        return sim.online == true && sim.smsReady == true
    }

    static func canDial(on simID: String?, sims: [SIMChannel]) -> Bool {
        guard let simID, let sim = sims.first(where: { $0.id == simID }) else { return false }
        return sim.online == true && sim.telephonyReady == true && sim.mediaReady == true
    }
}

enum CallAvailabilityPolicy {
    static func activeCalls(_ calls: [CallRecord]) -> [CallRecord] {
        calls.filter { !["ended", "failed"].contains($0.state ?? "") }
    }

    /// Every non-terminal call that runs on the same physical gateway as `simID` — the same SIM, or a different SIM
    /// in the same Pixel. A gateway serves one cellular call at a time, so any of these occupies the device.
    static func sameGatewayActiveCalls(simID: String?, sims: [SIMChannel], calls: [CallRecord]) -> [CallRecord] {
        guard let simID, let selected = sims.first(where: { $0.id == simID }) else { return [] }
        return activeCalls(calls).filter { call in
            guard let callSIMID = call.simId else { return false }
            if callSIMID == simID { return true }
            guard let selectedGateway = selected.gatewayId,
                  let callGateway = sims.first(where: { $0.id == callSIMID })?.gatewayId else { return false }
            return selectedGateway == callGateway
        }
    }

    /// S20 decision 6: when the server states occupancy, `holdsLock` is authoritative — a call can be non-terminal
    /// without holding the gateway lock. Only a response without the field falls back to the old "any active call
    /// means busy" derivation.
    static func gatewayIsBusy(simID: String?, sims: [SIMChannel], calls: [CallRecord]) -> Bool {
        guard simID != nil, sims.contains(where: { $0.id == simID }) else { return true }
        let candidates = sameGatewayActiveCalls(simID: simID, sims: sims, calls: calls)
        let stated = candidates.filter { $0.occupancy != nil }
        if !stated.isEmpty { return stated.contains { $0.occupancy?.holdsLock == true } }
        return !candidates.isEmpty
    }

    static func canUseMedia(for call: CallRecord, currentMediaCallID: String?) -> Bool {
        guard call.claimedByCurrentSession == true,
              ["connecting", "active"].contains(call.state ?? "") else { return false }
        return currentMediaCallID == nil || currentMediaCallID == call.id
    }

    static func canStartOutbound(currentMediaCallID: String?) -> Bool {
        currentMediaCallID == nil
    }

    static func primaryOwnedCall(_ calls: [CallRecord], currentMediaCallID: String?) -> CallRecord? {
        if let currentMediaCallID,
           let mediaCall = activeCalls(calls).first(where: { $0.id == currentMediaCallID && $0.claimedByCurrentSession == true }) {
            return mediaCall
        }
        return activeCalls(calls).first {
            $0.claimedByCurrentSession == true && ["outgoing_pending", "connecting", "active", "ending", "unknown"].contains($0.state ?? "")
        }
    }
}

/// S20 decision 5: a call that is still moving needs a faster answer than the steady list refresh. Only the user's
/// own transitional calls shorten the loop — another owner's `active` call does not make this device impatient.
enum CallRefreshCadencePolicy {
    static let responsive: Duration = .seconds(2)
    static let steady: Duration = .seconds(5)
    /// Non-terminal and not yet `active`: 拨号中 / 振铃 / 接听中 / 结束中.
    static let transitionalStates: Set<String> = ["outgoing_pending", "incoming_ringing", "connecting", "ending"]

    /// A ringing call is always "own": it is offered to this account and the answer race is the thing being polled.
    static func isOwnTransitional(_ call: CallRecord, currentMediaCallID: String?) -> Bool {
        guard let state = call.state, transitionalStates.contains(state) else { return false }
        if state == "incoming_ringing" { return true }
        return call.claimedByCurrentSession == true || call.id == currentMediaCallID
    }

    static func interval(
        calls: [CallRecord],
        currentMediaCallID: String?,
        mediaIsConnecting: Bool = false
    ) -> Duration {
        // 媒体连接中: the call row can already read `active` while this device is still bringing audio up.
        if mediaIsConnecting, currentMediaCallID != nil { return responsive }
        let responsiveNeeded = calls.contains { isOwnTransitional($0, currentMediaCallID: currentMediaCallID) }
        return responsiveNeeded ? responsive : steady
    }
}

/// S20 decision 6: what the occupancy strip says, and whether it may offer a release.
enum SIMOccupancyDisplayPolicy {
    static let releaseTitle = "结束该通话"
    static let declineConfirmTitle = "拒接这通来电？"
    static let declineConfirmMessage = "将替本账号的所有设备拒接这通来电。"
    static let declineActionTitle = "拒接"
    static let endConfirmTitle = "结束该通话？"
    static let endConfirmMessage = "将挂断本账号在另一台设备上的通话。"
    static let endActionTitle = "结束通话"

    /// The call that occupies the selected SIM's gateway. `holdsLock` wins when stated; otherwise the first
    /// non-terminal call on that gateway stands in, so the strip still appears against an older server.
    static func occupyingCall(simID: String?, sims: [SIMChannel], calls: [CallRecord]) -> CallRecord? {
        let candidates = CallAvailabilityPolicy.sameGatewayActiveCalls(simID: simID, sims: sims, calls: calls)
        if let locked = candidates.first(where: { $0.occupancy?.holdsLock == true }) { return locked }
        guard !candidates.contains(where: { $0.occupancy != nil }) else { return nil }
        return candidates.first
    }

    /// "iPhone 端" / "Android 端" / "网页端" / "AI 接听", or the device name when the server named one.
    ///
    /// S22 decision 4: an AI-answered call holds the gateway before anyone is recorded as its occupant, so a
    /// suppressed call with no platform reads "AI 接听" rather than the anonymous "其他设备". The composite
    /// condition is deliberate — a `timeout_ai` call still waiting for its timer is not being answered by an AI.
    static func occupantTitle(_ call: CallRecord) -> String {
        if let device = call.occupancy?.occupantDevice ?? call.answeredByDevice, !device.isEmpty { return device }
        let platform = call.occupancy?.occupantPlatform ?? call.answeredByPlatform ?? call.originatingPlatform
        // S38：占用条说的是这台 Pixel 正忙，不是“怎么拨的”，所以不用 callPlatformTitle 的「通过手机拨打」。
        if platform == "pixel" || call.originatingPlatform == "pixel" { return GatewayKind(call.gatewayKind).busyTitle }
        if let title = callPlatformTitle(platform, gatewayKind: call.gatewayKind) { return title }
        return call.suppressesRinging ? "AI 接听" : "其他设备"
    }

    /// S72 统一文案：「通话中 · 由 {端} 接听 · 自 {时间}」；内部通话「内部通话 · A → B · 由 {端} 接听」。
    /// 还在响铃的来电没人接，仍写「占用中 · {占用者} · 自 {时间}」。`lockedSince` 缺失时用 `startedAt`。
    static func summary(_ call: CallRecord, timeZone: TimeZone, simLabel: String? = nil) -> String {
        let since = GatewayTimeDisplay.compact(call.occupancy?.lockedSince ?? call.startedAt, timeZone: timeZone)
        if isRinging(call) { return "占用中 · \(occupantTitle(call)) · 自 \(since)" }
        if call.isInternal {
            let route = InternalCallTitle.route(
                direction: call.direction, thisSimLabel: simLabel, peerSimLabel: call.peerSimLabel
            )
            return "内部通话 · \(route) · 由 \(occupantTitle(call)) 接听"
        }
        return "通话中 · 由 \(occupantTitle(call)) 接听 · 自 \(since)"
    }

    /// A release is only offered for somebody else's call: ending your own is what the in-call控件 is for.
    static func canRelease(_ call: CallRecord) -> Bool {
        // S38：手机自己拨的通话，网络这一侧挂不掉它——服务器也会把 canRelease 报成 false，这里本地再兜一次。
        guard call.originatingPlatform != "pixel", let occupancy = call.occupancy else { return false }
        return occupancy.canRelease && !occupancy.isCurrentSession
    }

    static func isRinging(_ call: CallRecord) -> Bool { call.state == "incoming_ringing" }

    static func confirmTitle(_ call: CallRecord) -> String {
        isRinging(call) ? declineConfirmTitle : endConfirmTitle
    }

    static func confirmMessage(_ call: CallRecord) -> String {
        isRinging(call) ? declineConfirmMessage : endConfirmMessage
    }

    static func confirmActionTitle(_ call: CallRecord) -> String {
        isRinging(call) ? declineActionTitle : endActionTitle
    }
}

/// S20 decision 6: the body for the one-shot `POST /calls/{id}/end` behind "结束该通话".
///
/// Releasing somebody else's call must not send `onlyIfCurrentSessionOwner` — the server would answer 409
/// `CALL_NOT_SESSION_OWNER` for exactly this case, and `/calls/:id/end` already authorizes by snapshot owner.
/// That also means the request carries no guard at all, which is precisely why it must never be retried: between
/// a failure and a retry another device can answer, and the retry would hang that call up. The ringing case keeps
/// `onlyIfRinging` because 拒接 is only meaningful while nobody has answered.
enum OccupancyReleaseActionPolicy {
    static func body(for call: CallRecord) -> GuardedCallEndBody {
        SIMOccupancyDisplayPolicy.isRinging(call)
            ? GuardedCallEndBody(onlyIfCurrentSessionOwner: nil, onlyIfRinging: true)
            : GuardedCallEndBody(onlyIfCurrentSessionOwner: nil, onlyIfRinging: nil)
    }
}

/// SwiftUI ignores `.disabled()` on a `Picker` row, so an unusable SIM has to be rejected after the fact.
enum SIMPickerFallbackPolicy {
    static let unavailableSMSMessage = "该号码当前无法发送短信"
    static let unavailableSuffix = "（暂不可发送）"

    static func resolveSMS(selected: String?, previous: String?, sims: [SIMChannel]) -> String? {
        if let selected, SIMSelectionPolicy.canSendSMS(on: selected, sims: sims) { return selected }
        if let previous, SIMSelectionPolicy.canSendSMS(on: previous, sims: sims) { return previous }
        if let firstUsable = sims.first(where: { SIMSelectionPolicy.canSendSMS(on: $0.id, sims: sims) }) {
            return firstUsable.id
        }
        return previous ?? selected
    }

    static func rejected(selected: String?, previous: String?, sims: [SIMChannel]) -> Bool {
        guard let selected else { return false }
        return !SIMSelectionPolicy.canSendSMS(on: selected, sims: sims)
            && resolveSMS(selected: selected, previous: previous, sims: sims) != selected
    }
}

@MainActor
final class MessageDraftStore {
    struct Draft: Equatable { var remoteNumber = ""; var body = "" }
    private var composeByAccountAndSIM: [String: Draft] = [:]
    private var replyByConversation: [String: String] = [:]

    func compose(accountID: String, simID: String) -> Draft {
        composeByAccountAndSIM["\(accountID)\u{001f}\(simID)"] ?? Draft()
    }

    func saveCompose(_ draft: Draft, accountID: String, simID: String) {
        let key = "\(accountID)\u{001f}\(simID)"
        if draft.remoteNumber.isEmpty && draft.body.isEmpty { composeByAccountAndSIM.removeValue(forKey: key) }
        else { composeByAccountAndSIM[key] = draft }
    }

    func clearCompose(accountID: String, simID: String) {
        composeByAccountAndSIM.removeValue(forKey: "\(accountID)\u{001f}\(simID)")
    }

    func reply(accountID: String, conversation: MessageConversationID) -> String {
        replyByConversation["\(accountID)\u{001f}\(conversation.id)"] ?? ""
    }

    func saveReply(_ body: String, accountID: String, conversation: MessageConversationID) {
        let key = "\(accountID)\u{001f}\(conversation.id)"
        if body.isEmpty { replyByConversation.removeValue(forKey: key) }
        else { replyByConversation[key] = body }
    }
}

enum ComposeMessagePrefillPolicy {
    static func number(initialNumber: String?, draftNumber: String) -> String {
        let seeded = PhoneNumberText.normalized(initialNumber ?? "")
        return seeded.isEmpty ? "" : (initialNumber ?? seeded)
    }
}

enum HistoryRowActionPolicy {
    /// S22 decision 10 / R3 §6: the app used to say 拉黑 here and 屏蔽 on the contact card for the same action.
    /// S21 §F froze 屏蔽 as the contract wording, so the history row now borrows the card's copy verbatim
    /// instead of keeping a second spelling.
    static let blockConfirmationTitle = ContactCardActionPolicy.blockConfirmTitle
    static let blockConfirmationMessage = ContactCardActionPolicy.blockConfirmMessage
    static let redialTitle = "回拨"
    static let smsTitle = "发短信"
    static let blockTitle = "屏蔽"

    static func canRedial(remoteNumber: String?, simId: String?, mediaLive: Bool) -> Bool {
        hasRemoteAndSIM(remoteNumber: remoteNumber, simId: simId) && !mediaLive
            && PhoneNumberText.isDialable(PhoneNumberText.normalized(remoteNumber ?? ""))
    }

    static func canSendSMS(remoteNumber: String?, simId: String?) -> Bool {
        hasRemoteAndSIM(remoteNumber: remoteNumber, simId: simId)
    }

    static func canBlock(remoteNumber: String?) -> Bool {
        guard let remoteNumber, !PhoneNumberText.normalized(remoteNumber).isEmpty else { return false }
        return !OwnerBlockedNumberKey.isEmergency(remoteNumber)
    }

    static func mediaIsLive(callID: String?, state: CallMediaSession.State) -> Bool {
        guard callID != nil else { return false }
        switch state {
        case .connecting, .connected: return true
        default: return false
        }
    }

    private static func hasRemoteAndSIM(remoteNumber: String?, simId: String?) -> Bool {
        guard let remoteNumber, !PhoneNumberText.normalized(remoteNumber).isEmpty,
              let simId, !simId.isEmpty else { return false }
        return true
    }
}
