package org.vodog.gateway

import android.content.Context
import android.os.Build
import android.telecom.Call
import org.json.JSONArray
import org.json.JSONObject

data class NumberBlocklistItem(
    val simId: String,
    /** Call blocklist (S66: `numbers` kept its pre-S66 meaning for old gateways). */
    val numbers: List<String>,
    /** S66 SMS blocklist; absent (pre-S66 Control) means empty. */
    val smsNumbers: List<String> = emptyList(),
)

data class NumberBlocklistSnapshot(
    val version: Long,
    val items: List<NumberBlocklistItem>,
    /** S55 `numberBlocklist.phoneSync`, sent every heartbeat even when the version is unchanged. */
    val phoneSync: String? = null,
)

enum class NumberBlocklistApplyDecision { NO_OP, REPLACE, IGNORE }

/** Same-version no-op, higher replaces, lower ignored. First snapshot always replaces (including empty clear). */
internal fun numberBlocklistApplyDecision(previousVersion: Long?, nextVersion: Long): NumberBlocklistApplyDecision {
    if (nextVersion < 0) return NumberBlocklistApplyDecision.IGNORE
    if (previousVersion == null) return NumberBlocklistApplyDecision.REPLACE
    if (nextVersion == previousVersion) return NumberBlocklistApplyDecision.NO_OP
    if (nextVersion > previousVersion) return NumberBlocklistApplyDecision.REPLACE
    return NumberBlocklistApplyDecision.IGNORE
}

internal fun parseNumberBlocklist(response: JSONObject): NumberBlocklistSnapshot? {
    val raw = response.optJSONObject("numberBlocklist") ?: return null
    if (!raw.has("version") || raw.isNull("version")) return null
    val version = raw.optLong("version", -1L)
    if (version < 0) return null
    val itemsJson = raw.optJSONArray("items") ?: JSONArray()
    val items = buildList {
        for (index in 0 until itemsJson.length()) {
            val item = itemsJson.optJSONObject(index) ?: continue
            val simId = item.optString("simId").takeIf(String::isNotBlank) ?: continue
            add(NumberBlocklistItem(simId, blocklistNumbers(item, "numbers"), blocklistNumbers(item, "smsNumbers")))
        }
    }
    return NumberBlocklistSnapshot(version, items, raw.optString("phoneSync").takeIf(String::isNotBlank))
}

private fun blocklistNumbers(item: JSONObject, name: String): List<String> {
    val json = item.optJSONArray(name) ?: return emptyList()
    return (0 until json.length()).mapNotNull { json.optString(it).takeIf(String::isNotBlank) }
}

internal fun isEmergencyDigitKey(digits: String): Boolean = digits == "112" || digits == "911"

internal fun callingCodeForIso(countryIso: String?): String? {
    val iso = countryIso?.trim()?.uppercase().orEmpty()
    if (iso.length != 2) return null
    return CALLING_CODES[iso]
}

/** Digit-key equality plus national/E.164 when SIM country is known. Blank/unknown fail-open. Never 112/911. */
internal fun numberBlocklistMatchKeys(raw: String?, countryIso: String?): Set<String> {
    val digits = dialNumberMatchKey(raw) ?: return emptySet()
    if (isEmergencyDigitKey(digits)) return emptySet()
    val keys = mutableSetOf(digits)
    val callingCode = callingCodeForIso(countryIso) ?: return keys
    if (digits.startsWith(callingCode) && digits.length > callingCode.length + 1) {
        val national = digits.substring(callingCode.length)
        if (national.isNotEmpty() && !isEmergencyDigitKey(national)) keys += national
    } else if (!digits.startsWith(callingCode)) {
        val national = if (digits.startsWith("0") && digits.length > 1) digits.substring(1) else digits
        if (national.isNotEmpty() && !isEmergencyDigitKey(national)) {
            keys += national
            val e164 = callingCode + national
            if (!isEmergencyDigitKey(e164)) keys += e164
        }
    }
    return keys
}

