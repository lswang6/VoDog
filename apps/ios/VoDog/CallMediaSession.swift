import AVFoundation
import Foundation
@preconcurrency import LiveKitWebRTC
import Observation
import os

@MainActor @Observable
final class CallMediaSession: NSObject {
    static let shared = CallMediaSession()
    /// Diagnostics for the relay handshake. Every field is `.public` because none of it is user data:
    /// TURN credentials, SDP bodies and the user's own candidate addresses are deliberately never logged.
    /// The trail is `.notice`, not `.info`, so `log stream`/`log collect` keep it without a debugger attached.
    nonisolated private static let log = Logger(subsystem: "org.vodog", category: "media")

    enum State: Equatable {
        case idle
        case connecting(MediaTransport)
        case connected(MediaTransport)
        case failed(MediaTransport, String)
    }

    private(set) var state: State = .idle
    private(set) var callID: String?
    private(set) var isMuted = false
    private(set) var isSpeakerEnabled = false
    private(set) var microphoneAvailable = false
    /// S20 decision 8: when the held-call grace is running, the view shows a live countdown instead of a
    /// static sentence. Nil whenever no grace is pending.
    private(set) var graceDeadline: Date?
    private let factory: LKRTCPeerConnectionFactory
    private let rtcAudioSession = LKRTCAudioSession.sharedInstance()
    private var peerConnection: LKRTCPeerConnection?
    private var localAudioTrack: LKRTCAudioTrack?
    private var activeAttempt: UUID?
    /// S45: the candidate filter the live peer was built with, so `media.relay_candidates` says which one a
    /// gathering result belongs to instead of leaving the reader to infer it from the network label.
    private var candidateNetworkLabel = MediaCandidateNetworkPolicy.Choice.all.label
    private weak var activeSession: SessionStore?
    private var activeSessionIdentity: UUID?
    private var managedByCallKit = false
    var isManagedByCallKit: Bool { managedByCallKit }
    /// 30 s `media.stats`, as the web client logs, so a mid-call gap can be placed in time.
    private var statsTask: Task<Void, Never>?
    private var callKitAudioActive = false
    private var ownsAudioSessionActivation = false
    private var notifiedManualActivation = false
    private var callKitAudioWaiters: [CheckedContinuation<Void, Never>] = []
    private var automaticallyRetryTLS = false
    private var generatedCandidateCount = 0
    private var relayCandidateCount = 0
    private var firstRelayCandidateAt: ContinuousClock.Instant?
    private var handshakeInFlight = false
    /// S36 C3: the mark every ICE transition is measured against.
    private var offerSentAt: ContinuousClock.Instant?
    private var grace = MediaGraceTracker()
    private var graceTask: Task<Void, Never>?
    private var disconnectGraceTask: Task<Void, Never>?
    private var finalFailure: (@MainActor @Sendable (String) -> Void)?
    /// S69: one `media.summary` per call, spanning its network retry, TLS fallback and user retries.
    private var summary: MediaCallSummary?
    private var iceDisconnectedAt: ContinuousClock.Instant?
    /// S73 D3: the running rejoin of an established leg. It survives the `stop(reason: nil)` each attempt's
    /// `start` does, carries mute and speaker across peers, and is cleared by success, give-up or a real stop.
    private struct RejoinEpisode {
        let reason: String
        let failedLeg: MediaTransport
        let startedAt = ContinuousClock.now
        var attempt = 0
        var attemptStartedAt = ContinuousClock.now
        var muted: Bool
        var speaker: Bool
        /// S73h: the drop or an attempt happened offline; transports restart at UDP (`MediaRejoinPolicy.transport`).
        var wentOffline = false
        /// S73g: set after a skipped-probe attempt got 409 `MEDIA_PROBE_REQUIRED`; later attempts probe.
        var needsProbe = false
    }
    private var rejoin: RejoinEpisode?
    private var rejoinTask: Task<Void, Never>?
    /// S73 D7: the view shows "网络波动，正在重新连接…" instead of a failure while this is true.
    var isRejoining: Bool { rejoin != nil }
    var isConnectingOrConnected: Bool {
        switch state { case .connecting, .connected: true; default: false }
    }

    override private init() {
        LKRTCInitializeSSL()
        #if DEBUG
        // WebRTC's own STUN/TURN/ICE lines go to stderr (the Xcode console), not to unified logging.
        LKRTCSetMinDebugLogLevel(.info)
        #endif
        factory = LKRTCPeerConnectionFactory()
        super.init()
        rtcAudioSession.useManualAudio = true
        rtcAudioSession.add(self)
        observeAudioRouteChanges()
    }

    /// Logging only: the earpiece/speaker complaints need to be read against the route iOS actually picked.
    ///
    /// S36 C3: the same two facts also go to `diag_events`. The input port matters as much as the output —
    /// it is what tells CarPlay apart from a plain Bluetooth handsfree headset.
    private func observeAudioRouteChanges() {
        _ = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { notification in
            let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
            let route = AVAudioSession.sharedInstance().currentRoute
            let outputs = route.outputs.map(\.portType.rawValue).joined(separator: ",")
            let inputs = route.inputs.map(\.portType.rawValue).joined(separator: ",")
            Self.log.notice(
                "audio route changed reason=\(reason, privacy: .public) outputs=\(outputs, privacy: .public)"
            )
            Diag.shared.log("audio.route", ["reason": Int(reason), "outputs": outputs, "inputs": inputs])
        }
        // S36 C3: nothing observed interruptions before. This only records them — reacting is
        // `LKRTCAudioSessionDelegate`'s job and changing that without evidence is what this log is for.
        _ = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { notification in
            let type = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 0
            let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
            let reason = (notification.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt) ?? 0
            Diag.shared.log("audio.interruption", [
                "type": type == AVAudioSession.InterruptionType.began.rawValue ? "began" : "ended",
                "options": Int(options), "reason": Int(reason)
            ])
        }
    }

    var statusText: String {
        if isRejoining { return MediaRejoinPolicy.statusText }
        return switch state {
        case .idle: "音频未连接"
        case let .connecting(transport): "正在通过 \(transport.label) 连接音频…"
        case let .connected(transport): "音频已通过 \(transport.label) 连接"
        case let .failed(_, message): message
        }
    }

