import CryptoKit
import Foundation

// VoDog gateway: pure, Foundation-only logic (spec S53). Compiled into the app and into
// Tests/GatewayControlSelfTests, so nothing here may touch ModemService, AppKit or the network.

enum GatewayJSON {
    static func string(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    static func object(_ string: String) -> [String: Any] {
        ((try? JSONSerialization.jsonObject(with: Data(string.utf8))) as? [String: Any]) ?? [:]
    }

    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func date(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    static func int(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let text = value as? String { return Int(text) }
        return nil
    }
}

enum GatewayRules {
    /// The module's call belongs to a remote client (answered by Web/app/AI, or dialed by one): the Mac
    /// must not show its local call UI or end it. Unowned-SIM, `local_only` and S58 `.localDial` calls
    /// arrive with `handlesCalls` false or neither flag set and keep the local bar.
    static func bridgesRemoteCall(handlesCalls: Bool, answeredRemotely: Bool, remoteDial: Bool) -> Bool {
        handlesCalls && (answeredRemotely || remoteDial)
    }

    /// S72 D2: the module rings on this Mac only for calls nobody else rings for. Unowned SIM / `local_only`
    /// (not gateway-owned) always ring; a gateway-owned call stays silent when Control handles it without a
    /// human (AI mode, busy AI, busy reject, internal peer, blocked) or when a VoDog session on this
    /// Mac rings it through the client panel instead.
    static func ringsModuleLocally(gatewayOwned: Bool, silenced: Bool, clientSignedIn: Bool) -> Bool {
        gatewayOwned ? !silenced && !clientSignedIn : true
    }

    /// A hangup targets the module's call only on a positive match: its server id, or the device id
    /// Control copied into the payload. Control's `/end` sends `deviceCallId: null` before the dial ACK,
    /// so "no device id" must never mean "whatever call is up" (it would hang up an unrelated call).
    static func hangupMatches(commandCallId: String?, payloadDeviceCallId: String?,
                              serverCallId: String?, deviceCallId: String) -> Bool {
        (commandCallId != nil && commandCallId == serverCallId) || payloadDeviceCallId == deviceCallId
    }

    /// S72 D2: Control's `/gateway/calls/incoming` answer says nobody should ring locally for this call.
    /// `answerMode == "ai"` alone (not `aiHandling`, which waits for the AI run); `timeout_ai` rings.
    static func silencesLocalRing(disposition: String?, call: [String: Any]?) -> Bool {
        disposition == "rejected_busy" || disposition == "dropped_blocked"
            || call?["internal"] as? Bool == true || call?["conflictDisposition"] as? String == "ai_answered"
            || call?["answerMode"] as? String == "ai"
    }

    /// S51 destination rule, identical to Control's.
    static func isValidSMSDestination(_ value: String) -> Bool {
        value.range(of: #"^(\+[1-9][0-9]{5,14}|[0-9]{3,20})$"#, options: .regularExpression) != nil
    }

    static func isValidDTMF(_ value: String) -> Bool {
        value.range(of: #"^[0-9*#]{1,32}$"#, options: .regularExpression) != nil
    }

    /// Control re-hashes this, so it only has to be stable per SIM: lowercase hex SHA-256, first 32.
    static func iccidFingerprint(_ iccid: String) -> String {
        let digest = SHA256.hash(data: Data(iccid.uppercased().utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(32))
    }

    /// S65: the AT+CNUM number for `/gateway/sims/sync` `phoneNumber`; nil unless it matches Control's rule.
    static func syncPhoneNumber(_ raw: String?) -> String? {
        guard let number = raw?.filter({ $0 != " " && $0 != "-" }),
              number.range(of: #"^\+?[0-9]{3,20}$"#, options: .regularExpression) != nil else { return nil }
        return number
    }

    static func deviceCallId(locationID: UInt32, firstSeenMillis: Int64) -> String {
        String(format: "dji4g-%08x-", locationID) + String(firstSeenMillis)
    }

    static func countryIso(imsi: String?) -> String? {
        // ponytail: only mainland China is recognised (QDC507 ships with CN SIMs); nil otherwise.
        imsi?.hasPrefix("460") == true ? "CN" : nil
    }

    static func isUUID(_ value: String?) -> Bool {
        value.flatMap(UUID.init(uuidString:)) != nil
    }

    /// Telecom snapshot `calls[].state` for a VoDog call phase; nil when not reportable.
    static func snapshotState(_ phase: CallPhase) -> String? {
        switch phase {
        case .incoming: return "ringing"
        case .dialing, .alerting: return "dialing"
        case .active: return "active"
        case .ending, .recovering, .idle, .unavailable, .error: return nil
        }
    }

    /// S56: heartbeat response top-level `earlyMedia` (absent ⇒ false).
    static func earlyMedia(_ response: [String: Any]) -> Bool {
        response["earlyMedia"] as? Bool == true
    }

    /// `media/options` body. S56: a pre-answer (early media) leg omits `capture`; the binding is
    /// fetched from `capture-binding` once the call is active.
    static func mediaOptionsBody(transport: String, capture: GatewayCapture?) -> [String: Any] {
        var body: [String: Any] = ["transport": transport]
        if let capture { body["capture"] = captureBody(capture) }
        return body
    }

    static func captureBody(_ capture: GatewayCapture) -> [String: Any] {
        ["deviceCallId": capture.deviceCallId, "telecomCreationTimeMillis": capture.telecomCreationTimeMillis]
    }
}

/// S41 heartbeat blocklist. Digit-key equality, plus CN national/E.164 forms when the SIM is CN.
enum GatewayBlocklist {
    // ponytail: only +86 is folded (single CN SIM); port Pixel's CALLING_CODES table if other SIMs appear.
    static func keys(_ raw: String?, countryIso: String?) -> Set<String> {
        var digits = (raw ?? "").filter(\.isASCII).filter(\.isNumber)
        if digits.hasPrefix("00") { digits.removeFirst(2) }
        guard !digits.isEmpty, digits != "112", digits != "911" else { return [] }
        var keys: Set<String> = [digits]
        guard countryIso?.uppercased() == "CN" else { return keys }
        if digits.hasPrefix("86"), digits.count > 3 {
            keys.insert(String(digits.dropFirst(2)))
        } else {
            let national = digits.hasPrefix("0") && digits.count > 1 ? String(digits.dropFirst()) : digits
            keys.insert(national)
            keys.insert("86" + national)
        }
        return keys.subtracting(["112", "911"])
    }

    static func matches(_ remote: String?, listed: [String], countryIso: String?) -> Bool {
        let remoteKeys = keys(remote, countryIso: countryIso)
        guard !remoteKeys.isEmpty else { return false }
        return listed.contains { !keys($0, countryIso: countryIso).isDisjoint(with: remoteKeys) }
    }

    /// S66: `numbers` is the call list, `smsNumbers` the SMS list (absent from pre-S66 Control → empty).
    static func lists(_ items: [[String: Any]], simId: String?) -> (call: [String], sms: [String]) {
        let mine = items.filter { $0["simId"] as? String == simId }
        return (mine.flatMap { $0["numbers"] as? [String] ?? [] }, mine.flatMap { $0["smsNumbers"] as? [String] ?? [] })
    }

    /// Same-version no-op, higher replaces, lower ignored; the first snapshot always replaces.
    static func shouldReplace(current: Int?, next: Int) -> Bool {
        next >= 0 && (current == nil || next > current!)
    }
}

// MARK: - Command ledger (`gateway/commands.json`)

struct GatewayCommandEntry: Codable, Equatable {
    enum State: String, Codable { case started, done }
    var id: String
    var sequence: Int
    var kind: String
    var state: State
    /// Full ACK request body, persisted before the first send and re-sent verbatim.
    var ack: String?
    var ackDelivered = false
    var updatedAt: Date
    var deviceCallId: String?
}

final class GatewayCommandLedger {
    private struct File: Codable {
        var generation: Int
        var reportedFloor: Int
        var commands: [GatewayCommandEntry]
    }

    /// Kinds whose side effect must never be replayed after an unclean exit.
    static let ambiguousKinds: Set<String> = ["dial", "send_sms", "dtmf"]

    private let url: URL
    private var file: File

    var generation: Int { file.generation }
    var entries: [GatewayCommandEntry] { file.commands }

    init(url: URL, generation: Int, now: Date = Date()) {
        self.url = url
        let loaded = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder.gateway.decode(File.self, from: $0) }
        if let loaded, loaded.generation == generation {
            file = loaded
        } else {
            file = File(generation: generation, reportedFloor: 0, commands: [])
        }
        // A `started` row survived a crash or quit: its side effect is unknown.
        for index in file.commands.indices where file.commands[index].state == .started {
            let entry = file.commands[index]
            if Self.ambiguousKinds.contains(entry.kind) {
                file.commands[index].state = .done
                file.commands[index].ack = Self.ackBody(
                    generation: generation,
                    status: "rejected",
                    result: ["phase": "unknown", "reason": "ambiguous_after_restart"],
                    telecomState: entry.kind == "dial" ? "UNKNOWN" : nil
                )
                file.commands[index].updatedAt = now
            }
        }
        // answer/hangup/apply_sim_settings are safe to re-run when Control redelivers them.
        file.commands.removeAll { $0.state == .started }
        save()
    }

    static func ackBody(generation: Int, status: String, result: [String: Any], telecomState: String? = nil) -> String {
        var body: [String: Any] = ["generation": generation, "status": status, "result": result]
        if let telecomState { body["telecomState"] = telecomState }
        return GatewayJSON.string(body)
    }

    func entry(_ id: String) -> GatewayCommandEntry? {
        file.commands.first { $0.id == id }
    }

    func begin(id: String, sequence: Int, kind: String, deviceCallId: String? = nil, now: Date = Date()) {
        guard entry(id) == nil else { return }
        file.commands.append(GatewayCommandEntry(
            id: id, sequence: sequence, kind: kind, state: .started, ack: nil,
            updatedAt: now, deviceCallId: deviceCallId
        ))
        save()
    }

    /// Records the final ACK body; `begin` is implied for commands rejected before execution.
    func finish(id: String, sequence: Int, kind: String, ack: String, now: Date = Date()) {
        if let index = file.commands.firstIndex(where: { $0.id == id }) {
            file.commands[index].state = .done
            file.commands[index].ack = ack
            file.commands[index].updatedAt = now
        } else {
            file.commands.append(GatewayCommandEntry(
                id: id, sequence: sequence, kind: kind, state: .done, ack: ack, updatedAt: now
            ))
        }
        save()
    }

    func markDelivered(_ id: String, now: Date = Date()) {
        guard let index = file.commands.firstIndex(where: { $0.id == id }) else { return }
        file.commands[index].ackDelivered = true
        file.commands[index].updatedAt = now
        file.reportedFloor = reportedSequence
        prune(now: now)
        save()
    }

    var pendingAcks: [GatewayCommandEntry] {
        file.commands.filter { $0.state == .done && !$0.ackDelivered }.sorted { $0.sequence < $1.sequence }
    }

    /// Highest sequence such that every command this device has seen at or below it is ACKed.
    /// Sequences Control consumed without delivering (expired, superseded) do not block it.
    var reportedSequence: Int {
        var result = file.reportedFloor
        for entry in file.commands.sorted(by: { $0.sequence < $1.sequence }) where entry.sequence > result {
            guard entry.state == .done, entry.ackDelivered else { break }
            result = entry.sequence
        }
        return result
    }

    private func prune(now: Date) {
        let floor = file.reportedFloor
        file.commands.removeAll {
            $0.ackDelivered && $0.sequence <= floor && now.timeIntervalSince($0.updatedAt) > 3_600
        }
    }

    private func save() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder.gateway.encode(file) { try? data.write(to: url, options: .atomic) }
    }
}

// MARK: - Event outbox (`gateway/outbox.json`)

struct GatewayOutboxItem: Codable, Equatable {
    var eventId: String
    var path: String
    /// Request body; contains `eventId` and `generation` when the route takes them.
    var body: String
    /// `call.incoming`, `call.outgoing`, `sms.incoming` get response handling; everything else is fire-and-forget.
    var kind: String
    /// Opaque context for the response handler (deviceCallId, encoded module PDU references, message id).
    var context: String?
    var attempts = 0
    var nextAttemptAt = Date.distantPast
}

final class GatewayOutbox {
    private let url: URL
    private(set) var items: [GatewayOutboxItem]

    init(url: URL) {
        self.url = url
        items = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder.gateway.decode([GatewayOutboxItem].self, from: $0) } ?? []
    }

    func enqueue(_ item: GatewayOutboxItem) {
        items.append(item)
        save()
    }

    /// FIFO head, so incoming-before-state and connecting→active→ended stay ordered.
    func head(now: Date = Date()) -> GatewayOutboxItem? {
        guard let first = items.first, first.nextAttemptAt <= now else { return nil }
        return first
    }

    func remove(_ eventId: String) {
        items.removeAll { $0.eventId == eventId }
        save()
    }

    func deferItem(_ eventId: String, now: Date = Date()) {
        guard let index = items.firstIndex(where: { $0.eventId == eventId }) else { return }
        items[index].attempts += 1
        items[index].nextAttemptAt = now.addingTimeInterval(min(60, pow(2, Double(items[index].attempts))))
        save()
    }

    private func save() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder.gateway.encode(items) { try? data.write(to: url, options: .atomic) }
    }
}

extension JSONEncoder {
    static var gateway: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

extension JSONDecoder {
    static var gateway: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

// MARK: - Module identity and portable credentials

/// A DJI module is identified by its IMEI (`AT+CGSN`), which follows it across USB ports and Macs.
/// The full IMEI is never stored in a key name or uploaded.
enum GatewayModuleIdentity {
    static let legacyAccount = "credentials"
    /// Where the module keeps its own copy of the credentials (read/written over ADB).
    static let modulePath = "/data/vodog/vodog-gateway.json"

    static func storageKey(imei: String) -> String {
        let digest = SHA256.hash(data: Data(("celldock-gateway-imei:" + imei.filter(\.isNumber)).utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(16))
    }

    static func account(imei: String) -> String { "credentials." + storageKey(imei: imei) }

    static func displayKey(imei: String) -> String { "imei:" + String(imei.filter(\.isNumber).suffix(6)) }

    static func diagKey(imei: String) -> String { "imei:***" + String(imei.filter(\.isNumber).suffix(4)) }
}

struct GatewayCredentialResolution: Equatable {
    var credentials: GatewayCredentials?
    /// `keychain`, `module` or `legacy`; nil when unpaired.
    var source: String?
    var saveToKeychain = false
    var deleteLegacy = false
    var pushToModule = false

    /// `stored` is this Mac's copy for the module, `module` the copy read from the module itself
    /// (nil when it has none). The pre-IMEI `legacy` item is only claimed by a module that has
    /// neither. The module copy wins for a different gateway (the hardware moved), a higher epoch
    /// (re-paired elsewhere), or the same epoch with another token; otherwise this Mac's copy wins
    /// and is written back to the module.
    static func resolve(stored: GatewayCredentials?, legacy: GatewayCredentials?,
                        module: GatewayCredentials?) -> GatewayCredentialResolution {
        let local = stored ?? (module == nil ? legacy : nil)
        let claimsLegacy = stored == nil && module == nil && legacy != nil
        let chosen: GatewayCredentials?
        let source: String?
        switch (local, module) {
        case (nil, nil):
            chosen = nil; source = nil
        case let (local?, nil):
            chosen = local; source = claimsLegacy ? "legacy" : "keychain"
        case let (nil, module?):
            chosen = module; source = "module"
        case let (local?, module?):
            let moduleWins = module.gatewayId != local.gatewayId || module.deviceEpoch > local.deviceEpoch ||
                (module.deviceEpoch == local.deviceEpoch && module != local)
            chosen = moduleWins ? module : local
            source = moduleWins ? "module" : "keychain"
        }
        return GatewayCredentialResolution(
            credentials: chosen, source: source,
            saveToKeychain: chosen != nil && chosen != stored,
            deleteLegacy: claimsLegacy,
            pushToModule: chosen != nil && chosen != module
        )
    }
}

// MARK: - Transport failures

extension GatewayNetworkIssue {
    /// Settings-card text; the full error stays in gateway.log and diagnostics.
    static func userMessage(for error: Error) -> String {
        if let issue = GatewayNetworkIssue(error) {
            switch issue {
            case .timeout: return L10n.tr("心跳超时，已自动重连")
            case .connectionLost: return L10n.tr("网络连接中断，正在重连")
            case .cannotConnect: return L10n.tr("无法连接服务器")
            case .offline: return L10n.tr("Mac 未连接网络")
            case .tls: return L10n.tr("安全连接失败，正在重连")
            }
        }
        if let error = error as? GatewayHTTPError {
            if error.status == 401 { return L10n.tr("设备凭据已失效") }
            if error.status >= 500 { return L10n.tr("服务器暂时不可用") }
        }
        return L10n.tr("网关请求失败")
    }
}

// MARK: - One-click "加入账号" provisioning (S54)

/// Admin flow for an unpaired module: create gateway → pairing code → pair → wait for the first
/// SIM sync → assign the SIM to the signed-in user → (optional) label it. Persisted per module so a
/// retry resumes at the failed step and never creates a second gateway row.
struct GatewayProvisionState: Codable, Equatable {
    enum Step: String, Codable, CaseIterable {
        case createGateway, pairingCode, pair, waitSIM, assignOwner, labelSIM, done
    }

    var step: Step = .createGateway
    var gatewayId: String?
    var pairingCode: String?
    var simId: String?
    var simVersion: Int?
    /// Error code of the step that stopped the flow; nil while running or when done.
    var failure: String?
    var ownerFirstTriedAt: Date?

    var isFinished: Bool { step == .done }
    var isFailed: Bool { failure != nil }

    /// Move past a step that succeeded.
    mutating func succeed(_ finished: Step) {
        guard finished == step, let index = Step.allCases.firstIndex(of: step),
              index + 1 < Step.allCases.count else { return }
        step = Step.allCases[index + 1]
        failure = nil
    }

    /// Stop at `step`; a stale or used pairing code sends the retry back to minting a new one.
    mutating func fail(_ failed: Step, code: String) {
        failure = code
        if failed == .pair, code == "PAIRING_CODE_INVALID" {
            step = .pairingCode
            pairingCode = nil
        } else {
            step = failed
        }
    }

    /// `PUT /admin/sims/:id/owner` 409s that clear on their own: retry every 10 s for 1 min.
    static func ownerRetryable(code: String?, firstTriedAt: Date, now: Date = Date()) -> Bool {
        ["SIM_ABSENT", "GATEWAY_BUSY", "VERSION_CONFLICT"].contains(code ?? "") &&
            now.timeIntervalSince(firstTriedAt) < 60
    }

    static func gatewayName(imei: String) -> String {
        "DJI 4G " + String(imei.filter(\.isNumber).suffix(6))
    }
}

/// Per-gateway durable stores (S54: several gateways on one Mac never share a ledger or outbox).
enum GatewayStorePaths {
    static func ledger(_ directory: URL, gatewayId: String) -> URL {
        directory.appendingPathComponent("commands-\(gatewayId).json")
    }

    static func outbox(_ directory: URL, gatewayId: String) -> URL {
        directory.appendingPathComponent("outbox-\(gatewayId).json")
    }
}
