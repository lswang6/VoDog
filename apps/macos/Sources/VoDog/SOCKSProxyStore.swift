import Combine
import Foundation
import Security

struct SOCKSProxyCredentialStore {
    private let service = "org.vodog.macos.socks-proxy"

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
        let data = Data(password.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id.uuidString,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
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
final class SOCKSProxyStore: ObservableObject {
    static let shared = SOCKSProxyStore()
    @Published private(set) var configurations: [SOCKSProxyConfiguration]

    private let defaults: UserDefaults
    private let credentialStore: SOCKSProxyCredentialStore
    private let key = "SOCKSProxyConfigurations.v1"

    init(
        defaults: UserDefaults = .standard,
        credentialStore: SOCKSProxyCredentialStore = SOCKSProxyCredentialStore()
    ) {
        self.defaults = defaults
        self.credentialStore = credentialStore
        configurations = defaults.data(forKey: key).flatMap {
            try? JSONDecoder().decode([SOCKSProxyConfiguration].self, from: $0)
        } ?? []
    }

    func password(for id: UUID) -> String? {
        try? credentialStore.password(for: id)
    }

    func save(_ configuration: SOCKSProxyConfiguration, password: String? = nil) throws {
        if let index = configurations.firstIndex(where: { $0.id == configuration.id }) {
            configurations[index] = configuration
        } else {
            configurations.append(configuration)
        }
        switch configuration.authentication {
        case .none:
            try credentialStore.deletePassword(for: configuration.id)
        case .usernamePassword:
            if let password { try credentialStore.setPassword(password, for: configuration.id) }
        }
        try persist()
    }

    func delete(_ id: UUID) throws {
        configurations.removeAll { $0.id == id }
        try credentialStore.deletePassword(for: id)
        try persist()
    }

    private func persist() throws {
        defaults.set(try JSONEncoder().encode(configurations), forKey: key)
    }
}
