import XCTest
@testable import VoDog

final class SIMStripDisplayPolicyTests: XCTestCase {
    private func sim(_ id: String, online: Bool? = nil, label: String? = nil,
                     phone: String? = nil, slot: Int? = nil, gateway: String? = nil,
                     mode: String? = nil) throws -> SIMChannel {
        var object: [String: Any] = ["id": id]
        if let mode { object["settings"] = ["mode": mode, "timeoutSeconds": 45, "version": 1, "appliedVersion": 1] }
        if let online { object["online"] = online }
        if let label { object["label"] = label }
        if let phone { object["phoneLabel"] = phone }
        if let slot { object["slotIndex"] = slot }
        if let gateway { object["gatewayId"] = gateway }
        return try JSONDecoder().decode(SIMChannel.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testOnlineFirstIsStableAndRetainsOriginalColorIndices() throws {
        let sims = [try sim("a", online: false), try sim("b", online: true), try sim("c"),
                    try sim("d", online: true), try sim("e", online: false)]
        let displayed = SIMStripDisplayPolicy.items(sims, networkAvailable: true)
        XCTAssertEqual(displayed.map(\.element.id), ["b", "d", "a", "c", "e"])
        XCTAssertEqual(displayed.map(\.offset), [1, 3, 0, 2, 4])
        XCTAssertEqual(sims.map(\.id), ["a", "b", "c", "d", "e"])
    }

    func testCallLineTitlePrefersNumberThenLabelAndAppendsGateway() throws {
        let sims = [try sim("a", label: "办公", phone: " +12025550101 ", gateway: "00000001-ffff"),
                    try sim("b", label: " 家里 ", phone: " "), try sim("c")]
        XCTAssertEqual(callLineTitle("a", in: sims), "+12025550101 · PX-00000001")
        XCTAssertEqual(callLineTitle("b", in: sims), "家里 · 设备待确认")
        XCTAssertEqual(callLineTitle("c", in: sims), "未命名号码 · 设备待确认")
        XCTAssertNil(callLineTitle("zzz", in: sims))
        XCTAssertNil(callLineTitle(nil, in: sims))
    }

    func testOfflineKeepsOriginalOrderIncludingCachedOnlineSIMs() throws {
        let sims = [try sim("a", online: false), try sim("b", online: true), try sim("c")]
        let displayed = SIMStripDisplayPolicy.items(sims, networkAvailable: false)
        XCTAssertEqual(displayed.map(\.element.id), sims.map(\.id))
        XCTAssertEqual(displayed.map(\.offset), [0, 1, 2])
    }

    func testEmptyOrPhoneOnlyLabelFallsBackToSlotWithoutDuplicatingNumber() throws {
        for label in [nil, "", " \n", " +12025550102 "] as [String?] {
            let item = try sim("a", label: label, phone: "+12025550102", slot: 1)
            XCTAssertEqual(SIMStripDisplayPolicy.title(item, originalIndex: 0), "SIM 2")
        }
        XCTAssertEqual(SIMStripDisplayPolicy.title(try sim("b"), originalIndex: 2), "SIM 3")
        XCTAssertEqual(SIMStripDisplayPolicy.title(try sim("c", label: " 办公号码 "), originalIndex: 0), "办公号码")
    }

    @MainActor
    func testAccessibilityKeepsFullIdentityAndDeviceOfflineOverridesOnlineSnapshot() throws {
        let item = try sim("a", online: true, label: "办公室与客户服务长名称",
                           phone: "+12025550102", gateway: "gateway-full-identity")
        let availability = UIAvailabilityState()
        availability.updatePath(available: true)
        availability.didRefreshSIMs([item])
        XCTAssertEqual(availability.simStatus(item), "在线")
        availability.updatePath(available: false)
        XCTAssertEqual(SIMStripDisplayPolicy.accessibilityLabel(item, originalIndex: 0, status: availability.simStatus(item)),
                       "办公室与客户服务长名称，+12025550102，设备 PX-gateway-full-identity，设备未联网")
    }

    func testAnswerModeBadgeMapsModesAndHidesWithoutSettings() throws {
        XCTAssertEqual(SIMStripDisplayPolicy.answerModeBadge(try sim("a", mode: "normal")), "人工")
        XCTAssertEqual(SIMStripDisplayPolicy.answerModeBadge(try sim("b", mode: "ai")), "AI")
        XCTAssertEqual(SIMStripDisplayPolicy.answerModeBadge(try sim("c", mode: "timeout_ai")), "AI")
        XCTAssertNil(SIMStripDisplayPolicy.answerModeBadge(try sim("d")))
        XCTAssertNil(SIMStripDisplayPolicy.answerModeBadge(try sim("e", mode: "unknown")))
    }

    func testSIMPaletteRanksBySlotThenIdAndNeverRepeats() throws {
        let sims = [try sim("b", slot: 0), try sim("z"), try sim("a", slot: 1), try sim("a0", slot: 0)]
        for list in [sims, sims.reversed()] {
            XCTAssertEqual(["a0", "b", "a", "z"].map { id in SIMPalette.index(of: list.first { $0.id == id }!, in: list) },
                           [0, 1, 2, 3])
        }
        XCTAssertEqual((0..<8).map { SIMPalette.hex(index: $0, dark: false) },
                       ["#2457C5", "#147D78", "#B45309", "#7C3AED", "#BE185D", "#4338CA", "#8A5A2B", "#0E7490"])
        XCTAssertEqual((0..<8).map { SIMPalette.hex(index: $0, dark: true) },
                       ["#66A8FF", "#63D3CC", "#FDBA74", "#C4B5FD", "#F9A8D4", "#A5B4FC", "#E0B48A", "#67E8F9"])
        for dark in [false, true] {
            let tail = (8..<40).map { SIMPalette.hex(index: $0, dark: dark) }
            XCTAssertEqual(Set(tail).count, tail.count)
            XCTAssertEqual(tail, (8..<40).map { SIMPalette.hex(index: $0, dark: dark) })
            XCTAssertTrue(tail.allSatisfy { $0.range(of: "^#[0-9A-F]{6}$", options: .regularExpression) != nil })
        }
        for index in 8..<64 {
            let contrast = ThemeContrast.ratio(SIMPalette.uiColor(hex: SIMPalette.hex(index: index, dark: false)), .white)
            XCTAssertGreaterThanOrEqual(contrast, 4.5, "index \(index)")
        }
    }
}
