import Foundation

enum MediaCandidateNetworkPolicy {
    enum Choice: Equatable {
        /// Wi-Fi or Ethernet is carrying the path: keep pruning the tunnels.
        case lowCost
        /// Cellular-only, or a path no one has read yet: gather on everything.
        case all

        var label: String {
            switch self {
            case .lowCost: "lowCost"
            case .all: "all"
            }
        }
    }

    /// Reads the path the way `NWPath` answers it. "Uses" rather than "has available", deliberately: a Wi-Fi
    /// network that is joined but not carrying traffic (a captive portal, say) must not switch the filter back on
    /// and strip the cellular interface actually doing the work.
    static func choice(isSatisfied: Bool, usesWiFi: Bool, usesWiredEthernet: Bool) -> Choice {
        isSatisfied && (usesWiFi || usesWiredEthernet) ? .lowCost : .all
    }
}
