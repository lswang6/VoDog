import Foundation
import SystemConfiguration

enum VoWiFiSOCKSRelayError: LocalizedError {
    case moduleAddressUnavailable
    case egressUnavailable
    case listenerStopped

    var errorDescription: String? {
        switch self {
        case .moduleAddressUnavailable:
            return VoWiFiEgressProblem.moduleLinkDown.localizedDescription
        case .egressUnavailable:
            return VoWiFiEgressProblem.noInternetInterface.localizedDescription
        case .listenerStopped:
            return L10n.tr("VoWiFi SOCKS5 中继未能启动。")
        }
    }
}

/// The Mac interface that carries VoWiFi traffic towards the ePDG, either
/// directly or through a user-configured upstream SOCKS5 proxy.
struct VoWiFiEgress: Equatable, Sendable {
    let bsdName: String
    let dnsServers: [String]
    let ipv4Address: String?
    let router: String?

    /// Prefers whatever macOS considers the primary IPv4 path, because that is
    /// the interface with a working default route. Picking "the first Wi-Fi
    /// adapter" instead selected disconnected or secondary radios.
    static func current(excludingBSDNames excluded: Set<String> = []) -> VoWiFiEgress? {
        guard let store = SCDynamicStoreCreate(nil, "VoDogVoWiFi" as CFString, nil, nil) else {
            return nil
        }
        let global = SCDynamicStoreCopyValue(
            store, "State:/Network/Global/IPv4" as CFString
        ) as? [String: Any]
        if let primary = global?[kSCDynamicStorePropNetPrimaryInterface as String] as? String,
           !excluded.contains(primary),
           hasIPv4Address(store, bsdName: primary) {
            return VoWiFiEgress(
                bsdName: primary,
                dnsServers: dnsServers(store, bsdName: primary),
                ipv4Address: ipv4Address(store, bsdName: primary),
                router: global?[kSCPropNetIPv4Router as String] as? String
            )
        }
        // The primary path can legitimately be the module itself while the
        // user still wants VoWiFi over the Mac's Wi-Fi, so fall back to any
        // radio that actually holds an address.
        for name in wifiInterfaceNames().sorted() where !excluded.contains(name) {
            guard hasIPv4Address(store, bsdName: name) else { continue }
            return VoWiFiEgress(
                bsdName: name,
                dnsServers: dnsServers(store, bsdName: name),
                ipv4Address: ipv4Address(store, bsdName: name),
                router: interfaceRouter(store, bsdName: name)
            )
        }
        return nil
    }

    private static func wifiInterfaceNames() -> Set<String> {
        guard let interfaces = SCNetworkInterfaceCopyAll() as? [SCNetworkInterface] else {
            return []
        }
        return Set(interfaces.compactMap { interface in
            guard SCNetworkInterfaceGetInterfaceType(interface) as String? ==
                    (kSCNetworkInterfaceTypeIEEE80211 as String) else {
                return nil
            }
            return SCNetworkInterfaceGetBSDName(interface) as String?
        })
    }

    private static func hasIPv4Address(_ store: SCDynamicStore, bsdName: String) -> Bool {
        let value = SCDynamicStoreCopyValue(
            store, "State:/Network/Interface/\(bsdName)/IPv4" as CFString
        ) as? [String: Any]
        let addresses = value?[kSCPropNetIPv4Addresses as String] as? [String]
        return addresses?.isEmpty == false
    }

    private static func ipv4Address(_ store: SCDynamicStore, bsdName: String) -> String? {
        let value = SCDynamicStoreCopyValue(
            store, "State:/Network/Interface/\(bsdName)/IPv4" as CFString
        ) as? [String: Any]
        return (value?[kSCPropNetIPv4Addresses as String] as? [String])?.first
    }

    private static func interfaceRouter(_ store: SCDynamicStore, bsdName: String) -> String? {
        let value = SCDynamicStoreCopyValue(
            store, "State:/Network/Interface/\(bsdName)/IPv4" as CFString
        ) as? [String: Any]
        return value?[kSCPropNetIPv4Router as String] as? String
    }

