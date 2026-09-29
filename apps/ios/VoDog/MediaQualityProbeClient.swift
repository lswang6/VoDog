import Foundation
@preconcurrency import LiveKitWebRTC

struct MediaQualityProbeOptionsResponse: Decodable, Sendable {
    let networkGeneration: String
    let measurement: String
    let lifetimeMs: Int
    let sampleDurationMs: Int
    let packetIntervalMs: Int
    let maxPackets: Int
    let maxPacketBytes: Int
    let iceTransportPolicy: String
    let nodes: [MediaQualityProbeNode]
}

/// S69: with the feature off, a new Control answers 200 `{enabled:false, retryAfterMs}` instead of 503.
enum MediaQualityProbeOptionsReply: Decodable, Sendable {
    case disabled(retryAfterMs: Int)
    case options(MediaQualityProbeOptionsResponse)

    private struct Flag: Decodable { let enabled: Bool?; let retryAfterMs: Int? }

    init(from decoder: any Decoder) throws {
        let flag = try Flag(from: decoder)
        if flag.enabled == false {
            self = .disabled(retryAfterMs: flag.retryAfterMs ?? 3_600_000)
        } else {
            self = .options(try MediaQualityProbeOptionsResponse(from: decoder))
        }
    }
}

struct MediaQualityProbeNode: Decodable, Sendable {
    let nodeId: String
    let probeUrl: String
    let expiresAt: String
    let grant: String
    let iceServers: [MediaIceServer]
}

struct MediaQualityProbeResultsRequest: Encodable, Sendable {
    let networkGeneration: String
    let samples: [MediaQualityProbeSample]
}

struct MediaQualityProbeSample: Codable, Sendable, Equatable {
    let nodeId: String
    let outcome: MediaProbeOutcome
    let sent: Int
    let received: Int
    let connectionMs: Double?
    let rttMedianMs: Double?
    let rttP95Ms: Double?
    let jitterMs: Double?
    let sampleDurationMs: Double
}

private struct MediaQualityProbeDescription: Codable, Sendable {
    let type: String
    let sdp: String
}

enum MediaQualityProbeError: Error, Equatable {
    case invalidOptions
    case signaling
    case timedOut
}

enum MediaQualityProbeFrame {
    static func encode(sequence: UInt32, sentUs: UInt64) -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        bytes.replaceSubrange(0..<4, with: "CCQ1".utf8)
        for index in 0..<4 { bytes[4 + index] = UInt8(truncatingIfNeeded: sequence.bigEndian >> (index * 8)) }
        for index in 0..<8 { bytes[8 + index] = UInt8(truncatingIfNeeded: sentUs.bigEndian >> (index * 8)) }
        return Data(bytes)
    }

    static func decode(_ data: Data) -> (sequence: UInt32, sentUs: UInt64)? {
        guard data.count == 32, data.prefix(4) == Data("CCQ1".utf8),
              data[16..<32].allSatisfy({ $0 == 0 }) else { return nil }
        let sequence = data[4..<8].reduce(0) { ($0 << 8) | UInt32($1) }
        let sentUs = data[8..<16].reduce(0) { ($0 << 8) | UInt64($1) }
        guard sequence < 250 else { return nil }
        return (sequence, sentUs)
    }

    /// `jitterMs` is the median successive echo RTT difference. It is not RTP jitter.
    static func summarize(_ rtts: [Double]) -> (median: Double, p95: Double, jitter: Double)? {
        guard !rtts.isEmpty else { return nil }
        let sorted = rtts.sorted()
        let successive = Array(zip(rtts.dropFirst(), rtts)).map { abs($0.0 - $0.1) }.sorted()
        return (
            percentile(sorted, fraction: 0.5),
            percentile(sorted, fraction: 0.95),
            successive.isEmpty ? 0 : percentile(successive, fraction: 0.5)
        )
    }

    private static func percentile(_ sorted: [Double], fraction: Double) -> Double {
        sorted[min(sorted.count - 1, max(0, Int(ceil(Double(sorted.count) * fraction)) - 1))]
    }
}

