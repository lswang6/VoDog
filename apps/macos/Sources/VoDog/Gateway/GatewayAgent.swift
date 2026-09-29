import Foundation
import Network

// VoDog gateway, per-Mac coordinator (S53 + S54 一机多模组). Every attached DJI module with a
// readable IMEI gets its own `GatewayRuntime` (its own gateway row, credentials, heartbeat, doorbell,
// probes, ledger, outbox, SIM, blocklist and media sessions); they run concurrently. What stays per
// Mac lives here: the master switch, the server address, the Keychain cache, the network path /
// probe generation, the diagnostics upload and the liveness marker.

@MainActor
final class GatewayAgent: ObservableObject {
    static var defaultBaseURL: String { VoDogServer.baseURL.absoluteString }

    @Published private(set) var isEnabled: Bool
    @Published var baseURLString: String {
        didSet { defaults.set(baseURLString, forKey: Keys.baseURL) }
    }
    /// Attached modules in attach order.
    @Published private(set) var runtimes: [GatewayRuntime] = []
    private(set) var transport = "unknown"

    var networkGeneration: String { "\(networkGenerationPrefix)-\(networkGenerationCount)" }

    private enum Keys {
        static let cleanShutdown = "VoDogGateway.diagCleanShutdown.v1"
        static let lastAlive = "VoDogGateway.diagLastAlive.v1"
        static let enabled = "VoDogGateway.enabled.v1"
        static let baseURL = "VoDogGateway.baseURL.v1"
    }

    /// A module absent this long is detached (short USB/module restarts keep their runtime).
    private static let detachGrace: TimeInterval = 30

    private weak var appState: AppState?
    private let defaults = UserDefaults.standard
    private var keychainCache: [String: GatewayCredentials?] = [:]
    private var lastSeen: [String: Date] = [:]
    private var started = false
    private var diagFlushInFlight = false
    private let pathMonitor = NWPathMonitor()
    private var lastPathSignature: String?
    private var networkGenerationCount = 0
    private let networkGenerationPrefix = "mac-" + UUID().uuidString.prefix(8).lowercased()

