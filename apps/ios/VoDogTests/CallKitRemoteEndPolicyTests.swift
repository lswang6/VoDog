import XCTest
@testable import VoDog

final class CallKitRemoteEndPolicyTests: XCTestCase {
    func testEndsOnlyTrackedCallsTheListReportsFinished() {
        let tracked = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]
        let calls: [(id: String, state: String?)] = [
            // Present and finished — ended, case-insensitively.
            ("11111111-1111-1111-1111-111111111111".uppercased(), "ENDED"),
            // Present and still live — kept.
            ("22222222-2222-2222-2222-222222222222", "active"),
            // Finished but never tracked by CallKit — nothing to end.
            ("33333333-3333-3333-3333-333333333333", "failed"),
        ]
        XCTAssertEqual(
            CallKitRemoteEndPolicy.idsToEnd(activeCallKitIDs: tracked, calls: calls),
            ["11111111-1111-1111-1111-111111111111"]
        )

        // A just-reported ringing call races the poll: absence from the list never ends anything.
        XCTAssertEqual(CallKitRemoteEndPolicy.idsToEnd(activeCallKitIDs: tracked, calls: []), [])

        XCTAssertTrue(CallKitRemoteEndPolicy.isFinished("ended"))
        XCTAssertTrue(CallKitRemoteEndPolicy.isFinished("Failed"))
        for state in ["incoming_ringing", "outgoing_pending", "connecting", "active", "ending", "unknown", nil] {
            XCTAssertFalse(CallKitRemoteEndPolicy.isFinished(state), "state=\(state ?? "nil")")
        }
    }
}
