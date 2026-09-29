import Foundation

/// §D 设置页「网关设备」区块的全部判断。
///
/// Remote power is a controlled exception to "OFF = no outbound connections" (S21 decision 5), so the UI must
/// never imply an action that the server would refuse: every refusal has a reason the user can act on, and the
/// toggle is disabled with that reason rather than failing after the fact.
enum GatewayPowerPolicy {
    /// §D: the settings page re-reads the power state every 5 s while it is on screen.
    static let refreshInterval: Duration = .seconds(5)

    static func displayName(_ item: GatewayPower) -> String {
        if let name = item.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return "\(GatewayKind(item.kind).shortPrefix)\(item.gatewayId.prefix(8))"
    }

    /// 在线 = heartbeating. 待命中 = OFF but holding the standby beacon. 离线 = neither.
    static func statusTitle(_ item: GatewayPower) -> String {
        if item.online { return "在线" }
        if item.standbyOnline { return "待命中" }
        return "离线"
    }

    static func statusSymbol(_ item: GatewayPower) -> String {
        if item.online { return "checkmark.circle.fill" }
        if item.standbyOnline { return "moon.zzz.fill" }
        return "xmark.circle.fill"
    }

    static func remotePowerTitle(_ item: GatewayPower) -> String {
        item.remotePowerAllowed ? "远程开启已允许" : "远程开启未允许（需在网关设备上打开）"
    }

    /// The switch mirrors the gateway's own 主开关, not its connectivity: a gateway that is ON but temporarily
    /// unreachable is still ON.
    static func isOn(_ item: GatewayPower) -> Bool { item.controlEnabled }

    /// `nil` when the toggle may be used. Otherwise the reason it cannot be, in the user's words.
    static func toggleDisabledReason(_ item: GatewayPower) -> String? {
        if !item.remotePowerAllowed { return "需先在网关设备上打开「允许远程开启（待命）」" }
        if isOn(item) {
            // Decision 6: remote OFF is more conservative than local OFF — a remote user cannot see the phone.
            if item.occupied { return "网关正在通话中，暂时无法远程关闭" }
            if !item.online { return "网关不在线，暂时无法远程关闭" }
            return nil
        }
        if !item.standbyOnline { return "网关待命通道离线，暂时无法远程开启" }
        return nil
    }

    static func pendingTitle(_ item: GatewayPower) -> String? {
        switch item.desiredPower {
        case "on": "已请求开启，等待网关响应…"
        case "off": "已请求关闭，等待网关响应…"
        default: nil
        }
    }

    static let codeMessages: [String: String] = [
        "GATEWAY_REMOTE_POWER_NOT_ALLOWED": "网关未允许远程开启，请在网关设备上打开「允许远程开启（待命）」。",
        "GATEWAY_STANDBY_OFFLINE": "网关待命通道已离线，无法远程开启；请检查网关设备的网络。",
        "GATEWAY_OFFLINE": "网关当前不在线，无法远程关闭。",
        "GATEWAY_IN_USE": "网关正在通话中，为避免挂断通话已拒绝远程关闭。",
    ]

    static func message(for error: Error) -> String {
        if let code = (error as? APIError)?.serverCode, let text = codeMessages[code] { return text }
        return error.localizedDescription
    }

    /// `lastPowerResult` is how the gateway reports back that it refused or failed to apply a remote request.
    static let reasonMessages: [String: String] = [
        "call_in_progress": "网关正在通话中",
        "not_allowed": "网关未允许远程开启",
        "feature_gate": "网关功能门控未通过",
        "start_failed": "网关启动失败",
    ]

    static func lastResultMessage(_ item: GatewayPower) -> String? {
        guard let result = item.lastPowerResult, !result.ok else { return nil }
        let action = result.desired == "off" ? "远程关闭" : "远程开启"
        let reason = result.reason.map { reasonMessages[$0] ?? $0 } ?? "原因未知"
        return "上次\(action)失败：\(reason)"
    }

    static func lastResultSuccessMessage(_ item: GatewayPower) -> String? {
        guard let result = item.lastPowerResult, result.ok else { return nil }
        return "上次远程\(result.desired == "off" ? "关闭" : "开启")成功"
    }

    static func heartbeatTitle(_ item: GatewayPower, format: (String) -> String) -> String {
        let values = [
            item.lastSeenAt.map { "最近心跳 \(format($0))" },
            item.standbySeenAt.map { "待命心跳 \(format($0))" },
        ].compactMap { $0 }
        return values.isEmpty ? "尚未收到心跳" : values.joined(separator: " · ")
    }
}
