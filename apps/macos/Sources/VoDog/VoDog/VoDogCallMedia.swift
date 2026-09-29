import AVFoundation
import CoreAudio
import Foundation
import LiveKitWebRTC

/// S57 client-role media leg for a remote VoDog call: user media probes → `media/options` →
/// relay-only PeerConnection with a local **audio track** (not the gateway's `cellular-opus-v1` data
/// channel) → offer on the first relay candidate → `media/offer` → ICE connected. Port of iOS
/// `CallMediaSession.start` (L111-271) without CallKit/AVAudioSession; the LiveKitWebRTC ADM plays and
/// records through the Mac's default devices, never the DJI module's UAC (see `avoidModuleAudio`).
@MainActor
final class VoDogCallMedia: NSObject, ObservableObject {
    enum State: Equatable { case idle, connecting, connected, failed(String) }

    @Published private(set) var state: State = .idle
    @Published private(set) var muted = false
    private(set) var callID: String?

    private static let factory: LKRTCPeerConnectionFactory = {
        LKRTCInitializeSSL()
        return LKRTCPeerConnectionFactory()
    }()
    private var peer: LKRTCPeerConnection?
    private var track: LKRTCAudioTrack?
    private var attempt: UUID?
    private var relayCount = 0
    private var firstRelayAt: Date?

    private struct Failure: LocalizedError, CustomStringConvertible {
        var description: String
        var errorDescription: String? { description }
    }

    var statusText: String {
        switch state {
        case .idle: return L10n.tr("音频未连接")
        case .connecting: return L10n.tr("正在连接音频…")
        case .connected: return L10n.tr("音频已连接")
        case let .failed(message): return message
        }
    }

