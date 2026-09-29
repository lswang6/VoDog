package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S21 §F 联系人卡片 — which actions the card offers. The two that create data (新建联系人 /
 * 添加到现有联系人) must stay hidden until the lookup has actually answered, otherwise the card
 * invites the user to duplicate a contact it simply has not seen yet.
 */
class ContactCardPolicyTest {
    @Test fun `an unresolved lookup hides create and attach but still allows call, sms and block`() {
        val loading = card(contact = RemoteResource.Loading)
        val actions = contactCardActions(loading)
        assertTrue(actions.canCall)
        assertTrue(actions.canSms)
        assertFalse(actions.canCreateContact)
        assertFalse(actions.canAttachToContact)
        assertTrue(actions.canBlock)
        assertNull(actions.disabledReason)
    }

    @Test fun `a failed lookup (old control service) keeps create and attach hidden`() {
        val failed = card(contact = RemoteResource.Failed("HTTP_404"))
        assertFalse(contactCardActions(failed).canCreateContact)
        assertFalse(contactCardActions(failed).canAttachToContact)
        assertTrue(contactCardActions(failed).canCall)
    }

    @Test fun `an unknown number offers create and attach once the lookup answered null`() {
        val unknown = card(contact = RemoteResource.Loaded(null))
        val actions = contactCardActions(unknown)
        assertTrue(actions.canCreateContact)
        assertTrue(actions.canAttachToContact)
        assertEquals("屏蔽此号码", actions.blockLabel)
    }

    @Test fun `a known contact never offers to create a second copy`() {
        val known = card(contact = RemoteResource.Loaded(contact()))
        assertFalse(contactCardActions(known).canCreateContact)
        assertFalse(contactCardActions(known).canAttachToContact)
    }

    @Test fun `blocked swaps block for unblock and can resolve a missing entry id from the server`() {
        val blocked = card(
            annotation = ContactAnnotation("c-1", "张三", true, "b-1"),
            contact = RemoteResource.Loaded(contact()),
        )
        val actions = contactCardActions(blocked)
        assertEquals("解除屏蔽", actions.blockLabel)
        assertTrue(actions.canUnblock)
        assertFalse(actions.canBlock)
        assertNull(actions.disabledReason)
        // A pre-S21 row can omit the id; the ViewModel re-reads the blocklist once before unblocking.
        val idless = card(
            annotation = ContactAnnotation(null, null, true, null),
            contact = RemoteResource.Loaded(null),
        )
        assertTrue(contactCardActions(idless).canUnblock)
        assertFalse(contactCardActions(idless).canBlock)
        assertNull(contactCardActions(idless).disabledReason)
    }

    @Test fun `emergency numbers can be dialled but never blocked`() {
        listOf("112", "911", "+112", "9-1-1").forEach { number ->
            val actions = contactCardActions(card(number = number, contact = RemoteResource.Loaded(null)))
            assertTrue(number, actions.canCall)
            assertFalse(number, actions.canBlock)
            assertEquals(number, "紧急号码不能被屏蔽", actions.disabledReason)
        }
        assertFalse(isEmergencyServiceNumber("1120"))
        assertFalse(isEmergencyServiceNumber("110"))
    }

    @Test fun `a record without a number offers nothing and says why`() {
        val blank = contactCardActions(card(number = "", contact = RemoteResource.Loaded(null)))
        assertFalse(blank.canCall)
        assertFalse(blank.canSms)
        assertFalse(blank.canBlock)
        assertFalse(blank.canCreateContact)
        assertEquals("这条记录没有可用号码", blank.disabledReason)
        assertFalse(dialableNumber("null"))
        assertFalse(dialableNumber("未知"))
        assertTrue(dialableNumber("+8619900000101"))
    }

    @Test fun `a request in flight disables every action instead of double submitting`() {
        val busy = card(contact = RemoteResource.Loaded(null)).copy(busy = true)
        val actions = contactCardActions(busy)
        assertFalse(actions.canCall)
        assertFalse(actions.canBlock)
        assertFalse(actions.canCreateContact)
    }

    @Test fun `the confirm wording names the number and matches the direction`() {
        val target = ContactCardTarget("+8619900000101", annotation = ContactAnnotation(null, "张三", false, null))
        val block = contactBlockConfirm(target, blocked = false)
        // iOS asks with a question mark; S22 aligns the two (R4 Part B).
        assertEquals("屏蔽此号码？", block.title)
        assertEquals("屏蔽", block.confirmLabel)
        assertTrue(block.message.startsWith("+8619900000101 · 张三"))
        // S66: card / report blocking joins the call list only.
        assertTrue(block.message.contains("来电将被直接挂断"))
        assertTrue(!block.message.contains("短信不再"))
        val unblock = contactBlockConfirm(target, blocked = true)
        assertEquals("解除屏蔽", unblock.title)
        assertEquals("解除屏蔽", unblock.confirmLabel)
    }

    @Test fun `the card title falls back from contact name to the number`() {
        assertEquals("+86186", ContactCardTarget("+86186").title)
        assertEquals(
            "+86186 · 张三",
            ContactCardTarget("+86186", annotation = ContactAnnotation(null, "张三", false, null)).title,
        )
    }

