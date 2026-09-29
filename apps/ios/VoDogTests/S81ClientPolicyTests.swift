import XCTest
@testable import VoDog

/// S81：CallKit 来电名带被叫 SIM；推送首报与对账共用同一拼装函数。
final class S81ClientPolicyTests: XCTestCase {

    private func name(
        contact: String? = nil, number: String? = nil, isInternal: Bool = false, peer: String? = nil, sim: String? = nil
    ) -> String? {
        IncomingCallerName.text(
            contactName: contact, remoteNumber: number, isInternal: isInternal, peerSimLabel: peer, simLabel: sim
        )
    }

    func testComposesCallerAndCalledSim() {
        XCTAssertEqual(name(contact: "张三", number: "2025550103", sim: "工作卡"), "张三 → 工作卡")
        XCTAssertEqual(name(number: "2025550103", sim: "工作卡"), "2025550103 → 工作卡")
        XCTAssertEqual(name(sim: "工作卡"), "未知号码 → 工作卡")
        XCTAssertEqual(name(contact: " ", number: "", sim: "工作卡"), "未知号码 → 工作卡")
        XCTAssertEqual(name(contact: "张三", isInternal: true, peer: "联通186", sim: "工作卡"), "联通186（内部）→ 工作卡")
    }

    func testWithoutSimLabelKeepsLegacyName() {
        XCTAssertEqual(name(contact: "张三", number: "2025550103"), "张三")
        XCTAssertNil(name(number: "2025550103"))
        XCTAssertNil(name(number: "2025550103", sim: "  "))
        XCTAssertEqual(name(isInternal: true, peer: "联通186"), "联通186（内部）")
        XCTAssertEqual(name(isInternal: true), "内部来电（内部）")
    }

    func testPushPayloadDecodesSimLabel() throws {
        let id = UUID().uuidString
        let push = try XCTUnwrap(PushCallPayload([
            "version": 1, "event": "call.incoming", "callId": id, "remoteNumber": "2025550103",
            "simLabel": " 工作卡 ",
        ]))
        XCTAssertEqual(push.simLabel, "工作卡")
        XCTAssertEqual(push.callerDisplayName, "2025550103 → 工作卡")

        let legacy = try XCTUnwrap(PushCallPayload([
            "version": 1, "event": "call.incoming", "callId": id, "remoteNumber": "2025550103",
        ]))
        XCTAssertNil(legacy.simLabel)
        XCTAssertNil(legacy.callerDisplayName)
    }

    func testCallRecordDecodesSimLabel() throws {
        let call = try JSONDecoder().decode(
            CallRecord.self, from: Data(#"{"id":"c1","remoteNumber":"2025550103","simLabel":"工作卡"}"#.utf8)
        )
        XCTAssertEqual(call.simLabel, "工作卡")
        let legacy = try JSONDecoder().decode(CallRecord.self, from: Data(#"{"id":"c1"}"#.utf8))
        XCTAssertNil(legacy.simLabel)
    }
}
