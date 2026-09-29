import Foundation
#if canImport(VoDogNetworkIPC)
import VoDogNetworkIPC
#endif

struct SOCKSProxyConfiguration: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    var name: String
    /// Stable modem identity. Runtime interface names and location IDs are
    /// deliberately resolved afresh and never persisted here.
    var moduleIMEI: String
    var listenScope: ListenScope
    var port: UInt16
    var isEnabled: Bool
    var authentication: Authentication

    enum ListenScope: String, Codable, CaseIterable, Sendable {
        case loopback
        case lan
    }

    enum Authentication: Codable, Equatable, Sendable {
        case none
        case usernamePassword(username: String)
    }

    static func newDraft(moduleIMEI: String, port: UInt16) -> Self {
        Self(
            id: UUID(),
            name: "",
            moduleIMEI: moduleIMEI,
            listenScope: .loopback,
            port: port,
            isEnabled: false,
            authentication: .none
        )
    }
}

enum SOCKSProxyRuntimeState: Equatable, Sendable {
    case running(connections: Int)
    case stoppedModuleOffline
    case stoppedCellularDisabled
    case stoppedLinkDown
    case failedPortInUse(UInt16)
    /// Any other listener failure. Reporting these as a port conflict sent
    /// users chasing a problem that did not exist.
    case failedToStart(String)
    case stoppedMissingCredentials
    case disabled
}

/// One main-actor read captures every mutable network identity needed to open
/// an upstream socket. Callers must request a new snapshot for every session;
/// BSD names and service IDs are intentionally never persisted in proxy config.
struct SOCKSModuleNetworkBindingSnapshot: Equatable, Sendable {
    let moduleID: CellularModuleID
    let moduleIMEI: String
    let serviceID: String
    let bsdName: String
    let ipv4Address: String?
    let ipv6Address: String?
    let dnsServers: [String]
}

enum SOCKSProxyRunPolicy {
    static func shouldListen(
        isEnabled: Bool,
        mode: CellularNetworkMode,
        network: CellularNetworkStatus
    ) -> Bool {
        isEnabled &&
            mode.isEnabled &&
            network.isEnabled &&
            network.isLinkActive
    }

    static func stoppedState(
        isEnabled: Bool,
        mode: CellularNetworkMode,
        network: CellularNetworkStatus?
    ) -> SOCKSProxyRuntimeState? {
        guard isEnabled else { return .disabled }
        guard mode.isEnabled else { return .stoppedCellularDisabled }
        guard let network, network.isHardwarePresent else { return .stoppedModuleOffline }
        guard network.isEnabled else { return .stoppedCellularDisabled }
        guard network.isLinkActive else { return .stoppedLinkDown }
        return nil
    }
}

/// Classifies why a listener refused to start. Only a genuine address conflict
/// may surface as a port conflict; mapping every failure to that state sent
/// users chasing a problem that did not exist.
enum SOCKSProxyListenerFailure {
    static func state(posixCode: Int32?, description: String, port: UInt16)
        -> SOCKSProxyRuntimeState {
        switch posixCode {
        case EADDRINUSE, EADDRNOTAVAIL:
            return .failedPortInUse(port)
        default:
            return .failedToStart(description)
        }
    }
}

enum SOCKSProxyPortAllocator {
    static let base: UInt16 = 1080

    static func nextAvailable(used: Set<UInt16>) -> UInt16? {
        var candidate = base
        while used.contains(candidate) {
            guard candidate < UInt16.max else { return nil }
            candidate += 1
        }
        return candidate
    }

    /// Returns every configuration participating in a duplicate-port group.
    /// Disabled configurations remain reserved so enabling one later cannot
    /// unexpectedly stop another listener.
    static func conflicts(in configs: [SOCKSProxyConfiguration]) -> [UUID] {
        let counts = configs.reduce(into: [UInt16: Int]()) { result, config in
            result[config.port, default: 0] += 1
        }
        return configs.compactMap { config in
            counts[config.port, default: 0] > 1 ? config.id : nil
        }
    }
}