enum MediaQualityProbeSDP {
    /// Called only after `iceGatheringState == .complete`. The native stack may
    /// omit the nontrickle marker, so add it at that truthful completion point.
    static func completedRelayOnly(_ raw: String) throws -> String {
        guard !raw.isEmpty, raw.utf8.count <= 64 * 1_024 else { throw MediaQualityProbeError.signaling }
        var lines = raw.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n").map(String.init)
        let candidates = lines.filter { $0.hasPrefix("a=candidate:") }
        guard !candidates.isEmpty, candidates.allSatisfy(isUDPRelayCandidate) else {
            throw MediaQualityProbeError.signaling
        }
        let completionCount = lines.filter { $0 == "a=end-of-candidates" }.count
        guard completionCount <= 1 else { throw MediaQualityProbeError.signaling }
        if completionCount == 0 { lines.append("a=end-of-candidates") }
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    private static func isUDPRelayCandidate(_ line: String) -> Bool {
        let fields = line.split(whereSeparator: \Character.isWhitespace).map(String.init)
        guard fields.count >= 8, fields[2].caseInsensitiveCompare("udp") == .orderedSame,
              let typeIndex = fields.firstIndex(where: { $0.caseInsensitiveCompare("typ") == .orderedSame }),
              typeIndex + 1 < fields.count else { return false }
        return fields[typeIndex + 1].caseInsensitiveCompare("relay") == .orderedSame
    }
}

enum MediaQualityProbeBudget {
    /// Returns the timeout value without structurally awaiting a callback that
    /// ignores task cancellation. The cancel hook must synchronously initiate
    /// transport teardown; late callback results are discarded by the gate.
    static func race<Value: Sendable>(
        milliseconds: Int,
        timeoutValue: Value,
        cancel: @escaping @Sendable () -> Void,
        operation: @escaping @Sendable () async -> Value
    ) async -> Value {
        let gate = ProbeBudgetGate(timeoutValue: timeoutValue)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard gate.install(continuation) else { return }
                let work = Task {
                    guard !gate.isFinished else { return }
                    let value = await operation()
                    if gate.finish(value) { gate.cancelTasks() }
                }
                let timer = Task {
                    do { try await Task.sleep(for: .milliseconds(milliseconds)) }
                    catch { return }
                    if gate.finish(timeoutValue) {
                        if gate.claimCancellationHook() { cancel() }
                        gate.cancelTasks()
                    }
                }
                gate.store(work: work, timer: timer)
            }
        } onCancel: {
            _ = gate.finish(timeoutValue)
            if gate.claimCancellationHook() { cancel() }
            gate.cancelTasks()
        }
    }
}

enum MediaQualityProbeCallbackBridge {
    static func wait<Value: Sendable>(
        _ register: @escaping @Sendable (@escaping @Sendable (Result<Value, Error>) -> Void) -> Void
    ) async throws -> Value {
        let gate = ProbeCallbackGate<Value>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                gate.install(continuation)
                guard !Task.isCancelled else {
                    gate.finish(.failure(CancellationError()))
                    return
                }
                register { result in gate.finish(result) }
            }
        } onCancel: {
            gate.finish(.failure(CancellationError()))
        }
    }
}

enum MediaQualityProbeTaskCollector {
    /// The node attempts are deliberately unstructured so each can leave an
    /// uncooperative SDK callback at the budget boundary. Propagate cancellation
    /// explicitly so logout tears them down instead of merely cancelling this waiter.
    static func collect<Value: Sendable>(_ tasks: [Task<Value, Never>]) async -> [Value] {
        await withTaskCancellationHandler {
            var values: [Value] = []
            for task in tasks {
                guard !Task.isCancelled else { break }
                values.append(await task.value)
            }
            return values
        } onCancel: {
            tasks.forEach { $0.cancel() }
        }
    }
}

