package org.vodog

import android.annotation.SuppressLint
import android.content.Context
import android.provider.ContactsContract
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject

/**
 * S21 §A, 架构决策 2 — the device only reads, formats and uploads. De-duplication, `phoneMatchKeys`
 * normalisation and the created/updated/merged decision all happen on the control service; nothing
 * in this file decides that two rows are the same person.
 *
 * Everything above [ContactsContractReader] is pure Kotlin so the mapping rules (type labels, the
 * name fallback chain, batching, payload shape) are unit-testable without a device.
 */
internal data class DeviceContactPhone(val number: String, val type: Int, val customLabel: String?)

internal data class DeviceContactEmail(val address: String, val type: Int, val customLabel: String?)

internal data class DeviceContactAddress(
    val formatted: String?,
    val street: String?,
    val city: String?,
    val region: String?,
    val postalCode: String?,
    val country: String?,
    val type: Int,
    val customLabel: String?,
)

internal data class DeviceContact(
    val lookupKey: String,
    val displayName: String? = null,
    val givenName: String? = null,
    val familyName: String? = null,
    val organization: String? = null,
    val note: String? = null,
    val phones: List<DeviceContactPhone> = emptyList(),
    val emails: List<DeviceContactEmail> = emptyList(),
    val addresses: List<DeviceContactAddress> = emptyList(),
)

internal object ContactImport {
    /** §A: one request carries at most 2000 entries. */
    const val MAX_BATCH = 2000
    const val SOURCE = "android"

    /**
     * The control service validates every entry and rejects the **whole request** on the first
     * violation, so one absurd device row would otherwise cost a 2000-contact batch. Names are
     * truncated to the server's own limits; a number too long to be a number is dropped instead,
     * because a truncated phone number is a different phone number.
     */
    private const val MAX_NAME = 200
    private const val MAX_NAME_PART = 120
    private const val MAX_NOTES = 2000
    private const val MAX_LABEL = 60
    private const val MAX_RAW_NUMBER = 64
    private const val MAX_EMAIL = 320
    private const val MIN_EMAIL = 3
    private const val MAX_PHONES = 50
    private const val MAX_EMAILS = 50
    private const val MAX_ADDRESSES = 20
    private const val MAX_FORMATTED = 500
    private const val MAX_STREET = 300
    private const val MAX_LOCALITY = 120
    private const val MAX_POSTAL = 40

    fun phoneTypeLabel(type: Int, customLabel: String? = null): String? = customLabel
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: when (type) {
            ContactsContract.CommonDataKinds.Phone.TYPE_HOME -> "home"
            ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE -> "mobile"
            ContactsContract.CommonDataKinds.Phone.TYPE_WORK -> "work"
            ContactsContract.CommonDataKinds.Phone.TYPE_FAX_WORK -> "work_fax"
            ContactsContract.CommonDataKinds.Phone.TYPE_FAX_HOME -> "home_fax"
            ContactsContract.CommonDataKinds.Phone.TYPE_PAGER -> "pager"
            ContactsContract.CommonDataKinds.Phone.TYPE_MAIN -> "main"
            ContactsContract.CommonDataKinds.Phone.TYPE_WORK_MOBILE -> "work_mobile"
            ContactsContract.CommonDataKinds.Phone.TYPE_COMPANY_MAIN -> "company_main"
            ContactsContract.CommonDataKinds.Phone.TYPE_OTHER -> "other"
            else -> null
        }

    fun emailTypeLabel(type: Int, customLabel: String? = null): String? = customLabel
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: when (type) {
            ContactsContract.CommonDataKinds.Email.TYPE_HOME -> "home"
            ContactsContract.CommonDataKinds.Email.TYPE_WORK -> "work"
            ContactsContract.CommonDataKinds.Email.TYPE_MOBILE -> "mobile"
            ContactsContract.CommonDataKinds.Email.TYPE_OTHER -> "other"
            else -> null
        }

    fun addressTypeLabel(type: Int, customLabel: String? = null): String? = customLabel
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: when (type) {
            ContactsContract.CommonDataKinds.StructuredPostal.TYPE_HOME -> "home"
            ContactsContract.CommonDataKinds.StructuredPostal.TYPE_WORK -> "work"
            ContactsContract.CommonDataKinds.StructuredPostal.TYPE_OTHER -> "other"
            else -> null
        }

