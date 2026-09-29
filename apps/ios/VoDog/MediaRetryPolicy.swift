import Foundation

/// Decides whether a failed UDP attempt may be retried over TLS.
///
/// A TLS re-run only changes the relay path, so it can fix an unreachable or filtered UDP relay and nothing else.
/// Retrying a refused permission, a rejected contract or a server error just doubled the time the user waited for
/// the same failure, and a call the server had already ended came back as a misleading "使用 TLS 重试音频".
enum MediaRetryPolicy {
    static func shouldRetryTLS(after error: Error) -> Bool {
        switch error {
        case is APIError, is MediaProbeError, is SessionLifecycleError, is CancellationError:
            return false
        case let mediaError as MediaSessionError:
            return shouldRetryTLS(after: mediaError)
        default:
            // WebRTC reports SDP and peer-connection problems as plain NSErrors; those are worth one TLS attempt.
            return true
        }
    }

    static func shouldRetryTLS(after error: MediaSessionError) -> Bool {
        switch error {
        case .invalidRelayOptions, .invalidAnswer, .microphonePermissionDenied, .audioSessionConfigurationFailed,
             .callKitAudioTimedOut:
            // The relay contract, the answer and the audio session are identical on the TLS path.
            false
        case .iceGatheringTimedOut, .noRelayCandidate, .iceConnectTimedOut, .iceConnectionFailed,
             .peerCreationFailed, .missingLocalDescription:
            true
        }
    }

    static func shouldRetryAfterNetworkChange(
        after error: Error, pathAtStart: String, pathNow: String, alreadyRetried: Bool
    ) -> Bool {
        !alreadyRetried && (error as? MediaProbeError) == .networkChanged
            && pathAtStart == pathNow && pathNow.hasPrefix("satisfied:")
    }
}

/// S73 D3: a leg that drops after it connected is rejoined with a fresh peer (new options + offer); the bridge keeps
/// the room for 60 s and swaps the new same-role leg in. This replaces the old one-shot TLS fallback and the
/// "重试音频" grace for established calls; only an exhausted rejoin falls through to that grace.
enum MediaRejoinPolicy {
    static let maxAttempts = 3
    static let window: Duration = .seconds(60)
    /// The bridge answers 409 while the old leg still reads Connected (Control relays it as 409 or
    /// `503 MEDIA_BRIDGE_UNAVAILABLE`); it will not for long.
    static let conflictBackoff: Duration = .seconds(2)
    /// A network that is still down fails an attempt in milliseconds; spacing attempt starts keeps three attempts
    /// spread over ~30–45 s of the window instead of burnt in one second.
    static let attemptSpacing: Duration = .seconds(15)
    static let statusText = "网络波动，正在重新连接…"
    /// S73d: a probe or HTTP failure on a path that reads satisfied (Wi-Fi still re-associating) retries this soon.
    static let networkErrorRetry: Duration = .seconds(1)

    enum Decision: Equatable {
        case retry(after: Duration)
        case giveUp
    }

    static func transport(forAttempt attempt: Int, failedLeg: MediaTransport, wentOffline: Bool = false) -> MediaTransport {
        if wentOffline { return attempt % 2 == 1 ? .udp : .tls }
        return attempt <= 1 ? failedLeg : (failedLeg == .udp ? .tls : .udp)
    }

    /// ponytail: the 60 s window is checked only when an attempt starts; one begun near 60 s may run into its own
    /// options/ICE timeouts past it. Add a deadline task if the bridge window ever gets tighter than ~75 s.
    /// `elapsed`: since the leg dropped; `sinceAttemptStart`: since the attempt that just failed began.
    /// S73c: `offline` (no satisfied path when it failed) is not counted by the caller and retries at once — the
    /// next attempt itself waits for the path (`isOffline`), so recovery starts the moment the network is back.
    /// S73g: `probeRetry` (a skipped-probe attempt got 409 `MEDIA_PROBE_REQUIRED`, see `isProbeRequired`) retries at
    /// once, uncounted by the caller, with the probe.
    static func next(
        after error: Error, attemptsMade: Int, elapsed: Duration, sinceAttemptStart: Duration, offline: Bool = false,
        probeRetry: Bool = false
    ) -> Decision {
        guard isRecoverable(error) else { return .giveUp }
        if offline || probeRetry { return elapsed < window ? .retry(after: .zero) : .giveUp }
        if isNetworkError(error) { return elapsed + networkErrorRetry < window ? .retry(after: networkErrorRetry) : .giveUp }
        guard attemptsMade < maxAttempts else { return .giveUp }
        let delay = isConflict(error) ? conflictBackoff : max(.zero, attemptSpacing - sinceAttemptStart)
        return elapsed + delay < window ? .retry(after: delay) : .giveUp
    }

    static func shouldRejoinSetup(after error: Error, offline: Bool) -> Bool {
        guard isRecoverable(error) else { return false }
        return offline || error is URLError || (error as? MediaProbeError) == .networkChanged
    }

    /// S73d: like offline, not counted and no transport switch — the relay path was never tried.
    static func isNetworkError(_ error: Error) -> Bool {
        error is MediaProbeError || error is URLError
    }

    /// `MediaNetworkGenerationSource.currentPathLabel()`; "unknown" (no update yet) is not treated as offline.
    static func isOffline(pathLabel: String) -> Bool {
        pathLabel != "unknown" && !pathLabel.hasPrefix("satisfied:")
    }

    /// S73g: every rejoin (incl. `setup_offline`) skips the probe; Control answers this when the call has no media node
    /// fixed yet (since S73f the gateway usually fixes the preferred one first), so the episode's next attempt probes.
    static func isProbeRequired(_ error: Error) -> Bool {
        (error as? APIError)?.serverCode == "MEDIA_PROBE_REQUIRED"
    }

    static func isConflict(_ error: Error) -> Bool {
        guard case let .server(status, _, code)? = error as? APIError,
              !MediaGracePolicy.serverEndedCodes.contains(code ?? "") else { return false }
        return status == 409 || (status == 503 && code == "MEDIA_BRIDGE_UNAVAILABLE")
    }

    /// Conflicts, network errors and other 5xx are retried; any other 4xx from Control (auth, revoked, not found)
    /// means the call is not ours to rejoin.
    static func isRecoverable(_ error: Error) -> Bool {
        if isConflict(error) { return true }
        switch error {
        case is SessionLifecycleError, is CancellationError: return false
        case APIError.unauthorized: return false
        case let APIError.server(status, _, _) where (400..<500).contains(status): return false
        case MediaSessionError.microphonePermissionDenied, MediaSessionError.audioSessionConfigurationFailed:
            return false
        default: return true
        }
    }
}
