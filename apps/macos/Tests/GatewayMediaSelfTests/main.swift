import AVFoundation
import COpus
import Foundation

// Assert-based checks for the gateway media/recording pure logic. Run via
// scripts/run_gateway_media_tests.sh; set GATEWAY_ARCHIVE_VALIDATOR to the Go
// services/recording-archive-validator binary to also validate the produced archive objects.

func check(_ condition: @autoclosure () -> Bool, _ message: String, file: StaticString = #file, line: UInt = #line) {
    if !condition() {
        FileHandle.standardError.write(Data("FAIL \(message) (\(file):\(line))\n".utf8))
        exit(1)
    }
}

func sine(_ hz: Double, rate: Double, count: Int, amplitude: Double = 8000, phase: Int = 0) -> [Int16] {
    (0 ..< count).map { Int16(amplitude * sin(2 * .pi * hz * Double($0 + phase) / rate)) }
}

func energy(_ x: ArraySlice<Int16>) -> Double { x.reduce(0) { $0 + Double($1) * Double($1) } }

// MARK: Packet framing (services/media/packet.go)

do {
    let opus = Data([0x48, 1, 2, 3]) // SILK WB 20 ms, code 0
    check(GatewayMediaPacket.opusDurationMs(opus) == 20, "TOC 0x48 is 20 ms")
    check(GatewayMediaPacket.opusDurationMs(Data([0x49, 0])) == 40, "code 1 doubles the frame")
    check(GatewayMediaPacket.opusDurationMs(Data([0x4b, 0x03])) == 60, "code 3 multiplies by the frame count")
    check(GatewayMediaPacket.opusDurationMs(Data([0x4b])) == nil, "truncated code 3 rejected")
    check(GatewayMediaPacket.opusDurationMs(Data([0x80])) == nil, "2.5 ms CELT rejected")

    let packet = GatewayMediaPacket(direction: 0, durationMs: 20, sequence: 0xfffffffe, timestampUs: 1_234_567, opus: opus)
    let wire = packet.encoded()
    check(wire.count == 16 + opus.count, "16-byte header")
    check([UInt8](wire.prefix(16)) == [1, 0, 0, 20, 0xff, 0xff, 0xff, 0xfe, 0, 0, 0, 0, 0, 0x12, 0xd6, 0x87], "big-endian header")
    check(GatewayMediaPacket(decoding: wire) == packet, "round trip")
    var mismatched = wire
    mismatched[3] = 40
    check(GatewayMediaPacket(decoding: mismatched) == nil, "header duration must match TOC")
    var badDirection = wire
    badDirection[1] = 2
    check(GatewayMediaPacket(decoding: badDirection) == nil, "direction > 1 rejected")
    check(GatewayMediaPacket(decoding: wire.prefix(16)) == nil, "empty Opus rejected")
    var negative = wire
    negative[8] = 0x80
    check(GatewayMediaPacket(decoding: negative) == nil, "timestamp beyond Int64 rejected")
}

// MARK: Resampler (recording only since S70: 63 taps)

do {
    check(GatewayHalfBandResampler.taps.count >= 63, "recording FIR has ≥ 63 taps")
    var up = GatewayHalfBandResampler()
    var down = GatewayHalfBandResampler()
    var original: [Int16] = []
    var roundTrip: [Int16] = []
    for frame in 0 ..< 50 {
        let x = sine(400, rate: 8000, count: 160, phase: frame * 160)
        let wide = up.upsample(x)
        check(wide.count == 320, "8k→16k doubles 160 → 320")
        let narrow = down.downsample(wide)
        check(narrow.count == 160, "16k→8k halves 320 → 160")
        original += x
        roundTrip += narrow
    }
    // Two 63-tap filters at 16 kHz: 62 samples of delay at 16 kHz = 31 at 8 kHz.
    let delay = 31
    let a = original[1000 ..< 7000]
    let b = roundTrip[(1000 + delay) ..< (7000 + delay)]
    let ratio = energy(b) / energy(a)
    check(ratio > 0.95 && ratio < 1.05, "round-trip energy preserved (\(ratio))")
    let error = zip(a, b).reduce(0.0) { $0 + pow(Double($1.0) - Double($1.1), 2) }
    check(error / energy(a) < 0.01, "round trip matches the delayed input (\(error / energy(a)))")

    var antiAlias = GatewayHalfBandResampler()
    let tone = antiAlias.downsample(sine(6000, rate: 16000, count: 3200))
    check(energy(tone[400...]) / energy(sine(6000, rate: 16000, count: 3200)[800...]) < 0.001, "6 kHz attenuated >30 dB before decimation")

    // Recording upsample length: 10/20/60 ms chunks at 8 kHz → exactly twice the samples.
    var rec = GatewayHalfBandResampler()
    for n in [80, 160, 480] { check(rec.upsample(sine(300, rate: 8000, count: n)).count == 2 * n, "upsample \(n) → \(2 * n)") }
}

// MARK: Playout policy (S70 网关播放策略), codec-agnostic

func pk(_ seq: UInt32, ms: UInt16 = 20, loud: Bool = true) -> GatewayMediaPacket {
    GatewayMediaPacket(direction: 1, durationMs: ms, sequence: seq, timestampUs: UInt64(seq) * UInt64(ms) * 1_000,
                       opus: Data([ms == 10 ? 0x40 : 0x48, loud ? 1 : 0]))
}

/// Fake decoder: packets decode to their duration at amplitude 3000 (loud) or 50 (quiet); FEC/PLC to 1.
func fakeDecode(_ source: GatewayPlayout.Source) -> [Int16] {
    switch source {
    case let .packet(p): return [Int16](repeating: p.opus[p.opus.startIndex + 1] == 1 ? 3000 : 50, count: Int(p.durationMs) * 8)
    case let .fec(_, ms), let .plc(ms): return [Int16](repeating: 1, count: ms * 8)
    }
}

