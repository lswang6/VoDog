import Foundation
import IOKit.pwr_mgt
import Network
import Security

// VoDog gateway control plane (spec S53), one instance per attached DJI module (S54):
// pairing, SIM sync, heartbeat + doorbell, the durable command ledger, the durable event outbox,
// and call/SMS orchestration for that module's gateway. `GatewayAgent` owns the per-Mac parts.
// Runs on the main actor; every network call is awaited from the single `run()` loop so the
// outbox and the ledger are only ever touched in order.

struct GatewaySIMBinding: Codable, Equatable {
    var id: String
    var assignmentVersion: Int
    var fingerprint: String
    var countryIso: String?
    var label: String?
}

private struct GatewayBlocklistState: Codable {
    var version: Int
    var numbers: [String]
    /// S66 SMS list; nil = stored before S66, so its version is never sent and the next heartbeat gets a full snapshot.
    var smsNumbers: [String]?

    var syncedVersion: Int? { smsNumbers == nil ? nil : version }
}

private struct GatewaySMSForward: Codable {
    var messageID: String
    var references: [ModemPDUReference]
}

/// One cellular call on the gateway module, from first observation until its end is reported.
private final class GatewayTrackedCall {
    enum Origin { case incoming, remoteDial, localDial }

    let deviceCallId: String
    let firstSeenMillis: Int64
    let origin: Origin
    let direction: CallDirection
    var phase: CallPhase = .idle
    var number: String?
    var serverCallId: String?
    var reported = false
    var answeredRemotely = false
    /// S70: the answer command carried `answeredBy: "ai"` (Pixel GatewayCallExecution parity) →
    /// the media leg uses the AI playout target.
    var answeredByAi = false
    var wasActive = false
    var ended = false
    var blocked = false
    /// Control answered `local_only` (SIM not assigned in Web): nobody remote can answer it.
    var localOnly = false
    /// S72 D2: Control handles this incoming call without a human here (AI, busy, internal peer, blocked).
    var silencedLocally = false
    var endReason: CallEndReason?
    var media: GatewayMediaSession?
    /// S73b: the media leg failed for good (`onFailure` reason); `mediaHangupRequested` once we hung up for it.
    var mediaFailure: String?
    var mediaHangupRequested = false
    /// S75: why this gateway hung the call up itself; `call.local_end` is written once, when the call id is known.
    var localEndTrigger: String?
    var localEndLogged = false
    /// S58: archive recorder of a `.localDial` (no media leg).
    var localRecording: GatewayLocalDialRecording?

    init(deviceCallId: String, firstSeenMillis: Int64, origin: Origin, direction: CallDirection) {
        self.deviceCallId = deviceCallId
        self.firstSeenMillis = firstSeenMillis
        self.origin = origin
        self.direction = direction
    }
}

private struct GatewayCommand {
    let id: String
    let kind: String
    let sequence: Int
    let generation: Int
    let payload: [String: Any]
    let expiresAt: Date?
    let callId: String?
    let smsId: String?

    init?(_ raw: [String: Any]) {
        guard let id = raw["id"] as? String,
              let sequence = GatewayJSON.int(raw["sequence"]),
              let generation = GatewayJSON.int(raw["generation"]) else { return nil }
        self.id = id
        kind = raw["kind"] as? String ?? "unknown"
        self.sequence = sequence
        self.generation = generation
        payload = raw["payload"] as? [String: Any] ?? [:]
        expiresAt = GatewayJSON.date(raw["expiresAt"])
        callId = raw["callId"] as? String ?? payload["callId"] as? String
        smsId = raw["smsId"] as? String ?? payload["smsId"] as? String
    }
}

enum GatewayKeychain {
    private static let service = "org.vodog.macos.vodog-gateway"

    static func load(account: String) -> GatewayCredentials? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ] as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(GatewayCredentials.self, from: data)
    }

    static func delete(account: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }

    static func save(_ credentials: GatewayCredentials, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(credentials),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else {
            throw BoundSocketError.systemCall(operation: "Keychain update", code: updated)
        }
        let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw BoundSocketError.systemCall(operation: "Keychain add", code: status)
        }
    }
}

