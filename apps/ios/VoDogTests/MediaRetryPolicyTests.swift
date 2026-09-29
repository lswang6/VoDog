import XCTest
@testable import VoDog

final class MediaRetryPolicyTests: XCTestCase {
    func testRelayPathFailuresAreRetriedOverTLS() {
        XCTAssertTrue(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.iceGatheringTimedOut(.udp)))
        XCTAssertTrue(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.noRelayCandidate(.udp)))
        XCTAssertTrue(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.iceConnectTimedOut(.udp)))
        XCTAssertTrue(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.iceConnectionFailed(.udp)))
        XCTAssertTrue(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.peerCreationFailed))
        XCTAssertTrue(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.missingLocalDescription))
    }

    func testContractAndDeviceFailuresAreNotRetried() {
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.invalidRelayOptions))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.invalidAnswer))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.microphonePermissionDenied))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.audioSessionConfigurationFailed))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: MediaSessionError.callKitAudioTimedOut))
    }

    /// A server that just said "this call is gone" must not be asked the same question over TLS.
    func testServerErrorsAreNeverRetried() {
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: APIError.server(409, "", "MEDIA_REVOKED")))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: APIError.server(503, "", "GATEWAY_OFFLINE")))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: APIError.unauthorized))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: APIError.invalidResponse))
    }

    func testProbeSessionAndCancellationAreNeverRetried() {
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: MediaProbeError.networkChanged))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: MediaProbeError.invalidOptions))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: MediaProbeError.resultRejected))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: SessionLifecycleError.staleSession))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryTLS(after: CancellationError()))
    }

    /// WebRTC surfaces SDP and peer-connection problems as plain NSErrors; those get one TLS attempt.
    func testWebRTCErrorsAreRetried() {
        let error = NSError(domain: "org.webrtc.RTCPeerConnection", code: 5, userInfo: nil)
        XCTAssertTrue(MediaRetryPolicy.shouldRetryTLS(after: error))
    }

    func testNetworkChangeRetriesOnceOnlyWhenTheCoarsePathIsUnchanged() {
        let changed = MediaProbeError.networkChanged
        XCTAssertTrue(MediaRetryPolicy.shouldRetryAfterNetworkChange(
            after: changed, pathAtStart: "satisfied:wifi", pathNow: "satisfied:wifi", alreadyRetried: false))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryAfterNetworkChange(
            after: changed, pathAtStart: "satisfied:wifi", pathNow: "satisfied:wifi", alreadyRetried: true))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryAfterNetworkChange(
            after: changed, pathAtStart: "satisfied:wifi", pathNow: "satisfied:cellular", alreadyRetried: false))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryAfterNetworkChange(
            after: changed, pathAtStart: "unknown", pathNow: "unknown", alreadyRetried: false))
        XCTAssertFalse(MediaRetryPolicy.shouldRetryAfterNetworkChange(
            after: MediaProbeError.resultRejected, pathAtStart: "satisfied:wifi", pathNow: "satisfied:wifi",
            alreadyRetried: false))
    }
}