    func start(
        callID: String, session: SessionStore, transport: MediaTransport = .udp,
        managedByCallKit: Bool = false, automaticallyRetryTLS: Bool = false,
        onFinalFailure: (@MainActor @Sendable (String) -> Void)? = nil,
        requiredSessionIdentity: UUID? = nil, networkRetryUsed: Bool = false
    ) async {
        let startFields = "transport=\(transport.label) managedByCallKit=\(managedByCallKit)"
            + " automaticallyRetryTLS=\(automaticallyRetryTLS)"
        Self.log.notice("start callID=\(callID, privacy: .public) \(startFields, privacy: .public)")
        // Phone audio has priority over on-demand recording playback. Both singletons are
        // main-actor isolated, so the stop happens before this media attempt can configure audio.
        RecordingPlaybackController.shared.stop()
        DialTonePlayer.shared.stop()
        IncomingRingtonePlayer.shared.stop()
        // A retry of the same call keeps its summary open; anything else closes the previous call's.
        stop(reason: summary?.callID == callID ? nil : "replaced")
        guard let sessionIdentity = requiredSessionIdentity ?? session.sessionIdentity,
              session.isCurrentSession(sessionIdentity) else {
            rejoin = nil
            state = .failed(transport, SessionLifecycleError.staleSession.localizedDescription)
            return
        }
        if summary?.callID != callID { summary = MediaCallSummary(callID: callID) }
        summary?.attempts += 1
        summary?.transport = transport.label
        if transport == .tls, rejoin == nil, (summary?.attempts ?? 0) > 1 { summary?.tlsFallback = true }
        if networkRetryUsed { summary?.networkRetry = true }
        let attempt = UUID()
        isMuted = rejoin?.muted ?? false
        isSpeakerEnabled = rejoin?.speaker ?? false
        microphoneAvailable = false
        generatedCandidateCount = 0
        relayCandidateCount = 0
        firstRelayCandidateAt = nil
        activeAttempt = attempt
        self.callID = callID
        activeSession = session
        activeSessionIdentity = sessionIdentity
        self.managedByCallKit = managedByCallKit
        self.automaticallyRetryTLS = automaticallyRetryTLS
        finalFailure = onFinalFailure
        state = .connecting(transport)
        startPeriodicStats(callID: callID)
        // Gates the delegate's own failure handling: while the handshake is awaited, the waiting loops observe ICE
        // and throw, so a delegate-driven retry would run a second attempt in parallel with this one.
        handshakeInFlight = true
        defer { handshakeInFlight = false }
        // S36 C3: every step of the handshake is timed from here, so a slow options call and a slow relay are
        // told apart without a debugger attached.
        let attemptStartedAt = ContinuousClock.now
        let pathAtStart = MediaNetworkGenerationSource.shared.currentPathLabel()
        offerSentAt = nil
        do {
            let options = try await requestMediaOptions(
                callID: callID, transport: transport, session: session, sessionIdentity: sessionIdentity,
                // S73g: every rejoin skips the probe (S73f: the gateway fixes the node) until Control asks for one.
                skipProbe: rejoin.map { !$0.needsProbe } ?? false
            )
            Diag.shared.log("media.options", [
                "ms": Diag.ms(since: attemptStartedAt), "transport": transport.label,
                "node": options.mediaNodeId ?? "nil", "managedByCallKit": managedByCallKit
            ], callId: callID)
            // The relay URL never carries the TURN credentials — they travel in separate fields — so it is safe to log.
            let optionFields = "node=\(options.mediaNodeId ?? "nil") epoch=\(options.mediaEpoch.map(String.init) ?? "nil")"
                + " policy=\(options.iceTransportPolicy) relay=\(options.iceServers.first?.urls.first ?? "none")"
            Self.log.notice("media options callID=\(callID, privacy: .public) \(optionFields, privacy: .public)")
            try ensureCurrent(attempt)
            let relay = try options.validatedRelayURL(for: transport)
            // The microphone grant must exist before the voice-processing audio unit starts; without it WebRTC opens
            // a record path that iOS refuses and the call stays silent in both directions.
            try await requireMicrophonePermission()
            try configurePhoneAudioSession(managedByCallKit: managedByCallKit)
            // S73: an app-owned session resets the route on configure; a rejoin puts the speaker back.
            if !managedByCallKit, rejoin?.speaker == true { setSpeaker(true) }
            if managedByCallKit {
                let audioWaitStartedAt = ContinuousClock.now
                await waitForCallKitAudioIfNeeded()
                try ensureCurrent(attempt)
                guard callKitAudioActive else {
                    Diag.shared.log(
                        "media.callkit_audio_timeout", ["ms": Diag.ms(since: audioWaitStartedAt)], callId: callID
                    )
                    throw MediaSessionError.callKitAudioTimedOut
                }
            }
            let peer = try makePeerConnection(relay: relay)
            peerConnection = peer
            Self.log.notice("peer created gathering=\(peer.iceGatheringState.logLabel, privacy: .public)")

            // S20 decision 1: pin the Opus fmtp before the offer becomes the local description, so the parameters
            // the server sees — and pion mirrors back into the answer — are the three-client contract, not
            // libwebrtc's defaults.
            let generatedOffer = try await createOffer(on: peer)
            let offer = LKRTCSessionDescription(
                type: generatedOffer.type, sdp: OpusOfferPolicy.rewrite(sdp: generatedOffer.sdp)
            )
            let offerFields = "mLines=\(Self.mediaLineCount(offer.sdp)) hasCandidate=\(offer.sdp.contains("a=candidate")) opusContract=\(offer.sdp.contains(OpusOfferPolicy.fmtpParameters)) usedtx=\(offer.sdp.contains("usedtx"))"
            Self.log.notice("offer created \(offerFields, privacy: .public)")
            try ensureCurrent(attempt)
            try await setLocalDescription(offer, on: peer)
            Self.log.notice("local description set gathering=\(peer.iceGatheringState.logLabel, privacy: .public)")
            try await waitForRelayCandidates(on: peer, transport: transport, attempt: attempt)
            try ensureCurrent(attempt)
            // libwebrtc appends the gathered `a=candidate` lines to the pending local description, so the offer the
            // server receives carries them even though gathering never reported `.complete`.
            guard let local = peer.localDescription, !local.sdp.isEmpty else {
                throw MediaSessionError.missingLocalDescription
            }
            let offerPostFields = "bytes=\(local.sdp.utf8.count) candidateLines=\(Self.candidateLineCount(local.sdp))"
                + " hasCandidate=\(local.sdp.contains("a=candidate"))"
            Self.log.notice("posting offer \(offerPostFields, privacy: .public)")
            offerSentAt = .now
            Diag.shared.log("media.offer", [
                "ms": Diag.ms(since: attemptStartedAt), "transport": transport.label,
                "candidateLines": Self.candidateLineCount(local.sdp)
            ], callId: callID)
            let answer: MediaSessionDescription = try await session.request(
                "calls/\(callID)/media/offer", method: "POST",
                body: MediaSessionDescription(type: "offer", sdp: local.sdp),
                timeoutInterval: 8, requiredSessionIdentity: sessionIdentity
            )
            Diag.shared.log("media.answer", [
                "ms": offerSentAt.map { Diag.ms(since: $0) } ?? -1, "type": answer.type,
                "typs": Self.candidateTypes(in: answer.sdp)
            ], callId: callID)
            let answerFields = "type=\(answer.type) bytes=\(answer.sdp.utf8.count)"
                + " hasCandidate=\(answer.sdp.contains("a=candidate")) typs=\(Self.candidateTypes(in: answer.sdp))"
            Self.log.notice("answer received \(answerFields, privacy: .public)")
            try ensureCurrent(attempt)
            guard answer.type == "answer", !answer.sdp.isEmpty else { throw MediaSessionError.invalidAnswer }
            try await setRemoteDescription(LKRTCSessionDescription(type: .answer, sdp: answer.sdp), on: peer)
            Self.log.notice("remote description set callID=\(callID, privacy: .public)")
            // Candidates alone never carried audio: the relay still has to connect. Waiting here routes a stuck
            // `checking` through the same retry/fail path as every other media failure.
            try await waitForIceConnection(on: peer, transport: transport, attempt: attempt)
            if let episode = rejoin {
                logRejoin(episode, transport: transport, ok: true)
                rejoin = nil
                rejoinTask = nil
            }
        } catch is CancellationError {
            Self.log.notice("attempt cancelled callID=\(callID, privacy: .public)")
            if activeAttempt == attempt { stop() }
        } catch {
            Self.log.error("start failed callID=\(callID, privacy: .public) \(Self.failureFields(error), privacy: .public)")
            guard activeAttempt == attempt else { return }
            if rejoin != nil {
                continueRejoin(after: error, transport: transport)
                return
            }
            if session.isCurrentSession(sessionIdentity), MediaRetryPolicy.shouldRetryAfterNetworkChange(
                after: error, pathAtStart: pathAtStart,
                pathNow: MediaNetworkGenerationSource.shared.currentPathLabel(), alreadyRetried: networkRetryUsed
            ) {
                Diag.shared.log("media.retry_network", ["transport": transport.label], callId: callID)
                await start(
                    callID: callID, session: session, transport: transport,
                    managedByCallKit: managedByCallKit, automaticallyRetryTLS: automaticallyRetryTLS,
                    onFinalFailure: onFinalFailure, requiredSessionIdentity: sessionIdentity, networkRetryUsed: true
                )
                return
            }
            let retriesTLS = transport == .udp && automaticallyRetryTLS
                && session.isCurrentSession(sessionIdentity) && MediaRetryPolicy.shouldRetryTLS(after: error)
            // S36 C3: a UDP attempt that TLS then rescues never reaches `handleTerminalFailure`, and its exact
            // `MediaSessionError` is the discriminator the CarPlay investigation needs.
            Diag.shared.log("media.failed", [
                "transport": transport.label, "reason": String(describing: error),
                "message": error.localizedDescription, "willRetryTLS": retriesTLS
            ], callId: callID)
            if retriesTLS {
                await start(
                    callID: callID, session: session, transport: .tls,
                    managedByCallKit: managedByCallKit, automaticallyRetryTLS: false,
                    onFinalFailure: onFinalFailure, requiredSessionIdentity: sessionIdentity,
                    networkRetryUsed: networkRetryUsed
                )
                return
            }
            // S73e: the setup failed offline / on a network error — wait for the path and rejoin, don't hold for grace.
            let offline = MediaRejoinPolicy.isOffline(pathLabel: MediaNetworkGenerationSource.shared.currentPathLabel())
            if session.isCurrentSession(sessionIdentity),
               MediaRejoinPolicy.shouldRejoinSetup(after: error, offline: offline) {
                let episode = RejoinEpisode(
                    reason: "setup_offline", failedLeg: transport, muted: isMuted, speaker: isSpeakerEnabled,
                    wentOffline: true
                )
                rejoin = episode
                // The failed setup itself (attempt 0) ran the normal probed path.
                logRejoin(episode, transport: transport, ok: false, error: error, offline: offline, probeSkipped: false)
                scheduleRejoinAttempt(after: .zero)
                return
            }
            handleTerminalFailure(transport: transport, error: error)
        }
    }