/// Thread-safe gateway id for diagnostics emitted from media/recording queues.
private final class GatewayIdTag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = ""
    var gatewayId: String {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

@MainActor
final class GatewayRuntime: ObservableObject, Identifiable {
    let imei: String
    /// `GatewayModuleIdentity.storageKey(imei:)`.
    let id: String
    let displayKey: String
    /// Paused for this module only (per Mac); the master switch is `GatewayAgent.isEnabled`.
    @Published private(set) var isPaused: Bool
    @Published private(set) var provision: GatewayProvisionState?
    @Published private(set) var credentials: GatewayCredentials?
    @Published private(set) var sim: GatewaySIMBinding?
    @Published private(set) var isPairing = false
    @Published private(set) var lastHeartbeatAt: Date?
    @Published private(set) var lastError: String?
    var isEnabled: Bool { agent?.isEnabled == true && !isPaused }
    var isRunning: Bool { loopTask != nil }
    var httpClient: GatewayHTTP? { http }

    var isOnline: Bool {
        isEnabled && lastHeartbeatAt.map { Date().timeIntervalSince($0) < 10 } == true
    }

    private enum Keys {
        static let paused = "VoDogGateway.paused.v1"
        static let provision = "VoDogGateway.provision.v1"
        static let sim = "VoDogGateway.sim.v1"
        static let blocklist = "VoDogGateway.blocklist.v1"
        static let snapshotSequence = "VoDogGateway.snapshotSequence.v1"
        static let enabledAt = "VoDogGateway.enabledAt.v1"
    }

    private weak var appState: AppState?
    private weak var agent: GatewayAgent?
    private let tag = GatewayIdTag()
    private let defaults = UserDefaults.standard
    private let directory = AppDataDirectory.userApplicationSupport()
        .appendingPathComponent("gateway", isDirectory: true)
    private var outbox: GatewayOutbox?
    private var boundKey: String?
    private var moduleCopyChecked = false
    private var moduleCopyFailures = 0
    private var moduleCopyRetryAt = Date.distantPast
    private var pendingModulePush = false
    private var credentialRecoveryAttempted = false
    /// Last `pair` failure, for the provisioning step machine.
    private(set) var lastPairError: Error?
    /// When this Mac started driving the current gateway; see the move guard in `execute`.
    private var boundAt = Date()
    private var ledger: GatewayCommandLedger?
    private var http: GatewayHTTP?
    private var loopTask: Task<Void, Never>?
    private var doorbellTask: Task<Void, Never>?
    private var doorbellHoldMs = 0
    /// S56: Control's heartbeat `earlyMedia`; snapshotted into the modem at each remote dial.
    private var earlyMedia = false
    private var wakeRequested = false
    private var powerAssertion: IOPMAssertionID = 0
    private var syncedFingerprint: String?
    private var sentOfflineBeat = false
    private var lastMediaReady: Bool?
    private var blocklist: GatewayBlocklistState?
    private var current: GatewayTrackedCall?
    /// Reported calls whose server id is still unknown, by deviceCallId.
    private var awaitingCallId: [String: GatewayTrackedCall] = [:]
    private var pendingDial: (callId: String, deviceCallId: String, firstSeenMillis: Int64)?
    /// Server call ids hung up before their dial ran here (Control delivers `hangup` without waiting for
    /// telephony readiness and never finalizes the pending dial); such a dial is refused, never placed.
    /// ponytail: in memory, 60 s (> the 30 s dial lifetime); a restart in between loses it.
    private var cancelledDials: [String: Date] = [:]
    private var confirmedAbsent: [(id: String, at: Date)] = []
    private var snapshotDirty = true
    private var lastSnapshotAt = Date.distantPast
    private var lastHeartbeatStartedAt: Date?
    private var rtt = (count: 0, min: Int.max, max: 0, sum: 0, slow: 0, maxGap: 0, dueAt: Date.distantPast)
    private var doorbellWakeAt: Date?
    private var commandsReceivedAt = Date()
    private var lastCommandOutcome: (status: String, reason: String?)?
    private var lastSignalLevel: Int?
    private var lastDeviceStatusAt = Date.distantPast
    private var moduleAttached: Bool?
    private var errorThrottle = VoDogDiagThrottle()
    private var lastResetKey: String?
    private var consecutiveNetworkFailures = 0
    private var probeTask: Task<Void, Never>?
    private var provisionTask: Task<Void, Never>?

    init(imei: String, agent: GatewayAgent, appState: AppState) {
        self.imei = imei
        id = GatewayModuleIdentity.storageKey(imei: imei)
        displayKey = GatewayModuleIdentity.displayKey(imei: imei)
        self.agent = agent
        self.appState = appState
        isPaused = UserDefaults.standard.bool(forKey: Keys.paused + "." + GatewayModuleIdentity.storageKey(imei: imei))
        provision = UserDefaults.standard.data(forKey: Keys.provision + "." + GatewayModuleIdentity.storageKey(imei: imei))
            .flatMap { try? JSONDecoder().decode(GatewayProvisionState.self, from: $0) }
    }

    /// Structured diagnostics; safe to call from any thread (media/recording code runs off-main).
    /// Goes to the unified log, `~/Library/Logs/VoDog/gateway.log` and (above debug) the upload queue.
    /// Every event carries this module's gateway id and masked IMEI (the diag queue is per Mac).
    nonisolated var diag: GatewayDiag {
        { [tag, imei] event, level, callId, fields in
            var fields = fields
            if fields["gatewayId"] == nil, !tag.gatewayId.isEmpty { fields["gatewayId"] = tag.gatewayId }
            if fields["imei"] == nil { fields["imei"] = imei }
            GatewayDiagLog.shared.record(event, level: level, callId: callId, fields: fields)
        }
    }

    // MARK: Public surface (GatewayAgent / settings)

    /// Master switch or pause changed: run exactly when both allow it.
    func applyEnabled(action: String) {
        if isEnabled {
            defaults.set(Date(), forKey: Keys.enabledAt)
            startLoop(action: action)
        } else {
            stopLoop(sendOffline: true, reason: agent?.isEnabled == true ? "paused" : "disabled")
        }
    }

    func setPaused(_ paused: Bool) {
        guard paused != isPaused else { return }
        isPaused = paused
        defaults.set(paused, forKey: Keys.paused + "." + id)
        diag("gateway.state", "info", nil, ["paused": ["was": !paused, "now": paused]])
        applyEnabled(action: "resume")
    }

    /// Module detached from this Mac for good: stop without the controlEnabled=false beat (the
    /// all-false beat already went out when the module disappeared).
    func detach() {
        stopLoop(sendOffline: false, reason: "detached")
        provisionTask?.cancel()
        provisionTask = nil
    }

    func pair(code rawCode: String) {
        Task { _ = await pair(code: rawCode, baseURLString: agent?.baseURLString ?? GatewayAgent.defaultBaseURL) }
    }

    /// `POST /gateway/pair`, then Keychain + module copy. Returns the new credentials.
    func pair(code rawCode: String, baseURLString: String) async -> GatewayCredentials? {
        let code = rawCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isPairing, !code.isEmpty,
              let baseURL = URL(string: baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)),
              baseURL.scheme == "https" || baseURL.host == "localhost" || baseURL.host == "127.0.0.1" else {
            lastError = "Invalid server address or pairing code"
            return nil
        }
        guard let state = appState?.gatewayModuleState(imei: imei), state.modem.isConnected else {
            lastError = "Attach the module before pairing"
            return nil
        }
        isPairing = true
        let wasRunning = loopTask != nil
        if wasRunning { stopLoop(sendOffline: false, reason: "pairing") }
        defer {
            isPairing = false
            if wasRunning || isEnabled { applyEnabled(action: "paired") }
        }
        do {
            do {
                var request = URLRequest(url: baseURL.appendingPathComponent("api/v1/gateway/pair"), timeoutInterval: 20)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "label": "VoDog DJI 4G"])
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let json = GatewayJSON.object(String(decoding: data, as: UTF8.self))
                guard (200..<300).contains(status),
                      let token = json["deviceToken"] as? String,
                      let gateway = json["gateway"] as? [String: Any],
                      let gatewayId = gateway["id"] as? String,
                      let epoch = GatewayJSON.int(gateway["deviceEpoch"]) else {
                    let code = (json["error"] as? [String: Any])?["code"] as? String
                    throw GatewayHTTPError(status: status, code: code, body: data)
                }
                let paired = GatewayCredentials(baseURL: baseURL, deviceToken: token, gatewayId: gatewayId, deviceEpoch: epoch)
                try GatewayKeychain.save(paired, account: GatewayModuleIdentity.account(imei: imei))
                agent?.cacheCredentials(paired, imei: imei)
                boundKey = id
                moduleCopyChecked = true
                applyCredentials(paired)
                lastError = nil
                diag("gateway.state", "info", nil, ["paired": ["was": false, "now": true], "deviceEpoch": epoch,
                                                    "gatewayId": gatewayId, "credentialSource": "pairing"])
                // The module carries its own copy so any Mac it is plugged into can run it.
                if !(await pushModuleCopy(state.service, paired, imei: imei)) { pendingModulePush = true }
                return paired
            }
        } catch {
            lastError = L10n.tr("配对失败：%@", GatewayNetworkIssue.userMessage(for: error))
            GatewayDiagLog.shared.local("gateway.pair_failed", "\(error)")
            lastPairError = error
            return nil
        }
    }

    /// This module's gateway handles calls on `moduleID` (its own module) right now.
    func handlesCalls(on moduleID: CellularModuleID?) -> Bool {
        guard isEnabled, credentials != nil, sim != nil, current?.localOnly != true,
              let state = appState?.gatewayModuleState(imei: imei) else { return false }
        return moduleID == nil || moduleID == state.id
    }

    /// The call ringing on this module for remote clients: Control's id once bound (nil for the first
    /// 1–2 s, until +CLIP and the report round trip), and this gateway's SIM for matching before that.
    func ringingCall(on moduleID: CellularModuleID?) -> (callId: String?, simId: String?)? {
        guard handlesCalls(on: moduleID), let current, current.origin == .incoming, current.phase == .incoming,
              !current.blocked else { return nil }
        return (current.serverCallId, sim?.id)
    }

    /// S72 D2: Control said nobody should ring locally for this module's current incoming call.
    func silencesLocalRing(on moduleID: CellularModuleID?) -> Bool {
        guard handlesCalls(on: moduleID), let current, current.origin == .incoming else { return false }
        return current.silencedLocally || current.blocked
    }

    /// Paired with VoDog, whether running, paused or failed: the gateway owns this module's SMS.
    func ownsMessages(on moduleID: CellularModuleID) -> Bool {
        (credentials ?? agent?.storedCredentials(imei: imei)) != nil && appState?.gatewayModuleState(imei: imei)?.id == moduleID
    }

    /// Local M4A auto-recording is skipped only for calls the gateway bridges to the network.
    func suppressesLocalRecording(on moduleID: CellularModuleID?) -> Bool {
        handlesCalls(on: moduleID) && current?.origin != .localDial
    }

    /// A remote client owns this module's call: no local island / call card / in-call view / hang up.
    func bridgesRemoteCall(on moduleID: CellularModuleID?) -> Bool {
        guard let current else { return false }
        return GatewayRules.bridgesRemoteCall(handlesCalls: handlesCalls(on: moduleID),
                                              answeredRemotely: current.answeredRemotely,
                                              remoteDial: current.origin == .remoteDial)
    }

    func isBlockedSender(_ sender: String, moduleID: CellularModuleID) -> Bool {
        handlesCalls(on: moduleID) && isBlockedSMS(sender)
    }

    /// AppState calls this after any module's modem or call snapshot changed.
    func stateDidChange() {
        guard isEnabled, loopTask != nil, let state = appState?.gatewayModuleState(imei: imei) else { return }
        track(state)
    }

    /// New module messages from `MessageStore.merge`, including a long SMS replacing its stored partial (S84).
    func messagesArrived(_ messages: [SMSMessage], moduleID: CellularModuleID, isInitialSync: Bool) {
        guard loopTask != nil, let credentials, let sim, let state = appState?.gatewayModuleState(imei: imei),
              state.id == moduleID else { return }
        let enabledAt = defaults.object(forKey: Keys.enabledAt) as? Date ?? .distantPast
        for message in messages where !message.isOutgoing {
            // Initial sync also carries SIM history; only forward what arrived while the gateway was on.
            if isInitialSync, message.timestamp < enabledAt { continue }
            let body = String(message.body.prefix(5_000))
            guard !body.isEmpty, !message.sender.isEmpty else {
                diag("sms.incoming_skipped", "warn", nil, ["reason": "empty"])
                continue
            }
            var payload: [String: Any] = [
                "eventId": Self.newID(), "generation": credentials.deviceEpoch, "simId": sim.id,
                "assignmentVersion": sim.assignmentVersion, "remoteNumber": String(message.sender.prefix(64)),
                "body": body, "receivedAt": GatewayJSON.iso(message.timestamp),
            ]
            // S84: each generation of a long SMS carries the same key; Control updates its row in place.
            if let key = message.multipartKey { payload["multipartKey"] = String(key.prefix(128)) }
            payload["missingParts"] = message.missingParts
            let blocked = isBlockedSMS(message.sender)
            if blocked { payload["blockedLocally"] = true }
            diag("sms.received", "info", nil, ["parts": message.rawPDUs.count, "blocked": blocked,
                                               "initialSync": isInitialSync, "missingParts": message.missingParts,
                                               "awaitingParts": message.awaitingParts])
            // An awaiting partial keeps its slots so a restart can rebuild the cluster from the module.
            let forward = GatewaySMSForward(messageID: message.id,
                                            references: message.awaitingParts ? [] : message.effectiveModemReferences)
            let context = (try? JSONEncoder().encode(forward)).map { String(decoding: $0, as: UTF8.self) }
            enqueue("/gateway/sms/incoming", payload, kind: "sms.incoming", context: context)
        }
    }

    /// VoDog is the store for a gateway module, so no slot should outlive its message: anything
    /// VoDog has already saved locally and still sees on the module after `slotSweepGrace` (SIM history
    /// from before pairing, a failed post-forward delete) is deleted, retried at most once a minute.
    func sweepModuleSlots(_ relisted: [(message: SMSMessage, firstSeenAt: Date)], moduleID: CellularModuleID) {
        guard loopTask != nil, ownsMessages(on: moduleID),
              let service = appState?.gatewayModuleState(imei: imei)?.service else { return }
        let now = Date()
        slotSweepAttempts = slotSweepAttempts.filter { now.timeIntervalSince($0.value) < 3_600 }
        for (message, firstSeenAt) in relisted where !message.awaitingParts &&
            now.timeIntervalSince(firstSeenAt) >= Self.slotSweepGrace {
            let references = message.effectiveModemReferences
            guard !references.isEmpty,
                  now.timeIntervalSince(slotSweepAttempts[message.id] ?? .distantPast) >= 60 else { continue }
            slotSweepAttempts[message.id] = now
            diag("sms.slot_sweep", "info", nil, ["slots": references.count])
            service.deleteMessage(references: references) { [diag] result in
                if case let .failure(error) = result { diag("sms.slot_sweep_failed", "warn", nil, ["error": error]) }
            }
        }
    }

    /// Longer than a normal forward + delete round trip, so the sweep only catches leftovers.
    private static let slotSweepGrace: TimeInterval = 120
    private var slotSweepAttempts: [SMSMessage.ID: Date] = [:]

    /// A message the user sent from VoDog's own composer (S50).
    func localMessageSent(to destination: String, body: String, moduleID: CellularModuleID) {
        guard loopTask != nil, let credentials, let sim, !body.isEmpty,
              appState?.gatewayModuleState(imei: imei)?.id == moduleID else { return }
        diag("sms.local_sent", "info", nil, ["parts": (try? SMSPDUEncoder.encode(destination: destination, body: body))?.count ?? 0])
        enqueue("/gateway/sms/outgoing-observed", [
            "eventId": Self.newID(), "generation": credentials.deviceEpoch, "simId": sim.id,
            "assignmentVersion": sim.assignmentVersion, "remoteNumber": String(destination.prefix(64)),
            "body": String(body.prefix(5_000)), "sentAt": GatewayJSON.iso(Date()),
        ])
    }

    // MARK: Loop

    func startLoop(action: String) {
        guard isEnabled, loopTask == nil else { return }
        // Credentials are bound per attached module in `bind(_:)` on the first cycle.
        boundKey = nil
        syncedFingerprint = nil
        sentOfflineBeat = false
        lastMediaReady = nil
        snapshotDirty = true
        moduleAttached = nil
        diag("service.start", "info", nil, ["generation": credentials?.deviceEpoch ?? 0, "action": action,
                                            "installId": GatewayDiagLog.shared.installId])
        loopTask = Task { [weak self] in await self?.run() }
        probeTask = Task { [weak self] in await self?.runMediaProbes() }
    }

    func stopLoop(sendOffline: Bool, reason: String) {
        if loopTask != nil { diag("service.stop", "info", nil, ["reason": reason]) }
        loopTask?.cancel()
        loopTask = nil
        doorbellTask?.cancel()
        doorbellTask = nil
        doorbellHoldMs = 0
        probeTask?.cancel()
        probeTask = nil
        current?.media?.stop(reason: "gateway_disabled")
        current = nil
        pendingDial = nil
        appState?.gatewayModuleState(imei: imei)?.service.gatewayRemoteCall = false
        updatePowerAssertion(false)
        lastHeartbeatAt = nil
        if let http {
            // Control withdraws pending commands and closes calls on controlEnabled=false.
            let body = ledger.map { heartbeatBody(controlEnabled: false, telephony: false, sms: false, media: false, ledger: $0) }
            Task {
                if sendOffline, let body { _ = try? await http.json("POST", "/gateway/heartbeat", body, timeout: 10) }
                await self.agent?.flushDiag(http)
            }
        }
    }

    private func run() async {
        while !Task.isCancelled, isEnabled {
            await cycle()
            await nap(current == nil ? 2 : 1)
        }
    }

    private func nap(_ seconds: Double) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !wakeRequested, Date() < deadline, !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        wakeRequested = false
    }

    private func cycle() async {
        guard let state = appState?.gatewayModuleState(imei: imei) else {
            // Module gone from this Mac: one all-false beat, then silence until it is back.
            updatePowerAssertion(false)
            if !sentOfflineBeat, let http, let ledger, let credentials {
                sentOfflineBeat = true
                _ = await heartbeat(http, heartbeatBody(controlEnabled: true, telephony: false, sms: false, media: false, ledger: ledger), credentials)
            }
            return
        }
        await bind(state)
        guard let http, let ledger, let credentials else {
            // This module is not paired (on this Mac or on the module itself): stay idle.
            updatePowerAssertion(false)
            return
        }
        let connected = state.modem.isConnected
        updatePowerAssertion(connected)
        if connected != moduleAttached {
            diag("gateway.state", connected ? "info" : "warn", nil,
                 ["moduleAttached": ["was": Self.orNull(moduleAttached), "now": connected], "imei": state.modem.moduleIMEI ?? ""])
            moduleAttached = connected
        }
        track(state)
        logDeviceStatus(state)
        guard connected else {
            // Unplugged: one all-false beat, then silence until the module is back.
            if !sentOfflineBeat {
                sentOfflineBeat = true
                _ = await heartbeat(http, heartbeatBody(controlEnabled: true, telephony: false, sms: false, media: false, ledger: ledger), credentials)
            }
            await agent?.flushDiag(http)
            return
        }
        sentOfflineBeat = false
        await syncSIMIfNeeded(http, state)
        for entry in ledger.pendingAcks {
            guard let body = entry.ack, await sendAck(http, id: entry.id, body: body) else { break }
        }
        let registered = state.modem.registrationState.hasService || state.modem.voiceRegistrationState.hasService
        let cellular = state.modem.simReady && registered && sim != nil
        let media = state.call.voiceOverUSBSupported
        if media != lastMediaReady {
            lastMediaReady = media
            diag("gateway.dji4g.voice_runtime", media ? "info" : "warn", nil,
                 ["ready": media, "error": media ? "" : (state.call.lastError ?? "unknown")])
        }
        guard let response = await heartbeat(
            http,
            heartbeatBody(controlEnabled: true, telephony: cellular, sms: cellular, media: media, ledger: ledger),
            credentials
        ) else { return }
        let commands = (response["commands"] as? [[String: Any]] ?? []).compactMap(GatewayCommand.init)
        // A hangup later in this batch cancels its call's dial before the dial would place the call.
        cancelledDials = cancelledDials.filter { Date().timeIntervalSince($0.value) < 60 }
        for command in commands where command.kind == "hangup" && ledger.entry(command.id) == nil {
            if let callId = command.callId { cancelledDials[callId] = Date() }
        }
        for command in commands {
            guard !Task.isCancelled, isEnabled else { continue }
            // `state` predates the heartbeat and the earlier commands of this batch (a dial just placed
            // a call): execute against live state, with `current` re-tracked from it.
            let live = appState?.gatewayModuleState(imei: imei) ?? state
            track(live)
            let firstSeen = ledger.entry(command.id) == nil
            if firstSeen {
                diag("command.received", "info", command.callId, ["kind": command.kind, "sequence": command.sequence])
            }
            let startedAt = Date()
            lastCommandOutcome = nil
            await execute(command, http: http, ledger: ledger, state: live)
            if firstSeen {
                var fields: [String: Any] = [
                    "kind": command.kind, "ms": Self.ms(since: startedAt),
                    "sinceReceivedMs": Int(startedAt.timeIntervalSince(commandsReceivedAt) * 1_000),
                    "result": lastCommandOutcome?.status ?? "deferred",
                ]
                if let reason = lastCommandOutcome?.reason { fields["reason"] = reason }
                diag("command.executed", lastCommandOutcome?.status == "rejected" ? "warn" : "info", command.callId, fields)
            }
        }
        await flushOutbox(http)
        await sendSnapshotIfDue(http, state, credentials: credentials, ledger: ledger)
        await agent?.flushDiag(http)
    }

    private func heartbeatBody(controlEnabled: Bool, telephony: Bool, sms: Bool, media: Bool, ledger: GatewayCommandLedger) -> [String: Any] {
        var body: [String: Any] = [
            "controlEnabled": controlEnabled,
            "reportedSequence": ledger.reportedSequence,
            "capabilities": [
                "telephonyReady": telephony, "smsReady": sms, "mediaReady": media,
                "commandReconciliationReady": false,
            ],
            "timeZone": TimeZone.current.identifier,
            "kind": "dji4g", // S58: Control labels this gateway's calls/SIMs as DJI 4G.
        ]
        if let version = blocklist?.syncedVersion { body["numberBlocklistVersion"] = version }
        return body
    }

    private func heartbeat(_ http: GatewayHTTP, _ body: [String: Any], _ credentials: GatewayCredentials) async -> [String: Any]? {
        let startedAt = Date()
        if let wake = doorbellWakeAt {
            doorbellWakeAt = nil
            diag("doorbell.wake", "info", nil, ["ms": Int(startedAt.timeIntervalSince(wake) * 1_000)])
        }
        let gapMs = lastHeartbeatStartedAt.map { Int(startedAt.timeIntervalSince($0) * 1_000) }
        lastHeartbeatStartedAt = startedAt
        do {
            let response: [String: Any]
            do {
                response = try await http.json("POST", "/gateway/heartbeat", body, timeout: 6)
            } catch where GatewayNetworkIssue(error) != nil && !Task.isCancelled {
                // GatewayHTTP already dropped the stalled connection: retry once, right away, fresh.
                record(error, context: "heartbeat")
                response = try await http.json("POST", "/gateway/heartbeat", body, timeout: 6)
            }
            guard !Task.isCancelled else { return nil }
            commandsReceivedAt = Date()
            lastResetKey = nil
            consecutiveNetworkFailures = 0
            logHeartbeatRTT(ms: Self.ms(since: startedAt), gapMs: gapMs,
                            commands: (response["commands"] as? [Any])?.count ?? 0)
            let gateway = response["gateway"] as? [String: Any]
            if let epoch = GatewayJSON.int(gateway?["deviceEpoch"]), epoch != credentials.deviceEpoch {
                let message = "This gateway was re-paired elsewhere (epoch \(epoch)); pair again"
                if !recoverCredentials(message) { fail(message) }
                return nil
            }
            lastHeartbeatAt = Date()
            credentialRecoveryAttempted = false
            applyBlocklist(response["numberBlocklist"] as? [String: Any])
            earlyMedia = GatewayRules.earlyMedia(response)
            updateDoorbell(GatewayJSON.int((response["commandDoorbell"] as? [String: Any])?["maxHoldMs"]) ?? 0, http: http)
            return response
        } catch {
            record(error, context: "heartbeat")
            return nil
        }
    }

    private func updateDoorbell(_ holdMs: Int, http: GatewayHTTP) {
        doorbellHoldMs = holdMs
        guard holdMs > 0, doorbellTask == nil else { return }
        doorbellTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.isEnabled, self.doorbellHoldMs > 0 else { break }
                let hold = self.doorbellHoldMs
                do {
                    let response = try await http.json("POST", "/gateway/commands/doorbell", ["holdMs": hold],
                                                       timeout: Double(hold) / 1_000 + 10)
                    if response["wake"] as? Bool == true {
                        self.wakeRequested = true
                        self.doorbellWakeAt = Date()
                    }
                } catch {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
            self?.doorbellTask = nil
        }
    }

    private func applyBlocklist(_ raw: [String: Any]?) {
        guard let raw, sim != nil, let version = GatewayJSON.int(raw["version"]),
              GatewayBlocklist.shouldReplace(current: blocklist?.syncedVersion, next: version) else { return }
        let lists = GatewayBlocklist.lists(raw["items"] as? [[String: Any]] ?? [], simId: sim?.id)
        blocklist = GatewayBlocklistState(version: version, numbers: lists.call, smsNumbers: lists.sms)
        defaults.set(try? JSONEncoder().encode(blocklist), forKey: perGateway(Keys.blocklist))
    }

    private func isBlocked(_ number: String?) -> Bool {
        GatewayBlocklist.matches(number, listed: blocklist?.numbers ?? [], countryIso: sim?.countryIso)
    }

    private func isBlockedSMS(_ number: String?) -> Bool {
        GatewayBlocklist.matches(number, listed: blocklist?.smsNumbers ?? [], countryIso: sim?.countryIso)
    }

    private func syncSIMIfNeeded(_ http: GatewayHTTP, _ state: GatewayModuleState) async {
        guard state.modem.simReady, let iccid = state.modem.simICCID, !iccid.isEmpty else { return }
        let fingerprint = GatewayRules.iccidFingerprint(iccid)
        let phoneNumber = GatewayRules.syncPhoneNumber(state.modem.simPhoneNumber)
        // AT+CNUM may land after the ICCID; resync once when it does so Control can fill phone_label.
        let syncKey = fingerprint + "|" + (phoneNumber ?? "")
        guard syncKey != syncedFingerprint else { return }
        let countryIso = GatewayRules.countryIso(imsi: state.modem.simIMSI)
        var item: [String: Any] = [
            "slotIndex": 0, "subscriptionId": NSNull(), "phoneAccountHandle": NSNull(),
            "iccidFingerprint": fingerprint, "countryIso": Self.nullable(countryIso),
        ]
        if let phoneNumber { item["phoneNumber"] = phoneNumber }
        do {
            let response = try await http.json("POST", "/gateway/sims/sync", ["items": [item]])
            guard let item = (response["items"] as? [[String: Any]])?.first,
                  let id = item["id"] as? String,
                  let version = GatewayJSON.int(item["assignmentVersion"]) else { return }
            if sim?.id != id {
                blocklist = nil
                defaults.removeObject(forKey: perGateway(Keys.blocklist))
            }
            setSIM(GatewaySIMBinding(id: id, assignmentVersion: version, fingerprint: fingerprint,
                                     countryIso: countryIso, label: item["label"] as? String))
            syncedFingerprint = syncKey
        } catch {
            record(error, context: "sims/sync")
        }
    }

    private func setSIM(_ binding: GatewaySIMBinding) {
        sim = binding
        defaults.set(try? JSONEncoder().encode(binding), forKey: perGateway(Keys.sim))
    }

    // MARK: Module binding (portable per-module credentials)

    private func perGateway(_ key: String) -> String { key + "." + (credentials?.gatewayId ?? "none") }

    /// Binds the loop to the attached module's gateway: this Mac's Keychain copy first, then the copy
    /// the module carries (read over ADB while idle), newer epoch winning; the result is written back
    /// to whichever side is stale.
    private func bind(_ state: GatewayModuleState) async {
        guard state.modem.isConnected, let imei = state.modem.moduleIMEI, !imei.isEmpty else { return }
        let key = GatewayModuleIdentity.storageKey(imei: imei)
        if key != boundKey {
            if let http, let ledger, boundKey != nil {
                // The previous gateway's module is gone from this Mac: report it offline once.
                let body = heartbeatBody(controlEnabled: true, telephony: false, sms: false, media: false, ledger: ledger)
                _ = try? await http.json("POST", "/gateway/heartbeat", body, timeout: 10)
            }
            boundKey = key
            moduleCopyChecked = false
            moduleCopyFailures = 0
            moduleCopyRetryAt = .distantPast
            pendingModulePush = false
            credentialRecoveryAttempted = false
            applyCredentials(agent?.storedCredentials(imei: imei))
        }
        // ADB shares the modem queue with the voice runtime; never touch it during a call.
        guard !state.call.hasCall, Date() >= moduleCopyRetryAt else { return }
        if !moduleCopyChecked {
            let read: Result<Data?, Error> = await Self.moduleADB(state.service) {
                try $0.readPrivateFile(GatewayModuleIdentity.modulePath)
            }
            switch read {
            case let .success(data):
                moduleCopyChecked = true
                resolveCredentials(imei: imei, module: data.flatMap { try? JSONDecoder().decode(GatewayCredentials.self, from: $0) })
            case let .failure(error):
                moduleCopyFailures += 1
                moduleCopyRetryAt = Date().addingTimeInterval(60)
                diag("gateway.module_copy_failed", "warn", nil, ["op": "read", "imei": imei].merging(GatewayDiagLog.errorFields(error)) { current, _ in current })
                // ADB unusable: after 3 tries decide from this Mac alone (may still claim the legacy item).
                if moduleCopyFailures >= 3 {
                    moduleCopyChecked = true
                    resolveCredentials(imei: imei, module: nil)
                }
            }
        }
        if pendingModulePush, let credentials, Date() >= moduleCopyRetryAt {
            _ = await pushModuleCopy(state.service, credentials, imei: imei)
        }
    }

    private func resolveCredentials(imei: String, module: GatewayCredentials?) {
        let key = GatewayModuleIdentity.storageKey(imei: imei)
        let stored = agent?.storedCredentials(imei: imei)
        let legacy = GatewayKeychain.load(account: GatewayModuleIdentity.legacyAccount)
        let resolution = GatewayCredentialResolution.resolve(stored: stored, legacy: legacy, module: module)
        if resolution.saveToKeychain, let chosen = resolution.credentials {
            do {
                try GatewayKeychain.save(chosen, account: GatewayModuleIdentity.account(imei: imei))
                agent?.cacheCredentials(chosen, imei: imei)
            } catch {
                diag("gateway.error", "warn", nil, GatewayDiagLog.errorFields(error).merging(["route": "keychain"]) { $1 })
            }
        }
        if resolution.deleteLegacy, agent?.storedCredentials(imei: imei) != nil {
            GatewayKeychain.delete(account: GatewayModuleIdentity.legacyAccount)
        }
        pendingModulePush = resolution.pushToModule
        diag("gateway.state", "info", nil, [
            "credentialSource": resolution.source ?? "none", "imei": imei,
            "gatewayId": String((resolution.credentials?.gatewayId ?? "").prefix(8)),
            "deviceEpoch": resolution.credentials?.deviceEpoch ?? 0, "moduleCopy": module != nil,
        ])
        applyCredentials(resolution.credentials)
    }

    /// Switches every per-gateway store (ledger, outbox, SIM binding, blocklist) to `next`.
    private func applyCredentials(_ next: GatewayCredentials?) {
        guard next != credentials || (next != nil && http == nil) else { return }
        credentials = next
        doorbellTask?.cancel()
        doorbellTask = nil
        doorbellHoldMs = 0
        syncedFingerprint = nil
        sentOfflineBeat = false
        snapshotDirty = true
        guard let next else {
            http = nil
            ledger = nil
            outbox = nil
            sim = nil
            blocklist = nil
            return
        }
        let id = next.gatewayId
        tag.gatewayId = id
        boundAt = Date()
        // One-time move of the single-gateway (pre-IMEI) stores to the first gateway bound here.
        let manager = FileManager.default
        for (legacyName, name) in [("commands.json", "commands-\(id).json"), ("outbox.json", "outbox-\(id).json")] {
            let legacy = directory.appendingPathComponent(legacyName), target = directory.appendingPathComponent(name)
            if manager.fileExists(atPath: legacy.path), !manager.fileExists(atPath: target.path) {
                try? manager.moveItem(at: legacy, to: target)
            }
        }
        for key in [Keys.sim, Keys.blocklist] where defaults.object(forKey: key) != nil {
            if defaults.object(forKey: key + "." + id) == nil { defaults.set(defaults.object(forKey: key), forKey: key + "." + id) }
            defaults.removeObject(forKey: key)
        }
        http = GatewayHTTP(credentials: next)
        ledger = GatewayCommandLedger(url: GatewayStorePaths.ledger(directory, gatewayId: id), generation: next.deviceEpoch)
        outbox = GatewayOutbox(url: GatewayStorePaths.outbox(directory, gatewayId: id))
        sim = defaults.data(forKey: Keys.sim + "." + id).flatMap { try? JSONDecoder().decode(GatewaySIMBinding.self, from: $0) }
        blocklist = defaults.data(forKey: Keys.blocklist + "." + id).flatMap { try? JSONDecoder().decode(GatewayBlocklistState.self, from: $0) }
    }

    @discardableResult
    private func pushModuleCopy(_ service: ModemService, _ credentials: GatewayCredentials, imei: String) async -> Bool {
        guard let data = try? JSONEncoder().encode(credentials) else { return false }
        let result: Result<Void, Error> = await Self.moduleADB(service) {
            try $0.writePrivateFile(data, to: GatewayModuleIdentity.modulePath)
        }
        switch result {
        case .success:
            pendingModulePush = false
            diag("gateway.state", "info", nil, ["moduleCopy": "written", "imei": imei, "deviceEpoch": credentials.deviceEpoch])
            return true
        case let .failure(error):
            pendingModulePush = true
            moduleCopyRetryAt = Date().addingTimeInterval(60)
            diag("gateway.module_copy_failed", "warn", nil, ["op": "write", "imei": imei].merging(GatewayDiagLog.errorFields(error)) { current, _ in current })
            return false
        }
    }

    /// A 401 or epoch fence may just mean the module was re-paired on another Mac: re-read the
    /// module's copy once before giving up. Returns false when that was already tried.
    private func recoverCredentials(_ message: String) -> Bool {
        guard !credentialRecoveryAttempted, boundKey != nil else { return false }
        credentialRecoveryAttempted = true
        moduleCopyChecked = false
        moduleCopyFailures = 0
        moduleCopyRetryAt = .distantPast
        lastError = message + " (re-reading the module's copy)"
        diag("gateway.state", "warn", nil, ["credentialRecovery": message])
        return true
    }

    private static func moduleADB<V>(_ service: ModemService,
                                     _ body: @escaping (ModuleVoiceRuntime) throws -> V) async -> Result<V, Error> {
        await withCheckedContinuation { continuation in
            service.withModuleADB(completion: { continuation.resume(returning: $0) }, body: body)
        }
    }

    // MARK: Commands

    private func execute(_ command: GatewayCommand, http: GatewayHTTP, ledger: GatewayCommandLedger, state: GatewayModuleState) async {
        // Redelivered while pending: never re-execute; re-send a finished ACK verbatim.
        if let entry = ledger.entry(command.id) {
            if entry.state == .done, !entry.ackDelivered, let body = entry.ack {
                _ = await sendAck(http, id: command.id, body: body, callId: command.callId)
            }
            return
        }
        let finish: (String, [String: Any], String?) async -> Void = { [weak self] status, result, telecomState in
            let body = GatewayCommandLedger.ackBody(generation: command.generation, status: status,
                                                    result: result, telecomState: telecomState)
            ledger.finish(id: command.id, sequence: command.sequence, kind: command.kind, ack: body)
            self?.lastCommandOutcome = (status, result["reason"] as? String)
            _ = await self?.sendAck(http, id: command.id, body: body, callId: command.callId)
        }
        let notExecuted: (String) async -> Void = { reason in
            await finish("rejected", ["phase": "not_executed", "reason": reason], nil)
        }
        // Moving a module between Macs: the other Mac's ledger may hold this command as started.
        // A side-effecting command issued before this Mac bound the gateway is never executed here.
        let lifetimes: [String: TimeInterval] = ["dial": 30, "send_sms": 120, "dtmf": 20]
        if let lifetime = lifetimes[command.kind], let expiresAt = command.expiresAt,
           expiresAt.addingTimeInterval(-lifetime) < boundAt {
            await finish("rejected", ["phase": "unknown", "reason": "issued_before_attach"],
                         command.kind == "dial" ? "UNKNOWN" : nil)
            return
        }
        if command.kind != "apply_sim_settings", let expiresAt = command.expiresAt, expiresAt <= Date() {
            await notExecuted("command_expired")
            return
        }
        let service = state.service
        let call = state.call
        let executedAt = GatewayJSON.iso(Date())

        switch command.kind {
        case "apply_sim_settings":
            let payload = command.payload
            guard let simId = payload["simId"] as? String, let sim, simId == sim.id,
                  let settingsVersion = GatewayJSON.int(payload["settingsVersion"]),
                  let assignmentVersion = GatewayJSON.int(payload["assignmentVersion"]) else {
                await notExecuted("sim_not_found")
                return
            }
            // Control is authoritative for the assignment version; later sms/incoming must carry it.
            if assignmentVersion != sim.assignmentVersion {
                var updated = sim
                updated.assignmentVersion = assignmentVersion
                setSIM(updated)
            }
            await finish("acked", ["simId": simId, "appliedVersion": settingsVersion, "assignmentVersion": assignmentVersion], nil)

        case "dial":
            guard let callId = command.callId,
                  let number = command.payload["remoteNumber"] as? String,
                  command.payload["simId"] as? String == sim?.id else {
                await notExecuted("sim_not_found")
                return
            }
            if cancelledDials[callId] != nil {
                diag("dial.cancelled", "info", callId, ["commandId": command.id])
                await notExecuted("call_already_ended")
                return
            }
            guard call.canDial, current == nil else {
                await notExecuted("device_busy")
                return
            }
            let now = Self.nowMillis()
            let deviceCallId = GatewayRules.deviceCallId(locationID: state.modem.usbLocationID ?? 0, firstSeenMillis: now)
            ledger.begin(id: command.id, sequence: command.sequence, kind: command.kind, deviceCallId: deviceCallId)
            pendingDial = (callId, deviceCallId, now)
            service.gatewayRemoteCall = true
            service.gatewayEarlyMedia = earlyMedia
            let result = await Self.modemResult { service.dial(number, completion: $0) }
            // `canDial` required idle, so an outgoing call now can only be the one our ATD started.
            let after = appState?.gatewayModuleState(imei: imei)?.call
            let ourCall = after?.hasCall == true && after?.direction == .outgoing
            switch result {
            case .success:
                await finish("acked", ["phase": "submitted", "executedAt": executedAt, "deviceCallId": deviceCallId], "DIALING")
            case let .failure(message) where !ourCall:
                pendingDial = nil
                service.gatewayRemoteCall = false
                await finish("rejected", ["phase": "not_executed", "reason": "dial_failed", "detail": message], nil)
            case let .failure(message):
                await finish("rejected", ["phase": "unknown", "reason": "execution_unknown", "detail": message], "UNKNOWN")
            }

        case "answer":
            guard let tracked = current, tracked.origin == .incoming, call.phase == .incoming else {
                await notExecuted(current == nil ? "call_already_ended" : "call_not_found")
                return
            }
            if let deviceCallId = command.payload["deviceCallId"] as? String, deviceCallId != tracked.deviceCallId {
                await notExecuted("call_mapping_mismatch")
                return
            }
            ledger.begin(id: command.id, sequence: command.sequence, kind: command.kind)
            tracked.answeredRemotely = true
            // Local call UI hides for remotely answered calls; the island observes AppState, not the agent.
            appState?.objectWillChange.send()
            tracked.answeredByAi = command.payload["answeredBy"] as? String == "ai"
            if tracked.serverCallId == nil { tracked.serverCallId = command.callId }
            service.gatewayRemoteCall = true
            let result = await Self.modemResult { service.answerCall(completion: $0) }
            let after = appState?.gatewayModuleState(imei: imei)?.call
            switch result {
            case .success:
                await finish("acked", ["phase": "submitted", "executedAt": executedAt, "deviceCallId": tracked.deviceCallId],
                             after?.phase == .active ? "ACTIVE" : "RINGING")
            case let .failure(message) where after?.phase != .recovering:
                tracked.answeredRemotely = false
                appState?.objectWillChange.send()
                service.gatewayRemoteCall = false
                await finish("rejected", ["phase": "not_executed",
                                          "reason": after?.hasCall == true ? "answer_failed" : "call_already_ended",
                                          "detail": message], nil)
            case let .failure(message):
                await finish("rejected", ["phase": "unknown", "reason": "execution_unknown", "detail": message], "UNKNOWN")
            }

        case "hangup":
            guard call.hasCall, let tracked = current,
                  GatewayRules.hangupMatches(commandCallId: command.callId,
                                             payloadDeviceCallId: command.payload["deviceCallId"] as? String,
                                             serverCallId: tracked.serverCallId, deviceCallId: tracked.deviceCallId) else {
                guard let callId = command.callId, !confirmedAbsent.contains(where: { $0.id == callId }) else {
                    await notExecuted("call_already_ended")
                    return
                }
                // Not on the module and never ended here: its dial has not run yet. Refuse that dial
                // when it comes (tombstone) and report the call over; nothing was sent to the module.
                cancelledDials[callId] = Date()
                diag("call.local_end", "info", callId, ["trigger": "command_hangup"])
                await finish("acked", ["phase": "submitted", "executedAt": executedAt, "dialCancelled": true], "DISCONNECTED")
                return
            }
            ledger.begin(id: command.id, sequence: command.sequence, kind: command.kind)
            localEnd(tracked, "command_hangup")
            let result = await Self.modemResult { service.hangUp(completion: $0) }
            switch result {
            case .success:
                await finish("acked", ["phase": "submitted", "executedAt": executedAt, "deviceCallId": tracked.deviceCallId], "DISCONNECTED")
            case let .failure(message):
                await finish("rejected", ["phase": "unknown", "reason": "execution_unknown", "detail": message], "UNKNOWN")
            }

        case "dtmf":
            guard let digits = command.payload["digits"] as? String, GatewayRules.isValidDTMF(digits) else {
                await notExecuted("invalid_digits")
                return
            }
            guard call.canSendDTMF, current != nil else {
                await notExecuted("no_call")
                return
            }
            ledger.begin(id: command.id, sequence: command.sequence, kind: command.kind)
            // One AT+VTS per digit, never retried: a repeat would select an IVR option twice.
            var sent = 0
            for digit in digits {
                guard case .success = await Self.modemResult({ service.sendDTMF(String(digit), completion: $0) }) else { break }
                sent += 1
            }
            if sent == digits.count {
                await finish("acked", ["digits": sent], nil)
            } else {
                await finish("rejected", ["phase": sent == 0 ? "not_executed" : "unknown",
                                          "reason": sent == 0 ? "dtmf_failed" : "execution_unknown", "sent": sent], nil)
            }

        case "send_sms":
            guard let number = command.payload["remoteNumber"] as? String,
                  let body = command.payload["body"] as? String else {
                await notExecuted("invalid_payload")
                return
            }
            guard GatewayRules.isValidSMSDestination(number) else {
                await notExecuted("invalid_destination")
                return
            }
            guard command.payload["simId"] as? String == sim?.id else {
                await notExecuted("sim_not_found")
                return
            }
            // ponytail: the module refuses SMS during a call; leave it pending so Control redelivers
            // it next beat (it expires after 2 min if the call outlasts that). Re-read: `call` predates the beat.
            guard appState?.gatewayModuleState(imei: imei)?.call.hasCall == false else { return }
            ledger.begin(id: command.id, sequence: command.sequence, kind: command.kind)
            let parts = (try? SMSPDUEncoder.encode(destination: number, body: body))?.count ?? 0
            let sendStartedAt = Date()
            let result: SMSMessageSendResult = await withCheckedContinuation { continuation in
                service.sendMessage(to: number, body: body) { continuation.resume(returning: $0) }
            }
            let smsFields: [String: Any] = ["smsId": command.smsId ?? "", "parts": parts, "ms": Self.ms(since: sendStartedAt)]
            switch result {
            case .success:
                diag("sms.send", "info", nil, smsFields.merging(["result": "submitted"]) { $1 })
                diag("sms.sent", "info", nil, smsFields.merging(["result": "ok"]) { $1 })
                await finish("acked", ["phase": "submitted", "executedAt": executedAt], nil)
                if let smsId = command.smsId, let credentials {
                    enqueue("/gateway/sms/\(smsId)/events",
                            ["eventId": Self.newID(), "generation": credentials.deviceEpoch, "state": "sent"])
                }
            case let .failure(message, isDeliveryUncertain):
                diag("sms.failed", "warn", nil, smsFields.merging([
                    "result": isDeliveryUncertain ? "execution_unknown" : "send_failed", "error": String(message.prefix(120)),
                ]) { $1 })
                await finish("rejected", isDeliveryUncertain
                    ? ["phase": "unknown", "reason": "execution_unknown", "detail": message, "executedAt": executedAt]
                    : ["phase": "not_executed", "reason": "send_failed", "detail": message], nil)
            }

        default:
            await notExecuted("unsupported_kind")
        }
    }

    /// Returns false when delivery should be retried later.
    /// `callId`: the command's call, when known (the ledger's pending-ack replay has none).
    private func sendAck(_ http: GatewayHTTP, id: String, body: String, callId: String? = nil) async -> Bool {
        do {
            _ = try await http.send("POST", "/gateway/commands/\(id)/ack", body: Data(body.utf8))
            ledger?.markDelivered(id)
            return true
        } catch let error as GatewayHTTPError where Self.isPermanent(error) {
            ledger?.markDelivered(id)
            diag("command.ack_dropped", "warn", callId, ["status": error.status, "code": error.code ?? ""])
            return true
        } catch {
            record(error, context: "ack")
            return false
        }
    }

    // MARK: Calls

    private func track(_ state: GatewayModuleState) {
        let call = state.call
        guard call.hasCall else {
            if let ended = current {
                current = nil
                pendingDial = nil
                ended.ended = true
                ended.endReason = call.lastEndReason
                diag("telephony.state", "info", ended.serverCallId, [
                    "deviceCallId": ended.deviceCallId, "state": "ENDED",
                    "causeReason": call.lastEndReason?.rawValue ?? "unknown", "wasActive": ended.wasActive,
                ])
                state.service.gatewayRemoteCall = false
                end(ended)
                snapshotDirty = true
                wakeRequested = true
            }
            return
        }
        let tracked: GatewayTrackedCall
        if let current {
            tracked = current
        } else {
            let direction = call.direction ?? (call.phase == .incoming ? .incoming : .outgoing)
            if direction == .outgoing, let dial = pendingDial {
                tracked = GatewayTrackedCall(deviceCallId: dial.deviceCallId, firstSeenMillis: dial.firstSeenMillis,
                                             origin: .remoteDial, direction: .outgoing)
                tracked.serverCallId = dial.callId
                tracked.reported = true
            } else {
                let now = Self.nowMillis()
                tracked = GatewayTrackedCall(
                    deviceCallId: GatewayRules.deviceCallId(locationID: state.modem.usbLocationID ?? 0, firstSeenMillis: now),
                    firstSeenMillis: now, origin: direction == .incoming ? .incoming : .localDial, direction: direction
                )
            }
            current = tracked
        }
        if let number = call.number, !number.isEmpty { tracked.number = number }
        if call.phase != tracked.phase {
            tracked.phase = call.phase
            snapshotDirty = true
            wakeRequested = true
            diag("telephony.state", "info", tracked.serverCallId, [
                "deviceCallId": tracked.deviceCallId, "state": Self.telephonyState(call.phase),
                "direction": tracked.direction.rawValue, "origin": "\(tracked.origin)",
            ])
        }
        if !tracked.reported {
            switch tracked.origin {
            case .incoming:
                // RING usually precedes +CLIP; wait up to 2 s for the number (blocklist + fingerprint).
                if tracked.number != nil || Self.nowMillis() - tracked.firstSeenMillis >= 2_000 {
                    reportIncoming(tracked, service: state.service)
                }
            case .localDial:
                reportLocalDial(tracked)
            case .remoteDial:
                break
            }
        }
        if call.phase == .active, !tracked.wasActive {
            tracked.wasActive = true
            if tracked.origin != .localDial, !tracked.blocked, let callId = tracked.serverCallId {
                enqueueCallState(callId, "active")
            }
            tracked.media?.arm()
        }
        // S58: a module-dialed call is archived like a Pixel-dialed one once active and bound.
        if tracked.origin == .localDial, tracked.wasActive, tracked.localRecording == nil,
           let callId = tracked.serverCallId, let http {
            let recording = GatewayLocalDialRecording(
                http: http, callId: callId,
                capture: GatewayCapture(deviceCallId: tracked.deviceCallId, telecomCreationTimeMillis: tracked.firstSeenMillis),
                modem: state.service, diag: diag
            )
            tracked.localRecording = recording
            recording.start()
        }
        // S56: with early media the leg opens pre-answer (downlink only) and arms at active.
        let early = tracked.origin == .remoteDial && state.service.gatewayEarlyMedia &&
            (call.phase == .dialing || call.phase == .alerting)
        let wantsMedia = (tracked.origin == .remoteDial && (call.phase == .alerting || call.phase == .active || early)) ||
            (tracked.origin == .incoming && tracked.answeredRemotely && call.phase == .active)
        if wantsMedia, tracked.media == nil, let callId = tracked.serverCallId, let http {
            let session = GatewayMediaSession(
                http: http, callId: callId,
                capture: GatewayCapture(deviceCallId: tracked.deviceCallId, telecomCreationTimeMillis: tracked.firstSeenMillis),
                modem: state.service, early: early, answeredByAi: tracked.answeredByAi, diag: diag
            )
            session.onFailure = { [weak self, weak tracked, diag] reason in
                diag("media.session_failed", "error", callId, ["code": reason])
                Task { @MainActor in
                    guard let self, let tracked, !tracked.ended else { return }
                    tracked.mediaFailure = reason
                    self.stateDidChange()
                }
            }
            tracked.media = session
            if early { diag("media.early_started", "info", callId, ["phase": Self.telephonyState(call.phase)]) }
            session.start()
        }
        // S73b: only bridged calls own a media leg (`wantsMedia`), so local-only / local-dial calls never get here.
        // A pre-answer (early media) failure hangs up as soon as the call goes active.
        if let reason = tracked.mediaFailure,
           GatewayRejoinPolicy.hangsUpCall(active: call.phase == .active, alreadyRequested: tracked.mediaHangupRequested) {
            tracked.mediaHangupRequested = true
            diag("media.hangup_after_failure", "warn", tracked.serverCallId, ["reason": reason])
            localEnd(tracked, "media_terminal_failure")
            state.service.hangUp { [diag, callId = tracked.serverCallId] result in
                if case let .failure(message) = result {
                    diag("media.hangup_after_failure_failed", "warn", callId, ["error": String(message.prefix(120))])
                }
            }
        }
    }

    private func reportIncoming(_ tracked: GatewayTrackedCall, service: ModemService) {
        guard let credentials, let sim else { return }
        tracked.reported = true
        var body: [String: Any] = [
            "eventId": Self.newID(), "generation": credentials.deviceEpoch, "deviceCallId": tracked.deviceCallId,
            "simId": sim.id, "remoteNumber": Self.nullable(tracked.number.map { String($0.prefix(64)) }),
            "observedAt": GatewayJSON.iso(Date(timeIntervalSince1970: Double(tracked.firstSeenMillis) / 1_000)),
        ]
        if isBlocked(tracked.number) {
            tracked.blocked = true
            body["blockedLocally"] = true
            localEnd(tracked, "blocked")
            service.hangUp { [diag] result in
                if case let .failure(message) = result { diag("telephony.block_hangup_failed", "warn", nil, ["error": message]) }
            }
        }
        awaitingCallId[tracked.deviceCallId] = tracked
        enqueue("/gateway/calls/incoming", body, kind: "call.incoming", context: tracked.deviceCallId)
    }

    private func reportLocalDial(_ tracked: GatewayTrackedCall) {
        guard let credentials, let sim else { return }
        tracked.reported = true
        awaitingCallId[tracked.deviceCallId] = tracked
        // Control does not advance state on re-report; active and the end ride the telecom snapshot.
        enqueue("/gateway/calls/outgoing-observed", [
            "eventId": Self.newID(), "generation": credentials.deviceEpoch, "deviceCallId": tracked.deviceCallId,
            "simId": sim.id, "remoteNumber": Self.nullable(tracked.number.map { String($0.prefix(64)) }),
            "observedAt": GatewayJSON.iso(Date(timeIntervalSince1970: Double(tracked.firstSeenMillis) / 1_000)),
            "telecomState": tracked.phase == .active ? "active" : "dialing",
        ], kind: "call.outgoing", context: tracked.deviceCallId)
    }

    /// Final report for a call that left CLCC. Runs again once a late server id arrives.
    private func end(_ tracked: GatewayTrackedCall) {
        tracked.media?.stop(reason: "call_ended")
        tracked.localRecording?.stop()
        guard let callId = tracked.serverCallId else { return }
        awaitingCallId[tracked.deviceCallId] = nil
        if tracked.origin != .localDial, !tracked.blocked {
            // Mirrors Control's own rule: answered → ended, never answered → failed.
            enqueueCallState(callId, tracked.wasActive ? "ended" : "failed",
                             failureReason: tracked.wasActive ? nil : (tracked.endReason?.rawValue ?? "not_answered"))
        }
        confirmedAbsent.append((callId, Date()))
        if tracked.media != nil || tracked.localRecording?.started == true, let http {
            GatewayRecordingArchive.enqueueUpload(callId: callId, http: http, diag: diag)
        }
    }

    /// S75: the first local hang-up reason wins; logged now or once `telephony.bound` supplies the call id.
    private func localEnd(_ tracked: GatewayTrackedCall, _ trigger: String) {
        if tracked.localEndTrigger == nil { tracked.localEndTrigger = trigger }
        logLocalEnd(tracked)
    }

    private func logLocalEnd(_ tracked: GatewayTrackedCall) {
        guard let trigger = tracked.localEndTrigger, !tracked.localEndLogged, let callId = tracked.serverCallId else { return }
        tracked.localEndLogged = true
        diag("call.local_end", "info", callId, ["trigger": trigger, "deviceCallId": tracked.deviceCallId])
    }

    private func enqueueCallState(_ callId: String, _ state: String, failureReason: String? = nil) {
        guard let credentials else { return }
        var body: [String: Any] = ["eventId": Self.newID(), "generation": credentials.deviceEpoch, "state": state]
        if let failureReason { body["failureReason"] = failureReason }
        enqueue("/gateway/calls/\(callId)/events", body, kind: "call.state")
    }

    private func sendSnapshotIfDue(_ http: GatewayHTTP, _ state: GatewayModuleState, credentials: GatewayCredentials, ledger: GatewayCommandLedger) async {
        guard snapshotDirty || Date().timeIntervalSince(lastSnapshotAt) >= 10 else { return }
        // `state` was read at cycle start, before heartbeat/commands/outbox (seconds). A hang-up in
        // between left a stale busy snapshot and the end's dirty mark was wiped below, so Control saw
        // local_busy for one more ~10 s period (2026-09-26 GATEWAY_BUSY on redial). Re-read live state.
        let call = appState?.gatewayModuleState(imei: imei)?.call ?? state.call
        track(GatewayModuleState(id: state.id, service: state.service, modem: state.modem, call: call))
        // Clear before the POST: an end tracked while it is in flight re-marks and is sent next cycle.
        snapshotDirty = false
        confirmedAbsent.removeAll { Date().timeIntervalSince($0.at) > 300 }
        var calls: [[String: Any]] = []
        if let tracked = current, let snapshotState = GatewayRules.snapshotState(tracked.phase) {
            var item: [String: Any] = ["deviceCallId": tracked.deviceCallId, "direction": tracked.direction.rawValue,
                                       "state": snapshotState]
            if let sim { item["simId"] = sim.id }
            if let callId = tracked.serverCallId { item["callId"] = callId }
            calls.append(item)
        }
        // Monotonic across restarts: wall-clock millis, never below the last one sent.
        let sequence = max(defaults.integer(forKey: Keys.snapshotSequence) + 1, Int(Self.nowMillis()))
        defaults.set(sequence, forKey: Keys.snapshotSequence)
        let body: [String: Any] = [
            "snapshotId": Self.newID(), "snapshotSequence": sequence, "generation": credentials.deviceEpoch,
            "reportedSequence": ledger.reportedSequence, "localBusy": call.hasCall,
            "confirmedAbsentCallIds": Array(Set(confirmedAbsent.map(\.id)).prefix(16)),
            "calls": calls, "observedAt": GatewayJSON.iso(Date()),
        ]
        do {
            let response = try await http.json("POST", "/gateway/telecom/snapshot", body, timeout: 6)
            lastSnapshotAt = Date()
            let released = Set(response["releasedCallIds"] as? [String] ?? [])
            confirmedAbsent.removeAll { released.contains($0.id) }
            // VoDog has no system CallLog: every purge is `not_found` (spec S53 不做).
            let purges = (response["callLogPurges"] as? [[String: Any]] ?? []).compactMap { $0["purgeId"] as? String }
            if !purges.isEmpty {
                _ = try? await http.json("POST", "/gateway/call-log-purges/ack", [
                    "acks": purges.prefix(50).map { ["purgeId": $0, "status": "not_found", "deletedRows": 0] },
                ])
            }
        } catch {
            lastSnapshotAt = Date()
            snapshotDirty = true
            record(error, context: "telecom/snapshot")
        }
    }

    // MARK: Media probes

    /// Control picks the call's media node only from fresh probe evidence of this gateway subject
    /// (≥2 ok of the latest 3 per node, 120 s TTL). Basic HTTPS RTT probes, like the Pixel's.
    private func runMediaProbes() async {
        while !Task.isCancelled, isEnabled {
            guard let http, isOnline else {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                continue
            }
            var wait: TimeInterval = 10
            do {
                let generation = agent?.networkGeneration ?? "mac-0"
                let options = try await http.json("POST", "/gateway/media/probes/options", ["networkGeneration": generation])
                var samples: [[String: Any]] = []
                for node in options["nodes"] as? [[String: Any]] ?? [] {
                    guard let nodeId = node["nodeId"] as? String, let url = (node["probeUrl"] as? String).flatMap(URL.init(string:)),
                          url.scheme == "https" else { continue }
                    for grant in node["grants"] as? [String] ?? [] {
                        samples.append(await Self.probe(url: url, nodeId: nodeId, grant: grant))
                    }
                }
                guard !samples.isEmpty, !Task.isCancelled else { throw GatewayHTTPError(status: 0, code: "no_probe_nodes", body: Data()) }
                let result = try await http.json("POST", "/gateway/media/probes/results",
                                                 ["networkGeneration": generation, "samples": Array(samples.prefix(48))])
                let failed = samples.filter { $0["outcome"] as? String != "ok" }
                if !failed.isEmpty {
                    diag("media.probe", "warn", nil, ["samples": samples.count, "failed": failed.count,
                                                      "timeout": failed.filter { $0["outcome"] as? String == "timeout" }.count])
                }
                // Refresh when the evidence is within 20 s of expiring (Pixel cadence).
                let expiresAt = GatewayJSON.date(result["expiresAt"]) ?? GatewayJSON.date(options["expiresAt"])
                wait = max(1, (expiresAt?.timeIntervalSinceNow ?? 30) - 20)
            } catch {
                if !Task.isCancelled { diag("media.probe", "warn", nil, GatewayDiagLog.errorFields(error)) }
            }
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        }
    }

    private static let probeSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 5
        return URLSession(configuration: configuration, delegate: GatewayNoRedirect(), delegateQueue: nil)
    }()

    private static func probe(url: URL, nodeId: String, grant: String) async -> [String: Any] {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("Bearer \(grant)", forHTTPHeaderField: "Authorization")
        let started = DispatchTime.now().uptimeNanoseconds
        do {
            let (data, response) = try await probeSession.data(for: request)
            let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
            let json = GatewayJSON.object(String(decoding: data.prefix(4_096), as: UTF8.self))
            guard (response as? HTTPURLResponse)?.statusCode == 200, json["ok"] as? Bool == true,
                  json["nodeId"] as? String == nodeId else { return ["nodeId": nodeId, "outcome": "network_error"] }
            return ["nodeId": nodeId, "outcome": "ok", "httpsRttMs": min(elapsedMs, 10_000)]
        } catch let error as URLError where error.code == .timedOut {
            return ["nodeId": nodeId, "outcome": "timeout"]
        } catch {
            return ["nodeId": nodeId, "outcome": "network_error"]
        }
    }

    // MARK: Outbox and diagnostics

    private func enqueue(_ path: String, _ body: [String: Any], kind: String = "event", context: String? = nil) {
        let eventId = body["eventId"] as? String ?? Self.newID()
        outbox?.enqueue(GatewayOutboxItem(eventId: eventId, path: path, body: GatewayJSON.string(body), kind: kind, context: context))
        wakeRequested = true
    }

    private func flushOutbox(_ http: GatewayHTTP) async {
        guard let outbox else { return }
        while let item = outbox.head(), !Task.isCancelled {
            do {
                let data = try await http.send("POST", item.path, body: Data(item.body.utf8))
                outbox.remove(item.eventId)
                handleResponse(item, GatewayJSON.object(String(decoding: data, as: UTF8.self)))
            } catch let error as GatewayHTTPError where Self.isPermanent(error) {
                // FENCE_REJECTED (old epoch), EVENT_ID_REUSED, NOT_FOUND, validation: retrying cannot help.
                outbox.remove(item.eventId)
                if let context = item.context { awaitingCallId[context] = nil }
                diag("gateway.event_dropped", "warn", nil, ["kind": item.kind, "status": error.status, "code": error.code ?? ""])
            } catch {
                outbox.deferItem(item.eventId)
                record(error, context: item.kind)
                return
            }
        }
    }

    private func handleResponse(_ item: GatewayOutboxItem, _ response: [String: Any]) {
        switch item.kind {
        case "call.incoming", "call.outgoing":
            guard let deviceCallId = item.context, let tracked = awaitingCallId[deviceCallId] ?? current.flatMap({
                $0.deviceCallId == deviceCallId ? $0 : nil
            }) else { return }
            let callId = (response["call"] as? [String: Any])?["id"] as? String ?? response["callId"] as? String
            switch response["disposition"] as? String {
            case "dropped_blocked":
                tracked.blocked = true
            case "local_only":
                // Give the local answer buttons back; the island observes AppState, not the agent.
                tracked.localOnly = true
                appState?.objectWillChange.send()
            default:
                break
            }
            if item.kind == "call.incoming" {
                tracked.silencedLocally = GatewayRules.silencesLocalRing(
                    disposition: response["disposition"] as? String, call: response["call"] as? [String: Any])
                appState?.refreshIncomingRing()  // late local_only must start the ring, AI must stop it
            }
            guard let callId else {
                awaitingCallId[deviceCallId] = nil
                return
            }
            tracked.serverCallId = callId
            diag("telephony.bound", "info", callId, ["deviceCallId": deviceCallId])
            logLocalEnd(tracked)
            if tracked.ended {
                end(tracked)
            } else {
                awaitingCallId[deviceCallId] = nil
                stateDidChange() // S58: a local dial that is already active starts its recording now.
            }
            snapshotDirty = true
        case "sms.incoming":
            diag("sms.forwarded", "info", nil, ["smsId": response["smsId"] as? String ?? "",
                                                "disposition": response["disposition"] as? String ?? ""])
            // Control has the message: only now is it safe to free the module slot.
            guard let context = item.context,
                  let forward = try? JSONDecoder().decode(GatewaySMSForward.self, from: Data(context.utf8)),
                  !forward.references.isEmpty,
                  let service = appState?.gatewayModuleState(imei: imei)?.service else { return }
            service.deleteMessage(references: forward.references) { [diag] result in
                if case let .failure(message) = result { diag("sms.module_delete_failed", "warn", nil, ["error": message]) }
            }
        default:
            break
        }
    }

    private func logHeartbeatRTT(ms: Int, gapMs: Int?, commands: Int) {
        // S69 (Pixel rule): slow = >1.5 s round trip or a cycle gap over twice the expected poll; slow samples
        // only count into `heartbeat.summary`. A single uploaded warn only past 5 s (4G); the rest stay local.
        let expectedGapMs = current == nil ? 2_000 : 1_000
        let slow = ms > 1_500 || (gapMs ?? 0) > 2 * expectedGapMs
        var fields: [String: Any] = ["ms": ms, "commands": commands]
        if let gapMs { fields["gapMs"] = gapMs }
        if slow { fields["expectedGapMs"] = expectedGapMs }
        diag("heartbeat.rtt", ms > 5_000 ? "warn" : "debug", nil, fields)
        let now = Date()
        rtt.count += 1
        rtt.min = min(rtt.min, ms)
        rtt.max = max(rtt.max, ms)
        rtt.sum += ms
        if slow { rtt.slow += 1 }
        rtt.maxGap = max(rtt.maxGap, gapMs ?? 0)
        if rtt.dueAt == .distantPast { rtt.dueAt = now.addingTimeInterval(300) }
        if now >= rtt.dueAt {
            diag("heartbeat.summary", "info", nil,
                 ["count": rtt.count, "minMs": rtt.min, "avgMs": rtt.sum / rtt.count, "maxMs": rtt.max,
                  "slowCount": rtt.slow, "maxGapMs": rtt.maxGap])
            rtt = (0, Int.max, 0, 0, 0, 0, now.addingTimeInterval(300))
        }
    }

    /// `telephony.signal` on a level change; `device.status` every 60 s.
    private func logDeviceStatus(_ state: GatewayModuleState) {
        let modem = state.modem
        if modem.isConnected, modem.signalBars != lastSignalLevel {
            lastSignalLevel = modem.signalBars
            diag("telephony.signal", "info", nil, ["slot": 0, "level": modem.signalBars, "dbm": Self.orNull(modem.signalDBm)])
        }
        guard Date().timeIntervalSince(lastDeviceStatusAt) >= 60 else { return }
        lastDeviceStatusAt = Date()
        let process = ProcessInfo.processInfo
        diag("device.status", "info", nil, [
            "module": ["present": modem.isConnected, "state": modem.state.rawValue, "imei": modem.moduleIMEI ?? ""],
            "sims": [[
                "slot": 0, "carrier": modem.operatorName ?? "", "simState": "\(modem.simState)",
                "radio": modem.accessTechnology ?? "", "signalLevel": modem.signalBars, "dbm": Self.orNull(modem.signalDBm),
                "registration": "\(modem.registrationState)", "voiceRegistration": "\(modem.voiceRegistrationState)",
                "volte": Self.orNull(modem.volteSessionAvailable),
            ]],
            "voiceRuntimeReady": state.call.voiceOverUSBSupported,
            "callState": "\(state.call.phase)",
            "online": isOnline,
            "network": ["transport": agent?.transport ?? "unknown"],
            "mac": [
                "sleepAssertion": powerAssertion != 0, "thermal": process.thermalState.rawValue,
                "lowPower": process.isLowPowerModeEnabled, "uptimeS": Int(process.systemUptime),
            ],
            "queues": ["outbox": outbox?.items.count ?? 0, "diag": GatewayDiagLog.shared.pendingCount,
                       "pendingAcks": ledger?.pendingAcks.count ?? 0],
        ])
    }

    private func record(_ error: Error, context: String) {
        if let error = error as? GatewayHTTPError, error.status == 401 {
            let message = "Device credentials were revoked; pair again"
            if !recoverCredentials(message) { fail(message) }
            return
        }
        guard !Task.isCancelled else { return }
        // Short category text for the settings card; the full error goes to gateway.log / diag below.
        lastError = "\(Date().formatted(date: .omitted, time: .standard)) \(GatewayNetworkIssue.userMessage(for: error))"
        if let issue = GatewayNetworkIssue(error) {
            consecutiveNetworkFailures += 1
            let resetKey = "\(context)|\(issue.rawValue)"
            diag("gateway.connection_reset", resetKey == lastResetKey ? "debug" : "warn", nil, [
                "context": context, "code": (error as? URLError)?.code.rawValue ?? 0, "issue": issue.rawValue,
                "consecutiveFailures": consecutiveNetworkFailures,
            ])
            lastResetKey = resetKey
        }
        // S69: {domain, code, route}, one uploaded row per key per 60 s with `repeat`; repeats stay local (debug).
        GatewayDiagLog.shared.local("gateway.error_detail", "\(context): \(error)")  // full text, this Mac only
        let identity = GatewayDiagLog.errorIdentity(error)
        var fields: [String: Any] = ["domain": identity.domain, "code": identity.code, "route": context]
        if let serverCode = identity.serverCode { fields["serverCode"] = serverCode }
        if let repeats = errorThrottle.admit("\(context)|\(identity.domain)|\(identity.code)", now: Date()) {
            if repeats > 0 { fields["repeat"] = repeats }
            diag("gateway.error", "warn", nil, fields)
        } else {
            diag("gateway.error", "debug", nil, fields)
        }
    }

    private func fail(_ message: String) {
        lastError = message
        diag("gateway.state", "error", nil, ["paused": ["was": isPaused, "now": true], "reason": message])
        isPaused = true
        defaults.set(true, forKey: Keys.paused + "." + id)
        stopLoop(sendOffline: false, reason: message)
    }

    private func updatePowerAssertion(_ hold: Bool) {
        if hold, powerAssertion == 0 {
            var id: IOPMAssertionID = 0
            if IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                           IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                           "VoDog gateway" as CFString, &id) == kIOReturnSuccess {
                powerAssertion = id
            }
        } else if !hold, powerAssertion != 0 {
            IOPMAssertionRelease(powerAssertion)
            powerAssertion = 0
        }
    }

    private static func isPermanent(_ error: GatewayHTTPError) -> Bool {
        (400..<500).contains(error.status) && ![401, 408, 429].contains(error.status)
    }

    /// Optionals must become NSNull: a nil boxed in Any is not JSON and would void the whole row.
    private static func orNull<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }

    private static func ms(since date: Date) -> Int { Int(Date().timeIntervalSince(date) * 1_000) }

    private static func telephonyState(_ phase: CallPhase) -> String {
        switch phase {
        case .incoming: return "RINGING"
        case .dialing: return "DIALING"
        case .alerting: return "ALERTING"
        case .active: return "ACTIVE"
        case .ending: return "DISCONNECTING"
        case .recovering: return "RECOVERING"
        case .idle, .unavailable, .error: return "ENDED"
        }
    }

    private static func nullable(_ value: String?) -> Any { value.map { $0 as Any } ?? NSNull() }

    private static func newID() -> String { UUID().uuidString.lowercased() }

    private static func nowMillis() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }

    private static func modemResult(_ body: (@escaping (ModemActionResult) -> Void) -> Void) async -> ModemActionResult {
        await withCheckedContinuation { continuation in body { continuation.resume(returning: $0) } }
    }
}