internal fun numberBlocklistMatches(
    remoteNumber: String?,
    listedNumbers: Collection<String>,
    countryIso: String?,
): Boolean {
    val remoteKeys = numberBlocklistMatchKeys(remoteNumber, countryIso)
    if (remoteKeys.isEmpty()) return false
    for (listed in listedNumbers) {
        val listedKeys = numberBlocklistMatchKeys(listed, countryIso)
        if (listedKeys.isNotEmpty() && remoteKeys.any { it in listedKeys }) return true
    }
    // S55: on a CN SIM, also Control's service-code equivalences (`+8675595501` ≡ `95501`).
    if (callingCodeForIso(countryIso) != CN_CALLING_CODE) return false
    val remoteClasses = dialNumberMatchKey(remoteNumber)?.let(::blocklistMatchClasses).orEmpty()
    return remoteClasses.isNotEmpty() && listedNumbers.any { listed ->
        dialNumberMatchKey(listed)?.let(::blocklistMatchClasses).orEmpty().any(remoteClasses::contains)
    }
}

/*
 * S55 CN number equivalence, a line-for-line port of Control's `blocklistMatchClasses`
 * (services/control/src/blocklist.ts): a digit key maps to match classes, two keys are one number when
 * their classes overlap. Mobiles `8613…` ≡ `13…`; landlines `86 AREA N` ≡ `0AREA N`, never bare N; a
 * service code behind an area code ≡ the bare code; any country code before a service code is dropped
 * (`+85295008` ≡ `95008`); other numbers keep their country code strictly.
 * ponytail: CN-only, like Control.
 */
private const val CN_CALLING_CODE = "86"
private val CN_MOBILE = Regex("^1[3-9]\\d{9}$")
private val CN_SERVICE_SHORT = Regex("^(?:95\\d{3,4}|96\\d{3}|10\\d{3,6}|12\\d{3})$")
private val CN_NATIONAL_SERVICE = Regex("^[48]00\\d{7}$")
private val CN_LANDLINE = Regex("^(?:10|2[0-9]|[3-9][0-9]{2})(\\d{5,8})$")
private val CALLING_CODE_VALUES by lazy { CALLING_CODES.values.toSet() }

private fun cnLandlineClasses(n: String): List<String> {
    val local = CN_LANDLINE.matchEntire(n)?.groupValues?.get(1) ?: return emptyList()
    return if (CN_SERVICE_SHORT.matches(local)) listOf("0$n", local) else listOf("0$n")
}

internal fun blocklistMatchClasses(key: String): Set<String> {
    val classes = linkedSetOf(key)
    if (key.startsWith(CN_CALLING_CODE)) {
        val rest = key.drop(2)
        if (CN_MOBILE.matches(rest) || CN_SERVICE_SHORT.matches(rest) || CN_NATIONAL_SERVICE.matches(rest)) classes += rest
        classes += cnLandlineClasses(rest)
    } else if (key.startsWith("0")) {
        classes += cnLandlineClasses(key.drop(1))
    }
    for (length in 1..3) {
        if (key.length <= length) break
        val rest = key.drop(length)
        if (key.take(length) in CALLING_CODE_VALUES && CN_SERVICE_SHORT.matches(rest)) classes += rest
    }
    classes -= setOf("112", "911")
    return classes
}

/**
 * One class per number for set arithmetic (the S55 merge planner): the bare service code, else the
 * national mobile / 400 number, else `0AREA N`, else the digit key. Emergency numbers have none.
 * ponytail: class overlap is not transitive, so a Beijing `010 101196` and `+86 10101196` (both overlap
 * Control-wise) key differently here; union-find over a run's numbers if that ever shows up.
 */
