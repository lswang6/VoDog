import Foundation

public enum VoDogNetworkIPC {
    public static let protocolVersion = 12
    /// Bump only when the privileged helper implementation itself must be
    /// replaced. Keeping this independent from the app build prevents UI-only
    /// rebuilds and code-signing changes from requesting administrator access.
    /// Bump whenever either the helper or its installed VoWiFi runtime changes;
    /// the identity mismatch is what makes the app run the authenticated
    /// installer and replace both root-owned executables atomically.
    public static let helperBuildVersion = 15
    public static let helperIdentity = "VoDog Network Helper/\(helperBuildVersion)"
    public static let helperLabel = "org.vodog.macos.network.helper"
    public static let helperExecutableName = "VoDogNetworkHelper"
    public static let voWiFiRuntimeExecutableName = "VoDogVoWiFiRuntime"
    public static let launchDaemonPlistName = "org.vodog.macos.network.helper.plist"
}

public struct CellularNetworkConfigurationRequest: Codable, Equatable, Sendable {
    public let preferredLocationID: UInt32?
    public let standbyLocationIDs: [UInt32]
    public let offLocationIDs: [UInt32]

    public init(
        preferredLocationID: UInt32?,
        standbyLocationIDs: [UInt32],
        offLocationIDs: [UInt32]
    ) {
        self.preferredLocationID = preferredLocationID
        self.standbyLocationIDs = standbyLocationIDs
        self.offLocationIDs = offLocationIDs
    }

    public var enabledLocationIDs: [UInt32] {
        (preferredLocationID.map { [$0] } ?? []) + standbyLocationIDs
    }

    public var isValid: Bool {
        let preferred = Set(preferredLocationID.map { [$0] } ?? [])
        let standby = Set(standbyLocationIDs)
        let off = Set(offLocationIDs)
        return standby.count == standbyLocationIDs.count &&
            off.count == offLocationIDs.count &&
            preferred.isDisjoint(with: standby) &&
            preferred.isDisjoint(with: off) &&
            standby.isDisjoint(with: off)
    }
}

public enum CellularNetworkMode: Int, Codable, CaseIterable, Sendable {
    case off = 0
    case standby = 1
    case preferred = 2

    public var isEnabled: Bool { self != .off }
}

public enum CellularNetworkServiceOrderPolicy {
    public static func appliedOrder(
        mode: CellularNetworkMode,
        targetServiceID: String,
        originalOrder: [String],
        cellularServiceIDs: Set<String>
    ) -> [String] {
        let remaining = originalOrder.filter { $0 != targetServiceID }
        switch mode {
        case .off:
            return originalOrder
        case .preferred:
            return [targetServiceID] + remaining
        case .standby:
            let nonCellular = remaining.filter { !cellularServiceIDs.contains($0) }
            let otherCellular = remaining.filter(cellularServiceIDs.contains)
            return nonCellular + [targetServiceID] + otherCellular
        }
    }

    public static func appliedOrder(
        preferredServiceID: String?,
        standbyServiceIDs: [String],
        originalOrder: [String],
        cellularServiceIDs: Set<String>
    ) -> [String] {
        let preferred = preferredServiceID.map { [$0] } ?? []
        let preferredSet = Set(preferred)
        let standby = standbyServiceIDs.filter { !preferredSet.contains($0) }
        let enabledCellular = preferredSet.union(standby)
        let nonCellular = originalOrder.filter { !cellularServiceIDs.contains($0) }
        let disabledCellular = originalOrder.filter {
            cellularServiceIDs.contains($0) && !enabledCellular.contains($0)
        }
        return preferred + nonCellular + standby + disabledCellular
    }
}

/// Pure decision rules for moving modules between cellular network modes.
///
/// The invariant is that at most one module may be `.preferred` at any time,
/// while `.standby` and `.off` are unbounded. Every mode change funnels through
/// `plan(...)` so conflict handling cannot diverge between call sites.
public enum CellularNetworkModePlanner {
    public enum Outcome<ModuleID: Hashable>: Equatable {
        /// The requested module is not currently attached.
        case unknownModule
        /// Another module already owns `.preferred`; the caller must ask the user
        /// how to demote it before the change can be applied.
        case needsPreferredConflictResolution(previousPreferredID: ModuleID)
        /// The complete set of modes to submit as a single transaction.
        case apply([ModuleID: CellularNetworkMode])
    }

