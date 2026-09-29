import Foundation

// Pure audio plumbing for the VoDog gateway media leg (spec S53 「媒体」). No WebRTC or
// modem types here so Tests/GatewayMediaSelfTests can compile it with plain swiftc.

/// `services/media/packet.go`: 16-byte big-endian header + one Opus packet.
/// direction 0 = gateway→bridge (cellular party), 1 = bridge→gateway (VoDog user).
struct GatewayMediaPacket: Equatable {
    static let headerSize = 16
    static let maxOpusBytes = 1024

    var direction: UInt8
    var durationMs: UInt16
    var sequence: UInt32
    var timestampUs: UInt64
    var opus: Data

    func encoded() -> Data {
        var out = Data(capacity: Self.headerSize + opus.count)
        out.append(1)
        out.append(direction)
        withUnsafeBytes(of: durationMs.bigEndian) { out.append(contentsOf: $0) }
        withUnsafeBytes(of: sequence.bigEndian) { out.append(contentsOf: $0) }
        withUnsafeBytes(of: timestampUs.bigEndian) { out.append(contentsOf: $0) }
        out.append(opus)
        return out
    }

    /// Mirrors `decodePacket`: version 1, direction 0/1, 10/20/40/60 ms, TOC duration must match.
    init?(decoding raw: Data) {
        let b = [UInt8](raw)
        guard b.count > Self.headerSize, b.count <= Self.headerSize + Self.maxOpusBytes, b[0] == 1, b[1] <= 1 else {
            return nil
        }
        func be(_ range: Range<Int>) -> UInt64 { b[range].reduce(0) { $0 << 8 | UInt64($1) } }
        let duration = UInt16(be(2 ..< 4))
        let opus = Data(b[Self.headerSize...])
        // Android reads the timestamp as a signed long and requires >= 0; so do we.
        guard [10, 20, 40, 60].contains(duration), Self.opusDurationMs(opus) == duration,
              be(8 ..< 16) <= UInt64(Int64.max) else { return nil }
        self.init(direction: b[1], durationMs: duration, sequence: UInt32(be(4 ..< 8)), timestampUs: be(8 ..< 16), opus: opus)
    }

    init(direction: UInt8, durationMs: UInt16, sequence: UInt32, timestampUs: UInt64, opus: Data) {
        self.direction = direction
        self.durationMs = durationMs
        self.sequence = sequence
        self.timestampUs = timestampUs
        self.opus = opus
    }

    /// RFC 6716 §3.1 frame duration; nil for anything the bridge would reject.
    static func opusDurationMs(_ opus: Data) -> UInt16? {
        guard let toc = opus.first else { return nil }
        var samples: Int
        if toc & 0x80 != 0 {
            samples = 120 << Int((toc >> 3) & 3)
        } else if toc & 0x60 == 0x60 {
            samples = toc & 8 != 0 ? 960 : 480
        } else {
            samples = 480 << Int((toc >> 3) & 3)
            if samples == 3840 { samples = 2880 }
        }
        switch toc & 3 {
        case 1, 2: samples *= 2
        case 3:
            guard opus.count >= 2 else { return nil }
            samples *= Int(opus[opus.startIndex + 1] & 0x3f)
        default: break
        }
        guard [480, 960, 1920, 2880].contains(samples) else { return nil }
        return UInt16(samples / 48)
    }
}

/// 2x sample-rate converter between the modem's 8 kHz UAC and the 16 kHz archive format (S70: the
/// network path is 8 kHz end to end; this is only for the recording). One 63-tap windowed-sinc
/// half-band low-pass (cutoff 4 kHz at 16 kHz): up = zero-stuff then filter (gain 2); down = filter
/// then keep every other sample. Stateful across calls; use one instance per stream.
struct GatewayHalfBandResampler {
    static let taps: [Float] = {
        let count = 63
        let center = Float(count - 1) / 2
        var h = (0 ..< count).map { n -> Float in
            let x = Float(n) - center
            let sinc = x == 0 ? 0.5 : sin(Float.pi * x / 2) / (Float.pi * x)
            let window = 0.42 - 0.5 * cos(2 * Float.pi * Float(n) / Float(count - 1))
                + 0.08 * cos(4 * Float.pi * Float(n) / Float(count - 1))
            return sinc * window
        }
        let sum = h.reduce(0, +)
        h = h.map { $0 / sum }
        return h
    }()

