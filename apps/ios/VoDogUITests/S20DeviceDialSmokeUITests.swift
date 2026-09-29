import XCTest

/// S20 device smoke: places one short outbound call to the carrier service line from the
/// acceptance account, waits for the in-call controls, then ends it. Runs only on a physical
/// device with injected credentials; it exists so the S20 Opus contract, the Web-parity relay
/// offer and the command doorbell can be observed on a real handset without touching it.
final class S20DeviceDialSmokeUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testDialServiceLineAndEnd() throws {
        let number = ProcessInfo.processInfo.environment["VODOG_SMOKE_DIAL_NUMBER"] ?? ""
        try XCTSkipIf(number.isEmpty, "VODOG_SMOKE_DIAL_NUMBER must be injected at runtime")
        let app = configuredApplication()
        app.launch()
        ensureLoggedIn(app)

        selectTab("通话", in: app)
        XCTAssertTrue(app.navigationBars["电话"].waitForExistence(timeout: 8))
        let onlineSIM = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "在线")).firstMatch
        XCTAssertTrue(onlineSIM.waitForExistence(timeout: 20), "No online SIM in the strip")
        let firstKey = app.buttons[keypadLabel(number.first!)]
        XCTAssertTrue(firstKey.waitForExistence(timeout: 8), "The native dial pad is missing")
        for digit in number { app.buttons[keypadLabel(digit)].tap() }
        attachScreenshot(app, name: "s20-dialed-number")

        let dial = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "拨打")).firstMatch
        XCTAssertTrue(dial.waitForExistence(timeout: 5), "Dial button missing")
        XCTAssertTrue(dial.isEnabled, "Dial button disabled: gateway busy or SIM offline")
        let dialedAt = Date()
        dial.tap()

        let end = app.buttons["结束这通通话"].exists ? app.buttons["结束这通通话"] : app.buttons["结束通话"].firstMatch
        XCTAssertTrue(end.waitForExistence(timeout: 20), "In-call controls did not appear")
        NSLog("S20 smoke: in-call controls after %.1f s", Date().timeIntervalSince(dialedAt))
        attachScreenshot(app, name: "s20-in-call")
        sleep(25)
        attachScreenshot(app, name: "s20-in-call-25s")
        end.tap()
        if app.buttons["结束通话"].waitForExistence(timeout: 2) { app.buttons["结束通话"].firstMatch.tap() }
        XCTAssertTrue(app.buttons[keypadLabel("2")].waitForExistence(timeout: 30), "Dial pad did not return after ending")
        attachScreenshot(app, name: "s20-after-end")
    }

    private func keypadLabel(_ digit: Character) -> String {
        switch digit {
        case "2": return "2，ABC"
        case "3": return "3，DEF"
        case "4": return "4，GHI"
        case "5": return "5，JKL"
        case "6": return "6，MNO"
        case "7": return "7，PQRS"
        case "8": return "8，TUV"
        case "9": return "9，WXYZ"
        case "0": return "0，+"
        default: return String(digit)
        }
    }

    @MainActor
    private func ensureLoggedIn(_ app: XCUIApplication) {
        if app.tabBars.firstMatch.waitForExistence(timeout: 4) { return }
        XCTAssertTrue(app.textFields["用户名"].waitForExistence(timeout: 10))
        XCTAssertFalse(decodedEnvironmentValue("TEST_USERNAME_B64").isEmpty)
        XCTAssertFalse(decodedEnvironmentValue("TEST_PASSWORD_B64").isEmpty)
        let login = app.buttons["登录"]
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: login)
        waitForExpectations(timeout: 10)
        login.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 25), "Password login did not reach the main tabs")
    }

    @MainActor
    private func configuredApplication() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["VODOG_UI_TEST_USERNAME"] = decodedEnvironmentValue("TEST_USERNAME_B64")
        app.launchEnvironment["VODOG_UI_TEST_PASSWORD"] = decodedEnvironmentValue("TEST_PASSWORD_B64")
        return app
    }

    @MainActor
    private func selectTab(_ label: String, in app: XCUIApplication) {
        let button = app.tabBars.buttons[label]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
    }

    @MainActor
    private func attachScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func decodedEnvironmentValue(_ key: String) -> String {
        guard let raw = ProcessInfo.processInfo.environment[key], let data = Data(base64Encoded: raw) else { return "" }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
