import XCTest
@testable import VoDog

final class CallUIPresentationTests: XCTestCase {
    private func call(_ id: String = "a", state: String = "active", owned: Bool = true, ai: Bool = false) throws -> CallRecord {
        let object: [String: Any] = ["id": id, "state": state, "claimedByCurrentSession": owned,
                                     "answerMode": ai ? "ai" : "normal", "aiHandling": ai]
        return try JSONDecoder().decode(CallRecord.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testMinimizedIdentitySurvivesLiveUpdatesAndExplicitlyRestores() throws {
        let session = UUID()
        var policy = CallUIPresentationPolicy()
        policy.update(sessionID: session, calls: [try call(state: "connecting")], mediaCallID: nil)
        let identity = try XCTUnwrap(policy.presented?.id)
        policy.minimize()
        policy.update(sessionID: session, calls: [try call()], mediaCallID: "a")
        XCTAssertNil(policy.presented)
        XCTAssertEqual(policy.current?.id, identity)
        XCTAssertEqual(policy.current?.call.state, "active")
        policy.restore()
        XCTAssertEqual(policy.presented?.id, identity)
        XCTAssertEqual(policy.presented?.call.state, "active")
    }

    func testMissingSnapshotIsNotTerminalButExplicitEndClosesAndNewIDPresents() throws {
        let session = UUID()
        var policy = CallUIPresentationPolicy()
        policy.update(sessionID: session, calls: [try call()], mediaCallID: "a")
        policy.minimize()
        policy.update(sessionID: session, calls: [], mediaCallID: nil)
        XCTAssertEqual(policy.current?.id.call, "a")
        XCTAssertNil(policy.presented)
        policy.update(sessionID: session, calls: [try call(state: "ended")], mediaCallID: nil)
        XCTAssertNil(policy.current)
        policy.update(sessionID: session, calls: [try call("b")], mediaCallID: "b")
        XCTAssertEqual(policy.presented?.id.call, "b")
        policy.update(sessionID: session, calls: [try call(), try call("b")], mediaCallID: nil)
        XCTAssertEqual(policy.current?.id.call, "b", "A late pre-terminal row must not resurrect the ended call")
    }

    func testOtherOwnerAISuppressionAndUnclaimedRingingNeverPresent() throws {
        var policy = CallUIPresentationPolicy()
        let session = UUID()
        let missingOwnership = try JSONDecoder().decode(CallRecord.self, from: Data(#"{"id":"a","state":"active"}"#.utf8))
        for row in [missingOwnership, try call(owned: false), try call(ai: true), try call(state: "incoming_ringing", owned: false)] {
            policy.update(sessionID: session, calls: [row], mediaCallID: "a")
            XCTAssertNil(policy.current)
            XCTAssertNil(policy.presented)
        }
    }

    func testOwnershipLossAndSessionBoundaryInvalidatePresentation() throws {
        var policy = CallUIPresentationPolicy()
        let session = UUID()
        policy.update(sessionID: session, calls: [try call()], mediaCallID: nil)
        policy.update(sessionID: session, calls: [try call(owned: false)], mediaCallID: nil)
        XCTAssertNil(policy.current)
        policy.update(sessionID: nil, calls: [], mediaCallID: nil)
        XCTAssertNil(policy.presented)
        let nextSession = UUID()
        policy.update(sessionID: nextSession, calls: [try call()], mediaCallID: nil)
        XCTAssertEqual(policy.presented?.id.session, nextSession)
    }

    func testUnknownAndEndingKeepOwnedIdentityWithoutResettingMinimize() throws {
        var policy = CallUIPresentationPolicy()
        let session = UUID()
        policy.update(sessionID: session, calls: [try call()], mediaCallID: nil)
        policy.minimize()
        for state in ["unknown", "ending"] {
            policy.update(sessionID: session, calls: [try call(state: state)], mediaCallID: nil)
            XCTAssertEqual(policy.current?.call.state, state)
            XCTAssertNil(policy.presented)
        }
    }

    @MainActor
    func testDeviceOfflineOverridesCachedSIMButGatewayStandbyRemainsIndependent() throws {
        let store = UIAvailabilityState()
        let sim = try JSONDecoder().decode(SIMChannel.self, from: Data(#"{"id":"sim","online":true,"telephonyReady":true,"mediaReady":true,"smsReady":true}"#.utf8))
        store.updatePath(available: true)
        store.didRefreshSIMs([sim])
        XCTAssertTrue(store.canDial(on: "sim"))
        XCTAssertTrue(store.canSendSMS(on: "sim"))
        let standby = GatewayPower(gatewayId: "gateway", online: false, standbyOnline: true, remotePowerAllowed: true)
        XCTAssertTrue(store.canChangeGatewayPower(standby))
        store.updatePath(available: false)
        XCTAssertFalse(store.canMutate)
        XCTAssertFalse(store.canDial(on: "sim"))
        XCTAssertFalse(store.canSendSMS(on: "sim"))
        XCTAssertEqual(store.simStatus(sim), "设备未联网")
        XCTAssertEqual(store.reason, "设备未联网，已加载内容仍可查看；联网后可继续提交。")
        store.callMediaActive = true
        XCTAssertEqual(store.reason, "网络已断开，恢复后通话将自动重连")
        XCTAssertFalse(store.canMutate, "Call wording must not relax offline gating")
        store.callMediaActive = false
        XCTAssertEqual(store.sims.count, 1, "Network loss must not erase the cached identity")
        store.updatePath(available: true)
        XCTAssertFalse(store.canDial(on: "sim"), "Wait for the existing refresh to confirm capability")
        store.didRefreshSIMs([sim])
        XCTAssertTrue(store.canDial(on: "sim"))
        let offlineSIM = try JSONDecoder().decode(SIMChannel.self, from: Data(#"{"id":"sim","online":false}"#.utf8))
        store.didRefreshSIMs([offlineSIM])
        XCTAssertEqual(store.simStatus(offlineSIM), "号码设备离线")
        XCTAssertNil(store.reason)
        XCTAssertFalse(store.canDial(on: "sim"))
        XCTAssertTrue(store.canChangeGatewayPower(standby))
    }

    @MainActor
    func testBusinessErrorsAreNotOfflineAndTransportFailureIsNotGatewayOffline() throws {
        let store = UIAvailabilityState()
        store.updatePath(available: true)
        store.didFailRefresh(APIError.server(409, "conflict", nil))
        XCTAssertTrue(store.canMutate)
        store.didFailRefresh(APIError.unauthorized)
        XCTAssertTrue(store.canMutate)
        store.didFailRefresh(URLError(.timedOut))
        XCTAssertFalse(store.canMutate)
        XCTAssertEqual(store.path, .available)
        XCTAssertTrue(store.reason?.contains("连接暂不可用") == true)
        store.didRefreshSIMs([])
        XCTAssertTrue(store.canMutate)
    }

    func testImmediateEndLatchAndUnconfirmedRetryDoNotInventTerminalState() {
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertTrue(CallUIEndPolicy.isPending(requestedAt: start, state: "active", now: start))
        XCTAssertFalse(CallUIEndPolicy.isPending(requestedAt: start, state: "active", now: start.addingTimeInterval(CallUIEndPolicy.confirmationWindow + 1)))
        XCTAssertTrue(CallUIEndPolicy.isPending(requestedAt: nil, state: "ending", now: start))
        XCTAssertFalse(CallUIEndPolicy.isPending(requestedAt: nil, state: "active", now: start))
    }

    func testElapsedTimeRequiresAnsweredTimestampAndFreezesAtAuthoritativeEnd() throws {
        let now = try XCTUnwrap(GatewayTimeDisplay.parseISO("2026-09-20T01:02:03Z"))
        XCTAssertNil(CallElapsedTimePolicy.seconds(answeredAt: nil, endedAt: nil, now: now))
        XCTAssertNil(CallElapsedTimePolicy.seconds(answeredAt: "invalid", endedAt: nil, now: now))
        XCTAssertNil(CallElapsedTimePolicy.seconds(answeredAt: "2026-09-20T01:00:00Z", endedAt: "invalid", now: now))
        XCTAssertNil(CallElapsedTimePolicy.seconds(answeredAt: "2026-09-20T01:00:00Z", endedAt: nil, now: now, state: "ended"))
        XCTAssertEqual(CallElapsedTimePolicy.seconds(answeredAt: "2026-09-20T01:03:00Z", endedAt: nil, now: now), 0)
        XCTAssertEqual(CallElapsedTimePolicy.seconds(answeredAt: "2026-09-20T01:00:00Z", endedAt: nil, now: now.addingTimeInterval(0.9)), 123)
        XCTAssertEqual(CallElapsedTimePolicy.seconds(answeredAt: "2026-09-20T01:00:00Z", endedAt: nil, now: now), 123)
        XCTAssertEqual(CallElapsedTimePolicy.seconds(answeredAt: "2026-09-20T01:00:00Z", endedAt: "2026-09-20T01:01:00Z", now: now), 60)
        XCTAssertEqual(CallElapsedTimePolicy.text(seconds: 123), "02:03")
        XCTAssertEqual(CallElapsedTimePolicy.text(seconds: 3601), "1:00:01")
    }
    func testEndRequestFreezesThenResumesFromOriginalAnswerAndAuthoritativeEndingStaysFrozen() throws {
        let answered = "2026-09-20T01:00:00Z"
        let stop = try XCTUnwrap(GatewayTimeDisplay.parseISO("2026-09-20T01:00:10Z"))
        XCTAssertEqual(CallElapsedTimePolicy.seconds(answeredAt: answered, endedAt: nil, now: stop.addingTimeInterval(2), state: "active", requestedAt: stop), 10)
        let retry = stop.addingTimeInterval(CallUIEndPolicy.confirmationWindow + 1)
        XCTAssertEqual(CallElapsedTimePolicy.seconds(answeredAt: answered, endedAt: nil, now: retry, state: "active", requestedAt: stop), 10 + Int(CallUIEndPolicy.confirmationWindow) + 1)
        XCTAssertEqual(CallElapsedTimePolicy.seconds(answeredAt: answered, endedAt: nil, now: retry, state: "ending", endingObservedAt: stop), 10)
        XCTAssertEqual(CallElapsedTimePolicy.seconds(answeredAt: answered, endedAt: "2026-09-20T01:00:12Z", now: retry, state: "ended", requestedAt: stop), 12)
        XCTAssertNil(CallElapsedTimePolicy.seconds(answeredAt: nil, endedAt: nil, now: stop, requestedAt: stop))
    }

}
