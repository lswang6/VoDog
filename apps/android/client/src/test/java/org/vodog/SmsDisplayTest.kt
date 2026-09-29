package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsDisplayTest {
    @Test fun heldQueueAndUnknownExecutionHaveDistinctHumanReadableStatus() {
        val held = statusMessage("queued", "sms_gateway_execution_unresolved")
        val unknown = statusMessage("unknown", "sms_execution_unresolved")
        assertEquals("等待上一条短信状态确认", smsStateLabel(held))
        assertEquals("短信执行结果待确认", smsStateLabel(unknown))
        for (message in listOf(held, unknown)) {
            assertTrue(smsRowCaption(message, "SIM 1").contains(smsStateLabel(message)))
            assertTrue(smsSubtitle(message.raw, "SIM 1").contains(smsStateLabel(message)))
            assertTrue(!smsSubtitle(message.raw, "SIM 1").contains("sms_"))
            assertEquals(null, smsFailureDetail(message.raw))
        }
    }

    @Test fun undispatchedAndChangedRouteFailuresAreExplainedWithoutRawCodes() {
        val cases = mapOf(
            "sms_not_dispatched" to "发送失败：短信未下发到号码设备",
            "sms_route_changed_before_release" to "发送失败：发送前号码线路已变更",
        )
        cases.forEach { (reason, expected) ->
            val message = statusMessage("failed", reason)
            assertEquals(expected, smsStateLabel(message))
            assertTrue(smsRowCaption(message, "SIM 1").contains(expected))
            assertTrue(smsSubtitle(message.raw, "SIM 1").contains(expected))
            assertTrue(!smsSubtitle(message.raw, "SIM 1").contains(reason))
            assertEquals(null, smsFailureDetail(message.raw))
        }
    }

    @Test fun staleReasonCannotOverrideLaterDeliveryAndOrdinaryQueueRemainsQueued() {
        assertEquals("排队中", smsStateLabel(statusMessage("queued", "")))
        assertEquals("发送中", smsStateLabel(statusMessage("sending", "sms_gateway_execution_unresolved")))
        assertEquals("已发送", smsStateLabel(statusMessage("sent", "sms_execution_unresolved")))
        assertEquals("已送达", smsStateLabel(statusMessage("delivered", "sms_gateway_execution_unresolved")))
    }

    private fun statusMessage(state: String, reason: String): ClientSmsMessage = JSONObject()
        .put("id", "sms-test").put("simId", "sim-test").put("direction", "outgoing")
        .put("remoteNumber", "10086").put("body", "draft")
        .put("state", state).put("failureReason", reason).toClientSmsMessage()

    @Test fun outboundDeliveredShowsSimDirectionAndRealReceiptState() {
        val sms = JSONObject()
            .put("direction", "outgoing")
            .put("remoteNumber", "+12025550123")
            .put("body", "hello")
            .put("state", "delivered")
            .put("deliveredAt", "2026-09-09T12:00:00Z")

        assertEquals("发出 · +12025550123", smsTitle(sms))
        val subtitle = smsSubtitle(sms, "Office SIM")
        assertTrue(subtitle.startsWith("Office SIM · 已送达 · hello · 2026年9月9日 "))
        assertTrue(!subtitle.contains("T12:00:00Z"))
    }

    @Test fun incomingAndFailedStatesRemainDistinct() {
        val incoming = JSONObject().put("direction", "incoming").put("state", "delivered")
            .put("body", "received").put("receivedAt", "2026-09-09T12:01:00Z")
        val failed = JSONObject().put("direction", "outgoing").put("state", "failed")
            .put("body", "not sent").put("failureReason", "radio_off")

        assertTrue(smsTitle(incoming).startsWith("收到 ·"))
        assertTrue(smsSubtitle(incoming, "SIM 2").contains("SIM 2 · 已收到"))
        assertTrue(smsSubtitle(failed, "SIM 1").contains("发送失败 · not sent · radio_off"))
    }

    /**
     * iOS `testConversationLineCaptionIsDisplayNameWithoutDeviceIdentity`（ExpandedUIStateTests.swift:57）
     * 的 Android 镜像：会话页只留一行号码名。Android 用自己的 `displayLabel` 次序（号码标注优先），
     * 其余判据逐条一致——没有设备 id、没有 SIM id、没有用途词，只有一行。
     */
    @Test fun conversationLineCaptionIsDisplayNameWithoutDeviceIdentity() {
        val labelled = JSONObject("""{"id":"sim-a","gatewayId":"gateway-aaaaaaaa","label":"办公卡","phoneLabel":"+8619900000201","online":true}""")
            .toClientSim()
        val bare = JSONObject("""{"id":"sim-b","gatewayId":"gateway-bbbbbbbb","slotIndex":1,"online":true}""")
            .toClientSim()

        assertEquals("+8619900000201", ConversationLineCaption.text(labelled))
        assertEquals("SIM 2", ConversationLineCaption.text(bare))
        assertEquals(null, ConversationLineCaption.text(null))

        val caption = ConversationLineCaption.text(labelled).orEmpty()
        assertTrue(!caption.contains("回复"))
        assertTrue(!caption.contains("短信"))
        assertTrue(!caption.contains("PX-"))
        assertTrue(!caption.contains("sim-a"))
        assertTrue(!caption.contains("gateway-aaaaaaaa"))
        assertEquals(1, caption.lines().size)
    }

    @Test fun sentIsNotPresentedAsDelivered() {
        val sent = JSONObject().put("direction", "outgoing").put("state", "sent").put("body", "sent")
        val text = smsSubtitle(sent, "SIM 1")
        assertTrue(text.contains("已发送"))
        assertTrue(!text.contains("已送达"))
    }
}
