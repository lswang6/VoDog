import Foundation

// VoDog account models and pure policies (spec S54). Foundation only, so
// scripts/run_vodog_tests.sh can compile it without SwiftUI or the Keychain.
// Field shapes follow the iOS app's Models.swift and Control's routes.

/// Keychain payload: service `org.vodog.macos.vodog-account`, account `session`.
struct VoDogStoredSession: Codable, Equatable {
    var token: String
    var refreshToken: String?
    var expiresAt: String?
    var user: VoDogUser
}

enum VoDogTokenPolicy {
    /// Refresh this long before the access token expires (15 min tokens; AVPlayer cannot retry a 401).
    static let skew: TimeInterval = 60

    static func needsRefresh(expiresAt: String?, now: Date = Date()) -> Bool {
        guard let expiry = GatewayJSON.date(expiresAt) else { return false }
        return expiry.timeIntervalSince(now) < skew
    }

    /// Only an authenticated request that is not itself part of the auth handshake may refresh and retry.
    static func shouldRefreshAndRetry(status: Int, path: String, hadToken: Bool) -> Bool {
        status == 401 && hadToken && !["/auth/login", "/auth/refresh", "/auth/logout"].contains(path)
    }
}

/// S69: one uploaded row per key per 60 s; the next admitted row carries how many repeats it stood for.
/// Keys: client `api.error` = "method route-template|status", gateway `gateway.error` = "route|domain|code".
struct VoDogDiagThrottle {
    static let window: TimeInterval = 60
    private var entries: [String: (last: Date, suppressed: Int)] = [:]

    /// `nil` = drop this event; otherwise log it with this `repeat` count.
    mutating func admit(_ key: String, now: Date) -> Int? {
        if let entry = entries[key], now.timeIntervalSince(entry.last) < Self.window {
            entries[key] = (entry.last, entry.suppressed + 1)
            return nil
        }
        let suppressed = entries[key]?.suppressed ?? 0
        entries[key] = (now, 0)
        return suppressed
    }

    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    /// `/calls/<uuid>/end` → `/calls/:id/end`: UUID-shaped or all-digit segments are ids.
    static func routeTemplate(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: false).map { segment -> String in
            let text = String(segment)
            if UUID(uuidString: text) != nil || (!text.isEmpty && text.allSatisfy(\.isNumber)) { return ":id" }
            return text
        }.joined(separator: "/")
    }

    /// S69 `errorType` for a transport failure (no HTTP status).
    static func networkErrorType(_ error: Error) -> String {
        guard let code = (error as? URLError)?.code else { return "other" }
        switch code {
        case .timedOut: return "timeout"
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff,
             .cannotConnectToHost: return "offline"
        case .cannotFindHost, .dnsLookupFailed: return "dns"
        case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
             .clientCertificateRequired: return "tls"
        default: return "other"
        }
    }
}

enum VoDogJSON {
    static func decode<T: Decodable>(_ type: T.Type, from object: [String: Any]) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
    }
}

enum VoDogReceptionMode: String, CaseIterable, Identifiable {
    case normal, ai, timeoutAI = "timeout_ai"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .normal: return L10n.tr("人工接听")
        case .ai: return L10n.tr("AI 即接")
        case .timeoutAI: return L10n.tr("超时转 AI")
        }
    }
}

struct VoDogSIMSettings: Codable, Equatable {
    var mode: String
    var timeoutSeconds: Int
    var version: Int
    var appliedVersion: Int?
    var availableModes: [String]?
    var aiUnavailableReason: String?

    /// Older servers did not advertise capabilities: fail closed to `normal`.
    func isAvailable(_ mode: VoDogReceptionMode) -> Bool {
        (availableModes ?? [VoDogReceptionMode.normal.rawValue]).contains(mode.rawValue)
    }

    func mergingCapabilities(from previous: VoDogSIMSettings?) -> VoDogSIMSettings {
        guard availableModes == nil, let previous else { return self }
        var merged = self
        merged.availableModes = previous.availableModes
        merged.aiUnavailableReason = aiUnavailableReason ?? previous.aiUnavailableReason
        return merged
    }
}