    private static func dnsServers(_ store: SCDynamicStore, bsdName: String) -> [String] {
        let scoped = SCDynamicStoreCopyValue(
            store, "State:/Network/Interface/\(bsdName)/DNS" as CFString
        ) as? [String: Any]
        let global = SCDynamicStoreCopyValue(
            store, "State:/Network/Global/DNS" as CFString
        ) as? [String: Any]
        return (scoped ?? global)?[kSCPropNetDNSServerAddresses as String] as? [String] ?? []
    }
}

/// Identifies the exact inputs a relay was built from. Whenever any of these
/// change the relay must be rebuilt and the module restarted, because
/// `SOCKSNATTTransport` in `vowifi-go` never redials a broken association.
struct VoWiFiRelayIdentity: Equatable, Sendable {
    let moduleAddress: String
    let egressBSDName: String
    let upstreamProxyID: UUID?
}

/// A private, authenticated SOCKS5 endpoint reachable from exactly one module
/// over ECM. Its listeners are pinned to the Mac's address on that ECM link so
/// the cellular egress is never published to the network the Mac is joined to,
/// while every upstream socket is pinned to the selected egress interface.
final class VoWiFiSOCKSRelay {
    let sessionID: String
    let proxyURL: String
    let identity: VoWiFiRelayIdentity

    private let server: SOCKSProxyServer

    private init(
        server: SOCKSProxyServer,
        sessionID: String,
        proxyURL: String,
        identity: VoWiFiRelayIdentity
    ) {
        self.server = server
        self.sessionID = sessionID
        self.proxyURL = proxyURL
        self.identity = identity
    }

    func stop() {
        server.stop()
    }

    static func start(
        for module: CellularModuleSummary,
        egress: VoWiFiEgress,
        upstreamProxy: VoWiFiUpstreamProxySnapshot?,
        completion: @escaping (Result<VoWiFiSOCKSRelay, Error>) -> Void
    ) {
        // `network.ipv4Address` is the Mac's own address on the module's ECM
        // link; the module reaches the relay there and nowhere else.
        guard let moduleFacingAddress = module.network.ipv4Address,
              !moduleFacingAddress.isEmpty else {
            DispatchQueue.main.async {
                completion(.failure(VoWiFiSOCKSRelayError.moduleAddressUnavailable))
            }
            return
        }

        let sessionID = VoWiFiRuntimeControl.newSessionID()
        let username = "vowifi"
        let password = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let configuration = SOCKSProxyConfiguration(
            id: UUID(),
            name: "VoWiFi \(module.id.rawValue)",
            moduleIMEI: module.modem.moduleIMEI ?? module.id.rawValue,
            listenScope: .lan,
            port: 0,
            isEnabled: true,
            authentication: .usernamePassword(username: username)
        )
        let server = SOCKSProxyServer(
            configuration: configuration,
            password: password,
            udpUpstreamProxy: upstreamProxy,
            localBindAddress: moduleFacingAddress
        )
        server.updateBinding(SOCKSModuleNetworkBindingSnapshot(
            moduleID: module.id,
            moduleIMEI: configuration.moduleIMEI,
            serviceID: "vowifi-egress-\(egress.bsdName)",
            bsdName: egress.bsdName,
            ipv4Address: nil,
            ipv6Address: nil,
            dnsServers: egress.dnsServers
        ))

        let identity = VoWiFiRelayIdentity(
            moduleAddress: moduleFacingAddress,
            egressBSDName: egress.bsdName,
            upstreamProxyID: upstreamProxy?.id
        )
        var completed = false
        server.onReady = { port in
            guard !completed else { return }
            completed = true
            let encodedPassword = password.addingPercentEncoding(
                withAllowedCharacters: .urlPasswordAllowed
            ) ?? password
            let url = "socks5://\(username):\(encodedPassword)@\(moduleFacingAddress):\(port)"
            DispatchQueue.main.async {
                completion(.success(VoWiFiSOCKSRelay(
                    server: server,
                    sessionID: sessionID,
                    proxyURL: url,
                    identity: identity
                )))
            }
        }
        server.onFailure = { error in
            guard !completed else { return }
            completed = true
            DispatchQueue.main.async { completion(.failure(error)) }
        }
        do {
            try server.start()
        } catch {
            completed = true
            DispatchQueue.main.async { completion(.failure(error)) }
        }
    }
}
