package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S21 §A 架构决策 2 — the device formats, the server decides. These cases pin the formatting half:
 * which label a device phone type becomes, what happens to a card with no name, and that a batch
 * never exceeds the 2000-entry request limit.
 */
class ContactImportMappingTest {
    @Test fun `device phone types become the labels the contract names`() {
        assertEquals("mobile", ContactImport.phoneTypeLabel(TYPE_MOBILE))
        assertEquals("home", ContactImport.phoneTypeLabel(TYPE_HOME))
        assertEquals("work", ContactImport.phoneTypeLabel(TYPE_WORK))
        assertEquals("main", ContactImport.phoneTypeLabel(TYPE_MAIN))
        assertEquals("other", ContactImport.phoneTypeLabel(TYPE_OTHER))
        // A custom label wins over the type, and an unknown type has no label at all rather than a
        // made-up one — the server stores `label` verbatim.
        assertEquals("宿舍", ContactImport.phoneTypeLabel(TYPE_CUSTOM, "宿舍"))
        assertEquals("宿舍", ContactImport.phoneTypeLabel(TYPE_MOBILE, " 宿舍 "))
        assertNull(ContactImport.phoneTypeLabel(TYPE_CUSTOM))
        // A blank custom label is not a label: the type mapping still applies.
        assertEquals("mobile", ContactImport.phoneTypeLabel(TYPE_MOBILE, "   "))
        assertNull(ContactImport.phoneTypeLabel(TYPE_CUSTOM, "   "))
    }

    @Test fun `email and address types map on their own scale, not the phone one`() {
        // Email/StructuredPostal reuse the same small ints for different meanings than Phone does
        // (3 is TYPE_WORK for a phone but TYPE_OTHER for an e-mail), so each has its own map.
        assertEquals("home", ContactImport.emailTypeLabel(EMAIL_TYPE_HOME))
        assertEquals("work", ContactImport.emailTypeLabel(EMAIL_TYPE_WORK))
        assertEquals("other", ContactImport.emailTypeLabel(EMAIL_TYPE_OTHER))
        assertEquals("mobile", ContactImport.emailTypeLabel(EMAIL_TYPE_MOBILE))
        assertEquals("home", ContactImport.addressTypeLabel(POSTAL_TYPE_HOME))
        assertEquals("work", ContactImport.addressTypeLabel(POSTAL_TYPE_WORK))
        assertEquals("other", ContactImport.addressTypeLabel(POSTAL_TYPE_OTHER))
        assertNull(ContactImport.addressTypeLabel(TYPE_CUSTOM))
        // Phone 3 stays 工作 on the phone scale.
        assertEquals("work", ContactImport.phoneTypeLabel(TYPE_WORK))
    }

    @Test fun `a card with no display name falls back to the name parts then company then number`() {
        val parts = contact(givenName = "三", familyName = "张", phones = listOf(phone("186")))
        assertEquals("张三", ContactImport.resolvedDisplayName(parts))
        val company = contact(organization = "上海某某公司", phones = listOf(phone("021-1")))
        assertEquals("上海某某公司", ContactImport.resolvedDisplayName(company))
        val numberOnly = contact(phones = listOf(phone(" 19900000201 ")))
        assertEquals("19900000201", ContactImport.resolvedDisplayName(numberOnly))
        val emailOnly = contact(emails = listOf(email("a@b.c")))
        assertEquals("a@b.c", ContactImport.resolvedDisplayName(emailOnly))
        assertNull(ContactImport.resolvedDisplayName(contact()))
    }

    @Test fun `a display name is preferred over every fallback`() {
        val full = contact(
            displayName = "张三",
            givenName = "三",
            familyName = "张",
            organization = "公司",
            phones = listOf(phone("186")),
        )
        assertEquals("张三", ContactImport.resolvedDisplayName(full))
    }

    @Test fun `an entry with neither phone nor email is dropped, never uploaded nameless`() {
        assertNull(ContactImport.toEntry(contact(displayName = "只有名字")))
        assertEquals(0, ContactImport.entries(listOf(contact(displayName = "只有名字"))).size)
    }

