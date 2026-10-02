import XCTest

/// Read-only walkthrough on a signed-in device: visits every tab and a few detail screens, attaching a
/// screenshot and the accessibility tree of each for review. Never dials, sends or deletes.
/// Runs only with VODOG_DEVICE_WALKTHROUGH=1 (xcodebuild: TEST_RUNNER_VODOG_DEVICE_WALKTHROUGH=1).
final class DeviceWalkthroughUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = true
        try XCTSkipIf(ProcessInfo.processInfo.environment["VODOG_DEVICE_WALKTHROUGH"] != "1", "device walkthrough only")
    }

    @MainActor func testWalkthroughDefaultText() { walk(prefix: "std", largeText: false) }
    @MainActor func testWalkthroughLargeText() { walk(prefix: "ax", largeText: true) }

    /// Opens the first SMS thread repeatedly without any pull, recording whether a refresh spinner shows.
    @MainActor func testThreadOpenShowsNoRefreshWithoutPull() { threadOpenRounds(largeText: false) }
    @MainActor func testThreadOpenShowsNoRefreshWithoutPullLargeText() { threadOpenRounds(largeText: true) }
    @MainActor func testThreadOpenAfterScrollingShowsNoRefresh() { threadOpenRounds(largeText: false, scrollFirst: true) }

    @MainActor private func threadOpenRounds(largeText: Bool, scrollFirst: Bool = false) {
        let app = XCUIApplication()
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"] }
        app.launch()
        guard app.tabBars.firstMatch.waitForExistence(timeout: 15) else { return }
        tab("短信", app)
        for round in 1...4 {
            if scrollFirst { app.swipeUp(); app.swipeUp(); sleep(2) }
            guard openFirstRow(app) else { break }
            sleep(1)
            let refreshing = app.otherElements["Refreshing content"].exists
            NSLog("S90 thread-open round %d refreshing=%d", round, refreshing ? 1 : 0)
            capture(app, "open-\(round)")
            XCTAssertFalse(refreshing, "refresh spinner on plain thread open, round \(round)")
            back(app); sleep(2)
        }
    }

    @MainActor
    private func walk(prefix: String, largeText: Bool) {
        let app = XCUIApplication()
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"] }
        app.launch()
        guard app.tabBars.firstMatch.waitForExistence(timeout: 15) else { capture(app, "\(prefix)-00-not-signed-in"); return }

        tab("通话", app); capture(app, "\(prefix)-10-calls")

        tab("短信", app); capture(app, "\(prefix)-20-sms-list")
        app.swipeUp(); app.swipeUp(); sleep(2); capture(app, "\(prefix)-21-sms-list-scrolled")  // let momentum stop before the tap
        // No swipeDown back to the top: at the top it is a pull-to-refresh, whose spinner then shows in the thread.
        if openFirstRow(app) {
            capture(app, "\(prefix)-22-sms-thread")
            app.swipeDown(); capture(app, "\(prefix)-23-sms-thread-older")
            let bubble = app.staticTexts.allElementsBoundByIndex.last { $0.isHittable && $0.label.count > 30 }
            if let bubble {
                bubble.press(forDuration: 1.0); sleep(1); capture(app, "\(prefix)-24-sms-bubble-menu")
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap(); sleep(1)
            }
            back(app)
        }

        tab("记录", app); capture(app, "\(prefix)-30-records")
        let record = app.buttons["records.callDetail"].firstMatch
        if record.waitForExistence(timeout: 5) { record.tap(); sleep(3); capture(app, "\(prefix)-31-record-detail"); app.swipeUp(); capture(app, "\(prefix)-32-record-detail-scrolled"); back(app) }

        tab("通讯录", app); capture(app, "\(prefix)-40-contacts")
        if openFirstRow(app) { capture(app, "\(prefix)-41-contact-detail"); back(app) }

        tab("设置", app); capture(app, "\(prefix)-50-settings")
        app.swipeUp(); capture(app, "\(prefix)-51-settings-scrolled")
        app.swipeUp(); capture(app, "\(prefix)-52-settings-bottom")
    }

    @MainActor private func tab(_ label: String, _ app: XCUIApplication) {
        let button = app.tabBars.buttons[label]
        if button.waitForExistence(timeout: 5) { button.tap() }
        sleep(3)
    }

    /// Taps the first list row below the navigation bar; returns whether the screen changed.
    @MainActor private func openFirstRow(_ app: XCUIApplication) -> Bool {
        let before = app.navigationBars.firstMatch.identifier
        let candidates = app.cells.allElementsBoundByIndex.filter { $0.isHittable && $0.frame.minY > 330 }
        guard let row = candidates.first else { return false }
        row.tap(); sleep(3)
        return app.navigationBars.firstMatch.identifier != before || app.navigationBars.buttons.count > 0
    }

    @MainActor private func back(_ app: XCUIApplication) {
        let backButton = app.buttons["BackButton"].firstMatch
        if backButton.exists { backButton.tap(); sleep(2) }
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-tree"; tree.lifetime = .keepAlways; add(tree)
    }
}
