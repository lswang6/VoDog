import Foundation
import XCTest

/// Real HTTP/UI acceptance against `infra/s33-fixture-server.mts`. Every test is inert unless the caller opts in
/// with the exact loopback URL, a private fixture key and private login credentials. The app itself receives no
/// fixture-control key; it can only use the public product API as an ordinary native client.
final class S33BusinessUITests: XCTestCase {
    private let expectedBaseURL = "http://127.0.0.1:16880/api/v1"
    private let expectedDatabase = "vodog_s33_ui_test"
    private let expectedServerFingerprint = "ca16f103d8de6e43406acde471934d6bd46a0a5fa57acff481c5dfcc14d44381"
    private var activeApp: XCUIApplication?
    private var activeColorSchemeName = "light"

    override func setUpWithError() throws {
        continueAfterFailure = false
        activeApp = nil
        activeColorSchemeName = "light"
    }

    override func tearDownWithError() throws {
        defer { activeApp = nil }
        guard (testRun?.totalFailureCount ?? 0) > 0, let activeApp else { return }
        let safeTestName = name.replacingOccurrences(
            of: "[^A-Za-z0-9_-]+", with: "-", options: .regularExpression
        )
        MainActor.assumeIsolated {
            Self.writeDebugSnapshot(activeApp, name: "s33-failure-\(safeTestName)")
        }
    }