do {
    var p = GatewayPlayout()
    p.insert(pk(1)); p.insert(pk(0))
    var r = p.tick(fakeDecode)
    check(r.kind == .priming && r.frame.allSatisfy { $0 == 0 } && p.zeroFillFrames == 0, "40 ms < T: priming silence, not zero-fill")
    p.insert(pk(2))
    r = p.tick(fakeDecode)
    check(r.kind == .audio && r.frame.count == 160 && r.chunks.first?.source == .packet(pk(0)), "primed at 60 ms, oldest first")
    check(p.reordered == 1, "seq 0 after 1 counted as reordered")
    p.insert(pk(0)); p.insert(pk(2))
    check(p.late == 1 && p.duplicate == 1, "late + duplicate dropped")
    p.insert(pk(4)); p.insert(pk(6)); p.insert(pk(7))
    _ = p.tick(fakeDecode) // 1
    _ = p.tick(fakeDecode) // 2
    r = p.tick(fakeDecode) // 3 missing, 4 buffered → FEC from 4
    check(r.chunks.first?.source == .fec(next: pk(4), durationMs: 20) && p.fecFrames == 1 && p.lost == 1, "gap with successor → FEC(next)")
    _ = p.tick(fakeDecode) // 4
    r = p.tick(fakeDecode) // 5 missing, 6 buffered → FEC; 7 buffered
    check(p.fecFrames == 2, "second FEC")
    _ = p.tick(fakeDecode) // 6
    _ = p.tick(fakeDecode) // 7
    // Empty: 3 PLC ticks, then zeros; re-prime after 10 dry ticks.
    var kinds: [GatewayPlayout.TickKind] = []
    for _ in 0 ..< 12 { kinds.append(p.tick(fakeDecode).kind) }
    check(Array(kinds.prefix(3)) == [.plc, .plc, .plc] && kinds[3 ..< 10].allSatisfy { $0 == .zero }, "PLC ≤ 3 ticks then zeros: \(kinds)")
    check(kinds[10] == .priming && p.zeroFillFrames == 9, "re-primes after 200 ms dry (\(p.zeroFillFrames))")
    // A packet arriving during the short dry spell resumes without a re-prime.
    var q = GatewayPlayout()
    for s: UInt32 in 0 ..< 3 { q.insert(pk(s)) }
    for _ in 0 ..< 4 { _ = q.tick(fakeDecode) }
    q.insert(pk(3))
    check(q.tick(fakeDecode).chunks.first?.source == .packet(pk(3)) && q.late == 0, "late-in-time packet plays after one PLC")

    // 10 ms (Voice worker) and 60 ms packets both fill 20 ms ticks.
    var mixed = GatewayPlayout()
    for s: UInt32 in 0 ..< 8 { mixed.insert(pk(s, ms: 10)) }
    for _ in 0 ..< 4 { check(mixed.tick(fakeDecode).chunks.count == 2, "two 10 ms packets per tick") }

    // Forced catch-up: a 600 ms burst on top of T is decoded and dropped down to ≤ T+60.
    var burst = GatewayPlayout()
    for s: UInt32 in 0 ..< 3 { burst.insert(pk(s)) }
    _ = burst.tick(fakeDecode)
    for s: UInt32 in 3 ..< 33 { burst.insert(pk(s)) }
    _ = burst.tick(fakeDecode)
    _ = burst.tick(fakeDecode)
    check(burst.forcedDrops > 0 && burst.lastDepthUs <= 120_000, "forced catch-up to ≤ T+60 (\(burst.forcedDrops), \(burst.lastDepthUs))")
    check(burst.lost == 0, "forced drops are not transport losses")

    // S70c: an AI leg rides out a 500 ms burst of speech (no forced drops below T+1000), then
    // catches up on the quiet frames that follow.
    for ai in [true, false] {
        let p = GatewayPlayout.forAnsweredByAi(ai)
        check(p.capacityUs >= p.targetUs + p.forcedCatchUpUs + 500_000, "capacity holds forced threshold + 500 ms burst (ai \(ai))")
    }
    check(GatewayPlayout.forAnsweredByAi(false).forcedCatchUpUs == 300_000 && GatewayPlayout.forAnsweredByAi(true).targetUs == 200_000,
          "human forced at T+300, AI T=200")
    var aiBurst = GatewayPlayout.forAnsweredByAi(true)
    var aiSeq: UInt32 = 0
    for _ in 0 ..< 10 { aiBurst.insert(pk(aiSeq)); aiSeq += 1 }
    _ = aiBurst.tick(fakeDecode)
    for _ in 0 ..< 25 { aiBurst.insert(pk(aiSeq)); aiSeq += 1 }   // 500 ms burst of loud frames
    for _ in 0 ..< 100 {
        _ = aiBurst.tick(fakeDecode)
        aiBurst.insert(pk(aiSeq)); aiSeq += 1
    }
    check(aiBurst.forcedDrops == 0 && aiBurst.quietDrops == 0 && aiBurst.lastDepthUs > 500_000,
          "AI: loud 500 ms burst plays in full (forced \(aiBurst.forcedDrops), quiet \(aiBurst.quietDrops), depth \(aiBurst.lastDepthUs))")
    for _ in 0 ..< 200 {
        _ = aiBurst.tick(fakeDecode)
        aiBurst.insert(pk(aiSeq, loud: false)); aiSeq += 1
    }
    check(aiBurst.forcedDrops == 0 && aiBurst.quietDrops > 0 && aiBurst.lastDepthUs <= 260_000,
          "AI: quiet frames catch up (quiet \(aiBurst.quietDrops), depth \(aiBurst.lastDepthUs))")
    // The same burst forces drops on a human leg.
    var humanBurst = GatewayPlayout.forAnsweredByAi(false)
    for s: UInt32 in 0 ..< 3 { humanBurst.insert(pk(s)) }
    _ = humanBurst.tick(fakeDecode)
    for s: UInt32 in 3 ..< 28 { humanBurst.insert(pk(s)) }
    _ = humanBurst.tick(fakeDecode); _ = humanBurst.tick(fakeDecode)
    check(humanBurst.forcedDrops > 0, "human: 500 ms burst forces catch-up (\(humanBurst.forcedDrops))")

    // Quiet catch-up: 100 ms over target for > 1 s drops only quiet frames.
    var quiet = GatewayPlayout()
    var seq: UInt32 = 0
    for _ in 0 ..< 10 { quiet.insert(pk(seq, loud: seq % 4 != 0)); seq += 1 }
    for _ in 0 ..< 200 {
        _ = quiet.tick(fakeDecode)
        quiet.insert(pk(seq, loud: seq % 4 != 0)); seq += 1
    }
    check(quiet.quietDrops > 0 && quiet.forcedDrops == 0 && quiet.lastDepthUs <= 120_000,
          "quiet frames dropped until ≤ T+60 (\(quiet.quietDrops), \(quiet.lastDepthUs))")

    // Over capacity the oldest packet goes.
    var cap = GatewayPlayout(targetUs: 60_000, capacityUs: 100_000)
    for s: UInt32 in 0 ..< 7 { cap.insert(pk(s)) }
    check(cap.overflow == 2 && cap.tick(fakeDecode).chunks.first?.source == .packet(pk(2)), "oldest dropped over capacity")
}

