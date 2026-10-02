import XCTest

final class VoDogUITests: XCTestCase {
    private var username: String {
        decodedEnvironmentValue("TEST_USERNAME_B64")
    }
    private var password: String {
        decodedEnvironmentValue("TEST_PASSWORD_B64")
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func test01PasswordLoginShowsFourAuthoritativeEmptyStates() throws {
        requireCredentials()
        let app = configuredApplication()
        app.launch()
        ensureLoggedOut(app)
        ensureLoggedIn(app)

        let tabs = app.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 20))

        selectTab("电话", in: app)
        XCTAssertTrue(app.navigationBars["电话"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["没有已分配的 SIM"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["拨打"].isEnabled)
        attachScreenshot(app, name: "calls-empty")

        selectTab("短信", in: app)
        XCTAssertTrue(app.navigationBars["短信"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["暂无短信"].waitForExistence(timeout: 10))
        attachScreenshot(app, name: "messages-empty")

        selectTab("记录", in: app)
        XCTAssertTrue(app.navigationBars["记录"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["暂无记录"].waitForExistence(timeout: 10))
        attachScreenshot(app, name: "records-empty")

        selectTab("设置", in: app)
        XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["没有已分配的 SIM"].waitForExistence(timeout: 10))
        attachScreenshot(app, name: "settings-empty")
    }

    @MainActor
    func test02PasskeyRegistrationPresentsAndCancelsSystemRequest() throws {
        requireCredentials()
        let app = configuredApplication()
        app.launch()
        ensureLoggedIn(app)
        selectTab("设置", in: app)
        XCTAssertTrue(app.buttons["passkey.register"].waitForExistence(timeout: 10))
        app.buttons["passkey.register"].tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(20)
        var cancel: XCUIElement?
        while Date() < deadline, cancel == nil {
            cancel = [springboard.buttons["取消"], springboard.buttons["Cancel"], app.buttons["取消"], app.buttons["Cancel"]]
                .first(where: \.exists)
            if app.staticTexts["passkey-status"].label.contains("无需重复创建") { return }
            if cancel == nil { RunLoop.current.run(until: Date().addingTimeInterval(0.25)) }
        }
        guard let cancel else {
            let error = app.staticTexts["passkey-error"]
            if error.exists { XCTFail("Passkey request failed before presentation: \(error.label)") }
            let status = app.staticTexts["passkey-status"]
            if status.exists { XCTFail("Authorization request was issued but no system sheet appeared: \(status.label)") }
            XCTFail("Passkey request produced neither a system sheet nor diagnostic state")
            return
        }
        cancel.tap()
        XCTAssertFalse(cancel.waitForExistence(timeout: 3))
    }

    @MainActor
    func test03PushTokensRegisterWithoutExposingValues() throws {
        requireCredentials()
        let app = configuredApplication()
        app.launch()
        ensureLoggedIn(app)
        selectTab("设置", in: app)
        let tokenStatus = app.descendants(matching: .any)["push-token-status"].firstMatch
        XCTAssertTrue(tokenStatus.waitForExistence(timeout: 20))
        XCTAssertTrue(tokenStatus.label.contains("系统推送令牌已获取"), tokenStatus.label)
        let registration = app.descendants(matching: .any)["push-server-status"].firstMatch
        XCTAssertTrue(registration.waitForExistence(timeout: 20))
        XCTAssertTrue(registration.label.contains("服务端推送注册：已就绪"), registration.label)
    }

    @MainActor
    func test04PasskeyLoginWaitsForUserSystemConfirmation() throws {
        requireCredentials()
        let app = configuredApplication()
        app.launch()
        ensureLoggedOut(app)
        XCTAssertTrue(app.buttons["使用 Passkey 登录"].waitForExistence(timeout: 10))
        app.buttons["使用 Passkey 登录"].tap()
        let error = app.staticTexts["passkey-error"]
        let status = app.staticTexts["passkey-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        if error.exists { XCTFail("Passkey login failed before system confirmation: \(error.label)"); return }
        print("PASSKEY_REQUEST_ISSUED_CAPTURE_SCREEN_NOW")
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 90), "Passkey login was not confirmed on the physical device")
    }

    @MainActor
    func test05SyntheticVoIPPushWasReportedAndReconciled() throws {
        let app = configuredApplication()
        app.launch()
        ensureLoggedIn(app)
        selectTab("设置", in: app)
        let status = app.staticTexts["push-incoming-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertEqual(status.label, "权威记录不存在或已结束，CallKit 已关闭")
    }

    @MainActor
    func test06RetainedSessionShowsRealSMSReadOnly() throws {
        let app = configuredApplication()
        app.launch()

        XCTAssertTrue(
            app.tabBars.firstMatch.waitForExistence(timeout: 15),
            "The retained physical-device session is not signed in"
        )
        selectTab("短信", in: app)
        XCTAssertTrue(app.navigationBars["短信"].waitForExistence(timeout: 5))

        let recipient = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "0101")
        ).firstMatch
        XCTAssertTrue(recipient.waitForExistence(timeout: 20), "The expected real SMS conversation was not returned")
        // S95: the thread row is one combined element; its spoken label carries line, direction and state.
        XCTAssertTrue(app.buttons.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@ AND label CONTAINS %@", "SIM 1", "发出", "已送达"
        )).firstMatch.waitForExistence(timeout: 5))

        let reply = app.staticTexts["CC OK"]
        if reply.waitForExistence(timeout: 8) {
            print("SMS_REPLY_VODOG_OK_PRESENT")
        } else {
            print("SMS_REPLY_VODOG_OK_NOT_PRESENT")
        }
        attachScreenshot(app, name: "real-sms-list-read-only")
    }

    @MainActor
    func test07RetainedSessionShowsTheThreeRecordTabsAndRealSMSReadOnly() throws {
        let app = configuredApplication()
        app.launch()

        XCTAssertTrue(
            app.tabBars.firstMatch.waitForExistence(timeout: 15),
            "The retained physical-device session is not signed in"
        )
        selectTab("记录", in: app)
        XCTAssertTrue(app.navigationBars["记录"].waitForExistence(timeout: 5))

        // S22 决策 10 / S95：记录页是 通话 / 转录报告 / 拦截 三段，报告段自带日期范围菜单与搜索栏。
        for segment in ["通话", "转录报告", "拦截"] {
            let control = app.segmentedControls["records.tab"].buttons[segment]
            XCTAssertTrue(control.waitForExistence(timeout: 5), "Missing records segment: \(segment)")
            control.tap()
            attachScreenshot(app, name: "records-tab-\(segment)")
        }
        app.segmentedControls["records.tab"].buttons["转录报告"].tap()
        XCTAssertTrue(
            app.otherElements["records.reportRange"].waitForExistence(timeout: 5)
                || app.buttons["records.reportRange"].waitForExistence(timeout: 5),
            "The report tab must offer the date-range control"
        )
        attachScreenshot(app, name: "records-report-range")

        selectTab("短信", in: app)
        XCTAssertTrue(app.navigationBars["短信"].waitForExistence(timeout: 5))
        let recipient = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "0101")
        ).firstMatch
        XCTAssertTrue(recipient.waitForExistence(timeout: 20), "The expected real SMS conversation was not returned")
        // S95: the thread row is one combined element; its spoken label carries line, direction and state.
        XCTAssertTrue(app.buttons.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@ AND label CONTAINS %@", "SIM 1", "发出", "已送达"
        )).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["CC OK"].waitForExistence(timeout: 8), "The real CC OK reply was not returned")
        attachScreenshot(app, name: "reports-candidate-real-sms-read-only")
    }

    @MainActor
    private func ensureLoggedOut(_ app: XCUIApplication) {
        guard app.tabBars.firstMatch.waitForExistence(timeout: 3) else { return }
        selectTab("设置", in: app)
        let logout = app.buttons["退出登录"]
        for _ in 0..<4 where !logout.exists { app.swipeUp() }
        XCTAssertTrue(logout.waitForExistence(timeout: 10))
        logout.tap()
        XCTAssertTrue(app.textFields["用户名"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func ensureLoggedIn(_ app: XCUIApplication) {
        if app.tabBars.firstMatch.waitForExistence(timeout: 3) { return }
        let usernameField = app.textFields["用户名"]
        XCTAssertTrue(usernameField.waitForExistence(timeout: 10))
        let passwordField = app.secureTextFields["密码"]
        XCTAssertTrue(passwordField.exists)
        app.buttons["登录"].tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20), "Password login did not reach the main tabs")
    }

    @MainActor
    private func attachScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func configuredApplication() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["VODOG_UI_TEST_USERNAME"] = username
        app.launchEnvironment["VODOG_UI_TEST_PASSWORD"] = password
        return app
    }

    private func requireCredentials() {
        XCTAssertFalse(username.isEmpty, "TEST_USERNAME_B64 must be injected at runtime")
        XCTAssertFalse(password.isEmpty, "TEST_PASSWORD_B64 must be injected at runtime")
    }

    @MainActor
    private func selectTab(_ label: String, in app: XCUIApplication) {
        let button = app.tabBars.buttons[label]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func decodedEnvironmentValue(_ key: String) -> String {
        guard var encoded = ProcessInfo.processInfo.environment[key] else { return "" }
        encoded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded),
              let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }
}