internal fun blocklistCanonicalKey(raw: String?): String? {
    val key = dialNumberMatchKey(raw) ?: return null
    if (isEmergencyDigitKey(key) || (key.startsWith(CN_CALLING_CODE) && isEmergencyDigitKey(key.drop(2)))) return null
    val classes = blocklistMatchClasses(key)
    val rest = key.takeIf { it.startsWith(CN_CALLING_CODE) }?.drop(2)
    return when {
        CN_SERVICE_SHORT.matches(key) -> key
        rest != null && (CN_MOBILE.matches(rest) || CN_SERVICE_SHORT.matches(rest) || CN_NATIONAL_SERVICE.matches(rest)) -> rest
        else -> classes.firstOrNull(CN_SERVICE_SHORT::matches)
            ?: classes.firstOrNull { it != key && it.startsWith("0") }
            ?: key
    }
}

internal fun shouldRejectIncomingRinging(enabled: Boolean, state: DeviceCallState, listed: Boolean): Boolean =
    enabled && state == DeviceCallState.RINGING && listed

internal fun shouldDropIncomingSms(enabled: Boolean, listed: Boolean): Boolean = enabled && listed

internal fun incomingIsReportable(record: DeviceCallRecord, listed: Boolean): Boolean =
    record.direction == DeviceCallDirection.INCOMING &&
        !record.incomingReported &&
        record.incomingEventId != null &&
        !listed

/** S66 two-list stored snapshot; a lower or missing `format` is a pre-S66 call-only snapshot. */
private const val STORED_BLOCKLIST_FORMAT = 2

internal fun encodeStoredNumberBlocklist(snapshot: NumberBlocklistSnapshot): String {
    val items = JSONArray()
    snapshot.items.forEach { item ->
        items.put(JSONObject()
            .put("simId", item.simId)
            .put("numbers", JSONArray(item.numbers))
            .put("smsNumbers", JSONArray(item.smsNumbers)))
    }
    return JSONObject().put("format", STORED_BLOCKLIST_FORMAT).put("version", snapshot.version)
        .put("items", items).toString()
}

/** Version of a pre-S66 stored snapshot: its call list still rejects calls, but its version is not reused. */
internal const val NUMBER_BLOCKLIST_VERSION_UNKNOWN = -1L

/**
 * S66: a pre-S66 snapshot has no `smsNumbers`, so it decodes with [NUMBER_BLOCKLIST_VERSION_UNKNOWN] -
 * the next heartbeat sends no version and Control answers with the full two-list snapshot instead of
 * `items: []` until a change. Any real version replaces it.
 */
internal fun decodeStoredNumberBlocklist(raw: String): NumberBlocklistSnapshot? = runCatching {
    val value = JSONObject(raw)
    val parsed = parseNumberBlocklist(JSONObject().put("numberBlocklist", value)) ?: return@runCatching null
    if (value.optInt("format") < STORED_BLOCKLIST_FORMAT) parsed.copy(version = NUMBER_BLOCKLIST_VERSION_UNKNOWN)
    else parsed
}.getOrNull()