    private var history = [Float](repeating: 0, count: taps.count - 1)

    /// 8 kHz → 16 kHz; output is exactly twice the input length.
    mutating func upsample(_ input: [Int16]) -> [Int16] {
        var stuffed = [Float](repeating: 0, count: input.count * 2)
        for (i, s) in input.enumerated() { stuffed[i * 2] = Float(s) * 2 }
        return filter(stuffed, stride: 1)
    }

    /// 16 kHz → 8 kHz; input length must be even, output is half of it.
    mutating func downsample(_ input: [Int16]) -> [Int16] {
        filter(input.map(Float.init), stride: 2)
    }

    private mutating func filter(_ x: [Float], stride step: Int) -> [Int16] {
        let h = Self.taps
        let buffer = history + x
        var out: [Int16] = []
        out.reserveCapacity(x.count / step)
        var i = 0
        while i < x.count {
            // buffer[i + h.count - 1] is the newest sample for output i.
            var acc: Float = 0
            for k in 0 ..< h.count { acc += h[k] * buffer[i + h.count - 1 - k] }
            out.append(Int16(max(-32768, min(32767, acc.rounded()))))
            i += step
        }
        history = Array(buffer.suffix(h.count - 1))
        return out
    }
}

/// S70 「网关播放策略」 for the downlink (bridge→modem), clocked by the modem: `tick` is called once
/// per 160 modem samples (20 ms at 8 kHz) and returns exactly 160 samples. Codec-agnostic — the
/// caller decodes each `Source` — so the policy is testable without libopus.
///
/// - Primes to `targetUs` (60 ms human, 200 ms AI). Depth = buffered packet audio + decoded
///   samples not yet played, taken after each tick's pull. The UAC IOProc delivers 512 samples
///   at a time, so ticks come 3–4 back to back every 64 ms and the raw value saw-tooths by ~64 ms;
///   `depthUs` for catch-up and the p95 is therefore the minimum over the last 4 ticks (one
///   batch trough). Without that, a slow modem clock (−100 ppm) never looks "over for 1 s".
/// - Missing packet with a later one buffered: `.fec(next)` when the immediate successor is
///   there (libopus decodes its LBRR, or conceals if it has none), else `.plc`. Empty buffer:
///   PLC for at most 3 ticks, then zeros; after ≥ 200 ms empty it re-primes to the target.
/// - Catch-up: depth > T+60 ms for ≥ 1 s → a decoded packet frame with RMS < 300 is dropped and
///   one more is pulled in the same tick (at most one extra per tick); once engaged it stays on
///   until depth ≤ T (hysteresis — without it a slow modem clock parks depth just above T+60). Depth > T+`forcedCatchUpUs`
///   (300 ms human, 1000 ms AI — S70c: AI audio arrives in bursts, and forced drops at T+300 cut AI speech; AI legs
///   catch up on the silence between turns) → packets are decoded (decoder state) and dropped until depth ≤ T+60 ms.
/// - Over `capacityUs` the oldest packet is dropped (counted `overflow`).
struct GatewayPlayout {
    enum Source: Equatable {
        case packet(GatewayMediaPacket)
        /// Decode `next`'s in-band FEC for the lost packet before it (`durationMs` long).
        case fec(next: GatewayMediaPacket, durationMs: Int)
        case plc(durationMs: Int)
    }

    /// One decoded piece of audio, for the recording: `played` false = dropped by catch-up
    /// (S10: still part of `caller_original`, not of `caller_playout`). `startSample` is the
    /// playout-stream position of its first sample when played.
    struct Chunk {
        var source: Source
        var pcm: [Int16]
        var played: Bool
        var startSample: Int64
    }

