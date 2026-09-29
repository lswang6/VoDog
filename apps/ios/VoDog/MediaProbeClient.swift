import Foundation
import Network

protocol MediaNetworkGenerationProviding: Sendable {
    func currentGeneration() -> String
}

final class MediaNetworkGenerationSource: MediaNetworkGenerationProviding, @unchecked Sendable {
    static let shared = MediaNetworkGenerationSource()

    private let lock = NSLock()
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "org.vodog.media-network")
    private var generation = UUID().uuidString.lowercased()
    /// S45: the monitor this class already runs is also the app's only reading of which interface carries the
    /// path, so the candidate filter is decided here rather than from a second monitor. `.all` until the first
    /// update lands — a push can cold-launch straight into a call, and guessing "Wi-Fi" there would strip the
    /// cellular interface off it.
    private var candidateNetwork = MediaCandidateNetworkPolicy.Choice.all
    /// Coarse `status:type` reading (same shape as `network.path`), so a handshake can tell an AP/route refresh
    /// that rotated `generation` from a real Wi-Fi↔cellular switch. "unknown" until the first update.
    private var pathLabel = "unknown"

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in self?.record(path) }
        monitor.start(queue: queue)
    }

    func currentGeneration() -> String { lock.withLock { generation } }

    /// S45: read fresh at peer-connection creation — the path can change between calls, and between a call's
    /// UDP attempt and its TLS retry.
    func candidateNetworkChoice() -> MediaCandidateNetworkPolicy.Choice { lock.withLock { candidateNetwork } }

    func currentPathLabel() -> String { lock.withLock { pathLabel } }

    private func record(_ path: NWPath) {
        let choice = MediaCandidateNetworkPolicy.choice(
            isSatisfied: path.status == .satisfied,
            usesWiFi: path.usesInterfaceType(.wifi),
            usesWiredEthernet: path.usesInterfaceType(.wiredEthernet)
        )
        let type = path.usesInterfaceType(.wifi) ? "wifi" : path.usesInterfaceType(.cellular) ? "cellular"
            : path.usesInterfaceType(.wiredEthernet) ? "wired" : "other"
        let label = "\(path.status == .satisfied ? "satisfied" : "\(path.status)"):\(type)"
        lock.withLock {
            // NWPathMonitor invokes this handler when the effective path changes. Rotate even
            // when the coarse public properties are identical (for example Wi-Fi AP changes).
            generation = UUID().uuidString.lowercased()
            candidateNetwork = choice
            pathLabel = label
        }
    }
}

enum MediaProbeError: LocalizedError, Equatable {
    case invalidOptions
    case networkChanged
    case resultRejected

    var errorDescription: String? {
        switch self {
        case .invalidOptions: "媒体节点探测配置无效"
        case .networkChanged: "网络已变化，请重新连接音频"
        case .resultRejected: "媒体节点探测结果未被接受"
        }
    }
}

private final class MediaProbeNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) { completionHandler(nil) }
}

private final class MediaProbeTaskWaitGate<Value: Sendable>: @unchecked Sendable {
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
            guard terminal == nil else { return nil }
            terminal = result
            defer { self.continuation = nil }
            return self.continuation
        }
        continuation?.resume(with: result)
    }
}

private enum MediaProbeTaskWaiter {
    /// A cancelled caller detaches promptly from a shared in-flight probe. The
    /// observer remains only while another waiter owns the bounded shared task.
    static func wait<Value: Sendable>(_ task: Task<Value, Error>) async throws -> Value {
        let gate = MediaProbeTaskWaitGate<Value>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                gate.install(continuation)
                guard !Task.isCancelled else {
                    gate.finish(.failure(CancellationError()))
                    return
                }
                Task {
                    do { gate.finish(.success(try await task.value)) }
                    catch { gate.finish(.failure(error)) }
                }
            }
        } onCancel: {
            gate.finish(.failure(CancellationError()))
        }
    }
}

@MainActor
protocol MediaProbeLifecycleManaging: AnyObject {
    func cancelInFlight()
    func invalidateEvidence()
}

@MainActor
final class MediaProbeManager: MediaProbeLifecycleManaging {
    static let shared = MediaProbeManager()

    private struct Evidence {
        let sessionIdentity: UUID
        let generation: String
        let expiresAt: Date
        let monotonicExpiresAt: ContinuousClock.Instant
    }

    private let generationSource: any MediaNetworkGenerationProviding
    private let probeSession: URLSession
    private var evidence: Evidence?
    private struct InFlight {
        let id: UUID
        let sessionIdentity: UUID
        let generation: String
        let task: Task<String, Error>
    }

    private var inFlight: InFlight?
    private var inFlightWaiters = Set<UUID>()
    var activeWaiterCount: Int { inFlightWaiters.count }