    /// Re-runs the whole sequence for the held call — UDP first, with the automatic TLS fallback — using the identity
    /// stored by the failed attempt. This is the "重试音频" action shown during the grace period.
    func retry(session: SessionStore) async {
        guard let callID, let sessionIdentity = activeSessionIdentity,
              session.isCurrentSession(sessionIdentity) else { return }
        let isCallKitManaged = managedByCallKit
        let handler = finalFailure
        await start(
            callID: callID, session: session, transport: .udp,
            managedByCallKit: isCallKitManaged, automaticallyRetryTLS: true,
            onFinalFailure: handler, requiredSessionIdentity: sessionIdentity
        )
    }

    func retryWithTLS(session: SessionStore) async {
        guard let callID, let sessionIdentity = activeSessionIdentity,
              session.isCurrentSession(sessionIdentity) else { return }
        let isCallKitManaged = managedByCallKit
        let handler = finalFailure
        await start(
            callID: callID, session: session, transport: .tls,
            managedByCallKit: isCallKitManaged, automaticallyRetryTLS: false,
            onFinalFailure: handler, requiredSessionIdentity: sessionIdentity
        )
    }

    /// `reason` nil: `start` is retrying the same call, so its `media.summary` stays open.
    func stop(reason: String? = "stopped") {
        if let reason, let summary {
            let emitter = MediaSummaryEmitter(fields: summary.fields(
                finalState: state.logLabel, endReason: reason, candidates: generatedCandidateCount,
                relayCandidates: relayCandidateCount, callKitAudio: callKitAudioActive
            ), callID: summary.callID)
            self.summary = nil
            // S70: rx/tx from the last stats before close; `close()` waits for a pending request, and the 1 s
            // fallback emits without them so hangup never waits on stats.
            if let peerConnection {
                peerConnection.statistics { @Sendable report in
                    emitter.emit(MediaRtpStats.fields(report.statistics.values.map { ($0.type, $0.values as [String: Any]) }))
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + 1) { emitter.emit([:]) }
            } else {
                emitter.emit([:])
            }
        }
        let stopFields = "previousState=\(state.logLabel) callID=\(callID ?? "nil") candidates=\(generatedCandidateCount)"
            + " relayCandidates=\(relayCandidateCount) gracePending=\(grace.isPending)"
        Self.log.notice("stop \(stopFields, privacy: .public)")
        cancelGrace()
        // `reason` nil is a rejoin attempt's own `start`, which runs inside `rejoinTask`: cancelling it would
        // cancel the attempt.
        if reason != nil {
            rejoinTask?.cancel()
            rejoinTask = nil
            rejoin = nil
        }
        statsTask?.cancel()
        statsTask = nil
        activeAttempt = nil
        MediaProbeManager.shared.cancelInFlight()
        cleanupTransport()
        callID = nil
        activeSession = nil
        activeSessionIdentity = nil
        managedByCallKit = false
        automaticallyRetryTLS = false
        finalFailure = nil
        isMuted = false
        isSpeakerEnabled = false
        microphoneAvailable = false
        state = .idle
        let waiters = callKitAudioWaiters
        callKitAudioWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func startPeriodicStats(callID: String) {
        statsTask?.cancel()
        let window = MediaRtpWindow()
        statsTask = Task { @MainActor [weak self] in
            while (try? await Task.sleep(for: .seconds(30))) != nil {
                guard let self, self.callID == callID, let peer = self.peerConnection else { continue }
                let muted = self.isMuted
                let peerID = ObjectIdentifier(peer)
                peer.statistics { @Sendable report in
                    let stats = report.statistics.values.map { ($0.type, $0.values as [String: Any]) }
                    var fields = MediaRtpStats.fields(stats)
                    if var rx = fields["rx"] as? [String: Any] {
                        rx.merge(window.fields(stats, peerID: peerID)) { _, new in new }
                        fields["rx"] = rx
                    }
                    fields["muted"] = muted
                    Diag.shared.log("media.stats", fields, callId: callID)
                }
            }
        }
    }

    @discardableResult
    func setMuted(_ muted: Bool) -> Bool {
        // S73: between rejoin attempts there is no track; the choice is kept and applied to the next one.
        guard localAudioTrack != nil || rejoin != nil else { return false }
        localAudioTrack?.isEnabled = !muted
        rejoin?.muted = muted
        isMuted = muted
        return true
    }

    @discardableResult
    func setSpeaker(_ enabled: Bool) -> Bool {
        let mutation = PhoneAudioRoutePolicy.speakerMutation(
            ownsActivation: ownsAudioSessionActivation,
            callKitAudioActive: callKitAudioActive
        )
        guard mutation != .none else { return false }
        rtcAudioSession.lockForConfiguration()
        defer { rtcAudioSession.unlockForConfiguration() }
        do {
            switch mutation {
            case .none:
                return false
            case .categoryOptions:
                try applyCategoryOptionsLocked(speakerEnabled: enabled)
            case .portOverride:
                try rtcAudioSession.overrideOutputAudioPort(
                    PhoneAudioRoutePolicy.portOverride(speakerEnabled: enabled)
                )
            }
            isSpeakerEnabled = enabled
            return true
        } catch {
            return false
        }
    }

    func prepareCallKitAnswerAudio() async {
        if CallKitAudioSessionPolicy.shouldRequestRecordPermission(Self.microphonePermission()) {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        rtcAudioSession.ignoresPreferredAttributeConfigurationErrors =
            CallKitAudioSessionPolicy.ignoresPreferredAttributeConfigurationErrors
        try? configurePhoneAudioSession(managedByCallKit: true)
    }

    func preflightMicrophonePermission() async {
        guard CallKitAudioSessionPolicy.shouldRequestRecordPermission(Self.microphonePermission()) else { return }
        _ = await AVAudioApplication.requestRecordPermission()
    }

    func callKitDidActivate(_ audioSession: AVAudioSession) {
        Self.log.notice("callkit audio activated hasAttempt=\(self.activeAttempt != nil, privacy: .public)")
        summary?.callKitAudio = true
        callKitAudioActive = true
        rtcAudioSession.audioSessionDidActivate(audioSession)
        if CallKitAudioSessionPolicy.shouldEnableAudioOnActivate(hasCallAttempt: activeAttempt != nil) {
            rtcAudioSession.isAudioEnabled = true
        }
        let waiters = callKitAudioWaiters
        callKitAudioWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func callKitDidDeactivate(_ audioSession: AVAudioSession) {
        Self.log.notice("callkit audio deactivated hasAttempt=\(self.activeAttempt != nil, privacy: .public)")
        callKitAudioActive = false
        rtcAudioSession.isAudioEnabled = false
        rtcAudioSession.audioSessionDidDeactivate(audioSession)
    }

    private func ensureCurrent(_ attempt: UUID) throws {
        guard activeAttempt == attempt else { throw CancellationError() }
    }

    /// The single exit for every terminal media failure — the `start` catch, a delegate-reported ICE failure and an
    /// expired `disconnected` grace all land here, so they cannot drift apart.
    ///
    /// S18 decision 6: audio failing is not the call failing. The call is kept for `MediaGracePolicy.grace` with a
    /// "重试音频 / 结束通话" choice, and only a grace that expires without media ends it. A call the server already
    /// revoked is ended at once instead — there is nothing left to retry.
    private func handleTerminalFailure(transport: MediaTransport, error: Error) {
        // S36 C3: the one place every terminal media failure passes through, so `media.failed` cannot drift.
        Diag.shared.log("media.failed", [
            "transport": transport.label,
            "reason": (error as? MediaSessionError).map { String(describing: $0) } ?? "\(type(of: error))",
            "message": error.localizedDescription
        ], callId: callID)
        cleanupTransport()
        activeAttempt = nil
        guard let callID else { return }
        state = .failed(transport, MediaFailureMessagePolicy.message(for: error, transport: transport))
        switch MediaGracePolicy.plan(for: error) {
        case .endImmediately:
            Self.log.error("media failed, ending now callID=\(callID, privacy: .public) reason=server-ended")
            endHeldCall(callID: callID, reason: "server_ended")
        case .holdForGrace:
            Self.log.error("""
                media failed, holding call callID=\(callID, privacy: .public) \
                graceSeconds=\(MediaGracePolicy.graceSeconds, privacy: .public)
                """)
            beginGrace(callID: callID)
        }
    }

    /// The transport of an attempt that may still fail. `.failed` returns nil so a held call is not failed twice.
    private var activeTransport: MediaTransport? {
        switch state {
        case let .connecting(transport): transport
        case let .connected(transport): transport
        case .failed, .idle: nil
        }
    }

    /// An established leg failed (ICE `failed`, or `disconnected` past its 5 s grace). S73 D3: the CallKit call and
    /// the bridge room stay; the leg is rejoined with a fresh peer instead of the old one-shot TLS fallback.
    private func handleIceFailure(transport: MediaTransport, error: MediaSessionError, reason: String) {
        guard callID != nil, let activeSession, let activeSessionIdentity,
              activeSession.isCurrentSession(activeSessionIdentity) else {
            handleTerminalFailure(transport: transport, error: error)
            return
        }
        Self.log.error("leg failed, rejoining reason=\(reason, privacy: .public)")
        rejoin = RejoinEpisode(
            reason: reason, failedLeg: transport, muted: isMuted, speaker: isSpeakerEnabled,
            wentOffline: MediaRejoinPolicy.isOffline(pathLabel: MediaNetworkGenerationSource.shared.currentPathLabel())
        )
        scheduleRejoinAttempt(after: .zero)
    }

    /// Tears the dead peer down but keeps the call, the mute/speaker choice and a `.connecting` state, so the view
    /// shows the reconnect line rather than a failure, then runs the next attempt after `delay`.
    private func scheduleRejoinAttempt(after delay: Duration) {
        guard let episode = rejoin, let callID, let session = activeSession,
              let identity = activeSessionIdentity else { return }
        cleanupTransport()
        activeAttempt = nil
        isMuted = episode.muted
        isSpeakerEnabled = episode.speaker
        state = .connecting(MediaRejoinPolicy.transport(
            forAttempt: episode.attempt + 1, failedLeg: episode.failedLeg, wentOffline: episode.wentOffline
        ))
        // From `continueRejoin` this runs inside the old `rejoinTask`; cancelling it is safe only because `start`
        // returns right after with no further `await`.
        rejoinTask?.cancel()
        rejoinTask = Task { @MainActor [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            // S73c: no attempt while offline; start as soon as the path is back. At the window's end the attempt
            // runs anyway, fails offline and `continueRejoin` gives up with that real error.
            // ponytail: 250 ms poll of the existing monitor's label; a path-change callback if this ever matters.
            while !Task.isCancelled, let episode = self?.rejoin,
                  episode.startedAt.duration(to: .now) < MediaRejoinPolicy.window,
                  MediaRejoinPolicy.isOffline(pathLabel: MediaNetworkGenerationSource.shared.currentPathLabel()) {
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard let self, !Task.isCancelled, self.callID == callID, var episode = rejoin else { return }
            episode.attempt += 1
            episode.attemptStartedAt = .now
            rejoin = episode
            summary?.rejoins += 1
            await start(
                callID: callID, session: session,
                transport: MediaRejoinPolicy.transport(
                    forAttempt: episode.attempt, failedLeg: episode.failedLeg, wentOffline: episode.wentOffline
                ),
                managedByCallKit: managedByCallKit, automaticallyRetryTLS: false,
                onFinalFailure: finalFailure, requiredSessionIdentity: identity
            )
        }
    }

    private func continueRejoin(after error: Error, transport: MediaTransport) {
        guard var episode = rejoin else { return }
        let offline = MediaRejoinPolicy.isOffline(pathLabel: MediaNetworkGenerationSource.shared.currentPathLabel())
        logRejoin(episode, transport: transport, ok: false, error: error, offline: offline)
        let probeRetry = !episode.needsProbe && MediaRejoinPolicy.isProbeRequired(error)
        switch MediaRejoinPolicy.next(
            after: error, attemptsMade: episode.attempt, elapsed: episode.startedAt.duration(to: .now),
            sinceAttemptStart: episode.attemptStartedAt.duration(to: .now), offline: offline, probeRetry: probeRetry
        ) {
        case let .retry(delay):
            if probeRetry { episode.needsProbe = true }
            if offline { episode.wentOffline = true }
            if offline || probeRetry || MediaRejoinPolicy.isNetworkError(error) {
                // S73c/S73d: not counted, so the next attempt keeps this attempt's number and transport.
                episode.attempt -= 1
                rejoin = episode
            }
            scheduleRejoinAttempt(after: delay)
        case .giveUp:
            rejoin = nil
            rejoinTask = nil
            handleTerminalFailure(transport: transport, error: error)
        }
    }

    private func logRejoin(
        _ episode: RejoinEpisode, transport: MediaTransport, ok: Bool, error: Error? = nil, offline: Bool = false,
        probeSkipped: Bool? = nil
    ) {
        var fields: [String: Any] = [
            "attempt": episode.attempt, "reason": episode.reason, "transport": transport.label,
            "ms": Diag.ms(since: episode.attemptStartedAt), "downMs": Diag.ms(since: episode.startedAt),
            "ok": ok, "probeSkipped": probeSkipped ?? !episode.needsProbe
        ]
        if let error { fields["error"] = (error as? MediaSessionError).map { String(describing: $0) } ?? "\(type(of: error))" }
        if offline { fields["offline"] = true }
        if episode.wentOffline { fields["wentOffline"] = true }
        Diag.shared.log("media.rejoin", fields, callId: callID)
    }

    /// S18 decision 6: a relay that drops after it connected gets 5 s to come back — a brief Wi-Fi hiccup used to be
    /// indistinguishable from a dead relay.
    private func beginDisconnectGrace(transport: MediaTransport, peer: LKRTCPeerConnection) {
        guard disconnectGraceTask == nil else { return }
        if iceDisconnectedAt == nil { iceDisconnectedAt = .now }
        let seconds = MediaIceWaitPolicy.disconnectGrace.components.seconds
        Self.log.error("ice disconnected, holding graceSeconds=\(seconds, privacy: .public)")
        disconnectGraceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: MediaIceWaitPolicy.disconnectGrace)
            guard let self, !Task.isCancelled, peerConnection === peer, activeAttempt != nil else { return }
            disconnectGraceTask = nil
            guard !MediaIceWaitPolicy.isUsable(peer.iceConnectionState.mediaState) else {
                Self.log.notice("ice recovered after disconnect")
                noteIceRecovered()
                return
            }
            handleIceFailure(transport: transport, error: .iceConnectionFailed(transport), reason: "disconnected")
        }
    }

    private func noteIceRecovered() {
        guard let since = iceDisconnectedAt else { return }
        iceDisconnectedAt = nil
        Diag.shared.log("media.ice_recovered", ["downMs": Diag.ms(since: since)], callId: callID)
    }

    private func beginGrace(callID: String) {
        graceTask?.cancel()
        grace.begin(callID: callID)
        summary?.graceUsed = true
        graceDeadline = MediaGracePolicy.deadline(from: .now)
        graceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: MediaGracePolicy.grace)
            guard let self, !Task.isCancelled else { return }
            graceDeadline = nil
            guard case .failed = state, self.callID == callID, grace.consume(callID: callID) else { return }
            Self.log.error("media grace expired, ending call callID=\(callID, privacy: .public)")
            Diag.shared.log("media.grace_expired", ["graceSeconds": MediaGracePolicy.graceSeconds], callId: callID)
            endHeldCall(callID: callID, reason: "grace_expired")
        }
    }

    private func cancelGrace() {
        graceTask?.cancel()
        graceTask = nil
        graceDeadline = nil
        grace.cancel()
    }

    /// Runs the owner's end handler exactly once, then releases the session. The handler posts the call end and
    /// reports the CallKit end, so it must run before `stop()` clears it.
    private func endHeldCall(callID: String, reason: String) {
        let handler = finalFailure
        cancelGrace()
        stop(reason: reason)
        handler?(callID)
    }

    private func requestMediaOptions(
        callID: String, transport: MediaTransport, session: SessionStore, sessionIdentity: UUID, skipProbe: Bool = false
    ) async throws -> MediaOptionsResponse {
        // S73d: a rejoin's call already has its node fixed (Control's `call.media_node_id` branch ignores probes), and
        // a probe racing Wi-Fi re-association after airplane mode threw `networkChanged` and burnt an attempt.
        if skipProbe {
            return try await session.request(
                "calls/\(callID)/media/options", method: "POST",
                body: MediaOptionsRequest(
                    transport: transport, networkGeneration: MediaNetworkGenerationSource.shared.currentGeneration()
                ),
                timeoutInterval: 6, requiredSessionIdentity: sessionIdentity
            )
        }
        do {
            let generation = try await MediaProbeManager.shared.prepare(
                session: session, requiredSessionIdentity: sessionIdentity
            )
            return try await session.request(
                "calls/\(callID)/media/options", method: "POST",
                body: MediaOptionsRequest(transport: transport, networkGeneration: generation),
                timeoutInterval: 6, requiredSessionIdentity: sessionIdentity
            )
        } catch APIError.server(409, _, _) {
            MediaProbeManager.shared.invalidateEvidence()
            let generation = try await MediaProbeManager.shared.prepare(
                session: session, requiredSessionIdentity: sessionIdentity, force: true
            )
            return try await session.request(
                "calls/\(callID)/media/options", method: "POST",
                body: MediaOptionsRequest(transport: transport, networkGeneration: generation),
                timeoutInterval: 6, requiredSessionIdentity: sessionIdentity
            )
        }
    }

    private func makePeerConnection(relay: MediaIceServer) throws -> LKRTCPeerConnection {
        let configuration = LKRTCConfiguration()
        configuration.iceTransportPolicy = .relay
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherOnce
        configuration.audioJitterBufferFastAccelerate = MediaReceivePolicy.audioJitterBufferFastAccelerate
        configuration.audioJitterBufferMaxPackets = MediaReceivePolicy.audioJitterBufferMaxPackets
        // The phone enumerates ~18 interfaces (Wi-Fi, four cellular, ten IMS `ipsec*`/`utun*` tunnels) and allocates
        // a TURN port on each; the tunnel allocations never finish. Pruning duplicate TURN ports and dropping
        // link-local interfaces cuts the useless allocations.
        configuration.shouldPruneTurnPorts = true
        configuration.disableLinkLocalNetworks = true
        // S45, confirmed in production: `.lowCost` used to be unconditional, and on a cellular-only phone it
        // discarded the cellular interface itself — the always-present IMS tunnels are the "cheaper" network it
        // kept instead. Every call on 4G then gathered zero relay candidates while the TURN host saw no packet
        // from the phone. The filter now applies only where it was proven, on Wi-Fi and Ethernet.
        let candidateNetwork = MediaNetworkGenerationSource.shared.candidateNetworkChoice()
        configuration.candidateNetworkPolicy = candidateNetwork == .lowCost ? .lowCost : .all
        candidateNetworkLabel = candidateNetwork.label
        configuration.iceServers = [LKRTCIceServer(urlStrings: relay.urls, username: relay.username, credential: relay.credential)]
        let peerConstraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = factory.peerConnection(with: configuration, constraints: peerConstraints, delegate: self) else {
            throw MediaSessionError.peerCreationFailed
        }
        let audioConstraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: [
            "googEchoCancellation": "true",
            "googAutoGainControl": "true",
            "googNoiseSuppression": "true"
        ])
        let source = factory.audioSource(with: audioConstraints)
        let track = factory.audioTrack(with: source, trackId: "vodog-microphone")
        guard peer.add(track, streamIds: ["vodog-audio"]) != nil else {
            peer.close()
            throw MediaSessionError.peerCreationFailed
        }
        // S73: a rejoin's new track starts in the mute state the call already had.
        track.isEnabled = !isMuted
        localAudioTrack = track
        microphoneAvailable = true
        return peer
    }

