package org.vodog

import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.SystemClock
import android.security.NetworkSecurityPolicy
import android.system.Os
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.click
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runner.Description
import org.junit.rules.RuleChain
import org.junit.rules.TestWatcher

/**
 * S33 uses the real app and real Control routes. Only reset/peer orchestration goes through the
 * fixture-only endpoints. Run this against the opt-in `.s33` package with an adb reverse; the
 * checked build gate prevents these tests from ever pointing at a non-loopback host.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class S33BusinessJourneyTest {
    val compose = createAndroidComposeRule<MainActivity>()
    private val failureDiagnostics = object : TestWatcher() {
        override fun failed(error: Throwable, description: Description) {
            captureFailureDiagnostics(error, description)
        }
    }

    // The watcher is inside the Compose rule so it captures the live Activity before teardown.
    @get:Rule
    val rules: RuleChain = RuleChain.outerRule(compose).around(failureDiagnostics)

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val arguments get() = InstrumentationRegistry.getArguments()
    private lateinit var fixture: S33FixtureControl
    private lateinit var fixtureUsername: String
    private lateinit var fixturePassword: String
    private lateinit var s33Mode: String
    private lateinit var privateInput: JSONObject

    @Before
    fun verifyDedicatedAcceptanceBuild() {
        assertTrue("Instrumentation requires -Ps33UiTest=true", BuildConfig.S33_UI_TEST)
        assertEquals("http://127.0.0.1:16880/api/v1", BuildConfig.API_BASE_URL)
        assertEquals("org.vodog.s33", instrumentation.targetContext.packageName)
        assertTrue(NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted("127.0.0.1"))
        assertFalse(NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted("control.example.com"))
        assertEquals("[]", instrumentation.targetContext.getString(R.string.asset_statements))
        val appInfo = instrumentation.targetContext.packageManager.getApplicationInfo(
            instrumentation.targetContext.packageName,
            PackageManager.GET_META_DATA,
        )
        assertFalse(appInfo.metaData.getBoolean("firebase_messaging_auto_init_enabled", true))
        privateInput = loadPrivateInput()
        fixture = S33FixtureControl(privateInput.getString("fixtureKey"))
        val owner1 = privateInput.getJSONObject("accounts").getJSONObject("owner1")
        fixtureUsername = owner1.getString("username")
        fixturePassword = owner1.getString("password")
        s33Mode = requireNotNull(arguments.getString("s33Mode")) {
            "Pass -e s33Mode full or -e s33Mode handoff"
        }.also { require(it == "full" || it == "handoff") { "s33Mode must be full or handoff" } }
        val state = fixture.state()
        assertEquals("s33-v1", state.getString("fixtureVersion"))
        assertEquals(
            "ca16f103d8de6e43406acde471934d6bd46a0a5fa57acff481c5dfcc14d44381",
            state.getString("serverFingerprint"),
        )
        assertEquals(BuildConfig.API_BASE_URL, state.getString("apiBaseUrl"))
        assertEquals("basic", state.getString("mediaMode"))
        val simulation = state.getJSONObject("simulation")
        assertFalse(simulation.getBoolean("externalNetworkUsed"))
        assertFalse(simulation.getBoolean("validLoopbackWebRtcBridge"))
        assertFalse(simulation.getBoolean("loopbackTurnRelay"))
        assertFalse(simulation.getBoolean("temporaryBrowserProbeTrustRequired"))
    }

    @Test
    fun passwordLoginSessionRestoreLogoutAndEveryTab() {
        requireFullJourney()
        reset("all")
        signOutIfNeeded()
        login()

        listOf(
            "call" to "电话",
            "sms" to "短信",
            "history" to "记录",
            "contacts" to "通讯录",
            "settings" to "设置",
        ).forEach { (tag, title) ->
            compose.onNodeWithTag("tab.$tag", useUnmergedTree = true).performClick().assertIsSelected()
            waitForText(title)
        }

        compose.activityRule.scenario.recreate()
        waitForTag("workspace")
        compose.onNodeWithTag("workspace", useUnmergedTree = true).assertIsDisplayed()

        val device = UiDevice.getInstance(instrumentation)
        device.pressHome()
        device.waitForIdle()
        val intent = instrumentation.targetContext.packageManager
            .getLaunchIntentForPackage(instrumentation.targetContext.packageName)!!
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        instrumentation.targetContext.startActivity(intent)
        waitForTag("workspace")
        signOutIfNeeded()
        waitForTag("login.screen")
        captureEvidence("01-auth-session-logout")
    }

    @Test
    fun callsTabUnavailablePreflightThenPrimaryOutboundEndAndRejected() {
        requireFullJourney()
        reset("all")
        // The deterministic active call occupies the unavailable gateway. End it through the real
        // gateway-event route first so the unavailable-SIM assertion isolates readiness preflight.
        fixture.peer(
            "gateway.callEvent",
            id = S33Ids.CALL_ACTIVE,
            payload = callEvent(generation = 34, state = "ended"),
        )
        ensureLoggedIn()
        assertNativeMediaProbeUnavailable()
        openTab("call")
        waitForTag("sim.picker.${S33Ids.SIM_UNAVAILABLE}")

        val firstNumber = "0900000066"
        fixture.peer("requestCounters.reset")
        assertEquals(0, outboundCallRequestCount())
        selectSim(S33Ids.SIM_UNAVAILABLE)
        waitForText("号码设备离线时，请在对应 Pixel 手机上重新开启 VoDog。")
        enterDialNumber(firstNumber)
        val unavailableDial = compose.onNodeWithContentDescription(
            "使用+886 900 000 003拨打",
            useUnmergedTree = false,
        )
        unavailableDial.assertIsNotEnabled().performTouchInput { click() }
        compose.waitForIdle()
        assertEquals("disabled unavailable-SIM dial must not reach /calls/outbound", 0, outboundCallRequestCount())
        captureEvidence("01-calls-unavailable-preflight")

        selectSim(S33Ids.SIM_PRIMARY)
        val primaryDial = compose.onNodeWithContentDescription(
            "使用+886 900 000 001拨打",
            useUnmergedTree = false,
        )
        primaryDial.assertIsEnabled().performClick()
        waitForText("拨号已提交，正在等待 Pixel 的手机线路接通")
        val firstCall = awaitFixtureCall(S33Ids.SIM_PRIMARY, firstNumber)
        assertOutboundOwnedByAndroid(firstCall)
        assertEquals(1, outboundCallRequestCount())
        fixture.peer("gateway.ackLatest", id = S33Ids.GATEWAY_PRIMARY)
        fixture.peer(
            "gateway.callEvent",
            id = firstCall.getString("id"),
            payload = callEvent(generation = 33, state = "active"),
        )
        waitForText("通话中")
        waitForText("当前登录会话", substring = true)
        compose.onNodeWithTag("call.fullscreen").assertIsDisplayed()
        val duration = compose.onNodeWithTag("call.duration")
        duration.assertIsDisplayed()
        val initialDuration = duration.fetchSemanticsNode().config[SemanticsProperties.ContentDescription]
        compose.waitUntil(10_000) {
            duration.fetchSemanticsNode().config[SemanticsProperties.ContentDescription] != initialDuration
        }
        compose.onNodeWithContentDescription("最小化通话").assertIsDisplayed().performClick()
        compose.waitUntil(10_000) { compose.onNodeWithTag("call.restore").isDisplayed() }
        compose.onNodeWithTag("call.restore").assertIsEnabled().performClick()
        compose.waitUntil(10_000) { compose.onNodeWithTag("call.fullscreen").isDisplayed() }
        compose.onNodeWithTag("call.fullscreen").assertIsDisplayed()
        captureEvidence("01-call-end-action")
        clickText("结束通话")
        waitForText("结束请求已提交")
        val ending = awaitFixtureCallState(S33Ids.SIM_PRIMARY, firstNumber, "ending")
        assertTrue(ending.isNull("endedAt"))
        compose.onNodeWithTag("call.end").assertIsDisplayed().assertIsNotEnabled()
        captureEvidence("01-call-end-pending")
        fixture.peer("gateway.ackLatest", id = S33Ids.GATEWAY_PRIMARY)
        fixture.peer(
            "gateway.callEvent",
            id = firstCall.getString("id"),
            payload = callEvent(generation = 33, state = "ended"),
        )
        val ended = awaitFixtureCallState(S33Ids.SIM_PRIMARY, firstNumber, "ended")
        assertEquals("ended", ended.getString("state"))
        assertTrue(ended.optString("endedAt").isNotBlank() && ended.optString("endedAt") != "null")
        waitForContentDescription("清除号码")

        compose.onNodeWithContentDescription("清除号码", useUnmergedTree = false).performClick()
        val rejectedNumber = "0900000067"
        enterDialNumber(rejectedNumber)
        compose.onNodeWithContentDescription("使用+886 900 000 001拨打", useUnmergedTree = false)
            .assertIsEnabled().performClick()
        val rejectedCall = awaitFixtureCall(S33Ids.SIM_PRIMARY, rejectedNumber)
        assertOutboundOwnedByAndroid(rejectedCall)
        assertEquals(2, outboundCallRequestCount())
        fixture.peer(
            "gateway.ackLatest",
            id = S33Ids.GATEWAY_PRIMARY,
            payload = JSONObject()
                .put("status", "rejected")
                .put("result", JSONObject().put("reason", "virtual_radio_rejected")),
        )
        fixture.peer(
            "gateway.callEvent",
            id = rejectedCall.getString("id"),
            payload = callEvent(
                generation = 33,
                state = "failed",
                failureReason = "virtual_radio_rejected",
            ),
        )
        val failed = awaitFixtureCallState(S33Ids.SIM_PRIMARY, rejectedNumber, "failed")
        assertEquals("virtual_radio_rejected", failed.getString("failureReason"))
        assertTrue(failed.optString("endedAt").isNotBlank() && failed.optString("endedAt") != "null")
        // Pull the terminal call through the same user-visible refresh action, then locate that exact
        // dynamic call by id. The UI intentionally retains the raw number entered by the user.
        // The authoritative failure reaches the app through polling; the modal correctly hides
        // underlying controls until that update dismisses it. Wait for the visible user action.
        compose.waitUntil(15_000) {
            compose.onNodeWithContentDescription("刷新通话", useUnmergedTree = false).isDisplayed()
        }
        compose.onNodeWithContentDescription("刷新通话", useUnmergedTree = false)
            .assertIsDisplayed().performClick()
        val callList = compose.onNodeWithTag("calls.list", useUnmergedTree = true)
        val failedRowTag = "calls.recent.${rejectedCall.getString("id")}"
        callList.performScrollToNode(hasText("最近通话"))
        compose.waitUntil(15_000) { nodesWithTag(failedRowTag) == 1 }
        callList.performScrollToNode(hasTestTag(failedRowTag))
        val failedRow = hasTestTag(failedRowTag) and
            hasAnyDescendant(hasText(rejectedNumber)) and
            hasAnyDescendant(hasText("+886 900 000 001 · 失败"))
        compose.onNode(failedRow, useUnmergedTree = true).assertIsDisplayed()
        captureEvidence("01-calls-outbound-ended-rejected")
    }

    @Test
    fun contactsFullFieldsCasReloadDeleteAndCardFailureRetention() {
        requireFullJourney()
        reset("all")
        ensureLoggedIn()
        openTab("contacts")

        compose.onNodeWithTag("contacts.create", useUnmergedTree = true).performClick()
        fillContactEditor(
            name = "S33 Android Full",
            familyName = "安",
            givenName = "卓",
            organization = "Android Fixture Ltd",
            phone = "0900000088",
            email = "android-full@s33.test",
            address = "台北市 S33 Android 路 8 号",
            notes = "S33 Android full-field create",
        )
        compose.onNodeWithTag("contact.save", useUnmergedTree = true).performClick()
        waitForText("S33 Android Full")
        clickText("S33 Android Full")
        waitForText("Android Fixture Ltd")
        waitForText("android-full@s33.test")
        waitForText("台北市 S33 Android 路 8 号")
        waitForText("S33 Android full-field create")

        compose.onNodeWithTag("contact.edit", useUnmergedTree = true).performClick()
        replace("contact.organization", "Android Fixture Ltd v2")
        replace("contact.notes", "S33 Android full-field edit")
        compose.onNodeWithTag("contact.save", useUnmergedTree = true).performClick()
        waitForText("Android Fixture Ltd v2")
        waitForText("S33 Android full-field edit")
        compose.onNodeWithTag("contact.delete", useUnmergedTree = true).performClick()
        captureEvidence("02-contact-delete-confirm")
        compose.onNodeWithTag("contact.delete.confirm", useUnmergedTree = true).performClick()
        waitUntilGone("S33 Android Full")

        clickText("S33 林美玲")
        compose.onNodeWithTag("contact.edit", useUnmergedTree = true).performClick()
        replace("contact.notes", "Android stale draft must survive")
        // Close the IME before racing the peer mutation against Save. On API 36 the open keyboard
        // can otherwise consume the first physical dismissal while leaving the editor untouched.
        UiDevice.getInstance(instrumentation).pressBack()
        compose.waitForIdle()
        compose.onNodeWithTag("contact.editor", useUnmergedTree = true).assertIsDisplayed()
        val device = UiDevice.getInstance(instrumentation)
        fixture.peer("requestCounters.reset")
        fixture.peer(
            action = "contact.update",
            id = S33Ids.CONTACT_PRIMARY,
            payload = JSONObject().put("organization", "S33 Peer Organization"),
        )
        val staleBaseline = contactUpdateCounters()
        assertEquals(1, staleBaseline.first)
        assertEquals(200, staleBaseline.second)
        // Invoke the tagged Compose click action after the peer update. The conflict dialog is then
        // handled through UiAutomator because stacked dialogs can keep the Espresso link busy.
        compose.onNodeWithTag("contact.save", useUnmergedTree = true)
            .assertIsEnabled()
            .performClick()
        awaitContactUpdateCounters(count = staleBaseline.first + 1, status = 409)
        // The server counter can lead the client coroutine by a frame. Do not query Compose
        // semantics once the stacked AlertDialog begins mounting: Espresso waits for that modal's
        // tree to become idle and can deadlock. Advance frames directly while UiAutomator observes
        // the real confirmation instead.
        val conflictDeadline = SystemClock.uptimeMillis() + 10_000
        var keepDraft = device.findObject(By.text("保留草稿"))
        while (keepDraft == null && SystemClock.uptimeMillis() < conflictDeadline) {
            compose.mainClock.advanceTimeByFrame()
            keepDraft = device.wait(Until.findObject(By.text("保留草稿")), 100)
        }
        val keepDraftButton = checkNotNull(keepDraft) { "联系人冲突确认未显示" }
        assertTrue("保留草稿必须可操作", keepDraftButton.isEnabled)
        keepDraftButton.click()
        repeat(2) { compose.mainClock.advanceTimeByFrame() }
        waitForText("联系人已在另一端更新", substring = true)
        compose.onNodeWithTag("contact.notes", useUnmergedTree = true)
            .assertTextContains("Android stale draft must survive")
        waitForEnabledTag("contact.loadLatest")
        compose.onNodeWithTag("contact.loadLatest", useUnmergedTree = true)
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithTag("contact.organization", useUnmergedTree = true)
                    .assertTextContains("S33 Peer Organization")
                true
            }.getOrDefault(false)
        }
        compose.onNodeWithTag("contact.editor", useUnmergedTree = true).assertIsDisplayed()

        // The network-failure half of the regression: an editor entered from the actual card must
        // keep both the draft and the card open until the mutation succeeds.
        clickText("取消")
        UiDevice.getInstance(instrumentation).pressBack()
        openTab("history")
        compose.onNodeWithTag("history.view.interceptions", useUnmergedTree = true).performClick()
        waitForText("S33 intercepted SMS", substring = true)
        compose.onNodeWithTag("interception.row.${S33Ids.INTERCEPTION_SECONDARY}", useUnmergedTree = true)
            .performClick()
        waitForText("添加到现有联系人")
        clickText("添加到现有联系人")
        fixture.injectFailure(
            "POST",
            "/api/v1/contacts/${S33Ids.CONTACT_PRIMARY}/phones",
            "S33_CONTACT_ATTACH_FAILED",
            "S33 添加号码模拟失败",
        )
        clickText("加到「S33 林美玲」")
        waitForText("S33 添加号码模拟失败")
        waitForText("加到「S33 林美玲」")
        fixture.clearFailures()
        clickText("加到「S33 林美玲」")
        waitUntilGone("添加到现有联系人", timeoutMs = 15_000)

        compose.onNodeWithTag("interception.row.${S33Ids.INTERCEPTION_SMS_PRIMARY}", useUnmergedTree = true)
            .performClick()
        waitForText("新建联系人")
        clickText("新建联系人")
        replace("contact.name", "S33 Card Retry")
        fixture.injectFailure("POST", "/api/v1/contacts", "S33_CONTACT_CREATE_FAILED", "S33 联系人创建模拟失败")
        compose.onNodeWithTag("contact.save", useUnmergedTree = true).performClick()
        waitForText("S33 联系人创建模拟失败")
        compose.onNodeWithTag("contact.editor", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("contact.name", useUnmergedTree = true).assertTextContains("S33 Card Retry")
        fixture.clearFailures()
        compose.onNodeWithTag("contact.save", useUnmergedTree = true).performClick()
        waitUntilGone("S33 Card Retry", timeoutMs = 15_000)
        captureEvidence("02-contacts-card-retry")
    }

    @Test
    fun smsPartialDeleteKeepsInflightAndDeleteBlockRetriesOnlySecondStep() {
        requireFullJourney()
        reset("all")
        ensureLoggedIn()
        openTab("sms")
        waitForText("S33 发送中，删除应跳过")
        compose.onAllNodesWithTag("threads.row", useUnmergedTree = true).onFirst().performClick()
        waitForText("S33 已送达")

        compose.onNodeWithText("S33 已送达", useUnmergedTree = false).performTouchInput { longClick() }
        compose.onNodeWithTag("conversation.bubble.menu.multiSelect", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("conversation.selectAll", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("conversation.deleteSelected", useUnmergedTree = true).performClick()
        captureEvidence("03-sms-delete-confirm")
        compose.onNodeWithTag("conversation.delete.confirm", useUnmergedTree = true).performClick()
        waitForText("2 条短信正在发送中，暂时不能删除")
        waitForText("S33 排队中，删除应跳过")
        waitForText("S33 发送中，删除应跳过")
        captureEvidence("03-sms-inflight-retry")
        waitUntilGone("S33 已送达")

        val longBody = "S33 Android long message " + "验收内容".repeat(80)
        compose.onNodeWithTag("sms.reply.body", useUnmergedTree = true).performTextInput(longBody)
        compose.onNodeWithTag("sms.reply.send", useUnmergedTree = true).performClick()
        waitForText("S33 Android long message", substring = true)

        compose.onNodeWithContentDescription("返回短信", useUnmergedTree = false).performClick()
        waitForTag("threads.row")
        // The partial-delete half deliberately leaves its queued/sending rows, and the long-message
        // send adds a third in-flight row. Restore the canonical two-in-flight fixture before the
        // independent delete+block retry half, matching the Web/iOS acceptance sequence.
        reset("sms")
        waitUntilGone("S33 Android long message")
        waitForText("S33 发送中，删除应跳过")
        fixture.injectFailure(
            "POST",
            "/api/v1/sms/threads/delete",
            "S33_THREAD_DELETE_FAILED",
            "S33 对话删除模拟失败",
        )
        compose.onAllNodesWithTag("threads.row", useUnmergedTree = true).onFirst()
            .performTouchInput { longClick() }
        compose.onNodeWithTag("threads.menu.deleteAndBlock", useUnmergedTree = true).performClick()
        captureEvidence("03-sms-delete-and-block-confirm")
        compose.onNodeWithTag("threads.delete.confirm", useUnmergedTree = true).performClick()
        waitForText("号码已屏蔽，但对话删除失败，请重试")
        fixture.clearFailures()
        compose.onAllNodesWithTag("threads.row", useUnmergedTree = true).onFirst()
            .performTouchInput { longClick() }
        compose.onNodeWithTag("threads.menu.delete", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("threads.delete.confirm", useUnmergedTree = true).performClick()
        waitForText("2 条短信正在发送中，暂时不能删除")
        compose.onAllNodesWithTag("threads.row", useUnmergedTree = true).onFirst().performClick()
        waitForText("S33 排队中，删除应跳过")
        waitForText("S33 发送中，删除应跳过")
    }

    /** S48: local fixture contacts, staged multi-contact selection, and unsent drafts; no send/dial. */
    @Test
    fun s48NewSmsEmptyRecipientsPreservesBodyAndPickerCancelDone() {
        requireFullJourney()
        reset("all")
        ensureLoggedIn()
        // Use the real contact editor against the required loopback S33 fixture only.
        openTab("contacts")
        waitForTag("contacts.create")
        compose.onNodeWithTag("contacts.create", useUnmergedTree = true).performClick()
        replace("contact.name", "S48 Android Second")
        replace("contact.phone.0", "0900000088")
        // Dialog actions are fixed outside the scrolling form and remain above the IME.
        compose.onNodeWithTag("contact.save", useUnmergedTree = true)
            .assertIsDisplayed().assertIsEnabled().performClick()
        waitForText("S48 Android Second")
        openTab("sms")
        waitForContentDescription("新短信")
        compose.onNodeWithContentDescription("新短信").performClick()
        replace("sms.compose.number", "0999999999")
        replace("sms.compose.body", "S48 unsent body")
        compose.onNodeWithTag("sms.compose.cancel", useUnmergedTree = true).performClick()
        compose.onNodeWithContentDescription("新短信").performClick()
        waitForTag("sms.compose.number")
        assertEquals("", compose.onNodeWithTag("sms.compose.number", useUnmergedTree = true)
            .fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithTag("sms.compose.body", useUnmergedTree = true).assertTextContains("S48 unsent body")
        compose.onNodeWithTag("sms.recipients.add", useUnmergedTree = true).performScrollTo().performClick()
        replace("sms.recipients.search", "林美玲")
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("sms.recipients.choice").fetchSemanticsNodes().size >= 2 }
        compose.onAllNodesWithTag("sms.recipients.choice")[0].performClick().assertIsOn()
        compose.onAllNodesWithTag("sms.recipients.choice")[1].performClick().assertIsOn()
        compose.onNodeWithTag("sms.recipients.count").assertTextContains("已选 2 / 100")
        compose.onNodeWithTag("sms.recipients.cancel").performClick()
        assertEquals(0, compose.onAllNodesWithTag("sms.recipient.chip").fetchSemanticsNodes().size)
        compose.onNodeWithTag("sms.recipients.add", useUnmergedTree = true).performClick()
        replace("sms.recipients.search", "林美玲")
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("sms.recipients.choice").fetchSemanticsNodes().size >= 2 }
        compose.onAllNodesWithTag("sms.recipients.choice")[0].performClick()
        compose.onAllNodesWithTag("sms.recipients.choice")[1].performClick()
        replace("sms.recipients.search", "S48 Android Second")
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("sms.recipients.choice").fetchSemanticsNodes().size == 1 }
        compose.onNodeWithTag("sms.recipients.count").assertTextContains("已选 2 / 100")
        compose.onAllNodesWithTag("sms.recipients.choice")[0].performClick().assertIsOn()
        compose.onNodeWithTag("sms.recipients.count").assertTextContains("已选 3 / 100")
        replace("sms.recipients.search", "林美玲")
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("sms.recipients.choice").fetchSemanticsNodes().size >= 2 }
        compose.onAllNodesWithTag("sms.recipients.choice")[0].assertIsOn()
        compose.onAllNodesWithTag("sms.recipients.choice")[1].assertIsOn()
        compose.onNodeWithTag("sms.recipients.done").performClick()
        assertEquals(3, compose.onAllNodesWithTag("sms.recipient.chip").fetchSemanticsNodes().size)
        compose.onAllNodesWithTag("sms.recipient.chip")[0].performScrollTo().performClick()
        assertEquals(2, compose.onAllNodesWithTag("sms.recipient.chip").fetchSemanticsNodes().size)
        compose.onNodeWithTag("sms.compose.body", useUnmergedTree = true).assertTextContains("S48 unsent body")
        captureEvidence("s48-picker-done-remove-body")
        compose.onNodeWithTag("sms.compose.cancel", useUnmergedTree = true).performClick()
    }

    @Test
    fun s48BatchFailureRetainsComposerAndSimDrafts() {
        requireFullJourney()
        reset("all")
        ensureLoggedIn()
        openTab("sms")
        waitForContentDescription("新短信")
        compose.onNodeWithContentDescription("新短信").performClick()
        fun selectComposeSim(simId: String) {
            // Reveal the vertical form first; chip.performScrollTo only scrolls its horizontal row.
            androidx.test.espresso.Espresso.closeSoftKeyboard()
            compose.onNode(hasText("发送号码") and hasAnyAncestor(hasTestTag("sms.compose.form")),
                useUnmergedTree = true).performScrollTo().assertIsDisplayed()
            val chip = compose.onNode(hasTestTag("sim.picker.$simId") and
                hasAnyAncestor(hasTestTag("sms.compose.form")), useUnmergedTree = true)
            chip.performScrollTo().assertIsDisplayed().performClick()
            compose.waitUntil(10_000) { runCatching { chip.assertIsSelected(); true }.getOrDefault(false) }
        }
        selectComposeSim(S33Ids.SIM_PRIMARY)
        replace("sms.compose.number", "0900000061")
        compose.onNodeWithTag("sms.recipients.addManual", useUnmergedTree = true).performScrollTo().performClick()
        replace("sms.compose.number", "0900000062")
        replace("sms.compose.body", "S48 primary draft")
        selectComposeSim(S33Ids.SIM_SECONDARY)
        replace("sms.compose.body", "S48 secondary draft")
        compose.onNodeWithTag("sms.compose.number", useUnmergedTree = true).assertTextContains("0900000062")
        selectComposeSim(S33Ids.SIM_PRIMARY)
        compose.onNodeWithTag("sms.compose.body", useUnmergedTree = true).assertTextContains("S48 primary draft")
        fixture.injectFailure("POST", "/api/v1/sms/batch", "S48_BATCH_FAILED", "S48 批量提交模拟失败")
        compose.onNodeWithTag("sms.compose.send", useUnmergedTree = true).performClick()
        waitForText("S48 批量提交模拟失败", substring = true)
        compose.onNodeWithTag("sms.compose.header", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("sms.compose.body", useUnmergedTree = true).assertTextContains("S48 primary draft")
        compose.onNodeWithTag("sms.compose.number", useUnmergedTree = true).assertTextContains("0900000062")
        assertEquals(1, compose.onAllNodesWithTag("sms.recipient.chip").fetchSemanticsNodes().size)
        captureEvidence("s48-batch-failure-keeps-draft")
        compose.onNodeWithTag("sms.compose.cancel", useUnmergedTree = true).performClick()
    }

    @Test
    fun s47RecordSmsPrefillOverridesDraftAndRemainsEditable() {
        requireFullJourney()
        reset("all")
        ensureLoggedIn()
        openTab("sms")
        waitForContentDescription("新短信")
        compose.onNodeWithContentDescription("新短信").performClick()
        replace("sms.compose.number", "0999999999")
        compose.onNodeWithTag("sms.compose.cancel", useUnmergedTree = true).performClick()

        for (fromInfo in listOf(false, true)) {
            openTab("history")
            if (fromInfo) {
                waitForTag("history.detail.${S33Ids.CALL_RECORDED}")
                compose.onNodeWithContentDescription("返回记录").performClick()
            }
            waitForTag("history.search")
            replace("history.search", "0900000001")
            waitForText("S33 林美玲", substring = true)
            if (fromInfo) {
                compose.onAllNodes(hasContentDescription("联系人卡片"), useUnmergedTree = true)
                    .onFirst().performClick()
                waitForText("发送短信")
                clickText("发送短信")
            } else {
                compose.onAllNodesWithTag("records.row", useUnmergedTree = true).onFirst().performClick()
                waitForTag("history.detail.smsDraft")
                compose.onNodeWithTag("history.detail.smsDraft", useUnmergedTree = true).performClick()
            }
            waitForTag("sms.compose.number")
            compose.onNodeWithTag("sms.compose.number", useUnmergedTree = true).assertTextContains("0900000001")
            captureEvidence("s47-sms-${if (fromInfo) "info" else "detail"}-prefilled")
            replace("sms.compose.number", "0900000002")
            val sendingSim = compose.onNode(
                hasTestTag("sim.picker.${S33Ids.SIM_SECONDARY}") and hasAnyAncestor(hasTestTag("sms.compose.form")),
                useUnmergedTree = true,
            )
            sendingSim.performScrollTo().assertIsDisplayed().performClick()
            sendingSim.assertIsSelected()
            compose.onNodeWithTag("sms.compose.number", useUnmergedTree = true).assertTextContains("0900000002")
            captureEvidence("s47-sms-${if (fromInfo) "info" else "detail"}-edited-secondary")
            compose.onNodeWithTag("sms.compose.cancel", useUnmergedTree = true).performClick()
        }
        captureEvidence("s47-record-sms-prefill")
    }

    @Test
    fun callsReportsRecordingAiInterceptionsPagingAndExternalDelete() {
        requireFullJourney()
        reset("all")
        ensureLoggedIn()
        openTab("history")

        val search = compose.onNodeWithTag("history.search", useUnmergedTree = true)
        search.performTextInput("0900000001")
        waitForText("S33 林美玲", substring = true)
        compose.onAllNodesWithTag("records.row", useUnmergedTree = true).onFirst()
            .performTouchInput { longClick() }
        captureEvidence("04-record-delete-confirm")
        clickText("取消")
        compose.onAllNodesWithTag("records.row", useUnmergedTree = true).onFirst().performClick()
        waitForText("查看转录")
        fixture.injectFailure(
            "GET",
            "/api/v1/calls/${S33Ids.CALL_RECORDED}/transcript",
            "S33_TRANSCRIPT_TRANSIENT",
            "S33 转录瞬时失败",
        )
        clickText("查看转录")
        waitForText("S33 转录瞬时失败", substring = true)
        fixture.clearFailures()
        clickText("重试")
        waitForText("安排验收回访")
        UiDevice.getInstance(instrumentation).pressBack()
        waitUntilGone("转录", substring = false)
        waitForTag("history.detail.${S33Ids.CALL_RECORDED}")
        fixture.injectFailure(
            "GET",
            "/api/v1/calls/${S33Ids.CALL_RECORDED}/recordings",
            "S33_RECORDING_TRANSIENT",
            "S33 录音清单瞬时失败",
        )
        clickText("查看录音")
        waitForText("S33 录音清单瞬时失败", substring = true)
        fixture.clearFailures()
        clickText("重试")
        waitForText("原始录音")
        clickText("播放")
        waitForText("暂停", timeoutMs = 15_000)
        clickText("暂停")
        waitForText("继续")
        waitForText("下载的是服务器按时间轴混好的一条双人对话 MP3；这里的播放仍是两条声轨。")
        UiDevice.getInstance(instrumentation).pressBack()
        // “录音” is also a permanent fact label in the detail page. “继续” only belongs to the
        // recording sheet, so its disappearance proves the overlay closed without a false timeout.
        waitUntilGone("继续", substring = false)
        waitForTag("history.detail.${S33Ids.CALL_RECORDED}")
        compose.onNodeWithContentDescription("返回记录", useUnmergedTree = false).performClick()
        waitForTag("history.search")

        selectSim(S33Ids.SIM_SECONDARY)
        val aiSearch = compose.onNodeWithTag("history.search", useUnmergedTree = true)
        aiSearch.performTextClearance()
        aiSearch.performTextInput("+8619900000201")
        waitForText("S33 林美玲", substring = true)
        compose.onAllNodesWithTag("records.row", useUnmergedTree = true).onFirst().performClick()
        waitForText("您好，这里是 S33 模拟 AI 助理。")
        waitForText("请明天下午回电并准备报价。")
        waitForText("好的，已经记录回电和报价事项。")
        UiDevice.getInstance(instrumentation).pressBack()
        waitForTag("history.search")

        selectSim(S33Ids.SIM_PRIMARY)
        compose.onNodeWithTag("history.view.reports", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("history.report.preset.today", useUnmergedTree = true).performClick()
        val reportZone = ZoneId.of("Asia/Taipei")
        val recordedStartedAt = ClientApi(ClientSessionProcess.coordinator(instrumentation.targetContext))
            .callsPage(query = "0900000001", simId = S33Ids.SIM_PRIMARY, pageSize = 100)
            .items.single { it.optString("id") == S33Ids.CALL_RECORDED }
            .getString("startedAt")
        val recordedStartDate = Instant.parse(recordedStartedAt).atZone(reportZone).toLocalDate()
        val todayExpected = if (recordedStartDate == ZonedDateTime.now(reportZone).toLocalDate()) {
            "安排验收回访"
        } else {
            "这段时间没有通话"
        }
        waitForText(todayExpected)
        compose.onNodeWithTag("history.report.preset.today", useUnmergedTree = true).assertIsSelected()

        compose.onNodeWithTag("history.report.preset.days_7", useUnmergedTree = true).performClick()
        waitForText("安排验收回访")
        compose.onNodeWithTag("history.report.preset.days_7", useUnmergedTree = true).assertIsSelected()
        captureEvidence("04-report-block-action")
        clickText("立即屏蔽")
        waitForTag("reports.block.confirm")
        captureEvidence("04-report-block-confirm")
        clickText("取消")
        compose.onNodeWithTag("history.report.preset.days_7", useUnmergedTree = true).assertIsSelected()
        waitForText("安排验收回访")

        selectSim(S33Ids.SIM_SECONDARY)
        compose.onNodeWithTag("history.report.preset.days_7", useUnmergedTree = true).performClick()
        waitForText("客户需要报价")
        compose.onNodeWithTag("history.report.preset.days_7", useUnmergedTree = true).assertIsSelected()

        selectSim(S33Ids.SIM_PRIMARY)
        compose.onNodeWithTag("history.report.preset.days_30", useUnmergedTree = true).performClick()
        waitForText("转录失败，原始录音仍可查看")
        compose.onNodeWithTag("history.report.preset.days_30", useUnmergedTree = true).assertIsSelected()
        compose.onNodeWithTag("history.report.preset.custom", useUnmergedTree = true).performClick()
        waitForText("选择起止日期")
        clickText("确定")
        compose.onNodeWithTag("history.report.preset.custom", useUnmergedTree = true).assertIsSelected()
        waitForText("安排验收回访")

        compose.onNodeWithTag("history.view.interceptions", useUnmergedTree = true).performClick()
        waitForText("S33 intercepted SMS", substring = true)
        waitForText("S33 Primary SIM", substring = true)
        val interceptionList = compose.onNode(hasScrollToIndexAction(), useUnmergedTree = true)
        val secondaryInterceptionTag = "interception.row.${S33Ids.INTERCEPTION_SECONDARY}"
        interceptionList.performScrollToNode(hasTestTag(secondaryInterceptionTag))
        compose.onNodeWithTag(secondaryInterceptionTag, useUnmergedTree = false)
            .assertIsDisplayed()
            .assertTextContains("S33 Secondary eSIM", substring = true)
        val unavailableInterceptionTag = "interception.row.${S33Ids.INTERCEPTION_UNAVAILABLE}"
        interceptionList.performScrollToNode(hasTestTag(unavailableInterceptionTag))
        compose.onNodeWithTag(unavailableInterceptionTag, useUnmergedTree = false)
            .assertIsDisplayed()
            .assertTextContains("S33 Unavailable SIM", substring = true)
        waitForText("第 1 / 2 页")
        compose.onNodeWithContentDescription("下一页", useUnmergedTree = false)
            .assertIsEnabled()
            .performClick()
        waitForText("第 2 / 2 页")

        compose.onNodeWithTag("history.view.all_calls", useUnmergedTree = true).performClick()
        val historySearch = compose.onNodeWithTag("history.search", useUnmergedTree = true)
        historySearch.performTextClearance()
        historySearch.performTextInput("0900000001")
        waitForText("S33 林美玲", substring = true)
        compose.onAllNodesWithTag("records.row", useUnmergedTree = true).onFirst().performClick()
        waitForTag("history.detail.${S33Ids.CALL_RECORDED}")
        fixture.peer("call.delete", id = S33Ids.CALL_RECORDED)
        compose.waitUntil(12_000) { nodesWithTag("history.detail.${S33Ids.CALL_RECORDED}") == 0 }
        waitForText("这条通话记录已在另一端删除")
        captureEvidence("04-calls-external-delete")
    }

    @Test
    fun simNotesSettingsProviderAndGatewayCasAckLifecycleErrors() {
        requireFullJourney()
        reset("all")
        ensureLoggedIn()
        openTab("settings")
        waitForText("用户")
        waitForText("当前会话")
        waitForText("Android App")
        waitForText("S33 Primary SIM", substring = true)
        compose.onNodeWithTag("settings.sim.${S33Ids.SIM_PRIMARY}", useUnmergedTree = true).performClick()
        listOf("人工接听", "AI 即接", "超时转 AI").forEach { waitForText(it) }
        replace("settings.sim.label", "S33 Android SIM Draft")
        replace("settings.sim.phoneLabel", "S33 Android phone label")
        compose.onNodeWithTag("settings.sim.notes.unsaved", useUnmergedTree = true).assertTextContains("未保存设置")
        captureEvidence("s47-notes-unsaved")
        compose.onNodeWithTag("settings.sim.saveNotes", useUnmergedTree = true).performClick()
        waitForText("号码备注已保存")
        compose.waitUntil(10_000) { nodesWithTag("settings.sim.notes.unsaved") == 0 }
        captureEvidence("05-sim-notes-saved")

        compose.onNodeWithTag("settings.sim.mode.ai", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("settings.sim.mode.unsaved", useUnmergedTree = true).assertTextContains("未保存设置")
        compose.onNodeWithTag("settings.sim.mode.unsaved", useUnmergedTree = true).performScrollTo()
        captureEvidence("s47-mode-unsaved")
        compose.onNodeWithTag("settings.sim.saveMode", useUnmergedTree = true).performScrollTo().assertIsDisplayed().performClick()
        waitForText("正在应用", substring = true)
        fixture.peer("gateway.ackLatest", id = S33Ids.GATEWAY_PRIMARY)
        waitForText("应用成功")
        compose.waitUntil(10_000) { nodesWithTag("settings.sim.mode.unsaved") == 0 }
        compose.onNodeWithTag("settings.sim.mode.ai", useUnmergedTree = true).assertIsSelected()

        replace("settings.sim.label", "S33 stale SIM draft")
        fixture.peer(
            "sim.notes",
            id = S33Ids.SIM_PRIMARY,
            payload = JSONObject().put("label", "S33 peer SIM label").put("phoneLabel", "S33 peer phone label"),
        )
        compose.onNodeWithTag("settings.sim.saveNotes", useUnmergedTree = true).performClick()
        waitForText("号码备注已被另一端更新，当前草稿已保留。")
        compose.onNodeWithTag("settings.sim.notes.unsaved", useUnmergedTree = true).assertTextContains("未保存设置")
        compose.onNodeWithTag("settings.sim.label", useUnmergedTree = true).assertTextContains("S33 stale SIM draft")
        waitForEnabledTag("settings.sim.loadLatestNotes")
        compose.onNodeWithTag("settings.sim.loadLatestNotes", useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithTag("settings.sim.label", useUnmergedTree = true)
                    .assertTextContains("S33 peer SIM label")
                compose.onNodeWithTag("settings.sim.phoneLabel", useUnmergedTree = true)
                    .assertTextContains("S33 peer phone label")
                true
            }.getOrDefault(false)
        }

        // Navigate through the page action itself. It remains deterministic whether the IME is
        // still visible or already closed, and disposing this detail page clears its field focus.
        waitForContentDescription("返回设置")
        compose.onNodeWithContentDescription("返回设置", useUnmergedTree = false)
            .performScrollTo().assertIsDisplayed()
            .performClick()
        waitForTag("settings.list")
        waitForSettingsSection("provider")
        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.provider.doubao"))
        fixture.peer("provider.select", payload = JSONObject().put("provider", "doubao"))
        compose.onNodeWithTag("settings.provider.doubao", useUnmergedTree = true).performClick()
        waitForText("设置已被另一端更新，请核对后重试")
        waitForEnabledTag("settings.provider.loadLatest")
        compose.onNodeWithTag("settings.provider.loadLatest", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("settings.provider.doubao", useUnmergedTree = true).assertIsSelected()
        compose.onNodeWithTag("settings.provider.doubao.available", useUnmergedTree = true).assertExists()
        captureEvidence("s47-provider-green")

        waitForSettingsSection("passkeys")
        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_MAC}"))
        assertTaggedRowContains(
            "settings.passkey.${S33Ids.PASSKEY_OWNER1_MAC}",
            "S33 办公 MacBook",
            "Safari on macOS",
        )
        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_PHONE}"))
        assertTaggedRowContains(
            "settings.passkey.${S33Ids.PASSKEY_OWNER1_PHONE}",
            "S33 随身 iPhone",
            "iOS App",
        )

        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_MAC}"))
        compose.onNodeWithTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_MAC}.manage", useUnmergedTree = true)
            .performClick()
        compose.onNodeWithTag("settings.passkey.rename", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("settings.passkey.rename.input", useUnmergedTree = true)
            .performTextReplacement("S33 Android 验证办公 MacBook")
        fixture.injectFailure(
            "GET",
            "/api/v1/passkeys",
            "S33_PASSKEY_LIST_TRANSIENT",
            "S33 通行密钥列表瞬时失败",
        )
        compose.onNodeWithTag("settings.passkey.rename.confirm", useUnmergedTree = true).performClick()
        waitForText("S33 Android 验证办公 MacBook")
        waitForText("S33 通行密钥列表瞬时失败")
        fixture.clearFailures()
        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.passkey.retry"))
        compose.onNodeWithTag("settings.passkey.retry", useUnmergedTree = true)
            .assertIsDisplayed()
            .performClick()
        compose.waitUntil(10_000) { nodesWithTag("settings.passkey.retry") == 0 }
        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_MAC}"))
        assertTaggedRowContains(
            "settings.passkey.${S33Ids.PASSKEY_OWNER1_MAC}",
            "S33 Android 验证办公 MacBook",
        )

        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_PHONE}"))
        compose.onNodeWithTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_PHONE}.manage", useUnmergedTree = true)
            .performClick()
        compose.onNodeWithTag("settings.passkey.delete", useUnmergedTree = true).performClick()
        captureEvidence("05-passkey-delete-confirm")
        fixture.injectFailure(
            "GET",
            "/api/v1/passkeys",
            "S33_PASSKEY_LIST_TRANSIENT",
            "S33 通行密钥列表瞬时失败",
        )
        compose.onNodeWithTag("settings.passkey.delete.confirm", useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) { nodesWithTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_PHONE}") == 0 }
        compose.onNodeWithTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_PHONE}", useUnmergedTree = true)
            .assertDoesNotExist()
        waitForText("S33 通行密钥列表瞬时失败")
        fixture.clearFailures()
        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.passkey.retry"))
        compose.onNodeWithTag("settings.passkey.retry", useUnmergedTree = true)
            .assertIsDisplayed()
            .performClick()
        compose.waitUntil(10_000) { nodesWithTag("settings.passkey.retry") == 0 }
        compose.onNodeWithTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_PHONE}", useUnmergedTree = true)
            .assertDoesNotExist()

        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.passkey.add"))
        val localPasskeyFailure = "S33 本地域没有通行密钥信赖关联"
        fixture.injectFailure(
            "POST",
            "/api/v1/passkeys/register/options",
            "S33_LOCAL_PASSKEY_UNAVAILABLE",
            localPasskeyFailure,
        )
        compose.onNodeWithTag("settings.passkey.add", useUnmergedTree = true).performClick()
        waitForText(localPasskeyFailure)
        waitForEnabledTag("settings.passkey.add")
        assertTaggedRowContains(
            "settings.passkey.${S33Ids.PASSKEY_OWNER1_MAC}",
            "S33 Android 验证办公 MacBook",
        )
        compose.onNodeWithTag("settings.passkey.${S33Ids.PASSKEY_OWNER1_PHONE}", useUnmergedTree = true)
            .assertDoesNotExist()
        captureEvidence("05-passkey-local-registration-failure")
        fixture.clearFailures()

        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.blocklist.open"))
        compose.onNodeWithTag("settings.blocklist.open", useUnmergedTree = false)
            .assertIsDisplayed().performClick()
        waitForTag("settings.blocklist.page")
        compose.onNodeWithTag("settings.blocklist.page", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("settings.blocklist.back", useUnmergedTree = false).assertIsDisplayed()
        waitForSettingsSection("blocklist")
        compose.onNode(hasScrollToIndexAction(), useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.block.${S33Ids.BLOCK_PRIMARY}"))
        waitForText("+886 900 001 001")
        replace("settings.blocklist.search", "900 001-001")
        compose.onNodeWithTag("settings.block.${S33Ids.BLOCK_PRIMARY}", useUnmergedTree = true).assertIsDisplayed()
        captureEvidence("s47-blocklist-search-match")
        replace("settings.blocklist.search", "000000000000")
        waitForText("没有匹配的屏蔽号码")
        captureEvidence("s47-blocklist-search-empty")
        replace("settings.blocklist.search", "")
        waitForText("+886 900 001 001")
        compose.onNodeWithTag("settings.block.${S33Ids.BLOCK_PRIMARY}.unblock", useUnmergedTree = true).performClick()
        captureEvidence("05-unblock-confirm")
        compose.onNodeWithTag("settings.block.confirmUnblock", useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) { nodesWithTag("settings.block.${S33Ids.BLOCK_PRIMARY}") == 0 }
        waitUntilGone("+886 900 001 001")
        compose.onNodeWithTag("settings.blocklist.back", useUnmergedTree = false)
            .assertIsDisplayed().performClick()
        waitForTag("settings.list")
        compose.onNodeWithTag("settings.list", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("settings.blocklist.page", useUnmergedTree = true).assertDoesNotExist()

        val gatewayTag = "settings.gateway.${S33Ids.GATEWAY_PRIMARY}"
        val gatewayFailure = "网关正被另一通蜂窝通话占用"
        val settingsList = compose.onNodeWithTag("settings.list", useUnmergedTree = true)
        fixture.injectFailure(
            "POST",
            "/api/v1/gateways/${S33Ids.GATEWAY_PRIMARY}/power",
            "GATEWAY_BUSY",
            "S33 网关生命周期模拟拒绝",
        )
        waitForSettingsSection("gateway")
        settingsList.performScrollToNode(hasTestTag(gatewayTag))
        val gatewaySwitch = compose.onNodeWithTag(gatewayTag, useUnmergedTree = true)
        waitForText("关闭网关总控")
        gatewaySwitch.assertIsDisplayed().assertIsOn().performClick()
        captureEvidence("05-gateway-off-confirm")
        clickText("取消")
        gatewaySwitch.assertIsOn()

        gatewaySwitch.performClick()
        compose.onNodeWithTag("settings.gateway.confirmOff", useUnmergedTree = true).performClick()
        waitForInjectedFailuresConsumed()
        compose.waitUntil(10_000) {
            runCatching {
                settingsList.performScrollToNode(hasText(gatewayFailure))
                compose.onNodeWithText(gatewayFailure, useUnmergedTree = true).assertIsDisplayed()
                true
            }.getOrDefault(false)
        }
        gatewaySwitch.assertIsOn().assertIsEnabled()
        fixture.clearFailures()
        settingsList.performScrollToNode(hasTestTag(gatewayTag))
        gatewaySwitch.assertIsDisplayed().assertIsOn().assertIsEnabled().performClick()
        compose.onNodeWithTag("settings.gateway.confirmOff", useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) {
            runCatching {
                gatewaySwitch.assertIsNotEnabled()
                true
            }.getOrDefault(false)
        }
        settingsList.performScrollToNode(hasText("正在等待 Pixel 执行…"))
        compose.onNodeWithText("正在等待 Pixel 执行…", useUnmergedTree = true).assertIsDisplayed()
        val powerAck = fixture.peer(
            "gateway.powerAck",
            id = S33Ids.GATEWAY_PRIMARY,
            payload = JSONObject().put("desired", "off").put("ok", true).put("reason", JSONObject.NULL),
        )
        val powerItem = powerAck.getJSONObject("item")
        assertFalse(powerItem.getBoolean("controlEnabled"))
        assertFalse(powerItem.getBoolean("online"))
        assertTrue(powerItem.getBoolean("standbyOnline"))
        assertTrue(powerItem.isNull("desiredPower"))
        val lastPowerResult = powerItem.getJSONObject("lastPowerResult")
        assertEquals("off", lastPowerResult.getString("desired"))
        assertTrue(lastPowerResult.getBoolean("ok"))
        assertTrue(lastPowerResult.isNull("reason"))
        compose.waitUntil(10_000) {
            runCatching { gatewaySwitch.assertIsOff(); true }.getOrDefault(false)
        }
        settingsList.performScrollToNode(hasText("远程关闭已完成", substring = true))
        compose.onNode(hasText("远程关闭已完成", substring = true), useUnmergedTree = true)
            .assertIsDisplayed()
        settingsList.performScrollToNode(hasTestTag("settings.refreshAll"))
        waitForText("通话网络：自动，标准连接失败后尝试兼容连接。")
        compose.onNodeWithTag("settings.refreshAll", useUnmergedTree = true).performClick()
        listOf("sims", "provider", "blocklist", "gateway", "passkeys").forEach {
            waitForSettingsSection(it, timeoutMs = 15_000)
        }
        settingsList.performScrollToNode(hasTestTag(gatewayTag))
        gatewaySwitch.assertIsDisplayed().assertIsOff()
        settingsList.performScrollToNode(hasText("远程关闭已完成", substring = true))
        compose.onNode(hasText("远程关闭已完成", substring = true), useUnmergedTree = true)
            .assertIsDisplayed()
        captureEvidence("05-settings-cas-ack-gateway")
    }

    /**
     * Parent runs this last with `-e s33Reset false`; the private input file contains the host
     * handoff JSON. It deliberately performs no reset or teardown, so Web -> iOS -> Android -> Web
     * can observe one shared chain.
     */
    @Test
    fun sharedCrossClientHandoffPreservesServerState() {
        assumeTrue("shared handoff journey only", s33Mode == "handoff")
        require(arguments.getString("s33Reset") == "false") {
            "Shared handoff must be explicit: pass -e s33Reset false"
        }
        ensureLoggedIn()
        val handoff = privateInput.getJSONObject("handoff")
        assertEquals(S33Ids.CONTACT_PRIMARY, handoff.getString("contactId"))
        assertEquals(S33Ids.SIM_PRIMARY, handoff.getString("simId"))
        val expected = handoff.getJSONObject("expected")
        val expectedIos = expected.getJSONObject("ios")
        val expectedAndroid = expected.getJSONObject("android")
        val createdContact = expectedIos.getJSONObject("createdContact")

        openTab("contacts")
        waitForTag("contacts.row.${S33Ids.CONTACT_PRIMARY}", timeoutMs = 15_000)
        compose.onNodeWithTag("contacts.row.${S33Ids.CONTACT_PRIMARY}", useUnmergedTree = true).performClick()
        waitForText(expectedIos.getString("organization"))
        waitForText(expectedIos.getString("notes"))
        compose.onNodeWithTag("contact.edit", useUnmergedTree = true).performClick()
        replace("contact.organization", expectedAndroid.getString("organization"))
        compose.onNodeWithTag("contact.save", useUnmergedTree = true).performClick()
        waitForText(expectedAndroid.getString("organization"))
        waitForText(expectedAndroid.getString("notes"))

        UiDevice.getInstance(instrumentation).pressBack()
        waitForText(createdContact.getString("displayName"))
        clickText(createdContact.getString("displayName"))
        waitForText(createdContact.getString("phone"))
        compose.onNodeWithTag("contact.edit", useUnmergedTree = true).performClick()
        replace("contact.organization", expectedAndroid.getString("handoffContactOrganization"))
        compose.onNodeWithTag("contact.save", useUnmergedTree = true).performClick()
        waitForText(expectedAndroid.getString("handoffContactOrganization"))
        waitForText(createdContact.getString("phone"))

        openTab("settings")
        compose.onNodeWithTag("settings.sim.${S33Ids.SIM_PRIMARY}", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("settings.sim.label", useUnmergedTree = true)
            .assertTextContains(expectedIos.getString("simLabel"))
        replace("settings.sim.label", expectedAndroid.getString("simLabel"))
        compose.onNodeWithTag("settings.sim.saveNotes", useUnmergedTree = true).performClick()
        waitForText("号码备注已保存")
        compose.onNodeWithTag("settings.sim.label", useUnmergedTree = true)
            .assertTextContains(expectedAndroid.getString("simLabel"))

        UiDevice.getInstance(instrumentation).pressBack()
        waitForTag("settings.list")
        val iosProvider = expectedIos.getString("provider")
        val androidProvider = expectedAndroid.getString("provider")
        waitForSettingsSection("provider")
        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.provider.$androidProvider"))
        compose.onNodeWithTag("settings.provider.$iosProvider", useUnmergedTree = true).assertIsSelected()
        compose.onNodeWithTag("settings.provider.$androidProvider", useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithTag("settings.provider.$androidProvider", useUnmergedTree = true).assertIsSelected()
                true
            }.getOrDefault(false)
        }
        captureEvidence("06-shared-handoff-android")
        // No reset or teardown: Web verifies every Android mutation from this shared server state.
    }

    private fun reset(scenario: String) = fixture.reset(scenario)

    private fun requireFullJourney() = assumeTrue("full business journey only", s33Mode == "full")

    private fun loadPrivateInput(): JSONObject {
        val fileName = arguments.getString("s33ConfigFile")?.takeIf(String::isNotBlank) ?: "s33-input.json"
        require(fileName.matches(Regex("[A-Za-z0-9._-]{1,80}")) && '/' !in fileName && '\\' !in fileName) {
            "s33ConfigFile must be a plain file name under the app files directory"
        }
        val file = File(instrumentation.targetContext.filesDir, fileName)
        require(file.canonicalFile.parentFile == instrumentation.targetContext.filesDir.canonicalFile) {
            "s33ConfigFile must resolve inside the app files directory"
        }
        require(file.isFile) {
            "Write the private S33 input to ${file.absolutePath} before instrumentation"
        }
        require(Os.stat(file.absolutePath).st_mode and 0x3f == 0) {
            "Private S33 input must not grant group or other permissions (chmod 600)"
        }
        return JSONObject(file.readText(Charsets.UTF_8))
    }

    private fun ensureLoggedIn() {
        if (nodesWithTag("workspace") == 0) login()
    }

    private fun login() {
        waitForTag("login.username")
        replace("login.username", fixtureUsername)
        replace("login.password", fixturePassword)
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithTag("login.submit", useUnmergedTree = true).assertIsEnabled()
                true
            }.getOrDefault(false)
        }
        compose.onNodeWithTag("login.submit", useUnmergedTree = true).performClick()
        waitForTag("workspace", timeoutMs = 20_000)
    }

    private fun signOutIfNeeded() {
        if (nodesWithTag("workspace") == 0) return
        openTab("settings")
        compose.onNodeWithTag("settings.list", useUnmergedTree = true)
            .performScrollToNode(hasTestTag("settings.logout"))
        val logout = compose.onNodeWithTag("settings.logout", useUnmergedTree = true).assertIsDisplayed()
        captureEvidence("01-auth-logout-entry")
        logout.performClick()
        waitForTag("login.screen")
    }

    private fun openTab(name: String) {
        waitForTag("tab.$name")
        compose.onNodeWithTag("tab.$name", useUnmergedTree = true).performClick()
    }

    private fun selectSim(simId: String) {
        val tag = "sim.picker.$simId"
        waitForTag(tag)
        val expectedLabel = when (simId) {
            S33Ids.SIM_PRIMARY -> "S33 Primary SIM"
            S33Ids.SIM_SECONDARY -> "S33 Secondary eSIM"
            S33Ids.SIM_UNAVAILABLE -> "S33 Unavailable SIM"
            else -> error("Unknown fixture SIM: $simId")
        }
        compose.onNodeWithTag(tag, useUnmergedTree = false)
            .performScrollTo()
            .assertIsDisplayed()
            .assertTextContains(expectedLabel)
            .performClick()
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithTag(tag, useUnmergedTree = true).assertIsSelected()
                true
            }.getOrDefault(false)
        }
    }

    private fun fillContactEditor(
        name: String,
        familyName: String,
        givenName: String,
        organization: String,
        phone: String,
        email: String,
        address: String,
        notes: String,
    ) {
        replace("contact.name", name)
        replace("contact.familyName", familyName)
        replace("contact.givenName", givenName)
        replace("contact.organization", organization)
        replace("contact.phone.0", phone)
        clickText("添加邮箱")
        replace("contact.email.0", email)
        replace("contact.address", address)
        replace("contact.notes", notes)
    }

    private fun enterDialNumber(number: String) {
        number.forEach { digit -> clickText(digit.toString()) }
    }

    private fun outboundCallRequestCount(): Int = fixture.state()
        .getJSONObject("requestCounters")
        .getInt("outboundCallRequests")

    private fun contactUpdateCounters(): Pair<Int, Int?> {
        val counters = fixture.state().getJSONObject("requestCounters")
        return counters.getInt("contactUpdateRequestCount") to
            counters.optInt("contactUpdateLastStatus").takeIf { !counters.isNull("contactUpdateLastStatus") }
    }

    private fun awaitContactUpdateCounters(count: Int, status: Int, timeoutMs: Long = 10_000) {
        var observed: Pair<Int, Int?> = -1 to null
        try {
            compose.waitUntil(timeoutMs) {
                observed = contactUpdateCounters()
                observed.first >= count && observed.second == status
            }
        } catch (timeout: ComposeTimeoutException) {
            throw AssertionError(
                "stale contact PUT did not complete as expected: expected=$count/$status, " +
                    "observed=${observed.first}/${observed.second}",
                timeout,
            )
        }
        assertEquals("stale contact Save must issue exactly one real PUT", count, observed.first)
        assertEquals("stale contact PUT must be rejected by CAS", status, observed.second)
    }

    private fun assertNativeMediaProbeUnavailable() {
        val failure = runCatching {
            ClientApi(ClientSessionProcess.coordinator(instrumentation.targetContext))
                .probeOptions(UUID.randomUUID().toString())
        }.exceptionOrNull()
        assertTrue("basic native fixture must reject media probe options locally", failure is ApiError)
        failure as ApiError
        assertEquals(503, failure.status)
        assertEquals("MEDIA_PROBES_UNAVAILABLE", failure.code)
        assertEquals("Media node probes are not configured", failure.message)
    }

    private fun callEvent(
        generation: Int,
        state: String,
        failureReason: String? = null,
    ): JSONObject = JSONObject()
        .put("eventId", UUID.randomUUID().toString())
        .put("generation", generation)
        .put("state", state)
        .apply { failureReason?.let { put("failureReason", it) } }

    private fun awaitFixtureCall(simId: String, number: String, timeoutMs: Long = 10_000): JSONObject {
        var call: JSONObject? = null
        compose.waitUntil(timeoutMs) {
            call = runCatching {
                fixture.peer(
                    "call.lookup",
                    payload = JSONObject().put("simId", simId).put("remoteNumber", number),
                ).getJSONObject("call")
            }.getOrNull()
            call != null
        }
        return requireNotNull(call)
    }

    private fun awaitFixtureCallState(
        simId: String,
        number: String,
        state: String,
        timeoutMs: Long = 10_000,
    ): JSONObject {
        var call: JSONObject? = null
        compose.waitUntil(timeoutMs) {
            call = runCatching {
                fixture.peer(
                    "call.lookup",
                    payload = JSONObject().put("simId", simId).put("remoteNumber", number),
                ).getJSONObject("call")
            }.getOrNull()
            call?.optString("state") == state
        }
        return requireNotNull(call)
    }

    private fun assertOutboundOwnedByAndroid(call: JSONObject) {
        assertEquals("outgoing_pending", call.getString("state"))
        assertEquals("outgoing", call.getString("direction"))
        assertEquals(33, call.getInt("generation"))
        assertEquals(S33Ids.SIM_PRIMARY, call.getString("simId"))
        val owner = call.getJSONObject("sessionOwner")
        assertEquals("originating", owner.getString("kind"))
        assertTrue(owner.getBoolean("present"))
        assertEquals("android", owner.getString("platform"))
    }

    private fun replace(tag: String, value: String) {
        waitForTag(tag)
        val field = compose.onNodeWithTag(tag, useUnmergedTree = true)
        if (!field.isDisplayed()) field.performScrollTo()
        field.assertIsDisplayed().performTextReplacement(value)
    }

    private fun clickText(text: String, substring: Boolean = false) {
        val textMatcher = hasText(text, substring = substring)
        val clickableTextMatcher = hasClickAction() and
            (textMatcher or hasAnyDescendant(textMatcher))
        compose.waitUntil(10_000) {
            compose.onAllNodes(clickableTextMatcher, useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty()
        }
        val target = compose.onAllNodes(clickableTextMatcher, useUnmergedTree = true).onFirst()
        if (!target.isDisplayed()) target.performScrollTo()
        target.performClick()
    }

    private fun waitForTag(tag: String, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) { nodesWithTag(tag) > 0 }
    }

    private fun waitForContentDescription(description: String, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) {
            compose.onAllNodes(hasContentDescription(description), useUnmergedTree = false)
                .fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun waitForEnabledTag(tag: String, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) {
            runCatching {
                compose.onNodeWithTag(tag, useUnmergedTree = true).assertIsEnabled()
                true
            }.getOrDefault(false)
        }
    }

    private fun waitForSettingsSection(section: String, timeoutMs: Long = 15_000) {
        waitForTag("settings.ready.$section", timeoutMs)
    }

    private fun waitForInjectedFailuresConsumed(timeoutMs: Long = 10_000) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        var remaining = -1
        do {
            remaining = fixture.state().optJSONArray("injectedFailures")?.length() ?: -1
            if (remaining == 0) return
            SystemClock.sleep(50)
        } while (SystemClock.elapsedRealtime() < deadline)
        assertEquals("注入的请求失败未被客户端消费", 0, remaining)
    }

    private fun nodesWithTag(tag: String): Int =
        compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun waitForText(text: String, substring: Boolean = false, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) {
            compose.onAllNodes(hasText(text, substring = substring), useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun assertTaggedRowContains(tag: String, vararg exactTexts: String) {
        exactTexts.forEach { exactText ->
            compose.onNode(
                hasTestTag(tag) and hasAnyDescendant(hasText(exactText, substring = true)),
                useUnmergedTree = true,
            ).assertIsDisplayed()
        }
    }

    private fun waitUntilGone(text: String, substring: Boolean = true, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) {
            compose.onAllNodes(hasText(text, substring = substring), useUnmergedTree = true)
                .fetchSemanticsNodes().isEmpty()
        }
        compose.onNode(hasText(text, substring = substring), useUnmergedTree = true).assertDoesNotExist()
    }

    private fun captureEvidence(name: String) {
        compose.waitForIdle()
        val directory = File(instrumentation.targetContext.filesDir, "s33-evidence")
            .also { check(it.mkdirs() || it.isDirectory) }
        val nightMask = instrumentation.targetContext.resources.configuration.uiMode and
            Configuration.UI_MODE_NIGHT_MASK
        val theme = if (ClientAppearanceStore(instrumentation.targetContext).read()
            .usesDarkTheme(nightMask == Configuration.UI_MODE_NIGHT_YES)) "dark" else "light"
        val target = File(directory, "$name-$theme.png")
        assertTrue("Unable to capture ${target.absolutePath}", UiDevice.getInstance(instrumentation).takeScreenshot(target))
    }

    private fun captureFailureDiagnostics(error: Throwable, description: Description) {
        val prepared = runCatching {
            val context = instrumentation.targetContext
            check(context.packageName == "org.vodog.s33") {
                "Refusing to write S33 diagnostics into ${context.packageName}"
            }
            val directory = File(context.filesDir, "s33-evidence")
                .also { check(it.mkdirs() || it.isDirectory) }
            val nightMask = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
            val theme = if (ClientAppearanceStore(context).read()
                .usesDarkTheme(nightMask == Configuration.UI_MODE_NIGHT_YES)) "dark" else "light"
            val caseName = (description.methodName ?: description.displayName).map { character ->
                if (character.isLetterOrDigit() || character in ".-_") character else '_'
            }.joinToString("")
            Triple(UiDevice.getInstance(instrumentation), directory, "failure-$caseName-$theme")
        }.getOrElse {
            error.addSuppressed(it)
            return
        }
        val (device, directory, stem) = prepared
        runCatching {
            val ownFrame = error.stackTrace.firstOrNull {
                it.fileName == "S33BusinessJourneyTest.kt" &&
                    it.className.startsWith(S33BusinessJourneyTest::class.java.name)
            }
            val reason = JSONObject()
                .put("test", description.methodName ?: description.displayName)
                .put("exceptionClass", error.javaClass.name)
                .put("message", redactFailureText(error.message.orEmpty()))
                .put("source", ownFrame?.fileName ?: JSONObject.NULL)
                .put("line", ownFrame?.lineNumber?.takeIf { it > 0 } ?: JSONObject.NULL)
            File(directory, "$stem.json").writeText(reason.toString(2))
        }.exceptionOrNull()?.let(error::addSuppressed)
        runCatching {
            val screenshot = File(directory, "$stem.png")
            check(device.takeScreenshot(screenshot)) { "Unable to capture ${screenshot.absolutePath}" }
        }.exceptionOrNull()?.let(error::addSuppressed)
        runCatching {
            device.dumpWindowHierarchy(File(directory, "$stem.xml"))
        }.exceptionOrNull()?.let(error::addSuppressed)
    }

    private fun redactFailureText(raw: String): String {
        val secrets = linkedSetOf<String>()
        if (::fixturePassword.isInitialized) secrets += fixturePassword
        if (::privateInput.isInitialized) {
            privateInput.optString("fixtureKey").takeIf(String::isNotBlank)?.let(secrets::add)
            privateInput.optJSONObject("accounts")?.let { accounts ->
                val owners = accounts.keys()
                while (owners.hasNext()) {
                    accounts.optJSONObject(owners.next())
                        ?.optString("password")
                        ?.takeIf(String::isNotBlank)
                        ?.let(secrets::add)
                }
            }
        }
        return secrets.filter { it.length >= 4 }
            .fold(raw) { message, secret -> message.replace(secret, "[REDACTED]") }
            .take(2_000)
    }
}