    /**
     * The server requires a non-empty `displayName`, and a device row can easily have none — a
     * company-only card, or a bare number saved from the dialer. The fallback chain keeps the entry
     * importable instead of dropping it: 显示名 → 姓+名 → 公司 → 第一个号码 → 第一个邮箱.
     */
    fun resolvedDisplayName(contact: DeviceContact): String? {
        contact.displayName?.trim()?.takeIf(String::isNotEmpty)?.let { return it }
        val joined = listOfNotNull(
            contact.familyName?.trim()?.takeIf(String::isNotEmpty),
            contact.givenName?.trim()?.takeIf(String::isNotEmpty),
        ).joinToString("")
        if (joined.isNotEmpty()) return joined
        contact.organization?.trim()?.takeIf(String::isNotEmpty)?.let { return it }
        contact.phones.firstOrNull { it.number.isNotBlank() }?.number?.trim()?.let { return it }
        return contact.emails.firstOrNull { it.address.isNotBlank() }?.address?.trim()
    }

    /**
     * One device row → one import entry, or null when there is nothing the server could key on.
     * Duplicate numbers inside a single card are collapsed by their raw text only; real number
     * equality is the server's `phoneMatchKeys` job, not ours.
     */
    fun toEntry(contact: DeviceContact): ContactDraft? {
        val phones = contact.phones
            .mapNotNull { phone ->
                phone.number.trim().takeIf { it.isNotEmpty() && it.length <= MAX_RAW_NUMBER }?.let {
                    ContactPhoneDraft(it, phoneTypeLabel(phone.type, phone.customLabel)?.take(MAX_LABEL))
                }
            }
            .distinctBy { it.rawNumber }
            .take(MAX_PHONES)
        val emails = contact.emails
            .mapNotNull { email ->
                email.address.trim().takeIf { it.length in MIN_EMAIL..MAX_EMAIL }?.let {
                    ContactEmailDraft(it, emailTypeLabel(email.type, email.customLabel)?.take(MAX_LABEL))
                }
            }
            .distinctBy { it.address.lowercase() }
            .take(MAX_EMAILS)
        if (phones.isEmpty() && emails.isEmpty()) return null
        val name = resolvedDisplayName(contact)?.take(MAX_NAME) ?: return null
        return ContactDraft(
            displayName = name,
            givenName = contact.givenName?.take(MAX_NAME_PART),
            familyName = contact.familyName?.take(MAX_NAME_PART),
            organization = contact.organization?.take(MAX_NAME),
            notes = contact.note?.take(MAX_NOTES),
            phones = phones,
            emails = emails,
            addresses = contact.addresses
                .map { address ->
                    ContactAddressDraft(
                        formatted = address.formatted?.take(MAX_FORMATTED),
                        label = addressTypeLabel(address.type, address.customLabel)?.take(MAX_LABEL),
                        street = address.street?.take(MAX_STREET),
                        city = address.city?.take(MAX_LOCALITY),
                        region = address.region?.take(MAX_LOCALITY),
                        postalCode = address.postalCode?.take(MAX_POSTAL),
                        country = address.country?.take(MAX_LOCALITY),
                    )
                }
                .filterNot(ContactAddressDraft::empty)
                .take(MAX_ADDRESSES),
            sourceContactId = contact.lookupKey.takeIf(String::isNotBlank),
        )
    }

    fun entries(contacts: List<DeviceContact>): List<ContactDraft> = contacts.mapNotNull(::toEntry)

    /** Chunks at [MAX_BATCH]; an empty list produces no request at all. */
    fun batches(entries: List<ContactDraft>, size: Int = MAX_BATCH): List<List<ContactDraft>> =
        if (entries.isEmpty()) emptyList() else entries.chunked(size.coerceIn(1, MAX_BATCH))

    /** `POST /contacts/import` body for one batch (§A). */
    fun payload(batch: List<ContactDraft>, sourceDeviceId: String?): JSONObject = JSONObject()
        .put("source", SOURCE)
        .apply {
            sourceDeviceId?.takeIf(String::isNotBlank)?.let { put("sourceDeviceId", it) }
        }
        .put("contacts", JSONArray().also { array -> batch.forEach { array.put(it.toJson()) } })
}

/**
 * `Settings.Secure.ANDROID_ID` is per-app-signing-key and per-device, which is exactly the
 * "this phone's copy of the address book" identity the server keys re-imports on. It carries no
 * account or hardware identifier off the device beyond that.
 */
@SuppressLint("HardwareIds")
internal fun contactSourceDeviceId(context: Context): String? = runCatching {
    Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
}.getOrNull()?.takeIf { it.isNotBlank() && it != "9774d56d682e549c" }