struct VoDogSIM: Codable, Identifiable, Equatable {
    var id: String
    var gatewayId: String?
    var label: String?
    var phoneLabel: String?
    var slotIndex: Int?
    var online: Bool?
    var version: Int?
    var present: Bool?
    var assignmentPending: Bool?
    var settings: VoDogSIMSettings?
    /// S58: `pixel` | `dji4g` (missing → pixel); labels only.
    var gatewayKind: String?

    var displayName: String {
        if let label, !label.isEmpty { return label }
        return L10n.tr("SIM %lld", Int64((slotIndex ?? 0) + 1))
    }
}

struct VoDogVoiceProvider: Codable, Identifiable, Equatable {
    var id: String
    var label: String?
    var configured: Bool
    var online: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        configured = try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
    }

    var displayLabel: String {
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? id : trimmed
    }

    /// `nil` = selectable; otherwise the reason, shown before the user taps.
    var disabledReason: String? {
        if !configured { return L10n.tr("服务器未配置这个语音服务") }
        if !online { return L10n.tr("语音服务当前离线，暂时无法切换") }
        return nil
    }
}

struct VoDogVoiceProviderList: Codable, Equatable {
    var items: [VoDogVoiceProvider]
    var selected: String?
    var configVersion: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([VoDogVoiceProvider].self, forKey: .items) ?? []
        selected = try c.decodeIfPresent(String.self, forKey: .selected)
        configVersion = try c.decodeIfPresent(Int.self, forKey: .configVersion) ?? 1
    }
}

struct VoDogPasskey: Codable, Identifiable, Equatable {
    var id: String
    var createdAt: String
    var deviceType: String?
    var label: String?
    var displayName: String?
    var clientPlatform: String?
    var lastUsedAt: String?

    var resolvedName: String {
        for candidate in [label, displayName] {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty { return value }
        }
        return deviceType?.isEmpty == false ? deviceType! : L10n.tr("通行密钥")
    }
}

struct VoDogGatewayPowerResult: Codable, Equatable {
    var desired: String?
    var ok: Bool
    var reason: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        desired = try c.decodeIfPresent(String.self, forKey: .desired)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// `GatewayPowerDto`; every boolean defaults to the conservative value.
struct VoDogGatewayPower: Codable, Identifiable, Equatable {
    var id: String { gatewayId }
    var gatewayId: String
    var name: String?
    var controlEnabled: Bool
    var online: Bool
    var standbyOnline: Bool
    var remotePowerAllowed: Bool
    var desiredPower: String?
    var lastPowerResult: VoDogGatewayPowerResult?
    var occupied: Bool
    var lastSeenAt: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        gatewayId = try c.decode(String.self, forKey: .gatewayId)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        controlEnabled = try c.decodeIfPresent(Bool.self, forKey: .controlEnabled) ?? false
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
        standbyOnline = try c.decodeIfPresent(Bool.self, forKey: .standbyOnline) ?? false
        remotePowerAllowed = try c.decodeIfPresent(Bool.self, forKey: .remotePowerAllowed) ?? false
        desiredPower = try c.decodeIfPresent(String.self, forKey: .desiredPower)
        lastPowerResult = try c.decodeIfPresent(VoDogGatewayPowerResult.self, forKey: .lastPowerResult)
        occupied = try c.decodeIfPresent(Bool.self, forKey: .occupied) ?? false
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
    }

