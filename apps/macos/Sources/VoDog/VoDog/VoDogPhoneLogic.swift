import Foundation

// S57 remote calls / SMS / SIM strip: wire models and pure policies. Foundation only, so
// scripts/run_vodog_ui_tests.sh compiles it without SwiftUI, WebRTC or the Keychain.
// Rules follow the iOS app (SIMStripDisplayPolicy, ReliableCallEndPolicy, OpusOfferPolicy,
// MediaRelayGatheringPolicy, MessageConversation.grouped) and Web call-occupancy.ts.

/// `CallDto` subset the phone views need (`GET /calls`, `/calls/:id`, outbound, claim, end).
struct VoDogLiveCall: Decodable, Identifiable, Equatable {
    let id: String
    var simId: String?
    var direction: String?
    var remoteNumber: String?
    var state: String?
    var contactName: String?
    var claimedByCurrentSession: Bool?
    var answerMode: String?
    var aiHandling: Bool?
    /// S72: same-owner managed SIMs calling each other; `peerSimLabel` is the caller's own SIM on the ringing leg.
    var `internal`: Bool?
    var peerSimId: String?
    var peerSimLabel: String?
    /// S81: called SIM display (label, else number); only present when non-empty.
    var simLabel: String?

    /// S72 ring title argument for "%@（内部）": the calling SIM's label, nil for an external call.
    var internalPeerLabel: String? {
        guard `internal` == true else { return nil }
        let label = (peerSimLabel ?? "").trimmingCharacters(in: .whitespaces)
        return label.isEmpty ? nil : label
    }

    /// Web `aiSuppressed`: an AI-mode call the AI is handling never rings here.
    var suppressesRinging: Bool { answerMode == "ai" && aiHandling == true }
    var isFinished: Bool { VoDogPhonePolicy.isReleased(state) }
}

struct VoDogSMSMessage: Decodable, Identifiable, Equatable {
    let id: String
    var simId: String?
    var remoteNumber: String?
    var conversationAddress: String?
    var replyNumber: String?
    var canReply: Bool?
    var direction: String?
    var body: String?
    var state: String?
    var createdAt: String?
    var receivedAt: String?
    var sentAt: String?
    var deliveredAt: String?
    var failureReason: String?
    var contactName: String?
    /// S67c: incoming and not yet read on the server (missing → false).
    var unread: Bool?

    /// iOS `statusDate`: the latest known moment of this message.
    var statusDateString: String? { deliveredAt ?? sentAt ?? receivedAt ?? createdAt }
}

/// One thread on one SIM (iOS `MessageConversation`).
struct VoDogConversation: Identifiable, Equatable {
    let id: String              // normalized remote address
    var displayNumber: String
    var replyNumber: String?
    var canReply: Bool
    var contactName: String?
    var messages: [VoDogSMSMessage]   // ascending

    var latest: VoDogSMSMessage? { messages.last }

    /// S67c row dot: any message still unread that this session has not marked read yet.
    func hasUnread(excluding read: Set<String>) -> Bool {
        messages.contains { $0.unread == true && !read.contains($0.id) }
    }

    /// iOS `threadAddress`: what `POST /sms/threads/delete` is keyed by (the server normalises both sides).
    var threadAddress: String { displayNumber }

    /// iOS `blockNumber`: the newest non-empty raw `remoteNumber` (Control matches the number it stored),
    /// falling back to the display number.
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

/// S66 SMS deletion (iOS `MessageSelectionPolicy` / `ThreadDeleteResultPolicy`): `POST /sms/delete` takes
/// 1–500 ids; both delete endpoints answer `{deleted, skipped:[{id, reason}]}`.
enum VoDogSMSDeletePolicy {
    static let maximumBatch = 500

    static func toggle(_ id: String, in selection: Set<String>) -> Set<String> {
        selection.symmetricDifference([id])
    }

    /// The request body in thread order, limited to messages still in the thread (the 5 s poll may drop some).
    static func orderedIDs(_ selection: Set<String>, in messages: [VoDogSMSMessage]) -> [String] {
        messages.map(\.id).filter(selection.contains)
    }

    static func canDelete(_ ids: [String]) -> Bool { !ids.isEmpty && ids.count <= maximumBatch }

    static func skippedCount(_ response: [String: Any]) -> Int { (response["skipped"] as? [Any])?.count ?? 0 }