    private func createOffer(on peer: LKRTCPeerConnection) async throws -> LKRTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            let constraints = LKRTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
            peer.offer(for: constraints) { description, error in
                if let error { continuation.resume(throwing: error) }
                else if let description { continuation.resume(returning: description) }
                else { continuation.resume(throwing: MediaSessionError.missingLocalDescription) }
            }
        }
    }

    private func setLocalDescription(_ description: LKRTCSessionDescription, on peer: LKRTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    private func setRemoteDescription(_ description: LKRTCSessionDescription, on peer: LKRTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(description) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    /// Waits for relay candidates rather than for `iceGatheringState == .complete`: on a phone with IMS tunnels the
    /// completion event never arrives, and requiring it meant `media/offer` was never sent at all.
    private func waitForRelayCandidates(
        on peer: LKRTCPeerConnection, transport: MediaTransport, attempt: UUID
    ) async throws {
        let startedAt = ContinuousClock.now
        while true {
            try ensureCurrent(attempt)
            guard peerConnection === peer else { throw CancellationError() }
            // The delegate's count arrives through a MainActor hop, so it can lag the peer's own state by a poll; with
            // a relay-only policy every `a=candidate` line in the local description is a relay candidate, and it is
            // written synchronously. Taking the larger of the two keeps a fast `.complete` from reading as "nothing".
            let describedCandidates = Self.candidateLineCount(peer.localDescription?.sdp ?? "")
            let decision = MediaRelayGatheringPolicy.decide(
                gatheringComplete: peer.iceGatheringState == .complete,
                relayCandidateCount: max(relayCandidateCount, describedCandidates),
                elapsed: startedAt.duration(to: .now),
                sinceFirstRelayCandidate: firstRelayCandidateAt.map { $0.duration(to: .now) }
            )
            let fields = "elapsedMs=\(Self.elapsedMilliseconds(since: startedAt)) relayCandidates=\(relayCandidateCount)"
                + " described=\(describedCandidates) candidates=\(generatedCandidateCount)"
                + " gathering=\(peer.iceGatheringState.logLabel)"
            // S36 C3 / R1 H1: `network` rides on every event, so a relay gathered (or not gathered) while the
            // phone sat on a car's Wi-Fi is readable without guessing which interface libwebrtc chose.
            let diagFields: [String: Any] = [
                "elapsedMs": Self.elapsedMilliseconds(since: startedAt), "relayCandidates": relayCandidateCount,
                "described": describedCandidates, "candidates": generatedCandidateCount,
                "gathering": peer.iceGatheringState.logLabel, "transport": transport.label,
                "netPolicy": candidateNetworkLabel
            ]
            switch decision {
            case .proceed:
                Self.log.notice("relay candidates ready \(fields, privacy: .public)")
                Diag.shared.log("media.relay_candidates", diagFields, callId: callID)
                return
            case .noRelayCandidate:
                Self.log.error("no relay candidate \(fields, privacy: .public)")
                Diag.shared.log(
                    "media.relay_candidates", diagFields.merging(["ok": false]) { _, new in new }, callId: callID
                )
                throw MediaSessionError.noRelayCandidate(transport)
            case .wait:
                try await Task.sleep(for: MediaRelayGatheringPolicy.pollInterval)
            }
        }
    }

    /// Candidates alone never carried audio. A relay that gathers but never connects used to sit in `checking` until
    /// the user hung up; it now fails at `MediaIceWaitPolicy.connectTimeout` and goes through the retry/fail path.
    private func waitForIceConnection(
        on peer: LKRTCPeerConnection, transport: MediaTransport, attempt: UUID
    ) async throws {
        let startedAt = ContinuousClock.now
        for _ in 0..<MediaIceWaitPolicy.connectPollCount {
            try ensureCurrent(attempt)
            guard peerConnection === peer else { throw CancellationError() }
            switch MediaIceWaitPolicy.progress(for: peer.iceConnectionState.mediaState) {
            case .connected:
                Self.log.notice("ice connected elapsedMs=\(Self.elapsedMilliseconds(since: startedAt), privacy: .public)")
                if let summary, summary.connectMs == nil { self.summary?.connectMs = Diag.ms(since: summary.startedAt) }
                return
            case .failed:
                Self.log.error("ice failed while connecting state=\(peer.iceConnectionState.logLabel, privacy: .public)")
                throw MediaSessionError.iceConnectionFailed(transport)
            case .waiting:
                try await Task.sleep(for: MediaIceWaitPolicy.connectPollInterval)
            }
        }
        let fields = "elapsedMs=\(Self.elapsedMilliseconds(since: startedAt)) ice=\(peer.iceConnectionState.logLabel)"
        Self.log.error("ice connect timed out \(fields, privacy: .public)")
        throw MediaSessionError.iceConnectTimedOut(transport)
    }

    nonisolated private static func elapsedMilliseconds(since start: ContinuousClock.Instant) -> Int {
        Diag.ms(since: start)
    }

    /// SDP uses CRLF, and Swift treats "\r\n" as a single `Character`, so splitting on "\n" never split the offer at
    /// all — that is why the log reported `mLines=0` for a valid offer.
    nonisolated private static func sdpLines(_ sdp: String) -> [Substring] {
        sdp.split(whereSeparator: \.isNewline)
    }

    nonisolated private static func mediaLineCount(_ sdp: String) -> Int {
        sdpLines(sdp).filter { $0.hasPrefix("m=") }.count
    }

    nonisolated private static func candidateLineCount(_ sdp: String) -> Int {
        sdpLines(sdp).filter { $0.hasPrefix("a=candidate") }.count
    }

    /// `a=candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> …`
    nonisolated private static func candidateTypes(in sdp: String) -> String {
        let types = sdpLines(sdp)
            .filter { $0.contains("candidate:") }
            .compactMap { candidateType(in: String($0)) }
        return types.isEmpty ? "none" : Array(Set(types)).sorted().joined(separator: ",")
    }

    nonisolated private static func candidateType(in line: String) -> String? {
        let tokens = line.split(separator: " ").map(String.init)
        guard let index = tokens.firstIndex(of: "typ"), tokens.indices.contains(index + 1) else { return nil }
        return tokens[index + 1]
    }

    /// Host and server-reflexive addresses identify the user, so only the relayed address (the TURN allocation) is
    /// logged; `raddr` is never logged.
    nonisolated private static func candidateFields(_ sdp: String) -> String {
        let tokens = sdp.split(separator: " ").map(String.init)
        let type = candidateType(in: sdp) ?? "unknown"
        let proto = tokens.count > 2 ? tokens[2].lowercased() : "unknown"
        let port = tokens.count > 5 ? tokens[5] : "unknown"
        var fields = "typ=\(type) proto=\(proto) port=\(port)"
        if type == "relay", tokens.count > 4 { fields += " relayAddress=\(tokens[4])" }
        return fields
    }

    nonisolated private static func failureFields(_ error: Error) -> String {
        var fields = "errorType=\(String(describing: type(of: error))) message=\(error.localizedDescription)"
        if let apiError = error as? APIError {
            fields += " serverCode=\(apiError.serverCode ?? "nil")"
            if case let .server(status, _, _) = apiError { fields += " httpStatus=\(status)" }
        }
        return fields
    }

    /// iOS only shows the microphone prompt when the app asks for it; the usage description alone never grants
    /// access. Without the grant the voice-processing audio unit cannot open a record path and the whole call —
    /// both directions — stays silent, which is why this runs before the session is configured.
    private static func microphonePermission() -> CallKitAudioSessionPolicy.MicrophonePermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        case .undetermined: .undetermined
        @unknown default: .unknown
        }
    }

    private func requireMicrophonePermission() async throws {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return
        case .denied:
            throw MediaSessionError.microphonePermissionDenied
        case .undetermined:
            let granted = await AVAudioApplication.requestRecordPermission()
            guard granted else { throw MediaSessionError.microphonePermissionDenied }
        @unknown default:
            return
        }
    }

    /// Re-asserts the call audio session after an activation or audio-unit failure so a recoverable problem does not
    /// leave a connected call without audio.
    private func recoverAudioSessionIfNeeded() {
        switch CallKitAudioSessionPolicy.recoverAction(
            hasCallAttempt: activeAttempt != nil,
            managedByCallKit: managedByCallKit,
            callKitAudioActive: callKitAudioActive,
            ownsActivation: ownsAudioSessionActivation
        ) {
        case .none:
            return
        case .reenableAudioOnly:
            rtcAudioSession.isAudioEnabled = true
        case .setActiveAndEnable:
            rtcAudioSession.lockForConfiguration()
            do {
                try rtcAudioSession.setActive(true)
            } catch {
                Diag.shared.log("audio.session", [
                    "action": "activate", "owner": "app", "ok": false, "message": error.localizedDescription
                ], callId: callID)
            }
            rtcAudioSession.unlockForConfiguration()
            if !notifiedManualActivation {
                rtcAudioSession.audioSessionDidActivate(AVAudioSession.sharedInstance())
                notifiedManualActivation = true
            }
            rtcAudioSession.isAudioEnabled = true
        }
    }

    /// Returns on activation, on `stop()`, or after `MediaIceWaitPolicy.callKitAudioTimeout`; the caller tells
    /// them apart by `ensureCurrent` and `callKitAudioActive`.
    private func waitForCallKitAudioIfNeeded() async {
        guard managedByCallKit, !callKitAudioActive else { return }
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: MediaIceWaitPolicy.callKitAudioTimeout)
            guard !Task.isCancelled, let self else { return }
            let waiters = callKitAudioWaiters
            callKitAudioWaiters.removeAll()
            waiters.forEach { $0.resume() }
        }
        defer { timeout.cancel() }
        await withCheckedContinuation { continuation in
            if callKitAudioActive {
                continuation.resume()
            } else {
                callKitAudioWaiters.append(continuation)
            }
        }
    }

    private func configurePhoneAudioSession(managedByCallKit: Bool) throws {
        rtcAudioSession.ignoresPreferredAttributeConfigurationErrors =
            CallKitAudioSessionPolicy.ignoresPreferredAttributeConfigurationErrors
        rtcAudioSession.lockForConfiguration()
        do {
            if managedByCallKit {
                try applyCategoryOptionsLocked(speakerEnabled: isSpeakerEnabled)
                rtcAudioSession.isAudioEnabled = callKitAudioActive
                rtcAudioSession.unlockForConfiguration()
                let fields = "owner=callkit category=playAndRecord mode=voiceChat"
                    + " audioEnabled=\(callKitAudioActive) ownsActivation=\(ownsAudioSessionActivation)"
                Self.log.notice("audio session configured \(fields, privacy: .public)")
                summary?.audioOwner = "callkit"
                return
            }
            let configuration = LKRTCAudioSessionConfiguration.webRTC()
            configuration.category = AVAudioSession.Category.playAndRecord.rawValue
            configuration.categoryOptions = PhoneAudioRoutePolicy.callCategoryOptions(speakerEnabled: false)
            configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
            configuration.sampleRate = 48_000
            configuration.ioBufferDuration = 0.02
            try rtcAudioSession.setConfiguration(configuration)
            try rtcAudioSession.setActive(true)
            ownsAudioSessionActivation = true
            rtcAudioSession.unlockForConfiguration()
        } catch {
            rtcAudioSession.unlockForConfiguration()
            Diag.shared.log("audio.session", [
                "action": managedByCallKit ? "configure" : "activate", "owner": managedByCallKit ? "callkit" : "app",
                "ok": false, "message": error.localizedDescription
            ], callId: callID)
            throw error
        }
        // useManualAudio=true requires this notify or the voice unit never starts (silent both ways).
        rtcAudioSession.audioSessionDidActivate(AVAudioSession.sharedInstance())
        notifiedManualActivation = true
        rtcAudioSession.isAudioEnabled = true
        isSpeakerEnabled = false
        let fields = "owner=app category=\(AVAudioSession.Category.playAndRecord.rawValue)"
            + " mode=\(AVAudioSession.Mode.voiceChat.rawValue) sampleRate=48000 ownsActivation=\(ownsAudioSessionActivation)"
        Self.log.notice("audio session configured \(fields, privacy: .public)")
        summary?.audioOwner = "app"
        summary?.outputs = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType.rawValue)
            .joined(separator: ",")
    }

    private func applyCategoryOptionsLocked(speakerEnabled: Bool) throws {
        try rtcAudioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: PhoneAudioRoutePolicy.callCategoryOptions(speakerEnabled: speakerEnabled)
        )
    }

    private func cleanupTransport() {
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
        iceDisconnectedAt = nil
        rtcAudioSession.isAudioEnabled = false
        if notifiedManualActivation {
            rtcAudioSession.audioSessionDidDeactivate(AVAudioSession.sharedInstance())
            notifiedManualActivation = false
        }
        localAudioTrack?.isEnabled = false
        localAudioTrack = nil
        isMuted = false
        isSpeakerEnabled = false
        microphoneAvailable = false
        peerConnection?.delegate = nil
        peerConnection?.close()
        peerConnection = nil
        if ownsAudioSessionActivation {
            rtcAudioSession.lockForConfiguration()
            try? rtcAudioSession.setActive(false)
            rtcAudioSession.unlockForConfiguration()
            ownsAudioSessionActivation = false
        }
    }
}

