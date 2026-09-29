import Foundation

struct VoWiFiUpstreamProxyConfiguration: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    var name: String
    var host: String
    var port: UInt16
    var isEnabled: Bool
    var authentication: Authentication

    enum Authentication: Codable, Equatable, Sendable {
        case none
        case usernamePassword(username: String)
    }

    static func newDraft() -> Self {
        Self(
            id: UUID(),
            name: "",
            host: "",
            port: 1080,
            isEnabled: true,
            authentication: .none
        )
    }

    var endpointDescription: String {
        let value = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return "\(value):\(port)"
    }
}

enum VoWiFiUpstreamRoute: Codable, Hashable, Sendable {
    case direct
    case proxy(UUID)
}

struct VoWiFiUpstreamProxySnapshot: Equatable, Sendable {
    let id: UUID
    let name: String
    let host: String
    let port: UInt16
    let username: String?
    let password: String?

    var usesLoopbackEndpoint: Bool {
        let value = host.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            .lowercased()
        if value == "localhost" || value == "localhost." || value == "::1" {
            return true
        }
        let components = value.split(separator: ".", omittingEmptySubsequences: false)
        return components.count == 4 && components.first == "127" &&
            components.allSatisfy { UInt8($0) != nil }
    }
}

enum VoWiFiUpstreamProbeState: Equatable, Sendable {
    case idle
    case probing
    case succeeded(Date)
    case failed(String)
}

enum VoWiFiUpstreamProxyError: LocalizedError {
    case invalidAddress
    case missingCredentials
    case disabled
    case authenticationRejected
    case noAcceptableAuthentication
    case udpAssociateRejected(UInt8)
    case invalidResponse
    case unavailable

    var errorDescription: String? {
        switch self {
        case .invalidAddress: return L10n.tr("上游代理地址无效。")
        case .missingCredentials: return L10n.tr("上游代理缺少用户名或密码。")
        case .disabled: return L10n.tr("选中的上游代理已停用。")
        case .authenticationRejected: return L10n.tr("上游代理拒绝了用户名或密码。")
        case .noAcceptableAuthentication: return L10n.tr("上游代理不接受当前认证方式。")
        case let .udpAssociateRejected(code):
            return L10n.tr("上游代理拒绝 UDP ASSOCIATE（代码 %lld）。", Int64(code))
        case .invalidResponse: return L10n.tr("上游代理返回了无效的 SOCKS5 响应。")
        case .unavailable: return L10n.tr("上游代理当前不可用。")
        }
    }
}