    init(
        generationSource: any MediaNetworkGenerationProviding = MediaNetworkGenerationSource.shared,
        probeSession: URLSession? = nil
    ) {
        self.generationSource = generationSource
        if let probeSession {
            self.probeSession = probeSession
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.httpCookieAcceptPolicy = .never
            configuration.timeoutIntervalForRequest = 2
            configuration.timeoutIntervalForResource = 2
            self.probeSession = URLSession(
                configuration: configuration,
                delegate: MediaProbeNoRedirectDelegate(), delegateQueue: nil
            )
        }
    }

    func prepare(
        session: SessionStore, requiredSessionIdentity: UUID, force: Bool = false
    ) async throws -> String {
        try Task.checkCancellation()
        guard session.isCurrentSession(requiredSessionIdentity) else { throw SessionLifecycleError.staleSession }
        let generation = generationSource.currentGeneration()
        if !force, let evidence,
           evidence.sessionIdentity == requiredSessionIdentity,
           evidence.generation == generation,
           evidence.expiresAt.timeIntervalSinceNow > 5,
           ContinuousClock().now < evidence.monotonicExpiresAt {
            try Task.checkCancellation()
            return generation
        }
        if force { evidence = nil }
        if let inFlight,
           inFlight.sessionIdentity == requiredSessionIdentity,
           inFlight.generation == generation {
            return try await waitForInFlight(inFlight)
        }
        inFlight?.task.cancel()
        inFlightWaiters.removeAll()
        let taskID = UUID()
        let task = Task { @MainActor [weak self, weak session] in
            guard let self, let session else { throw CancellationError() }
            return try await self.perform(
                session: session, sessionIdentity: requiredSessionIdentity, generation: generation
            )
        }
        let started = InFlight(
            id: taskID, sessionIdentity: requiredSessionIdentity,
            generation: generation, task: task
        )
        inFlight = started
        return try await waitForInFlight(started)
    }

    func cancelInFlight() {
        inFlight?.task.cancel()
        inFlight = nil
        inFlightWaiters.removeAll()
    }

    func invalidateEvidence() { evidence = nil }

    private var qualityProbesPausedUntil: ContinuousClock.Instant?

    private func waitForInFlight(_ current: InFlight) async throws -> String {
        let waiterID = UUID()
        inFlightWaiters.insert(waiterID)
        defer {
            inFlightWaiters.remove(waiterID)
            if inFlight?.id == current.id, inFlightWaiters.isEmpty {
                current.task.cancel()
                inFlight = nil
            }
        }
        let value = try await MediaProbeTaskWaiter.wait(current.task)
        try Task.checkCancellation()
        return value
    }

    private func perform(session: SessionStore, sessionIdentity: UUID, generation: String) async throws -> String {
        let options: MediaProbeOptionsResponse = try await session.request(
            "media/probes/options", method: "POST",
            body: MediaProbeOptionsRequest(networkGeneration: generation),
            timeoutInterval: 6, requiredSessionIdentity: sessionIdentity
        )
        try validate(options, expectedGeneration: generation)
        let samples = try await probe(nodes: options.nodes)
        try Task.checkCancellation()
        guard generationSource.currentGeneration() == generation else { throw MediaProbeError.networkChanged }
        guard session.isCurrentSession(sessionIdentity) else { throw SessionLifecycleError.staleSession }
        let result: MediaProbeResultsResponse = try await session.request(
            "media/probes/results", method: "POST",
            body: MediaProbeResultsRequest(networkGeneration: generation, samples: samples),
            timeoutInterval: 6, requiredSessionIdentity: sessionIdentity
        )
        guard result.accepted == samples.count, let expiry = Self.parseDate(result.expiresAt),
              expiry.timeIntervalSinceNow > 0 else { throw MediaProbeError.resultRejected }
        try await performRelayQualityIfAvailable(
            session: session, sessionIdentity: sessionIdentity, generation: generation
        )
        try Task.checkCancellation()
        guard generationSource.currentGeneration() == generation else { throw MediaProbeError.networkChanged }
        guard session.isCurrentSession(sessionIdentity) else { throw SessionLifecycleError.staleSession }
        evidence = Evidence(
            sessionIdentity: sessionIdentity, generation: generation, expiresAt: expiry,
            monotonicExpiresAt: ContinuousClock().now.advanced(by: .seconds(120))
        )
        return generation
    }

