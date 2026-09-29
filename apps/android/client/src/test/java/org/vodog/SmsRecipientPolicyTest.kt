package org.vodog

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SmsRecipientPolicyTest {
    private val contact = JSONObject("""{"id":"a","displayName":"林","phones":[
        {"rawNumber":"0900 000 001","e164":"+886900000001"},
        {"rawNumber":"0900 000 002","e164":"+886900000002"}]}""").toClientContact()

    @Test fun ordinaryComposeIsEmptyAndExplicitEntryIsEditableWithoutOldDraft() {
        assertEquals("", SmsRecipientPolicy.initialInput(null))
        assertEquals("0900000001", SmsRecipientPolicy.initialInput("0900000001"))
        assertEquals(listOf(SmsRecipient("10086")), SmsRecipientPolicy.resolved(emptyList(), "10086", listOf(contact)))
    }

    @Test fun multipleNumbersAndContactsDedupManualAliasesWithoutGuessingCountry() {
        val selected = contact.phones.map { SmsRecipient(it.dialNumber, contact.displayName) }
        assertEquals(2, SmsRecipientPolicy.resolved(selected, "0900-000-001", listOf(contact)).size)
        assertEquals(3, SmsRecipientPolicy.resolved(selected, "10086", listOf(contact)).size)
        assertEquals(1, SmsRecipientPolicy.unique(listOf(SmsRecipient("+886 900-000-001"), SmsRecipient("886900000001")), emptyList()).size)
        assertEquals(2, SmsRecipientPolicy.unique(listOf(SmsRecipient("0900000001"), SmsRecipient("+886900000001")), emptyList()).size)
    }

    @Test fun serviceNumbersPreservedInvalidAndEmergencyRejected() {
        assertEquals("10086", SmsRecipientPolicy.digitKey("10086"))
        listOf("", "name", "12+34", "123;456", "123,456", "112", "911").forEach {
            assertFalse(it, SmsRecipientPolicy.valid(listOf(SmsRecipient(it))))
        }
    }
}
