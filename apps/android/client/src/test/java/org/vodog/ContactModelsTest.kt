package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S21 §A 架构决策 3 — `contactId/contactName/blocked/blockedEntryId` are optional on every DTO,
 * because a control service deployed before this round omits them entirely. Reading a pre-S21 row
 * has to produce "unknown contact, not blocked", never an exception and never a blocked=true.
 */
class ContactModelsTest {
    @Test fun `call and sms rows without the S21 fields read as unknown and unblocked`() {
        val legacyCall = JSONObject()
            .put("id", "call-1").put("simId", "sim-1").put("remoteNumber", "+8619900000101")
            .put("direction", "incoming").put("state", "ended")
        val annotation = legacyCall.toContactAnnotation()
        assertNull(annotation.contactId)
        assertNull(annotation.contactName)
        assertFalse(annotation.blocked)
        assertNull(annotation.blockedEntryId)
        assertEquals(ContactAnnotation.Empty, annotation)
    }

    @Test fun `explicit nulls are not turned into blank strings`() {
        val nulled = JSONObject()
            .put("contactId", JSONObject.NULL)
            .put("contactName", JSONObject.NULL)
            .put("blockedEntryId", JSONObject.NULL)
            .put("blocked", false)
        val annotation = nulled.toContactAnnotation()
        assertNull(annotation.contactId)
        assertNull(annotation.contactName)
        assertNull(annotation.blockedEntryId)
        assertFalse(annotation.blocked)
    }

    @Test fun `a blocked row carries the entry id the card needs to unblock`() {
        val blocked = JSONObject()
            .put("contactId", "c-1").put("contactName", "张三")
            .put("blocked", true).put("blockedEntryId", "b-9")
        assertEquals(
            ContactAnnotation("c-1", "张三", true, "b-9"),
            blocked.toContactAnnotation(),
        )
    }

    @Test fun `contact parsing keeps every phone email and address`() {
        val contact = contactJson().toClientContact()
        assertEquals("张三", contact.displayName)
        assertEquals(1L, contact.version)
        assertEquals(2, contact.phones.size)
        assertEquals("+8619900000101", contact.phones[0].e164)
        assertTrue(contact.phones[0].isPrimary)
        assertFalse(contact.phones[1].isPrimary)
        assertEquals("a@b.c", contact.emails.single().address)
        assertEquals("上海市浦东新区", contact.addresses.single().displayLine)
        assertEquals("+8619900000101", contact.primaryPhone?.dialNumber)
        assertEquals("199 0000 0101", contact.listSubtitle)
    }

    @Test fun `a contact without any sub-array or primary flag still parses`() {
        val bare = JSONObject().put("id", "c-2").put("displayName", "李四")
            .put("phones", JSONArray().put(JSONObject().put("rawNumber", "19900000201")))
        val contact = bare.toClientContact()
        assertEquals(1L, contact.version)
        assertTrue(contact.emails.isEmpty())
        assertTrue(contact.addresses.isEmpty())
        // No isPrimary anywhere: the first phone is the one the list row shows.
        assertTrue(contact.phones.single().isPrimary)
        assertEquals("19900000201", contact.listSubtitle)
        assertNull(contact.organization)
    }

    @Test fun `contact version is parsed and never falls below the compatibility floor`() {
        assertEquals(7L, JSONObject().put("id", "c-7").put("version", 7).toClientContact().version)
        assertEquals(1L, JSONObject().put("id", "c-0").put("version", 0).toClientContact().version)
    }

    @Test fun `a nameless contact falls back rather than rendering an empty row`() {
        val nameless = JSONObject().put("id", "c-3").put("displayName", "")
        assertEquals("未命名联系人", nameless.toClientContact().displayName)
        assertEquals("无号码", nameless.toClientContact().listSubtitle)
    }

    @Test fun `an address with only parts still prints one line`() {
        val parts = JSONObject().put("id", "c-4").put("displayName", "王五").put(
            "addresses",
            JSONArray().put(
                JSONObject().put("street", "南京路 1 号").put("city", "上海市")
                    .put("country", "中国").put("postalCode", "200000"),
            ),
        )
        assertEquals("中国 上海市 南京路 1 号 200000", parts.toClientContact().addresses.single().displayLine)
    }

    @Test fun `the draft body carries nulls for omitted scalars and drops empty addresses`() {
        val draft = ContactDraft(
            displayName = "  张三  ",
            phones = listOf(ContactPhoneDraft(" 186 ", "mobile")),
            addresses = listOf(ContactAddressDraft(), ContactAddressDraft(formatted = "上海")),
        )
        val body = draft.toJson()
        assertEquals("张三", body.getString("displayName"))
        assertTrue(body.isNull("organization"))
        assertTrue(body.isNull("notes"))
        assertEquals("186", body.getJSONArray("phones").getJSONObject(0).getString("rawNumber"))
        assertEquals("mobile", body.getJSONArray("phones").getJSONObject(0).getString("label"))
        assertEquals(1, body.getJSONArray("addresses").length())
        assertFalse(body.has("sourceContactId"))
    }

