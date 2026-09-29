import Foundation
import LiveKitWebRTC
import Network

/// One call's media leg: `media/options` → relay-only PeerConnection → `cellular-opus-v1`
/// data channel → `media/offer`; swaps the modem's UAC audio from the Mac mic/speaker to the
/// network while running, and records the P3 archive tracks.
///
/// Mirrors the Pixel gateway (apps/android/gateway …/media/GatewayDataChannelTransport.kt,
/// GatewayTransportFallback.kt, GatewayAudioMediaSession.kt). Audio is clocked by the modem:
/// every 160 modem downlink samples (20 ms) produce one uplink packet and pull 20 ms of playout.
/// Call `start()` before `ModemService.dial/answerCall` to skip the Mac microphone prompt.
final class GatewayMediaSession: NSObject {
    var onFailure: ((String) -> Void)?

    private let http: GatewayHTTP
    private let callId: String
    private let capture: GatewayCapture
    private let modem: ModemService
    private let diag: GatewayDiag

    // Guards everything below; taken by the UAC io thread, the WebRTC threads and the caller.
    // Never call into LKRTC* objects while holding it: their proxies block on the signaling
    // thread, which may itself be waiting for this lock inside a delegate callback.
    private let lock = NSLock()
    private var stopped = false
    private var failed = false
    private var negotiation: Task<Void, Never>?
    private var peer: LKRTCPeerConnection?
    private var channel: LKRTCDataChannel?
    private var channelOpen = false
    private var transport = "udp"
    private var firstRelayAt: Date?
    private var gatheringCompleteAt: Date?
    private var recorder: GatewayCallRecorder?
    private var recorderStartFrame: Int64 = 0
    /// S56: false while an early-media leg is pre-answer — uplink to the modem is silence and no
    /// recorder runs until `arm()` at CLCC active.
    private var armed: Bool
    private let createdAt = Date()
    /// S73: a leg lost mid-call is rebuilt (new PC + DataChannel) while the modem audio, recorder
    /// and playout stay; `rejoins` counts successful rebuilds, `iceDisconnectedAt` arms the 5 s grace.
    private var rejoining = false
    private var rejoins = 0
    private var iceDisconnectedAt: Date?
    // S72c-style `media.stats` every `statsEveryFrames` modem ticks (30 s).
    private var statsPrevious: [String: Int] = [:]
    private var statsAt = Date()

    // Audio path state (modem clock, 8 kHz end to end — S70).
    private var codec = GatewayOpusCodec()
    private var playout: GatewayPlayout
    private var downlink8k: [Int16] = []
    private var uplink8k: [Int16] = []
    private var frameIndex: Int64 = 0
    private var sequence: UInt32 = 0
    /// Encoded uplink packets waiting for their 20 ms send slot (S70: the UAC IOProc hands over
    /// 512 samples = 64 ms at once; sending the 3–4 packets back to back reordered them on the way
    /// to the bridge, `downLate` 10–15 %). Drained one per ≥ 12 ms by `modemUplink`: the UAC loop
    /// polls every ~5 ms + work, so the spacing must round up to fewer than four polls (< 20 ms)
    /// or the outbox drains slower than one packet per 20 ms and drops continuously.
    private var outbox: [Data] = []
    private var lastSendNs: UInt64 = 0

    // Receive side: the WebRTC callback only appends here under `inboxLock` (never `lock`).
    private let inboxLock = NSLock()
    private var inbox: [GatewayMediaPacket] = []
    private var receiveChannel: LKRTCDataChannel?
    private var inboxDrops = 0
    private var directionRejected = 0
    private var invalidPackets = 0

    // Recording: all GatewayCallRecorder calls run on `recordQueue`, off the modem lock.
    private let recordQueue = DispatchQueue(label: "org.vodog.gateway.recording", qos: .utility)
    private var recordPending = 0 // guarded by `lock`
    private var remoteUpsampler = GatewayHalfBandResampler() // recordQueue only
    private var callerUpsampler = GatewayHalfBandResampler() // recordQueue only
    private var playoutUpsampler = GatewayHalfBandResampler() // recordQueue only
    private var callerNextUs: Int64 = 0 // recordQueue only

    // Counters (reported as `media.session_end` and archive sessionStats).
    private var sentPackets = 0
    private var sendDrops = 0
    private var injectionDrops = 0
    private var callerRecordDrops = 0
    private var rxPackets = 0
    private var rxLbrrPackets = 0
    private var rxBandwidth = [0, 0, 0, 0, 0]
    /// S75: quiet catch-up latch transitions; the first `maxCatchUpEvents` become `media.catchup` rows.
    private var catchUpEvents = 0

