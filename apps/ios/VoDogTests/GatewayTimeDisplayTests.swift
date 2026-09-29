import XCTest
@testable import VoDog

final class GatewayTimeDisplayTests: XCTestCase {
    func testShanghaiMidnightIndependentOfProcessTimeZone() {
        let zone = GatewayTimeDisplay.resolvedTimeZone(callZone: "Asia/Shanghai")
        XCTAssertEqual(zone.identifier, "Asia/Shanghai")
        XCTAssertEqual(
            GatewayTimeDisplay.compact("2026-09-10T16:00:00Z", timeZone: zone),
            "2026-09-11 00:00"
        )
        XCTAssertEqual(
            GatewayTimeDisplay.compact("2026-09-10T16:00:00.000Z", timeZone: zone),
            "2026-09-11 00:00"
        )
    }

    func testFallbackIsShanghaiNeverBeijing() {
        XCTAssertEqual(GatewayTimeDisplay.fallbackIANA, "Asia/Shanghai")
        XCTAssertNil(TimeZone(identifier: "Asia/Beijing"))
        XCTAssertEqual(
            GatewayTimeDisplay.resolvedTimeZone(callZone: nil, simZone: nil).identifier,
            "Asia/Shanghai"
        )
        XCTAssertEqual(
            GatewayTimeDisplay.resolvedTimeZone(callZone: "Not/AZone", simZone: nil).identifier,
            "Asia/Shanghai"
        )
    }

    func testCallZoneWinsOverLiveSimZone() {
        let zone = GatewayTimeDisplay.resolvedTimeZone(callZone: "Asia/Tokyo", simZone: "Asia/Shanghai")
        XCTAssertEqual(zone.identifier, "Asia/Tokyo")
        XCTAssertEqual(
            GatewayTimeDisplay.compact("2026-09-10T16:00:00Z", timeZone: zone),
            "2026-09-11 01:00"
        )
    }

    func testTalkSecondsUsesAnsweredToEnded() {
        XCTAssertEqual(
            GatewayTimeDisplay.talkSeconds(
                answeredAt: "2026-09-10T16:00:00Z",
                endedAt: "2026-09-10T16:01:05Z"
            ),
            65
        )
        XCTAssertNil(GatewayTimeDisplay.talkSeconds(answeredAt: "2026-09-10T16:00:00Z", endedAt: nil))
        XCTAssertEqual(
            GatewayTimeDisplay.talkSeconds(
                answeredAt: "2026-09-10T16:01:00Z",
                endedAt: "2026-09-10T16:00:00Z"
            ),
            0
        )
    }
}
