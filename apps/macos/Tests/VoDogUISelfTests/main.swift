import Foundation

var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    checks += 1
    if !condition() {
        FileHandle.standardError.write(Data("VoDogUISelfTests failed (line \(line)): \(message)\n".utf8))
        exit(1)
    }
}

typealias P = VoDogPhonePolicy

func sim(_ id: String, slot: Int?, online: Bool?, mode: String? = nil) -> VoDogSIM {
    VoDogSIM(id: id, gatewayId: nil, label: nil, phoneLabel: nil, slotIndex: slot, online: online, version: nil,
                    present: nil, assignmentPending: nil,
                    settings: mode.map { VoDogSIMSettings(mode: $0, timeoutSeconds: 20, version: 1) })
}

func call(_ id: String, _ state: String, mode: String? = nil, ai: Bool? = nil) -> VoDogLiveCall {
    VoDogLiveCall(id: id, state: state, answerMode: mode, aiHandling: ai)
}

// Route.
check(P.usesRemoteRoute(signedIn: true) && !P.usesRemoteRoute(signedIn: false), "signed in → Control, out → module")
do {
    let a = CellularModuleID(rawValue: "a"), b = CellularModuleID(rawValue: "b")
    let modules: [(simID: String?, moduleID: CellularModuleID, canDial: Bool)] = [("s1", a, true), ("s2", b, false), (nil, a, true)]
    check(P.localDialModule(simID: "s1", modules: modules) == a, "S58: SIM on this Mac's module dials locally")
    check(P.localDialModule(simID: "s2", modules: modules) == nil, "S58: busy local module → Control")
    check(P.localDialModule(simID: "remote", modules: modules) == nil, "S58: other gateway's SIM → Control")
    check(P.localDialModule(simID: "s1", modules: []) == nil, "S58: no local gateway → Control")
}

// SIM strip order: online first, stable; a stale list keeps server order.
do {
    let sims = [sim("a", slot: 0, online: false), sim("b", slot: 1, online: true), sim("c", slot: 2, online: nil),
                sim("d", slot: 3, online: true)]
    check(P.displayOrder(sims, fresh: true).map(\.id) == ["b", "d", "a", "c"], "online first, stable")
    check(P.displayOrder(sims, fresh: false).map(\.id) == ["a", "b", "c", "d"], "stale keeps order")
    check(P.showsOnline(sims[1], fresh: true) && !P.showsOnline(sims[1], fresh: false), "stale greys the dot")
    check(!P.showsOnline(sims[2], fresh: true), "nil online is offline")
    check(P.preferredSIM(sims, current: "c") == "c", "keeps a current choice")
    check(P.preferredSIM(sims, current: "gone") == "b", "falls back to first online")
    check(P.preferredSIM([], current: nil) == nil, "no SIMs, no choice")
}

// Palette rank: (slotIndex, id), independent of input order; nil slot sorts last.
do {
    let sims = [sim("z", slot: 1, online: true), sim("x", slot: nil, online: true), sim("b", slot: 0, online: false),
                sim("a", slot: 1, online: false)]
    check(P.colorRank(of: "b", in: sims) == 0, "slot 0 first")
    check(P.colorRank(of: "a", in: sims) == 1 && P.colorRank(of: "z", in: sims) == 2, "same slot by id")
    check(P.colorRank(of: "x", in: sims) == 3, "nil slot last")
    check(P.colorRank(of: "a", in: sims.reversed()) == 1, "rank independent of input order")
    check(P.colorRank(of: "z", in: P.displayOrder(sims, fresh: true)) == 2, "rank independent of display order")
}

