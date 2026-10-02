import XCTest
@testable import VoDog

/// S58「网关类型区分」：`gatewayKind` / `kind` 只换文字，缺失按 Pixel；线上的 `pixel` 语义值不变。
final class S58GatewayKindTests: XCTestCase {

    func testMappingDefaultsToPixel() {
        XCTAssertEqual(GatewayKind(nil), .pixel)
        XCTAssertEqual(GatewayKind("martian"), .pixel)
        XCTAssertEqual(GatewayKind("dji4g"), .dji4g)
    }

    func testSimShortLabelAndDecoding() throws {
        func sim(_ extra: String) throws -> SIMChannel {
            try JSONDecoder().decode(SIMChannel.self, from: Data(#"{"id":"s1","gatewayId":"0123456789abcdef"\#(extra)}"#.utf8))
        }
        XCTAssertEqual(simGatewayIdentity(try sim(""), shortened: true), "PX-01234567")
        XCTAssertEqual(simGatewayIdentity(try sim(#","gatewayKind":null"#), shortened: false), "PX-0123456789abcdef")
        XCTAssertEqual(simGatewayIdentity(try sim(#","gatewayKind":"dji4g""#), shortened: true), "DJI-01234567")
        // S91: a name wins; blank falls back to the id.
        XCTAssertEqual(simGatewayIdentity(try sim(#","gatewayName":"Pixel 7 Pro""#), shortened: true), "Pixel 7 Pro")
        XCTAssertEqual(simGatewayIdentity(try sim(#","gatewayName":"Pixel 7 Pro""#), shortened: false), "Pixel 7 Pro · PX-01234567")
        XCTAssertEqual(simGatewayIdentity(try sim(#","gatewayName":"  ""#), shortened: true), "PX-01234567")
    }

    func testCallWordingFollowsGatewayKind() throws {
        func call(_ kind: String) throws -> CallRecord {
            try JSONDecoder().decode(CallRecord.self, from: Data(#"""
            {"id":"c1","simId":"s1","state":"active","originatingPlatform":"pixel"\#(kind),
             "occupancy":{"holdsLock":true,"isCurrentSession":false,"canRelease":true}}
            """#.utf8))
        }
        let pixel = try call(""), dji = try call(#","gatewayKind":"dji4g""#)
        XCTAssertEqual(pixel.s38BadgeTitle, "通过手机拨打")
        XCTAssertEqual(dji.s38BadgeTitle, "通过 DJI 4G 模组拨打")
        XCTAssertEqual(callOwnerTitle(dji), "通过 DJI 4G 模组拨打")
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(pixel), "手机通话中")
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(dji), "DJI 4G 模组通话中")
        // 能力判断不看类型：设备直拨依旧不给远程结束。
        XCTAssertFalse(SIMOccupancyDisplayPolicy.canRelease(dji))
    }

    func testRecordingSourceTitleKeepsWireValue() {
        XCTAssertEqual(RecordingSource.pixel.rawValue, "pixel")
        XCTAssertEqual(RecordingSource.pixel.title(), "Pixel 原始归档")
        XCTAssertEqual(RecordingSource.pixel.title(gatewayKind: "dji4g"), "DJI 4G 原始归档")
        XCTAssertEqual(RecordingSource.mediaNode.title(gatewayKind: "dji4g"), "服务器录音")
        let disabled = recordingErrorPresentation(APIError.server(503, "", nil), source: .pixel, gatewayKind: "dji4g")
        XCTAssertTrue(disabled.message.hasPrefix("DJI 4G 原始归档尚未开启"))
    }

    func testReportItemCarriesGatewayKindIntoTheRecordingSheet() throws {
        func report(_ extra: String) throws -> CallReportItem {
            try JSONDecoder().decode(CallReportItem.self, from: Data(#"""
            {"callId":"c1","startedAt":"t","sim":{"id":"s1","label":"SIM","slotIndex":0},"originatingPlatform":"pixel"\#(extra)}
            """#.utf8))
        }
        XCTAssertNil(try report("").gatewayKind)
        let dji = try report(#","gatewayKind":"dji4g""#)
        let sheet = RecordsView.RecordSheet(callID: dji.callId, kind: .recording, timeZone: nil,
                                            originatingPlatform: dji.originatingPlatform, gatewayKind: dji.gatewayKind)
        XCTAssertEqual(sheet.gatewayKind, "dji4g")
        XCTAssertEqual(RecordingSource.defaultSource(originatingPlatform: sheet.originatingPlatform).title(gatewayKind: sheet.gatewayKind),
                       "DJI 4G 原始归档")
    }

    func testGatewayPowerKind() throws {
        let item = try JSONDecoder().decode(
            GatewayPower.self, from: Data(#"{"gatewayId":"0123456789abcdef","kind":"dji4g"}"#.utf8)
        )
        XCTAssertEqual(GatewayPowerPolicy.displayName(item), "DJI-01234567")
        XCTAssertEqual(GatewayPowerPolicy.displayName(GatewayPower(gatewayId: "0123456789abcdef")), "PX-01234567")
    }

    func testDeviceDialledCallsOpenTheDeviceArchiveByDefault() throws {
        XCTAssertEqual(RecordingSource.defaultSource(originatingPlatform: "pixel"), .pixel)
        XCTAssertEqual(RecordingSource.defaultSource(originatingPlatform: "ios"), .mediaNode)
        XCTAssertEqual(RecordingSource.defaultSource(originatingPlatform: nil), .mediaNode)
        let report = try JSONDecoder().decode(CallReportItem.self, from: Data(#"""
        {"callId":"c1","startedAt":"t","sim":{"id":"s1","label":"SIM","slotIndex":0},"originatingPlatform":"pixel"}
        """#.utf8))
        XCTAssertEqual(RecordingSource.defaultSource(originatingPlatform: report.originatingPlatform), .pixel)
    }

    func testOwnerJoinedLocalDefaultsToDeviceArchiveAndRelabelsServerRecording() throws {
        XCTAssertEqual(RecordingSource.defaultSource(originatingPlatform: "ios", ownerJoinedLocal: true), .pixel)
        XCTAssertEqual(RecordingSource.defaultSource(originatingPlatform: "ios", ownerJoinedLocal: false), .mediaNode)
        XCTAssertEqual(RecordingSource.mediaNode.title(ownerJoinedLocal: true), "服务器录音（不含本机接入）")
        XCTAssertEqual(RecordingSource.pixel.title(ownerJoinedLocal: true), "Pixel 原始归档")
        let base = #"{"callId":"c1","startedAt":"t","sim":{"id":"s1","label":"SIM","slotIndex":0}"#
        XCTAssertFalse(try JSONDecoder().decode(CallReportItem.self, from: Data((base + "}").utf8)).ownerJoinedLocal)
        XCTAssertTrue(try JSONDecoder().decode(CallReportItem.self, from: Data((base + #","ownerJoinedLocal":true}"#).utf8)).ownerJoinedLocal)
        let call = try JSONDecoder().decode(CallRecord.self, from: Data(#"{"id":"c1","ownerJoinedLocal":true}"#.utf8))
        XCTAssertEqual(call.ownerJoinedLocal, true)
        XCTAssertNotEqual(try JSONDecoder().decode(CallRecord.self, from: Data(#"{"id":"c1"}"#.utf8)).ownerJoinedLocal, true)
    }
}
