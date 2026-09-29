package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/**
 * S22: AI 即接 suppression, the 报告 date window, the login gating and the saved-account store.
 * Everything here is a pure decision the UI only renders — the tests exist so the rules can be read
 * without a device.
 */
class S22ClientPolicyTest {

    private fun ringingCall(answerMode: String? = null, aiHandling: Boolean? = null): JSONObject =
        JSONObject()
            .put("id", "call-1")
            .put("state", "incoming_ringing")
            .apply {
                answerMode?.let { put("answerMode", it) }
                aiHandling?.let { put("aiHandling", it) }
            }

    // ---- 决策 4 suppress ---------------------------------------------------------------------

    @Test fun aiModeWithALiveRunSuppressesTheAnswerButtons() {
        assertTrue(aiAnswerSuppressed(ringingCall("ai", true)))
    }

    @Test fun timeoutAiKeepsRingingUntilTheAiActuallyTakesOver() {
        // `timeout_ai` also carries an ai_run while the call legitimately rings on every device, so
        // `aiHandling` alone must never hide the buttons.
        assertFalse(aiAnswerSuppressed(ringingCall("timeout_ai", true)))
    }

    @Test fun aiModeWithoutALiveRunFallsBackToANormalRingingCall() {
        // The run was lost/failed and the server cleared ai_run_id: the call rings again and the
        // client must offer 接听 (S22 决策 5).
        assertFalse(aiAnswerSuppressed(ringingCall("ai", false)))
    }

    @Test fun aServerWithoutS22FieldsNeverSuppressesAnything() {
        assertFalse(aiAnswerSuppressed(ringingCall()))
        assertEquals("normal", callAnswerMode(ringingCall()))
    }

    @Test fun occupancyLabelNamesTheAiInsteadOfAGenericOtherDevice() {
        val occupancy = JSONObject()
            .put("holdsLock", true)
            .put("occupantPlatform", JSONObject.NULL)
            .put("occupantDevice", JSONObject.NULL)
            .put("isCurrentSession", false)
            .put("canRelease", false)
        val suppressed = ringingCall("ai", true).put("occupancy", occupancy)
        assertEquals("AI 接听", callOccupantLabel(suppressed))
        val ringing = ringingCall("timeout_ai", true).put("occupancy", occupancy)
        assertEquals("其他设备", callOccupantLabel(ringing))
    }

    // ---- 决策 10 报告窗口与文案 ---------------------------------------------------------------

    @Test fun presetRangesAreInclusiveCalendarDaysEndingToday() {
        val today = LocalDate.of(2026, 9, 12)
        assertEquals(ReportDateRange(today, today), reportRangeFor(ReportRangePreset.TODAY, today))
        assertEquals(
            ReportDateRange(LocalDate.of(2026, 9, 6), today),
            reportRangeFor(ReportRangePreset.DAYS_7, today),
        )
        assertEquals(
            ReportDateRange(LocalDate.of(2026, 8, 14), today),
            reportRangeFor(ReportRangePreset.DAYS_30, today),
        )
        assertNull("自定义 keeps whatever the picker produced", reportRangeFor(ReportRangePreset.CUSTOM, today))
    }

    @Test fun presetsAnchorOnTheGatewayCalendarDayNotThePhones() {
        // 2026-09-12T16:30Z is still the 12th in UTC but already the 13th in Shanghai.
        val instant = Instant.parse("2026-09-12T16:30:00Z")
        assertEquals(LocalDate.of(2026, 9, 13), reportToday("Asia/Shanghai", instant))
        assertEquals(LocalDate.of(2026, 9, 12), reportToday("UTC", instant))
    }

    @Test fun datePickerMillisRoundTripThroughUtcMidnight() {
        val day = LocalDate.of(2026, 9, 12)
        assertEquals(day, reportDateFromPickerMillis(reportPickerMillis(day)))
        // M3 hands back UTC midnight for the day the user tapped. Reading it in the phone's own zone
        // would move the boundary a day east of Greenwich, so both directions are pinned to UTC.
        assertEquals(86_400_000L, reportPickerMillis(LocalDate.of(1970, 1, 2)))
        assertEquals(LocalDate.of(1970, 1, 2), reportDateFromPickerMillis(86_400_000L))
        assertEquals(LocalDate.of(1970, 1, 2), reportDateFromPickerMillis(86_400_000L + 82_800_000L))
    }

    @Test fun rangeWiresAsInclusiveIsoDays() {
        val range = ReportDateRange(LocalDate.of(2026, 9, 6), LocalDate.of(2026, 9, 12))
        assertEquals("2026-09-06", range.fromWire)
        assertEquals("2026-09-12", range.toWire)
        assertEquals("2026-09-06 至 2026-09-12", range.label)
        assertEquals("2026-09-12", ReportDateRange(range.to, range.to).label)
    }