    enum TickKind: Equatable { case audio, plc, zero, priming }

    static let frameSamples = 160
    static let quietRms = 300.0

    let targetUs: Int
    /// Depth above T at which frames are dropped even mid-speech.
    let forcedCatchUpUs: Int
    let capacityUs: Int
    private var packets: [UInt32: GatewayMediaPacket] = [:]
    private var bufferedUs = 0
    private var next: UInt32?
    private var everPrimed = false
    private var lastDurationMs = 20
    private var pending: [Int16] = []
    private var emptyPlcRun = 0
    private var dryTicks = 0
    private var overTicks = 0
    private(set) var quietCatchUp = false
    private var highestSeen: UInt32?
    private var resetOnNextInsert = false
    private(set) var playedSamples: Int64 = 0
    /// Post-pull depth histogram in 10 ms buckets (last bucket = ≥ 5 s).
    private var depthHistogram = [Int](repeating: 0, count: 501)

    private(set) var received = 0
    private(set) var late = 0
    private(set) var duplicate = 0
    private(set) var overflow = 0
    private(set) var lost = 0
    private(set) var reordered = 0
    private(set) var underrunTicks = 0
    private(set) var zeroFillFrames = 0
    private(set) var plcFrames = 0
    private(set) var fecFrames = 0
    private(set) var quietDrops = 0
    private(set) var forcedDrops = 0
    /// S73 D4: re-primes after a new leg's first packet or a sequence jump > `streamResetJump`.
    private(set) var streamResets = 0
    /// Raw post-pull depth of the last tick.
    private(set) var lastDepthUs = 0
    /// Minimum post-pull depth over the last 4 ticks: the policy's depth.
    private(set) var troughDepthUs = 0
    private var recentDepths: [Int] = []

    init(targetUs: Int = 60_000, forcedCatchUpUs: Int = 300_000, capacityUs: Int = 3_000_000) {
        self.targetUs = targetUs
        self.forcedCatchUpUs = forcedCatchUpUs
        self.capacityUs = capacityUs
    }

    /// S70c (Pixel parity): human T=60 forced at T+300; AI T=200 forced at T+1000. The default 3 s
    /// capacity holds either forced threshold plus a 500 ms burst.
    static func forAnsweredByAi(_ answeredByAi: Bool) -> GatewayPlayout {
        answeredByAi ? GatewayPlayout(targetUs: 200_000, forcedCatchUpUs: 1_000_000) : GatewayPlayout()
    }

    private var depthUs: Int { bufferedUs + pending.count * 125 }

    var depthP95Ms: Int {
        let total = depthHistogram.reduce(0, +)
        guard total > 0 else { return 0 }
        var seen = 0
        for (bucket, count) in depthHistogram.enumerated() {
            seen += count
            if seen * 100 >= total * 95 { return bucket * 10 }
        }
        return 5_000
    }

    static let streamResetJump: Int32 = 50

    /// S73 D4: the next inserted packet starts a new stream (a rejoined leg's first packet).
    mutating func resetOnNextPacket() { resetOnNextInsert = true }

    /// Buffered packets of the old stream are dropped (not counted as loss) and playout re-primes
    /// from the new one; decoded-but-unplayed samples and all counters stay.
    private mutating func resetStream() {
        packets.removeAll()
        bufferedUs = 0
        next = nil
        highestSeen = nil
        resetOnNextInsert = false
        streamResets += 1
    }

    mutating func insert(_ packet: GatewayMediaPacket) {
        if resetOnNextInsert || highestSeen.map({ abs(Int64(Int32(bitPattern: packet.sequence &- $0))) > Int64(Self.streamResetJump) }) == true {
            resetStream()
        }
        if let high = highestSeen, Int32(bitPattern: packet.sequence &- high) < 0 { reordered += 1 }
        if highestSeen.map({ Int32(bitPattern: packet.sequence &- $0) > 0 }) ?? true { highestSeen = packet.sequence }
        if let next, Int32(bitPattern: packet.sequence &- next) < 0 { late += 1; return }
        if packets[packet.sequence] != nil { duplicate += 1; return }
        packets[packet.sequence] = packet
        bufferedUs += Int(packet.durationMs) * 1_000
        received += 1
        while bufferedUs > capacityUs, let oldest = oldestSequence(), let dropped = packets.removeValue(forKey: oldest) {
            bufferedUs -= Int(dropped.durationMs) * 1_000
            overflow += 1
            if let n = next, Int32(bitPattern: oldest &- n) >= 0 { next = oldest &+ 1 }
        }
    }