    @MainActor
    func test01AuthenticationContactCRUDAndConflictReload() async throws {
        let fixture = try await requireFixture(scenario: "contacts")
        let app = launchApp()
        ensureLoggedIn(app)
        attachScreenshot(app, name: "s33-01-authenticated-tabs")

        // The local session uses a separate keychain namespace. A normal restart must restore this local account.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15), "The isolated local session was not restored")

        selectTab("通讯录", in: app)
        XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["S33 测试联系人甲"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["S33 Owner2 Private"].exists, "Another account's contact leaked into owner1")

        let marker = "S33 iOS CRUD \(String(UUID().uuidString.prefix(8)))"
        app.buttons["contacts.new"].tap()
        XCTAssertTrue(app.navigationBars["新建联系人"].waitForExistence(timeout: 5))
        replaceText(app.textFields["显示名称"], with: marker)
        replaceText(app.textFields["名"], with: "iOS")
        replaceText(app.textFields["姓"], with: "S33")
        replaceText(app.textFields["公司"], with: "Fixture Create")
        replaceText(app.textFields["号码"], with: "2025550115")
        finishTextInput(in: app)
        let addEmail = app.buttons["添加邮箱"]
        reveal(addEmail, in: app)
        addEmail.tap()
        Self.writeDebugSnapshot(app, name: "s33-contact-after-add-email")
        let email = app.textFields["邮箱地址"]
        XCTAssertTrue(email.waitForExistence(timeout: 3), "Adding an email did not create its form row")
        reveal(email, in: app)
        replaceText(email, with: "ios-crud.s33@example.test")
        finishTextInput(in: app)
        let addAddress = app.buttons["添加地址"]
        reveal(addAddress, in: app)
        addAddress.tap()
        let address = app.textFields["contactEdit.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 3), "Adding an address did not create its form row")
        reveal(address, in: app)
        replaceText(address, with: "台北市 S33 iOS 路 88 号")
        finishTextInput(in: app)
        let notes = app.textFields["contactEdit.notes"]
        reveal(notes, in: app)
        replaceText(notes, with: "S33 iOS 完整字段")
        attachScreenshot(app, name: "s33-02-contact-complete-draft")
        app.buttons["contactEdit.save"].tap()
        XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts[marker].waitForExistence(timeout: 10))

        // Keep a stale draft on screen, mutate the same seeded contact through the simulated peer, and prove the
        // app refuses the stale save until the user explicitly loads the complete fresh snapshot.
        app.staticTexts["S33 测试联系人甲"].tap()
        XCTAssertTrue(app.navigationBars["联系人"].waitForExistence(timeout: 5))
        app.buttons["contactDetail.edit"].tap()
        XCTAssertTrue(app.navigationBars["编辑联系人"].waitForExistence(timeout: 5))
        let draftOrganization = "iOS 保留的旧草稿"
        replaceText(app.textFields["公司"], with: draftOrganization)
        _ = try await fixture.peer(
            action: "contact.update", id: fixture.state.ids.contacts.primary,
            payload: ["organization": "Web peer v4", "notes": "peer 完整快照"]
        )
        app.buttons["contactEdit.save"].tap()
        XCTAssertTrue(app.alerts["联系人已更新"].waitForExistence(timeout: 8))
        XCTAssertEqual(app.textFields["公司"].value as? String, draftOrganization, "Conflict overwrote the local draft")
        attachScreenshot(app, name: "s33-03-contact-cas-conflict")
        app.alerts["联系人已更新"].buttons["载入最新内容（替换当前草稿）"].tap()
        XCTAssertTrue(waitUntil(timeout: 10) { (app.textFields["公司"].value as? String) == "Web peer v4" })
        let refreshedNotes = app.textFields["contactEdit.notes"]
        reveal(refreshedNotes, in: app)
        XCTAssertEqual(refreshedNotes.value as? String, "peer 完整快照")
        app.buttons["取消"].tap()
        XCTAssertTrue(app.navigationBars["联系人"].waitForExistence(timeout: 5))
        app.navigationBars["联系人"].buttons.firstMatch.tap()

        // Delete only the contact created by this test; the seeded shared-CAS contact remains for later clients.
        let search = revealSearchField(in: app)
        replaceText(search, with: marker)
        XCTAssertTrue(app.staticTexts[marker].waitForExistence(timeout: 8))
        app.staticTexts[marker].tap()
        attachAppearanceScreenshots(app, name: "s33-contact-destructive-entry")
        app.buttons["contactDetail.delete"].tap()
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-contact-delete-confirmation-red")
        app.buttons["删除"].tap()
        XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 10))
        XCTAssertTrue(waitUntil(timeout: 3) { !app.staticTexts[marker].exists })
        attachScreenshot(app, name: "s33-contact-deleted")

        // End this isolated journey through the real logout UI. Later tests must authenticate again rather than
        // inheriting an unproved cached token from this case.
        selectTab("设置", in: app)
        let logout = app.buttons["退出登录"]
        reveal(logout, in: app, maxSwipes: 8)
        attachAppearanceScreenshots(app, name: "s33-logout-destructive-red")
        logout.tap()
        XCTAssertTrue(app.textFields["用户名"].waitForExistence(timeout: 10), "Logout did not return to authentication")
    }

    @MainActor
    func test02CallsReportsRecordingTranscriptsAndExternalDeletion() async throws {
        let fixture = try await requireFixture(scenario: "all")
        let app = launchApp()
        ensureLoggedIn(app)
        selectTab("记录", in: app)
        XCTAssertTrue(app.navigationBars["记录"].waitForExistence(timeout: 8))

        // 129 calls exceed the native 50-row page. Move to page two and back through the real pager before
        // narrowing to the recorded fixture call.
        // SwiftUI exposes the PagerBar container identifier on its children on this OS. Use the stable spoken
        // labels and scroll the real Records list until the pinned pager is mounted and hittable.
        let callsPage = app.buttons["跳转到指定页"]
        let callsNext = app.buttons["下一页"]
        revealPagerControl(callsNext, in: app)
        XCTAssertTrue((callsPage.value as? String)?.contains("第 1 /") == true)
        callsNext.tap()
        XCTAssertTrue(waitUntil(timeout: 12) { (callsPage.value as? String)?.contains("第 2 /") == true })
        XCTAssertTrue(app.buttons["records.callDetail"].firstMatch.waitForExistence(timeout: 8))
        attachScreenshot(app, name: "s33-calls-second-page")
        let callsPrevious = app.buttons["上一页"]
        revealPagerControl(callsPrevious, in: app)
        callsPrevious.tap()
        XCTAssertTrue(waitUntil(timeout: 12) { (callsPage.value as? String)?.contains("第 1 /") == true })

        // The recorded call proves detail, server transcript and generated loopback audio playback.
        replaceText(revealSearchField(in: app), with: "2025550111")
        let recorded = app.buttons["records.callDetail"].firstMatch
        XCTAssertTrue(recorded.waitForExistence(timeout: 12))
        recorded.tap()
        XCTAssertTrue(app.navigationBars["通话详情"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "S33 测试联系人甲"))
            .firstMatch.waitForExistence(timeout: 8))
        app.buttons["records.viewTranscript"].tap()
        XCTAssertTrue(app.navigationBars["转录"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["安排验收回访"].waitForExistence(timeout: 8))
        attachScreenshot(app, name: "s33-05-recorded-transcript")
        dismissSheet(named: "转录", in: app)
        app.buttons["records.viewRecording"].tap()
        XCTAssertTrue(app.navigationBars["录音"].waitForExistence(timeout: 8))
        Self.writeDebugSnapshot(app, name: "s33-recording-sheet-loaded")
        let mediaNodeSource = app.segmentedControls["records.recordingSource"].buttons["服务器录音"]
        XCTAssertTrue(mediaNodeSource.waitForExistence(timeout: 8))
        XCTAssertTrue(mediaNodeSource.isSelected, "Server recording source was not selected")
        let play = app.buttons["播放"].firstMatch
        XCTAssertTrue(play.waitForExistence(timeout: 8))
        play.tap()
        XCTAssertTrue(app.buttons["停止"].firstMatch.waitForExistence(timeout: 8), "Generated fixture audio did not enter playback")
        XCTAssertFalse(app.buttons["header.closeButton"].exists, "Playback also opened the system share sheet")
        attachScreenshot(app, name: "s33-06-recording-playing")
        app.buttons["停止"].firstMatch.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { play.exists && play.isHittable }, "Stop did not return the recording row to Play")
        XCTAssertFalse(app.buttons["header.closeButton"].exists, "Stopping playback left a system share sheet in front")
        let downloadBoth = app.buttons["下载对话 MP3"]
        XCTAssertTrue(downloadBoth.waitForExistence(timeout: 5), "The conversation MP3 download action was unavailable")
        downloadBoth.tap()
        let shareClose = app.buttons["header.closeButton"]
        XCTAssertTrue(shareClose.waitForExistence(timeout: 15), "The download action did not open the system share sheet")
        attachScreenshot(app, name: "s33-06b-recording-download-independent")
        shareClose.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { !shareClose.exists }, "The system share sheet did not close")
        dismissSheet(named: "录音", in: app)
        app.navigationBars["通话详情"].buttons.firstMatch.tap()

        // The second fixture call carries the live AI conversation and a successful report transcript.
        replaceText(revealSearchField(in: app), with: "+12025550102")
        XCTAssertTrue(app.buttons["records.callDetail"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["records.callDetail"].firstMatch.tap()
        let aiGreeting = app.staticTexts["您好，这里是 S33 模拟 AI 助理。"]
        XCTAssertTrue(aiGreeting.waitForExistence(timeout: 10))
        revealStaticEvidence(aiGreeting, in: app, maxSwipes: 10)
        _ = try await fixture.peer(
            action: "inject.failure",
            payload: [
                "method": "GET",
                "path": .string("/api/v1/calls/\(fixture.state.ids.calls.ai)/ai-transcript"),
                "status": 503,
                "code": "S33_TRANSCRIPT_REFRESH",
                "message": "S33 simulated transcript refresh failure",
                "count": 10,
            ]
        )
        let refreshError = app.descendants(matching: .any)["records.aiTranscriptRefreshError"]
        let refreshErrorText = app.staticTexts["AI 对话刷新失败"]
        revealStaticEvidence(refreshErrorText, in: app, maxSwipes: 10)
        XCTAssertTrue(refreshError.exists, "AI refresh error container was not exposed")
        attachScreenshot(app, name: "s33-07-ai-refresh-error")
        revealStaticEvidence(aiGreeting, in: app, maxSwipes: 10)
        XCTAssertTrue(aiGreeting.exists && staticEvidenceIsVisible(aiGreeting, in: app),
                      "A transient refresh failure discarded or hid the last successful AI transcript")
        attachScreenshot(app, name: "s33-07-ai-conversation")
        _ = try await fixture.peer(action: "clearFailures")
        XCTAssertTrue(waitUntil(timeout: 12) { !refreshError.exists }, "AI transcript refresh did not recover")
        revealStaticEvidence(aiGreeting, in: app, maxSwipes: 10)
        XCTAssertTrue(aiGreeting.exists && staticEvidenceIsVisible(aiGreeting, in: app),
                      "A successful refresh did not preserve the recovered transcript snapshot")
        app.navigationBars["通话详情"].buttons.firstMatch.tap()

        // Exercise every period offered by the native report contract, then capture the populated report.
        app.segmentedControls["records.tab"].buttons["转录报告"].tap()
        let reportRange = app.descendants(matching: .any)["records.reportRange"]
        for period in ["今天", "7 天", "30 天", "自定义"] {
            XCTAssertTrue(reportRange.waitForExistence(timeout: 5))
            reportRange.tap()
            let option = app.buttons[period]
            XCTAssertTrue(option.waitForExistence(timeout: 5), "Missing report period \(period)")
            option.tap()
            XCTAssertTrue(reportRange.waitForExistence(timeout: 5))
            XCTAssertTrue(app.staticTexts["安排验收回访"].waitForExistence(timeout: 10),
                          "Report \(period) did not render the seeded successful summary")
            XCTAssertTrue(app.staticTexts["明天下午回电"].waitForExistence(timeout: 10),
                          "Report \(period) did not render the seeded action item")
            XCTAssertTrue(app.buttons["records.reportTranscript"].firstMatch.exists,
                          "Report \(period) did not render its transcript action")
        }
        XCTAssertTrue(app.descendants(matching: .any)["records.reportFrom"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["records.reportTo"].exists)
        attachScreenshot(app, name: "s33-08-report-periods")
        app.staticTexts["安排验收回访"].tap()
        XCTAssertTrue(app.navigationBars["通话详情"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["安排验收回访"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["明天下午回电"].waitForExistence(timeout: 8))
        app.navigationBars["通话详情"].buttons.firstMatch.tap()

        // A detail that another client deletes must close its authoritative content and stop any media surface.
        app.segmentedControls["records.tab"].buttons["通话"].tap()
        replaceText(revealSearchField(in: app), with: "2025550111")
        XCTAssertTrue(app.buttons["records.callDetail"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["records.callDetail"].firstMatch.tap()
        _ = try await fixture.peer(action: "call.delete", id: fixture.state.ids.calls.recorded)
        XCTAssertTrue(app.alerts["通话记录已被删除"].waitForExistence(timeout: 12))
        attachScreenshot(app, name: "s33-09-call-deleted-elsewhere")
        app.alerts["通话记录已被删除"].buttons["返回记录"].tap()
        XCTAssertTrue(app.navigationBars["记录"].waitForExistence(timeout: 5))

        // All-SIM interception rows carry the server-resolved SIM and timezone for that individual event.
        app.segmentedControls["records.tab"].buttons["拦截"].tap()
        let unblock = app.buttons["blocklist.unblock"].firstMatch
        XCTAssertTrue(unblock.waitForExistence(timeout: 10))
        unblock.tap()
        let unblockConfirmation = app.staticTexts["解除屏蔽这个号码？"]
        XCTAssertTrue(unblockConfirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["解除屏蔽"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-unblock-confirmation-red")
        cancelPopoverConfirmation(
            unblockConfirmation,
            preserving: app.navigationBars["记录"],
            in: app
        )
        let contexts = app.buttons.matching(identifier: "interceptions.row")
        // The deterministic ordering starts with Primary SMS, Secondary call, then another Primary SMS;
        // Unavailable is the next call just below the initially mounted lazy rows. Scroll each expected row into
        // the actual viewport so the evidence proves all three per-row SIM contexts rather than only query data.
        for (label, evidenceName) in [
            ("S33 Primary SIM", "primary"),
            ("S33 Secondary eSIM", "secondary"),
            ("S33 Unavailable SIM", "unavailable"),
        ] {
            let row = contexts.matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
            reveal(row, in: app, maxSwipes: 10)
            XCTAssertTrue(row.exists && row.isHittable, "Interception context for \(label) was not visible")
            attachScreenshot(app, name: "s33-10-interception-sim-context-\(evidenceName)")
        }
        let interceptionsPage = app.buttons["跳转到指定页"]
        let interceptionsNext = app.buttons["下一页"]
        revealPagerControl(interceptionsNext, in: app)
        XCTAssertTrue((interceptionsPage.value as? String)?.contains("第 1 /") == true)
        interceptionsNext.tap()
        XCTAssertTrue(waitUntil(timeout: 12) { (interceptionsPage.value as? String)?.contains("第 2 /") == true })
        let secondPageRow = app.buttons["interceptions.row"].firstMatch
        reveal(secondPageRow, in: app, maxSwipes: 10)
        XCTAssertTrue(secondPageRow.exists && secondPageRow.isHittable, "Second interception page had no visible row")
        attachScreenshot(app, name: "s33-interceptions-second-page")
    }

    @MainActor
    func test03SMSPartialDeleteBlockRetryAndSettingsCAS() async throws {
        let fixture = try await requireFixture(scenario: "all")
        let app = launchApp()
        ensureLoggedIn(app)

        selectTab("短信", in: app)
        let primarySIM = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "S33 Primary SIM")
        ).firstMatch
        XCTAssertTrue(primarySIM.waitForExistence(timeout: 10), "Primary SIM selector was not visible")
        primarySIM.tap()
        Self.writeDebugSnapshot(app, name: "s33-sms-after-primary-sim")

        // Send through the native composer before restoring the deterministic deletion fixture. The exact long
        // body must return in the real conversation as a queued outbound message.
        let longSMS = "S33 iOS 长短信 · " + String(repeating: "跨端验收内容1234567890", count: 12)
        app.buttons["新短信"].tap()
        XCTAssertTrue(app.navigationBars["新短信"].waitForExistence(timeout: 8))
        replaceText(app.textFields["电话号码"], with: "2025550111")
        finishTextInput(in: app)
        replaceText(app.textFields["短信内容"], with: longSMS)
        finishTextInput(in: app)
        app.buttons["发送"].tap()
        XCTAssertTrue(app.navigationBars["短信"].waitForExistence(timeout: 15))
        let exactLongSMS = app.staticTexts.matching(NSPredicate(format: "label == %@", longSMS)).firstMatch
        XCTAssertTrue(exactLongSMS.waitForExistence(timeout: 12), "Sent long SMS body was not returned exactly")
        XCTAssertTrue(app.staticTexts["等待发送"].waitForExistence(timeout: 8), "Outbound long SMS did not show its queued state")
        attachScreenshot(app, name: "s33-sms-long-message-queued")
        _ = try await fixture.reset("sms")
        app.swipeDown()
        let thread = app.buttons.matching(identifier: "messages.conversation").matching(
            NSPredicate(format: "label CONTAINS %@", "S33 测试联系人甲")
        ).firstMatch
        XCTAssertTrue(thread.waitForExistence(timeout: 12))
        thread.tap()
        XCTAssertTrue(app.staticTexts["S33 收到的短信"].waitForExistence(timeout: 8))
        app.buttons["conversation.selectMode"].tap()
        app.buttons["conversation.selectAll"].tap()
        XCTAssertTrue(app.staticTexts["已选 4 条"].waitForExistence(timeout: 5))
        app.buttons["conversation.deleteSelected"].tap()
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-sms-delete-confirmation-red")
        app.buttons["删除"].tap()
        XCTAssertTrue(app.staticTexts["2 条正在发送中，暂时无法删除。"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["S33 排队中，删除应跳过"].exists)
        XCTAssertTrue(app.staticTexts["S33 发送中，删除应跳过"].exists)
        XCTAssertFalse(app.staticTexts["S33 收到的短信"].exists)
        attachScreenshot(app, name: "s33-11-sms-partial-delete")
        app.navigationBars.firstMatch.buttons.firstMatch.tap()

        // Force step two of 删除并屏蔽 to fail once. The retry message must remain visible and a second attempt
        // must skip the already-satisfied block step while finishing the thread deletion.
        _ = try await fixture.reset("sms")
        _ = try await fixture.peer(
            action: "inject.failure",
            payload: [
                "method": "POST", "path": "/api/v1/sms/threads/delete", "status": 503,
                "code": "S33_DELETE_RETRY", "message": "S33 simulated delete retry", "count": 1,
            ]
        )
        app.swipeDown()
        let retryThread = app.buttons.matching(identifier: "messages.conversation").matching(
            NSPredicate(format: "label CONTAINS %@", "S33 测试联系人甲")
        ).firstMatch
        XCTAssertTrue(retryThread.waitForExistence(timeout: 10))
        retryThread.swipeLeft()
        attachAppearanceScreenshots(app, name: "s33-sms-delete-block-swipe-red")
        app.buttons["threads.deleteAndBlock"].tap()
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-sms-delete-block-confirmation-red")
        app.buttons["删除"].tap()
        XCTAssertTrue(app.staticTexts["号码已屏蔽，但对话删除失败，请重试"].waitForExistence(timeout: 10))
        attachScreenshot(app, name: "s33-12-delete-block-retry")
        retryThread.swipeLeft()
        app.buttons["threads.deleteAndBlock"].tap()
        app.buttons["删除"].tap()
        XCTAssertTrue(app.staticTexts["2 条正在发送中，暂时无法删除。"].waitForExistence(timeout: 10))
        XCTAssertTrue(retryThread.exists, "The thread must remain while queued/sending messages are skipped")
        retryThread.tap()
        XCTAssertTrue(app.staticTexts["S33 排队中，删除应跳过"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["S33 发送中，删除应跳过"].exists)
        XCTAssertFalse(app.staticTexts["S33 收到的短信"].exists)
        app.navigationBars.firstMatch.buttons.firstMatch.tap()

        _ = try await fixture.reset("settings")
        selectTab("设置", in: app)
        let role = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "角色, 用户")
        ).firstMatch
        XCTAssertTrue(role.waitForExistence(timeout: 10), "Account role was not localized")
        let currentSession = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "当前会话, iOS App")
        ).firstMatch
        XCTAssertTrue(currentSession.waitForExistence(timeout: 5), "Current native session was not identified")
        XCTAssertTrue(app.staticTexts["S33 Primary SIM"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "PX-33000000-0000-4000-8000-000000000101"))
            .firstMatch.waitForExistence(timeout: 10))
        Self.writeDebugSnapshot(app, name: "s33-settings-list-initial")
        app.staticTexts["S33 Primary SIM"].tap()
        XCTAssertTrue(app.navigationBars["S33 Primary SIM"].waitForExistence(timeout: 8))

        let label = app.textFields["显示名称"]
        replaceText(label, with: "iOS notes draft")
        _ = try await fixture.peer(
            action: "sim.notes", id: fixture.state.ids.sims.primary,
            payload: ["label": "Web peer SIM label", "phoneLabel": "+1 peer"]
        )
        app.buttons["保存备注"].tap()
        XCTAssertTrue(app.buttons["simSettings.reloadNotesConflict"].waitForExistence(timeout: 10))
        XCTAssertEqual(label.value as? String, "iOS notes draft")
        attachScreenshot(app, name: "s33-13-sim-notes-conflict")
        app.buttons["simSettings.reloadNotesConflict"].tap()
        XCTAssertTrue(waitUntil(timeout: 10) { (label.value as? String) == "Web peer SIM label" })

        // The PUT response is authoritative for the local edit. A failing follow-up GET must keep that accepted
        // label on screen and report a refresh warning separately, rather than presenting the save as failed.
        let savedLabelDuringRefreshFailure = "iOS 备注保存后刷新失败"
        _ = try await fixture.peer(
            action: "inject.failure",
            payload: [
                "method": "GET", "path": "/api/v1/sims", "status": 503,
                "code": "S33_SIM_REFRESH", "message": "S33 simulated SIM refresh failure", "count": 10,
            ]
        )
        replaceText(label, with: "  \(savedLabelDuringRefreshFailure)  ")
        app.buttons["保存备注"].tap()
        XCTAssertTrue(waitUntil(timeout: 10) { (label.value as? String) == savedLabelDuringRefreshFailure })
        let simRefreshWarning = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "S33 simulated SIM refresh failure")
        ).firstMatch
        revealStaticEvidence(simRefreshWarning, in: app, maxSwipes: 8)
        XCTAssertEqual(label.value as? String, savedLabelDuringRefreshFailure)
        attachScreenshot(app, name: "s33-sim-notes-write-kept-after-refresh-failure")
        _ = try await fixture.peer(action: "clearFailures")
        XCTAssertTrue(waitUntil(timeout: 12) { !simRefreshWarning.exists }, "SIM refresh warning did not recover")
        XCTAssertEqual(label.value as? String, savedLabelDuringRefreshFailure)

        // Keep a local mode draft while a peer advances the settings version. The draft stays until an explicit
        // reload, then a fresh save remains pending until the virtual Pixel acknowledges the actual command.
        let mode = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "模式")).firstMatch
        XCTAssertTrue(mode.waitForExistence(timeout: 5))
        mode.tap()
        app.buttons["AI 即接"].tap()
        _ = try await fixture.peer(
            action: "sim.settings", id: fixture.state.ids.sims.primary,
            payload: ["mode": "timeout_ai", "timeoutSeconds": 60]
        )
        app.buttons["保存设置"].tap()
        XCTAssertTrue(app.buttons["simSettings.reloadSettingsConflict"].waitForExistence(timeout: 10))
        attachScreenshot(app, name: "s33-14-sim-settings-conflict")
        app.buttons["simSettings.reloadSettingsConflict"].tap()
        XCTAssertTrue(waitUntil(timeout: 8) { !app.buttons["simSettings.reloadSettingsConflict"].exists })
        mode.tap()
        app.buttons["AI 即接"].tap()
        app.buttons["保存设置"].tap()
        let applyStatus = app.staticTexts.matching(identifier: "simSettings.applyStatus").firstMatch
        XCTAssertTrue(app.staticTexts["正在应用中…"].waitForExistence(timeout: 8))
        _ = try await fixture.peer(action: "gateway.ackLatest", id: fixture.state.ids.gateways.primary)
        XCTAssertTrue(waitUntil(timeout: 12) { applyStatus.label.contains("应用成功") })
        attachScreenshot(app, name: "s33-15-sim-settings-acked")

        // A provider peer update advances configVersion; the stale native tap must show the explicit reload gate.
        app.navigationBars.firstMatch.buttons.firstMatch.tap()
        let providerRows = app.buttons.matching(identifier: "voiceProvider.row")
        let xai = providerRows.matching(NSPredicate(format: "label CONTAINS %@", "xAI Grok")).firstMatch
        let doubao = providerRows.matching(NSPredicate(format: "label CONTAINS %@", "豆包")).firstMatch
        reveal(doubao, in: app)
        XCTAssertTrue(xai.exists)
        XCTAssertTrue(xai.isSelected, "The stale native provider snapshot must start on xAI")
        Self.writeDebugSnapshot(app, name: "s33-settings-provider-before-cas")
        _ = try await fixture.peer(action: "provider.select", payload: ["provider": "doubao"])
        doubao.tap()
        XCTAssertTrue(app.descendants(matching: .any)["voiceProvider.conflict"].waitForExistence(timeout: 10))
        attachScreenshot(app, name: "s33-16-provider-cas-conflict")
        let reloadProviderConflict = app.buttons.matching(
            NSPredicate(format: "label == %@", "载入并确认最新配置")
        ).firstMatch
        XCTAssertTrue(reloadProviderConflict.waitForExistence(timeout: 5))
        reloadProviderConflict.tap()
        XCTAssertTrue(waitUntil(timeout: 8) {
            !app.descendants(matching: .any)["voiceProvider.conflict"].exists
        })

        // Remote power is a virtual-gateway command in this fixture. Acknowledge it via the fixture boundary and
        // require the native row to settle on the server-reported state.
        let power = app.switches["gatewayPower.toggle"].firstMatch
        reveal(power, in: app)
        XCTAssertEqual(power.value as? String, "1", "Primary virtual gateway should begin enabled")
        attachAppearanceScreenshots(app, name: "s33-17-gateway-destructive-control")
        Self.writeDebugSnapshot(app, name: "s33-settings-gateway-before-command")
        // SwiftUI exposes both the confirmation action and a nested accessibility button with the same label.
        // The stable identifier plus firstMatch avoids XCTest's ambiguous label subscript while retaining the
        // exact destructive action contract.
        let confirmPowerOff = app.buttons.matching(identifier: "gatewayPower.confirmOff").firstMatch
        let powerOffConfirmation = app.staticTexts["关闭 S33 Primary Pixel？"]
        openGatewayPowerOffConfirmation(powerOffConfirmation, in: app)
        XCTAssertTrue(confirmPowerOff.waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-18-gateway-close-confirmation-red")
        cancelPopoverConfirmation(
            powerOffConfirmation, preserving: app.navigationBars["设置"], in: app
        )
        XCTAssertFalse(app.staticTexts["已请求关闭，等待网关响应…"].exists)
        XCTAssertEqual(power.value as? String, "1", "Cancelling gateway close changed its state")

        openGatewayPowerOffConfirmation(powerOffConfirmation, in: app)
        XCTAssertTrue(confirmPowerOff.waitForExistence(timeout: 5))
        confirmPowerOff.tap()
        XCTAssertTrue(app.staticTexts["已请求关闭，等待网关响应…"].waitForExistence(timeout: 8))
        _ = try await fixture.peer(
            action: "gateway.powerAck", id: fixture.state.ids.gateways.primary,
            payload: ["desired": "off", "ok": true]
        )
        XCTAssertTrue(waitUntil(timeout: 12) { (power.value as? String) == "0" })
        XCTAssertFalse(app.staticTexts["已请求关闭，等待网关响应…"].exists)
        XCTAssertTrue(app.staticTexts["上次远程关闭成功"].waitForExistence(timeout: 8))
        attachScreenshot(app, name: "s33-19-settings-gateway-acked")

        // Settings exposes every account-level control from one page. The blocklist destination reuses the same
        // authoritative rows and destructive unblock confirmation as Records.
        let heartbeat = app.descendants(matching: .any)["gatewayPower.heartbeat"].firstMatch
        XCTAssertTrue(heartbeat.exists, "Gateway heartbeat status was omitted")
        let blocklistEntry = app.buttons["settings.blocklist"]
        reveal(blocklistEntry, in: app, maxSwipes: 12)
        blocklistEntry.tap()
        XCTAssertTrue(app.navigationBars["已屏蔽号码"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["+1 202 555 0112"].waitForExistence(timeout: 10))
        let settingsUnblock = app.buttons["blocklist.unblock"].firstMatch
        XCTAssertTrue(settingsUnblock.waitForExistence(timeout: 5))
        settingsUnblock.tap()
        let settingsUnblockConfirmation = app.staticTexts["解除屏蔽这个号码？"]
        XCTAssertTrue(settingsUnblockConfirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["解除屏蔽"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-settings-unblock-confirmation-red")
        cancelPopoverConfirmation(
            settingsUnblockConfirmation, preserving: app.navigationBars["已屏蔽号码"], in: app
        )
        app.navigationBars["已屏蔽号码"].buttons.firstMatch.tap()

        let passkeyAdd = app.buttons["passkey.register"]
        reveal(passkeyAdd, in: app, maxSwipes: 12)
        XCTAssertTrue(app.staticTexts["通行密钥"].exists)
        let macPasskey = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "S33 办公 MacBook", "Safari on macOS")
        ).firstMatch
        XCTAssertTrue(macPasskey.waitForExistence(timeout: 10), "Passkey metadata did not render")
        XCTAssertTrue(app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "S33 随身 iPhone")
        ).firstMatch.exists)
        XCTAssertFalse(app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "S33 Owner2 Passkey")
        ).firstMatch.exists, "Another account's passkey leaked into owner1")

        let macMenu = app.buttons.matching(identifier: "passkey.menu").matching(
            NSPredicate(format: "label CONTAINS %@", "S33 办公 MacBook")
        ).firstMatch
        reveal(macMenu, in: app, maxSwipes: 4)
        macMenu.tap()
        app.buttons["重命名"].tap()
        XCTAssertTrue(app.alerts["重命名通行密钥"].waitForExistence(timeout: 5))
        replaceText(app.textFields["名称"], with: "S33 iOS 已重命名")
        _ = try await fixture.peer(
            action: "inject.failure",
            payload: [
                "method": "GET", "path": "/api/v1/passkeys", "status": 503,
                "code": "S33_PASSKEY_REFRESH", "message": "S33 simulated passkey refresh failure", "count": 10,
            ]
        )
        let renameAlert = app.alerts["重命名通行密钥"]
        let renameField = app.textFields["名称"]
        let renameSave = renameAlert.buttons["保存"]
        renameSave.tap()
        if !waitUntil(timeout: 2) { !renameAlert.exists } {
            // On this OS the first synthesized alert-button tap can be consumed solely by resigning the text
            // field. The open alert proves renamePasskey (whose first statement dismisses it) never started.
            // Retry once only after the keyboard is gone and the intended value is still intact.
            XCTAssertTrue(waitUntil(timeout: 2) { !app.keyboards.firstMatch.exists },
                          "Passkey rename alert remained open with its keyboard still active")
            XCTAssertEqual(renameField.value as? String, "S33 iOS 已重命名")
            NSLog("S33 passkey rename save was consumed by keyboard dismissal; retrying once")
            renameSave.tap()
        }
        XCTAssertTrue(waitUntil(timeout: 5) { !renameAlert.exists }, "Passkey rename action did not start")
        let renamedPasskey = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "S33 iOS 已重命名")
        ).firstMatch
        XCTAssertTrue(renamedPasskey.waitForExistence(timeout: 10))
        let passkeyRefreshWarning = app.descendants(matching: .any)["settings.passkeyRefreshError"]
        let passkeyRefreshWarningText = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "S33 simulated passkey refresh failure")
        ).firstMatch
        revealStaticEvidence(passkeyRefreshWarningText, in: app, maxSwipes: 8)
        XCTAssertTrue(passkeyRefreshWarning.exists)
        XCTAssertTrue(renamedPasskey.exists, "Accepted passkey rename was rolled back by a failed refresh")
        attachScreenshot(app, name: "s33-passkey-rename-kept-after-refresh-failure")
        _ = try await fixture.peer(action: "clearFailures")
        let passkeyRetry = app.buttons.matching(NSPredicate(format: "label == %@", "重试")).firstMatch
        XCTAssertTrue(passkeyRetry.waitForExistence(timeout: 5))
        passkeyRetry.tap()
        XCTAssertTrue(waitUntil(timeout: 10) { !passkeyRefreshWarning.exists })
        XCTAssertTrue(renamedPasskey.exists)

        let renamedMenu = app.buttons.matching(identifier: "passkey.menu").matching(
            NSPredicate(format: "label CONTAINS %@", "S33 iOS 已重命名")
        ).firstMatch
        reveal(renamedMenu, in: app, maxSwipes: 4)
        renamedMenu.tap()
        app.buttons["删除"].tap()
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-settings-passkey-delete-red")
        _ = try await fixture.peer(
            action: "inject.failure",
            payload: [
                "method": "GET", "path": "/api/v1/passkeys", "status": 503,
                "code": "S33_PASSKEY_REFRESH", "message": "S33 simulated passkey refresh failure", "count": 10,
            ]
        )
        app.buttons["删除"].tap()
        XCTAssertTrue(waitUntil(timeout: 5) { !renamedPasskey.exists })
        revealStaticEvidence(passkeyRefreshWarningText, in: app, maxSwipes: 8)
        XCTAssertTrue(passkeyRefreshWarning.exists)
        XCTAssertFalse(renamedPasskey.exists, "Accepted passkey deletion was undone by a failed refresh")
        attachScreenshot(app, name: "s33-passkey-delete-kept-after-refresh-failure")
        _ = try await fixture.peer(action: "clearFailures")
        XCTAssertTrue(passkeyRetry.waitForExistence(timeout: 5))
        passkeyRetry.tap()
        XCTAssertTrue(waitUntil(timeout: 10) { !passkeyRefreshWarning.exists })
        XCTAssertFalse(renamedPasskey.exists)

        let notificationStatus = app.descendants(matching: .any)["settings.notificationPermission"].firstMatch
        revealStaticEvidence(notificationStatus, in: app, maxSwipes: 12)
        XCTAssertTrue(app.descendants(matching: .any)["settings.microphonePermission"].firstMatch.exists)
        let pushTokenStatus = app.descendants(matching: .any)["push-token-status"].firstMatch
        revealStaticEvidence(pushTokenStatus, in: app, maxSwipes: 6)
        XCTAssertTrue(
            ["系统推送令牌已获取", "正在获取系统推送令牌", "等待系统推送令牌"].contains {
                pushTokenStatus.label.contains($0)
            },
            "Unexpected system push token state: \(pushTokenStatus.label)"
        )
        let pushServerStatus = app.descendants(matching: .any)["push-server-status"].firstMatch
        revealStaticEvidence(pushServerStatus, in: app, maxSwipes: 6)
        XCTAssertTrue(pushServerStatus.label.contains("服务端推送注册："), pushServerStatus.label)
        let networkPolicy = app.descendants(matching: .any)["settings.callNetworkPolicy"].firstMatch
        revealStaticEvidence(networkPolicy, in: app, maxSwipes: 6)
        let refreshAll = app.buttons["settings.refreshAll"]
        reveal(refreshAll, in: app, maxSwipes: 8)
        refreshAll.tap()
        XCTAssertTrue(waitUntil(timeout: 25) { refreshAll.exists && refreshAll.isEnabled })
        XCTAssertTrue(notificationStatus.exists)
        attachScreenshot(app, name: "s33-settings-complete-status-and-refresh")
    }

    /// The one persistent chain is deliberately separate from reset-backed domain tests. Web writes a private
    /// marker file after its real UI save; iOS consumes that exact server snapshot, advances it, and leaves both
    /// the server and marker file ready for Android.
    @MainActor
    func test04SharedWebToIOSAndAndroidHandoff() async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["VODOG_UI_TEST_SHARED_JOURNEY"] == "1",
                          "Set VODOG_UI_TEST_SHARED_JOURNEY=1 only for the sequenced three-client handoff")
        let path = environment["VODOG_UI_TEST_WEB_HANDOFF_PATH"] ?? ""
        let encoded = environment["VODOG_UI_TEST_WEB_HANDOFF_B64"] ?? ""
        try XCTSkipIf(path.isEmpty && encoded.isEmpty,
                      "Inject Web's handoff JSON through VODOG_UI_TEST_WEB_HANDOFF_B64")
        let hostURL = path.isEmpty ? nil : URL(fileURLWithPath: path)
        let handoffData: Data
        if !encoded.isEmpty {
            guard let decoded = decodedEnvironmentData(encoded) else {
                throw S33FixtureError.invalidResponse("VODOG_UI_TEST_WEB_HANDOFF_B64 is invalid")
            }
            handoffData = decoded
        } else if let hostURL {
            handoffData = try Data(contentsOf: hostURL)
        } else {
            throw S33FixtureError.invalidResponse("Web handoff JSON is unavailable")
        }
        let handoff = try JSONDecoder().decode(S33WebHandoff.self, from: handoffData)
        let fixture = try await requireFixture(scenario: nil)
        XCTAssertEqual(handoff.contactId, fixture.state.ids.contacts.primary)
        XCTAssertEqual(handoff.simId, fixture.state.ids.sims.primary)

        let app = launchApp()
        ensureLoggedIn(app)
        selectTab("通讯录", in: app)
        replaceText(revealSearchField(in: app), with: "S33 测试联系人甲")
        XCTAssertTrue(app.staticTexts["S33 测试联系人甲"].waitForExistence(timeout: 10))
        app.staticTexts["S33 测试联系人甲"].tap()
        XCTAssertTrue(app.navigationBars["联系人"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["contactDetail.edit"].waitForExistence(timeout: 5))
        app.buttons["contactDetail.edit"].tap()
        XCTAssertTrue(app.navigationBars["编辑联系人"].waitForExistence(timeout: 8))
        let organization = app.textFields["公司"]
        let notes = app.textFields["contactEdit.notes"]
        XCTAssertTrue(organization.waitForExistence(timeout: 5))
        let iosOrganization = handoff.expected.ios.organization
        let currentOrganization = organization.value as? String
        XCTAssertTrue(
            currentOrganization == handoff.expected.web.organization || currentOrganization == iosOrganization,
            "Primary contact was neither Web input nor this iOS run's exact output: \(currentOrganization ?? "<missing>")"
        )
        if currentOrganization == handoff.expected.web.organization {
            replaceText(organization, with: iosOrganization)
            finishTextInput(in: app)
        }
        reveal(notes, in: app)
        XCTAssertEqual(notes.value as? String, handoff.expected.web.notes)
        if currentOrganization == handoff.expected.web.organization {
            app.buttons["contactEdit.save"].tap()
        } else {
            app.buttons["取消"].tap()
        }
        XCTAssertTrue(app.navigationBars["联系人"].waitForExistence(timeout: 10))
        app.navigationBars["联系人"].buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 8))

        let handoffContact = handoff.expected.ios.createdContact.displayName
        let handoffPhone = handoff.expected.ios.createdContact.phone
        XCTAssertEqual(handoffPhone, "2025550115", "Unexpected shared handoff phone contract")
        XCTAssertTrue(handoffPhone.allSatisfy(\.isNumber), "Shared handoff phone must contain only digits")
        XCTAssertEqual(handoffPhone.count, 10, "Shared handoff phone must be a synthetic NANP number")
        XCTAssertTrue(handoffPhone.hasPrefix("20255501"), "Shared handoff phone must be a synthetic NANP number")
        let handoffE164 = "+1\(handoffPhone)"
        let handoffPhoneRowLabel = "mobile, \(handoffE164)"
        let handoffPhoneRow = app.staticTexts.matching(
            NSPredicate(format: "label == %@", handoffPhoneRowLabel)
        ).firstMatch
        let handoffSearchResultLabel = "\(handoffContact)，\(handoffE164)"
        let handoffSearchResult = app.buttons.matching(
            NSPredicate(format: "label == %@", handoffSearchResultLabel)
        ).firstMatch
        let contactSearch = revealSearchField(in: app)
        replaceText(contactSearch, with: handoffContact)
        let noHandoffContact = app.staticTexts["没有匹配的联系人"]
        XCTAssertTrue(waitUntil(timeout: 10) { handoffSearchResult.exists || noHandoffContact.exists },
                      "Handoff contact search never reached an authoritative result")
        if handoffSearchResult.exists {
            openExactContactSearchResult(handoffSearchResult, in: app)
            XCTAssertTrue(handoffPhoneRow.waitForExistence(timeout: 8),
                          "Existing handoff contact did not expose exact normalized phone row \(handoffPhoneRowLabel)")
            app.navigationBars["联系人"].buttons.firstMatch.tap()
            XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 8))
            closeContactSearch(in: app)
        } else {
            XCTAssertTrue(noHandoffContact.exists, "Handoff contact absence was not authoritative")
            replaceText(contactSearch, with: "")
            closeContactSearch(in: app)
            let newContact = app.buttons["contacts.new"]
            XCTAssertTrue(newContact.waitForExistence(timeout: 5))
            newContact.tap()
            XCTAssertTrue(app.navigationBars["新建联系人"].waitForExistence(timeout: 5))
            replaceText(app.textFields["显示名称"], with: handoffContact)
            replaceText(app.textFields["号码"], with: handoffPhone)
            finishTextInput(in: app)
            app.buttons["contactEdit.save"].tap()
            XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 10))
            XCTAssertTrue(handoffSearchResult.waitForExistence(timeout: 10),
                          "Created handoff contact did not expose exact search row \(handoffSearchResultLabel)")
            openExactContactSearchResult(handoffSearchResult, in: app)
            XCTAssertTrue(handoffPhoneRow.waitForExistence(timeout: 8),
                          "Created handoff contact did not expose exact normalized phone row \(handoffPhoneRowLabel)")
            app.navigationBars["联系人"].buttons.firstMatch.tap()
        }
        attachScreenshot(app, name: "s33-19-ios-android-contact-handoff")

        selectTab("设置", in: app)
        let webSIM = app.staticTexts[handoff.expected.web.simLabel]
        let iosSIM = app.staticTexts[handoff.expected.ios.simLabel]
        let simToOpen: XCUIElement
        let simNeedsAdvance: Bool
        if webSIM.waitForExistence(timeout: 10) {
            XCTAssertFalse(iosSIM.exists, "Both Web and iOS labels were exposed for one primary SIM")
            simToOpen = webSIM
            simNeedsAdvance = true
        } else {
            XCTAssertTrue(iosSIM.waitForExistence(timeout: 10),
                          "Primary SIM was neither Web input nor this iOS run's exact output")
            simToOpen = iosSIM
            simNeedsAdvance = false
        }
        reveal(simToOpen, in: app, maxSwipes: 8)
        simToOpen.tap()
        let simLabel = app.textFields["显示名称"]
        XCTAssertTrue(simLabel.waitForExistence(timeout: 8), "Primary SIM settings did not open")
        let iosSIMLabel = handoff.expected.ios.simLabel
        XCTAssertEqual(simLabel.value as? String, simNeedsAdvance ? handoff.expected.web.simLabel : iosSIMLabel)
        if simNeedsAdvance {
            replaceText(simLabel, with: iosSIMLabel)
            let saveNotes = app.buttons["保存备注"]
            saveNotes.tap()
            XCTAssertTrue(waitUntil(timeout: 10) {
                saveNotes.exists && saveNotes.isEnabled && (simLabel.value as? String) == iosSIMLabel
            }, "SIM notes save did not return to its accepted editable state")
            XCTAssertTrue(app.navigationBars[iosSIMLabel].waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["simSettings.reloadNotesConflict"].exists)
        }
        app.navigationBars[iosSIMLabel].buttons.firstMatch.tap()
        XCTAssertTrue(app.staticTexts[iosSIMLabel].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts[handoff.expected.web.simLabel].exists,
                       "Parent settings list still exposed the pre-save Web SIM label")
        attachScreenshot(app, name: "s33-20-shared-handoff-ready-for-android")
        let provider = app.buttons.matching(identifier: "voiceProvider.row")
            .matching(NSPredicate(format: "label CONTAINS %@", "xAI Grok")).firstMatch
        reveal(provider, in: app, maxSwipes: 8)
        XCTAssertTrue(provider.isSelected, "Web handoff provider must remain xai")
        attachScreenshot(app, name: "s33-20b-shared-handoff-provider-preserved")

        if let hostURL, FileManager.default.isWritableFile(atPath: hostURL.path) {
            try? recordIOSHandoff(
                at: hostURL, organization: iosOrganization, notes: handoff.expected.ios.notes,
                simLabel: iosSIMLabel, createdContactName: handoffContact,
                createdContactPhone: handoff.expected.ios.createdContact.phone
            )
        }
    }

    /// The native localhost fixture deliberately cannot establish WebRTC: iOS keeps its production trust and TURN
    /// requirements. This journey proves everything around that boundary through the real UI and Control service:
    /// offline prevention, an owned outbound request, gateway rejection, media-failure grace, and an owner end.
    @MainActor
    func test05LocalOutboundPreflightRejectionAndOwnedEnd() async throws {
        let fixture = try await requireFixture(scenario: "all")
        XCTAssertEqual(fixture.state.mediaMode, "basic", "Native acceptance must never use the browser WebRTC bridge")
        XCTAssertFalse(fixture.state.simulation.validLoopbackWebRtcBridge)
        XCTAssertFalse(fixture.state.simulation.loopbackTurnRelay)
        XCTAssertFalse(fixture.state.simulation.temporaryBrowserProbeTrustRequired)

        addUIInterruptionMonitor(withDescription: "S33 simulator microphone permission") { alert in
            for label in ["允许", "Allow"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }

        let app = launchApp()
        ensureLoggedIn(app)
        selectTab("电话", in: app)
        XCTAssertTrue(app.navigationBars["电话"].waitForExistence(timeout: 8))

        _ = try await fixture.peer(action: "requestCounters.reset")
        let initialOutboundCount = try await fixture.loadState().requestCounters.outboundCallRequests
        XCTAssertEqual(initialOutboundCount, 0)

        let unavailableSIM = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "S33 Unavailable SIM")
        ).firstMatch
        revealSIM(unavailableSIM, in: app, towardTrailing: true)
        unavailableSIM.tap()
        let rejectedNumber = "2025550113"
        enterDialNumber(rejectedNumber, in: app)
        XCTAssertTrue(app.staticTexts["当前号码离线，暂时无法拨号"].waitForExistence(timeout: 5))
        let disabledDial = app.buttons["使用S33 Unavailable SIM拨打"]
        XCTAssertTrue(disabledDial.waitForExistence(timeout: 5))
        XCTAssertFalse(disabledDial.isEnabled, "An offline gateway exposed an enabled dial action")
        disabledDial.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        try await Task.sleep(for: .milliseconds(500))
        let offlineOutboundCount = try await fixture.loadState().requestCounters.outboundCallRequests
        XCTAssertEqual(
            offlineOutboundCount, 0,
            "A coordinate tap on the disabled offline control reached the outbound API"
        )
        attachScreenshot(app, name: "s33-21-offline-dial-disabled-no-request")

        // Release only the separate seeded unavailable-gateway call. Its fixture generation is 34; using the
        // primary SIM/gateway here would conceal a cross-gateway routing defect.
        _ = try await fixture.peer(
            action: "gateway.callEvent", id: fixture.state.ids.calls.active,
            payload: ["eventId": S33JSONValue(UUID().uuidString), "generation": 34, "state": "ended"]
        )

        let primarySIM = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "S33 Primary SIM")
        ).firstMatch
        revealSIM(primarySIM, in: app, towardTrailing: false)
        primarySIM.tap()
        let primaryDial = app.buttons["使用S33 Primary SIM拨打"]
        XCTAssertTrue(primaryDial.waitForExistence(timeout: 5))
        XCTAssertTrue(primaryDial.isEnabled)
        primaryDial.tap()

        let rejected = try await waitForFixtureCall(
            fixture, simID: fixture.state.ids.sims.primary, remoteNumber: rejectedNumber,
            expectedState: "outgoing_pending"
        )
        XCTAssertEqual(rejected.call.direction, "outgoing")
        XCTAssertEqual(rejected.call.sessionOwner.kind, "originating")
        XCTAssertTrue(rejected.call.sessionOwner.present)
        XCTAssertEqual(rejected.call.sessionOwner.platform, "ios")
        let rejectedOutboundCount = try await fixture.loadState().requestCounters.outboundCallRequests
        XCTAssertEqual(rejectedOutboundCount, 1)
        attachScreenshot(app, name: "s33-22-ios-owned-outbound-pending")

        _ = try await fixture.peer(
            action: "gateway.ackLatest", id: fixture.state.ids.gateways.primary,
            payload: [
                "status": "rejected",
                "result": .object(["phase": "not_executed", "reason": "virtual_radio_rejected"]),
            ]
        )
        _ = try await fixture.peer(
            action: "gateway.callEvent", id: rejected.call.id,
            payload: [
                "eventId": S33JSONValue(UUID().uuidString), "generation": S33JSONValue(rejected.call.generation),
                "state": "failed", "failureReason": "virtual_radio_rejected",
            ]
        )
        let failed = try await waitForFixtureCall(
            fixture, simID: fixture.state.ids.sims.primary, remoteNumber: rejectedNumber,
            expectedState: "failed"
        )
        XCTAssertEqual(failed.call.failureReason, "virtual_radio_rejected")
        XCTAssertNotNil(failed.call.endedAt)
        let failedRow = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", rejectedNumber, "失败")
        ).firstMatch
        reveal(failedRow, in: app, maxSwipes: 8)
        attachScreenshot(app, name: "s33-23-virtual-gateway-rejected")

        let ownedEndNumber = "2025550114"
        enterDialNumber(ownedEndNumber, in: app)
        XCTAssertTrue(primaryDial.isEnabled)
        primaryDial.tap()
        let owned = try await waitForFixtureCall(
            fixture, simID: fixture.state.ids.sims.primary, remoteNumber: ownedEndNumber,
            expectedState: "outgoing_pending"
        )
        XCTAssertEqual(owned.call.sessionOwner.platform, "ios")
        let ownedEndOutboundCount = try await fixture.loadState().requestCounters.outboundCallRequests
        XCTAssertEqual(ownedEndOutboundCount, 2)

        // Basic mode cannot gather a relay candidate. The app must hold the cellular leg for its documented
        // 30-second recovery grace and expose the user's own red end action rather than ending on media failure.
        let graceEnd = app.buttons["结束这通通话"]
        XCTAssertTrue(graceEnd.waitForExistence(timeout: 40), "Media failure never reached the native recovery grace")
        XCTAssertTrue(app.descendants(matching: .any)["30 秒内未恢复音频将自动结束通话"]
            .waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-24-owned-call-grace-red-end")
        graceEnd.tap()

        // This intermediate server state is the evidence that the real iOS button POSTed /calls/{id}/end. Only
        // after observing it may the fixture acknowledge the resulting hangup and report Telecom ended.
        let ending = try await waitForFixtureCall(
            fixture, simID: fixture.state.ids.sims.primary, remoteNumber: ownedEndNumber,
            expectedState: "ending"
        )
        XCTAssertNil(ending.call.endedAt)
        _ = try await fixture.peer(action: "gateway.ackLatest", id: fixture.state.ids.gateways.primary)
        _ = try await fixture.peer(
            action: "gateway.callEvent", id: owned.call.id,
            payload: [
                "eventId": S33JSONValue(UUID().uuidString), "generation": S33JSONValue(owned.call.generation),
                "state": "ended",
            ]
        )
        let ended = try await waitForFixtureCall(
            fixture, simID: fixture.state.ids.sims.primary, remoteNumber: ownedEndNumber,
            expectedState: "ended"
        )
        XCTAssertNotNil(ended.call.endedAt)
        app.buttons["刷新通话"].tap()
        let endedRow = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", ownedEndNumber, "已结束")
        ).firstMatch
        reveal(endedRow, in: app, maxSwipes: 8)
        XCTAssertFalse(app.buttons["结束这通通话"].exists)
        attachScreenshot(app, name: "s33-25-owned-call-ended")
    }

    /// A short dark-mode walkthrough for destructive controls. The app receives the color scheme
    /// before launch through the Debug simulator hook guarded by the same exact real-loopback acceptance flags.
    /// Business-destructive confirmations are cancelled; logout changes only this test's isolated local session.
    @MainActor
    func test06DarkDestructiveAppearance() async throws {
        _ = try await requireFixture(scenario: "all")
        let app = launchApp(colorScheme: "dark")
        ensureLoggedIn(app)

        selectTab("通讯录", in: app)
        let contact = app.staticTexts["S33 测试联系人甲"]
        XCTAssertTrue(contact.waitForExistence(timeout: 12))
        contact.tap()
        XCTAssertTrue(app.navigationBars["联系人"].waitForExistence(timeout: 5))
        let deleteContact = app.buttons["contactDetail.delete"]
        reveal(deleteContact, in: app, maxSwipes: 8)
        deleteContact.tap()
        let contactDeleteConfirmation = app.staticTexts["删除这个联系人？"]
        XCTAssertTrue(contactDeleteConfirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-dark-contact-delete-confirmation")
        cancelPopoverConfirmation(
            contactDeleteConfirmation, preserving: app.navigationBars["联系人"], in: app
        )
        app.navigationBars["联系人"].buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 5))

        selectTab("短信", in: app)
        let primarySIM = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "S33 Primary SIM")
        ).firstMatch
        XCTAssertTrue(primarySIM.waitForExistence(timeout: 10))
        primarySIM.tap()
        let thread = app.buttons.matching(identifier: "messages.conversation").matching(
            NSPredicate(format: "label CONTAINS %@", "S33 测试联系人甲")
        ).firstMatch
        XCTAssertTrue(thread.waitForExistence(timeout: 10))
        reveal(thread, in: app, maxSwipes: 6)
        thread.swipeLeft()
        let deleteAndBlock = app.buttons["threads.deleteAndBlock"]
        XCTAssertTrue(deleteAndBlock.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["threads.delete"].exists)
        attachAppearanceScreenshots(app, name: "s33-dark-sms-swipe-actions")
        deleteAndBlock.tap()
        let smsDeleteAndBlockConfirmation = app.staticTexts["删除并屏蔽此号码？"]
        XCTAssertTrue(smsDeleteAndBlockConfirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-dark-sms-delete-block-confirmation")
        cancelPopoverConfirmation(
            smsDeleteAndBlockConfirmation, preserving: app.navigationBars["短信"], in: app
        )

        selectTab("记录", in: app)
        XCTAssertTrue(app.navigationBars["记录"].waitForExistence(timeout: 8))
        replaceText(revealSearchField(in: app), with: "2025550111")
        let recorded = app.buttons["records.callDetail"].firstMatch
        XCTAssertTrue(recorded.waitForExistence(timeout: 12))
        reveal(recorded, in: app, maxSwipes: 6)
        recorded.swipeLeft()
        let deleteRecord = app.buttons["records.delete"]
        XCTAssertTrue(deleteRecord.waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-dark-record-delete-swipe")
        deleteRecord.tap()
        let recordDeleteConfirmation = app.staticTexts["删除这条通话记录？"]
        XCTAssertTrue(recordDeleteConfirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-dark-record-delete-confirmation")
        cancelPopoverConfirmation(
            recordDeleteConfirmation, preserving: app.navigationBars["记录"], in: app
        )

        selectTab("设置", in: app)
        let blocklistEntry = app.buttons["settings.blocklist"]
        reveal(blocklistEntry, in: app, maxSwipes: 12)
        blocklistEntry.tap()
        XCTAssertTrue(app.navigationBars["已屏蔽号码"].waitForExistence(timeout: 8))
        let unblock = app.buttons["blocklist.unblock"].firstMatch
        XCTAssertTrue(unblock.waitForExistence(timeout: 8))
        reveal(unblock, in: app, maxSwipes: 6)
        unblock.tap()
        let unblockConfirmation = app.staticTexts["解除屏蔽这个号码？"]
        XCTAssertTrue(unblockConfirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["解除屏蔽"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-dark-settings-unblock-confirmation")
        cancelPopoverConfirmation(
            unblockConfirmation, preserving: app.navigationBars["已屏蔽号码"], in: app
        )
        app.navigationBars["已屏蔽号码"].buttons.firstMatch.tap()

        let macMenu = app.buttons.matching(identifier: "passkey.menu").matching(
            NSPredicate(format: "label CONTAINS %@", "S33 办公 MacBook")
        ).firstMatch
        reveal(macMenu, in: app, maxSwipes: 12)
        macMenu.tap()
        app.buttons["删除"].tap()
        let passkeyDeleteConfirmation = app.staticTexts["删除这个通行密钥？"]
        XCTAssertTrue(passkeyDeleteConfirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-dark-passkey-delete-confirmation")
        cancelPopoverConfirmation(
            passkeyDeleteConfirmation, preserving: app.navigationBars["设置"], in: app
        )

        let power = app.switches["gatewayPower.toggle"].firstMatch
        reveal(power, in: app, maxSwipes: 12)
        XCTAssertEqual(power.value as? String, "1")
        let gatewayDeleteConfirmation = app.staticTexts["关闭 S33 Primary Pixel？"]
        openGatewayPowerOffConfirmation(gatewayDeleteConfirmation, in: app)
        let confirmPowerOff = app.buttons.matching(identifier: "gatewayPower.confirmOff").firstMatch
        XCTAssertTrue(confirmPowerOff.waitForExistence(timeout: 5))
        attachAppearanceScreenshots(app, name: "s33-dark-gateway-close-confirmation")
        cancelPopoverConfirmation(
            gatewayDeleteConfirmation, preserving: app.navigationBars["设置"], in: app
        )

        let logout = app.buttons["退出登录"]
        reveal(logout, in: app, maxSwipes: 12)
        attachAppearanceScreenshots(app, name: "s33-dark-logout-control")
        logout.tap()
        XCTAssertTrue(app.textFields["用户名"].waitForExistence(timeout: 10))
        attachAppearanceScreenshots(app, name: "s33-dark-logged-out")
    }

    // S47: real navigation + persisted draft, never sends an SMS or places a call.
    @MainActor
    func test07RecordSMSPrefillOverridesDraftAndRemainsEditable() async throws {
        _ = try await requireFixture(scenario: "all")
        let app = launchApp()
        ensureLoggedIn(app)
        selectTab("短信", in: app)
        let primary = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "S33 Primary SIM")).firstMatch
        XCTAssertTrue(primary.waitForExistence(timeout: 10))
        primary.tap()
        app.buttons["新短信"].tap()
        let recipient = app.textFields["compose.recipient"]
        // SwiftUI drops the multiline placeholder from AX after text is entered.
        let body = app.textFields.matching(NSPredicate(format: "identifier != %@", "compose.recipient")).firstMatch
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        replaceText(recipient, with: "2025550119")
        finishTextInput(in: app)
        replaceText(body, with: "S47 保留正文")
        finishTextInput(in: app)
        app.buttons["取消"].tap()

        selectTab("记录", in: app)
        replaceText(revealSearchField(in: app), with: "2025550111")
        let searchKey = app.keyboards.buttons["Search"]
        XCTAssertTrue(searchKey.waitForExistence(timeout: 5))
        searchKey.tap()
        XCTAssertTrue(waitUntil(timeout: 3) { !app.keyboards.firstMatch.exists })
        let row = app.buttons["records.callDetail"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 12))
        row.tap()
        XCTAssertTrue(app.buttons["contactActions.sms"].waitForExistence(timeout: 8))
        app.buttons["contactActions.sms"].tap()
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        XCTAssertTrue(waitUntil(timeout: 8) { (recipient.value as? String) == "2025550111" })
        replaceText(recipient, with: "2025550118")
        finishTextInput(in: app)
        // Pushing/popping the native SIM picker must not reseed the edited recipient.
        app.buttons["compose.sim"].tap()
        app.navigationBars.firstMatch.buttons.firstMatch.tap()
        XCTAssertEqual(recipient.value as? String, "2025550118")
        XCTAssertEqual(body.value as? String, "S47 保留正文")
        app.buttons["取消"].tap()

        selectTab("记录", in: app)
        XCTAssertTrue(app.buttons["contactActions.info"].waitForExistence(timeout: 8))
        app.buttons["contactActions.info"].tap()
        XCTAssertTrue(app.buttons["contactCard.sms"].waitForExistence(timeout: 8))
        app.buttons["contactCard.sms"].tap()
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        XCTAssertTrue(waitUntil(timeout: 8) { (recipient.value as? String) == "2025550111" })
        replaceText(recipient, with: "2025550117")
        finishTextInput(in: app)
        XCTAssertEqual(recipient.value as? String, "2025550117")
        attachScreenshot(app, name: "s47-record-sms-prefill-editable")
        app.buttons["取消"].tap()
    }

    @MainActor
    func test08SMSDraftEditsSurviveDelayedSIMLoad() async throws {
        let fixture = try await requireFixture(scenario: "all")
        let app = launchApp()
        ensureLoggedIn(app)
        selectTab("记录", in: app)
        replaceText(revealSearchField(in: app), with: "2025550111")
        let searchKey = app.keyboards.buttons["Search"]
        XCTAssertTrue(searchKey.waitForExistence(timeout: 5))
        searchKey.tap()
        XCTAssertTrue(waitUntil(timeout: 3) { !app.keyboards.firstMatch.exists })
        let row = app.buttons["records.callDetail"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 12))
        row.tap()
        XCTAssertTrue(app.buttons["contactActions.sms"].waitForExistence(timeout: 8))
        // The Messages tab has not loaded SIMs yet. Fail that read while editing the sheet.
        _ = try await fixture.peer(action: "inject.failure", payload: [
            "method": "GET", "path": "/api/v1/sims", "status": 503,
            "code": "S47_SIM_WAIT", "message": "S47 deferred SIM snapshot", "count": 10,
        ])
        app.buttons["contactActions.sms"].tap()
        let recipient = app.textFields["compose.recipient"]
        // SwiftUI drops the multiline placeholder from AX after text is entered.
        let body = app.textFields.matching(NSPredicate(format: "identifier != %@", "compose.recipient")).firstMatch
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        replaceText(recipient, with: "2025550116")
        finishTextInput(in: app)
        replaceText(body, with: "S47 SIM 返回前编辑正文")
        finishTextInput(in: app)
        _ = try await fixture.peer(action: "clearFailures")
        let picker = app.buttons["compose.sim"]
        XCTAssertTrue(waitUntil(timeout: 15) {
            picker.label.contains("S33 Primary SIM") || (picker.value as? String)?.contains("S33 Primary SIM") == true
        })
        XCTAssertEqual(recipient.value as? String, "2025550116")
        XCTAssertEqual(body.value as? String, "S47 SIM 返回前编辑正文")
        attachScreenshot(app, name: "s47-delayed-sim-preserves-edits")
        app.buttons["取消"].tap()
    }

    /// S48: only local fixture contacts and unsent drafts; no SMS or call is submitted.
    @MainActor
    func test09S48BlankComposerMultiContactSelectionAndDraftPreservation() async throws {
        _ = try await requireFixture(scenario: "all")
        let app = launchApp()
        ensureLoggedIn(app)

        selectTab("通讯录", in: app)
        XCTAssertTrue(app.buttons["contacts.new"].waitForExistence(timeout: 10))
        app.buttons["contacts.new"].tap()
        replaceText(app.textFields["显示名称"], with: "S48 第二联系人")
        replaceText(app.textFields["号码"], with: "2025550115")
        finishTextInput(in: app)
        app.buttons["contactEdit.save"].tap()
        XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 10))

        selectTab("短信", in: app)
        let primary = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "S33 Primary SIM")).firstMatch
        XCTAssertTrue(primary.waitForExistence(timeout: 10))
        primary.tap()
        app.buttons["新短信"].tap()
        let recipient = app.textFields["compose.recipient"]
        let body = app.textFields["compose.body"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        XCTAssertTrue((recipient.value as? String) == "" || (recipient.value as? String) == "电话号码")
        replaceText(recipient, with: "2025550119")
        finishTextInput(in: app)
        replaceText(body, with: "S48 取消重开保留正文")
        finishTextInput(in: app)
        app.buttons["compose.cancel"].tap()
        app.buttons["新短信"].tap()
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        XCTAssertTrue((recipient.value as? String) == "" || (recipient.value as? String) == "电话号码")
        XCTAssertEqual(body.value as? String, "S48 取消重开保留正文")

        app.buttons["compose.addContacts"].tap()
        let first = app.buttons.matching(NSPredicate(format: "label == %@", "S33 测试联系人甲，+12025550111")).firstMatch
        let second = app.buttons.matching(NSPredicate(format: "label == %@", "S33 测试联系人甲，+12025550102")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()
        second.tap()
        app.buttons["compose.contacts.cancel"].tap()
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["compose.removeRecipient.+12025550111"].exists, "Cancel committed a pending selection")

        app.buttons["compose.addContacts"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertEqual(first.value as? String, "未选择")
        first.tap()
        second.tap()
        let search = revealSearchField(in: app)
        replaceText(search, with: "第二联系人")
        let third = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "S48 第二联系人，")).firstMatch
        XCTAssertTrue(third.waitForExistence(timeout: 10))
        third.tap()
        XCTAssertEqual(third.value as? String, "已选择")
        // Complete without dismissing native search: the selection actions must stay reachable.
        let pickerDone = app.buttons["compose.contacts.done"]
        XCTAssertTrue(pickerDone.waitForExistence(timeout: 5))
        XCTAssertTrue(pickerDone.isHittable, "Done must remain reachable during active contact search")
        pickerDone.tap()
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["compose.removeRecipient.+12025550111"].exists)
        XCTAssertTrue(app.buttons["compose.removeRecipient.+12025550102"].exists)
        XCTAssertEqual(app.buttons["compose.send"].label, "发送（3）")

        // Manual input equal to an existing chip must not create a fourth recipient.
        replaceText(recipient, with: "+1 202 555 0111")
        finishTextInput(in: app)
        XCTAssertEqual(app.buttons["compose.send"].label, "发送（3）")
        app.buttons["compose.removeRecipient.+12025550102"].tap()
        XCTAssertEqual(app.buttons["compose.send"].label, "发送（2）")

        // Native SIM navigation must preserve the still-editable manual input and selected chips.
        app.buttons["compose.sim"].tap()
        app.navigationBars.firstMatch.buttons.firstMatch.tap()
        XCTAssertEqual(recipient.value as? String, "+1 202 555 0111")
        XCTAssertEqual(app.buttons["compose.send"].label, "发送（2）")
        XCTAssertEqual(body.value as? String, "S48 取消重开保留正文")
        attachScreenshot(app, name: "s48-multiple-recipients-native-composer")
        app.buttons["compose.cancel"].tap()
        app.buttons["新短信"].tap()
        XCTAssertTrue(recipient.waitForExistence(timeout: 8))
        XCTAssertTrue((recipient.value as? String) == "" || (recipient.value as? String) == "电话号码")
        XCTAssertFalse(app.buttons["compose.removeRecipient.+12025550111"].exists)
        XCTAssertEqual(body.value as? String, "S48 取消重开保留正文")
        attachScreenshot(app, name: "s48-new-blank-recipient-retains-body")
        app.buttons["compose.cancel"].tap()
    }

    @MainActor
    private func requireFixture(scenario: String?) async throws -> S33FixtureClient {
        let environment = ProcessInfo.processInfo.environment
        let runnerAPI = environment["VODOG_UI_TEST_API_BASE_URL"] ?? "<missing>"
        let environmentDiagnostic = [
            "api=\(runnerAPI)",
            "realBackend=\(environment["VODOG_UI_TEST_REAL_BACKEND"] ?? "<missing>")",
            "usernamePresent=\(!(environment["TEST_USERNAME_B64"] ?? "").isEmpty)",
            "passwordPresent=\(!(environment["TEST_PASSWORD_B64"] ?? "").isEmpty)",
            "fixtureKeyPresent=\(!(environment["VODOG_UI_TEST_FIXTURE_KEY"] ?? "").isEmpty)",
        ].joined(separator: "; ")
        NSLog("S33 test environment: %@", environmentDiagnostic)
        let diagnosticAttachment = XCTAttachment(string: environmentDiagnostic)
        diagnosticAttachment.name = "s33-runtime-environment-allowlist"
        diagnosticAttachment.lifetime = .keepAlways
        add(diagnosticAttachment)
        try XCTSkipUnless(environment["VODOG_UI_TEST_REAL_BACKEND"] == "1", "Set VODOG_UI_TEST_REAL_BACKEND=1 to run S33 mutations")
        try XCTSkipUnless(runnerAPI == expectedBaseURL,
                          "S33 only accepts the fixed loopback API; runner value was \(runnerAPI)")
        let key = environment["VODOG_UI_TEST_FIXTURE_KEY"] ?? ""
        try XCTSkipIf(key.isEmpty, "VODOG_UI_TEST_FIXTURE_KEY must come from build/s33/private/credentials.json")
        try XCTSkipIf(decodedEnvironmentValue("TEST_USERNAME_B64").isEmpty || decodedEnvironmentValue("TEST_PASSWORD_B64").isEmpty,
                      "S33 login credentials must be injected at runtime")
        let client = S33FixtureClient(key: key)
        let state = try await client.loadState()
        XCTAssertTrue(state.ready)
        XCTAssertEqual(state.fixtureVersion, "s33-v1")
        XCTAssertEqual(state.apiBaseUrl, expectedBaseURL)
        XCTAssertFalse(state.simulation.externalNetworkUsed)
        XCTAssertFalse(state.simulation.realCellularUsed)
        guard state.database == expectedDatabase else {
            throw S33FixtureError.invalidResponse("S33 refused unexpected database identity: \(state.database)")
        }
        guard state.serverFingerprint == expectedServerFingerprint else {
            throw S33FixtureError.invalidResponse("S33 refused unexpected fixture server fingerprint")
        }
        if let scenario { _ = try await client.reset(scenario) }
        return try await client.reloaded()
    }

    private func recordIOSHandoff(
        at url: URL, organization: String, notes: String, simLabel: String,
        createdContactName: String, createdContactPhone: String
    ) throws {
        let data = try Data(contentsOf: url)
        guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw S33FixtureError.invalidResponse("Web handoff JSON is not an object")
        }
        object["ios"] = [
            "contactOrganization": organization,
            "contactNotes": notes,
            "simLabel": simLabel,
            "createdContactName": createdContactName,
            "createdContactPhone": createdContactPhone,
        ]
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
            .write(to: url, options: .atomic)
    }

    @MainActor
    private func launchApp(colorScheme: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        activeApp = app
        activeColorSchemeName = colorScheme
        app.launchEnvironment["VODOG_UI_TEST_API_BASE_URL"] = expectedBaseURL
        app.launchEnvironment["VODOG_UI_TEST_REAL_BACKEND"] = "1"
        app.launchEnvironment["VODOG_UI_TEST_COLOR_SCHEME"] = colorScheme
        app.launchEnvironment["VODOG_UI_TEST_USERNAME"] = decodedEnvironmentValue("TEST_USERNAME_B64")
        app.launchEnvironment["VODOG_UI_TEST_PASSWORD"] = decodedEnvironmentValue("TEST_PASSWORD_B64")
        app.launch()
        return app
    }

    @MainActor
    private func ensureLoggedIn(_ app: XCUIApplication) {
        let username = app.textFields["用户名"]
        // The SIM identity row is visible at the top of Settings while the gateway cards are lazily mounted much
        // farther down. Its fixture device identity is stable even when the shared handoff renames the SIM label.
        let livePrimarySIM = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "PX-33000000-0000-4000-8000-000000000101")
        ).firstMatch
        if app.tabBars.firstMatch.waitForExistence(timeout: 4) {
            selectTab("设置", in: app)
            _ = waitUntil(timeout: 12) { livePrimarySIM.exists || username.exists }
            if livePrimarySIM.exists { return }
        }
        XCTAssertTrue(username.waitForExistence(timeout: 10))
        let login = app.buttons["登录"]
        XCTAssertTrue(waitUntil(timeout: 10) { login.isEnabled })
        login.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 25), "Local password login did not reach main tabs")
        selectTab("设置", in: app)
        XCTAssertTrue(livePrimarySIM.waitForExistence(timeout: 15), "Authenticated local account did not load its primary SIM")
    }

    @MainActor
    private func selectTab(_ label: String, in app: XCUIApplication) {
        let button = app.tabBars.buttons[label]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, maxSwipes: Int = 5) {
        if element.exists, element.isHittable { return }

        if element.exists {
            let viewport = app.windows.firstMatch.frame
            let frame = element.frame
            let isAboveViewport = !frame.isNull && frame.maxY <= viewport.minY + 1
            if isAboveViewport {
                for _ in 0..<maxSwipes {
                    if element.exists, element.isHittable { return }
                    app.swipeDown()
                }
            } else {
                for _ in 0..<maxSwipes {
                    if element.exists, element.isHittable { return }
                    app.swipeUp()
                }
                for _ in 0..<maxSwipes {
                    if element.exists, element.isHittable { return }
                    app.swipeDown()
                }
            }
        } else {
            // Lazy List rows have no frame until mounted. Scan to the bottom, then back to the top, stopping as
            // soon as the requested row becomes both present and tappable.
            for _ in 0..<maxSwipes {
                if element.exists, element.isHittable { return }
                app.swipeUp()
            }
            for _ in 0..<maxSwipes {
                if element.exists, element.isHittable { return }
                app.swipeDown()
            }
        }
        XCTAssertTrue(element.waitForExistence(timeout: 3), "Missing form control \(element)")
        XCTAssertTrue(element.isHittable, "Form control remained off screen \(element)")
    }

    @MainActor
    private func revealStaticEvidence(
        _ element: XCUIElement, in app: XCUIApplication, maxSwipes: Int = 5
    ) {
        if staticEvidenceIsVisible(element, in: app) { return }
        let viewport = evidenceViewport(in: app)
        if element.exists, !element.frame.isNull, element.frame.maxY <= viewport.minY + 1 {
            for _ in 0..<maxSwipes {
                if staticEvidenceIsVisible(element, in: app) { return }
                app.swipeDown()
            }
        } else {
            for _ in 0..<maxSwipes {
                if staticEvidenceIsVisible(element, in: app) { return }
                app.swipeUp()
            }
            for _ in 0..<maxSwipes {
                if staticEvidenceIsVisible(element, in: app) { return }
                app.swipeDown()
            }
        }
        XCTAssertTrue(element.waitForExistence(timeout: 3), "Missing static evidence \(element)")
        XCTAssertTrue(staticEvidenceIsVisible(element, in: app), "Static evidence remained outside the visible list")
    }

    @MainActor
    private func staticEvidenceIsVisible(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        guard element.exists else { return false }
        let frame = element.frame
        guard !frame.isNull, !frame.isInfinite, !frame.isEmpty else { return false }
        let intersection = frame.intersection(evidenceViewport(in: app))
        guard !intersection.isNull, !intersection.isEmpty else { return false }
        let requiredHeight = min(frame.height, 24) * 0.9
        let requiredWidth = min(frame.width, 24) * 0.9
        return intersection.height >= requiredHeight && intersection.width >= requiredWidth
    }

    @MainActor
    private func evidenceViewport(in app: XCUIApplication) -> CGRect {
        let window = app.windows.firstMatch.frame
        let scrollable = app.collectionViews.firstMatch.exists
            ? app.collectionViews.firstMatch : app.scrollViews.firstMatch
        let scrollIntersection = scrollable.exists ? scrollable.frame.intersection(window) : window
        let base = scrollIntersection.isNull || scrollIntersection.isEmpty ? window : scrollIntersection
        var minY = base.minY
        var maxY = base.maxY

        let navigationBar = app.navigationBars.firstMatch
        if navigationBar.exists, navigationBar.frame.intersects(base) {
            minY = max(minY, navigationBar.frame.maxY)
        }
        let tabBar = app.tabBars.firstMatch
        if tabBar.exists, tabBar.frame.intersects(base) {
            maxY = min(maxY, tabBar.frame.minY)
        }
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists, keyboard.frame.intersects(base) {
            maxY = min(maxY, keyboard.frame.minY)
        }

        guard maxY > minY else { return base }
        return CGRect(x: base.minX, y: minY, width: base.width, height: maxY - minY)
    }

    @MainActor
    private func revealPagerControl(_ element: XCUIElement, in app: XCUIApplication, maxSwipes: Int = 55) {
        if element.exists, element.isHittable { return }
        let recordsList = app.collectionViews.firstMatch.exists
            ? app.collectionViews.firstMatch : app.scrollViews.firstMatch
        XCTAssertTrue(recordsList.waitForExistence(timeout: 5), "Records list was not mounted")
        for _ in 0..<maxSwipes {
            if element.exists, element.isHittable { return }
            recordsList.swipeUp()
        }
        XCTAssertTrue(element.waitForExistence(timeout: 3), "Records pager control was not mounted")
        XCTAssertTrue(element.isHittable, "Records pager control remained off screen")
    }

    @MainActor
    private func revealSearchField(in app: XCUIApplication, maxSwipes: Int = 55) -> XCUIElement {
        let search = app.searchFields.firstMatch
        if search.exists, search.isHittable { return search }
        let list = app.collectionViews.firstMatch.exists
            ? app.collectionViews.firstMatch : app.scrollViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 5), "Searchable list was not mounted")
        for _ in 0..<maxSwipes {
            if search.exists, search.isHittable { return search }
            list.swipeDown()
        }
        XCTAssertTrue(search.waitForExistence(timeout: 3), "Pulling down the list did not reveal search")
        XCTAssertTrue(search.isHittable, "Search remained outside the visible list")
        return search
    }

    @MainActor
    private func closeContactSearch(in app: XCUIApplication) {
        let navigationBar = app.navigationBars["通讯录"]
        let close = navigationBar.buttons["Close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "Contacts search mode had no close control")
        close.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { !app.keyboards.firstMatch.exists },
                      "Contacts search keyboard did not dismiss")
        XCTAssertTrue(app.buttons["contacts.new"].waitForExistence(timeout: 5),
                      "Contacts toolbar did not return after closing search")
    }

    @MainActor
    private func enterDialNumber(_ number: String, in app: XCUIApplication) {
        let labels: [Character: String] = [
            "0": "0，+", "1": "1", "2": "2，ABC", "3": "3，DEF", "4": "4，GHI", "5": "5，JKL",
            "6": "6，MNO", "7": "7，PQRS", "8": "8，TUV", "9": "9，WXYZ",
        ]
        let firstKey = app.buttons["1"]
        for _ in 0..<12 {
            if firstKey.exists, firstKey.isHittable { break }
            let numberDisplay = app.buttons["拨号号码"]
            if numberDisplay.exists, numberDisplay.isHittable {
                numberDisplay.tap()
            } else {
                app.swipeDown()
            }
        }
        XCTAssertTrue(firstKey.waitForExistence(timeout: 5), "Dial pad was not mounted")
        XCTAssertTrue(firstKey.isHittable, "Dial pad remained off screen")
        let clear = app.buttons["清除号码"]
        if clear.exists, clear.isEnabled {
            XCTAssertTrue(clear.isHittable, "Clear-number control remained off screen")
            clear.tap()
        }
        for digit in number {
            guard let label = labels[digit] else {
                XCTFail("S33 dial fixture contains an unsupported keypad character")
                return
            }
            let key = app.buttons[label]
            XCTAssertTrue(key.waitForExistence(timeout: 3), "Missing dial key \(label)")
            key.tap()
        }
    }

    @MainActor
    private func revealSIM(_ element: XCUIElement, in app: XCUIApplication, towardTrailing: Bool) {
        if element.exists, element.isHittable { return }
        let strip = app.scrollViews["sim.strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 5), "SIM strip was not mounted")
        for _ in 0..<4 {
            if element.exists, element.isHittable { return }
            if towardTrailing { strip.swipeLeft() } else { strip.swipeRight() }
        }
        XCTAssertTrue(element.waitForExistence(timeout: 3), "Requested SIM was not mounted")
        XCTAssertTrue(element.isHittable, "Requested SIM remained outside the visible strip")
    }

    @MainActor
    private func waitForFixtureCall(
        _ fixture: S33FixtureClient, simID: String, remoteNumber: String,
        expectedState: String, timeout: TimeInterval = 15
    ) async throws -> S33CallLookupResponse {
        let deadline = Date().addingTimeInterval(timeout)
        var lastObservation = "not found"
        while Date() < deadline {
            do {
                let response = try await fixture.lookupCall(simID: simID, remoteNumber: remoteNumber)
                lastObservation = response.call.state
                if response.call.state == expectedState { return response }
            } catch {
                lastObservation = error.localizedDescription
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        throw S33FixtureError.invalidResponse(
            "Call \(remoteNumber) did not reach \(expectedState); last observation: \(lastObservation)"
        )
    }

    @MainActor
    private func dismissSheet(named title: String, in app: XCUIApplication) {
        let navigationBar = app.navigationBars[title]
        XCTAssertTrue(navigationBar.waitForExistence(timeout: 5), "Missing \(title) sheet")
        let done = app.buttons["records.sheetDone"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "Missing explicit close control for \(title)")
        done.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { !navigationBar.exists }, "\(title) sheet did not dismiss")
    }

    @MainActor
    private func cancelPopoverConfirmation(
        _ confirmationMarker: XCUIElement, preserving pageMarker: XCUIElement, in app: XCUIApplication
    ) {
        let cancel = app.buttons["取消"]
        if cancel.exists, cancel.isHittable {
            cancel.tap()
        } else {
            // Compact-width confirmation popovers can omit an explicit Cancel button. The first outside tap is
            // consumed by the popover; use the far-left navigation-bar edge, away from the destructive action.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.08)).tap()
        }
        XCTAssertTrue(waitUntil(timeout: 5) { !confirmationMarker.exists }, "Destructive confirmation did not close")
        XCTAssertTrue(pageMarker.exists, "Cancelling the destructive confirmation left its source page")
    }

    @MainActor
    private func openGatewayPowerOffConfirmation(
        _ confirmationMarker: XCUIElement, in app: XCUIApplication
    ) {
        for attempt in 0...1 {
            // Foreground polling can replace a SwiftUI ForEach row between discovery and the synthesized tap.
            // Resolve the sole enabled gateway switch immediately before each attempt and target the current
            // trailing thumb geometry rather than retaining its unlabelled UIKit child.
            let current = app.switches.matching(identifier: "gatewayPower.toggle")
                .matching(NSPredicate(format: "enabled == true")).firstMatch
            guard current.waitForExistence(timeout: 3), current.isHittable else {
                XCTFail("Primary gateway switch was unavailable immediately before the power-off tap")
                return
            }
            XCTAssertTrue(app.staticTexts["S33 Primary Pixel"].exists, "The enabled switch was not the primary gateway row")
            current.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
            if confirmationMarker.waitForExistence(timeout: 3) {
                NSLog("S33 gateway close confirmation opened on attempt %d", attempt + 1)
                return
            }

            let refreshed = app.switches.matching(identifier: "gatewayPower.toggle")
                .matching(NSPredicate(format: "enabled == true")).firstMatch
            let pending = app.staticTexts["已请求关闭，等待网关响应…"]
            guard attempt == 0,
                  refreshed.exists,
                  refreshed.isEnabled,
                  (refreshed.value as? String) == "1",
                  !pending.exists,
                  !confirmationMarker.exists,
                  app.staticTexts["S33 Primary Pixel"].exists else {
                XCTFail("Gateway switch tap neither opened confirmation nor remained safely retryable")
                return
            }
            NSLog("S33 gateway close confirmation tap was not delivered; retrying once against the current thumb")
        }
        XCTFail("Gateway close confirmation did not open after one bounded retry")
    }

    @MainActor
    private func replaceText(_ element: XCUIElement, with value: String) {
        XCTAssertTrue(element.waitForExistence(timeout: 8), "Missing text field \(element)")
        element.tap()
        let old = element.value as? String ?? ""
        element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: max(old.count, 64)))
        element.typeText(value)
    }

    @MainActor
    private func openExactContactSearchResult(_ row: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(row.waitForExistence(timeout: 8), "Exact contact search result was unavailable")
        XCTAssertTrue(row.isHittable, "Exact contact search result was not hittable")
        row.tap()

        let detail = app.navigationBars["联系人"]
        if detail.waitForExistence(timeout: 2) { return }

        let stillInSearchResults = app.navigationBars["通讯录"].exists && row.exists && row.isHittable
        let keyboardDismissed = waitUntil(timeout: 2) { !app.keyboards.firstMatch.exists }
        XCTAssertTrue(stillInSearchResults && keyboardDismissed,
                      "Contact result tap neither navigated nor left a safe exact-result retry state")
        guard stillInSearchResults, keyboardDismissed else { return }

        NSLog("S33 exact contact result first tap dismissed search input; retrying once")
        row.tap()
        XCTAssertTrue(detail.waitForExistence(timeout: 8),
                      "Exact contact result did not open after one bounded keyboard-dismiss retry")
    }

    @MainActor
    private func finishTextInput(in app: XCUIApplication) {
        let done = app.buttons["keyboard.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "The shared keyboard Done control was unavailable")
        done.tap()
        XCTAssertTrue(waitUntil(timeout: 3) { !app.keyboards.firstMatch.exists },
                      "The software keyboard did not dismiss")
    }

    @MainActor
    private func attachScreenshot(_ app: XCUIApplication, name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "vodog-s33-ui", isDirectory: true
        )
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let screenshotURL = directory.appendingPathComponent("\(name).png")
            try screenshot.pngRepresentation.write(to: screenshotURL, options: .atomic)
            NSLog("S33 UI evidence screenshot: %@", screenshotURL.path)
        } catch {
            NSLog("Could not persist S33 UI evidence screenshot: %@", error.localizedDescription)
        }
    }

    @MainActor
    private func attachAppearanceScreenshots(_ app: XCUIApplication, name: String) {
        // The color scheme is fixed before launch. Changing XCUIDevice.appearance while a confirmation is open
        // does not update this process reliably and used to produce two light screenshots with misleading names.
        attachScreenshot(app, name: "\(name)-\(activeColorSchemeName)")
    }

    @MainActor
    private static func writeDebugSnapshot(_ app: XCUIApplication, name: String) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "vodog-s33-ui", isDirectory: true
        )
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let screenshotURL = directory.appendingPathComponent("\(name).png")
            let hierarchyURL = directory.appendingPathComponent("\(name)-hierarchy.txt")
            try app.screenshot().pngRepresentation.write(to: screenshotURL, options: .atomic)
            try app.debugDescription.write(to: hierarchyURL, atomically: true, encoding: .utf8)
            NSLog("S33 UI diagnostic screenshot: %@", screenshotURL.path)
            NSLog("S33 UI diagnostic hierarchy: %@", hierarchyURL.path)
        } catch {
            NSLog("Could not persist S33 UI diagnostics: %@", error.localizedDescription)
        }
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval, _ predicate: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
        }
        return predicate()
    }

    private func decodedEnvironmentValue(_ key: String) -> String {
        guard let encoded = ProcessInfo.processInfo.environment[key],
              let data = decodedEnvironmentData(encoded) else { return "" }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func decodedEnvironmentData(_ value: String) -> Data? {
        var encoded = value
        encoded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        return Data(base64Encoded: encoded)
    }
}