    @Test fun answerModeLabelSeparatesAiTimeoutAiHumanAndMissedCalls() {
        assertEquals("AI 接听", reportAnswerModeLabel("ai", "ai", "2026-09-12T02:00:01Z"))
        assertEquals("超时 AI", reportAnswerModeLabel("timeout_ai", "ai", "2026-09-12T02:00:20Z"))
        assertEquals("真人", reportAnswerModeLabel("normal", "android", "2026-09-12T02:00:05Z"))
        assertEquals("真人", reportAnswerModeLabel("timeout_ai", "ios", "2026-09-12T02:00:05Z"))
        assertEquals("未接", reportAnswerModeLabel("normal", null, null))
        assertEquals("未接", reportAnswerModeLabel(null, null, null))
    }

    @Test fun summaryPlaceholderExplainsEveryNonSucceededTranscriptState() {
        assertNull("succeeded renders the real summary", reportSummaryPlaceholder("succeeded"))
        assertEquals("转录处理中…", reportSummaryPlaceholder("queued"))
        assertEquals("转录处理中…", reportSummaryPlaceholder("running"))
        assertEquals("转录处理中…", reportSummaryPlaceholder("retry"))
        assertEquals("转录失败，原始录音仍可查看", reportSummaryPlaceholder("failed"))
        assertEquals("无转录：录音为空", reportSummaryPlaceholder(TRANSCRIPT_STATE_NONE))
    }

    @Test fun compactTimestampsDropWhatTheReaderAlreadyKnows() {
        val now = Instant.parse("2026-09-12T06:00:00Z")
        val zone = "Asia/Shanghai"
        assertEquals("10:30", formatCompactGatewayDateTime("2026-09-12T02:30:00Z", zone, now))
        assertEquals("09-01 10:30", formatCompactGatewayDateTime("2026-09-01T02:30:00Z", zone, now))
        assertEquals("2025-09-01 10:30", formatCompactGatewayDateTime("2025-09-01T02:30:00Z", zone, now))
        assertEquals("时间待确认", formatCompactGatewayDateTime("", zone, now))
    }

    @Test fun shortDurationLabelStaysOnOneLine() {
        assertEquals("48 秒", talkDurationShortLabel("2026-09-12T02:00:00Z", "2026-09-12T02:00:48Z"))
        assertEquals("2 分 05 秒", talkDurationShortLabel("2026-09-12T02:00:00Z", "2026-09-12T02:02:05Z"))
        assertNull(talkDurationShortLabel(null, "2026-09-12T02:02:05Z"))
    }

    @Test fun classifierSilenceRendersAsUnclassifiedNotAsSafe() {
        val item = reportItem()
        assertTrue(reportClassificationUnknown(item))
        assertFalse(reportClassificationUnknown(item.copy(blockRecommended = false)))
        assertFalse(reportClassificationUnknown(item.copy(blockRecommended = true)))
    }

    private fun reportItem() = CallReportItem(
        callId = "call-1",
        startedAt = "2026-09-12T02:00:00Z",
        direction = "incoming",
        remoteNumber = "+8619900000102",
        sim = ReportSim("sim-1", "SIM", 0),
        summary = null,
        actionItems = emptyList(),
        advertisingClassification = "unknown",
        recordingStatus = "ready",
        callUrl = "",
        transcriptUrl = "",
        recordingUrl = "",
        transcriptCompletedAt = "",
    )

    // ---- 决策 11 登录 ------------------------------------------------------------------------

    @Test fun passwordLoginWaitsForTheAuthConfigEvenWithAFullyRestoredForm() {
        // R4 A3 #1: a process death restores username/password through rememberSaveable, but the new
        // ViewModel has not read /auth/config yet. Defaults say "Turnstile off", which is exactly what
        // a real "off" looks like — so the button must stay dead until the answer arrives.
        val pending = TurnstileUiState()
        assertFalse(passwordLoginEnabled(pending, busy = false, username = "u", password = "p"))
        assertFalse(passkeyLoginEnabled(pending, busy = false, username = "u"))

        val off = TurnstileUiState(configLoaded = true)
        assertTrue(passwordLoginEnabled(off, busy = false, username = "u", password = "p"))
        assertTrue(passkeyLoginEnabled(off, busy = false, username = "u"))
    }

    @Test fun turnstileOnStillRequiresASolvedChallengeForPasswordButNotForPasskey() {
        val on = TurnstileUiState(enabled = true, siteKey = "key", configLoaded = true)
        assertFalse(passwordLoginEnabled(on, busy = false, username = "u", password = "p"))
        assertTrue("Passkey no longer depends on Turnstile", passkeyLoginEnabled(on, busy = false, username = "u"))
        val solved = on.copy(token = "token")
        assertTrue(passwordLoginEnabled(solved, busy = false, username = "u", password = "p"))
    }

