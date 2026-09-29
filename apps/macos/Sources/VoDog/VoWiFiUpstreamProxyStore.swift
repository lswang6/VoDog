import Combine
import Foundation
import Security

private struct VoWiFiUpstreamCredentialStore {
    private let service = "org.vodog.macos.vowifi-upstream"

    func password(for id: UUID) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id.uuidString,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw BoundSocketError.systemCall(operation: "Keychain read", code: status)
        }
        return String(data: data, encoding: .utf8)
    }

    func setPassword(_ password: String, for id: UUID) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id.uuidString,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: Data(password.utf8),
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

    func deletePassword(for id: UUID) throws {
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id.uuidString,
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw BoundSocketError.systemCall(operation: "Keychain delete", code: status)
        }
    }
}

@MainActor
final class VoWiFiUpstreamProxyStore: ObservableObject {
    static let shared = VoWiFiUpstreamProxyStore()

    @Published private(set) var configurations: [VoWiFiUpstreamProxyConfiguration]
    @Published private(set) var routes: [String: VoWiFiUpstreamRoute]
    @Published private(set) var probeStates: [UUID: VoWiFiUpstreamProbeState] = [:]

    private let defaults: UserDefaults
    private let credentials = VoWiFiUpstreamCredentialStore()
    private let configurationsKey = "VoWiFiUpstreamProxies.v1"
    private let routesKey = "VoWiFiUpstreamRoutes.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        configurations = defaults.data(forKey: configurationsKey).flatMap {
            try? JSONDecoder().decode([VoWiFiUpstreamProxyConfiguration].self, from: $0)
        } ?? []
        routes = defaults.data(forKey: routesKey).flatMap {
            try? JSONDecoder().decode([String: VoWiFiUpstreamRoute].self, from: $0)
        } ?? [:]
    }

    func route(for moduleIMEI: String) -> VoWiFiUpstreamRoute {
        routes[moduleIMEI] ?? .direct
    }

    func setRoute(_ route: VoWiFiUpstreamRoute, for moduleIMEI: String) throws {
        routes[moduleIMEI] = route
        try persistRoutes()
    }

    func password(for id: UUID) -> String? { try? credentials.password(for: id) }

    func snapshot(for id: UUID) throws -> VoWiFiUpstreamProxySnapshot {
        guard let config = configurations.first(where: { $0.id == id }) else {
            throw VoWiFiUpstreamProxyError.unavailable
        }
        guard config.isEnabled else { throw VoWiFiUpstreamProxyError.disabled }
        let username: String?
        let password: String?
        switch config.authentication {
        case .none:
            username = nil
            password = nil
        case let .usernamePassword(value):
            username = value
            password = try credentials.password(for: id)
            guard !value.isEmpty, password?.isEmpty == false else {
                throw VoWiFiUpstreamProxyError.missingCredentials
            }
        }
        return VoWiFiUpstreamProxySnapshot(
            id: config.id,
            name: config.name,
            host: config.host,
            port: config.port,
            username: username,
            password: password
        )
    }

    func save(_ configuration: VoWiFiUpstreamProxyConfiguration, password: String?) throws {
        if let index = configurations.firstIndex(where: { $0.id == configuration.id }) {
            configurations[index] = configuration
        } else {
            configurations.append(configuration)
        }
        switch configuration.authentication {
        case .none:
            try credentials.deletePassword(for: configuration.id)
        case .usernamePassword:
            if let password, !password.isEmpty {
                try credentials.setPassword(password, for: configuration.id)
            }
        }
        try persistConfigurations()
    }

    func delete(_ id: UUID) throws {
        configurations.removeAll { $0.id == id }
        routes = routes.mapValues { route in
            if case let .proxy(proxyID) = route, proxyID == id {
                return VoWiFiUpstreamRoute.direct
            }
            return route
        }
        probeStates[id] = nil
        try credentials.deletePassword(for: id)
        try persistConfigurations()
        try persistRoutes()
    }

    func setProbeState(_ state: VoWiFiUpstreamProbeState, for id: UUID) {
        probeStates[id] = state
    }

    private func persistConfigurations() throws {
        defaults.set(try JSONEncoder().encode(configurations), forKey: configurationsKey)
    }

    private func persistRoutes() throws {
        defaults.set(try JSONEncoder().encode(routes), forKey: routesKey)
    }
}