    /// Fills in a mode for every attached module so a plan always describes the
    /// whole configuration rather than a partial delta.
    public static func normalizedModes<ModuleID: Hashable>(
        moduleIDs: [ModuleID],
        currentModes: [ModuleID: CellularNetworkMode],
        fallback: (ModuleID) -> CellularNetworkMode
    ) -> [ModuleID: CellularNetworkMode] {
        var modes = currentModes
        for moduleID in moduleIDs where modes[moduleID] == nil {
            modes[moduleID] = fallback(moduleID)
        }
        return modes
    }

    public static func plan<ModuleID: Hashable>(
        setting mode: CellularNetworkMode,
        for moduleID: ModuleID,
        moduleIDs: [ModuleID],
        currentModes: [ModuleID: CellularNetworkMode],
        replacingPreviousPreferredWith replacementMode: CellularNetworkMode?
    ) -> Outcome<ModuleID> {
        guard moduleIDs.contains(moduleID) else { return .unknownModule }
        var modes = currentModes
        if mode == .preferred,
           let previousPreferredID = moduleIDs.first(where: {
               $0 != moduleID && modes[$0] == .preferred
           }) {
            guard let replacementMode, replacementMode != .preferred else {
                return .needsPreferredConflictResolution(
                    previousPreferredID: previousPreferredID
                )
            }
            modes[previousPreferredID] = replacementMode
        }
        modes[moduleID] = mode
        return .apply(modes)
    }

    /// Turns every attached module off in one transaction.
    public static func turningEverythingOff<ModuleID: Hashable>(
        moduleIDs: [ModuleID],
        currentModes: [ModuleID: CellularNetworkMode]
    ) -> [ModuleID: CellularNetworkMode] {
        var modes = currentModes
        for moduleID in moduleIDs { modes[moduleID] = .off }
        return modes
    }

    /// Repairs a configuration that claims more than one `.preferred` module,
    /// which can happen when restoring persisted preferences across launches.
    /// The retained module wins; the rest fall back to `.standby`.
    public static func collapsingExtraPreferred<ModuleID: Hashable>(
        modes: [ModuleID: CellularNetworkMode],
        moduleIDs: [ModuleID],
        retaining preferredID: ModuleID?
    ) -> [ModuleID: CellularNetworkMode] {
        let preferredIDs = moduleIDs.filter { modes[$0] == .preferred }
        guard preferredIDs.count > 1 else { return modes }
        let retained = preferredID.flatMap { preferredIDs.contains($0) ? $0 : nil }
            ?? preferredIDs.first
        var repaired = modes
        for moduleID in preferredIDs where moduleID != retained {
            repaired[moduleID] = .standby
        }
        return repaired
    }
}

public enum VoDogNetworkResultCode: Int {
    case success = 0
    case failure = 1
    case linkInactive = 2
    case dhcpTimeout = 3
}

public struct VoWiFiHostStartRequest: Codable, Equatable, Sendable {
    public let runtimeKey: String
    public let sessionID: String
    public let simBridgeHost: String
    public let simBridgeToken: String
    public let outerInterface: String
    public let outerGateway: String?
    public let outerLocalIP: String?
    public let proxyURL: String?
    public let tunMTU: Int

    public init(
        runtimeKey: String,
        sessionID: String,
        simBridgeHost: String,
        simBridgeToken: String,
        outerInterface: String,
        outerGateway: String?,
        outerLocalIP: String?,
        proxyURL: String?,
        tunMTU: Int = 1_280
    ) {
        self.runtimeKey = runtimeKey
        self.sessionID = sessionID
        self.simBridgeHost = simBridgeHost
        self.simBridgeToken = simBridgeToken
        self.outerInterface = outerInterface
        self.outerGateway = outerGateway
        self.outerLocalIP = outerLocalIP
        self.proxyURL = proxyURL
        self.tunMTU = tunMTU
    }
}

public struct VoWiFiHostStatusRequest: Codable, Equatable, Sendable {
    public let runtimeKey: String

    public init(runtimeKey: String) {
        self.runtimeKey = runtimeKey
    }
}

@objc(VoDogNetworkHelperProtocol)
public protocol VoDogNetworkHelperProtocol {
    func ping(reply: @escaping (Int, String) -> Void)

    func applyCellularNetworkConfiguration(
        _ requestData: Data,
        reply: @escaping (Int, String) -> Void
    )

    func startVoWiFiHost(
        _ requestData: Data,
        reply: @escaping (Int, String, Data?) -> Void
    )

    func stopVoWiFiHost(
        _ requestData: Data,
        reply: @escaping (Int, String) -> Void
    )

    func queryVoWiFiHost(
        _ requestData: Data,
        reply: @escaping (Int, String, Data?) -> Void
    )
}
