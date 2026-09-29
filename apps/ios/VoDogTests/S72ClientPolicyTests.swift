import XCTest
@testable import VoDog

/// S72：内部通话（同一 owner 的托管卡互打）、忙线未接、网关本机接听、占用条统一文案与两个新 409。
final class S72ClientPolicyTests: XCTestCase {

    private func decodeCall(_ json: String) throws -> CallRecord {
        try JSONDecoder().decode(CallRecord.self, from: Data(json.utf8))
    }

    private let zone = TimeZone(identifier: "Asia/Shanghai")!

    func testCallDecodesS72FieldsAndLegacyRowsAlike() throws {
        let call = try decodeCall(#"""
        {"id":"c1","simId":"s1","direction":"incoming","state":"ended","internal":true,
         "peerSimId":"s2","peerSimLabel":"联通186"}
        """#)
        XCTAssertTrue(call.isInternal)
        XCTAssertEqual(call.peerSimId, "s2")
        XCTAssertEqual(call.peerSimLabel, "联通186")

        let legacy = try decodeCall(#"{"id":"c2","direction":"incoming","state":"ended"}"#)
        XCTAssertFalse(legacy.isInternal)
        XCTAssertNil(legacy.peerSimLabel)
        XCTAssertNil(legacy.internalTitle(in: []))
    }

    func testInternalTitleFollowsTheLegDirection() {
        XCTAssertEqual(
            InternalCallTitle.text(direction: "incoming", thisSimLabel: "电信133", peerSimLabel: "联通186"),
            "内部通话 联通186 → 电信133"
        )
        XCTAssertEqual(
            InternalCallTitle.text(direction: "outgoing", thisSimLabel: "联通186", peerSimLabel: "电信133"),
            "内部通话 联通186 → 电信133"
        )
        XCTAssertEqual(
            InternalCallTitle.text(direction: "incoming", thisSimLabel: " ", peerSimLabel: nil),
            "内部通话 另一张卡 → 本卡"
        )
    }

    func testInternalLegIsNeverMissedNorUnseen() throws {
        let call = try decodeCall(#"""
        {"id":"c1","direction":"incoming","state":"ended","internal":true,"peerSimLabel":"联通186","unseen":true}
        """#)
        XCTAssertFalse(call.isMissedIncoming)
        XCTAssertEqual(call.rowStateTitle, "已结束")
        XCTAssertNil(call.shownContactName)
        XCTAssertFalse(UnreadDotPolicy.callUnseen(call, locallySeen: []))
        XCTAssertEqual(
            CallAnswerMethod.resolve(answerMode: nil, answeredByPlatform: nil, answeredAt: nil, isInternal: true),
            .notConnected
        )
    }

    func testBusyAutoRejectedReadsAsBusyMissed() throws {
        let call = try decodeCall(#"""
        {"id":"c1","direction":"incoming","state":"failed","failureReason":"busy_auto_rejected"}
        """#)
        XCTAssertEqual(call.rowStateTitle, "忙线未接")
        let plain = try decodeCall(#"{"id":"c2","direction":"incoming","state":"ended"}"#)
        XCTAssertEqual(plain.rowStateTitle, "未接来电")
        XCTAssertEqual(
            CallAnswerMethod.resolve(
                answerMode: "normal", answeredByPlatform: nil, answeredAt: nil, failureReason: "busy_auto_rejected"
            ).title,
            "忙线未接"
        )
        XCTAssertEqual(CallAnswerMethod.resolve(answerMode: nil, answeredByPlatform: nil, answeredAt: nil), .missed)
    }

    func testDevicePlatformReadsAsGatewayItself() throws {
        XCTAssertEqual(callPlatformTitle("device"), "网关本机")
        let call = try decodeCall(#"{"id":"c1","state":"active","answeredByPlatform":"device"}"#)
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(call), "网关本机")
        XCTAssertEqual(callOwnerTitle(call), "网关本机")
    }

    func testOccupancyStripUnifiedWording() throws {
        let call = try decodeCall(#"""
        {"id":"c1","direction":"incoming","state":"active","startedAt":"2026-09-11T12:00:00.000Z",
         "occupancy":{"holdsLock":true,"lockedSince":"2026-09-11T12:34:00.000Z","occupantPlatform":"android"}}
        """#)
        XCTAssertEqual(
            SIMOccupancyDisplayPolicy.summary(call, timeZone: zone),
            "通话中 · 由 Android 端 接听 · 自 2026-09-11 20:34"
        )
        let internalCall = try decodeCall(#"""
        {"id":"c2","direction":"incoming","state":"active","internal":true,"peerSimLabel":"联通186",
         "occupancy":{"holdsLock":true,"occupantPlatform":"ios"}}
        """#)
        XCTAssertEqual(
            SIMOccupancyDisplayPolicy.summary(internalCall, timeZone: zone, simLabel: "电信133"),
            "内部通话 · 联通186 → 电信133 · 由 iPhone 端 接听"
        )
    }

    func testReportItemDecodesS72FieldsAndLegacyRowsAlike() throws {
        let json = #"{"window":{"timeZone":"Asia/Shanghai","fromInclusive":"2026-09-25T16:00:00Z","toExclusive":"2026-09-26T16:00:00Z"},"items":[{"callId":"c1","startedAt":"2026-09-26T01:00:00Z","direction":"incoming","sim":{"id":"s1","label":"电信133","slotIndex":0},"internal":true,"peerSimLabel":"联通186","unseen":true},{"callId":"c2","startedAt":"2026-09-26T01:00:00Z","direction":"incoming","remoteNumber":"10010","sim":{"id":"s1","label":"电信133","slotIndex":0},"failureReason":"busy_auto_rejected"},{"callId":"c3","startedAt":"2026-09-26T01:00:00Z","sim":{"id":"s1","label":"电信133","slotIndex":0}}]}"#
        let items = try JSONDecoder().decode(CallReportEnvelope.self, from: Data(json.utf8)).items
        XCTAssertEqual(items[0].titleText, "内部通话 联通186 → 电信133")
        XCTAssertEqual(items[0].answerMethod, .notConnected)
        XCTAssertFalse(UnreadDotPolicy.reportUnseen(items[0], locallySeen: []))
        XCTAssertEqual(items[1].answerMethod.title, "忙线未接")
        XCTAssertFalse(items[2].isInternal)
        XCTAssertNil(items[2].failureReason)
        XCTAssertEqual(items[2].answerMethod, .missed)
    }

    func testPushPayloadInternalCallerName() throws {
        let id = UUID().uuidString
        let internalPush = try XCTUnwrap(PushCallPayload([
            "version": 1, "event": "call.incoming", "callId": id, "remoteNumber": "2025550105",
            "internal": true, "peerSimLabel": "联通186",
        ]))
        XCTAssertTrue(internalPush.isInternal)
        XCTAssertEqual(internalPush.callerDisplayName, "联通186（内部）")

        let plain = try XCTUnwrap(PushCallPayload([
            "version": 1, "event": "call.incoming", "callId": id, "contactName": "张三",
        ]))
        XCTAssertFalse(plain.isInternal)
        XCTAssertEqual(plain.callerDisplayName, "张三")
    }

    func testNewConflictCodesHaveFixedChineseMessages() {
        XCTAssertEqual(
            APIError.server(409, "same device", "SAME_DEVICE_INTERNAL").errorDescription,
            "同一设备上的两张卡不能互打"
        )
        XCTAssertEqual(
            APIError.server(409, "", "OWN_OUTGOING_CALL").errorDescription,
            "这是你正在拨出的通话"
        )
        XCTAssertEqual(APIError.server(409, "别的", "OTHER").errorDescription, "别的")
    }
}
