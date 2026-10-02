package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S38 三端合同: 手机自动拦截 / 通过手机拨打 / 忙线冲突. Everything the client does with the new fields is a
 * pure mapping, so the wording can be read here without a device.
 */
class S38ClientPolicyTest {

    private fun call(
        originatingPlatform: String? = null,
        failureReason: String? = null,
        conflictDisposition: String? = null,
        blockedSource: String? = null,
    ): JSONObject = JSONObject().put("id", "call-1").apply {
        put("originatingPlatform", originatingPlatform ?: JSONObject.NULL)
        put("failureReason", failureReason ?: JSONObject.NULL)
        put("conflictDisposition", conflictDisposition ?: JSONObject.NULL)
        put("blockedSource", blockedSource ?: JSONObject.NULL)
    }

    // ---- 列表行 badge ------------------------------------------------------------------------

    @Test fun aPixelDialledCallSaysItWasDialledOnThePhone() {
        assertEquals("通过手机拨打", s38CallBadgeLabel(call(originatingPlatform = "pixel")))
        assertTrue(isPixelOriginatedCall(call(originatingPlatform = "pixel")))
    }

    @Test fun busyAutoRejectWins() {
        assertEquals(
            "忙线未接",
            s38CallBadgeLabel(call(failureReason = "busy_auto_rejected", conflictDisposition = "rejected")),
        )
    }

    @Test fun busyAiAnswerIsItsOwnBadge() {
        assertEquals("忙线 AI 代接", s38CallBadgeLabel(call(conflictDisposition = "ai_answered")))
    }

    @Test fun anOrdinaryCallGetsNoExtraLine() {
        assertNull(s38CallBadgeLabel(call(originatingPlatform = "android")))
        // JSON null must not leak as the string "null" through optString.
        assertNull(s38CallBadgeLabel(JSONObject().put("id", "call-1")))
    }

    @Test fun anUnknownDispositionIsIgnoredRatherThanRendered() {
        assertNull(s38CallBadgeLabel(call(conflictDisposition = "something_new")))
    }

    // ---- S38b 拦截行 ------------------------------------------------------------------------

    @Test fun aBlockedCallRowNamesWhoInterceptedIt() {
        assertEquals("手机自动拦截", s38CallBadgeLabel(call(failureReason = "number_blocked", blockedSource = "phone")))
        assertEquals("网关拦截", s38CallBadgeLabel(call(failureReason = "number_blocked", blockedSource = "gateway")))
        assertEquals("服务器拦截", s38CallBadgeLabel(call(failureReason = "number_blocked", blockedSource = "control")))
    }

    @Test fun aBlockedCallWithoutASourceStillSaysItWasBlocked() {
        // JSON null 和整把键缺席都要落到同一句话。
        assertEquals("已拦截", s38CallBadgeLabel(call(failureReason = "number_blocked")))
        assertEquals("已拦截", s38CallBadgeLabel(JSONObject().put("failureReason", "number_blocked")))
        assertEquals("已拦截", s38CallBadgeLabel(call(failureReason = "number_blocked", blockedSource = "future_source")))
    }

    @Test fun theInterceptionBadgeWinsOverTheOtherS38Lines() {
        assertEquals(
            "手机自动拦截",
            s38CallBadgeLabel(call(originatingPlatform = "pixel", failureReason = "number_blocked", blockedSource = "phone")),
        )
        assertNull(blockedCallSourceLabel(call(failureReason = "busy_auto_rejected")))
    }

    /** 记录页的 `/calls` 请求必须显式要拦截行，否则服务端默认把它们藏起来。 */
    @Test fun theRecordsCallsRouteAsksForBlockedRows() {
        assertTrue(ClientApiRoutes.callsPage().contains("includeBlocked=true"))
        assertTrue(ClientApiRoutes.callsPage("189", "sim-1", 2, 100).contains("includeBlocked=true"))
    }

    // ---- 失败原因 ----------------------------------------------------------------------------

