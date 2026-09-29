package org.vodog

import android.media.AudioManager
import android.telecom.DisconnectCause
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** S72: 内部通话显示、忙线未接、网关本机、别处接听、owner 忙线、新错误码。 */
class S72ClientPolicyTest {
    private val callId = "11111111-1111-4111-8111-111111111111"
    private val notificationId = "22222222-2222-4222-8222-222222222222"

    private fun internalCall(direction: String, id: String = "c-$direction") = JSONObject()
        .put("id", id).put("direction", direction).put("state", "ended").put("internal", true)
        .put("peerSimLabel", "Demo SIM A").put("remoteNumber", "+8618600000000")
        .put("sim", JSONObject().put("label", "Demo SIM B"))

    @Test fun internalTitleNamesBothCardsInCallDirection() {
        assertEquals("内部通话 Demo SIM A → Demo SIM B", internalCallTitle(internalCall("incoming")))
        assertEquals("内部通话 Demo SIM B → Demo SIM A", internalCallTitle(internalCall("outgoing")))
        assertNull(internalCallTitle(JSONObject().put("direction", "incoming")))
        assertEquals("内部通话 另一张卡 → 本卡", internalCallTitle(true, "incoming", null, "null"))
        assertEquals("内部通话 Demo SIM A → Demo SIM B" to "+8618600000000", callRowLines(internalCall("incoming")))
    }

    @Test fun historyItemDecodesTheNewFieldsTolerantly() {
        val item = parseCallHistoryItem(internalCall("incoming").put("peerSimId", "sim-b").put("simId", "sim-a"), JSONObject().put("label", "Demo SIM B"))
        assertTrue(item.internal)
        assertEquals("sim-b", item.peerSimId)
        assertEquals("内部通话 Demo SIM A → Demo SIM B", item.internalTitle)
        val legacy = parseCallHistoryItem(JSONObject().put("id", "x").put("direction", "incoming").put("peerSimLabel", JSONObject.NULL), null)
        assertFalse(legacy.internal)
        assertNull(legacy.peerSimLabel)
        assertNull(legacy.internalTitle)
    }

    @Test fun internalIsNeverMissedAndBusyRejectHasItsOwnLabel() {
        val unanswered = internalCall("incoming")
        assertFalse(isMissedIncomingCall(unanswered))
        assertNull(missedCallLabel(unanswered))
        val busy = JSONObject().put("direction", "incoming").put("state", "failed").put("failureReason", "busy_auto_rejected")
        assertEquals("忙线未接", missedCallLabel(busy))
        assertEquals("忙线未接", failureReasonLabel("busy_auto_rejected"))
        assertEquals("无人接听", reportAnswerModeLabel("normal", null, null, internal = true))
        assertEquals("未接", reportAnswerModeLabel("normal", null, null))
        assertEquals("未接来电", missedCallLabel(JSONObject().put("direction", "incoming").put("state", "ended")))
    }

    @Test fun deviceAnswerIsTheGatewayItself() {
        assertEquals("网关本机", reportAnswerModeLabel("normal", "device", "2026-09-26T00:00:00Z"))
        assertEquals("网关本机", occupancyPlatformLabel("device"))
        assertEquals(
            "通话中 · 由 网关本机 接听 · 自 10:03",
            callOccupancyNotice(JSONObject().put("answeredByPlatform", "device").put("startedAt", "2026-09-11T02:03:00Z")),
        )
        assertEquals("通话中 · 由 AI 接听 · 自 10:03", callOccupancyNotice(JSONObject().put("answeredByPlatform", "ai").put("startedAt", "2026-09-11T02:03:00Z")))
    }

    @Test fun internalOccupancyUsesTheSpecWording() {
        val call = internalCall("incoming").put("state", "active").put("answeredByPlatform", "ios")
        assertEquals("内部通话 · Demo SIM A → Demo SIM B · 由 iPhone 端 接听", callOccupancyNotice(call))
    }

    @Test fun outgoingLegIsHiddenOnlyWhenItsIncomingPeerIsListed() {
        val incoming = internalCall("incoming", "in-1")
        val outgoing = internalCall("outgoing", "out-1").put("peerCallId", "in-1")
        assertEquals(listOf(incoming), hideMergedInternalLegs(listOf(outgoing, incoming)))
        // 没有 peerCallId（或对端不在本页）→ 两腿都留着。
        val orphan = internalCall("outgoing", "out-2")
        assertEquals(listOf(orphan, incoming), hideMergedInternalLegs(listOf(orphan, incoming)))
        assertEquals(listOf(outgoing), hideMergedInternalLegs(listOf(outgoing)))
    }

    @Test fun ringingTakenElsewhereIsAnsweredElsewhereNotCancelled() {
        assertEquals(DisconnectCause.ANSWERED_ELSEWHERE, ringingEndedDisconnectCause(JSONObject().put("state", "active")))
        assertEquals(DisconnectCause.ANSWERED_ELSEWHERE, ringingEndedDisconnectCause(JSONObject().put("state", "connecting")))
        assertEquals(
            DisconnectCause.ANSWERED_ELSEWHERE,
            ringingEndedDisconnectCause(JSONObject().put("state", "ended").put("answeredAt", "2026-09-26T00:00:00Z")),
        )
        assertEquals(DisconnectCause.CANCELED, ringingEndedDisconnectCause(JSONObject().put("state", "ended").put("answeredAt", JSONObject.NULL)))
        assertEquals(DisconnectCause.CANCELED, ringingEndedDisconnectCause(null))
        assertEquals(
            DisconnectCause.CANCELED,
            ringingEndedDisconnectCause(JSONObject().put("state", "ended").put("claimedByCurrentSession", true).put("answeredAt", "x")),
        )
    }

    @Test fun pushAcceptsTheInternalKeysAndTitlesTheRing() {
        val parsed = parseIncomingPush(mapOf(
            "version" to "1", "event" to "call.incoming", "callId" to callId, "notificationId" to notificationId,
            "internal" to "true", "peerSimLabel" to "Demo SIM A",
        ))!!
        assertTrue(parsed.internal)
        assertEquals("Demo SIM A", parsed.peerSimLabel)
        assertEquals("Demo SIM A（内部） 来电", incomingCallTitle("+86186", null, parsed.internal, parsed.peerSimLabel))
        assertEquals("+86186 来电", incomingCallTitle("+86186", null, false, null))
        assertNull(incomingCallTitle(null, null, false, null))
        assertFalse(parseIncomingPush(mapOf(
            "version" to "1", "event" to "call.incoming", "callId" to callId, "notificationId" to notificationId, "internal" to "false",
        ))!!.internal)
    }

    @Test fun audioModeFallbackCountsCellularAndVoip() {
        assertTrue(audioModeInCall(AudioManager.MODE_IN_CALL))
        assertTrue(audioModeInCall(AudioManager.MODE_IN_COMMUNICATION))
        assertFalse(audioModeInCall(AudioManager.MODE_NORMAL))
        assertFalse(audioModeInCall(AudioManager.MODE_RINGTONE))
    }

    @Test fun newConflictCodesReadInChinese() {
        assertEquals("同一设备上的两张卡不能互打", ApiError(409, "SAME_DEVICE_INTERNAL", "x").userMessage())
        assertEquals("这是你正在拨出的通话", ApiError(409, "OWN_OUTGOING_CALL", "x").userMessage())
    }
}