    /// UDP first, one TLS retry (UDP-hostile networks). Never ends the call: a failure is shown and
    /// 结束通话 stays available.
    func start(callID: String, account: VoDogAccount) async {
        stop()
        let attempt = UUID()
        self.attempt = attempt
        self.callID = callID
        state = .connecting
        let started = Date()
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            fail(attempt, account, "microphone_denied", L10n.tr("没有麦克风权限，请在系统设置中允许 VoDog 使用麦克风。"))
            return
        }
        var lastError: Error = Failure(description: "unknown")
        do {
            let generation = try await probe(account)
            for transport in ["udp", "tls"] {
                guard self.attempt == attempt else { return }
                do {
                    let devices = try await connect(callID: callID, transport: transport, generation: generation,
                                                    account: account, attempt: attempt)
                    guard self.attempt == attempt else { return }
                    state = .connected
                    account.diag("media.start", callId: callID, fields: devices.merging([
                        "transport": transport, "ms": Int(Date().timeIntervalSince(started) * 1_000)
                    ]) { _, new in new })
                    return
                } catch is CancellationError {
                    return
                } catch {
                    guard self.attempt == attempt else { return }
                    lastError = error
                    closePeer()
                    let api = error as? VoDogAPIError
                    // Authorization answers (revoked / not winner / gone) will not change over TLS.
                    if let api, [403, 404].contains(api.status) || api.code == "MEDIA_REVOKED" { break }
                }
            }
        } catch is CancellationError {
            return
        } catch {
            lastError = error
        }
        fail(attempt, account, "\(lastError)", L10n.tr("音频连接失败：%@", VoDogErrorText.text(for: lastError)),
             error: lastError)
    }

    func stop() {
        attempt = nil
        closePeer()
        callID = nil
        muted = false
        state = .idle
    }

    func setMuted(_ value: Bool) {
        track?.isEnabled = !value
        muted = value
    }

    private func fail(_ attempt: UUID, _ account: VoDogAccount, _ reason: String, _ message: String,
                      error: Error? = nil, site: String = #function) {
        guard self.attempt == attempt else { return }
        account.diag("media.failed", level: "warn", callId: callID, fields: ["reason": String(reason.prefix(200))])
        VoDogErrorText.shown(message, error: error, site: site)
        closePeer()
        self.attempt = nil
        state = .failed(message)
    }

    private func closePeer() {
        peer?.close()
        peer = nil
        track = nil
        relayCount = 0
        firstRelayAt = nil
    }

    // MARK: Handshake

    private func connect(callID: String, transport: String, generation: String, account: VoDogAccount,
                         attempt: UUID) async throws -> [String: Any] {
        var options: [String: Any]
        do {
            options = try await account.json("POST", "/calls/\(callID)/media/options",
                                             body: ["transport": transport, "networkGeneration": generation])
        } catch let error as VoDogAPIError where error.status == 409 && error.code != "MEDIA_REVOKED" {
            // iOS: a 409 means the probe evidence is missing or stale — probe again once and retry.
            let fresh = try await probe(account)
            options = try await account.json("POST", "/calls/\(callID)/media/options",
                                             body: ["transport": transport, "networkGeneration": fresh])
        }
        try ensureCurrent(attempt)
        guard let relay = VoDogPhonePolicy.validatedRelay(options, transport: transport) else {
            throw Failure(description: "invalid_relay_options")
        }

        let configuration = LKRTCConfiguration()
        configuration.iceServers = [LKRTCIceServer(urlStrings: relay.urls, username: relay.username,
                                                   credential: relay.credential)]
        configuration.iceTransportPolicy = .relay
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherOnce
        configuration.shouldPruneTurnPorts = true
        configuration.disableLinkLocalNetworks = true
        let devices = Self.avoidModuleAudio()
        guard let pc = Self.factory.peerConnection(
            with: configuration, constraints: LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil),
            delegate: self) else { throw Failure(description: "peer_creation") }
        let source = Self.factory.audioSource(with: LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: [
            "googEchoCancellation": "true", "googAutoGainControl": "true", "googNoiseSuppression": "true"
        ]))
        let audio = Self.factory.audioTrack(with: source, trackId: "vodog-microphone")
        guard pc.add(audio, streamIds: ["vodog-audio"]) != nil else {
            pc.close()
            throw Failure(description: "track_add")
        }
        peer = pc
        track = audio
        audio.isEnabled = !muted

        let generated = try await pc.offer(for: LKRTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil))
        try ensureCurrent(attempt, pc)
        try await pc.setLocalDescription(LKRTCSessionDescription(
            type: generated.type, sdp: VoDogOpusOffer.rewrite(sdp: generated.sdp)))

        let gatherStart = Date()
        while true {
            try ensureCurrent(attempt, pc)
            let described = (pc.localDescription?.sdp ?? "").components(separatedBy: "\n")
                .filter { $0.hasPrefix("a=candidate") }.count
            let decision = VoDogPhonePolicy.gatherDecision(
                complete: pc.iceGatheringState == .complete, relayCount: max(relayCount, described),
                elapsed: Date().timeIntervalSince(gatherStart), sinceFirstRelay: firstRelayAt.map { Date().timeIntervalSince($0) })
            if decision == .proceed { break }
            if decision == .noRelayCandidate { throw Failure(description: "no_relay_candidate") }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard let local = pc.localDescription?.sdp, !local.isEmpty else { throw Failure(description: "missing_local_description") }
        let answer = try await account.json("POST", "/calls/\(callID)/media/offer", body: ["type": "offer", "sdp": local])
        try ensureCurrent(attempt, pc)
        guard answer["type"] as? String == "answer", let sdp = answer["sdp"] as? String, !sdp.isEmpty else {
            throw Failure(description: "invalid_answer")
        }
        try await pc.setRemoteDescription(LKRTCSessionDescription(type: .answer, sdp: sdp))

        for _ in 0..<120 {   // 12 s
            try ensureCurrent(attempt, pc)
            switch pc.iceConnectionState {
            case .connected, .completed: return devices
            case .failed, .closed: throw Failure(description: "ice_failed")
            default: try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        throw Failure(description: "ice_connect_timeout")
    }

    private func ensureCurrent(_ attempt: UUID, _ pc: LKRTCPeerConnection? = nil) throws {
        guard self.attempt == attempt, pc == nil || peer === pc else { throw CancellationError() }
    }

    // MARK: Probes

    private static let probeSession = URLSession(configuration: {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 5
        return configuration
    }(), delegate: NoRedirect(), delegateQueue: nil)

    /// Control picks the media node only from fresh user-subject probe evidence (409 MEDIA_PROBE_REQUIRED
    /// otherwise). Same basic HTTPS RTT probes as `GatewayRuntime.runMediaProbes`, on the user routes.
    // ponytail: one fresh generation per media start (~one RTT per grant); cache it per network path if
    // answer latency ever matters.
    private func probe(_ account: VoDogAccount) async throws -> String {
        let generation = "mac-" + UUID().uuidString.lowercased()
        let options = try await account.json("POST", "/media/probes/options", body: ["networkGeneration": generation])
        var samples: [[String: Any]] = []
        for node in options["nodes"] as? [[String: Any]] ?? [] {
            guard let nodeId = node["nodeId"] as? String, let url = (node["probeUrl"] as? String).flatMap(URL.init(string:)),
                  url.scheme == "https" else { continue }
            for grant in node["grants"] as? [String] ?? [] {
                samples.append(await Self.probeSample(url: url, nodeId: nodeId, grant: grant))
            }
        }
        guard !samples.isEmpty else { throw Failure(description: "no_probe_nodes") }
        let batch = Array(samples.prefix(48))
        let result = try await account.json("POST", "/media/probes/results",
                                            body: ["networkGeneration": generation, "samples": batch])
        guard result["accepted"] as? Int == batch.count else { throw Failure(description: "probe_rejected") }
        return generation
    }

    private static func probeSample(url: URL, nodeId: String, grant: String) async -> [String: Any] {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("Bearer \(grant)", forHTTPHeaderField: "Authorization")
        let started = Date()
        do {
            let (data, response) = try await probeSession.data(for: request)
            let json = (try? JSONSerialization.jsonObject(with: data.prefix(4_096))) as? [String: Any] ?? [:]
            guard (response as? HTTPURLResponse)?.statusCode == 200, json["ok"] as? Bool == true,
                  json["nodeId"] as? String == nodeId else { return ["nodeId": nodeId, "outcome": "network_error"] }
            return ["nodeId": nodeId, "outcome": "ok", "httpsRttMs": min(Date().timeIntervalSince(started) * 1_000, 10_000)]
        } catch let error as URLError where error.code == .timedOut {
            return ["nodeId": nodeId, "outcome": "timeout"]
        } catch {
            return ["nodeId": nodeId, "outcome": "network_error"]
        }
    }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    // MARK: Audio devices

    /// The ADM follows the system default devices. The module's UAC ("AC Interface" / "AS Interface",
    /// 8 kHz) is never made default by macOS on its own, but if the user did, switch this call to the
    /// first other device so the remote call never fights the gateway leg for the modem audio.
    private static func avoidModuleAudio() -> [String: Any] {
        let adm = factory.audioDeviceModule
        let input = defaultDeviceName(kAudioHardwarePropertyDefaultInputDevice)
        let output = defaultDeviceName(kAudioHardwarePropertyDefaultOutputDevice)
        let inputs = adm.inputDevices.filter { !$0.isDefault }
        let outputs = adm.outputDevices.filter { !$0.isDefault }
        if let index = VoDogPhonePolicy.replacementDevice(current: input, candidates: inputs.map(\.name)) {
            adm.inputDevice = inputs[index]
        }
        if let index = VoDogPhonePolicy.replacementDevice(current: output, candidates: outputs.map(\.name)) {
            adm.outputDevice = outputs[index]
        }
        // Before the first call the ADM reports an unnamed placeholder: fall back to the CoreAudio default.
        func label(_ device: LKRTCIODevice, _ fallback: String?) -> String {
            device.isDefault || device.name.isEmpty ? fallback ?? "default" : device.name
        }
        return ["input": label(adm.inputDevice, input), "output": label(adm.outputDevice, output)]
    }

    private static func defaultDeviceName(_ selector: AudioObjectPropertySelector) -> String? {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != 0 else { return nil }
        var name: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        address.mSelector = kAudioObjectPropertyName
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name) == noErr, let name else { return nil }
        return name.takeRetainedValue() as String
    }
}

// MARK: - WebRTC callbacks (signaling thread → main actor)

extension VoDogCallMedia: LKRTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        guard candidate.sdp.contains(" typ relay") else { return }
        Task { @MainActor in
            guard self.peer === peerConnection else { return }
            self.relayCount += 1
            if self.firstRelayAt == nil { self.firstRelayAt = Date() }
        }
    }

    /// After connecting, a failed/closed relay is shown as an audio failure; the call itself stays up
    /// until the user ends it (iOS keeps a held call rather than dropping it on media loss).
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {
        guard newState == .failed else { return }
        Task { @MainActor in
            guard self.peer === peerConnection, self.state == .connected else { return }
            self.closePeer()
            self.attempt = nil
            self.state = .failed(L10n.tr("音频连接已中断"))
        }
    }

    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {}
}