// S36b D1: `client.snapshot` reports the media state, so the label is no longer file-private.
extension CallMediaSession.State {
    var logLabel: String {
        switch self {
        case .idle: "idle"
        case let .connecting(transport): "connecting(\(transport.label))"
        case let .connected(transport): "connected(\(transport.label))"
        case let .failed(transport, _): "failed(\(transport.label))"
        }
    }
}

private extension LKRTCSignalingState {
    var logLabel: String {
        switch self {
        case .stable: "stable"
        case .haveLocalOffer: "haveLocalOffer"
        case .haveLocalPrAnswer: "haveLocalPrAnswer"
        case .haveRemoteOffer: "haveRemoteOffer"
        case .haveRemotePrAnswer: "haveRemotePrAnswer"
        case .closed: "closed"
        @unknown default: "unknown(\(rawValue))"
        }
    }
}

private extension LKRTCIceGatheringState {
    var logLabel: String {
        switch self {
        case .new: "new"
        case .gathering: "gathering"
        case .complete: "complete"
        @unknown default: "unknown(\(rawValue))"
        }
    }
}

extension LKRTCIceConnectionState {
    /// Mirrors WebRTC's state onto the app's own enum so `MediaIceWaitPolicy` (and its tests) stay WebRTC-free.
    var mediaState: MediaIceState {
        switch self {
        case .new: .new
        case .checking: .checking
        case .connected: .connected
        case .completed: .completed
        case .failed: .failed
        case .disconnected: .disconnected
        case .closed: .closed
        case .count: .unknown
        @unknown default: .unknown
        }
    }
}