/**
 * One pass over `ContactsContract.Data`, grouped by contact id. A single query beats the
 * contact-then-phones-then-emails walk by a wide margin on a real address book, and it is the only
 * place in the client that touches the contacts provider.
 */
internal class ContactsContractReader(private val context: Context) {
    fun read(limit: Int = HARD_LIMIT): List<DeviceContact> {
        val projection = arrayOf(
            ContactsContract.Data.LOOKUP_KEY,
            ContactsContract.Data.CONTACT_ID,
            ContactsContract.Data.MIMETYPE,
            ContactsContract.Data.DISPLAY_NAME_PRIMARY,
            ContactsContract.Data.DATA1,
            ContactsContract.Data.DATA2,
            ContactsContract.Data.DATA3,
            ContactsContract.Data.DATA4,
            ContactsContract.Data.DATA5,
            ContactsContract.Data.DATA7,
            ContactsContract.Data.DATA8,
            ContactsContract.Data.DATA9,
            ContactsContract.Data.DATA10,
        )
        val builders = LinkedHashMap<String, Builder>()
        context.contentResolver.query(
            ContactsContract.Data.CONTENT_URI,
            projection,
            "${ContactsContract.Data.MIMETYPE} IN (?,?,?,?,?,?)",
            arrayOf(
                ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
                ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
                ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
                ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE,
                ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE,
                ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE,
            ),
            "${ContactsContract.Data.CONTACT_ID} ASC",
        )?.use { cursor ->
            val lookupColumn = cursor.getColumnIndexOrThrow(ContactsContract.Data.LOOKUP_KEY)
            val idColumn = cursor.getColumnIndexOrThrow(ContactsContract.Data.CONTACT_ID)
            val mimeColumn = cursor.getColumnIndexOrThrow(ContactsContract.Data.MIMETYPE)
            val displayColumn = cursor.getColumnIndexOrThrow(ContactsContract.Data.DISPLAY_NAME_PRIMARY)
            val data = IntArray(10) { index ->
                cursor.getColumnIndex("data${index + 1}")
            }
            fun text(column: Int): String? =
                column.takeIf { it >= 0 }?.let { cursor.getString(it) }?.trim()?.takeIf(String::isNotEmpty)
            fun number(column: Int): Int = column.takeIf { it >= 0 }?.let {
                if (cursor.isNull(it)) 0 else cursor.getInt(it)
            } ?: 0
            while (cursor.moveToNext()) {
                val key = text(lookupColumn) ?: cursor.getLong(idColumn).toString()
                if (!builders.containsKey(key) && builders.size >= limit) continue
                val builder = builders.getOrPut(key) { Builder(key) }
                builder.displayName = builder.displayName ?: text(displayColumn)
                when (cursor.getString(mimeColumn)) {
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE -> {
                        builder.displayName = text(data[0]) ?: builder.displayName
                        builder.givenName = builder.givenName ?: text(data[1])
                        builder.familyName = builder.familyName ?: text(data[2])
                    }
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE -> text(data[0])?.let {
                        builder.phones += DeviceContactPhone(it, number(data[1]), text(data[2]))
                    }
                    ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE -> text(data[0])?.let {
                        builder.emails += DeviceContactEmail(it, number(data[1]), text(data[2]))
                    }
                    ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE ->
                        builder.addresses += DeviceContactAddress(
                            formatted = text(data[0]),
                            street = text(data[3]),
                            city = text(data[6]),
                            region = text(data[7]),
                            postalCode = text(data[8]),
                            country = text(data[9]),
                            type = number(data[1]),
                            customLabel = text(data[2]),
                        )
                    ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE ->
                        builder.organization = builder.organization ?: text(data[0])
                    ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE ->
                        builder.note = builder.note ?: text(data[0])
                }
            }
        }
        return builders.values.map(Builder::build)
    }

    private class Builder(val lookupKey: String) {
        var displayName: String? = null
        var givenName: String? = null
        var familyName: String? = null
        var organization: String? = null
        var note: String? = null
        val phones = mutableListOf<DeviceContactPhone>()
        val emails = mutableListOf<DeviceContactEmail>()
        val addresses = mutableListOf<DeviceContactAddress>()

        fun build() = DeviceContact(
            lookupKey = lookupKey,
            displayName = displayName,
            givenName = givenName,
            familyName = familyName,
            organization = organization,
            note = note,
            phones = phones.toList(),
            emails = emails.toList(),
            addresses = addresses.toList(),
        )
    }

    private companion object {
        /** A safety rail, not a product limit; §验证与关闭条件 leaves >2000 books to a later round. */
        const val HARD_LIMIT = 20_000
    }
}