enum MediaQualityProbeGenerationMonitor {
    static func start<Value: Sendable>(
        tasks: [Task<Value, Never>], expected: String,
        source: any MediaNetworkGenerationProviding
    ) -> Task<Void, Never> {
        Task {
            while !Task.isCancelled {
                if source.currentGeneration() != expected {
                    tasks.forEach { $0.cancel() }
                    return
                }
                do { try await Task.sleep(for: .milliseconds(20)) }
                catch { return }
            }
        }
    }
}

@MainActor
final class MediaQualityProbeCloseGate {
    private(set) var isClosed = false

    func close(_ action: () -> Void) {
        guard !isClosed else { return }
        isClosed = true
        action()
    }
}

private final class ProbeCallbackGate<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var terminal: Result<Value, Error>?

    func install(_ continuation: CheckedContinuation<Value, Error>) {
        let result = lock.withLock { () -> Result<Value, Error>? in
            if let terminal { return terminal }
            self.continuation = continuation
            return nil
        }
        if let result { continuation.resume(with: result) }
    }

    func finish(_ result: Result<Value, Error>) {
        let continuation = lock.withLock { () -> CheckedContinuation<Value, Error>? in
            guard case nil = terminal else { return nil }
            terminal = result
            defer { self.continuation = nil }
            return self.continuation
        }
        continuation?.resume(with: result)
    }
}

private final class ProbeBudgetGate<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?
    private var work: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var finished = false
    private var cancellationHookClaimed = false
    private let timeoutValue: Value

    init(timeoutValue: Value) { self.timeoutValue = timeoutValue }

    @discardableResult
    func install(_ continuation: CheckedContinuation<Value, Never>) -> Bool {
        let alreadyFinished = lock.withLock { () -> Bool in
            guard !finished else { return true }
            self.continuation = continuation
            return false
        }
        if alreadyFinished { continuation.resume(returning: timeoutValue) }
        return !alreadyFinished
    }

    func store(work: Task<Void, Never>, timer: Task<Void, Never>) {
        let shouldCancel = lock.withLock { () -> Bool in
            guard !finished else { return true }
            self.work = work
            self.timer = timer
            return false
        }
        if shouldCancel { work.cancel(); timer.cancel() }
    }

    @discardableResult
    func finish(_ value: Value) -> Bool {
        let outcome = lock.withLock { () -> (Bool, CheckedContinuation<Value, Never>?) in
            guard !finished else { return (false, nil) }
            finished = true
            defer { self.continuation = nil }
            return (true, self.continuation)
        }
        outcome.1?.resume(returning: value)
        return outcome.0
    }

    var isFinished: Bool { lock.withLock { finished } }

    func claimCancellationHook() -> Bool {
        lock.withLock {
            guard !cancellationHookClaimed else { return false }
            cancellationHookClaimed = true
            return true
        }
    }

    func cancelTasks() {
        let tasks = lock.withLock { () -> (Task<Void, Never>?, Task<Void, Never>?) in
            defer { work = nil; timer = nil }
            return (work, timer)
        }
        tasks.0?.cancel(); tasks.1?.cancel()
    }
}

