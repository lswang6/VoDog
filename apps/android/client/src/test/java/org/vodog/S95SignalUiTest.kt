package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class S95SignalUiTest {
    @Test
    fun verificationCodeNeedsKeywordAndPrefersDigitsAfterIt() {
        assertEquals("482913", smsVerificationCode("【服务】您的验证码为 482913，5 分钟内有效"))
        assertEquals("1234", smsVerificationCode("10690000 验证码 1234"))
        assertEquals("778899", smsVerificationCode("778899 is your code"))
        assertEquals("5521", smsVerificationCode("Your OTP: 5521"))
        assertNull(smsVerificationCode("会议改到 1430，房间 2201"))
        assertNull(smsVerificationCode("验证码已失效"))
        assertNull(smsVerificationCode("验证码 123"))
        assertNull(smsVerificationCode("验证码 123456789"))
    }

    @Test
    fun aiBadgeTextAndLabelFollowTheAnswerMode() {
        assertNull(aiBadgeText("normal"))
        assertNull(aiBadgeText(null))
        assertNull(aiBadgeText("unknown", 30, compact = false))
        assertEquals("AI", aiBadgeText("ai"))
        assertEquals("AI", aiBadgeText("timeout_ai", 30))
        assertEquals("AI 代接", aiBadgeText("ai", 30, compact = false))
        assertEquals("AI · 30 秒后", aiBadgeText("timeout_ai", 30, compact = false))
        assertEquals("AI 兜底", aiBadgeText("timeout_ai", null, compact = false))
        assertNull(aiBadgeAccessibilityLabel("normal"))
        assertEquals("AI 代接已开启，立即由 AI 接听", aiBadgeAccessibilityLabel("ai"))
        assertEquals("AI 代接已开启，响铃 45 秒无人接听后由 AI 接听", aiBadgeAccessibilityLabel("timeout_ai", 45))
    }

    @Test
    fun transcriptStatusNeverShowsProviderModelOrErrorCodes() {
        val provider = TranscriptProvider(TranscriptTrack.entries.first(), "openai-compatible", "gemini-3.8-flash-low", "v1")
        val result = TranscriptResult("你好", emptyList(), listOf(provider), "unknown", true, null, emptyList())
        fun transcript(status: String, next: String? = null) = CallTranscript(
            "job-1", "call-1", status, 2, next, "openai-compatible:gemini-3.8-flash-low", "upstream 503 from xai",
            result, "2026-10-02T05:00:00Z", "2026-10-02T05:00:00Z", null,
        )
        for (status in listOf("queued", "running", "retry", "failed", "weird_status")) {
            val text = transcriptStatusText(transcript(status, "2026-10-02T05:58:00Z")).orEmpty()
            for (raw in listOf("openai", "gemini", "flash", "xai", "503", "job-1", "weird_status", "T05:58")) {
                assertFalse("$status leaked $raw: $text", text.contains(raw))
            }
        }
        assertEquals("转写失败", transcriptStatusText(transcript("failed")))
        assertNull(transcriptStatusText(transcript("succeeded")))
    }

    @Test
    fun englishExceptionTextIsNeverShown() {
        assertEquals("网络连接失败，请稍后重试", java.net.UnknownHostException("Unable to resolve host \"x\"").userMessage())
        assertEquals("操作失败，请稍后重试", IllegalStateException("boom").userMessage())
        assertEquals("网络测量未完成，请重试", IllegalStateException("网络测量未完成，请重试").userMessage())
    }

    @Test
    fun simTailDigitsKeepsLastFour() {
        assertEquals("0101", simTailDigits("+1 202 555 0101"))
        assertNull(simTailDigits("123"))
        assertNull(simTailDigits(null))
    }
}

class S95CompactTimeTest {
    @org.junit.Test
    fun compactListTimeShortensTodayAndThisYear() {
        val zone = java.time.ZoneId.of("Asia/Shanghai")
        val now = java.time.Instant.parse("2026-10-02T06:00:00Z")
        org.junit.Assert.assertEquals("13:58", compactListTime("2026-10-02T05:58:00Z", zone, now))
        org.junit.Assert.assertEquals("9月28日", compactListTime("2026-09-28T05:58:00Z", zone, now))
        org.junit.Assert.assertEquals(displayDateTime("2025-09-28T05:58:00Z"), compactListTime("2025-09-28T05:58:00Z", zone, now))
    }
}

class S95bRecordsRowTest {
    @org.junit.Test
    fun daySectionsAndRowTime() {
        val zone = java.time.ZoneId.of("Asia/Shanghai")
        val now = java.time.Instant.parse("2026-10-02T06:00:00Z") // Friday 14:00 local
        org.junit.Assert.assertEquals("今天", callDaySectionLabel("2026-10-02T01:00:00Z", zone, now))
        org.junit.Assert.assertEquals("昨天", callDaySectionLabel("2026-10-01T01:00:00Z", zone, now))
        org.junit.Assert.assertEquals("周一", callDaySectionLabel("2026-09-28T01:00:00Z", zone, now))
        org.junit.Assert.assertEquals("9月20日", callDaySectionLabel("2026-09-20T01:00:00Z", zone, now))
        org.junit.Assert.assertEquals("2025年9月20日", callDaySectionLabel("2025-09-20T01:00:00Z", zone, now))
        org.junit.Assert.assertEquals("时间待确认", callDaySectionLabel("null", zone, now))
        org.junit.Assert.assertEquals("09:05", callRowTime("2026-10-02T01:05:00Z", zone))
        org.junit.Assert.assertEquals("", callRowTime("", zone))
        org.junit.Assert.assertEquals("09:05", callRelativeTime("2026-10-02T01:05:00Z", zone, now))
        org.junit.Assert.assertEquals("昨天", callRelativeTime("2026-10-01T01:00:00Z", zone, now))
        org.junit.Assert.assertEquals("周一", callRelativeTime("2026-09-28T01:00:00Z", zone, now))
        org.junit.Assert.assertEquals("9/20", callRelativeTime("2026-09-20T01:00:00Z", zone, now))
        org.junit.Assert.assertEquals("2025/9/20", callRelativeTime("2025-09-20T01:00:00Z", zone, now))
    }

    @org.junit.Test
    fun recordsSegmentsUseTheUnifiedLabels() {
        org.junit.Assert.assertEquals(listOf("通话", "转录报告", "拦截"), HistoryView.entries.map { it.label })
    }
}