struct GatewayModuleState {
    let id: CellularModuleID
    let service: ModemService
    let modem: ModemSnapshot
    let call: CallSnapshot
}

/// Media probes must hit the probe URL itself; a redirect is a failed probe.
private final class GatewayNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// MARK: - One-click "加入账号" (S54)

extension GatewayRuntime {
    var isProvisioning: Bool { provisionTask != nil }

    /// Admin only; resumes at the step that failed last time.
    func startProvisioning(account: VoDogAccount) {
        guard provisionTask == nil, account.isAdmin, account.user != nil else { return }
        provisionTask = Task { [weak self] in
            await self?.runProvisioning(account)
            self?.provisionTask = nil
            self?.objectWillChange.send()
        }
        objectWillChange.send()
    }

    private func saveProvision(_ state: GatewayProvisionState) {
        provision = state
        defaults.set(try? JSONEncoder().encode(state), forKey: Keys.provision + "." + id)
    }

    private static func errorCode(_ error: Error?) -> String {
        if let error = error as? VoDogAPIError { return error.code ?? "HTTP_\(error.status)" }
        if let error = error as? GatewayHTTPError { return error.code ?? "HTTP_\(error.status)" }
        if let error, let issue = GatewayNetworkIssue(error) { return "NETWORK_\(issue.rawValue)" }
        return error.map { String(describing: type(of: $0)) } ?? "UNKNOWN"
    }