    private static let frame8k = 160
    private static let frameUs: Int64 = 20_000
    private static let maxUplinkBacklog = 1_600 // 200 ms at 8 kHz
    private static let maxBufferedPackets: UInt64 = 3
    static let speechPacketFloorBytes = GatewayMediaPacket.headerSize + 100
    private static let maxOutbox = 5
    private static let sendSpacingNs: UInt64 = 12_000_000
    private static let maxInbox = 256
    private static let maxRecordPending = 200
    private static let statsEveryFrames: Int64 = 1_500
    private static let maxCatchUpEvents = 20
    /// S73b: a rejoin attempt failing while the Mac has no satisfied path is not counted.
    private static let pathMonitor: NWPathMonitor = {
        let monitor = NWPathMonitor()
        monitor.start(queue: DispatchQueue(label: "org.vodog.gateway.media.path"))
        return monitor
    }()
    private static var online: Bool { pathMonitor.currentPath.status == .satisfied }
    private static let factory: LKRTCPeerConnectionFactory = {
        LKRTCInitializeSSL()
        return LKRTCPeerConnectionFactory()
    }()

    /// `answeredByAi`: Control's answer command said `answeredBy: "ai"` → S23 AI playout target.
    init(http: GatewayHTTP, callId: String, capture: GatewayCapture, modem: ModemService, early: Bool,
         answeredByAi: Bool = false, diag: @escaping GatewayDiag) {
        playout = GatewayPlayout.forAnsweredByAi(answeredByAi)
        self.http = http
        self.callId = callId
        self.capture = capture
        self.modem = modem
        self.diag = diag
        armed = !early
        super.init()
        _ = Self.pathMonitor // running well before any rejoin reads `currentPath`
    }