// Palette values.
do {
    let light = ["#2457C5", "#147D78", "#B45309", "#7C3AED", "#BE185D", "#4338CA", "#8A5A2B", "#0E7490"]
    let dark = ["#66A8FF", "#63D3CC", "#FDBA74", "#C4B5FD", "#F9A8D4", "#A5B4FC", "#E0B48A", "#67E8F9"]
    for index in 0..<8 {
        check(P.simColorHex(rank: index, dark: false) == light[index], "fixed light \(index)")
        check(P.simColorHex(rank: index, dark: true) == dark[index], "fixed dark \(index)")
    }
    check(P.hslHex(0, 1, 0.5) == "#FF0000" && P.hslHex(120, 1, 0.25) == "#008000", "hsl conversion")
    check(P.hslHex(240, 1, 0.5) == "#0000FF", "hsl blue")
    let extended = (8..<64).map { P.simColorHex(rank: $0, dark: false) }
    check(Set(extended).count == extended.count, "rank ≥ 8 colors are distinct")
    check(Set(extended).isDisjoint(with: light), "rank ≥ 8 never repeats a fixed color")
    check(P.simColorHex(rank: 9, dark: true) == P.simColorHex(rank: 9, dark: true), "deterministic")
    // h(8) = (8 × 137.508 + 20) mod 360 = 40.064 → light hsl(h,65%,28%), dark hsl(h,80%,75%).
    check(P.simColorHex(rank: 8, dark: false) == P.hslHex(40.064, 0.65, 0.28), "rank 8 light formula")
    check(P.simColorHex(rank: 8, dark: true) == P.hslHex(40.064, 0.80, 0.75), "rank 8 dark formula")
}

// Answer-mode badge.
check(P.answerModeBadge("normal") == "人工", "normal → 人工")
check(P.answerModeBadge("ai") == "AI" && P.answerModeBadge("timeout_ai") == "AI", "ai modes → AI")
check(P.answerModeBadge(nil) == nil && P.answerModeBadge("weird") == nil, "no settings → nothing")

// Incoming filter (Web audibleRingingCall).
do {
    let calls = [call("1", "active"), call("2", "incoming_ringing", mode: "ai", ai: true),
                 call("3", "incoming_ringing", mode: "timeout_ai", ai: true), call("4", "incoming_ringing")]
    check(P.incomingRinging(calls)?.id == "3", "AI-handled ai-mode call is suppressed; timeout_ai still rings")
    check(P.incomingRinging([call("5", "incoming_ringing", mode: "ai", ai: false)])?.id == "5", "ai mode not yet handled rings")
    check(P.incomingRinging([call("6", "connecting")]) == nil, "only incoming_ringing")
    var ringing = call("7", "incoming_ringing")
    ringing.simId = "sim-a"
    check(P.localAnswerCallID(serverCallId: "srv", simId: "sim-a", ringing: ringing) == "srv", "local 接听 prefers the gateway's call id")
    check(P.localAnswerCallID(serverCallId: nil, simId: "sim-a", ringing: ringing) == "7", "else the ringing call on the same SIM")
    check(P.localAnswerCallID(serverCallId: nil, simId: "sim-b", ringing: ringing) == nil
          && P.localAnswerCallID(serverCallId: nil, simId: nil, ringing: ringing) == nil, "never another SIM's call")
}

// End retry policy.
do {
    check(P.endRetryDelays.first == 0 && P.endRetryDelays.count >= 4, "immediate first try, several retries")
    check(zip(P.endRetryDelays, P.endRetryDelays.dropFirst()).allSatisfy { $0 <= $1 }, "backoff never shrinks")
    check((85...95).contains(P.endRetryDelays.reduce(0, +)), "retries span ~90 s like iOS")
    check(P.endBody(declining: true)["onlyIfRinging"] as? Bool == true, "decline guarded by ringing")
    check(P.endBody(declining: false)["onlyIfCurrentSessionOwner"] as? Bool == true, "hang up guarded by owner")
    check(P.shouldStopEnding(status: 404, code: nil) && P.shouldStopEnding(status: 401, code: nil), "gone/unauth stop")
    check(P.shouldStopEnding(status: 409, code: "CALL_NOT_RINGING"), "moved-on 409 stops")
    check(!P.shouldStopEnding(status: 409, code: "OTHER") && !P.shouldStopEnding(status: 0, code: "NETWORK"), "others retry")
    check(!P.shouldStopEnding(status: 503, code: nil), "5xx retries")
    check(P.isReleased("ended") && P.isReleased("failed") && !P.isReleased("ending") && !P.isReleased(nil), "released states")
}