    @Test fun `a draft needs a name and at least one phone or email`() {
        assertFalse(ContactDraft("张三").valid)
        assertFalse(ContactDraft("", phones = listOf(ContactPhoneDraft("186"))).valid)
        assertTrue(ContactDraft("张三", phones = listOf(ContactPhoneDraft("186"))).valid)
        assertTrue(ContactDraft("张三", emails = listOf(ContactEmailDraft("a@b.c"))).valid)
    }

    @Test fun `import counters add up across batches and read zero when absent`() {
        val first = parseContactImportResult(
            JSONObject().put("total", 3).put("created", 2).put("updated", 1).put("phonesSkipped", 4),
        )
        val second = parseContactImportResult(JSONObject().put("total", 2).put("merged", 2))
        val sum = first + second
        assertEquals(5, sum.total)
        assertEquals(2, sum.created)
        assertEquals(1, sum.updated)
        assertEquals(2, sum.merged)
        assertEquals(0, sum.skipped)
        assertEquals(4, sum.phonesSkipped)
        assertEquals("共 5 条 · 新增 2 · 更新 1 · 合并 2 · 跳过 0 · 忽略号码 4", sum.summary)
        assertEquals("共 2 条 · 新增 0 · 更新 0 · 合并 2 · 跳过 0", second.summary)
    }

    @Test fun `an interception row survives a missing sim contact and body`() {
        val minimal = JSONObject().put("id", "i-1").put("kind", "call")
            .put("remoteNumber", "+8619900000201").put("occurredAt", "2026-09-11T10:00:00.000Z")
        val parsed = minimal.toClientInterception()
        assertEquals("call", parsed.kind)
        assertNull(parsed.simId)
        assertNull(parsed.contactName)
        assertNull(parsed.bodyPreview)
        assertNull(parsed.blockedEntryId)
        val sms = JSONObject().put("id", "i-2").put("kind", "sms").put("simId", "sim-1")
            .put("remoteNumber", "106").put("occurredAt", "2026-09-11T10:00:00.000Z")
            .put("bodyPreview", "验证码").put("blockedEntryId", "b-1").put("contactName", "广告")
            .put("source", "gateway").put("simLabel", "Demo SIM B").put("gatewayTimeZone", "Europe/Paris")
        val parsedSms = sms.toClientInterception()
        assertEquals("验证码", parsedSms.bodyPreview)
        assertEquals("b-1", parsedSms.blockedEntryId)
        assertEquals("gateway", parsedSms.source)
        assertEquals("Demo SIM B", parsedSms.simLabel)
        assertEquals("Europe/Paris", parsedSms.gatewayTimeZone)
        assertEquals("Demo SIM B", interceptionSimDisplayLabel(parsedSms, null))
        assertEquals("Europe/Paris", interceptionGatewayTimeZone(parsedSms, null))
        assertEquals(
            "2026-09-11 12:00",
            formatGatewayDateTime(parsedSms.occurredAt, interceptionGatewayTimeZone(parsedSms, null)),
        )

        val currentSim = ClientSim(
            id = "sim-1", gatewayId = "g-1", label = "SIM 1", phoneLabel = "Demo line", slotIndex = 0,
            countryIso = "CN", embedded = false, present = true, assignmentPending = false, online = true,
            telephonyReady = true, smsReady = true, mediaReady = true, timeZone = "Asia/Shanghai",
        )
        assertEquals("Demo line", interceptionSimDisplayLabel(parsed, currentSim))
        assertEquals("Asia/Shanghai", interceptionGatewayTimeZone(parsed, currentSim))
    }

    @Test fun `ai transcript segments drop an unknown role instead of failing`() {
        val ai = JSONObject().put("role", "ai").put("text", "你好").put("at", "2026-09-11T10:00:00.000Z")
        assertEquals(ClientAiTranscriptSegment("ai", "你好", "2026-09-11T10:00:00.000Z"), ai.toAiTranscriptSegment())
        val odd = JSONObject().put("role", "system").put("text", "x")
        assertEquals("caller", odd.toAiTranscriptSegment().role)
        assertNull(odd.toAiTranscriptSegment().at)
    }

    private fun contactJson() = JSONObject()
        .put("id", "c-1")
        .put("displayName", "张三")
        .put("givenName", "三")
        .put("familyName", "张")
        .put("organization", JSONObject.NULL)
        .put("source", "android")
        .put("blocked", false)
        .put(
            "phones",
            JSONArray()
                .put(
                    JSONObject().put("id", "p-1").put("rawNumber", "199 0000 0101")
                        .put("e164", "+8619900000101").put("label", "mobile").put("isPrimary", true),
                )
                .put(JSONObject().put("id", "p-2").put("rawNumber", "021-12345678").put("isPrimary", false)),
        )
        .put("emails", JSONArray().put(JSONObject().put("id", "e-1").put("address", "a@b.c").put("label", "home")))
        .put(
            "addresses",
            JSONArray().put(JSONObject().put("id", "a-1").put("formatted", "上海市浦东新区").put("label", "work")),
        )
}