final class MediaRejoinPolicyTests: XCTestCase {
    func testFirstAttemptKeepsTransportThenSwitches() {
        XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 1, failedLeg: .udp), .udp)
        XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 2, failedLeg: .udp), .tls)
        XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 3, failedLeg: .udp), .tls)
        XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 1, failedLeg: .tls), .tls)
        XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 2, failedLeg: .tls), .udp)
        // S73h: after going offline the first attempt is UDP even when the failed leg was TLS, then alternates.
        for leg in [MediaTransport.udp, .tls] {
            XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 1, failedLeg: leg, wentOffline: true), .udp)
            XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 2, failedLeg: leg, wentOffline: true), .tls)
            XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 3, failedLeg: leg, wentOffline: true), .udp)
        }
        XCTAssertEqual(MediaRejoinPolicy.transport(forAttempt: 1, failedLeg: .tls, wentOffline: false), .tls)
    }

    func testFastFailureWaitsForSpacingAndConflictBacksOffTwoSeconds() {
        let ice = MediaSessionError.iceConnectionFailed(.udp)
        XCTAssertEqual(
            MediaRejoinPolicy.next(after: ice, attemptsMade: 1, elapsed: .seconds(1), sinceAttemptStart: .seconds(1)),
            .retry(after: .seconds(14))
        )
        XCTAssertEqual(
            MediaRejoinPolicy.next(after: ice, attemptsMade: 1, elapsed: .seconds(16), sinceAttemptStart: .seconds(16)),
            .retry(after: .zero)
        )
        let conflict = APIError.server(409, "", "MEDIA_LEG_CONNECTED")
        XCTAssertEqual(
            MediaRejoinPolicy.next(after: conflict, attemptsMade: 2, elapsed: .seconds(3), sinceAttemptStart: .seconds(1)),
            .retry(after: .seconds(2))
        )
        let bridgeBusy = APIError.server(503, "", "MEDIA_BRIDGE_UNAVAILABLE")
        XCTAssertTrue(MediaRejoinPolicy.isConflict(bridgeBusy))
        XCTAssertEqual(
            MediaRejoinPolicy.next(after: bridgeBusy, attemptsMade: 1, elapsed: .seconds(6), sinceAttemptStart: .seconds(1)),
            .retry(after: .seconds(2))
        )
        XCTAssertFalse(MediaRejoinPolicy.isConflict(APIError.server(503, "", "GATEWAY_OFFLINE")))
    }

    func testGivesUpAfterThreeAttemptsOrSixtySeconds() {
        let ice = MediaSessionError.iceConnectTimedOut(.tls)
        XCTAssertEqual(
            MediaRejoinPolicy.next(after: ice, attemptsMade: 3, elapsed: .seconds(20), sinceAttemptStart: .seconds(12)),
            .giveUp
        )
        XCTAssertEqual(
            MediaRejoinPolicy.next(after: ice, attemptsMade: 2, elapsed: .seconds(55), sinceAttemptStart: .seconds(2)),
            .giveUp
        )
        XCTAssertEqual(
            MediaRejoinPolicy.next(after: ice, attemptsMade: 2, elapsed: .seconds(40), sinceAttemptStart: .seconds(15)),
            .retry(after: .zero)
        )
    }

    func testProbeRequiredRetriesAtOnceWithTheProbe() {
        // S73g: rejoins (incl. setup_offline) skip the probe; 409 MEDIA_PROBE_REQUIRED means no node is fixed yet.
        let probeRequired = APIError.server(409, "", "MEDIA_PROBE_REQUIRED")
        XCTAssertTrue(MediaRejoinPolicy.isProbeRequired(probeRequired))
        XCTAssertFalse(MediaRejoinPolicy.isProbeRequired(APIError.server(409, "", "MEDIA_LEG_CONNECTED")))
        XCTAssertFalse(MediaRejoinPolicy.isProbeRequired(MediaProbeError.networkChanged))
        // Uncounted by the caller, so it retries even after three counted attempts.
        XCTAssertEqual(
            MediaRejoinPolicy.next(
                after: probeRequired, attemptsMade: 3, elapsed: .seconds(25), sinceAttemptStart: .milliseconds(300),
                probeRetry: true
            ),
            .retry(after: .zero)
        )
        XCTAssertEqual(
            MediaRejoinPolicy.next(
                after: probeRequired, attemptsMade: 1, elapsed: .seconds(60), sinceAttemptStart: .zero, probeRetry: true
            ),
            .giveUp
        )
        // Once the episode already probes, the same answer is an ordinary counted conflict.
        XCTAssertEqual(
            MediaRejoinPolicy.next(
                after: probeRequired, attemptsMade: 1, elapsed: .seconds(5), sinceAttemptStart: .seconds(1)
            ),
            .retry(after: .seconds(2))
        )
    }

    func testOfflineFailureRetriesAtOnceUncountedWithinWindow() {
        let offline = URLError(.notConnectedToInternet)
        XCTAssertEqual(
            MediaRejoinPolicy.next(
                after: offline, attemptsMade: 1, elapsed: .seconds(6), sinceAttemptStart: .milliseconds(50),
                offline: true
            ),
            .retry(after: .zero)
        )
        // Not counted: an offline failure after three counted attempts still retries.
        XCTAssertEqual(
            MediaRejoinPolicy.next(
                after: offline, attemptsMade: 3, elapsed: .seconds(30), sinceAttemptStart: .zero, offline: true
            ),
            .retry(after: .zero)
        )
        XCTAssertEqual(
            MediaRejoinPolicy.next(
                after: offline, attemptsMade: 1, elapsed: .seconds(60), sinceAttemptStart: .zero, offline: true
            ),
            .giveUp
        )
        XCTAssertEqual(
            MediaRejoinPolicy.next(
                after: APIError.server(404, "", "CALL_NOT_FOUND"), attemptsMade: 1, elapsed: .seconds(1),
                sinceAttemptStart: .zero, offline: true
            ),
            .giveUp
        )
        XCTAssertTrue(MediaRejoinPolicy.isOffline(pathLabel: "unsatisfied:other"))
        XCTAssertTrue(MediaRejoinPolicy.isOffline(pathLabel: "requiresConnection:cellular"))
        XCTAssertFalse(MediaRejoinPolicy.isOffline(pathLabel: "satisfied:wifi"))
        XCTAssertFalse(MediaRejoinPolicy.isOffline(pathLabel: "unknown"))
    }

    func testNetworkErrorOnSatisfiedPathRetriesInOneSecondUncounted() {
        for error: Error in [MediaProbeError.networkChanged, URLError(.timedOut), URLError(.networkConnectionLost)] {
            XCTAssertTrue(MediaRejoinPolicy.isNetworkError(error), "\(error)")
            XCTAssertEqual(
                MediaRejoinPolicy.next(after: error, attemptsMade: 1, elapsed: .seconds(16), sinceAttemptStart: .seconds(1)),
                .retry(after: .seconds(1)), "\(error)"
            )
            // Not counted: still retried after three counted attempts, bounded only by the window.
            XCTAssertEqual(
                MediaRejoinPolicy.next(after: error, attemptsMade: 3, elapsed: .seconds(40), sinceAttemptStart: .zero),
                .retry(after: .seconds(1)), "\(error)"
            )
            XCTAssertEqual(
                MediaRejoinPolicy.next(after: error, attemptsMade: 1, elapsed: .seconds(59), sinceAttemptStart: .zero),
                .giveUp, "\(error)"
            )
        }
        // ICE failures on a live network keep the 15 s spacing.
        XCTAssertFalse(MediaRejoinPolicy.isNetworkError(MediaSessionError.iceConnectTimedOut(.udp)))
        XCTAssertFalse(MediaRejoinPolicy.isNetworkError(APIError.server(503, "", nil)))
    }

    func testServerEndedAndSessionFailuresAreNotRejoined() {
        for error: Error in [
            APIError.server(409, "", "MEDIA_REVOKED"), APIError.unauthorized, APIError.server(403, "", nil),
            APIError.server(404, "", "CALL_NOT_FOUND"), APIError.server(400, "", nil),
            SessionLifecycleError.staleSession, CancellationError(), MediaSessionError.microphonePermissionDenied
        ] {
            XCTAssertEqual(
                MediaRejoinPolicy.next(after: error, attemptsMade: 1, elapsed: .zero, sinceAttemptStart: .zero),
                .giveUp, "\(error)"
            )
        }
        XCTAssertFalse(MediaRejoinPolicy.isConflict(APIError.server(409, "", "MEDIA_REVOKED")))
        XCTAssertTrue(MediaRejoinPolicy.isRecoverable(URLError(.notConnectedToInternet)))
        XCTAssertTrue(MediaRejoinPolicy.isRecoverable(APIError.server(503, "", nil)))
    }

    func testSetupFailureOfflineOrOnNetworkErrorRejoinsOnlineFailureDoesNot() {
        // Offline: any recoverable failure waits for the path instead of going to grace.
        XCTAssertTrue(MediaRejoinPolicy.shouldRejoinSetup(after: MediaSessionError.iceConnectTimedOut(.udp), offline: true))
        XCTAssertTrue(MediaRejoinPolicy.shouldRejoinSetup(after: URLError(.notConnectedToInternet), offline: true))
        // Network error on a satisfied path.
        XCTAssertTrue(MediaRejoinPolicy.shouldRejoinSetup(after: URLError(.timedOut), offline: false))
        XCTAssertTrue(MediaRejoinPolicy.shouldRejoinSetup(after: MediaProbeError.networkChanged, offline: false))
        // Online failures keep today's grace path.
        for error: Error in [
            MediaSessionError.iceConnectTimedOut(.udp), MediaSessionError.noRelayCandidate(.tls),
            APIError.server(403, "", nil), APIError.server(503, "", nil),
            MediaProbeError.invalidOptions, MediaProbeError.resultRejected
        ] {
            XCTAssertFalse(MediaRejoinPolicy.shouldRejoinSetup(after: error, offline: false), "\(error)")
        }
        // Never rejoined, even offline: the call is not ours or the device can't do audio.
        for error: Error in [
            APIError.server(404, "", "CALL_NOT_FOUND"), APIError.unauthorized, SessionLifecycleError.staleSession,
            CancellationError(), MediaSessionError.microphonePermissionDenied
        ] {
            XCTAssertFalse(MediaRejoinPolicy.shouldRejoinSetup(after: error, offline: true), "\(error)")
        }
    }
}