// Numbers and SMS threads.
do {
    check(P.normalizedNumber(" +86 138-0000 0000 ") == "+8613800000000", "normalize")
    check(P.normalizedNumber("12+3") == "123", "inner plus dropped")
    check(P.addressKey("BANK") == "BANK" && P.addressKey("(010) 1234") == "0101234", "address keys")
    check(P.recipients("138, 139;138\n") == ["138", "139"], "recipients split + dedupe")
    let messages = [
        VoDogSMSMessage(id: "1", simId: "s1", remoteNumber: "+86 138", direction: "incoming", body: "a", createdAt: "2026-01-01"),
        VoDogSMSMessage(id: "2", simId: "s1", remoteNumber: "+86138", direction: "outgoing", body: "b", createdAt: "2026-01-03"),
        VoDogSMSMessage(id: "3", simId: "s2", remoteNumber: "+86138", direction: "incoming", body: "c", createdAt: "2026-01-04"),
        VoDogSMSMessage(id: "4", simId: "s1", remoteNumber: "BANK", canReply: false, direction: "incoming", body: "d",
                               createdAt: "2026-01-02")
    ]
    let threads = P.conversations(messages, simID: "s1")
    check(threads.map(\.id) == ["+86138", "BANK"], "grouped by SIM + address, newest first")
    check(threads[0].messages.map(\.id) == ["1", "2"], "thread ascending")
    check(threads[0].replyNumber == "+86138" && threads[0].canReply, "reply number falls back to remote")
    check(!threads[1].canReply, "explicit canReply false")
    check(P.conversations(messages, simID: nil).isEmpty, "no SIM, no threads")
    check(P.deliveryKey("queued") == "等待发送" && P.deliveryKey("delivered") == "已送达", "delivery labels")
    check(P.deliveryKey("received") == nil && P.deliveryKey("mystery") == "状态待确认", "delivery fallbacks")

    // S67c conversation dot: any unread message not yet marked read locally; `unread` missing → false.
    let wire = try! JSONDecoder().decode([VoDogSMSMessage].self,
                                         from: Data(#"[{"id":"r","unread":true},{"id":"o"}]"#.utf8))
    let unreadThread = VoDogConversation(id: "t", displayNumber: "t", replyNumber: nil, canReply: true,
                                                contactName: nil, messages: wire)
    check(wire[0].unread == true && wire[1].unread == nil, "unread decodes")
    check(unreadThread.hasUnread(excluding: []), "one unread message lights the thread")
    check(!unreadThread.hasUnread(excluding: ["r"]), "locally read hides the dot")
    check(!threads[0].hasUnread(excluding: []), "no unread field, no dot")
}

// S66 SMS deletion: block number, selection, batch limit, skipped count, retry key.
do {
    typealias D = VoDogSMSDeletePolicy
    let messages = [
        VoDogSMSMessage(id: "a", simId: "s1", remoteNumber: "+8613800138000", createdAt: "2026-01-01"),
        VoDogSMSMessage(id: "b", simId: "s1", remoteNumber: "13800138000", createdAt: "2026-01-02"),
        VoDogSMSMessage(id: "c", simId: "s1", remoteNumber: "  ", createdAt: "2026-01-03")
    ]
    let main = VoDogConversation(id: "13800138000", displayNumber: "+86 138", replyNumber: nil, canReply: true,
                                        contactName: nil, messages: messages)
    check(main.blockNumber == "13800138000", "newest non-empty raw remote number")
    check(main.threadAddress == "+86 138", "thread address is the display number")
    let blank = VoDogConversation(id: "x", displayNumber: " ", replyNumber: nil, canReply: false, contactName: nil,
                                         messages: [VoDogSMSMessage(id: "z", remoteNumber: nil)])
    check(blank.blockNumber == nil, "nothing to block")
    var selection = D.toggle("b", in: [])
    selection = D.toggle("a", in: selection)
    check(D.orderedIDs(selection, in: messages) == ["a", "b"], "body in thread order")
    check(D.orderedIDs(D.toggle("a", in: selection).union(["gone"]), in: messages) == ["b"], "toggle off + stale ids dropped")
    check(!D.canDelete([]) && D.canDelete(["a"]), "empty selection cannot delete")
    check(D.canDelete(Array(repeating: "x", count: 500)) && !D.canDelete(Array(repeating: "x", count: 501)), "500 cap")
    check(D.skippedCount(["deleted": 2, "skipped": [["id": "c", "reason": "in_flight"]]]) == 1, "skipped counted")
    check(D.skippedCount([:]) == 0, "empty response skips nothing")
    check(D.threadKey(simID: "s1", threadID: "138") != D.threadKey(simID: "s2", threadID: "138"), "retry key per SIM")
}

// Media: relay validation, gathering decision, Opus fmtp, module audio guard.
do {
    func options(_ url: String) -> [String: Any] {
        ["iceTransportPolicy": "relay", "iceServers": [["urls": [url], "username": "u", "credential": "c"]]]
    }
    check(P.validatedRelay(options("turn:192.0.2.1:3478?transport=udp"), transport: "udp") != nil, "udp relay ok")
    check(P.validatedRelay(options("turn:192.0.2.1:3478?transport=udp"), transport: "tls") == nil, "udp url refused for tls")
    check(P.validatedRelay(options("turns:h:443?transport=tcp"), transport: "tls") != nil, "tls relay ok")
    check(P.validatedRelay(["iceTransportPolicy": "all"], transport: "udp") == nil, "non-relay refused")

    check(P.gatherDecision(complete: false, relayCount: 0, elapsed: 1, sinceFirstRelay: nil) == .wait, "waits")
    check(P.gatherDecision(complete: false, relayCount: 1, elapsed: 1, sinceFirstRelay: 0.1) == .wait, "settles")
    check(P.gatherDecision(complete: false, relayCount: 1, elapsed: 1, sinceFirstRelay: 0.5) == .proceed, "proceeds after settle")
    check(P.gatherDecision(complete: true, relayCount: 0, elapsed: 1, sinceFirstRelay: nil) == .noRelayCandidate, "complete, none")
    check(P.gatherDecision(complete: false, relayCount: 0, elapsed: 12, sinceFirstRelay: nil) == .noRelayCandidate, "cap")

    let sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;usedtx=1\r\na=rtpmap:0 PCMU/8000\r\n"
    let rewritten = VoDogOpusOffer.rewrite(sdp: sdp)
    check(VoDogOpusOffer.fmtpParameters ==
          "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;maxplaybackrate=16000;sprop-maxcapturerate=16000",
          "fmtp == iOS OpusOfferPolicy (S70 wideband)")
    check(rewritten.contains("a=fmtp:111 \(VoDogOpusOffer.fmtpParameters)\r\n"), "opus fmtp replaced, CRLF kept")
    check(!rewritten.contains("usedtx"), "dtx removed")
    let missing = VoDogOpusOffer.rewrite(sdp: "a=rtpmap:109 OPUS/48000/2\na=x\n")
    check(missing == "a=rtpmap:109 OPUS/48000/2\na=fmtp:109 \(VoDogOpusOffer.fmtpParameters)\na=x\n", "fmtp inserted")
    check(VoDogOpusOffer.rewrite(sdp: "a=rtpmap:0 PCMU/8000\n") == "a=rtpmap:0 PCMU/8000\n", "no opus untouched")

    check(P.replacementDevice(current: "MacBook Pro Microphone", candidates: ["AC Interface", "X"]) == nil, "keep a Mac default")
    check(P.replacementDevice(current: "AC Interface", candidates: ["AC Interface", "MacBook Pro Microphone"]) == 1,
          "module UAC default is replaced")
    check(P.replacementDevice(current: "AS Interface", candidates: ["AS Interface"]) == nil, "nothing else to pick")
    check(P.replacementDevice(current: nil, candidates: ["X"]) == nil, "unknown default kept")
}

// S72: internal ring label + DTO decode.
do {
    let items = try! JSONDecoder().decode([VoDogLiveCall].self, from: Data(#"[{"id":"a","internal":true,"peerSimId":"p","peerSimLabel":" 联通186 "},{"id":"b","internal":true,"peerSimLabel":""},{"id":"c","peerSimLabel":"x"}]"#.utf8))
    check(items[0].internalPeerLabel == "联通186", "internal ring shows the calling SIM label")
    check(items[1].internalPeerLabel == nil && items[2].internalPeerLabel == nil, "no label / external → normal title")
}

print("VoDogUISelfTests passed (\(checks) checks)")
