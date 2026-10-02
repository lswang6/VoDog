package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S21 §F — every remote number in the app goes through [callTitle] / [numberWithContactName], so a
 * call cannot read "199…0101 · 张三" on one screen and a bare number on the next. The name is purely
 * additive: a pre-S21 row has no `contactName` and must render exactly as it did in S20.
 */
class ContactDisplayTest {
    @Test fun `a call without contactName renders exactly the number, as before S21`() {
        val legacy = JSONObject().put("id", "call-1").put("remoteNumber", "+8619900000101")
        assertEquals("+8619900000101", callTitle(legacy))
        assertEquals("+8619900000101", callTitle(legacy.put("contactName", JSONObject.NULL)))
        assertEquals("+8619900000101", callTitle(JSONObject(legacy.toString()).put("contactName", "   ")))
    }

    @Test fun `a resolved call renders 号码 · 姓名`() {
        val resolved = JSONObject().put("id", "call-1").put("remoteNumber", "+8619900000101")
            .put("contactName", "张三")
        assertEquals("+8619900000101 · 张三", callTitle(resolved))
    }

    @Test fun `a call with neither number nor name still has a heading`() {
        // S95b §C: the internal call id is never used as a heading.
        assertEquals("号码未知", callTitle(JSONObject().put("id", "call-1")))
        assertEquals("号码未知", callTitle(JSONObject()))
    }

    @Test fun `a name identical to the number is not printed twice`() {
        assertEquals("19900000201", numberWithContactName("19900000201", "19900000201"))
        assertEquals("号码未知", numberWithContactName("", null))
        assertEquals("号码未知", numberWithContactName("null", null))
        assertEquals("19900000201 · 张三", numberWithContactName("19900000201", " 张三 "))
    }

    /** S36 C5-a: 列表行拆两行——有姓名时第一行姓名、第二行完整号码；没有姓名只剩号码那一行。 */
    @Test fun `a call row splits the name onto its own line and never trims the number`() {
        val resolved = JSONObject().put("id", "call-1").put("remoteNumber", "+8619900000101")
            .put("contactName", "张三")
        assertEquals("张三" to "+8619900000101", callRowLines(resolved))
        assertEquals(
            null to "+8619900000101",
            callRowLines(JSONObject().put("id", "call-1").put("remoteNumber", "+8619900000101")),
        )
        // 姓名等于号码不重复，没有号码也仍然有一行可印。
        assertEquals(
            null to "19900000201",
            callRowLines(JSONObject().put("remoteNumber", "19900000201").put("contactName", "19900000201")),
        )
        assertEquals(null to "号码未知", callRowLines(JSONObject())) // S95b §C: never the internal id
    }

    /**
     * S36 C5-b: 确认后拨打用哪张卡 —— 记录带的卡还在就用它，否则用拨号盘当前选中的，最后退到第一张
     * 能打电话的卡；一张都没有时返回 null，界面回到「只填号码」的老路径。
     */
    @Test fun `confirm-then-dial resolves the record SIM, then the selection, then the first usable`() {
        fun sim(id: String, usable: Boolean) = ClientSim(
            id = id, gatewayId = "gw", label = id, phoneLabel = null, slotIndex = 0, countryIso = null,
            embedded = null, present = usable, assignmentPending = false, online = usable,
            telephonyReady = usable, smsReady = usable, mediaReady = usable,
        )
        val offline = sim("sim-offline", usable = false)
        val usable = sim("sim-usable", usable = true)
        val sims = listOf(offline, usable)
        assertEquals(usable, resolveDialSim("sim-usable", "sim-offline", sims))
        assertEquals(offline, resolveDialSim("sim-gone", "sim-offline", sims))
        assertEquals(usable, resolveDialSim(null, "", sims))
        assertNull(resolveDialSim("sim-usable", "sim-usable", emptyList()))
    }

    @Test fun `interception kinds and AI roles read in Chinese`() {
        assertEquals("来电", interceptionKindLabel("call"))
        assertEquals("短信", interceptionKindLabel("sms"))
        assertEquals("拦截", interceptionKindLabel("other"))
        assertEquals("AI", aiTranscriptRoleLabel("ai"))
        assertEquals("对方", aiTranscriptRoleLabel("caller"))
        assertEquals("未知", aiTranscriptRoleLabel("system"))
    }

    @Test fun `device contact labels are localized, custom ones kept verbatim`() {
        assertEquals("手机", contactLabelText("mobile"))
        assertEquals("住宅", contactLabelText("home"))
        assertEquals("工作", contactLabelText("WORK"))
        assertEquals("公司总机", contactLabelText("company_main"))
        assertEquals("宿舍", contactLabelText("宿舍"))
        assertEquals("其他", contactLabelText(null))
        assertEquals("其他", contactLabelText("  "))
    }