class GatewayNumberBlocklistStore(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun snapshot(): NumberBlocklistSnapshot? = synchronized(LOCK) {
        prefs.getString(KEY, null)?.let(::decodeStoredNumberBlocklist)
    }

    /** The version to advertise to Control; null when none or pre-S66 (unknown). */
    fun knownVersion(): Long? = snapshot()?.version?.takeIf { it >= 0 }

    fun apply(next: NumberBlocklistSnapshot): Boolean = synchronized(LOCK) {
        when (numberBlocklistApplyDecision(snapshot()?.version, next.version)) {
            NumberBlocklistApplyDecision.NO_OP, NumberBlocklistApplyDecision.IGNORE -> false
            NumberBlocklistApplyDecision.REPLACE -> {
                val encoded = encodeStoredNumberBlocklist(next)
                check(prefs.edit().putString(KEY, encoded).commit()) { "number blocklist commit failed" }
                true
            }
        }
    }

    /** S66 call blocklist: ringing rejection and CallLog backfill. */
    fun isCallListed(simId: String?, remoteNumber: String?, countryIso: String?): Boolean =
        isListed(simId, remoteNumber, countryIso, NumberBlocklistItem::numbers)

    /** S66 SMS blocklist: incoming SMS drop and journaled SMS recheck. */
    fun isSmsListed(simId: String?, remoteNumber: String?, countryIso: String?): Boolean =
        isListed(simId, remoteNumber, countryIso, NumberBlocklistItem::smsNumbers)

    private fun isListed(
        simId: String?,
        remoteNumber: String?,
        countryIso: String?,
        list: (NumberBlocklistItem) -> List<String>,
    ): Boolean {
        if (simId.isNullOrBlank()) return false
        val item = snapshot()?.items?.firstOrNull { it.simId == simId } ?: return false
        return numberBlocklistMatches(remoteNumber, list(item), countryIso)
    }

    fun clear() = synchronized(LOCK) { prefs.edit().clear().commit() }

    private companion object {
        const val NAME = "gateway_number_blocklist"
        const val KEY = "snapshot"
        val LOCK = Any()
    }
}

internal fun rejectListedRingingCalls(context: Context) {
    if (!GatewayRuntimeStore(context).enabled) return
    val journal = DeviceCallJournal(context)
    val blocklist = GatewayNumberBlocklistStore(context)
    val bindings = GatewaySimBindingStore(context)
    for (deviceCallId in GatewayTelecomCallRegistry.deviceCallIds()) {
        val call = GatewayTelecomCallRegistry.call(deviceCallId) ?: continue
        if (call.deviceState() != DeviceCallState.RINGING) continue
        val record = journal.find(deviceCallId)
        val handle = call.details.accountHandle?.stableString()?.let(IccidFingerprint()::derivePhoneAccount)
            ?: record?.phoneAccountHandle
        val binding = bindings.byPhoneAccount(handle) ?: continue
        val remote = call.remoteNumber() ?: record?.remoteNumber
        if (!blocklist.isCallListed(binding.simId, remote, binding.countryIso)) continue
        // S21 §B: a snapshot that arrives while the phone is already ringing blocks the call and
        // records the interception exactly like the InCallService path does.
        enqueueBlockedCallInterception(
            context, deviceCallId, binding.simId, GatewayRuntimeStore(context).deviceEpoch, remote,
        )
        journal.suppressIncomingReport(deviceCallId)
        rejectDeclined(call, deviceCallId, "blocked_snapshot")
    }
}

/** S75: blocked calls have no server call id yet; the row joins `telephony.state` by `deviceCallId`. */
internal fun rejectDeclined(call: Call, deviceCallId: String, trigger: String) {
    if (Build.VERSION.SDK_INT >= 30) {
        call.reject(Call.REJECT_REASON_DECLINED)
    } else {
        @Suppress("DEPRECATION")
        call.reject(false, null)
    }
    GatewayDiag.localEnd(deviceCallId, null, trigger)
}

