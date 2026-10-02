import XCTest

final class ExpandedUIUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testPhoneKeypadDismissalAndReadOnlyMessages() throws {
        let app = configuredApplication()
        app.launch()
        ensureLoggedIn(app)

        selectTab("电话", in: app)
        XCTAssertTrue(app.navigationBars["电话"].waitForExistence(timeout: 8))
        let two = app.buttons["2，ABC"]
        XCTAssertTrue(two.waitForExistence(timeout: 8), "The native dial pad is missing")
        two.tap()
        XCTAssertTrue(app.staticTexts["2"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["删除一位"].isEnabled)
        app.staticTexts["最近通话"].tap()
        XCTAssertFalse(two.waitForExistence(timeout: 2), "Tapping blank content did not dismiss the dial pad")
        app.buttons["拨号号码"].tap()
        XCTAssertTrue(two.waitForExistence(timeout: 3))
        attachScreenshot(app, name: "expanded-phone-keypad")

        selectTab("短信", in: app)
        XCTAssertTrue(app.navigationBars["短信"].waitForExistence(timeout: 8))
        let recipient = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "0101")).firstMatch
        XCTAssertTrue(recipient.waitForExistence(timeout: 20), "The authorized real SMS conversation is missing")
        XCTAssertTrue(app.staticTexts["CC OK"].waitForExistence(timeout: 8))
        recipient.tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["发送回复"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["查看号码和设备完整标识"].exists)
        attachScreenshot(app, name: "expanded-message-conversation")
    }

    /// S31 D/E: a fresh Records stack must not inherit the Messages stack, while returning to a detail that the
    /// user opened in Records is normal per-tab navigation preservation. The test never sends or deletes data.
    @MainActor
    func testMessageAndRecordsNavigationStacksStayIndependent() throws {
        // No credential injection and no login fallback: this test may only use a session already retained by
        // the simulator. If that prerequisite is absent, skipping is safer than changing the user's auth state.
        let app = XCUIApplication()
        app.launch()
        guard app.tabBars.firstMatch.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the simulator's retained authenticated session")
        }

        selectTab("短信", in: app)
        XCTAssertTrue(app.navigationBars["短信"].waitForExistence(timeout: 8))
        let conversation = app.buttons["messages.conversation"].firstMatch
        XCTAssertTrue(conversation.waitForExistence(timeout: 20), "A read-only conversation is required")
        conversation.tap()
        XCTAssertTrue(app.buttons["发送回复"].waitForExistence(timeout: 5))

        let reply = app.textFields["短信"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertTrue(reply.isEnabled, "An online assigned conversation is required for the keyboard case")
        reply.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        // On iOS 27 the software keyboard covers the tab bar (both occupy y=791...874 in the captured AX tree),
        // so a tab tap while it is open cannot reach the app. Dismiss it through the app-wide recogniser first,
        // then exercise the actual reachable Messages → Records transition.
        app.navigationBars.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let replyKeyboardDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: keyboard
        )
        XCTAssertEqual(XCTWaiter.wait(for: [replyKeyboardDismissed], timeout: 3), .completed)

        for _ in 0..<3 {
            selectTab("记录", in: app)
            XCTAssertTrue(app.navigationBars["记录"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.navigationBars["通话详情"].exists, "Messages navigation leaked into a fresh Records stack")
            selectTab("短信", in: app)
            XCTAssertTrue(app.buttons["发送回复"].waitForExistence(timeout: 5))
        }

        // Enter selection explicitly before tapping the link-bearing bubble. This bypasses the URL preview's own
        // long press and is the reliable S30 fallback. Cancelling the confirmation sends no destructive request.
        let stableMessage = app.descendants(matching: .any)["conversation.messageBubble"].firstMatch
        XCTAssertTrue(stableMessage.waitForExistence(timeout: 8))
        app.buttons["conversation.selectMode"].tap()
        XCTAssertTrue(app.staticTexts["已选 0 条"].waitForExistence(timeout: 5))
        stableMessage.tap()
        XCTAssertTrue(app.staticTexts["已选 1 条"].waitForExistence(timeout: 5))
        let deleteSelected = app.buttons["conversation.deleteSelected"]
        XCTAssertTrue(deleteSelected.isEnabled)
        deleteSelected.tap()
        let destructiveConfirmation = app.buttons["删除"]
        XCTAssertTrue(destructiveConfirmation.waitForExistence(timeout: 5))
        app.navigationBars.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let confirmationDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: destructiveConfirmation
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [confirmationDismissed], timeout: 2), .completed,
            "Tapping outside the iOS 27 confirmation popover did not cancel it"
        )
        XCTAssertTrue(stableMessage.exists)
        XCTAssertTrue(app.staticTexts["已选 1 条"].exists)
        app.buttons["conversation.cancelSelect"].tap()
        XCTAssertTrue(app.buttons["conversation.selectMode"].waitForExistence(timeout: 5))

        selectTab("记录", in: app)
        let firstCall = app.buttons["records.callDetail"].firstMatch
        XCTAssertTrue(firstCall.waitForExistence(timeout: 20), "A call row is required to verify expected detail retention")
        firstCall.tap()
        XCTAssertTrue(app.navigationBars["通话详情"].waitForExistence(timeout: 8))
        selectTab("短信", in: app)
        XCTAssertTrue(app.buttons["发送回复"].waitForExistence(timeout: 5))
        selectTab("记录", in: app)
        XCTAssertTrue(
            app.navigationBars["通话详情"].waitForExistence(timeout: 5),
            "A detail opened by the user should remain on its own tab's stack"
        )
    }

    /// S31 E: force only the login presentation in a Debug test process. This leaves the saved token and the
    /// authenticated app instance untouched, so the test can safely prove the window-level keyboard behaviour.
    @MainActor
    func testIsolatedLoginBackgroundTapDismissesKeyboard() throws {
        let app = XCUIApplication()
        app.launchEnvironment["VODOG_UI_TEST_LOGIN_ONLY"] = "1"
        app.launchEnvironment["VODOG_UI_TEST_USERNAME"] = "s31-keyboard-fixture"
        app.launchEnvironment["VODOG_UI_TEST_PASSWORD"] = "not-used"
        app.launch()

        let username = app.textFields["用户名"]
        XCTAssertTrue(username.waitForExistence(timeout: 10))
        username.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        app.staticTexts["VoDog"].tap()
        let dismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: keyboard
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [dismissed], timeout: 3), .completed,
            "Login background tap kept the keyboard open"
        )
    }

    @MainActor
    func testUIReferenceScreensReadOnly() throws {
        let loginApp = XCUIApplication()
        loginApp.launchEnvironment["VODOG_UI_TEST_LOGIN_ONLY"] = "1"
        loginApp.launch()
        XCTAssertTrue(loginApp.textFields["用户名"].waitForExistence(timeout: 10))
        attachScreenshot(loginApp, name: "reference-01-login")
        loginApp.terminate()

        let app = configuredApplication()
        app.launch()
        ensureLoggedIn(app)

        selectTab("电话", in: app)
        XCTAssertTrue(app.navigationBars["电话"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["2，ABC"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["SIM 1"].firstMatch.waitForExistence(timeout: 15))
        attachScreenshot(app, name: "reference-02-phone-dialer")

        selectTab("短信", in: app)
        XCTAssertTrue(app.navigationBars["短信"].waitForExistence(timeout: 8))
        let recipient = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "0101")).firstMatch
        XCTAssertTrue(recipient.waitForExistence(timeout: 20), "The authorized read-only conversation is missing")
        attachScreenshot(app, name: "reference-03-message-list")
        persistPrivateScreenshot(app, name: "03-message-list")
        recipient.tap()
        XCTAssertTrue(app.staticTexts["CC OK"].waitForExistence(timeout: 8))
        attachScreenshot(app, name: "reference-04-message-conversation")
        persistPrivateScreenshot(app, name: "04-message-conversation")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["新短信"].waitForExistence(timeout: 5))
        app.buttons["新短信"].tap()
        XCTAssertTrue(app.textFields["电话号码"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["发送"].waitForExistence(timeout: 5))
        attachScreenshot(app, name: "reference-05-new-message")
        persistPrivateScreenshot(app, name: "05-new-message")
        app.buttons["取消"].tap()

        selectTab("记录", in: app)
        XCTAssertTrue(app.navigationBars["记录"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["7天"].waitForExistence(timeout: 8))
        let reportFinished = NSPredicate { _, _ in
            !app.staticTexts["正在读取报告…"].exists
        }
        expectation(for: reportFinished, evaluatedWith: app)
        waitForExpectations(timeout: 20)
        attachScreenshot(app, name: "reference-06-records")
        persistPrivateScreenshot(app, name: "06-records")

        selectTab("设置", in: app)
        XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["SIM 与接听模式"].waitForExistence(timeout: 8))
        attachScreenshot(app, name: "reference-07-settings")
        persistPrivateScreenshot(app, name: "07-settings")
        let sim = app.staticTexts["SIM 1"].firstMatch
        XCTAssertTrue(sim.waitForExistence(timeout: 8))
        sim.tap()
        XCTAssertTrue(app.staticTexts["应用状态"].waitForExistence(timeout: 8))
        attachScreenshot(app, name: "reference-08-sim-settings")
        persistPrivateScreenshot(app, name: "08-sim-settings")
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
        // XCUI can report {-1, -1} as the semantic tab button's hit point while the software keyboard is up.
        // A coordinate anchored to the same element still targets its visible frame and matches the established
        // retained-session harness in VoDogUITests.
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    @MainActor
    private func attachScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func decodedEnvironmentValue(_ key: String) -> String {
        guard var encoded = ProcessInfo.processInfo.environment[key] else { return "" }
        encoded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded), let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }

    @MainActor
    private func persistPrivateScreenshot(_ app: XCUIApplication, name: String) {
        let directory = workspaceRoot.appendingPathComponent("delivery/private/ui-reference/current-stable", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent("\(name).png")
        try? app.screenshot().pngRepresentation.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private var workspaceRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }
}