private struct S33FixtureClient: Sendable {
    let key: String
    var state: S33FixtureState

    init(key: String, state: S33FixtureState? = nil) {
        self.key = key
        self.state = state ?? .empty
    }

    func reloaded() async throws -> S33FixtureClient {
        S33FixtureClient(key: key, state: try await loadState())
    }

    func loadState() async throws -> S33FixtureState {
        try await request(path: "state", method: "GET", body: Optional<S33FixtureCommand>.none)
    }

    func reset(_ scenario: String) async throws -> S33FixtureResetResponse {
        try await request(path: "reset", method: "POST", body: S33FixtureCommand(scenario: scenario))
    }

    func peer(action: String, id: String? = nil, payload: [String: S33JSONValue] = [:]) async throws -> S33JSONValue {
        let noContentResponse: S33JSONValue? = ["contact.delete", "call.delete", "blocklist.remove"].contains(action)
            ? .null
            : nil
        return try await request(
            path: "peer",
            method: "POST",
            body: S33FixtureCommand(action: action, id: id, payload: payload),
            noContentResponse: noContentResponse
        )
    }

    func lookupCall(simID: String, remoteNumber: String) async throws -> S33CallLookupResponse {
        try await request(
            path: "peer", method: "POST",
            body: S33FixtureCommand(
                action: "call.lookup", id: nil,
                payload: ["simId": S33JSONValue(simID), "remoteNumber": S33JSONValue(remoteNumber)]
            )
        )
    }