    @Test fun theBusyRejectReasonIsTranslated() {
        assertEquals("忙线未接", failureReasonLabel("busy_auto_rejected"))
    }

    @Test fun anyOtherReasonStaysVerbatimAndBlanksStayHidden() {
        assertEquals("号码已拦截", failureReasonLabel("number_blocked"))
        // S95b §C: an unknown raw enum is hidden, never printed verbatim.
        assertNull(failureReasonLabel("some_future_reason"))
        assertNull(failureReasonLabel(null))
        assertNull(failureReasonLabel(""))
        assertNull(failureReasonLabel("null"))
    }

    // ---- 拦截来源 ----------------------------------------------------------------------------

    @Test fun interceptionSourcesAreNamed() {
        assertEquals("手机自动拦截", interceptionSourceLabel("phone"))
        assertEquals("网关拦截", interceptionSourceLabel("gateway"))
        assertEquals("服务器拦截", interceptionSourceLabel("control"))
    }

    @Test fun anAbsentOrUnknownInterceptionSourceAddsNothing() {
        assertNull(interceptionSourceLabel(null))
        assertNull(interceptionSourceLabel("future_source"))
    }

    @Test fun anInterceptionDecodesThePhoneSource() {
        val row = JSONObject()
            .put("id", "int-1")
            .put("kind", "call")
            .put("remoteNumber", "19900000103")
            .put("occurredAt", "2026-09-17T06:24:00Z")
            .put("source", "phone")
            .toClientInterception()
        assertEquals("phone", row.source)
        assertEquals("手机自动拦截", interceptionSourceLabel(row.source))
    }

    // ---- 占用条 ------------------------------------------------------------------------------

    @Test fun aPixelOccupantIsNamedRatherThanCalledUnknown() {
        assertEquals("手机通话中", callOccupancyLabel(JSONObject().put("originatingPlatform", "pixel")))
        // 真机上 optString("answeredByPlatform", fallback) 对 JSON null 会回 "null" 而不是 fallback。
        val nulled = JSONObject().put("answeredByPlatform", JSONObject.NULL).put("originatingPlatform", "pixel")
        assertEquals("手机通话中", callOccupancyLabel(nulled))
        assertEquals("手机端", callOwnerLabel(nulled))
        assertEquals("手机端", occupancyPlatformLabel("pixel"))
        assertEquals("手机端", callOwnerLabel(JSONObject().put("originatingPlatform", "pixel")))
    }

    @Test fun aMacOccupantIsNamed() {
        assertEquals("Mac 端通话", callOccupancyLabel(JSONObject().put("answeredByPlatform", "macos")))
        assertEquals("Mac 端", occupancyPlatformLabel("macos"))
    }

    @Test fun theOccupancyBannerSaysTheSameThingAsIosAndWeb() {
        val call = call(originatingPlatform = "pixel").put("startedAt", "2026-09-18T01:00:00Z")
        assertEquals("手机通话中", callOccupantLabel(call))
        assertTrue(callOccupancyNotice(call, "Asia/Shanghai").startsWith("通话中 · 由 手机本机 接听 · 自 "))
    }

    @Test fun thePixelOccupantSurvivesTheOccupancyWhitelist() {
        val occupancy = JSONObject()
            .put("occupancy", JSONObject().put("holdsLock", true).put("occupantPlatform", "pixel"))
            .toCallOccupancy()
        assertEquals("pixel", occupancy?.occupantPlatform)
    }

    @Test fun aPixelDialledCallOffersNoReleaseButtonEvenIfTheServerSaysItMay() {
        val call = call(originatingPlatform = "pixel").put(
            "occupancy",
            JSONObject().put("holdsLock", true).put("canRelease", true).put("isCurrentSession", false),
        )
        assertFalse(canReleaseOccupiedCall(call))
        // The same payload without the pixel origin still releases, so the guard is the only reason.
        assertTrue(canReleaseOccupiedCall(call(originatingPlatform = "android").put("occupancy", call.getJSONObject("occupancy"))))
    }
}