    mutating func tick(_ decode: (Source) -> [Int16]) -> (frame: [Int16], chunks: [Chunk], kind: TickKind) {
        var chunks: [Chunk] = []
        var kind = TickKind.audio
        if next == nil {
            if bufferedUs >= targetUs, let first = oldestSequence() {
                next = first
                everPrimed = true
                dryTicks = 0
                emptyPlcRun = 0
            } else {
                kind = .priming
                if everPrimed { zeroFillFrames += 1 }
            }
        }
        if next != nil {
            // Forced catch-up (decided on the previous tick's depth, still true now).
            if lastDepthUs > targetUs + forcedCatchUpUs {
                while depthUs > targetUs + 60_000, !packets.isEmpty, let source = nextSource() {
                    let pcm = decode(source)
                    forcedDrops += 1
                    if case .packet = source { chunks.append(Chunk(source: source, pcm: pcm, played: false, startSample: playedSamples)) }
                }
                overTicks = 0
            }
            var extraPulled = false
            while pending.count < Self.frameSamples, let source = nextSource() {
                let pcm = decode(source)
                if case .packet = source, quietCatchUp, !extraPulled, Self.rms(pcm) < Self.quietRms {
                    quietDrops += 1
                    extraPulled = true
                    chunks.append(Chunk(source: source, pcm: pcm, played: false, startSample: playedSamples))
                    continue
                }
                chunks.append(Chunk(source: source, pcm: pcm, played: true, startSample: playedSamples + Int64(pending.count)))
                pending += pcm
                emptyPlcRun = 0
                dryTicks = 0
            }
            if pending.count < Self.frameSamples {
                // Buffer empty: PLC up to 60 ms, then zeros; re-prime after 200 ms dry.
                underrunTicks += 1
                dryTicks += 1
                if emptyPlcRun < 3 {
                    emptyPlcRun += 1
                    plcFrames += 1
                    let source = Source.plc(durationMs: 20)
                    let pcm = decode(source)
                    chunks.append(Chunk(source: source, pcm: pcm, played: true, startSample: playedSamples + Int64(pending.count)))
                    pending += pcm
                    kind = .plc
                } else {
                    zeroFillFrames += 1
                    kind = .zero
                }
                if dryTicks >= 10 { next = nil }
            }
        }
        if pending.count < Self.frameSamples { pending += [Int16](repeating: 0, count: Self.frameSamples - pending.count) }
        let frame = Array(pending.prefix(Self.frameSamples))
        pending.removeFirst(Self.frameSamples)
        playedSamples += Int64(Self.frameSamples)

        lastDepthUs = depthUs
        recentDepths.append(lastDepthUs)
        if recentDepths.count > 4 { recentDepths.removeFirst() }
        troughDepthUs = recentDepths.min() ?? 0
        overTicks = troughDepthUs > targetUs + 60_000 ? overTicks + 1 : 0
        if overTicks >= 50 { quietCatchUp = true } else if troughDepthUs <= targetUs { quietCatchUp = false }
        depthHistogram[min(depthHistogram.count - 1, troughDepthUs / 10_000)] += 1
        return (frame, chunks, kind)
    }

    /// The next source in sequence order; nil when no packet at or after `next` is buffered.
    private mutating func nextSource() -> Source? {
        guard let expected = next, !packets.isEmpty else { return nil }
        if let packet = packets.removeValue(forKey: expected) {
            bufferedUs -= Int(packet.durationMs) * 1_000
            lastDurationMs = Int(packet.durationMs)
            next = expected &+ 1
            return .packet(packet)
        }
        lost += 1
        next = expected &+ 1
        if let following = packets[expected &+ 1] {
            fecFrames += 1
            return .fec(next: following, durationMs: lastDurationMs)
        }
        plcFrames += 1
        return .plc(durationMs: lastDurationMs)
    }