    private func performRelayQualityIfAvailable(
        session: SessionStore, sessionIdentity: UUID, generation: String
    ) async throws {
        let options: MediaQualityProbeOptionsResponse
        do {
            // S69: Control said the feature is off; skip asking until its `retryAfterMs` has passed.
            if let until = qualityProbesPausedUntil, ContinuousClock.now < until { throw APIError.server(503, "", nil) }
            let reply: MediaQualityProbeOptionsReply = try await session.request(
                "media/quality-probes/options", method: "POST",
                body: MediaProbeOptionsRequest(networkGeneration: generation),
                timeoutInterval: 6, requiredSessionIdentity: sessionIdentity
            )
            switch reply {
            case let .options(value):
                options = value
            case let .disabled(retryAfterMs):
                qualityProbesPausedUntil = ContinuousClock.now.advanced(by: .milliseconds(retryAfterMs))
                throw APIError.server(503, "", nil)
            }
        } catch APIError.server(503, _, _) {
            // The default-off feature flag deliberately preserves HTTPS-only evidence.
            try Task.checkCancellation()
            guard generationSource.currentGeneration() == generation else { throw MediaProbeError.networkChanged }
            guard session.isCurrentSession(sessionIdentity) else { throw SessionLifecycleError.staleSession }
            return
        }
        try MediaQualityProbeRunner.validate(options, generation: generation)
        guard generationSource.currentGeneration() == generation else { throw MediaProbeError.networkChanged }
        let samples = await MediaQualityProbeRunner.run(options, generationSource: generationSource)
        try Task.checkCancellation()
        guard samples.count == options.nodes.count,
              generationSource.currentGeneration() == generation else { throw MediaProbeError.networkChanged }
        guard session.isCurrentSession(sessionIdentity) else { throw SessionLifecycleError.staleSession }
        let result: MediaProbeResultsResponse = try await session.request(
            "media/quality-probes/results", method: "POST",
            body: MediaQualityProbeResultsRequest(networkGeneration: generation, samples: samples),
            timeoutInterval: 6, requiredSessionIdentity: sessionIdentity
        )
        guard result.accepted == samples.count, let expiry = Self.parseDate(result.expiresAt),
              expiry.timeIntervalSinceNow > 0 else { throw MediaProbeError.resultRejected }
    }

    private func validate(_ options: MediaProbeOptionsResponse, expectedGeneration: String) throws {
        guard options.networkGeneration == expectedGeneration,
              !options.nodes.isEmpty, options.nodes.count <= 16,
              let expiry = Self.parseDate(options.expiresAt), expiry.timeIntervalSinceNow > 0 else {
            throw MediaProbeError.invalidOptions
        }
        guard Set(options.nodes.map(\.nodeId)).count == options.nodes.count else {
            throw MediaProbeError.invalidOptions
        }
        for node in options.nodes {
            guard node.nodeId.range(of: #"^[a-z][a-z0-9_-]{0,31}$"#, options: .regularExpression) != nil,
                  node.grants.count == 3,
                  node.grants.allSatisfy({ !$0.isEmpty && $0.count <= 4096 }),
                  let nodeExpiry = Self.parseDate(node.expiresAt), nodeExpiry.timeIntervalSinceNow > 0,
                  let url = URL(string: node.probeUrl), url.scheme?.lowercased() == "https",
                  let host = url.host, !host.isEmpty,
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                  url.path == "/probe" else { throw MediaProbeError.invalidOptions }
        }
    }

    private func probe(nodes: [MediaProbeNode]) async throws -> [MediaProbeSample] {
        try await withThrowingTaskGroup(of: [MediaProbeSample].self) { group in
            for node in nodes {
                group.addTask { [probeSession] in
                    var values: [MediaProbeSample] = []
                    for grant in node.grants {
                        try Task.checkCancellation()
                        values.append(await Self.measure(node: node, grant: grant, session: probeSession))
                    }
                    return values
                }
            }
            var result: [MediaProbeSample] = []
            for try await samples in group { result.append(contentsOf: samples) }
            return result
        }
    }

    private static func measure(node: MediaProbeNode, grant: String, session: URLSession) async -> MediaProbeSample {
        guard let url = URL(string: node.probeUrl) else {
            return MediaProbeSample(nodeId: node.nodeId, outcome: .networkError, httpsRttMs: nil)
        }
        var request = URLRequest(url: url, timeoutInterval: 2)
        request.httpMethod = "POST"
        request.setValue("Bearer \(grant)", forHTTPHeaderField: "Authorization")
        let clock = ContinuousClock()
        let started = clock.now
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let payload = try? JSONDecoder().decode(ProbeAcknowledgement.self, from: data),
                  payload.ok, payload.nodeId == node.nodeId else {
                return MediaProbeSample(nodeId: node.nodeId, outcome: .networkError, httpsRttMs: nil)
            }
            let duration = started.duration(to: clock.now)
            let milliseconds = min(10_000, max(0, Double(duration.components.seconds) * 1_000
                + Double(duration.components.attoseconds) / 1_000_000_000_000_000))
            return MediaProbeSample(nodeId: node.nodeId, outcome: .ok, httpsRttMs: milliseconds)
        } catch let error as URLError where error.code == .timedOut {
            return MediaProbeSample(nodeId: node.nodeId, outcome: .timeout, httpsRttMs: nil)
        } catch {
            return MediaProbeSample(nodeId: node.nodeId, outcome: .networkError, httpsRttMs: nil)
        }
    }

    private static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    private struct ProbeAcknowledgement: Decodable { let ok: Bool; let nodeId: String }
}