    var displayName: String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "GW-\(gatewayId.prefix(8))" : trimmed
    }

    var statusTitle: String {
        if online { return L10n.tr("在线") }
        if standbyOnline { return L10n.tr("待命中") }
        return L10n.tr("离线")
    }

    /// Same rules as iOS GatewayPowerPolicy: disabled with the reason whenever the server would refuse.
    var toggleDisabledReason: String? {
        if !remotePowerAllowed { return L10n.tr("网关未允许远程开启") }
        if controlEnabled {
            if occupied { return L10n.tr("网关正在通话中，暂时无法远程关闭") }
            if !online { return L10n.tr("网关不在线，暂时无法远程关闭") }
            return nil
        }
        if !standbyOnline { return L10n.tr("网关待命通道离线，暂时无法远程开启") }
        return nil
    }

    var pendingTitle: String? {
        switch desiredPower {
        case "on": return L10n.tr("已请求开启，等待网关响应…")
        case "off": return L10n.tr("已请求关闭，等待网关响应…")
        default: return nil
        }
    }

    var lastResultFailure: String? {
        guard let result = lastPowerResult, !result.ok else { return nil }
        let reason = result.reason ?? L10n.tr("原因未知")
        return result.desired == "off" ? L10n.tr("上次远程关闭失败：%@", reason) : L10n.tr("上次远程开启失败：%@", reason)
    }
}

/// S67 `GET /badges`: pending incoming calls (missed / AI-answered) and unread incoming SMS.
/// `sims` lists only SIMs with a non-zero count.
struct VoDogBadges: Codable, Equatable {
    struct SIM: Codable, Equatable {
        var simId: String
        var calls: Int
        var sms: Int
    }

    enum Kind { case calls, sms }

    var calls = 0
    var sms = 0
    var sims: [SIM] = []

    /// One kind, or both summed (`nil`), for the whole account or one SIM.
    func count(_ kind: Kind?, simID: String? = nil) -> Int {
        let (c, s) = simID.map { id in sims.first { $0.simId == id }.map { ($0.calls, $0.sms) } ?? (0, 0) } ?? (calls, sms)
        switch kind {
        case .calls: return c
        case .sms: return s
        case nil: return c + s
        }
    }

    /// Optimistic local −1 after `POST /calls/:id/seen` (the next refresh corrects it).
    mutating func decrementCall(simID: String?) {
        calls = max(0, calls - 1)
        if let index = sims.firstIndex(where: { $0.simId == simID }) { sims[index].calls = max(0, sims[index].calls - 1) }
    }

    /// Badge text: nil hides it (0), >99 shows `99+`.
    static func text(_ count: Int) -> String? {
        count <= 0 ? nil : count > 99 ? "99+" : String(count)
    }
}

/// Maps Control error codes to the words iOS shows; falls back to the server message.
enum VoDogErrorText {
    /// S69 `ui.error_shown` sink (AppState wires it to the account): screen = calling file, site = function.
    nonisolated(unsafe) static var onShown: ((_ screen: String, _ site: String, _ message: String,
                                              _ code: Int?, _ serverCode: String?) -> Void)?

    /// Every user-visible VoDog error text is reported where it is produced: the builders here,
    /// `VoDogRecordsError.message`, `VoDogContactsUI.errorText`, `shown(_:)` for local copy,
    /// and `.reportsVoDogError` for texts derived in a view body. Cancellation is never shown, so never reported.
    static func message(_ error: Error, file: String = #fileID, site: String = #function) -> String {
        let text = text(for: error)
        reportShown(text, error, file: file, site: site)
        return text
    }

    /// Local error copy (validation, fixed failure text); pass the caught error when there is one for `code`.
    @discardableResult
    static func shown(_ text: String, error: Error? = nil, file: String = #fileID, site: String = #function) -> String {
        reportShown(text, error, file: file, site: site)
        return text
    }

    static func reportShown(_ text: String, _ error: Error?, file: String, site: String) {
        guard let onShown else { return }
        if let error, VoDogDiagThrottle.isCancellation(error) { return }
        let screen = ((file as NSString).lastPathComponent as NSString).deletingPathExtension
        let api = error as? VoDogAPIError
        onShown(screen, site, text, api?.status ?? error.map { ($0 as NSError).code }, api?.code)
    }