private extension LKRTCIceConnectionState {
    var logLabel: String {
        switch self {
        case .new: "new"
        case .checking: "checking"
        case .connected: "connected"
        case .completed: "completed"
        case .failed: "failed"
        case .disconnected: "disconnected"
        case .closed: "closed"
        case .count: "count"
        @unknown default: "unknown(\(rawValue))"
        }
    }
}

extension CallMediaSession: LKRTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {
        Self.log.notice("signaling state=\(stateChanged.logLabel, privacy: .public)")
    }
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {
        Self.log.notice("stream added audioTracks=\(stream.audioTracks.count, privacy: .public)")
    }
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {
        Self.log.notice("stream removed audioTracks=\(stream.audioTracks.count, privacy: .public)")
    }
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {
        Self.log.notice("renegotiation needed")
    }
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {
        Self.log.notice("ice connection state=\(newState.logLabel, privacy: .public)")
        let mediaState = newState.mediaState
        let label = newState.logLabel
        Task { @MainActor [weak self] in
            guard let self else { return }
            // S36 C3: logged before the liveness guard — a transition on a superseded peer is still evidence.
            var fields: [String: Any] = ["state": label]
            if let offerSentAt { fields["ms"] = Diag.ms(since: offerSentAt) }
            Diag.shared.log("media.ice", fields, callId: callID)
            // Only the peer of the live attempt may drive state; a closed or superseded peer reports late.
            guard self.peerConnection === peerConnection, activeAttempt != nil else { return }
            if !handshakeInFlight, MediaIceWaitPolicy.warrantsCallStateCheck(mediaState), let callID {
                IncomingCallManager.shared.checkRemoteEndNow(callID: callID)
            }
            switch mediaState {
            case .connected, .completed:
                disconnectGraceTask?.cancel()
                disconnectGraceTask = nil
                noteIceRecovered()
                if case let .connecting(transport) = state { state = .connected(transport) }
            case .failed, .closed:
                // During the handshake the wait loops observe ICE and throw, so `start` owns the failure; acting here
                // too would run a second attempt alongside the first.
                guard !handshakeInFlight, let transport = activeTransport else { return }
                handleIceFailure(transport: transport, error: .iceConnectionFailed(transport), reason: label)
            case .disconnected:
                guard !handshakeInFlight, let transport = activeTransport else { return }
                beginDisconnectGrace(transport: transport, peer: peerConnection)
            case .new, .checking, .unknown:
                break
            }
        }
    }
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {
        Self.log.notice("ice gathering state=\(newState.logLabel, privacy: .public)")
    }
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        let fields = "mid=\(candidate.sdpMid ?? "nil") \(Self.candidateFields(candidate.sdp))"
        Self.log.notice("ice candidate \(fields, privacy: .public)")
        let isRelay = Self.candidateType(in: candidate.sdp) == "relay"
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            generatedCandidateCount += 1
            guard isRelay else { return }
            relayCandidateCount += 1
            if firstRelayCandidateAt == nil { firstRelayCandidateAt = .now }
        }
    }
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {
        Self.log.notice("ice candidates removed count=\(candidates.count, privacy: .public)")
    }
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
        Self.log.notice("data channel opened label=\(dataChannel.label, privacy: .public)")
    }
}