    init(appState: AppState) {
        self.appState = appState
        isEnabled = defaults.bool(forKey: Keys.enabled)
        baseURLString = defaults.string(forKey: Keys.baseURL) ?? Self.defaultBaseURL
        // Probe evidence is per network generation: a changed primary path invalidates it.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let signature = "\(path.status)|" + path.availableInterfaces.map(\.name).joined(separator: ",")
            let transport = path.status != .satisfied ? "none"
                : path.usesInterfaceType(.wiredEthernet) ? "ethernet"
                : path.usesInterfaceType(.wifi) ? "wifi"
                : path.usesInterfaceType(.cellular) ? "cellular" : "other"
            let validated = path.status == .satisfied
            DispatchQueue.main.async {
                guard let self else { return }
                if transport != self.transport {
                    self.transport = transport
                    self.diag("network.transport", transport == "none" ? "warn" : "info", nil,
                              ["transport": transport, "validated": validated, "expensive": path.isExpensive])
                }
                guard signature != self.lastPathSignature else { return }
                if self.lastPathSignature != nil { self.networkGenerationCount += 1 }
                self.lastPathSignature = signature
            }
        }
        pathMonitor.start(queue: .global(qos: .utility))
        // S52 liveness: a previous run that neither quit cleanly nor went quiet >1 day ago was killed.
        if !defaults.bool(forKey: Keys.cleanShutdown), let lastAlive = defaults.object(forKey: Keys.lastAlive) as? Date,
           Date().timeIntervalSince(lastAlive) < 86_400 {
            diag("app.killed", "warn", nil, ["lastAliveAgoS": Int(Date().timeIntervalSince(lastAlive))])
        }
        defaults.removeObject(forKey: Keys.lastAlive)
        defaults.set(false, forKey: Keys.cleanShutdown)
    }

    /// Per-Mac events (no gateway id); runtimes add theirs.
    nonisolated var diag: GatewayDiag {
        { event, level, callId, fields in
            GatewayDiagLog.shared.record(event, level: level, callId: callId, fields: fields)
        }
    }

    // MARK: AppState surface

    func start() {
        started = true
        reconcile()
        // Detach is time-based (a gone module publishes nothing), so re-check periodically.
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reconcile() }
        }
    }

    func setEnabled(_ enabled: Bool) {
        guard enabled != isEnabled else { return }
        isEnabled = enabled
        defaults.set(enabled, forKey: Keys.enabled)
        diag("gateway.state", "info", nil, ["enabled": ["was": !enabled, "now": enabled]])
        for runtime in runtimes { runtime.applyEnabled(action: enabled ? "enable" : "disable") }
    }

    /// App quit: every queue is already on disk; mark the exit clean and try one last upload.
    func prepareForTermination() {
        for runtime in runtimes where runtime.isRunning {
            runtime.diag("service.stop", "info", nil, ["reason": "app_terminate"])
        }
        defaults.set(true, forKey: Keys.cleanShutdown)
        if let http = runtimes.lazy.compactMap(\.httpClient).first { Task { await flushDiag(http) } }
    }

    /// AppState calls this after any module's modem or call snapshot changed.
    func stateDidChange() {
        guard started else { return }
        reconcile()
        for runtime in runtimes { runtime.stateDidChange() }
    }

    func handlesCalls(on moduleID: CellularModuleID?) -> Bool {
        runtimes.contains { $0.handlesCalls(on: moduleID) }
    }

    func ringingCall(on moduleID: CellularModuleID?) -> (callId: String?, simId: String?)? {
        runtimes.lazy.compactMap { $0.ringingCall(on: moduleID) }.first
    }

    func silencesLocalRing(on moduleID: CellularModuleID?) -> Bool {
        runtimes.contains { $0.silencesLocalRing(on: moduleID) }
    }

    func ownsMessages(on moduleID: CellularModuleID) -> Bool {
        runtimes.contains { $0.ownsMessages(on: moduleID) }
    }

    func suppressesLocalRecording(on moduleID: CellularModuleID?) -> Bool {
        runtimes.contains { $0.suppressesLocalRecording(on: moduleID) }
    }

    func bridgesRemoteCall(on moduleID: CellularModuleID?) -> Bool {
        runtimes.contains { $0.bridgesRemoteCall(on: moduleID) }
    }

    func isBlockedSender(_ sender: String, moduleID: CellularModuleID) -> Bool {
        runtimes.contains { $0.isBlockedSender(sender, moduleID: moduleID) }
    }

    func messagesArrived(_ messages: [SMSMessage], moduleID: CellularModuleID, isInitialSync: Bool) {
        for runtime in runtimes { runtime.messagesArrived(messages, moduleID: moduleID, isInitialSync: isInitialSync) }
    }

    func sweepModuleSlots(_ relisted: [(message: SMSMessage, firstSeenAt: Date)], moduleID: CellularModuleID) {
        for runtime in runtimes { runtime.sweepModuleSlots(relisted, moduleID: moduleID) }
    }

    func localMessageSent(to destination: String, body: String, moduleID: CellularModuleID) {
        for runtime in runtimes { runtime.localMessageSent(to: destination, body: body, moduleID: moduleID) }
    }

    // MARK: Shared per-Mac services for runtimes

    /// This Mac's Keychain copy for a module (cached; Keychain reads are not free).
    func storedCredentials(imei: String) -> GatewayCredentials? {
        let key = GatewayModuleIdentity.storageKey(imei: imei)
        if let cached = keychainCache[key] { return cached }
        let loaded = GatewayKeychain.load(account: GatewayModuleIdentity.account(imei: imei))
        keychainCache[key] = loaded
        return loaded
    }

    func cacheCredentials(_ credentials: GatewayCredentials, imei: String) {
        keychainCache[GatewayModuleIdentity.storageKey(imei: imei)] = credentials
    }

    /// One upload at a time: the queue is shared by every gateway on this Mac, so two concurrent
    /// flushes would send the same batch twice. Any online gateway's token will do (rows carry
    /// their own `gatewayId`).
    func flushDiag(_ http: GatewayHTTP) async {
        guard !diagFlushInFlight else { return }
        diagFlushInFlight = true
        defer { diagFlushInFlight = false }
        defaults.set(Date(), forKey: Keys.lastAlive)
        for _ in 0..<3 {
            let batch = GatewayDiagLog.shared.nextBatch()
            guard !batch.lines.isEmpty else { return }
            var request = URLRequest(url: http.credentials.baseURL.appendingPathComponent("api/v1/diag/events"),
                                     timeoutInterval: 20)
            request.httpMethod = "POST"
            request.setValue("Bearer \(http.credentials.deviceToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(GatewayDiagLog.shared.installId, forHTTPHeaderField: "X-Diag-Install")
            // S75: Control derives diag_events.clock_offset_ms from this.
            request.setValue(String(Int64(Date().timeIntervalSince1970 * 1_000)), forHTTPHeaderField: "X-Diag-Sent-At")
            request.httpBody = Data(("[" + batch.lines.joined(separator: ",") + "]").utf8)
            guard let (_, response) = try? await http.session.data(for: request),
                  let status = (response as? HTTPURLResponse)?.statusCode else { return }
            if (200..<300).contains(status) || (400..<500).contains(status) && ![401, 408, 429].contains(status) {
                GatewayDiagLog.shared.commit(batch.queued)
            } else {
                return
            }
        }
    }

    // MARK: Runtimes

    /// One runtime per attached module with a readable IMEI; created on attach, dropped after the
    /// module has been gone for `detachGrace`.
    private func reconcile() {
        guard let appState else { return }
        let now = Date()
        var changed = false
        for state in appState.gatewayAttachedModules() {
            guard let imei = state.modem.moduleIMEI else { continue }
            let key = GatewayModuleIdentity.storageKey(imei: imei)
            lastSeen[key] = now
            guard !runtimes.contains(where: { $0.id == key }) else { continue }
            let runtime = GatewayRuntime(imei: imei, agent: self, appState: appState)
            runtimes.append(runtime)
            changed = true
            runtime.diag("gateway.state", "info", nil, ["moduleAttached": ["was": false, "now": true]])
            if isEnabled { runtime.applyEnabled(action: "attach") }
        }
        for runtime in runtimes where now.timeIntervalSince(lastSeen[runtime.id] ?? now) > Self.detachGrace {
            runtime.detach()
            lastSeen[runtime.id] = nil
            changed = true
        }
        if changed { runtimes.removeAll { lastSeen[$0.id] == nil } }
    }
}
