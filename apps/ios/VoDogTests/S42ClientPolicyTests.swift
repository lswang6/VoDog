import XCTest
@testable import VoDog

/// S42 decision 5: 推送到达时 iPhone 已在别的通话里，机主接不了，客户端必须把「占线」告诉 Control。
/// 这里锁死的是「占线」的定义——判错一边会让 AI 抢在机主前面代接，判错另一边会让来电白响。
final class S42ClientPolicyTests: XCTestCase {

    private let incoming = UUID()

    private func call(
        _ uuid: UUID, ended: Bool = false, connected: Bool = false, outgoing: Bool = false, onHold: Bool = false
    ) -> OwnerBusyPolicy.CallState {
        OwnerBusyPolicy.CallState(
            uuid: uuid, hasEnded: ended, hasConnected: connected, isOutgoing: outgoing, isOnHold: onHold
        )
    }

    func testAnIdlePhoneOrThisCallAloneIsNeverBusy() {
        XCTAssertFalse(OwnerBusyPolicy.isBusy(calls: [], incomingCallUUID: incoming))

        // This call's own CallKit leg must never count as the call that blocks it, whenever the read happens.
        XCTAssertFalse(OwnerBusyPolicy.isBusy(calls: [call(incoming)], incomingCallUUID: incoming))
        XCTAssertFalse(OwnerBusyPolicy.isBusy(calls: [call(incoming, connected: true)], incomingCallUUID: incoming))
    }

    func testAnotherLiveCallIsBusy() {
        XCTAssertTrue(OwnerBusyPolicy.isBusy(calls: [call(UUID(), connected: true)], incomingCallUUID: incoming))
        // Still dialling: no audio yet, but the user is just as unable to answer.
        XCTAssertTrue(OwnerBusyPolicy.isBusy(calls: [call(UUID(), outgoing: true)], incomingCallUUID: incoming))
        // On hold is still connected.
        XCTAssertTrue(
            OwnerBusyPolicy.isBusy(calls: [call(UUID(), connected: true, onHold: true)], incomingCallUUID: incoming)
        )
        XCTAssertTrue(
            OwnerBusyPolicy.isBusy(
                calls: [call(incoming), call(UUID(), ended: true), call(UUID(), connected: true)],
                incomingCallUUID: incoming
            )
        )
    }

    func testAFinishedOrMerelyRingingCallIsNotBusy() {
        XCTAssertFalse(OwnerBusyPolicy.isBusy(calls: [call(UUID(), ended: true)], incomingCallUUID: incoming))
        XCTAssertFalse(
            OwnerBusyPolicy.isBusy(calls: [call(UUID(), ended: true, connected: true)], incomingCallUUID: incoming)
        )
        // Another *incoming* call ringing next to this one: nothing owns the audio, the user can still pick either.
        XCTAssertFalse(OwnerBusyPolicy.isBusy(calls: [call(UUID())], incomingCallUUID: incoming))
        // A push whose id is not a UUID leaves nothing to exclude; the live call still decides.
        XCTAssertTrue(OwnerBusyPolicy.isBusy(calls: [call(UUID(), connected: true)], incomingCallUUID: nil))
    }

    /// A cold-launched answer waits 5 × 1 s only for the session; a withdrawn offer gives up at once.
    func testAnswerWaitsOnlyForAMissingSession() {
        XCTAssertNil(ClaimedCallPolicy.answerBlocker(offered: true, authenticated: true))
        XCTAssertEqual(ClaimedCallPolicy.answerBlocker(offered: true, authenticated: false), "not_authenticated")
        XCTAssertEqual(ClaimedCallPolicy.answerBlocker(offered: false, authenticated: true), "not_offered")
        XCTAssertEqual(ClaimedCallPolicy.answerBlocker(offered: false, authenticated: false), "not_offered")
        XCTAssertTrue(ClaimedCallPolicy.shouldWaitForSession(blocker: "not_authenticated"))
        XCTAssertFalse(ClaimedCallPolicy.shouldWaitForSession(blocker: "not_offered"))
        XCTAssertFalse(ClaimedCallPolicy.shouldWaitForSession(blocker: nil))
        XCTAssertEqual(ClaimedCallPolicy.sessionWaitAttempts, 5)
        XCTAssertEqual(ClaimedCallPolicy.sessionWaitInterval, .seconds(1))
    }
}