    @Test fun aFailedConfigReadIsStillLoadedAndCarriesAnExplanation() {
        val failed = TurnstileUiState(configLoaded = true, configError = TURNSTILE_CONFIG_FAILED_MESSAGE)
        assertFalse(failed.required)
        assertEquals("人机验证配置加载失败，请检查网络", failed.configError)
        // The form is usable again (the server is the authority); it just stops pretending it knows.
        assertTrue(passwordLoginEnabled(failed, busy = false, username = "u", password = "p"))
    }

    @Test fun busyOrEmptyFieldsAlwaysWin() {
        val ready = TurnstileUiState(configLoaded = true)
        assertFalse(passwordLoginEnabled(ready, busy = true, username = "u", password = "p"))
        assertFalse(passwordLoginEnabled(ready, busy = false, username = " ", password = "p"))
        assertFalse(passwordLoginEnabled(ready, busy = false, username = "u", password = ""))
        assertFalse(passkeyLoginEnabled(ready, busy = false, username = ""))
    }

    // ---- 决策 11 已保存的账号 ----------------------------------------------------------------

    /**
     * Two independent SharedPreferences files, the way the app has them: `session_vault` for the
     * session token and `last_login_vault` for the saved account.
     */
    private class FakePrefsFiles {
        val files = mutableMapOf<String, MutableMap<String, String>>()
        fun store(name: String): LastLoginBlobStore = object : LastLoginBlobStore {
            override fun read(): String? = files[name]?.get("blob")
            override fun write(blob: String) { files.getOrPut(name) { mutableMapOf() }["blob"] = blob }
            override fun clear() { files.remove(name) }
        }
        fun clearFile(name: String) { files.remove(name) }
    }

    @Test fun savedCredentialsRoundTripAndSurviveTheLogoutThatClearsTheSessionVault() {
        val prefs = FakePrefsFiles()
        val sessionVault = prefs.store("session_vault")
        val store = LastLoginStore(prefs.store("last_login_vault"))
        sessionVault.write("session-token-blob")
        store.save(" operator ", "s3cret pass")
        assertEquals(LastLogin("operator", "s3cret pass"), store.read())

        // logout() -> SessionVault.clear(): its own prefs file and its own KeyStore alias, nothing
        // else. That separation is the entire reason this is not a field inside SessionVault.
        prefs.clearFile("session_vault")
        assertNull(sessionVault.read())
        assertEquals(LastLogin("operator", "s3cret pass"), store.read())

        // "忘记已保存的账号" is the only thing that removes it.
        store.clear()
        assertNull(store.read())
    }

    @Test fun passkeyLoginRefreshesTheUsernameAndKeepsThatAccountsPassword() {
        val store = LastLoginStore(FakePrefsFiles().store("last_login_vault"))
        store.save("operator", "pw")
        store.saveUsername("operator")
        assertEquals(LastLogin("operator", "pw"), store.read())
    }

    @Test fun aDifferentAccountNeverInheritsThePreviousPassword() {
        val store = LastLoginStore(FakePrefsFiles().store("last_login_vault"))
        store.save("operator", "pw")
        store.saveUsername("someone-else")
        assertEquals(LastLogin("someone-else", ""), store.read())
    }

    @Test fun blankOrCorruptEntriesDecodeToNothing() {
        val store = LastLoginStore(FakePrefsFiles().store("last_login_vault"))
        store.save("", "pw")
        store.save("operator", "")
        assertNull(store.read())
        assertNull(decodeLastLogin(null))
        assertNull(decodeLastLogin("no-separator"))
        assertNull(decodeLastLogin("\u0000pw"))
        assertEquals(LastLogin("u", "p"), decodeLastLogin(encodeLastLogin(LastLogin("u", "p"))))
    }

    // ---- R4 Part B 音频恢复倒计时 -------------------------------------------------------------

    @Test fun graceCountdownTicksDownAndNeverGoesNegative() {
        val failedAt = 1_000_000L
        assertEquals(CallMediaGracePolicy.GRACE_SECONDS, mediaGraceRemainingSeconds(failedAt, failedAt))
        assertEquals(20, mediaGraceRemainingSeconds(failedAt, failedAt + 10_000))
        assertEquals(0, mediaGraceRemainingSeconds(failedAt, failedAt + 45_000))
        // An older build (or a state restored without the timestamp) shows the full window.
        assertEquals(CallMediaGracePolicy.GRACE_SECONDS, mediaGraceRemainingSeconds(null, failedAt))
        assertEquals("未恢复音频将在 20 秒后自动结束通话", mediaGraceCountdownFootnote(20))
    }

    @Test fun failureStampsTheGraceStartSoTheCountdownIsNotRestartedByRecomposition() {
        var published = CallMediaUiState()
        var clock = 5_000L
        val machine = CallMediaStateMachine({ }, { published = it }, { clock })
        val token = machine.begin("call-1", CallMediaTransport.UDP)
        assertNull(published.failedAtMillis)
        machine.failed(token, "音频连接失败")
        assertEquals(5_000L, published.failedAtMillis)
        clock = 9_000L
        assertEquals(26, mediaGraceRemainingSeconds(published.failedAtMillis, clock))
    }
}