private object S33Ids {
    private const val PREFIX = "33000000-0000-4000-8000-000000000"
    const val GATEWAY_PRIMARY = "${PREFIX}101"
    const val SIM_PRIMARY = "${PREFIX}201"
    const val SIM_SECONDARY = "${PREFIX}202"
    const val SIM_UNAVAILABLE = "${PREFIX}203"
    const val CONTACT_PRIMARY = "${PREFIX}301"
    const val CALL_RECORDED = "${PREFIX}501"
    const val CALL_ACTIVE = "${PREFIX}503"
    const val BLOCK_PRIMARY = "${PREFIX}601"
    const val PASSKEY_OWNER1_MAC = "ERERERERERERERERERERERERERERERERERERERERERE"
    const val PASSKEY_OWNER1_PHONE = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI"
    const val INTERCEPTION_SMS_PRIMARY = "33000000-0000-4000-8000-000000007001"
    const val INTERCEPTION_SECONDARY = "33000000-0000-4000-8000-000000008001"
    const val INTERCEPTION_UNAVAILABLE = "33000000-0000-4000-8000-000000008002"
}

private class S33FixtureControl(private val key: String) {
    fun state(): JSONObject = request("GET", "/__s33/state")

    fun reset(scenario: String): JSONObject = request(
        "POST",
        "/__s33/reset",
        JSONObject().put("scenario", scenario),
    )

    fun peer(
        action: String,
        id: String? = null,
        payload: JSONObject = JSONObject(),
    ): JSONObject = request(
        "POST",
        "/__s33/peer",
        JSONObject().put("action", action).put("payload", payload).apply { id?.let { put("id", it) } },
    )

    fun injectFailure(method: String, path: String, code: String, message: String) = peer(
        "inject.failure",
        payload = JSONObject()
            .put("method", method)
            .put("path", path)
            .put("status", 503)
            .put("code", code)
            .put("message", message)
            .put("count", 1),
    )

    fun clearFailures() = peer("clearFailures")

    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        val connection = URL("http://127.0.0.1:16880$path").openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = method
            connection.connectTimeout = 5_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("Accept", "application/json")
            if (method != "GET") connection.setRequestProperty("x-s33-fixture-key", key)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            check(status in 200..299) { "$method $path returned $status: $text" }
            if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }
}