// MARK: S73 leg rejoin: playout stream reset (D4) and rejoin budget (D3)

do {
    func primeAndPlay(_ p: inout GatewayPlayout, _ seqs: [UInt32]) { for s in seqs { p.insert(pk(s)) }; for _ in seqs { _ = p.tick(fakeDecode) } }
    // Forward jump > 50 (outage on a bridge with room-level seq): re-prime from the new packet,
    // no 50-frame PLC walk, no loss counted.
    var fwd = GatewayPlayout()
    primeAndPlay(&fwd, Array(0 ..< 6))
    let lostBefore = fwd.lost
    fwd.insert(pk(4)) // late, old stream
    for s: UInt32 in 100 ..< 103 { fwd.insert(pk(s)) }
    let r = fwd.tick(fakeDecode)
    check(fwd.streamResets == 1 && fwd.lost == lostBefore && r.chunks.contains { $0.source == .packet(pk(100)) } && fwd.plcFrames < 5,
          "jump > 50 re-primes from the new stream (resets \(fwd.streamResets), lost \(fwd.lost), plc \(fwd.plcFrames))")
    // Backward jump (bridge restarted its counter): not swallowed as late.
    var back = GatewayPlayout()
    primeAndPlay(&back, Array(5_000 ..< 5_006))
    for s: UInt32 in 0 ..< 3 { back.insert(pk(s)) }
    check(back.late == 0 && back.streamResets == 1 && back.tick(fakeDecode).chunks.contains { $0.source == .packet(pk(0)) },
          "restart at 0 plays, not late (late \(back.late))")
    // Small gap (≤ 50) is loss, not a reset.
    var gap = GatewayPlayout()
    primeAndPlay(&gap, Array(0 ..< 6))
    gap.insert(pk(40))
    check(gap.streamResets == 0, "gap of 34 is not a stream reset")
    // New leg's first packet resets even with a continuous sequence and drops the old leg's buffer.
    var leg = GatewayPlayout()
    for s: UInt32 in 0 ..< 6 { leg.insert(pk(s)) }
    _ = leg.tick(fakeDecode)
    leg.resetOnNextPacket()
    for s: UInt32 in 6 ..< 9 { leg.insert(pk(s)) }
    let legTick = leg.tick(fakeDecode)
    check(leg.streamResets == 1 && legTick.chunks.contains { $0.source == .packet(pk(6)) } && !legTick.chunks.contains { $0.source == .packet(pk(3)) },
          "new leg: re-primed from its first packet, old buffer dropped")
    leg.insert(pk(9))
    check(leg.streamResets == 1, "reset is one-shot")

    // Rejoin budget.
    let t0 = Date(timeIntervalSince1970: 1_000)
    var policy = GatewayRejoinPolicy(lostAt: t0, transport: "udp")
    let a1 = policy.next(now: t0)
    check(a1?.attempt == 1 && a1?.transport == "udp" && a1?.startAt == t0 && a1?.deadline == t0 + 20, "attempt 1: same transport, now")
    let a2 = policy.next(now: t0 + 1) // failed fast: network still down
    check(a2?.attempt == 2 && a2?.transport == "tls" && a2?.startAt == t0 + 15, "attempt 2: other transport, ≥ 15 s after attempt 1")
    let a3 = policy.next(now: t0 + 16, afterConflict: true)
    check(a3?.attempt == 3 && a3?.transport == "tls" && a3?.startAt == t0 + 18, "conflict: 2 s backoff, counts")
    check(policy.next(now: t0 + 19) == nil, "no fourth attempt")
    var late = GatewayRejoinPolicy(lostAt: t0, transport: "tls")
    _ = late.next(now: t0)
    let lateStep = late.next(now: t0 + 50)
    check(lateStep?.transport == "udp" && lateStep?.deadline == t0 + 60, "attempt deadline clipped to the 60 s window")
    check(late.next(now: t0 + 59) == nil, "no attempt starting past the window")
    check(GatewayRejoinPolicy.isConflict(status: 409, code: nil) && GatewayRejoinPolicy.isConflict(status: 503, code: "MEDIA_BRIDGE_UNAVAILABLE")
          && !GatewayRejoinPolicy.isConflict(status: 503, code: "OTHER"), "409 / proxied 503 MEDIA_BRIDGE_UNAVAILABLE = conflict")
    check(GatewayRejoinPolicy.isFatal(status: 403, code: "MEDIA_REVOKED") && GatewayRejoinPolicy.isFatal(status: 404, code: nil)
          && !GatewayRejoinPolicy.isFatal(status: 409, code: "X") && !GatewayRejoinPolicy.isFatal(status: 503, code: nil),
          "other 4xx stop the rejoin; 409 and 5xx do not")

    // S73b: offline failures are refunded and retried at once, still inside the window.
    var net = GatewayRejoinPolicy(lostAt: t0, transport: "udp")
    _ = net.next(now: t0)
    let r1 = net.next(now: t0 + 30, afterOffline: true)
    check(r1?.attempt == 1 && r1?.transport == "udp" && r1?.startAt == t0 + 30, "offline attempt 1 refunded: same attempt, starts on path return")
    let r2 = net.next(now: t0 + 31)
    check(r2?.attempt == 2 && r2?.startAt == t0 + 45, "online failure counts and keeps the 15 s spacing")
    let r3 = net.next(now: t0 + 46, afterOffline: true)
    check(r3?.attempt == 2 && r3?.transport == "tls" && r3?.startAt == t0 + 46, "offline attempt 2 refunded")
    check(net.next(now: t0 + 50, afterConflict: true)?.attempt == 3 && net.next(now: t0 + 51, afterConflict: true) == nil,
          "three counted attempts still cap it")
    var offlineAll = GatewayRejoinPolicy(lostAt: t0, transport: "udp")
    _ = offlineAll.next(now: t0)
    check(offlineAll.next(now: t0 + 60, afterOffline: true) == nil && offlineAll.attempts == 1, "offline until the 60 s window ends → exhausted, attempt not refunded")

    // S73b: hang up a bridged call whose media failed for good, once, only when established.
    check(GatewayRejoinPolicy.hangsUpCall(active: true, alreadyRequested: false), "active + failed → hang up")
    check(!GatewayRejoinPolicy.hangsUpCall(active: true, alreadyRequested: true), "no double hangup")
    check(!GatewayRejoinPolicy.hangsUpCall(active: false, alreadyRequested: false), "not before active / while ending")
}