/// Audio-session problems used to be invisible: a failed audio-unit start left a connected call silent with no error
/// and no retry. These callbacks re-assert the session when it is recoverable.
extension CallMediaSession: LKRTCAudioSessionDelegate {
    nonisolated func audioSession(_ audioSession: LKRTCAudioSession, audioUnitStartFailedWithError error: Error) {
        Self.log.error("audio unit start failed \(Self.failureFields(error), privacy: .public)")
        let message = error.localizedDescription
        Task { @MainActor [weak self] in
            Diag.shared.log("audio.unit_failed", ["message": message], callId: self?.callID)
            self?.recoverAudioSessionIfNeeded()
        }
    }

    nonisolated func audioSession(_ audioSession: LKRTCAudioSession, failedToSetActive active: Bool, error: Error) {
        let fields = "active=\(active) \(Self.failureFields(error))"
        Self.log.error("audio session failed to set active \(fields, privacy: .public)")
        let message = error.localizedDescription
        Task { @MainActor [weak self] in
            Diag.shared.log("audio.session", [
                "action": active ? "activate" : "deactivate", "owner": "webrtc", "ok": false, "message": message
            ], callId: self?.callID)
        }
        guard active else { return }
        Task { @MainActor [weak self] in self?.recoverAudioSessionIfNeeded() }
    }