    static func text(for error: Error) -> String {
        guard let api = error as? VoDogAPIError else { return error.localizedDescription }
        switch api.code {
        case "VERSION_CONFLICT", "VERSION_REQUIRED": return L10n.tr("已在其他客户端更新，请载入最新后再保存。")
        case "PROVIDER_VERSION_CONFLICT", "PROVIDER_VERSION_REQUIRED":
            return L10n.tr("AI 语音服务已在其他客户端更新，请载入最新配置后再选择。")
        case "GATEWAY_REMOTE_POWER_NOT_ALLOWED": return L10n.tr("网关未允许远程开启")
        case "GATEWAY_STANDBY_OFFLINE": return L10n.tr("网关待命通道离线，暂时无法远程开启")
        case "GATEWAY_OFFLINE": return L10n.tr("网关不在线，暂时无法远程关闭")
        case "GATEWAY_IN_USE": return L10n.tr("网关正在通话中，为避免挂断通话已拒绝远程关闭。")
        case "INVALID_CREDENTIALS": return L10n.tr("账号或密码不正确")
        case "SAME_DEVICE_INTERNAL": return L10n.tr("同一设备上的两张卡不能互打")   // S72 D5
        case "OWN_OUTGOING_CALL": return L10n.tr("这是你正在拨出的通话")
        case "TURNSTILE_REQUIRED", "TURNSTILE_FAILED": return L10n.tr("人机验证未通过，请重新验证后重试。")
        default: break
        }
        if api.status == 0 { return L10n.tr("无法连接服务器，请检查网络。") }
        if let message = api.message, !message.isEmpty { return message }
        return L10n.tr("请求失败（HTTP %lld）", Int64(api.status))
    }

    static func isVersionConflict(_ error: Error) -> Bool {
        guard let api = error as? VoDogAPIError else { return false }
        return (api.status == 409 && api.code == "VERSION_CONFLICT") || (api.status == 428 && api.code == "VERSION_REQUIRED")
    }

    static func isProviderConflict(_ error: Error) -> Bool {
        guard let api = error as? VoDogAPIError else { return false }
        return (api.status == 409 && api.code == "PROVIDER_VERSION_CONFLICT")
            || (api.status == 428 && api.code == "PROVIDER_VERSION_REQUIRED")
    }

    static func isNotFound(_ error: Error) -> Bool { (error as? VoDogAPIError)?.status == 404 }
}

/// Port of iOS SettingsApplyPolicy (S32): a settings PUT writes the desired version; the gateway
/// acks it later by raising `appliedVersion`. 应用成功 only when `version == target && applied >= target`.
enum VoDogApplyPolicy {
    static let pollInterval: TimeInterval = 2
    static let timeout: TimeInterval = 30

    enum State: Equatable {
        case idle
        case applying(started: Date, target: Int)
        case applied
        case superseded
        case timedOut
    }

    enum Tone: Equatable { case pending, success, warning, none }

    static var pendingText: String { L10n.tr("正在应用中…") }
    static var successText: String { L10n.tr("应用成功") }
    static var warningText: String { L10n.tr("设置已保存，但设备尚未确认应用。") }
    static var supersededText: String { L10n.tr("设置已被另一客户端的新版本替代，请刷新后查看。") }

    static func next(_ state: State, now: Date, appliedVersion: Int?, version: Int?) -> State {
        guard case let .applying(started, target) = state else { return state }
        if let version, version > target { return .superseded }
        if version == target, let appliedVersion, appliedVersion >= target { return .applied }
        if now.timeIntervalSince(started) >= timeout { return .timedOut }
        return state
    }

    static func label(_ state: State, appliedVersion: Int?, version: Int?) -> (text: String, tone: Tone) {
        if case .superseded = state { return (supersededText, .warning) }
        if case let .applying(_, target) = state {
            if let version, version > target { return (supersededText, .warning) }
            if version == target, let appliedVersion, appliedVersion >= target { return (successText, .success) }
            return (pendingText, .pending)
        }
        if let applied = appliedVersion, let expected = version, applied >= expected { return (successText, .success) }
        guard version != nil else { return ("", .none) }
        return (warningText, .warning)
    }

    /// A refresh must not overwrite a dirty draft; a server version change under a dirty draft is a conflict.
    static func hasExternalChange(currentVersion: Int?, baseVersion: Int?, draftIsDirty: Bool) -> Bool {
        draftIsDirty && currentVersion != nil && baseVersion != nil && currentVersion != baseVersion
    }
}