// Offline gate: ±100 ppm, 500 ms burst, 2 % loss, 20 simulated minutes, UAC batches of 512 samples.
func simulate(ppm: Double, targetUs: Int, minutes: Int = 20, ai: Bool = false) {
    var rng: UInt64 = 0x9e3779b97f4a7c15
    func random() -> Double {
        rng &+= 0x9e3779b97f4a7c15
        var z = rng
        z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
        z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
        return Double((z ^ (z >> 31)) >> 11) / Double(1 << 53)
    }
    let seconds = Double(minutes) * 60
    let burstStart = 600.0, burstEnd = 600.5
    // Arrivals: sender clock is nominal; network 40 ms + 0–30 ms jitter; 2 % loss; burst held.
    var arrivals: [(Double, GatewayMediaPacket)] = []
    for k in 0 ..< Int(seconds / 0.02) {
        let sent = Double(k) * 0.02
        guard random() >= 0.02 else { continue }
        var at = sent + 0.04 + random() * 0.03
        if sent >= burstStart && sent < burstEnd { at = burstEnd + 0.04 }
        arrivals.append((at, pk(UInt32(k), loud: (k / 100) % 3 != 0)))
    }
    arrivals.sort { $0.0 < $1.0 }
    var p = ai ? GatewayPlayout.forAnsweredByAi(true) : GatewayPlayout(targetUs: targetUs)
    var next = 0
    var modemSamples = 0
    var ticks = 0
    var dryRun = 0
    var minuteMean = [Double](repeating: 0, count: minutes)
    var minuteCount = [Int](repeating: 0, count: minutes)
    var afterBurst: [Int] = []
    var firstRecovered: Double?
    let rate = 8_000 * (1 + ppm / 1_000_000)
    while true {
        modemSamples += 512
        let now = Double(modemSamples) / rate
        if now >= seconds { break }
        while next < arrivals.count, arrivals[next].0 <= now { p.insert(arrivals[next].1); next += 1 }
        while (ticks + 1) * 160 <= modemSamples {
            ticks += 1
            let kind = p.tick(fakeDecode).kind
            if kind == .zero || (kind == .priming && ticks > 100) {
                check(dryRun >= 3, "zero-fill only after the buffer ran dry (ppm \(ppm), t \(now))")
            }
            dryRun = kind == .audio ? 0 : dryRun + 1
            let minute = min(minutes - 1, Int(now / 60))
            minuteMean[minute] += Double(p.troughDepthUs)
            minuteCount[minute] += 1
            if now > burstEnd + 0.04, firstRecovered == nil, p.troughDepthUs <= targetUs + 60_000 { firstRecovered = now - burstEnd - 0.04 }
            if now > burstEnd + 0.04 + 5, now < burstEnd + 60 { afterBurst.append(p.troughDepthUs) }
        }
    }
    let means = zip(minuteMean, minuteCount).map { $0 / Double(max(1, $1)) / 1_000 }
    let limitMs = Double(targetUs / 1_000 + 60)
    let afterP95 = afterBurst.sorted()[afterBurst.count * 95 / 100]
    check((firstRecovered ?? 99) <= 5, "ppm \(ppm) T \(targetUs / 1000): back to ≤ T+60 within 5 s of the burst (\(firstRecovered ?? -1) s)")
    check(afterP95 <= targetUs + 60_000, "ppm \(ppm) T \(targetUs / 1000): p95 depth 5–60 s after the burst ≤ T+60 (\(afterP95 / 1000) ms)")
    // Catch-up engages after 1 s above T+60, so a drifting clock saw-tooths up to just over it.
    check(means.allSatisfy { $0 <= limitMs + 20 }, "ppm \(ppm): per-minute mean depth bounded by T+80 (\(means.map { Int($0) }))")
    if ppm < 0 && minutes > 20 { check(p.quietDrops > 0, "slow modem clock is absorbed by quiet-frame drops") }
    check(minutes > 20 || p.depthP95Ms <= targetUs / 1_000 + 60, "ppm \(ppm): p95 \(p.depthP95Ms) ≤ T+60")
    print("simulate ppm \(Int(ppm)) T \(targetUs / 1000): recovered \(String(format: "%.2f", firstRecovered ?? -1)) s, p95 \(p.depthP95Ms) ms, underrun \(p.underrunTicks), zero \(p.zeroFillFrames), plc \(p.plcFrames), fec \(p.fecFrames), quiet \(p.quietDrops), forced \(p.forcedDrops), minutes \(means.map { Int($0) })")
}
simulate(ppm: 100, targetUs: 60_000)
simulate(ppm: -100, targetUs: 60_000)
simulate(ppm: -100, targetUs: 60_000, minutes: 40)
simulate(ppm: 100, targetUs: 200_000, ai: true)
simulate(ppm: -100, targetUs: 200_000, ai: true)