    @Test fun `the dialer only asks the server once the input could identify somebody`() {
        assertFalse(shouldLookupNumber(""))
        assertFalse(shouldLookupNumber("+"))
        assertFalse(shouldLookupNumber("18"))
        assertTrue(shouldLookupNumber("186"))
        assertTrue(shouldLookupNumber("+86 186"))
    }

    @Test fun `the dialer hint only shows for the number it was resolved for`() {
        val lookup = DialerLookupState("19900000101", "c-1", "张三")
        assertEquals("张三", lookup.hintFor("19900000101"))
        assertEquals("张三", lookup.hintFor(" 19900000101 "))
        assertNull(lookup.hintFor("1990000010"))
        assertNull(DialerLookupState().hintFor("19900000101"))
    }

    @Test fun `an interception whose number was since unblocked offers 屏蔽, not a dead end`() {
        val stillBlocked = interceptionContactCardTarget(interception(blockedEntryId = "b-1"))
        assertTrue(stillBlocked.annotation.blocked)
        assertEquals("b-1", stillBlocked.annotation.blockedEntryId)
        assertTrue(contactCardActions(ContactCardUiState(stillBlocked, RemoteResource.Loaded(null))).canUnblock)

        // Same historical row after the number was unblocked: `blockedEntryId` is gone, so the card
        // must offer 屏蔽 again instead of an unblock it cannot perform.
        val released = interceptionContactCardTarget(interception(blockedEntryId = null))
        assertFalse(released.annotation.blocked)
        val actions = contactCardActions(ContactCardUiState(released, RemoteResource.Loaded(null)))
        assertFalse(actions.canUnblock)
        assertTrue(actions.canBlock)
        assertEquals("屏蔽此号码", actions.blockLabel)
        assertNull(actions.disabledReason)
    }

    @Test fun `an untouched address field round-trips every stored part`() {
        val stored = listOf(
            ClientContactAddress("a-1", "上海市浦东新区", "home", "世纪大道 1 号", "上海市", "上海", "200120", "中国"),
            ClientContactAddress("a-2", null, "work", "南京路 2 号", "上海市", null, null, "中国"),
        )
        val untouched = contactEditorAddresses(stored, "上海市浦东新区", "上海市浦东新区")
        assertEquals(2, untouched.size)
        assertEquals("世纪大道 1 号", untouched[0].street)
        assertEquals("200120", untouched[0].postalCode)
        assertEquals("南京路 2 号", untouched[1].street)

        // An edit replaces the first address only; the second survives untouched.
        val edited = contactEditorAddresses(stored, "上海市浦东新区", "北京市朝阳区")
        assertEquals(2, edited.size)
        assertEquals("北京市朝阳区", edited[0].formatted)
        assertNull(edited[0].street)
        assertEquals("home", edited[0].label)
        assertEquals("南京路 2 号", edited[1].street)

        // Clearing the field drops the first address and keeps the rest.
        val cleared = contactEditorAddresses(stored, "上海市浦东新区", "  ")
        assertEquals(1, cleared.size)
        assertEquals("南京路 2 号", cleared.single().street)
        assertTrue(contactEditorAddresses(emptyList(), "", "").isEmpty())
    }

    private fun interception(blockedEntryId: String?) = ClientInterception(
        id = "i-1",
        kind = "call",
        simId = "sim-1",
        remoteNumber = "+8619900000201",
        contactId = null,
        contactName = "推销",
        occurredAt = "2026-09-11T10:00:00.000Z",
        bodyPreview = null,
        blockedEntryId = blockedEntryId,
        source = "gateway",
    )

    private fun card(
        number: String = "+8619900000101",
        annotation: ContactAnnotation = ContactAnnotation.Empty,
        contact: RemoteResource<ClientContact?> = RemoteResource.NotLoaded,
    ) = ContactCardUiState(ContactCardTarget(number, "call-1", annotation), contact = contact)

    private fun contact() = ClientContact(
        id = "c-1",
        displayName = "张三",
        givenName = null,
        familyName = null,
        organization = null,
        notes = null,
        source = "android",
        sourceDeviceId = null,
        sourceContactId = null,
        phones = listOf(ClientContactPhone("p-1", "199 0000 0101", "+8619900000101", "mobile", true)),
        emails = emptyList(),
        addresses = emptyList(),
        blocked = false,
        createdAt = null,
        updatedAt = null,
    )

    @Test fun `settings shows both list counts and names the list being unblocked`() {
        val one = RemoteList.Loaded(listOf(org.json.JSONObject()))
        assertEquals("来电 1 · 短信 0", blocklistSummary(one, RemoteList.Loaded(emptyList())))
        assertEquals("读取失败，打开重试", blocklistSummary(one, RemoteList.Failed("x")))
        assertEquals("正在读取屏蔽号码…", blocklistSummary(one, RemoteList.Loading))
        assertTrue(blocklistUnblockMessage("95559", "sms").contains("短信黑名单"))
        assertTrue(blocklistUnblockMessage("95559", "call").contains("来电黑名单"))
        assertTrue(blocklistUnblockMessage("95559", "").contains("来电黑名单"))
    }
}