private val CALLING_CODES = mapOf(
    "AC" to "247", "AD" to "376", "AE" to "971", "AF" to "93", "AG" to "1", "AI" to "1",
    "AL" to "355", "AM" to "374", "AO" to "244", "AR" to "54", "AS" to "1", "AT" to "43",
    "AU" to "61", "AW" to "297", "AZ" to "994", "BA" to "387", "BB" to "1", "BD" to "880",
    "BE" to "32", "BF" to "226", "BG" to "359", "BH" to "973", "BI" to "257", "BJ" to "229",
    "BM" to "1", "BN" to "673", "BO" to "591", "BR" to "55", "BS" to "1", "BT" to "975",
    "BW" to "267", "BY" to "375", "BZ" to "501", "CA" to "1", "CD" to "243", "CF" to "236",
    "CG" to "242", "CH" to "41", "CI" to "225", "CK" to "682", "CL" to "56", "CM" to "237",
    "CN" to "86", "CO" to "57", "CR" to "506", "CU" to "53", "CV" to "238", "CW" to "599",
    "CY" to "357", "CZ" to "420", "DE" to "49", "DJ" to "253", "DK" to "45", "DM" to "1",
    "DO" to "1", "DZ" to "213", "EC" to "593", "EE" to "372", "EG" to "20", "ER" to "291",
    "ES" to "34", "ET" to "251", "FI" to "358", "FJ" to "679", "FK" to "500", "FM" to "691",
    "FO" to "298", "FR" to "33", "GA" to "241", "GB" to "44", "GD" to "1", "GE" to "995",
    "GF" to "594", "GH" to "233", "GI" to "350", "GL" to "299", "GM" to "220", "GN" to "224",
    "GP" to "590", "GQ" to "240", "GR" to "30", "GT" to "502", "GU" to "1", "GW" to "245",
    "GY" to "592", "HK" to "852", "HN" to "504", "HR" to "385", "HT" to "509", "HU" to "36",
    "ID" to "62", "IE" to "353", "IL" to "972", "IM" to "44", "IN" to "91", "IQ" to "964",
    "IR" to "98", "IS" to "354", "IT" to "39", "JM" to "1", "JO" to "962", "JP" to "81",
    "KE" to "254", "KG" to "996", "KH" to "855", "KI" to "686", "KM" to "269", "KN" to "1",
    "KP" to "850", "KR" to "82", "KW" to "965", "KY" to "1", "KZ" to "7", "LA" to "856",
    "LB" to "961", "LC" to "1", "LI" to "423", "LK" to "94", "LR" to "231", "LS" to "266",
    "LT" to "370", "LU" to "352", "LV" to "371", "LY" to "218", "MA" to "212", "MC" to "377",
    "MD" to "373", "ME" to "382", "MG" to "261", "MH" to "692", "MK" to "389", "ML" to "223",
    "MM" to "95", "MN" to "976", "MO" to "853", "MP" to "1", "MQ" to "596", "MR" to "222",
    "MS" to "1", "MT" to "356", "MU" to "230", "MV" to "960", "MW" to "265", "MX" to "52",
    "MY" to "60", "MZ" to "258", "NA" to "264", "NC" to "687", "NE" to "227", "NG" to "234",
    "NI" to "505", "NL" to "31", "NO" to "47", "NP" to "977", "NR" to "674", "NU" to "683",
    "NZ" to "64", "OM" to "968", "PA" to "507", "PE" to "51", "PF" to "689", "PG" to "675",
    "PH" to "63", "PK" to "92", "PL" to "48", "PM" to "508", "PR" to "1", "PS" to "970",
    "PT" to "351", "PW" to "680", "PY" to "595", "QA" to "974", "RE" to "262", "RO" to "40",
    "RS" to "381", "RU" to "7", "RW" to "250", "SA" to "966", "SB" to "677", "SC" to "248",
    "SD" to "249", "SE" to "46", "SG" to "65", "SI" to "386", "SK" to "421", "SL" to "232",
    "SM" to "378", "SN" to "221", "SO" to "252", "SR" to "597", "SS" to "211", "ST" to "239",
    "SV" to "503", "SX" to "1", "SY" to "963", "SZ" to "268", "TC" to "1", "TD" to "235",
    "TG" to "228", "TH" to "66", "TJ" to "992", "TK" to "690", "TL" to "670", "TM" to "993",
    "TN" to "216", "TO" to "676", "TR" to "90", "TT" to "1", "TV" to "688", "TW" to "886",
    "TZ" to "255", "UA" to "380", "UG" to "256", "US" to "1", "UY" to "598", "UZ" to "998",
    "VA" to "39", "VC" to "1", "VE" to "58", "VG" to "1", "VI" to "1", "VN" to "84",
    "VU" to "678", "WF" to "681", "WS" to "685", "XK" to "383", "YE" to "967", "ZA" to "27",
    "ZM" to "260", "ZW" to "263",
)