    /// Remembers a thread whose number is already blocked so a retried 删除并屏蔽 does not block again.
    /// Thread ids are address-only here, so the SIM is part of the key.
    static func threadKey(simID: String, threadID: String) -> String { simID + "|" + threadID }
}

enum VoDogPhonePolicy {
    // MARK: Route

    /// S57: signed in → every dial, answer and SMS goes through Control; signed out → the local module.
    static func usesRemoteRoute(signedIn: Bool) -> Bool { signedIn }

    /// S58: a signed-in dial on a SIM of a module this Mac's gateway runs goes straight to that
    /// module; nil (other SIM, or that module is busy) → Control, which answers busy for its lock.
    static func localDialModule(simID: String,
                                modules: [(simID: String?, moduleID: CellularModuleID, canDial: Bool)]) -> CellularModuleID? {
        modules.first { $0.simID == simID && $0.canDial }?.moduleID
    }

    // MARK: SIM strip

    /// Online SIMs first, stable; a stale list keeps server order (cached `online` is not current truth).
    static func displayOrder(_ sims: [VoDogSIM], fresh: Bool) -> [VoDogSIM] {
        // Control orders by slot_index only, so SIMs on different gateways with the same slot swap
        // places between refreshes; rank by (slotIndex, id) so a chip never moves under the pointer.
        let ranked = sims.sorted { ($0.slotIndex ?? Int.max, $0.id) < ($1.slotIndex ?? Int.max, $1.id) }
        guard fresh else { return ranked }
        return ranked.filter { $0.online == true } + ranked.filter { $0.online != true }
    }

    static func showsOnline(_ sim: VoDogSIM, fresh: Bool) -> Bool { fresh && sim.online == true }

    /// Palette index: rank in the account list sorted by (slotIndex, id) — never display order.
    static func colorRank(of simID: String, in sims: [VoDogSIM]) -> Int {
        let sorted = sims.sorted { ($0.slotIndex ?? Int.max, $0.id) < ($1.slotIndex ?? Int.max, $1.id) }
        return sorted.firstIndex { $0.id == simID } ?? 0
    }

    static let fixedPalette: [(light: String, dark: String)] = [
        ("#2457C5", "#66A8FF"), ("#147D78", "#63D3CC"), ("#B45309", "#FDBA74"), ("#7C3AED", "#C4B5FD"),
        ("#BE185D", "#F9A8D4"), ("#4338CA", "#A5B4FC"), ("#8A5A2B", "#E0B48A"), ("#0E7490", "#67E8F9")
    ]
    static let textOnColor = (light: "#FFFFFF", dark: "#0B1220")

    /// S57 palette: 8 fixed colors, then golden-angle hues (never an exact repeat).
    static func simColorHex(rank: Int, dark: Bool) -> String {
        if fixedPalette.indices.contains(rank) { return dark ? fixedPalette[rank].dark : fixedPalette[rank].light }
        let hue = (Double(rank) * 137.508 + 20).truncatingRemainder(dividingBy: 360)
        return dark ? hslHex(hue, 0.80, 0.75) : hslHex(hue, 0.65, 0.28)
    }