    private func runProvisioning(_ account: VoDogAccount) async {
        var state = provision ?? GatewayProvisionState()
        if state.isFinished { state = GatewayProvisionState() }
        state.failure = nil
        saveProvision(state)
        let log: (GatewayProvisionState.Step, String, String?) -> Void = { [diag] step, result, code in
            var fields: [String: Any] = ["step": step.rawValue, "result": result]
            if let code { fields["code"] = code }
            diag("gateway.provision", result == "failed" ? "warn" : "info", nil, fields)
        }
        while !state.isFinished, !state.isFailed, !Task.isCancelled {
            let step = state.step
            do {
                switch step {
                case .createGateway:
                    let response = try await account.json("POST", "/admin/gateways",
                                                          body: ["name": GatewayProvisionState.gatewayName(imei: imei)],
                                                          idempotent: true)
                    guard let gatewayId = (response["gateway"] as? [String: Any])?["id"] as? String else {
                        throw VoDogAPIError(status: 0, code: "BAD_RESPONSE", message: nil, body: Data())
                    }
                    state.gatewayId = gatewayId
                case .pairingCode:
                    guard let gatewayId = state.gatewayId else { state.step = .createGateway; continue }
                    let response = try await account.json("POST", "/admin/gateways/\(gatewayId)/pairing-codes", idempotent: true)
                    guard let code = (response["pairingCode"] as? [String: Any])?["code"] as? String else {
                        throw VoDogAPIError(status: 0, code: "BAD_RESPONSE", message: nil, body: Data())
                    }
                    state.pairingCode = code
                case .pair:
                    guard let code = state.pairingCode else { state.step = .pairingCode; continue }
                    guard let paired = await pair(code: code, baseURLString: account.baseURL.absoluteString) else {
                        state.fail(.pair, code: Self.errorCode(lastPairError))
                        log(step, "failed", state.failure)
                        continue
                    }
                    state.pairingCode = nil
                    state.gatewayId = paired.gatewayId
                    // Run this module now: the SIM only syncs from a running gateway.
                    setPaused(false)
                    if agent?.isEnabled == false { agent?.setEnabled(true) } else { applyEnabled(action: "provisioned") }
                case .waitSIM:
                    let deadline = Date().addingTimeInterval(120)
                    while sim == nil || credentials?.gatewayId != state.gatewayId {
                        guard Date() < deadline, !Task.isCancelled else {
                            throw VoDogAPIError(status: 0, code: "SIM_NOT_SYNCED", message: nil, body: Data())
                        }
                        try await Task.sleep(nanoseconds: 2_000_000_000)
                    }
                    state.simId = sim?.id
                case .assignOwner:
                    guard let user = account.user, state.simId != nil else {
                        throw VoDogAPIError(status: 401, code: "NOT_SIGNED_IN", message: nil, body: Data())
                    }
                    let firstTried = state.ownerFirstTriedAt ?? Date()
                    state.ownerFirstTriedAt = firstTried
                    while true {
                        // S65: a resync may hand back a different row id (SIM moved from another gateway).
                        if credentials?.gatewayId == state.gatewayId, let current = sim?.id { state.simId = current }
                        let simId = state.simId ?? ""
                        do {
                            let sims = try await account.json("GET", "/admin/sims")
                            guard let row = (sims["items"] as? [[String: Any]])?.first(where: { $0["id"] as? String == simId }),
                                  let version = GatewayJSON.int(row["version"]) else {
                                throw VoDogAPIError(status: 409, code: "SIM_ABSENT", message: nil, body: Data())
                            }
                            let response = try await account.json("PUT", "/admin/sims/\(simId)/owner",
                                                                  body: ["ownerUserId": user.id, "expectedVersion": version])
                            state.simVersion = GatewayJSON.int((response["sim"] as? [String: Any])?["version"])
                            break
                        } catch let error as VoDogAPIError
                                    where GatewayProvisionState.ownerRetryable(code: error.code, firstTriedAt: firstTried) {
                            log(step, "retry", error.code)
                            try await Task.sleep(nanoseconds: 10_000_000_000)
                        }
                    }
                case .labelSIM:
                    // Optional polish: a failure here never undoes the assignment.
                    if let simId = state.simId, let version = state.simVersion {
                        let modem = appState?.gatewayModuleState(imei: imei)?.modem
                        var body: [String: Any] = [
                            "label": String("\(modem?.operatorName ?? "SIM") DJI".prefix(80)), "expectedVersion": version,
                        ]
                        if let number = modem?.simPhoneNumber, !number.isEmpty { body["phoneLabel"] = String(number.prefix(80)) }
                        do {
                            _ = try await account.json("PUT", "/sims/\(simId)", body: body)
                        } catch {
                            log(step, "skipped", Self.errorCode(error))
                        }
                    }
                case .done:
                    continue
                }
                state.succeed(step)
                log(step, "ok", nil)
            } catch {
                if Task.isCancelled { break }
                state.fail(step, code: Self.errorCode(error))
                log(step, "failed", state.failure)
            }
            saveProvision(state)
        }
        saveProvision(state)
    }
}