// MARK: Opus (libopus 1.6.1, 8 kHz)

/// Speech-like test signal: pitch and amplitude move every frame (PLC cannot just continue it).
func voice(_ frame: Int, rate: Int = 8_000) -> [Int16] {
    let f0 = 110.0 + Double((frame * 37) % 90)
    let amp = 2_000.0 + Double((frame * 53) % 7) * 900
    let n = rate / 50
    return (0 ..< n).map { i in
        let t = Double(frame * n + i) / Double(rate)
        return Int16((1 ... 6).reduce(0.0) { $0 + amp / Double($1) * sin(2 * .pi * f0 * Double($1) * t) })
    }
}

do {
    guard let codec = GatewayOpusCodec() else { check(false, "libopus codec available"); exit(1) }
    check(codec.encoderSetting(1) == 1 && codec.encoderSetting(2) == 12 && codec.encoderSetting(3) == 20_000, "FEC on, 12 % loss, 20 kbps")
    check(codec.encoderSetting(4) == 3001 && codec.encoderSetting(5) == 10, "SIGNAL_VOICE, complexity 10")
    check(codec.decoderComplexity == 5, "decoder complexity 5 = deep PLC (\(codec.decoderComplexity))")
    check(GatewayOpusCodec(decoderComplexity: 0)?.decoderComplexity == 0, "classic-PLC baseline decoder")
    var packets: [Data] = []
    for frame in 0 ..< 60 {
        guard let opus = codec.encode(voice(frame)) else { check(false, "encode produced a packet"); exit(1) }
        check(GatewayMediaPacket.opusDurationMs(opus) == 20, "encoded packet TOC says 20 ms")
        check(GatewayMediaPacket(decoding: GatewayMediaPacket(direction: 0, durationMs: 20, sequence: 0, timestampUs: 0, opus: opus).encoded()) != nil,
              "bridge would accept the packet")
        check(GatewayOpusCodec.bandwidthIndex(opus) == 0, "8 kHz input encodes narrowband")
        packets.append(opus)
    }
    let lbrr = packets.filter(GatewayOpusCodec.hasLbrr).count
    check(lbrr >= 50, "uplink packets carry LBRR (\(lbrr)/60)")

    // Three decoders over the same stream: lossless reference, FEC for one lost packet, PLC for it.
    // Averaged over several loss positions: a single frame of a stationary test signal favours PLC by chance.
    func lostFrames(_ lost: Int) -> (ref: [Int16], fec: [Int16], plc: [Int16], fecRecovered: Int, plcRecovered: Int) {
        let ref = GatewayOpusCodec()!, fec = GatewayOpusCodec()!, plc = GatewayOpusCodec()!
        var refFrame: [Int16] = [], fecFrame: [Int16] = [], plcFrame: [Int16] = []
        for (i, opus) in packets.enumerated() {
            let packet = GatewayMediaPacket(direction: 1, durationMs: 20, sequence: UInt32(i), timestampUs: 0, opus: opus)
            let r = ref.decode(.packet(packet))
            check(r.count == 160, "decode yields 160 samples at 8 kHz")
            if i == lost {
                refFrame = r
                fecFrame = fec.decode(.fec(next: GatewayMediaPacket(direction: 1, durationMs: 20, sequence: UInt32(lost + 1), timestampUs: 0, opus: packets[lost + 1]), durationMs: 20))
                plcFrame = plc.decode(.plc(durationMs: 20))
            } else {
                _ = fec.decode(.packet(packet))
                _ = plc.decode(.packet(packet))
            }
        }
        return (refFrame, fecFrame, plcFrame, fec.fecRecovered, plc.fecRecovered)
    }
    // Log-spectral distance (dB) to the lossless decode: waveform error punishes phase, not pitch.
    func spectrum(_ x: [Int16]) -> [Double] {
        (1 ..< 80).map { k in
            var re = 0.0, im = 0.0
            for (n, v) in x.enumerated() { re += Double(v) * cos(2 * .pi * Double(k * n) / 160); im -= Double(v) * sin(2 * .pi * Double(k * n) / 160) }
            return 10 * log10(re * re + im * im + 1)
        }
    }
    func err(_ x: [Int16], _ refFrame: [Int16]) -> Double {
        let a = spectrum(x), b = spectrum(refFrame)
        return (zip(a, b).reduce(0.0) { $0 + pow($1.0 - $1.1, 2) } / Double(a.count)).squareRoot()
    }
    var fecErr = 0.0, plcErr = 0.0
    let positions = stride(from: 10, through: 50, by: 5).filter { GatewayOpusCodec.hasLbrr(packets[$0 + 1]) }
    check(positions.count >= 6, "enough loss positions whose next packet carries LBRR (\(positions.count))")
    for lost in positions {
        let r = lostFrames(lost)
        check(r.fec.count == 160 && r.plc.count == 160 && energy(r.plc[...]) > 0, "FEC and PLC frames sized 20 ms")
        check(r.fecRecovered == 1 && r.plcRecovered == 0, "FEC recovery counted only when LBRR was present")
        fecErr += err(r.fec, r.ref) / Double(positions.count)
        plcErr += err(r.plc, r.ref) / Double(positions.count)
    }
    check(fecErr < plcErr, "FEC recovers lost frames better than PLC on average (fec \(fecErr), plc \(plcErr))")

    // S70f deep PLC (complexity 5) vs classic (0), decoded at 8 kHz — the Pixel opus_loss_harness "plc"
    // mode: its 137 Hz syllable signal, seeded random loss, PLC only, mean log-spectral error of voiced
    // concealed frames vs the lossless decode. NB SILK (our 8 kHz uplink shape) never runs LPCNet
    // (silk/PLC.c needs fs_kHz 16) so it must equal classic; WB (browser/bridge shape) uses it.
    func harnessSignal(rate: Int, frames: Int) -> [[Int16]] {
        var noise: UInt32 = 0x4f50_5553
        let n = rate / 50
        let samples: [Int16] = (0 ..< frames * n).map { i in
            noise = noise &* 1_664_525 &+ 1_013_904_223
            let t = Double(i) / Double(rate)
            let syllable = 0.25 + 0.75 * pow(sin(.pi * 2.7 * t), 2)
            let voiced = sin(2 * .pi * 137 * t) * 0.58 + sin(2 * .pi * 274 * t) * 0.24 + sin(2 * .pi * 733 * t) * 0.10
            let hiss = (Double(Int32(noise >> 16)) - 32_768) / 32_768 * 0.03
            return Int16(max(-32_768, min(32_767, (voiced * syllable + hiss) * 18_000)))
        }
        return stride(from: 0, to: samples.count, by: n).map { Array(samples[$0 ..< $0 + n]) }
    }
    func concealErr(_ stream: [Data], complexity: Int32, lossPercent: UInt32) -> Double {
        var state: UInt32 = 0x4f50_5553, total = 0.0, counted = 0
        let ref = GatewayOpusCodec()!, dec = GatewayOpusCodec(decoderComplexity: complexity)!
        for (i, opus) in stream.enumerated() {
            state = state &* 1_664_525 &+ 1_013_904_223
            let p = GatewayMediaPacket(direction: 1, durationMs: 20, sequence: UInt32(i), timestampUs: 0, opus: opus)
            let r = ref.decode(.packet(p))
            guard i > 0, (state >> 8) % 1000 < lossPercent * 10 else { _ = dec.decode(.packet(p)); continue }
            let c = dec.decode(.plc(durationMs: 20))
            check(c.count == 160, "concealed frame is 160 samples at 8 kHz")
            if energy(r[...]) >= 160 * 500 * 500 { total += err(c, r); counted += 1 } // RMS >= 500: silence is trivially right
        }
        return total / Double(max(counted, 1))
    }
    var status: Int32 = 0
    let wbEncoder = opus_encoder_create(16_000, 1, OPUS_APPLICATION_VOIP, &status)!
    let wbPackets: [Data] = harnessSignal(rate: 16_000, frames: 180).map { pcm in
        var out = [UInt8](repeating: 0, count: 1_275)
        let n = opus_encode(wbEncoder, pcm, 320, &out, Int32(out.count))
        return Data(out.prefix(Int(max(n, 0))))
    }
    opus_encoder_destroy(wbEncoder)
    // CELT-only (RESTRICTED_LOWDELAY) also feeds LPCNet (celt_decoder.c, any Fs but 96 kHz): conceal at 8 kHz.
    let celtEncoder = opus_encoder_create(16_000, 1, OPUS_APPLICATION_RESTRICTED_LOWDELAY, &status)!
    let celtDecoder = GatewayOpusCodec()!
    for (i, pcm) in harnessSignal(rate: 16_000, frames: 40).enumerated() {
        var out = [UInt8](repeating: 0, count: 1_275)
        let n = opus_encode(celtEncoder, pcm, 320, &out, Int32(out.count))
        let p = GatewayMediaPacket(direction: 1, durationMs: 20, sequence: UInt32(i), timestampUs: 0, opus: Data(out.prefix(Int(max(n, 0)))))
        let c = celtDecoder.decode(i % 4 == 3 ? .plc(durationMs: 20) : .packet(p))
        check(c.count == 160 && (i % 4 != 3 || energy(c[...]) > 0), "CELT deep PLC at 8 kHz yields 160 samples")
    }
    opus_encoder_destroy(celtEncoder)
    let nbPackets = harnessSignal(rate: 8_000, frames: 180).compactMap { codec.encode($0) }
    check(wbPackets.allSatisfy { GatewayOpusCodec.bandwidthIndex($0) == 2 } && nbPackets.count == 180, "16 kHz input encodes WB, 8 kHz NB")
    for (name, stream) in [("nb", nbPackets), ("wb", wbPackets)] {
        for loss: UInt32 in [5, 10, 20] {
            let classic = concealErr(stream, complexity: 0, lossPercent: loss), deep = concealErr(stream, complexity: 5, lossPercent: loss)
            check(deep <= classic + 0.05, "\(name) \(loss) % loss: deep PLC no worse than classic (deep \(deep), classic \(classic))")
            print("opus plc \(name) \(loss)% loss: classic \(String(format: "%.3f", classic)) deep \(String(format: "%.3f", deep)) dB")
        }
    }
    print("opus: lbrr \(lbrr)/60, lost-frame error fec \(String(format: "%.3f", fecErr)) plc \(String(format: "%.3f", plcErr)), bytes avg \(packets.map(\.count).reduce(0, +) / packets.count)")

    // 10 ms WB packets from a 16 kHz browser-like encoder decode straight to 8 kHz.
    var description = AudioStreamBasicDescription(mSampleRate: 16000, mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
                                                  mFramesPerPacket: 160, mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
    let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    let encoder10 = AVAudioConverter(from: pcmFormat, to: AVAudioFormat(streamDescription: &description)!)!
    let wbDecoder = GatewayOpusCodec()!
    for frame in 0 ..< 5 {
        let input = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: 160)!
        input.frameLength = 160
        for (i, v) in sine(440, rate: 16000, count: 160, phase: frame * 160).enumerated() { input.int16ChannelData![0][i] = v }
        let out = AVAudioCompressedBuffer(format: encoder10.outputFormat, packetCapacity: 1, maximumPacketSize: 1024)
        var fed = false
        _ = encoder10.convert(to: out, error: nil) { _, state in
            if fed { state.pointee = .noDataNow; return nil }
            fed = true; state.pointee = .haveData; return input
        }
        let opus = Data(bytes: out.data, count: Int(out.byteLength))
        check(GatewayMediaPacket.opusDurationMs(opus) == 10, "10 ms TOC")
        let decoded = wbDecoder.decode(.packet(GatewayMediaPacket(direction: 1, durationMs: 10, sequence: UInt32(frame), timestampUs: 0, opus: opus)))
        check(decoded.count == 80, "10 ms packet decodes to 80 samples at 8 kHz (\(decoded.count))")
        check(GatewayOpusCodec.bandwidthIndex(opus) != nil, "bandwidth readable")
    }
}