    private func oldestSequence() -> UInt32? {
        guard let anchor = packets.keys.first else { return nil }
        return packets.keys.min { Int32(bitPattern: $0 &- anchor) < Int32(bitPattern: $1 &- anchor) }
    }

    static func rms(_ pcm: [Int16]) -> Double {
        guard !pcm.isEmpty else { return 0 }
        return (pcm.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(pcm.count)).squareRoot()
    }
}


/// S73 D3 rejoin budget for one outage: ≤ 3 attempts within 60 s of the loss; attempt 1 keeps the
/// failed leg's transport, later ones use the other (UDP↔TLS). Attempts start ≥ 15 s apart so a
/// network that is still down is retried across ~30–45 s, except after a bridge conflict (old leg
/// still Connected), which retries after 2 s and still counts. Reset after a successful rejoin.
struct GatewayRejoinPolicy {
    static let disconnectGrace: TimeInterval = 5
    static let maxAttempts = 3
    static let window: TimeInterval = 60
    static let attemptSpacing: TimeInterval = 15
    static let conflictBackoff: TimeInterval = 2
    /// Per-attempt negotiation budget, clipped to the window.
    static let attemptBudget: TimeInterval = 20

    struct Step: Equatable {
        var attempt: Int
        var transport: String
        var startAt: Date
        var deadline: Date
    }

    let lostAt: Date
    let lostTransport: String
    private(set) var attempts = 0
    private var lastStart: Date?

    init(lostAt: Date, transport: String) {
        self.lostAt = lostAt
        lostTransport = transport
    }

    var windowEnd: Date { lostAt.addingTimeInterval(Self.window) }

    /// The next attempt (wait until `startAt`), or nil when the budget is spent.
    /// `afterOffline`: the previous attempt failed with no satisfied network path — it is refunded
    /// and the next one starts `now` (the caller waits for the path first), still inside the window.
    mutating func next(now: Date, afterConflict: Bool = false, afterOffline: Bool = false) -> Step? {
        if afterOffline, attempts > 0, now < windowEnd {
            attempts -= 1
            lastStart = nil
        }
        guard attempts < Self.maxAttempts else { return nil }
        let startAt = lastStart.map {
            afterConflict ? now.addingTimeInterval(Self.conflictBackoff) : max(now, $0.addingTimeInterval(Self.attemptSpacing))
        } ?? now
        guard startAt < windowEnd else { return nil }
        attempts += 1
        lastStart = startAt
        let transport = attempts == 1 ? lostTransport : (lostTransport == "udp" ? "tls" : "udp")
        return Step(attempt: attempts, transport: transport, startAt: startAt,
                    deadline: min(startAt.addingTimeInterval(Self.attemptBudget), windowEnd))
    }

    /// Control proxies the bridge's "old leg still Connected" 409 as 503 MEDIA_BRIDGE_UNAVAILABLE
    /// (services/control app.ts gateway media/offer); either one backs off 2 s.
    static func isConflict(status: Int, code: String?) -> Bool {
        status == 409 || (status == 503 && code == "MEDIA_BRIDGE_UNAVAILABLE")
    }

    /// S73b: a bridged call whose media leg failed for good (rejoin exhausted, negotiation failed)
    /// is hung up once it is established — the Pixel kept such calls up in silence, billing on.
    /// Once per call; a Control hangup racing it is refused by `ModemService.hangUp` (action in flight).
    static func hangsUpCall(active: Bool, alreadyRequested: Bool) -> Bool {
        active && !alreadyRequested
    }

    /// Any other 4xx (auth, revoked, not found) ends the rejoin: today's failure path.
    static func isFatal(status: Int, code: String?) -> Bool {
        (400 ..< 500).contains(status) && !isConflict(status: status, code: code)
    }
}