    /// S56: the call went active — open the uplink and fetch the capture binding the early
    /// `media/options` skipped. No-op for legs that started armed.
    func arm() {
        let first = lock.withLock { () -> Bool in
            guard !armed, !stopped else { return false }
            armed = true
            return true
        }
        guard first else { return }
        diag("media.early_armed", "info", callId, ["earlyMs": Int(Date().timeIntervalSince(createdAt) * 1000)])
        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.postRetrying("/gateway/calls/\(self.callId)/capture-binding",
                                                           GatewayRules.captureBody(self.capture))
                guard let binding = response["captureBinding"] as? [String: Any] else {
                    throw GatewayArchiveError.invalid("capture_binding_missing")
                }
                self.startRecorder(binding)
            } catch {
                // Recording is lost for this call; its audio is not affected.
                guard !self.lock.withLock({ self.stopped }) else { return }
                let reason = (error as? GatewayHTTPError).map { "http_\($0.status)_\($0.code ?? "")" } ?? GatewayDiagLog.errorReason(error)
                self.diag("media.early_capture_failed", "warn", self.callId, ["reason": String(reason.prefix(120))])
            }
        }
    }

    func start() {
        let ready = lock.withLock { () -> Bool in
            guard !stopped, negotiation == nil else { return false }
            guard codec != nil else { failLocked("opus_unavailable"); return false }
            negotiation = Task { [weak self] in await self?.negotiate() }
            return true
        }
        guard ready else { return }
        modem.voiceAudio.attachGatewayPipe(.init(
            downlink: { [weak self] in self?.modemDownlink($0) },
            uplink: { [weak self] in self?.modemUplink(&$0) ?? 0 }
        ))
    }

    /// Detaches the modem audio, closes the leg and seals the recording synchronously, so a
    /// following `GatewayRecordingArchive.enqueueUpload` finds manifest.json.
    func stop(reason: String) {
        let task = lock.withLock { () -> Task<Void, Never>?? in
            guard !stopped else { return nil }
            stopped = true
            return .some(negotiation)
        }
        guard let task else { return }
        modem.voiceAudio.detachGatewayPipe()
        task?.cancel()
        closePeer()
        let (inboxRejected, invalid, dropped) = inboxLock.withLock { (directionRejected, invalidPackets, inboxDrops) }
        lock.lock()
        // Archive sessionStats (Control validates it .strict()): exactly these four keys.
        let stats: [String: Int] = [
            "networkSendDrops": sendDrops,
            "remotePacketDrops": playout.late + playout.duplicate + playout.overflow + inboxRejected + invalid + dropped,
            "injectionDrops": injectionDrops,
            "transportMissingPackets": playout.lost,
        ]
        var fields: [String: Any] = stats
        fields["stopReason"] = reason
        fields["framesOut"] = Int(frameIndex)
        fields["packetsSent"] = sentPackets
        fields["packetsReceived"] = playout.received
        fields["underrunFrames"] = playout.underrunTicks
        fields["overflowDrops"] = playout.overflow
        fields["lateDrops"] = playout.late
        // S70 诊断计数 (diagnostics only, never the archive manifest).
        fields["playoutTargetMs"] = playout.targetUs / 1_000
        fields["playoutDepthP95Ms"] = playout.depthP95Ms
        fields["underrunTicks"] = playout.underrunTicks
        fields["zeroFillFrames"] = playout.zeroFillFrames
        fields["plcFrames"] = playout.plcFrames
        fields["fecRecoveredFrames"] = codec?.fecRecovered ?? 0
        fields["catchUpQuietDrops"] = playout.quietDrops
        fields["catchUpForcedDrops"] = playout.forcedDrops
        fields["rxPackets"] = rxPackets
        fields["rxLbrrPackets"] = rxLbrrPackets
        fields["rxBandwidth"] = ["nb": rxBandwidth[0], "mb": rxBandwidth[1], "wb": rxBandwidth[2], "swb": rxBandwidth[3], "fb": rxBandwidth[4]]
        fields["reorderedPackets"] = playout.reordered
        fields["callerRecordDrops"] = callerRecordDrops
        fields["decoderComplexity"] = codec?.decoderComplexity ?? 0
        fields["rejoins"] = rejoins
        fields["streamResets"] = playout.streamResets
        fields["catchUpEvents"] = catchUpEvents
        let recorder = self.recorder
        self.recorder = nil
        lock.unlock()
        diag("media.session_end", failed ? "warn" : "info", callId, fields)
        guard let recorder else { return }
        let terminal = failed || reason.lowercased().contains("fail") ? "failed" : "ended"
        // Queued frames land first: the queue is serial.
        recordQueue.sync {
            do {
                try recorder.finish(terminalState: terminal, mediaFatal: failed, stats: stats)
            } catch {
                diag("recording.finalize_failed", "error", callId, GatewayDiagLog.errorFields(error))
            }
        }
    }

    // MARK: - Modem side (UAC io thread)

    /// Called with each UAC input batch (512 samples = 64 ms on the QDC507). Every 160 samples is
    /// one modem tick: encode one uplink packet (queued for paced sending) and pull one 20 ms
    /// playout frame. Nothing here blocks on WebRTC or disk.
    private func modemDownlink(_ samples: [Int16]) {
        let arrived = inboxLock.withLock { () -> [GatewayMediaPacket] in
            defer { inbox.removeAll(keepingCapacity: true) }
            return inbox
        }
        let stats = lock.withLock { () -> [String: Any]? in
            guard !stopped, let codec else { return nil }
            var stats: [String: Any]?
            for packet in arrived {
                rxPackets += 1
                if GatewayOpusCodec.hasLbrr(packet.opus) { rxLbrrPackets += 1 }
                if let band = GatewayOpusCodec.bandwidthIndex(packet.opus) { rxBandwidth[band] += 1 }
                playout.insert(packet)
            }
            downlink8k += samples
            while downlink8k.count >= Self.frame8k {
                let frame = Array(downlink8k.prefix(Self.frame8k))
                downlink8k.removeFirst(Self.frame8k)
                tickLocked(frame, codec: codec)
                if frameIndex % Self.statsEveryFrames == 0 { stats = statsLocked(codec) }
            }
            return stats
        }
        if let stats { diag("media.stats", "info", callId, stats) }
    }

    /// S72c parity (Pixel `media.stats`): cumulative counters named as in `media.session_end`,
    /// plus `delta` since the previous row so an outage can be placed in time.
    private func statsLocked(_ codec: GatewayOpusCodec) -> [String: Any] {
        let current: [String: Int] = [
            "rxPackets": rxPackets, "txPackets": sentPackets, "packetsReceived": playout.received,
            "transportMissingPackets": playout.lost, "networkSendDrops": sendDrops, "injectionDrops": injectionDrops,
            "lateDrops": playout.late, "overflowDrops": playout.overflow, "underrunTicks": playout.underrunTicks,
            "plcFrames": playout.plcFrames, "zeroFillFrames": playout.zeroFillFrames, "fecRecoveredFrames": codec.fecRecovered,
            "catchUpQuietDrops": playout.quietDrops, "catchUpForcedDrops": playout.forcedDrops,
            "rejoins": rejoins, "streamResets": playout.streamResets,
        ]
        let now = Date()
        var fields: [String: Any] = current
        fields["delta"] = current.reduce(into: [String: Int]()) { $0[$1.key] = $1.value - (statsPrevious[$1.key] ?? 0) }
        fields["ms"] = Int(now.timeIntervalSince(createdAt) * 1_000)
        fields["intervalMs"] = Int(now.timeIntervalSince(statsAt) * 1_000)
        fields["playoutDepthMs"] = playout.troughDepthUs / 1_000
        fields["transport"] = transport
        fields["legOpen"] = channelOpen
        statsPrevious = current
        statsAt = now
        return fields
    }

    private func tickLocked(_ frame: [Int16], codec: GatewayOpusCodec) {
        let t = frameIndex * Self.frameUs
        let recordUs = (frameIndex - recorderStartFrame) * Self.frameUs
        frameIndex += 1
        if channelOpen, let opus = codec.encode(frame) {
            outbox.append(GatewayMediaPacket(direction: 0, durationMs: 20, sequence: sequence, timestampUs: UInt64(t), opus: opus).encoded())
            sequence &+= 1
            if outbox.count > Self.maxOutbox {
                outbox.removeFirst()
                sendDrops += 1
            }
        }

        let wasCatchingUp = playout.quietCatchUp
        let (pcm, chunks, _) = playout.tick { codec.decode($0) }
        if playout.quietCatchUp != wasCatchingUp {
            catchUpEvents += 1
            if catchUpEvents <= Self.maxCatchUpEvents {
                let fields: [String: Any] = ["state": playout.quietCatchUp ? "on" : "off", "depthMs": playout.troughDepthUs / 1_000,
                                             "targetMs": playout.targetUs / 1_000]
                // UAC io thread: diag does file I/O, so it runs on the serial recording queue.
                recordQueue.async { [diag, callId] in diag("media.catchup", "info", callId, fields) }
            }
        }
        // S56: pre-answer the caller's audio is still pulled (no backlog at answer) but not played.
        uplink8k += armed ? pcm : [Int16](repeating: 0, count: pcm.count)
        if uplink8k.count > Self.maxUplinkBacklog {
            injectionDrops += (uplink8k.count - Self.maxUplinkBacklog) / Self.frame8k
            uplink8k.removeFirst(uplink8k.count - Self.maxUplinkBacklog)
        }

        guard let recorder else { return }
        guard recordPending < Self.maxRecordPending else {
            callerRecordDrops += 1
            return
        }
        recordPending += 1
        // Playout-stream sample → recording µs (8 kHz: 125 µs per sample; one tick = 160 samples).
        let offsetUs = recorderStartFrame * Self.frameUs
        recordQueue.async { [self] in
            recorder.append("remote_original", remoteUpsampler.upsample(frame), timestampUs: recordUs, sourceTimestampUs: nil)
            for chunk in chunks {
                let at = chunk.startSample * 125 - offsetUs
                var source: Int64?
                if case let .packet(packet) = chunk.source {
                    source = Int64(packet.timestampUs)
                    // S10 caller_original: every normally decoded frame, catch-up drops included.
                    let originalAt = max(at, callerNextUs)
                    if originalAt >= 0 {
                        recorder.append("caller_original", callerUpsampler.upsample(chunk.pcm), timestampUs: originalAt, sourceTimestampUs: source)
                    }
                    callerNextUs = originalAt + Int64(chunk.pcm.count) * 125
                }
                guard chunk.played, at >= 0 else { continue }
                let kind: String?
                switch chunk.source {
                case .packet: kind = nil
                case .fec: kind = "fec_attempt"
                case .plc: kind = "plc"
                }
                recorder.appendPlayout(playoutUpsampler.upsample(chunk.pcm), timestampUs: at, sourceTimestampUs: source, recoveryKind: kind)
            }
            lock.withLock { recordPending -= 1 }
        }
    }

    /// Called every UAC loop pass (~5 ms): hands queued playout to the modem, and sends at most
    /// one uplink packet per 20 ms slot, outside `lock`.
    private func modemUplink(_ buffer: inout [Int16]) -> Int {
        let now = DispatchTime.now().uptimeNanoseconds
        let (count, packet, channel) = lock.withLock { () -> (Int, Data?, LKRTCDataChannel?) in
            let count = min(buffer.count, uplink8k.count)
            for i in 0 ..< count { buffer[i] = uplink8k[i] }
            uplink8k.removeFirst(count)
            guard channelOpen, let channel, !outbox.isEmpty, now &- lastSendNs >= Self.sendSpacingNs else { return (count, nil, nil) }
            lastSendNs = now
            return (count, outbox.removeFirst(), channel)
        }
        if let packet, let channel {
            // Android GatewayDataChannelTransport.mediaBackpressureExceeded: drop when more than
            // 3 packets are queued, sized by a speech packet (S70f: sized by the current packet,
            // tiny silence packets behind buffered speech were dropped: 231/1424 on AI call dd4c7100).
            let sizing = UInt64(max(packet.count, Self.speechPacketFloorBytes))
            let sent = channel.bufferedAmount + UInt64(packet.count) <= sizing * Self.maxBufferedPackets
                && channel.sendData(LKRTCDataBuffer(data: packet, isBinary: true))
            lock.withLock { if sent { sentPackets += 1 } else { sendDrops += 1 } }
        }
        return count
    }

    // MARK: - Negotiation (S24 fallback, S25 D9 relay settle)

    private struct Fallback: Error { let reason: String }

    private func negotiate() async {
        var transport = "udp"
        for attempt in 1 ... 2 {
            do {
                try await connect(transport: transport, attempt: attempt)
                return
            } catch let fallback as Fallback where attempt == 1 && !Task.isCancelled && !lock.withLock({ stopped }) {
                let next = transport == "udp" ? "tls" : "udp"
                diag("media.fallback", "warn", callId, ["from": transport, "to": next, "reason": fallback.reason])
                closePeer()
                transport = next
            } catch {
                if Task.isCancelled || lock.withLock({ stopped }) { return }
                let reason = (error as? Fallback)?.reason ?? (error as? GatewayHTTPError).map { "http_\($0.status)_\($0.code ?? "")" } ?? GatewayDiagLog.errorReason(error)
                diag("media.failed", "error", callId, ["transport": transport, "attempt": attempt, "reason": String(reason.prefix(120))])
                lock.withLock { failLocked("negotiation_failed") }
                return
            }
        }
    }

    /// S73 D3/D5: rebuild a leg lost mid-call. Modem pipe, recorder, playout and the uplink
    /// sequence stay; only the PeerConnection/DataChannel is replaced via a fresh options + offer.
    /// Over budget → today's failed state.
    private func rejoin(reason: String, lostTransport: String) async {
        closePeer()
        var policy = GatewayRejoinPolicy(lostAt: Date(), transport: lostTransport)
        var conflict = false
        var offline = false
        while let step = policy.next(now: Date(), afterConflict: conflict, afterOffline: offline) {
            let wait = step.startAt.timeIntervalSinceNow
            if wait > 0 {
                do { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) } catch { return }
            }
            let startedAt = Date()
            var fields: [String: Any] = ["attempt": step.attempt, "reason": reason, "transport": step.transport]
            do {
                try await connect(transport: step.transport, attempt: step.attempt, deadline: step.deadline)
                // `connect` returns early (no throw) when stopped mid-attempt.
                guard let total = lock.withLock({ () -> Int? in
                    guard !stopped else { return nil }
                    rejoining = false
                    rejoins += 1
                    return rejoins
                }) else { return }
                fields["ms"] = Int(Date().timeIntervalSince(startedAt) * 1_000)
                fields["downMs"] = Int(Date().timeIntervalSince(policy.lostAt) * 1_000) // S75: since the leg was lost
                fields["ok"] = true
                fields["rejoins"] = total
                diag("media.rejoin", "info", callId, fields)
                return
            } catch {
                if Task.isCancelled || lock.withLock({ stopped }) { return }
                closePeer()
                let http = error as? GatewayHTTPError
                conflict = http.map { GatewayRejoinPolicy.isConflict(status: $0.status, code: $0.code) } ?? false
                offline = !Self.online
                fields["ms"] = Int(Date().timeIntervalSince(startedAt) * 1_000)
                fields["downMs"] = Int(Date().timeIntervalSince(policy.lostAt) * 1_000) // S75: since the leg was lost
                fields["ok"] = false
                fields["error"] = String(((error as? Fallback)?.reason ?? http.map { "http_\($0.status)_\($0.code ?? "")" }
                    ?? GatewayDiagLog.errorReason(error)).prefix(120))
                if offline { fields["offline"] = true }
                diag("media.rejoin", "warn", callId, fields)
                if let http, GatewayRejoinPolicy.isFatal(status: http.status, code: http.code) { break }
                if offline {
                    // Retry the moment the path is back; past the window `next` returns nil → exhausted.
                    _ = await waitUntil(policy.windowEnd) { _ in Self.online }
                    if Task.isCancelled || lock.withLock({ stopped }) { return }
                }
            }
        }
        if Task.isCancelled { return }
        diag("media.failed", "error", callId, ["transport": lostTransport, "reason": "rejoin_exhausted", "attempts": policy.attempts])
        lock.withLock { failLocked("rejoin_exhausted") }
    }

    /// One attempt: 8 s budget with a 3 s relay deadline while a fallback remains, else 20 s;
    /// a rejoin passes its own `deadline` (clipped to the 60 s window).
    private func connect(transport: String, attempt: Int, deadline rejoinDeadline: Date? = nil) async throws {
        let startedAt = Date()
        let deadline = rejoinDeadline ?? startedAt.addingTimeInterval(attempt == 1 ? 8 : 20)
        let path = "/gateway/calls/\(callId)/media/options"
        let options: [String: Any]
        do {
            options = try await postRetrying(path, GatewayRules.mediaOptionsBody(
                transport: transport, capture: lock.withLock { armed } ? capture : nil
            ))
        } catch let error as GatewayHTTPError where error.status == 409 && error.code == "CAPTURE_BINDING_REQUIRED" {
            // S56: the call went active (or Control turned early media off) while the capture-less
            // request was in flight; ask again as today's armed leg.
            options = try await postRetrying(path, GatewayRules.mediaOptionsBody(transport: transport, capture: capture))
        }
        guard options["iceTransportPolicy"] as? String == "relay",
              let servers = options["iceServers"] as? [[String: Any]], !servers.isEmpty else {
            throw GatewayArchiveError.invalid("relay_ice_required")
        }
        if let binding = options["captureBinding"] as? [String: Any] { startRecorder(binding) }

        let configuration = LKRTCConfiguration()
        configuration.iceServers = servers.map {
            LKRTCIceServer(urlStrings: $0["urls"] as? [String] ?? [], username: $0["username"] as? String, credential: $0["credential"] as? String)
        }
        configuration.iceTransportPolicy = .relay
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherOnce
        // S20 D7: one TURN allocation per network; the relay quota is small (coturn 24/12).
        configuration.shouldPruneTurnPorts = true
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = Self.factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw GatewayArchiveError.invalid("peer_creation")
        }
        // services/media/main.go accepts only label cellular-opus-v1, unordered, maxRetransmits ==
        // the bridge's configured value (0 in production) and no maxPacketLifeTime — exactly the
        // Pixel gateway's DataChannel.Init (GatewayDataChannelTransport.kt ordered=false, maxRetransmits=0).
        let dcConfig = LKRTCDataChannelConfiguration()
        dcConfig.isOrdered = false
        dcConfig.maxRetransmits = 0
        guard let dc = pc.dataChannel(forLabel: "cellular-opus-v1", configuration: dcConfig) else {
            pc.close()
            throw GatewayArchiveError.invalid("data_channel_creation")
        }
        dc.delegate = self
        let proceed = lock.withLock { () -> Bool in
            guard !stopped else { return false }
            peer = pc
            channel = dc
            inboxLock.withLock { receiveChannel = dc }
            self.transport = transport
            firstRelayAt = nil
            gatheringCompleteAt = nil
            iceDisconnectedAt = nil
            // S73 D4: the rebuilt leg's first packet starts a new playout stream.
            if rejoining { playout.resetOnNextPacket() }
            return true
        }
        guard proceed else { pc.close(); return }

        let offer = try await pc.offer(for: constraints)
        try await pc.setLocalDescription(offer)
        // Never wait for gathering COMPLETE alone: on media-node-a it never fires. First relay candidate,
        // then a 500 ms settle (or COMPLETE inside it).
        let relayDeadline = attempt == 1 && rejoinDeadline == nil ? startedAt.addingTimeInterval(3) : deadline
        guard await waitUntil(relayDeadline, { $0.firstRelayAt != nil || $0.gatheringCompleteAt != nil }) else {
            throw Fallback(reason: "no_relay_candidate")
        }
        if let relayAt = lock.withLock({ firstRelayAt }) {
            _ = await waitUntil(relayAt.addingTimeInterval(0.5)) { $0.gatheringCompleteAt != nil }
        }
        let sdp = pc.localDescription?.sdp ?? ""
        let relayCount = sdp.components(separatedBy: "\n").filter { $0.contains("a=candidate:") && $0.contains(" typ relay") }.count
        guard relayCount > 0 else { throw Fallback(reason: "relay_unavailable") }
        diag("media.offer", "info", callId, ["transport": transport, "ms": Int(Date().timeIntervalSince(startedAt) * 1000), "relayCandidates": relayCount])

        let answer = try await postRetrying("/gateway/calls/\(callId)/media/offer", ["type": "offer", "sdp": sdp])
        guard answer["type"] as? String == "answer", let answerSdp = answer["sdp"] as? String else {
            throw GatewayArchiveError.invalid("media_answer")
        }
        try await pc.setRemoteDescription(LKRTCSessionDescription(type: .answer, sdp: answerSdp))
        guard await waitUntil(deadline, { $0.channelOpen }) else { throw Fallback(reason: "data_channel_timeout") }
        diag("media.leg_open", "info", callId, ["transport": transport, "attempt": attempt, "ms": Int(Date().timeIntervalSince(startedAt) * 1000)])
    }

    /// Control answers 409 with these while a fact it needs is still in flight (Android
    /// MEDIA_SETUP_TRANSIENT_409_CODES); retried within 12 s.
    private func postRetrying(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        try await http.postRetrying(path, body)
    }

    /// Polls `condition` under the lock every 20 ms; false on deadline, stop or cancellation.
    private func waitUntil(_ deadline: Date, _ condition: (GatewayMediaSession) -> Bool) async -> Bool {
        while true {
            let (done, dead) = lock.withLock { (condition(self), stopped) }
            if done { return true }
            if dead || Task.isCancelled || Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func startRecorder(_ binding: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard recorder == nil, !stopped else { return }
        do {
            recorder = try GatewayCallRecorder(callId: callId, binding: binding)
            GatewayRecordingArchive.markActive(callId, gatewayId: http.credentials.gatewayId)
            recorderStartFrame = frameIndex
        } catch {
            diag("recording.start_failed", "error", callId, GatewayDiagLog.errorFields(error))
        }
    }

    private func closePeer() {
        let (pc, dc) = lock.withLock { () -> (LKRTCPeerConnection?, LKRTCDataChannel?) in
            // Stale uplink packets are not replayed on the next leg; `sequence` itself runs on (S73 D4).
            defer { peer = nil; channel = nil; channelOpen = false; outbox.removeAll() }
            return (peer, channel)
        }
        inboxLock.withLock { receiveChannel = nil; inbox.removeAll() }
        dc?.delegate = nil
        dc?.close()
        pc?.close()
    }

    private func failLocked(_ reason: String) {
        guard !failed, !stopped else { return }
        failed = true
        let callback = onFailure
        DispatchQueue.main.async { callback?(reason) }
    }

    /// S73 D5: the established leg dropped (ICE/PC failed, DataChannel closed, ICE disconnected
    /// ≥ 5 s). Called under `lock` on a WebRTC thread, so the rebuild runs in a Task — never
    /// `closePeer()` here (it blocks on the signaling thread).
    private func legLostLocked(_ reason: String) {
        guard !failed, !stopped, !rejoining else { return }
        rejoining = true
        channelOpen = false
        iceDisconnectedAt = nil
        let lostTransport = transport
        // The initial negotiate may still be polling for this leg's open; stop it so its timeout
        // cannot mark the session failed underneath the rejoin (no-op once it has returned).
        negotiation?.cancel()
        negotiation = Task { [weak self] in await self?.rejoin(reason: reason, lostTransport: lostTransport) }
    }

    private func isCurrent(_ pc: LKRTCPeerConnection) -> Bool { peer === pc }
}

// MARK: - WebRTC callbacks (signaling/network threads)

extension GatewayMediaSession: LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate {
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        guard candidate.sdp.contains(" typ relay") else { return }
        lock.withLock { if isCurrent(peerConnection), firstRelayAt == nil { firstRelayAt = Date() } }
    }

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {
        guard newState == .complete else { return }
        lock.withLock { if isCurrent(peerConnection), gatheringCompleteAt == nil { gatheringCompleteAt = Date() } }
    }

    /// S73: DISCONNECTED for ≥ 5 s or FAILED/CLOSED on the established leg → rejoin (S40 kept a
    /// short DISCONNECTED transient: CONNECTED/COMPLETED inside the grace cancels it).
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {
        let name: String
        switch newState {
        case .connected, .completed:
            lock.withLock { if isCurrent(peerConnection) { iceDisconnectedAt = nil } }
            return
        case .disconnected: name = "disconnected"
        case .failed: name = "failed"
        case .closed: name = "closed"
        default: return
        }
        lock.withLock {
            guard isCurrent(peerConnection), !stopped else { return }
            diag("media.ice_state", newState == .failed ? "error" : "info", callId, ["transport": transport, "state": name])
            guard channelOpen else { return }
            guard newState == .disconnected else { legLostLocked("ice_\(name)"); return }
            guard iceDisconnectedAt == nil else { return }
            let since = Date()
            iceDisconnectedAt = since
            DispatchQueue.global().asyncAfter(deadline: .now() + GatewayRejoinPolicy.disconnectGrace) { [weak self] in
                guard let self else { return }
                self.lock.withLock {
                    guard self.isCurrent(peerConnection), self.iceDisconnectedAt == since, self.channelOpen else { return }
                    self.legLostLocked("ice_disconnected")
                }
            }
        }
    }

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        guard newState == .failed || newState == .disconnected else { return }
        lock.withLock {
            guard isCurrent(peerConnection), !stopped else { return }
            diag("media.pc_state", newState == .failed ? "error" : "info", callId,
                 ["transport": transport, "state": newState == .failed ? "failed" : "disconnected"])
            if newState == .failed && channelOpen { legLostLocked("pc_failed") }
        }
    }

    func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {
        let state = dataChannel.readyState
        lock.withLock {
            guard dataChannel === channel, !stopped else { return }
            switch state {
            case .open:
                channelOpen = true
            case .closed:
                if channelOpen { legLostLocked("transport_disconnected") }
                channelOpen = false
            default:
                break
            }
        }
    }

    func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        // S70: enqueue only — never the modem `lock` (it stalled this WebRTC thread behind codec
        // work and synchronous WAV writes; the bridge saw late SACKs as upBackpressureDrops).
        let packet = buffer.isBinary ? GatewayMediaPacket(decoding: buffer.data) : nil
        inboxLock.withLock {
            guard dataChannel === receiveChannel, buffer.isBinary else { return }
            guard let packet else { invalidPackets += 1; return }
            guard packet.direction == 1 else { directionRejected += 1; return }
            inbox.append(packet)
            if inbox.count > Self.maxInbox {
                inbox.removeFirst()
                inboxDrops += 1
            }
        }
    }

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {}
}