    static func hslHex(_ h: Double, _ s: Double, _ l: Double) -> String {
        let c = (1 - abs(2 * l - 1)) * s
        let x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = l - c / 2
        let (r, g, b): (Double, Double, Double)
        switch h {
        case ..<60: (r, g, b) = (c, x, 0)
        case ..<120: (r, g, b) = (x, c, 0)
        case ..<180: (r, g, b) = (0, c, x)
        case ..<240: (r, g, b) = (0, x, c)
        case ..<300: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        return String(format: "#%02X%02X%02X", Int(((r + m) * 255).rounded()), Int(((g + m) * 255).rounded()),
                      Int(((b + m) * 255).rounded()))
    }

    /// Localization key: normal → 人工, ai / timeout_ai → AI, no settings (or unknown mode) → nothing.
    static func answerModeBadge(_ mode: String?) -> String? {
        switch mode {
        case "normal": return "人工"
        case "ai", "timeout_ai": return "AI"
        default: return nil
        }
    }

    /// Keeps the current choice while it exists; otherwise the first online SIM, then the first.
    static func preferredSIM(_ sims: [VoDogSIM], current: String?) -> String? {
        if let current, sims.contains(where: { $0.id == current }) { return current }
        return sims.first(where: { $0.online == true })?.id ?? sims.first?.id
    }

    // MARK: Calls

    /// Web `audibleRingingCall`: the ringing call a human may answer here.
    static func incomingRinging(_ calls: [VoDogLiveCall]) -> VoDogLiveCall? {
        calls.first { $0.state == "incoming_ringing" && !$0.suppressesRinging }
    }

    /// Which server call the local 接听 claims for a gateway-owned ring: the gateway's bound call id, else
    /// the VoDog call ringing on the same SIM (a SIM rings one call at a time).
    static func localAnswerCallID(serverCallId: String?, simId: String?, ringing: VoDogLiveCall?) -> String? {
        if let serverCallId { return serverCallId }
        guard let simId, let ringing, ringing.simId == simId, ringing.state == "incoming_ringing" else { return nil }
        return ringing.id
    }

    static func isReleased(_ state: String?) -> Bool { ["ended", "failed"].contains(state ?? "") }

    /// A lost `end` keeps the SIM locked, so it is retried; every body carries a guard so a late retry
    /// can never hang up a call another device answered meanwhile.
    static let endRetryDelays: [TimeInterval] = [0, 1, 2, 4, 8, 15, 30, 30]   // ~90 s, iOS ReliableCallEndQueue

    static func endBody(declining: Bool) -> [String: Any] {
        declining ? ["onlyIfRinging": true] : ["onlyIfCurrentSessionOwner": true]
    }

    /// 401/404 and the two "state moved on" 409s make a retry moot; everything else (network, 5xx) retries.
    static func shouldStopEnding(status: Int, code: String?) -> Bool {
        status == 401 || status == 404
            || (status == 409 && ["CALL_NOT_SESSION_OWNER", "CALL_NOT_RINGING"].contains(code ?? ""))
    }

    static func normalizedNumber(_ value: String) -> String {
        var result = ""
        for character in value.trimmingCharacters(in: .whitespacesAndNewlines) where "0123456789*#+".contains(character) {
            if character == "+" && !result.isEmpty { continue }
            result.append(character)
        }
        return result
    }

    // MARK: SMS

    /// iOS `ConversationAddress.key`: phone-shaped → dial characters; an alphabetic sender stays opaque.
    static func addressKey(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.allSatisfy({ "0123456789*#+-(). \t".contains($0) }) ? normalizedNumber(trimmed) : trimmed
    }

    /// iOS `MessageConversation.grouped`: threads of the selected SIM, newest first.
    static func conversations(_ messages: [VoDogSMSMessage], simID: String?) -> [VoDogConversation] {
        guard let simID else { return [] }
        var groups: [String: [VoDogSMSMessage]] = [:]
        for message in messages where message.simId == simID {
            guard let raw = message.conversationAddress ?? message.remoteNumber else { continue }
            let key = addressKey(raw)
            if !key.isEmpty { groups[key, default: []].append(message) }
        }
        return groups.map { key, values in
            let sorted = values.sorted { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
            let latest = sorted.last
            let display = [latest?.conversationAddress, latest?.remoteNumber].compactMap { $0 }
                .first { !$0.isEmpty } ?? key
            let fallback = latest?.remoteNumber.map(normalizedNumber).flatMap { $0.isEmpty ? nil : $0 }
            let reply = latest?.replyNumber.map(normalizedNumber).flatMap { $0.isEmpty ? nil : $0 }
                ?? (latest?.canReply == nil ? fallback : nil)
            return VoDogConversation(
                id: key, displayNumber: display, replyNumber: reply, canReply: latest?.canReply ?? (reply != nil),
                contactName: sorted.reversed().compactMap(\.contactName).first { !$0.isEmpty }, messages: sorted)
        }
        .sorted { ($0.latest?.createdAt ?? "") > ($1.latest?.createdAt ?? "") }
    }

    /// iOS `deliveryTitle` (localization key). Never claims delivery before the server says so.
    static func deliveryKey(_ state: String?) -> String? {
        switch state?.lowercased() {
        case "queued", "pending": return "等待发送"
        case "sending": return "发送中"
        case "sent": return "已发送"
        case "delivered": return "已送达"
        case "received", nil: return nil
        case "failed": return "发送失败"
        default: return "状态待确认"
        }
    }

    /// Several comma/semicolon/newline separated numbers go to `POST /sms/batch`.
    static func recipients(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(whereSeparator: { ",;，；\n".contains($0) }).map { normalizedNumber(String($0)) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    // MARK: Media

    /// iOS `MediaOptionsResponse.validatedRelayURL`: exactly one relay server of the requested transport.
    static func validatedRelay(_ options: [String: Any], transport: String) -> (urls: [String], username: String, credential: String)? {
        guard options["iceTransportPolicy"] as? String == "relay",
              let servers = options["iceServers"] as? [[String: Any]], servers.count == 1,
              let urls = servers[0]["urls"] as? [String], urls.count == 1,
              let username = servers[0]["username"] as? String, !username.isEmpty,
              let credential = servers[0]["credential"] as? String, !credential.isEmpty else { return nil }
        let url = urls[0].lowercased()
        let ok = transport == "tls" ? url.hasPrefix("turns:") && url.contains("transport=tcp")
            : url.hasPrefix("turn:") && url.contains("transport=udp")
        return ok ? (urls, username, credential) : nil
    }

    enum GatherDecision: Equatable { case wait, proceed, noRelayCandidate }

    static let relaySettle: TimeInterval = 0.4
    static let relayCap: TimeInterval = 12

    /// Offer on the first relay candidate plus a short settle; gathering `complete` is only an early exit
    /// (media-node-a never fires it).
    static func gatherDecision(complete: Bool, relayCount: Int, elapsed: TimeInterval,
                               sinceFirstRelay: TimeInterval?) -> GatherDecision {
        if complete { return relayCount > 0 ? .proceed : .noRelayCandidate }
        if relayCount > 0, let sinceFirstRelay, sinceFirstRelay >= relaySettle { return .proceed }
        if elapsed >= relayCap { return relayCount > 0 ? .proceed : .noRelayCandidate }
        return .wait
    }

    /// S57 audio device guard: the DJI module's UAC shows up as CoreAudio "AC Interface" (input) /
    /// "AS Interface" (output), 8 kHz mono. Returns the index to switch to when the current device is
    /// one of them, nil to keep the system default.
    // ponytail: name match (CoreAudio exposes no USB identity through the ADM); upgrade to the
    // VoiceAudioService UID if another module names its UAC differently.
    static let moduleAudioNames: Set<String> = ["AC Interface", "AS Interface"]

    static func replacementDevice(current: String?, candidates: [String]) -> Int? {
        guard let current, moduleAudioNames.contains(current) else { return nil }
        return candidates.firstIndex { !moduleAudioNames.contains($0) }
    }
}

/// S20 decision 1 (iOS `OpusOfferPolicy`, verbatim rules): every Opus payload carries exactly this fmtp.
enum VoDogOpusOffer {
    /// S70: both gateways decode at <= 16 kHz, so every bit spent above wideband is wasted. Its own
    /// constant so it can be rolled back independently (S20 invariant 5).
    static let widebandParameters = "maxplaybackrate=16000;sprop-maxcapturerate=16000"
    static let fmtpParameters = "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;\(widebandParameters)"

    static func rewrite(sdp: String) -> String {
        let lines = sdp.components(separatedBy: "\n")
        var opus = Set<String>(), withFmtp = Set<String>()
        for line in lines {
            let body = strip(line)
            if let payload = opusPayload(body) { opus.insert(payload) }
            if let payload = fmtpPayload(body) { withFmtp.insert(payload) }
        }
        guard !opus.isEmpty else { return sdp }
        var out: [String] = []
        for line in lines {
            let cr = line.hasSuffix("\r") ? "\r" : ""
            let body = strip(line)
            if let payload = fmtpPayload(body), opus.contains(payload) {
                out.append("a=fmtp:\(payload) \(fmtpParameters)\(cr)")
                continue
            }
            out.append(line)
            if let payload = opusPayload(body), !withFmtp.contains(payload) {
                out.append("a=fmtp:\(payload) \(fmtpParameters)\(cr)")
            }
        }
        return out.joined(separator: "\n")
    }

    private static func strip(_ line: String) -> String { line.hasSuffix("\r") ? String(line.dropLast()) : line }

    private static func opusPayload(_ body: String) -> String? {
        guard body.hasPrefix("a=rtpmap:") else { return nil }
        let rest = body.dropFirst("a=rtpmap:".count)
        guard let space = rest.firstIndex(of: " ") else { return nil }
        let payload = String(rest[..<space])
        let name = rest[rest.index(after: space)...].split(separator: "/", maxSplits: 1).first ?? ""
        return !payload.isEmpty && payload.allSatisfy(\.isNumber) && name.lowercased() == "opus" ? payload : nil
    }

    private static func fmtpPayload(_ body: String) -> String? {
        guard body.hasPrefix("a=fmtp:") else { return nil }
        let payload = String(body.dropFirst("a=fmtp:".count).prefix { $0 != " " })
        return !payload.isEmpty && payload.allSatisfy(\.isNumber) ? payload : nil
    }
}
