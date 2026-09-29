package org.vodog

internal data class SmsRecipient(val number: String, val name: String? = null)

/** Mirrors Control phoneDigitKey: no guessed country, short service numbers stay intact. */
internal object SmsRecipientPolicy {
    fun initialInput(explicitNumber: String?): String = explicitNumber.orEmpty()

    fun digitKey(raw: String): String? {
        val value = raw.trim()
        if (value.isEmpty() || value.length > 64 || !value.matches(Regex("[+0-9().\\s-]+"))) return null
        val compact = value.replace(Regex("[().\\s-]"), "")
        if (!compact.matches(Regex("\\+?[0-9]{1,20}"))) return null
        return compact.removePrefix("+")
    }

    // Contact raw/E.164 pairs are authoritative aliases; never infer a region from device locale.
    fun key(number: String, contacts: List<ClientContact>): String? {
        val rawKey = digitKey(number) ?: return null
        val phone = contacts.asSequence().flatMap { it.phones.asSequence() }.firstOrNull {
            digitKey(it.rawNumber) == rawKey || digitKey(it.dialNumber) == rawKey
        }
        return phone?.let { digitKey(it.dialNumber) } ?: rawKey
    }

    fun unique(recipients: List<SmsRecipient>, contacts: List<ClientContact>): List<SmsRecipient> =
        recipients.distinctBy { key(it.number, contacts) ?: it.number.trim() }

    fun resolved(selected: List<SmsRecipient>, input: String, contacts: List<ClientContact>): List<SmsRecipient> =
        unique(selected + input.trim().takeIf(String::isNotEmpty)?.let { listOf(SmsRecipient(it)) }.orEmpty(), contacts)

    fun valid(recipients: List<SmsRecipient>): Boolean = recipients.isNotEmpty() && recipients.all {
        digitKey(it.number)?.let { key -> key != "112" && key != "911" } == true
    }
}