extension GatewayHTTP {
    /// POST that waits out Control's transient 409s (media node pinning, CLCC active not yet seen).
    func postRetrying(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        let delays: [UInt64] = [250, 500, 1_000, 1_500, 2_000, 2_500, 3_000]
        let deadline = Date().addingTimeInterval(12)
        var attempt = 0
        while true {
            do {
                return try await json("POST", path, body)
            } catch let error as GatewayHTTPError where error.status == 409
                && ["MEDIA_NODE_PENDING", "CAPTURE_NOT_ACTIVE", "CAPTURE_NOT_CONFIRMED"].contains(error.code ?? "") && Date() < deadline {
                try await Task.sleep(nanoseconds: delays[min(attempt, delays.count - 1)] * 1_000_000)
                attempt += 1
            }
        }
    }
}

/// S58: archive recorder for a call dialed on the module itself (Mac mic/speaker). No WebRTC and
/// no gateway pipe — it only listens to `VoiceAudioService`'s record tap, like the Pixel's passive
/// recorder: capture-binding once active, 8 kHz → 16 kHz tracks, sealed at the end for upload.
final class GatewayLocalDialRecording {
    private let http: GatewayHTTP
    private let callId: String
    private let capture: GatewayCapture
    private let modem: ModemService
    private let diag: GatewayDiag