    private func request<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        path: String, method: String, body: Body?, noContentResponse: Response? = nil
    ) async throws -> Response {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:16880/__s33/\(path)")!)
        request.httpMethod = method
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" { request.setValue(key, forHTTPHeaderField: "x-s33-fixture-key") }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw S33FixtureError.invalidResponse(String(decoding: data, as: UTF8.self))
        }
        if http.statusCode == 204, let noContentResponse {
            return noContentResponse
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

private struct S33FixtureCommand: Encodable, Sendable {
    var scenario: String?
    var action: String?
    var owner: String?
    var id: String?
    var payload: [String: S33JSONValue]?

    init(scenario: String) { self.scenario = scenario }
    init(action: String, id: String?, payload: [String: S33JSONValue]) {
        self.action = action; owner = "owner1"; self.id = id; self.payload = payload
    }
}

private struct S33FixtureResetResponse: Decodable, Sendable { let reset: String; let state: S33FixtureState }

private struct S33WebHandoff: Decodable, Sendable {
    struct Snapshot: Decodable, Sendable {
        let organization, notes, simLabel, provider: String
    }
    struct IOSSnapshot: Decodable, Sendable {
        struct CreatedContact: Decodable, Sendable { let displayName, phone: String }
        let organization, notes, simLabel, provider: String
        let createdContact: CreatedContact
    }
    struct AndroidSnapshot: Decodable, Sendable {
        let organization, notes, simLabel, provider, handoffContactOrganization: String
    }
    struct Expected: Decodable, Sendable {
        let web: Snapshot
        let ios: IOSSnapshot
        let android: AndroidSnapshot
    }
    let marker: String
    let contactId: String
    let simId: String
    let expected: Expected
}

private struct S33CallLookupResponse: Decodable, Sendable {
    struct Call: Decodable, Sendable {
        struct SessionOwner: Decodable, Sendable {
            let kind: String
            let present: Bool
            let platform: String?
            let device: String?
        }
        let id: String
        let state: String
        let direction: String
        let generation: Int
        let simId: String
        let remoteNumber: String
        let failureReason: String?
        let endedAt: String?
        let sessionOwner: SessionOwner
    }
    let call: Call
}

private struct S33FixtureState: Decodable, Sendable {
    struct IDs: Decodable, Sendable {
        struct Contacts: Decodable, Sendable { let primary: String }
        struct Calls: Decodable, Sendable { let recorded, ai, active, failedReport: String }
        struct SIMs: Decodable, Sendable { let primary, secondary, unavailable: String }
        struct Gateways: Decodable, Sendable { let primary, unavailable: String }
        let contacts: Contacts
        let calls: Calls
        let sims: SIMs
        let gateways: Gateways
    }
    struct Simulation: Decodable, Sendable {
        let validLoopbackWebRtcBridge: Bool
        let loopbackTurnRelay: Bool
        let temporaryBrowserProbeTrustRequired: Bool
        let externalNetworkUsed: Bool
        let realCellularUsed: Bool
    }
    struct RequestCounters: Decodable, Sendable { let outboundCallRequests: Int }
    let ready: Bool
    let fixtureVersion: String
    let serverFingerprint: String
    let apiBaseUrl: String
    let database: String
    let mediaMode: String
    let ids: IDs
    let requestCounters: RequestCounters
    let simulation: Simulation

    static let empty = S33FixtureState(
        ready: false, fixtureVersion: "", serverFingerprint: "", apiBaseUrl: "", database: "", mediaMode: "", ids: .init(
            contacts: .init(primary: ""), calls: .init(recorded: "", ai: "", active: "", failedReport: ""),
            sims: .init(primary: "", secondary: "", unavailable: ""),
            gateways: .init(primary: "", unavailable: "")
        ), requestCounters: .init(outboundCallRequests: 0), simulation: .init(
            validLoopbackWebRtcBridge: false, loopbackTurnRelay: false,
            temporaryBrowserProbeTrustRequired: false, externalNetworkUsed: true, realCellularUsed: true
        )
    )
}

private indirect enum S33JSONValue: Codable, Sendable, ExpressibleByStringLiteral,
    ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral {
    case string(String), int(Int), double(Double), bool(Bool), array([S33JSONValue])
    case object([String: S33JSONValue]), null

    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .int(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Int.self) { self = .int(value) }
        else if let value = try? container.decode(Double.self) { self = .double(value) }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode([S33JSONValue].self) { self = .array(value) }
        else if let value = try? container.decode([String: S33JSONValue].self) { self = .object(value) }
        else if container.decodeNil() { self = .null }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported S33 JSON value") }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

private enum S33FixtureError: LocalizedError { case invalidResponse(String) }

private extension Dictionary where Key == String, Value == S33JSONValue {
    init(_ values: [String: String]) { self = values.mapValues(S33JSONValue.string) }
}

private extension S33JSONValue {
    init(_ value: String) { self = .string(value) }
    init(_ value: Int) { self = .int(value) }
    init(_ value: Bool) { self = .bool(value) }
}