@MainActor
enum MediaQualityProbeRunner {
    static func validate(_ options: MediaQualityProbeOptionsResponse, generation: String) throws {
        guard options.networkGeneration == generation,
              options.measurement == "relay_data_channel_echo_v1",
              options.lifetimeMs == 5_000,
              options.sampleDurationMs == 2_000,
              options.packetIntervalMs == 20,
              options.maxPackets == 250,
              options.maxPacketBytes == 512,
              options.iceTransportPolicy == "relay",
              (1...16).contains(options.nodes.count),
              Set(options.nodes.map(\.nodeId)).count == options.nodes.count else {
            throw MediaQualityProbeError.invalidOptions
        }
        for node in options.nodes {
            guard node.nodeId.range(of: #"^[a-z][a-z0-9_-]{0,31}$"#, options: .regularExpression) != nil,
                  !node.grant.isEmpty, node.grant.count <= 4_096,
                  let expiry = parseDate(node.expiresAt), expiry.timeIntervalSinceNow > 0,
                  let url = URL(string: node.probeUrl), url.scheme?.lowercased() == "https",
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                  url.path == "/webrtc-probe/offer", node.iceServers.count == 1,
                  let ice = node.iceServers.first, ice.urls.count == 1,
                  let turnURL = ice.urls.first,
                  turnURL.range(of: #"^turn:[A-Za-z0-9.-]+:[0-9]+\?transport=udp$"#, options: .regularExpression) != nil,
                  !ice.username.isEmpty, ice.username.count <= 1_024,
                  !ice.credential.isEmpty, ice.credential.count <= 4_096 else {
                throw MediaQualityProbeError.invalidOptions
            }
        }
    }

    static func run(
        _ options: MediaQualityProbeOptionsResponse,
        generationSource: any MediaNetworkGenerationProviding
    ) async -> [MediaQualityProbeSample] {
        let expectedGeneration = options.networkGeneration
        let tasks = options.nodes.map { node in
            Task { @MainActor in
                let attempt = RelayQualityProbeAttempt(node: node)
                return await attempt.measure(
                    expectedGeneration: expectedGeneration,
                    generationSource: generationSource,
                    lifetimeMs: options.lifetimeMs,
                    sampleDurationMs: options.sampleDurationMs,
                    packetIntervalMs: options.packetIntervalMs,
                    maxPackets: options.maxPackets
                )
            }
        }
        let generationMonitor = MediaQualityProbeGenerationMonitor.start(
            tasks: tasks, expected: expectedGeneration, source: generationSource
        )
        defer { generationMonitor.cancel() }
        return await MediaQualityProbeTaskCollector.collect(tasks)
    }

    private static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

@MainActor
private final class RelayQualityProbeAttempt: NSObject {
    private let node: MediaQualityProbeNode
    private let factory = LKRTCPeerConnectionFactory()
    private var peer: LKRTCPeerConnection?
    private var channel: LKRTCDataChannel?
    private var sentAt: [UInt32: UInt64] = [:]
    private var receivedSequences = Set<UInt32>()
    private var rtts: [Double] = []
    private var invalidEcho = false
    private let closeGate = MediaQualityProbeCloseGate()

    init(node: MediaQualityProbeNode) { self.node = node }

    func measure(
        expectedGeneration: String,
        generationSource: any MediaNetworkGenerationProviding,
        lifetimeMs: Int,
        sampleDurationMs: Int,
        packetIntervalMs: Int,
        maxPackets: Int
    ) async -> MediaQualityProbeSample {
        let nodeID = node.nodeId
        let result = await MediaQualityProbeBudget.race(
            milliseconds: lifetimeMs,
            timeoutValue: .failed(nodeId: nodeID, outcome: .timeout),
            cancel: { [weak self] in Task { @MainActor in self?.close() } },
            operation: { @MainActor [self] in
                do {
                    return try await perform(
                        expectedGeneration: expectedGeneration,
                        generationSource: generationSource,
                        sampleDurationMs: sampleDurationMs,
                        packetIntervalMs: packetIntervalMs,
                        maxPackets: maxPackets
                    )
                } catch is CancellationError {
                    return .failed(nodeId: nodeID, outcome: .timeout)
                } catch MediaQualityProbeError.timedOut {
                    return .failed(nodeId: nodeID, outcome: .timeout)
                } catch {
                    return .failed(nodeId: nodeID, outcome: .networkError)
                }
            }
        )
        close()
        return result
    }

    private func perform(
        expectedGeneration: String,
        generationSource: any MediaNetworkGenerationProviding,
        sampleDurationMs: Int,
        packetIntervalMs: Int,
        maxPackets: Int
    ) async throws -> MediaQualityProbeSample {
        try ensureCurrent(expectedGeneration, generationSource)
        guard let ice = node.iceServers.first else { throw MediaQualityProbeError.invalidOptions }
        let configuration = LKRTCConfiguration()
        configuration.iceTransportPolicy = .relay
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherOnce
        // S45: deliberately left at libwebrtc's default, which is the unfiltered `.all` that `makePeerConnection`
        // now falls back to — the probe never had the `.lowCost` filter, so it never had the cellular-only bug,
        // and narrowing it here would only be a new way to lose a measurement.
        configuration.iceServers = [LKRTCIceServer(urlStrings: ice.urls, username: ice.username, credential: ice.credential)]
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw MediaQualityProbeError.signaling
        }
        self.peer = peer
        let dataConfiguration = LKRTCDataChannelConfiguration()
        dataConfiguration.isOrdered = false
        dataConfiguration.maxRetransmits = 0
        guard let channel = peer.dataChannel(forLabel: "media-quality-v1", configuration: dataConfiguration) else {
            throw MediaQualityProbeError.signaling
        }
        self.channel = channel
        channel.delegate = self

        let startedUs = Self.monotonicMicros()
        let offer = try await createOffer(peer)
        try ensureCurrent(expectedGeneration, generationSource)
        try await setLocal(offer, peer)
        try ensureCurrent(expectedGeneration, generationSource)
        try await waitForGathering(peer, expectedGeneration, generationSource)
        guard let local = peer.localDescription else { throw MediaQualityProbeError.signaling }
        let completedRelaySDP = try MediaQualityProbeSDP.completedRelayOnly(local.sdp)
        let answer = try await exchange(completedRelaySDP)
        try ensureCurrent(expectedGeneration, generationSource)
        guard answer.type == "answer", !answer.sdp.isEmpty else { throw MediaQualityProbeError.signaling }
        try await setRemote(LKRTCSessionDescription(type: .answer, sdp: answer.sdp), peer)
        try ensureCurrent(expectedGeneration, generationSource)
        try await waitForOpen(channel, expectedGeneration, generationSource)
        let connectionMs = min(5_000, Double(Self.monotonicMicros() - startedUs) / 1_000)

        let sampleStartedUs = Self.monotonicMicros()
        var sequence: UInt32 = 0
        repeat {
            try ensureCurrent(expectedGeneration, generationSource)
            let sentUs = Self.monotonicMicros()
            let frame = MediaQualityProbeFrame.encode(sequence: sequence, sentUs: sentUs)
            guard channel.sendData(LKRTCDataBuffer(data: frame, isBinary: true)) else {
                throw MediaQualityProbeError.signaling
            }
            sentAt[sequence] = sentUs
            sequence += 1
            if sequence >= maxPackets { break }
            try await Task.sleep(for: .milliseconds(packetIntervalMs))
        } while Self.monotonicMicros() - sampleStartedUs < UInt64(sampleDurationMs * 1_000)

        // Allow the last unreliable echoes one interval to arrive without extending the sample budget.
        try await Task.sleep(for: .milliseconds(packetIntervalMs))
        try ensureCurrent(expectedGeneration, generationSource)
        let duration = min(5_000, Double(Self.monotonicMicros() - sampleStartedUs) / 1_000)
        guard sequence >= 20, !rtts.isEmpty, !invalidEcho, duration >= 2_000 else {
            return .failed(nodeId: node.nodeId, outcome: .networkError, sent: Int(sequence), received: rtts.count, duration: duration, connectionMs: connectionMs)
        }
        guard let metrics = MediaQualityProbeFrame.summarize(rtts) else {
            throw MediaQualityProbeError.signaling
        }
        return MediaQualityProbeSample(
            nodeId: node.nodeId, outcome: .ok, sent: Int(sequence), received: rtts.count,
            connectionMs: connectionMs, rttMedianMs: metrics.median, rttP95Ms: metrics.p95,
            jitterMs: metrics.jitter, sampleDurationMs: duration
        )
    }

    private func exchange(_ sdp: String) async throws -> MediaQualityProbeDescription {
        guard let url = URL(string: node.probeUrl) else { throw MediaQualityProbeError.invalidOptions }
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(node.grant)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(MediaQualityProbeDescription(type: "offer", sdp: sdp))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        let session = URLSession(configuration: configuration, delegate: QualityProbeNoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count <= 128 * 1_024 else {
            throw MediaQualityProbeError.signaling
        }
        return try JSONDecoder().decode(MediaQualityProbeDescription.self, from: data)
    }

    private func createOffer(_ peer: LKRTCPeerConnection) async throws -> LKRTCSessionDescription {
        try await MediaQualityProbeCallbackBridge.wait { completion in
            peer.offer(for: LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { value, error in
                if let error { completion(.failure(error)) }
                else if let value { completion(.success(value)) }
                else { completion(.failure(MediaQualityProbeError.signaling)) }
            }
        }
    }

    private func setLocal(_ description: LKRTCSessionDescription, _ peer: LKRTCPeerConnection) async throws {
        let _: Void = try await MediaQualityProbeCallbackBridge.wait { completion in
            peer.setLocalDescription(description) { error in
                if let error { completion(.failure(error)) } else { completion(.success(())) }
            }
        }
    }

    private func setRemote(_ description: LKRTCSessionDescription, _ peer: LKRTCPeerConnection) async throws {
        let _: Void = try await MediaQualityProbeCallbackBridge.wait { completion in
            peer.setRemoteDescription(description) { error in
                if let error { completion(.failure(error)) } else { completion(.success(())) }
            }
        }
    }

    private func waitForGathering(
        _ peer: LKRTCPeerConnection, _ generation: String,
        _ generationSource: any MediaNetworkGenerationProviding
    ) async throws {
        for _ in 0..<100 {
            try ensureCurrent(generation, generationSource)
            if peer.iceGatheringState == .complete { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw MediaQualityProbeError.timedOut
    }

    private func waitForOpen(
        _ channel: LKRTCDataChannel, _ generation: String,
        _ generationSource: any MediaNetworkGenerationProviding
    ) async throws {
        for _ in 0..<100 {
            try ensureCurrent(generation, generationSource)
            if channel.readyState == .open { return }
            if channel.readyState == .closed || channel.readyState == .closing { throw MediaQualityProbeError.signaling }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw MediaQualityProbeError.timedOut
    }

    private func ensureCurrent(
        _ generation: String, _ generationSource: any MediaNetworkGenerationProviding
    ) throws {
        try Task.checkCancellation()
        guard !closeGate.isClosed else { throw CancellationError() }
        guard generationSource.currentGeneration() == generation else { throw MediaProbeError.networkChanged }
    }

    private func close() {
        closeGate.close {
            channel?.delegate = nil
            channel?.close()
            channel = nil
            peer?.delegate = nil
            peer?.close()
            peer = nil
        }
    }

    private static func monotonicMicros() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000 }
}

extension RelayQualityProbeAttempt: LKRTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {}

    nonisolated func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        let data = buffer.data
        Task { @MainActor [weak self] in self?.receive(data, binary: buffer.isBinary) }
    }

    private func receive(_ data: Data, binary: Bool) {
        guard !closeGate.isClosed else { return }
        guard binary, let decoded = MediaQualityProbeFrame.decode(data),
              !receivedSequences.contains(decoded.sequence),
              let expectedSentUs = sentAt[decoded.sequence], expectedSentUs == decoded.sentUs else {
            invalidEcho = true; close(); return
        }
        let now = Self.monotonicMicros()
        guard now >= decoded.sentUs else { invalidEcho = true; close(); return }
        receivedSequences.insert(decoded.sequence)
        rtts.append(min(5_000, Double(now - decoded.sentUs) / 1_000))
    }
}

extension RelayQualityProbeAttempt: LKRTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {}
}

private final class QualityProbeNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) { completionHandler(nil) }
}

private extension MediaQualityProbeSample {
    static func failed(
        nodeId: String, outcome: MediaProbeOutcome, sent: Int = 0, received: Int = 0,
        duration: Double = 0, connectionMs: Double? = nil
    ) -> Self {
        .init(
            nodeId: nodeId, outcome: outcome, sent: sent, received: received,
            connectionMs: connectionMs, rttMedianMs: nil, rttP95Ms: nil,
            jitterMs: nil, sampleDurationMs: duration
        )
    }
}