    // Guards everything below; taken by the UAC io thread (tap) and the main actor.
    private let lock = NSLock()
    private var stopped = false
    private var recorder: GatewayCallRecorder?
    private var bound = false
    private var startedAt = Date()
    private var remote = (resampler: GatewayHalfBandResampler(), nextUs: Int64?.none)
    private var caller = (resampler: GatewayHalfBandResampler(), nextUs: Int64?.none)

    /// True once a recorder was created, i.e. there is a directory worth uploading.
    var started: Bool { lock.withLock { bound } }

    init(http: GatewayHTTP, callId: String, capture: GatewayCapture, modem: ModemService, diag: @escaping GatewayDiag) {
        self.http = http
        self.callId = callId
        self.capture = capture
        self.modem = modem
        self.diag = diag
    }

    /// Call once CLCC is active and the server call id is known.
    func start() {
        // ponytail: audio before capture-binding returns (about one RTT, longer while Control has not
        // yet seen the call active) is dropped; buffer it in the tap if the leading second matters.
        modem.voiceAudio.attachRecordTap(.init(
            downlink: { [weak self] in self?.append($0, remote: true) },
            uplink: { [weak self] in self?.append($0, remote: false) }
        ))
        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.http.postRetrying("/gateway/calls/\(self.callId)/capture-binding",
                                                                GatewayRules.captureBody(self.capture))
                guard let binding = response["captureBinding"] as? [String: Any] else {
                    throw GatewayArchiveError.invalid("capture_binding_missing")
                }
                let armed = try self.lock.withLock { () -> Bool in
                    guard !self.stopped else { return false }
                    self.recorder = try GatewayCallRecorder(callId: self.callId, binding: binding)
                    self.startedAt = Date()
                    self.bound = true
                    GatewayRecordingArchive.markActive(self.callId, gatewayId: self.http.credentials.gatewayId)
                    return true
                }
                if armed { self.diag("recording.local_dial_armed", "info", self.callId, [:]) }
            } catch {
                // The call and the local M4A are not affected; only the archive is lost.
                let reason = (error as? GatewayHTTPError).map { "http_\($0.status)_\($0.code ?? "")" } ?? GatewayDiagLog.errorReason(error)
                self.diag("recording.local_dial_failed", "warn", self.callId, ["reason": String(reason.prefix(120))])
            }
        }
    }

    /// Detaches the tap and seals the recording synchronously (before `enqueueUpload`).
    func stop() {
        modem.voiceAudio.detachRecordTap()
        lock.lock()
        defer { lock.unlock() }
        stopped = true
        guard let recorder else { return }
        do {
            try recorder.finish(terminalState: "ended", mediaFatal: false, stats: [:])
        } catch {
            diag("recording.finalize_failed", "error", callId, GatewayDiagLog.errorFields(error))
        }
        self.recorder = nil
    }

    /// UAC io thread. Each track runs on its own sample clock (the mic and the modem are not
    /// sample-locked); a track more than 100 ms behind wall time (mute, mic stall) snaps forward,
    /// which the recorder logs as a gap, so the two tracks stay aligned.
    private func append(_ pcm8k: [Int16], remote isRemote: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard let recorder, !pcm8k.isEmpty else { return }
        let pcm = isRemote ? remote.resampler.upsample(pcm8k) : caller.resampler.upsample(pcm8k)
        let wallUs = Int64(Date().timeIntervalSince(startedAt) * 1_000_000)
        let clockUs = isRemote ? remote.nextUs : caller.nextUs
        let at = clockUs.map { wallUs - $0 > 100_000 ? wallUs : $0 } ?? wallUs
        recorder.append(isRemote ? "remote_original" : "caller_original", pcm, timestampUs: at, sourceTimestampUs: nil)
        let next = at + Int64(pcm8k.count) * 125
        if isRemote { remote.nextUs = next } else { caller.nextUs = next }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