    @Test fun `contact source labels cover every value the contract allows`() {
        listOf("android", "ios", "web_vcard", "web_csv", "web_picker", "manual").forEach { source ->
            assertTrue(source, contactSourceLabel(source) != "来源未知")
        }
        assertEquals("来源未知", contactSourceLabel(null))
    }

    @Test fun `an SMS thread made only of pre-S21 messages stays a plain number`() {
        val thread = thread(
            sms("1", "+8619900000101", "2026-09-11T10:00:00.000Z"),
            sms("2", "+8619900000101", "2026-09-11T10:05:00.000Z"),
        )
        assertEquals(ContactAnnotation.Empty, thread.contact)
        assertEquals("+8619900000101", thread.title)
    }

    @Test fun `the newest annotated message decides the thread name and blocked state`() {
        // The name was added to the address book after the first message arrived, and the number was
        // blocked after the second: the newest row is the current truth, not the oldest.
        val thread = thread(
            sms("1", "+8619900000101", "2026-09-11T10:00:00.000Z"),
            sms("2", "+8619900000101", "2026-09-11T10:05:00.000Z", contactName = "张三"),
            sms("3", "+8619900000101", "2026-09-11T10:09:00.000Z", contactName = "张三", blockedEntryId = "b-1"),
        )
        assertEquals("张三", thread.contact.contactName)
        assertTrue(thread.contact.blocked)
        assertEquals("b-1", thread.contact.blockedEntryId)
        assertEquals("+8619900000101 · 张三", thread.title)
    }

    @Test fun `the thread card acts on the reply number, not the display address`() {
        val withReply = thread(
            sms("1", "+8619900000101", "2026-09-11T10:00:00.000Z", contactName = "张三"),
        )
        assertEquals("+8619900000101", withReply.contactNumber)
        val target = smsContactCardTarget(withReply)
        assertEquals("+8619900000101", target.number)
        assertEquals("张三", target.annotation.contactName)
        // An SMS thread has no call behind it, so the blocklist request carries no sourceCallId.
        assertNull(target.sourceCallId)
        // A shortcode that cannot be replied to still yields the address rather than a blank card.
        val noReply = thread(
            sms("1", "106900", "2026-09-11T10:00:00.000Z", replyable = false),
        )
        assertEquals("106900", noReply.contactNumber)
        assertTrue(dialableNumber(noReply.contactNumber))
    }

    @Test fun `a push may carry contactName and remoteNumber but still rejects any other extra key`() {
        val callId = "11111111-1111-4111-8111-111111111111"
        val notificationId = "22222222-2222-4222-8222-222222222222"
        val base = mapOf(
            "version" to "1",
            "event" to "call.incoming",
            "callId" to callId,
            "notificationId" to notificationId,
        )
        assertEquals(
            IncomingPush("call.incoming", callId, notificationId, "张三"),
            parseIncomingPush(base + ("contactName" to "张三")),
        )
        assertEquals(IncomingPush("call.incoming", callId, notificationId), parseIncomingPush(base))
        // S36 C1: `remoteNumber` joined the allow-list next to `contactName`.
        assertEquals(
            IncomingPush("call.incoming", callId, notificationId, "张三", "+86186"),
            parseIncomingPush(base + ("contactName" to "张三") + ("remoteNumber" to "+86186")),
        )
        // A blank name is the same as no name, and any other extra key still drops the push.
        assertNull(parseIncomingPush(base + ("contactName" to "张三") + ("callerHint" to "+86186")))
        assertNull(parseIncomingPush(base + ("contactName" to "张三") - "callId")
        )
        assertNull(parseIncomingPush(base + ("contactName" to "   "))?.contactName)
    }

    private fun thread(vararg messages: JSONObject): SmsConversation =
        smsConversations(messages.toList(), "sim-a").single()

    private fun sms(
        id: String,
        address: String,
        timestamp: String,
        contactName: String? = null,
        blockedEntryId: String? = null,
        replyable: Boolean = true,
    ): JSONObject = JSONObject()
        .put("id", id)
        .put("simId", "sim-a")
        .put("direction", "incoming")
        .put("remoteNumber", address)
        .put("conversationAddress", address)
        .put("replyNumber", if (replyable) address else JSONObject.NULL)
        .put("canReply", replyable)
        .put("body", "hi")
        .put("state", "delivered")
        .put("receivedAt", timestamp)
        .apply {
            contactName?.let { put("contactName", it).put("contactId", "c-1") }
            blockedEntryId?.let { put("blocked", true).put("blockedEntryId", it) }
        }
}