    @Test fun `an imported entry keeps the lookup key as sourceContactId and de-duplicates raw numbers`() {
        val entry = checkNotNull(
            ContactImport.toEntry(
                contact(
                    lookupKey = "lookup-1",
                    displayName = "张三",
                    phones = listOf(phone("186", TYPE_MOBILE), phone("186", TYPE_HOME), phone("021", TYPE_WORK)),
                    emails = listOf(email("A@B.c"), email("a@b.c")),
                ),
            ),
        )
        assertEquals("lookup-1", entry.sourceContactId)
        assertEquals(listOf("186", "021"), entry.phones.map { it.rawNumber })
        assertEquals("mobile", entry.phones.first().label)
        assertEquals(1, entry.emails.size)
        assertTrue(entry.valid)
        assertEquals("android", ContactImport.SOURCE)
    }

    @Test fun `an empty address is not uploaded`() {
        val entry = checkNotNull(
            ContactImport.toEntry(
                contact(
                    displayName = "张三",
                    phones = listOf(phone("186")),
                    addresses = listOf(
                        DeviceContactAddress(null, null, null, null, null, null, POSTAL_TYPE_HOME, null),
                        DeviceContactAddress("上海市", null, null, null, null, null, POSTAL_TYPE_WORK, null),
                    ),
                ),
            ),
        )
        assertEquals(1, entry.addresses.size)
        assertEquals("work", entry.addresses.single().label)
    }

    @Test fun `batches never exceed the contract limit and an empty book sends no request`() {
        val entries = List(ContactImport.MAX_BATCH + 7) {
            ContactDraft("联系人 $it", phones = listOf(ContactPhoneDraft("1380000$it")))
        }
        val batches = ContactImport.batches(entries)
        assertEquals(2, batches.size)
        assertEquals(ContactImport.MAX_BATCH, batches[0].size)
        assertEquals(7, batches[1].size)
        assertTrue(batches.all { it.size <= ContactImport.MAX_BATCH })
        assertTrue(ContactImport.batches(emptyList()).isEmpty())
        // An oversized request size is clamped, never honoured.
        assertEquals(ContactImport.MAX_BATCH, ContactImport.batches(entries, size = 9_999)[0].size)
    }

    @Test fun `the import payload carries source, device id and the batch`() {
        val payload = ContactImport.payload(
            listOf(ContactDraft("张三", phones = listOf(ContactPhoneDraft("186")), sourceContactId = "lookup-1")),
            sourceDeviceId = "android-id-1",
        )
        assertEquals("android", payload.getString("source"))
        assertEquals("android-id-1", payload.getString("sourceDeviceId"))
        assertEquals(1, payload.getJSONArray("contacts").length())
        assertEquals("lookup-1", payload.getJSONArray("contacts").getJSONObject(0).getString("sourceContactId"))
        // A device that refuses to report ANDROID_ID simply omits the key.
        assertTrue(!ContactImport.payload(emptyList(), null).has("sourceDeviceId"))
    }

    private fun contact(
        lookupKey: String = "lookup",
        displayName: String? = null,
        givenName: String? = null,
        familyName: String? = null,
        organization: String? = null,
        note: String? = null,
        phones: List<DeviceContactPhone> = emptyList(),
        emails: List<DeviceContactEmail> = emptyList(),
        addresses: List<DeviceContactAddress> = emptyList(),
    ) = DeviceContact(lookupKey, displayName, givenName, familyName, organization, note, phones, emails, addresses)

    private fun phone(number: String, type: Int = TYPE_MOBILE) = DeviceContactPhone(number, type, null)

    private fun email(address: String, type: Int = EMAIL_TYPE_HOME) = DeviceContactEmail(address, type, null)

    private companion object {
        // ContactsContract.CommonDataKinds constants, spelled out so the JVM test never loads the
        // Android provider classes.
        const val TYPE_CUSTOM = 0
        const val TYPE_HOME = 1
        const val TYPE_MOBILE = 2
        const val TYPE_WORK = 3
        const val TYPE_OTHER = 7
        const val TYPE_MAIN = 12
        const val EMAIL_TYPE_HOME = 1
        const val EMAIL_TYPE_WORK = 2
        const val EMAIL_TYPE_OTHER = 3
        const val EMAIL_TYPE_MOBILE = 4
        const val POSTAL_TYPE_HOME = 1
        const val POSTAL_TYPE_WORK = 2
        const val POSTAL_TYPE_OTHER = 3
    }
}