// MARK: canonical JSON / gzip

do {
    let json = String(decoding: try canonicalJSON(["b": 1, "a": ["d": "x/y", "c": true, "B": [NSNull(), 0, false]], "A": "é\"\n"]), as: UTF8.self)
    check(json == #"{"A":"é\"\n","a":{"B":[null,0,false],"c":true,"d":"x/y"},"b":1}"#, "canonical JSON = JS canonical: \(json)")
    check(isoMillis(Date(timeIntervalSince1970: 1.5)) == "1970-01-01T00:00:01.500Z", "toISOString form")

    let temp = FileManager.default.temporaryDirectory.appendingPathComponent("gateway-gzip-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temp) }
    let source = temp.appendingPathComponent("in.bin")
    var bytes = Data()
    for i in 0 ..< 300_000 { bytes.append(UInt8(truncatingIfNeeded: i * 7 + i / 13)) }
    try bytes.write(to: source)
    try GatewayDeterministicGzip.compress(source, to: temp.appendingPathComponent("a.gz"))
    try GatewayDeterministicGzip.compress(source, to: temp.appendingPathComponent("b.gz"))
    let a = try Data(contentsOf: temp.appendingPathComponent("a.gz"))
    let b = try Data(contentsOf: temp.appendingPathComponent("b.gz"))
    check(a == b, "gzip bytes stable")
    check([UInt8](a.prefix(10)) == [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff], "fixed gzip header")
    let gunzip = Process()
    gunzip.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
    gunzip.arguments = ["-dc", temp.appendingPathComponent("a.gz").path]
    let pipe = Pipe()
    gunzip.standardOutput = pipe
    try gunzip.run()
    let out = pipe.fileHandleForReading.readDataToEndOfFile()
    gunzip.waitUntilExit()
    check(gunzip.terminationStatus == 0 && out == bytes, "gzip -dc restores the input")
}

// MARK: Recorder → archive objects (+ Go validator when available)

do {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("gateway-archive-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let callId = UUID().uuidString.lowercased()
    let binding: [String: Any] = [
        "id": UUID().uuidString.lowercased(), "callId": callId, "deviceCallId": "dji4g-1a2b-1758700000000",
        "telecomCreationTimeMillis": 1_758_700_000_000, "captureGeneration": 3, "mediaNodeId": "media-node-a",
        "mediaEpoch": 1, "createdAt": "2026-09-24T00:00:00.000Z",
    ]
    let recorder = try GatewayCallRecorder(root: root, callId: callId, binding: binding)
    let frame = sine(300, rate: 16000, count: 320)
    for i in 0 ..< 10 {
        let t = Int64(i) * 20_000
        recorder.append("remote_original", frame, timestampUs: t, sourceTimestampUs: nil)
        if i == 4 {
            recorder.appendPlayout(frame, timestampUs: t, sourceTimestampUs: nil, recoveryKind: "plc")
        } else if i >= 2 {
            recorder.append("caller_original", frame, timestampUs: t, sourceTimestampUs: Int64(i) * 20_000 + 7)
            recorder.appendPlayout(frame, timestampUs: t, sourceTimestampUs: Int64(i) * 20_000 + 7, recoveryKind: nil)
        }
    }
    recorder.markDropped("caller_original", timestampUs: 200_000, frames: 2)
    try recorder.finish(terminalState: "ended", mediaFatal: false, stats: ["networkSendDrops": 1, "transportMissingPackets": 1])

    let directory = root.appendingPathComponent(callId)
    let wav = try Data(contentsOf: directory.appendingPathComponent("remote_original.wav"))
    check(wav.count == 44 + 10 * 640, "remote WAV size")
    func le32(_ o: Int) -> UInt32 { wav[o ..< o + 4].enumerated().reduce(0) { $0 | UInt32($1.element) << (8 * $1.offset) } }
    check(String(decoding: wav[0 ..< 4], as: UTF8.self) == "RIFF" && le32(4) == UInt32(wav.count - 8), "RIFF size")
    check(le32(24) == 16000 && le32(28) == 32000 && wav[22] == 1 && wav[34] == 16 && le32(40) == 6400, "16 kHz mono 16-bit header")

    let timeline = try String(contentsOf: directory.appendingPathComponent("timeline.jsonl"), encoding: .utf8)
    let events = timeline.split(separator: "\n").map { try! JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    check(events.first?["event"] as? String == "start" && events.last?["state"] as? String == "ended", "start … stop")
    check(events.contains { $0["event"] as? String == "gap" && $0["track"] as? String == "caller_original" && $0["durationUs"] as? Int == 20_000 },
          "missing caller frame becomes a durationUs gap")
    check(events.contains { $0["recoveryKind"] as? String == "plc" }, "PLC playout labelled")
    check(events.filter { $0["event"] as? String == "frame" }.allSatisfy { $0.keys.contains("sourceTimestampUs") }, "sourceTimestampUs always present")

    let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("manifest.json"))) as! [String: Any]
    let caller = (manifest["tracks"] as! [String: Any])["caller_original"] as! [String: Any]
    check(manifest["version"] as? Int == 3 && caller["captureComplete"] as? Bool == false && caller["droppedFrames"] as? Int == 2,
          "local manifest v3, caller capture incomplete")

    let journal = try GatewayRecordingArchive.prepare(directory: directory, capture: binding)
    let uploadBytes = try Data(contentsOf: directory.appendingPathComponent("manifest.upload.json"))
    check(journal.manifestSha256 == sha256Hex(uploadBytes), "fingerprint = sha256 of the exact upload bytes")
    let recanonical = try canonicalJSON(try JSONSerialization.jsonObject(with: uploadBytes))
    check(recanonical == uploadBytes, "upload manifest is canonical")
    let upload = try JSONSerialization.jsonObject(with: uploadBytes) as! [String: Any]
    check(Set(upload.keys) == ["version", "captureBinding", "startedAt", "endedAt", "terminalState", "tracks", "derivedTracks", "timeline", "sessionStats"],
          "strict manifest keys")
    check(Set((upload["captureBinding"] as! [String: Any]).keys) == ["id", "deviceCallId", "telecomCreationTimeMillis", "captureGeneration"],
          "captureBinding carries exactly four fields")
    check((upload["startedAt"] as! String).hasSuffix("Z") && (upload["startedAt"] as! String).count == 24, "startedAt toISOString form")
    for track in upload["tracks"] as! [[String: Any]] {
        check(track["originalBytes"] as! Int == (track["pcmBytes"] as! Int) + 44, "originalBytes = pcmBytes + 44")
    }
    check(Set(journal.objects.map(\.name)) == ["remote_original.wav.gz", "caller_original.wav.gz", "caller_playout.wav.gz", "timeline.jsonl.gz"],
          "v3 object set")

    if let validator = ProcessInfo.processInfo.environment["GATEWAY_ARCHIVE_VALIDATOR"], !validator.isEmpty {
        let size = { (name: String) in (try! FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(name).path)[.size] as! NSNumber).stringValue }
        func validate(_ object: String, _ extra: [String]) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: validator)
            process.arguments = ["-root", directory.path, "-input", directory.appendingPathComponent(object).path,
                                 "-output", directory.appendingPathComponent(object + ".verified").path, "-max-output", "600000000"] + extra
            let err = Pipe()
            process.standardError = err
            process.standardOutput = Pipe()
            try! process.run()
            process.waitUntilExit()
            let message = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            check(process.terminationStatus == 0, "validator accepts \(object): \(message)")
        }
        for name in ["remote_original", "caller_original", "caller_playout"] { validate("\(name).wav.gz", ["-kind", "wav"]) }
        validate("timeline.jsonl.gz", ["-kind", "timeline", "-remote-bytes", size("remote_original.wav"),
                                       "-caller-bytes", size("caller_original.wav"), "-playout-bytes", size("caller_playout.wav")])
        print("validator: archive objects accepted")
    }

    // Crash recovery: a directory whose writer died keeps its .part files.
    let crashed = UUID().uuidString.lowercased()
    var crashedBinding = binding
    crashedBinding["callId"] = crashed
    let dying = try GatewayCallRecorder(root: root, callId: crashed, binding: crashedBinding)
    dying.append("remote_original", frame, timestampUs: 0, sourceTimestampUs: nil)
    let crashedDirectory = root.appendingPathComponent(crashed)
    let handle = try FileHandle(forWritingTo: crashedDirectory.appendingPathComponent("timeline.jsonl.part"))
    try handle.seekToEnd()
    handle.write(Data(#"{"event":"fra"#.utf8)) // torn last line
    try handle.close()
    try GatewayCallRecorder.recoverIncomplete(crashedDirectory)
    let recovered = try JSONSerialization.jsonObject(with: Data(contentsOf: crashedDirectory.appendingPathComponent("manifest.json"))) as! [String: Any]
    check(recovered["terminalState"] as? String == "recovered_incomplete" && recovered["version"] as? Int == 2, "recovered manifest")
    let recoveredTimeline = try String(contentsOf: crashedDirectory.appendingPathComponent("timeline.jsonl"), encoding: .utf8)
    check(!recoveredTimeline.contains("fra\n") && recoveredTimeline.hasSuffix(#"{"event":"stop","state":"recovered_incomplete"}"# + "\n"),
          "torn line dropped, stop appended")
}

print("GatewayMediaSelfTests passed")
