import Foundation

/// The ICE connection states the app reacts to, mirrored off WebRTC so this policy — and its tests — need no peer
/// connection.
enum MediaIceState: Equatable, Sendable {
    case new, checking, connected, completed, failed, disconnected, closed, unknown
}

/// S18 decision 6: after the answer is applied, `checking` gets at most 12 s; a `disconnected` that had already
/// connected gets 5 s of grace before it counts as a failure.
enum MediaIceWaitPolicy {
    static let connectPollInterval: Duration = .milliseconds(100)
    static let connectPollCount = 120
    static let connectTimeout: Duration = .seconds(12)
    static let disconnectGrace: Duration = .seconds(5)
    /// A CallKit-managed attempt waits at most this long for `didActivate` before failing instead of hanging.
    static let callKitAudioTimeout: Duration = .seconds(8)

    enum Progress: Equatable {
        case connected
        case waiting
        case failed
    }

    /// `disconnected` counts as waiting here: during the connect wait it can still recover, and after a connection
    /// it is handled by `disconnectGrace`.
    static func progress(for state: MediaIceState) -> Progress {
        switch state {
        case .connected, .completed: .connected
        case .failed, .closed: .failed
        case .new, .checking, .disconnected, .unknown: .waiting
        }
    }

    static func isUsable(_ state: MediaIceState) -> Bool { progress(for: state) == .connected }

    /// S70d: a live call whose media drops asks Control right away whether the far side hung up.
    static func warrantsCallStateCheck(_ state: MediaIceState) -> Bool {
        [.disconnected, .failed, .closed].contains(state)
    }
}

/// Limit queued audio to about 500 ms and accelerate excess buffered audio to reduce latency.
enum MediaReceivePolicy {
    static let audioJitterBufferFastAccelerate = true
    static let audioJitterBufferMaxPackets: Int32 = 25
}
