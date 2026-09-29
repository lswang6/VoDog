import Foundation

enum OccupancyReleasePolicy {
    enum Trigger: Equatable {
        case background
        case terminate
    }

    enum MediaLiveness: Equatable {
        case idle
        case connecting
        case connected
        case failed
    }

    static func mediaLiveness(_ state: CallMediaSession.State) -> MediaLiveness {
        switch state {
        case .idle: .idle
        case .connecting: .connecting
        case .connected: .connected
        case .failed: .failed
        }
    }

    static func isLive(activeCallIDs: [String], media: MediaLiveness) -> Bool {
        !activeCallIDs.isEmpty || media == .connecting || media == .connected
    }

    static func shouldRelease(
        trigger: Trigger,
        isLive: Bool,
        media: MediaLiveness = .idle,
        hasCallKit: Bool = false
    ) -> Bool {
        switch trigger {
        case .background:
            if hasCallKit { return !isLive }
            // Swipe-away does not run willTerminate. A silent connecting leftover would
            // otherwise keep occupying the gateway after the user leaves the app.
            return media != .connected
        case .terminate:
            return true
        }
    }

    static func ownedIDs(
        mediaCallID: String?,
        ownedCallSessions: [String: UUID],
        currentSessionIdentity: UUID
    ) -> Set<String> {
        var ids = Set(
            ownedCallSessions.compactMap { key, identity in
                identity == currentSessionIdentity ? key.lowercased() : nil
            }
        )
        if let mediaCallID, !mediaCallID.isEmpty {
            ids.insert(mediaCallID.lowercased())
        }
        return ids
    }
}
