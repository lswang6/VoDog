import Foundation
#if canImport(VoDogNetworkIPC)
import VoDogNetworkIPC
#endif

enum CellularLinkRecoveryPolicy {
    static let maximumAttempts = 3

    /// Recovery is evaluated per module. A module the user asked to keep
    /// connected deserves the same repair path as the preferred one; only a
    /// module that is meant to be off is left alone.
    static func shouldAttempt(
        network: CellularNetworkStatus,
        modem: ModemSnapshot,
        desiredMode: CellularNetworkMode = .preferred,
        hasCall: Bool,
        isChangingNetwork: Bool,
        isInFlight: Bool,
        completedAttempts: Int
    ) -> Bool {
        desiredMode.isEnabled &&
            network.isEnabled &&
            network.isHardwarePresent &&
            !network.isActive &&
            modem.isConnected &&
            modem.usbNetMode == 1 &&
            !hasCall &&
            !isChangingNetwork &&
            !isInFlight &&
            completedAttempts < maximumAttempts
    }

    static func shouldRestartModule(
        network: CellularNetworkStatus,
        modem: ModemSnapshot,
        desiredMode: CellularNetworkMode = .preferred,
        hasCall: Bool,
        completedAttempts: Int,
        alreadyRestarted: Bool
    ) -> Bool {
        completedAttempts >= maximumAttempts &&
            !alreadyRestarted &&
            desiredMode.isEnabled &&
            network.isEnabled &&
            modem.isConnected &&
            modem.usbNetMode == 1 &&
            !hasCall
    }

    /// The helper cannot see the module's internal bridge state, so a carrier
    /// that is up does not prove the data path forwards. Any enabled module
    /// whose interface is not carrying traffic still needs preparing.
    static func needsLinkPreparation(_ network: CellularNetworkStatus) -> Bool {
        !network.isEnabled || !network.isLinkActive
    }

    /// Whether automatic repair still has something left to try for a module.
    /// Drives the difference between "正在自动重试" and "已停止自动重试", so the user
    /// knows whether waiting is pointless and manual action is needed.
    static func isRetrying(completedAttempts: Int, hasRestarted: Bool) -> Bool {
        completedAttempts < maximumAttempts || !hasRestarted
    }

    /// A power cycle re-enumerates USB, so it is the last resort.
    ///
    /// Only a DHCP timeout justifies skipping the soft-recovery ladder: the link
    /// is already carrying traffic, so more link repair cannot help. An inactive
    /// link may simply be slow to come up — a module rejoining its internal
    /// bridge needs about 26 seconds — and every backoff step buys it more time.
    /// Escalating on the first inactive link made the three-attempt ladder dead
    /// code and power cycled healthy-but-slow modules.
    static func shouldEscalateToRestart(
        reason: CellularNetworkFailureReason,
        completedAttempts: Int
    ) -> Bool {
        switch reason {
        case .dhcpTimeout:
            return true
        case .linkInactive:
            return completedAttempts >= maximumAttempts
        case .other:
            return false
        }
    }

    /// A power cycle re-enumerates USB, so it must stay rare. A chronically
    /// faulty module often blips active for a few seconds after a restart, and
    /// treating that as "healthy again" would re-arm the restart path forever.
    static let restartCooldown: TimeInterval = 600

    static func canClearRestartGuard(lastRestart: Date?, now: Date) -> Bool {
        guard let lastRestart else { return true }
        return now.timeIntervalSince(lastRestart) >= restartCooldown
    }

    static func delayNanoseconds(completedAttempts: Int) -> UInt64 {
        switch completedAttempts {
        case ...0: return 3_000_000_000
        case 1: return 15_000_000_000
        default: return 30_000_000_000
        }
    }
}