    nonisolated func audioSession(_ audioSession: LKRTCAudioSession, didChangeCanPlayOrRecord canPlayOrRecord: Bool) {
        Self.log.notice("audio session canPlayOrRecord=\(canPlayOrRecord, privacy: .public)")
        guard canPlayOrRecord else { return }
        Task { @MainActor [weak self] in self?.recoverAudioSessionIfNeeded() }
    }
}

/// S69: what one call's media did, across every attempt, reported once as `media.summary` when it stops.
struct MediaCallSummary {
    let callID: String
    let startedAt = ContinuousClock.now
    var attempts = 0
    var transport = "udp"
    var tlsFallback = false
    var networkRetry = false
    var connectMs: Int?
    var graceUsed = false
    /// S73 D8: rejoin attempts started, successful or not.
    var rejoins = 0
    var audioOwner: String?
    var outputs: String?
    var callKitAudio = false

    func fields(
        finalState: String, endReason: String, candidates: Int, relayCandidates: Int, callKitAudio active: Bool
    ) -> [String: Any] {
        var out: [String: Any] = [
            "finalState": finalState, "transport": transport, "attempts": attempts, "tlsFallback": tlsFallback,
            "networkRetry": networkRetry, "candidates": candidates, "relayCandidates": relayCandidates,
            "graceUsed": graceUsed, "rejoins": rejoins, "endReason": endReason, "callKitAudio": callKitAudio || active,
            "ms": Diag.ms(since: startedAt)
        ]
        if let connectMs { out["connectMs"] = connectMs }
        if let audioOwner { out["audioOwner"] = audioOwner }
        if let outputs, !outputs.isEmpty { out["outputs"] = outputs }
        return out
    }
}

/// S70: emits one `media.summary` exactly once — with rx/tx when the stats arrive, without them on the fallback.
final class MediaSummaryEmitter: @unchecked Sendable {
    private let lock = NSLock()
    private var fields: [String: Any]?
    private let callID: String

    init(fields: [String: Any], callID: String) {
        self.fields = fields
        self.callID = callID
    }

    func emit(_ extra: [String: Any]) {
        let pending: [String: Any]? = lock.withLock {
            defer { fields = nil }
            return fields
        }
        guard let pending else { return }
        Diag.shared.log("media.summary", pending.merging(extra) { _, new in new }, callId: callID)
    }
}

/// S70 shared contract: receive/send quality counters from the audio inbound-rtp / outbound-rtp stats, same keys
/// and rounding as the web client.
enum MediaRtpStats {
    private static let rxCounts = [
        "packetsReceived", "packetsLost", "concealedSamples", "silentConcealedSamples", "totalSamplesReceived",
        "concealmentEvents",
        "insertedSamplesForDeceleration", "removedSamplesForAcceleration"
    ]

    /// `stats`: (type, values) per stats object. Returns `rx`/`tx` only when present.
    static func fields(_ stats: [(type: String, values: [String: Any])]) -> [String: Any] {
        var rx: [String: Any] = [:]
        var tx: [String: Any] = [:]
        for (type, values) in stats {
            guard (values["kind"] ?? values["mediaType"]) as? String == "audio" else { continue }
            let number = { (key: String) in values[key] as? NSNumber }
            if type == "inbound-rtp", rx.isEmpty {
                for key in rxCounts { if let value = number(key) { rx[key] = value.intValue } }
                if let jitter = number("jitter") { rx["jitterMs"] = tenth(jitter.doubleValue * 1000) }
                if let delay = number("jitterBufferDelay"), let emitted = number("jitterBufferEmittedCount"),
                   emitted.doubleValue > 0 {
                    rx["jitterBufferMs"] = tenth(delay.doubleValue / emitted.doubleValue * 1000)
                    // Same average for NetEq's target: jitterBufferMs well above it = backlog, near it = network jitter.
                    if let target = number("jitterBufferTargetDelay") {
                        rx["jitterBufferTargetMs"] = tenth(target.doubleValue / emitted.doubleValue * 1000)
                    }
                }
            } else if type == "outbound-rtp", tx.isEmpty {
                for key in ["packetsSent", "bytesSent"] { if let value = number(key) { tx[key] = value.intValue } }
            }
        }
        var out: [String: Any] = [:]
        if !rx.isEmpty { out["rx"] = rx }
        if !tx.isEmpty { out["tx"] = tx }
        return out
    }

    static func tenth(_ value: Double) -> Double { (value * 10).rounded() / 10 }
}

/// NetEq counters for the interval since the previous `media.stats` row of the same peer connection; the cumulative
/// `rx` fields average over the whole PC. A different `peerID` (first connect, S73 rejoin) starts a fresh window.
/// libwebrtc exposes no per-packet inter-arrival maximum, so none is reported.
final class MediaRtpWindow: @unchecked Sendable {
    private static let keys = [
        "jitterBufferDelay", "jitterBufferTargetDelay", "jitterBufferEmittedCount",
        "concealmentEvents", "removedSamplesForAcceleration", "packetsReceived"
    ]
    private let lock = NSLock()
    private var previous: (peerID: ObjectIdentifier, raw: [String: Double])?

    func fields(_ stats: [(type: String, values: [String: Any])], peerID: ObjectIdentifier) -> [String: Any] {
        guard let values = stats.first(where: {
            $0.type == "inbound-rtp" && ($0.values["kind"] ?? $0.values["mediaType"]) as? String == "audio"
        })?.values else { return [:] }
        let raw = Self.keys.reduce(into: [String: Double]()) { $0[$1] = (values[$1] as? NSNumber)?.doubleValue }
        let before: [String: Double]? = lock.withLock {
            defer { previous = (peerID, raw) }
            return previous?.peerID == peerID ? previous?.raw : nil
        }
        guard let before else { return [:] }
        let delta = { (key: String) -> Double? in
            guard let now = raw[key], let then = before[key] else { return nil }
            return now - then
        }
        var out: [String: Any] = [:]
        for (key, name) in [("concealmentEvents", "concealmentEventsWin"),
                            ("removedSamplesForAcceleration", "removedSamplesForAccelerationWin"),
                            ("packetsReceived", "packetsReceivedWin")] {
            if let value = delta(key) { out[name] = Int(value) }
        }
        if let emitted = delta("jitterBufferEmittedCount"), emitted > 0 {
            if let value = delta("jitterBufferDelay") { out["jitterBufferWinMs"] = MediaRtpStats.tenth(value / emitted * 1000) }
            if let value = delta("jitterBufferTargetDelay") {
                out["jitterBufferTargetWinMs"] = MediaRtpStats.tenth(value / emitted * 1000)
            }
        }
        return out
    }
}
