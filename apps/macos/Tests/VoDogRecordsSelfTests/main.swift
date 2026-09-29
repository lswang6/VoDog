import AVFoundation
import Foundation

// Assert-based checks for VoDogRecordModels.swift. Run via scripts/run_vodog_records_tests.sh.
// Samples mirror Control's /calls, /reports/calls, /transcript, /ai-transcript and /recordings responses.

func check(_ condition: @autoclosure () -> Bool, _ message: String, file: StaticString = #file, line: UInt = #line) {
    if !condition() {
        FileHandle.standardError.write(Data("FAIL \(message) (\(file):\(line))\n".utf8))
        exit(1)
    }
}

func json(_ text: String) -> Any { try! JSONSerialization.jsonObject(with: Data(text.utf8)) }

// MARK: /calls page

do {
    let page = try CCRecords.decode(CCCallsPage.self, from: json("""
    {"items":[
      {"id":"11111111-1111-4111-8111-111111111111","simId":"s1","direction":"incoming","remoteNumber":"+8613800000000",
       "state":"ended","startedAt":"2026-09-20T02:00:00.000Z","answeredAt":"2026-09-20T02:00:05.000Z",
       "endedAt":"2026-09-20T02:01:10.000Z","answeredByPlatform":"macos","answeredByDevice":null,
       "originatingPlatform":null,"failureReason":null,"gatewayTimeZone":"Asia/Shanghai","contactName":"张三",
       "blocked":false,"answerMode":"normal","aiHandling":false,"occupancy":{"locked":false},"unknownField":1},
      {"id":"22222222-2222-4222-8222-222222222222","direction":"incoming","state":"failed",
       "failureReason":"number_blocked","blockedSource":"gateway","startedAt":"2026-09-20T03:00:00Z"}
    ],"page":1,"pageSize":50,"total":2,"totalPages":1}
    """))
    check(page.items.count == 2 && page.totalPages == 1, "calls page decodes")
    let first = page.items[0]
    check(first.contactName == "张三" && first.answeredByPlatform == "macos", "call fields")
    check(CCRecordLabels.owner(first)?.text == "Mac 端" && CCRecordLabels.owner(first)?.isKey == true, "macos → Mac 端")
    check(CCRecordLabels.badge(first) == nil, "plain call has no badge")
    check(CCTime.duration(answeredAt: first.answeredAt, endedAt: first.endedAt) == "1 分 05 秒", "talk time 65 s")
    check(CCTime.gatewayClock(first.startedAt, zone: first.gatewayTimeZone) == "2026-09-20 10:00", "gateway zone clock")
    let blocked = page.items[1]
    check(blocked.showsBlockedMark, "number_blocked shows block mark")
    check(CCRecordLabels.badge(blocked) == "网关拦截", "blocked source badge")
    check(CCTime.duration(answeredAt: blocked.answeredAt, endedAt: blocked.endedAt) == nil, "unanswered has no duration")
    let legacy = try CCRecords.decode(CCCallsPage.self, from: json(#"{"items":[{"id":"x"}]}"#))
    check(legacy.totalPages == nil && legacy.items[0].state == nil, "legacy page without envelope")
} catch { check(false, "calls decode threw \(error)") }

// MARK: labels

check(CCRecordLabels.platform("ios") == "iPhone 端", "ios")
check(CCRecordLabels.platform("android") == "Android 端", "android")
check(CCRecordLabels.platform("web") == "网页端", "web")
check(CCRecordLabels.platform("ai") == "AI 接听", "ai")
check(CCRecordLabels.platform("pixel") == "通过手机拨打", "pixel")
check(CCRecordLabels.platform("zzz") == nil, "unknown platform")
// S58 gateway kind: text only, missing → pixel.
check(CCRecordLabels.platform("pixel", gatewayKind: "dji4g") == "通过 DJI 4G 模组拨打", "dji4g direct dial")
check(CCRecordLabels.platform("pixel", gatewayKind: nil) == "通过手机拨打", "missing kind → pixel")
check(CCRecordLabels.badge(failureReason: nil, blockedSource: nil, conflictDisposition: nil, originatingPlatform: "pixel",
                           gatewayKind: "dji4g") == "通过 DJI 4G 模组拨打", "dji4g badge")
check(CCRecordLabels.recordingSource("pixel", gatewayKind: "dji4g") == "DJI 4G 原始归档", "dji4g archive")
check(CCRecordLabels.recordingSource("pixel", gatewayKind: "pixel") == "Pixel 原始归档", "pixel archive")
check(CCRecordLabels.recordingSource("server", gatewayKind: "dji4g") == "服务器录音", "server recording")
check(CCRecordLabels.state("active") == "通话中" && CCRecordLabels.state(nil) == "状态待确认", "state titles")
check(CCRecordLabels.badge(failureReason: "number_blocked", blockedSource: nil, conflictDisposition: nil, originatingPlatform: "pixel") == "已拦截", "blocked wins, unknown source")
check(CCRecordLabels.badge(failureReason: "number_blocked", blockedSource: "phone", conflictDisposition: nil, originatingPlatform: nil) == "手机自动拦截", "phone source")
check(CCRecordLabels.badge(failureReason: "busy_auto_rejected", blockedSource: nil, conflictDisposition: nil, originatingPlatform: nil) == "忙线未接", "S72 busy reject → 忙线未接")
check(CCRecordLabels.badge(failureReason: nil, blockedSource: nil, conflictDisposition: "ai_answered", originatingPlatform: "pixel") == "忙线 AI 代接", "conflict before pixel")
check(CCRecordLabels.badge(failureReason: nil, blockedSource: nil, conflictDisposition: nil, originatingPlatform: "pixel") == "通过手机拨打", "pixel badge")
check(CCRecordLabels.answerMethod(answerMode: "ai", answeredByPlatform: "ai", answeredAt: nil) == "未接", "missed first")
check(CCRecordLabels.answerMethod(answerMode: "timeout_ai", answeredByPlatform: "ai", answeredAt: "t") == "超时 AI", "timeout ai")
check(CCRecordLabels.answerMethod(answerMode: "ai", answeredByPlatform: "ai", answeredAt: "t") == "AI 接听", "ai")
check(CCRecordLabels.answerMethod(answerMode: "timeout_ai", answeredByPlatform: "ios", answeredAt: "t") == "真人", "human")
var aiCall = CCCallRecord(id: "a")
aiCall.answerMode = "ai"; aiCall.aiHandling = true
check(CCRecordLabels.aiHandling(aiCall) == "AI 正在处理", "ai handling")
aiCall.aiHandling = nil; aiCall.answerMode = "timeout_ai"
check(CCRecordLabels.aiHandling(aiCall) == "超时转 AI 模式", "timeout mode")
aiCall.answeredByDevice = "LS 的 MacBook"
check(CCRecordLabels.owner(aiCall)?.text == "LS 的 MacBook" && CCRecordLabels.owner(aiCall)?.isKey == false, "device name wins")
check(CCRecordLabels.track("remote_original") == "对方原声", "remote track")
check(CCRecordLabels.track("caller_original") == "我的原声", "caller track")
check(CCRecordLabels.track("caller_playout") == "手机播放", "playout track")
check(CCRecordLabels.speaker(track: "", speaker: "remote") == "对方", "speaker remote")
check(CCRecordLabels.speaker(track: "caller_original", speaker: "x") == "本人", "speaker self")
check(CCRecordLabels.reportSummary(transcriptState: "none", errorCode: nil, summary: nil) == (true, "无转录：录音为空"), "summary none")
check(CCRecordLabels.reportSummary(transcriptState: "failed", errorCode: "RECORDING_EMPTY", summary: nil).text == "无转录：录音为空", "summary empty recording")
check(CCRecordLabels.reportSummary(transcriptState: "failed", errorCode: "X", summary: nil).text == "转录失败，原始录音仍可查看", "summary failed")
check(CCRecordLabels.reportSummary(transcriptState: "running", errorCode: nil, summary: " ").text == "转录处理中…", "summary running")
check(CCRecordLabels.reportSummary(transcriptState: "succeeded", errorCode: nil, summary: "推销") == (false, "推销"), "summary text")
check(CCRecordLabels.blockBadge(blockRecommended: true, blockReason: " ") == .recommended(reason: nil), "recommend no reason")
check(CCRecordLabels.blockBadge(blockRecommended: nil, blockReason: nil) == .unclassified, "unclassified")
check(CCRecordLabels.blockBadge(blockRecommended: false, blockReason: "x") == .none, "not recommended")

// MARK: time

check(CCTime.clock(0) == "0:00" && CCTime.clock(59.9) == "0:59" && CCTime.clock(3725) == "1:02:05", "clock")
check(CCTime.clock(.nan) == "0:00" && CCTime.clock(-1) == "0:00", "clock guards")
check(CCTime.parseISO("2026-09-20T02:00:00.123Z") != nil && CCTime.parseISO("2026-09-20T02:00:00Z") != nil, "iso both forms")
check(CCTime.gatewayClock(nil, zone: nil) == "—", "missing clock")
check(CCTime.duration(answeredAt: "2026-09-20T02:01:00Z", endedAt: "2026-09-20T02:00:00Z") == nil, "negative duration dropped")
check(CCTime.duration(answeredAt: "2026-09-20T02:00:00Z", endedAt: "2026-09-20T02:00:48Z") == "48 秒", "short talk time in seconds")

// MARK: /reports/calls

do {
    let page = try CCRecords.decode(CCReportPage.self, from: json("""
    {"window":{"period":"7d","timeZone":"Asia/Shanghai"},"items":[
      {"callId":"c1","startedAt":"2026-09-20T02:00:00.000Z","direction":"incoming","remoteNumber":"95555",
       "sim":{"id":"s1","label":"DJI","slotIndex":0},"answerMode":"ai","answeredByPlatform":"ai",
       "answeredAt":"2026-09-20T02:00:03.000Z","endedAt":"2026-09-20T02:00:33.000Z",
       "transcriptState":"succeeded","transcriptError":null,"summary":"贷款推销","actionItems":["回电"],
       "classification":"advertising","blockRecommended":true,"blockCategory":"marketing","blockReason":"推销",
       "hasAiTranscript":true,"blocked":false},
      {"callId":"c2","startedAt":"2026-09-20T03:00:00Z","sim":{"id":"s1","label":null,"slotIndex":null},
       "transcriptState":"none","actionItems":[]}
    ],"page":1,"pageSize":50,"total":2,"totalPages":1}
    """))
    check(page.items.count == 2, "report decodes")
    let item = page.items[0]
    check(item.actionItems == ["回电"] && item.blockRecommended == true && item.sim?.label == "DJI", "report fields")
    check(item.asCallRecord.id == "c1" && item.asCallRecord.simId == "s1", "report → call seed")
    check(page.items[1].sim?.label == nil && page.items[1].blockRecommended == nil, "sparse report row")
} catch { check(false, "report decode threw \(error)") }

// MARK: transcript + AI

do {
    let envelope = try CCRecords.decode(CCTranscriptEnvelope.self, from: json("""
    {"transcript":{"id":"j","callId":"c1","status":"succeeded","attempts":1,"nextAttemptAt":null,"error":null,
     "result":{"text":"你好 喂","segments":[
       {"track":"remote_original","speaker":"remote","text":"你好","startMs":0,"endMs":800},
       {"track":"remote_original","speaker":"remote","text":"请问","startMs":900,"endMs":1500},
       {"track":"caller_original","speaker":"vodog_user","text":"喂","startMs":1600,"endMs":2000},
       {"track":"caller_original","speaker":"vodog_user","text":"  ","startMs":2100,"endMs":2200}],
      "providers":[],"advertisingClassification":"unknown","includeInReports":true,"summary":"问候","actionItems":[]},
     "createdAt":"x","updatedAt":"x","completedAt":null}}
    """))
    let job = envelope.transcript!
    check(job.status == "succeeded" && job.result?.summary == "问候", "transcript decodes")
    let blocks = CCTranscriptBlock.blocks(from: job.result!.segments!)
    check(blocks.count == 2 && blocks[0].text == "你好 请问" && blocks[1].text == "喂", "blocks merge same speaker, drop blanks")
    let none = try CCRecords.decode(CCTranscriptEnvelope.self, from: json(#"{"transcript":null}"#))
    check(none.transcript == nil, "null transcript")
    let retry = try CCRecords.decode(CCTranscriptEnvelope.self, from: json(#"{"transcript":{"status":"retry","nextAttemptAt":"2026-09-20T02:00:00Z","error":{"code":"X","message":"m"},"result":null}}"#))
    check(retry.transcript?.status == "retry" && retry.transcript?.error?.message == "m", "retry job")
    let ai = try CCRecords.decode(CCAiTranscriptEnvelope.self, from: json(#"{"items":[{"role":"ai","text":"您好","at":"t"},{"role":"caller","text":"找谁","at":null}]}"#))
    check(ai.items.count == 2 && CCRecordLabels.aiRole(ai.items[0].role) == "AI 助理" && CCRecordLabels.aiRole(ai.items[1].role) == "对方", "ai transcript")
} catch { check(false, "transcript decode threw \(error)") }

// MARK: recording manifests

do {
    let sha = String(repeating: "a", count: 64)
    let v1 = try CCRecords.decode(CCRecordingEnvelope.self, from: json("""
    {"recording":{"version":1,"callId":"c1","finalizedAt":"2026-09-20T02:01:00.123456789Z","complete":true,
     "artifacts":[{"name":"remote_original.ogg","bytes":40000,"sha256":"\(sha)"},
                  {"name":"caller_original.ogg","bytes":30000,"sha256":"\(sha)"},
                  {"name":"timeline.jsonl","bytes":100,"sha256":"\(sha)"}],"nodeId":"media-node-a","mediaEpoch":1}}
    """)).recording!
    check(v1.source == "media_node" && v1.archiveComplete, "v1 source/complete")
    check(v1.tracks.map(\.track) == ["remote_original", "caller_original"], "v1 tracks, timeline skipped")
    check(!v1.isEmptyCapture, "v1 has audio")

    let v3 = try CCRecords.decode(CCRecordingEnvelope.self, from: json("""
    {"recording":{"source":"pixel","version":3,"archiveId":"x","callId":"c1","manifestSha256":"\(sha)",
     "archiveComplete":true,"captureComplete":false,"startedAt":"2026-09-20T02:00:00.000Z","endedAt":"2026-09-20T02:01:00.000Z",
     "tracks":[{"track":"caller_original","mediaType":"audio/wav","bytes":900000,"sha256":"\(sha)","durationMs":60000},
               {"track":"remote_original","mediaType":"audio/wav","bytes":900000,"sha256":"\(sha)","durationMs":60000}],
     "derivedTracks":[{"track":"caller_playout","bytes":900000,"durationMs":60000}],
     "timeline":{"mediaType":"application/x-ndjson","bytes":10,"sha256":"\(sha)"}}}
    """)).recording!
    check(v3.source == "pixel" && v3.captureComplete == false, "v3 flags")
    check(v3.tracks.map(\.track) == ["remote_original", "caller_original", "caller_playout"], "v3 ordered with derived")
    check(v3.originals.count == 2 && v3.tracks[2].derived && v3.tracks[0].durationMs == 60000, "v3 derived flag")
    check(v3.finalizedAt == "2026-09-20T02:01:00.000Z", "v3 endedAt as finalizedAt")

    let empty = try CCRecords.decode(CCRecordingEnvelope.self, from: json("""
    {"recording":{"version":1,"callId":"c1","finalizedAt":"x","complete":false,
     "artifacts":[{"name":"remote_original.ogg","bytes":95},{"name":"caller_original.ogg","bytes":95}]}}
    """)).recording!
    check(empty.isEmptyCapture && !empty.archiveComplete, "header-only capture is empty")
    let missing = try CCRecords.decode(CCRecordingEnvelope.self, from: json(#"{"recording":null}"#))
    check(missing.recording == nil, "null recording")
} catch { check(false, "manifest decode threw \(error)") }

// MARK: sims

do {
    let sims = try CCRecords.decode(CCSimList.self, from: json(#"{"items":[{"id":"s1","label":"DJI","slotIndex":0,"version":3},{"id":"s2","label":" ","slotIndex":1}]}"#))
    check(sims.items[0].title == "DJI" && sims.items[1].title == "SIM 2", "sim titles")
} catch { check(false, "sims decode threw \(error)") }

// MARK: playback toggle + load watchdog

check(CCPlaybackPolicy.action(isCurrent: true, hasPlayer: true, isPlaying: true) == .pause, "playing → pause")
check(CCPlaybackPolicy.action(isCurrent: true, hasPlayer: true, isPlaying: false) == .resume, "paused → resume")
check(CCPlaybackPolicy.action(isCurrent: true, hasPlayer: false, isPlaying: false) == .restart, "stalled/failed load restarts, never resume on nil player")
check(CCPlaybackPolicy.action(isCurrent: false, hasPlayer: true, isPlaying: true) == .restart, "other track restarts")

do {
    let value = try await CCAsync.withTimeout(2) { 42 }
    check(value == 42, "fast op returns its value")
} catch { check(false, "fast op threw \(error)") }

do {
    _ = try await CCAsync.withTimeout(2) { () async throws -> Int in throw URLError(.timedOut) }
    check(false, "op error must propagate")
} catch { check(error is URLError, "op error propagates, got \(error)") }

// An op that ignores cancellation forever (like a request stuck behind a refresh) must still time out.
do {
    _ = try await CCAsync.withTimeout(0.2) { () async throws -> Int in
        Thread.sleep(forTimeInterval: 2) // ignores cancellation entirely
        return 0
    }
    check(false, "hung op must time out")
} catch {
    check(error is CCTimeoutError, "hung op → CCTimeoutError, got \(error)")
}
do {
    let started = Date()
    _ = try? await CCAsync.withTimeout(0.2) { () async throws -> Int in
        Thread.sleep(forTimeInterval: 2) // ignores cancellation entirely
        return 0
    }
    check(Date().timeIntervalSince(started) < 1.5, "timeout fires promptly")
}

// Outer cancellation (tap again / leave detail) ends the wait at once.
do {
    let outer = Task { try await CCAsync.withTimeout(30) { () async throws -> Int in
        try await Task.sleep(nanoseconds: 30_000_000_000); return 0 } }
    try? await Task.sleep(nanoseconds: 50_000_000)
    let started = Date()
    outer.cancel()
    do { _ = try await outer.value; check(false, "cancelled wait must throw") }
    catch { check(error is CancellationError && Date().timeIntervalSince(started) < 1, "outer cancel → CancellationError promptly") }
}

// The real Pixel WAV from the device report (if present) must be playable as downloaded.
let tmp = ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()
let wav = URL(fileURLWithPath: tmp).appendingPathComponent("dl-remote_original.bin")
if let data = try? Data(contentsOf: wav) {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("cc-selftest-\(UUID().uuidString).wav")
    try data.write(to: url)
    let playable = try await AVURLAsset(url: url).load(.isPlayable)
    try? FileManager.default.removeItem(at: url)
    check(playable, "real Pixel WAV playable from temp .wav")
}

// MARK: missed incoming + SIM line

do {
    func call(_ direction: String?, _ state: String?, answeredAt: String? = nil, failure: String? = nil) -> CCCallRecord {
        CCCallRecord(id: "c", direction: direction, state: state, answeredAt: answeredAt, failureReason: failure)
    }
    check(call("incoming", "ended").isMissedIncoming, "unanswered ended incoming is missed")
    check(call("incoming", "failed", answeredAt: "").isMissedIncoming, "empty answeredAt still missed")
    check(!call("incoming", "ended", answeredAt: "2026-09-20T02:00:05Z").isMissedIncoming, "answered is not missed")
    check(!call("incoming", "failed", failure: "number_blocked").isMissedIncoming, "blocked is not missed")
    check(!call("outgoing", "failed").isMissedIncoming, "outgoing is not missed")
    check(!call("incoming", "incoming_ringing").isMissedIncoming, "still ringing is not missed")
    check(!call("incoming", nil).isMissedIncoming, "unknown state is not missed")

    // S67 optimistic −1 guess: missed or AI-answered incoming, never blocked / human-answered / outgoing.
    var ai = call("incoming", "ended", answeredAt: "2026-09-20T02:00:05Z"); ai.aiHandling = true
    var busyAI = call("incoming", "ended", answeredAt: "2026-09-20T02:00:05Z"); busyAI.conflictDisposition = "ai_answered"
    var blockedAI = call("incoming", "failed", failure: "number_blocked"); blockedAI.aiHandling = true
    check(call("incoming", "ended").isBadgeCandidate, "missed counts")
    check(ai.isBadgeCandidate && busyAI.isBadgeCandidate, "AI / busy-AI answered counts")
    check(!call("incoming", "ended", answeredAt: "2026-09-20T02:00:05Z").isBadgeCandidate, "human-answered does not count")
    check(!blockedAI.isBadgeCandidate, "blocked does not count")
    check(!call("outgoing", "failed").isBadgeCandidate, "outgoing does not count")

    // S67c row dot: server `unseen`, missing → no dot, hidden once opened this session.
    let decoded = try! JSONDecoder().decode([CCCallRecord].self, from: Data(#"[{"id":"u","unseen":true},{"id":"n"}]"#.utf8))
    check(decoded[0].showsUnseenDot(seen: []) && !decoded[1].showsUnseenDot(seen: []), "unseen decodes, missing → false")
    check(!decoded[0].showsUnseenDot(seen: ["u"]), "opened this session hides the dot")
    let reports = try! JSONDecoder().decode([CCReportItem].self, from: Data(#"[{"callId":"r","unseen":true},{"callId":"m"}]"#.utf8))
    check(reports[0].showsUnseenDot(seen: []) && !reports[1].showsUnseenDot(seen: []), "report unseen decodes, missing → false")
    check(!reports[0].showsUnseenDot(seen: ["r"]), "opened report hides the dot")
    check(reports[0].asCallRecord.unseen == true, "report select passes unseen as pending")

    check(CCSimItem(id: "s", label: "工作", phoneLabel: " +8613800000000 ", slotIndex: 0, gatewayId: "abcdef0123456789",
                    gatewayKind: "dji4g").lineText == "+8613800000000 · DJI 4G · abcdef01", "phoneLabel + dji4g gateway")
    check(CCSimItem(id: "s", label: "工作", phoneLabel: "", slotIndex: 0, gatewayId: "abcdef0123456789").lineText
          == "工作 · Pixel · abcdef01", "label fallback, missing kind → Pixel")
    check(CCSimItem(id: "s", slotIndex: 1).lineText == "SIM 2", "no gateway → title only")
    let sims = try CCRecords.decode(CCSimList.self, from: json(#"{"items":[{"id":"s","phoneLabel":"+1","gatewayId":"g1","gatewayKind":"pixel"}]}"#))
    check(sims.items[0].lineText == "+1 · Pixel · g1", "sim list decodes gateway fields")
} catch { check(false, "sim decode threw \(error)") }

// S72 internal calls, device answer, occupancy.
do {
    let legs = try CCRecords.decode(CCCallsPage.self, from: json(#"{"items":[{"id":"i","direction":"incoming","state":"ended","internal":true,"peerSimId":"p","peerSimLabel":"联通186"},{"id":"o","direction":"outgoing","internal":true,"peerSimLabel":"电信133"},{"id":"a","direction":"incoming","state":"active","answeredByPlatform":"device","answeredAt":"2026-09-26T03:04:00Z","gatewayTimeZone":"Asia/Shanghai"}]}"#))
    let r1 = CCRecordLabels.internalRoute(legs.items[0], ownSIM: "电信133")
    check(r1?.from == "联通186" && r1?.to == "电信133", "incoming leg: peer → own")
    let r2 = CCRecordLabels.internalRoute(legs.items[1], ownSIM: "联通186")
    check(r2?.from == "联通186" && r2?.to == "电信133", "outgoing leg: own → peer")
    check(CCRecordLabels.internalRoute(legs.items[2], ownSIM: "x") == nil, "external → nil")
    check(!legs.items[0].isMissedIncoming, "internal leg is never a missed call")
    check(CCRecordLabels.platform("device") == "网关本机", "device → 网关本机")
    let occ = CCRecordLabels.occupancy(legs.items[2])
    check(occ?.owner.text == "网关本机" && occ?.since == "11:04", "occupancy owner + HH:mm in gateway zone")
    check(CCRecordLabels.occupancy(legs.items[0]) == nil, "ended → no occupancy")
    let report = try CCRecords.decode([CCReportItem].self, from: json(#"[{"callId":"r","internal":true,"peerSimLabel":"A"}]"#))
    check(report[0].asCallRecord.internal == true && report[0].asCallRecord.peerSimLabel == "A", "report carries internal fields")
} catch { check(false, "S72 decode threw \(error)") }

print("VoDogRecordsSelfTests passed")
