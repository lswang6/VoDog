package org.vodog

import org.json.JSONArray
import org.json.JSONObject

internal data class ClientSim(
    val id: String,
    val gatewayId: String?,
    val label: String,
    val phoneLabel: String?,
    val slotIndex: Int?,
    val countryIso: String?,
    val embedded: Boolean?,
    val present: Boolean,
    val assignmentPending: Boolean,
    val online: Boolean,
    val telephonyReady: Boolean,
    val smsReady: Boolean,
    val mediaReady: Boolean,
    val version: Long = 0,
    val timeZone: String? = null,
    val answerMode: String? = null,
    val gatewayKind: GatewayKind = GatewayKind.PIXEL,
) {
    val gatewayShortLabel: String get() = gatewayId?.let(gatewayKind::shortLabel) ?: "网关待确认"
    val gatewayFullLabel: String get() = gatewayId?.let { "${gatewayKind.shortPrefix}-$it" } ?: "网关身份待确认"
    val displayLabel: String get() = phoneLabel?.takeIf(String::isNotBlank) ?: label
    val canCall: Boolean get() = present && !assignmentPending && online && telephonyReady && mediaReady
    val canSms: Boolean get() = present && !assignmentPending && online && smsReady

    fun unavailableReason(forCall: Boolean): String? = when {
        !present -> "此号码当前未启用"
        assignmentPending -> "号码归属正在确认"
        !online -> "号码设备离线时，请在对应网关设备上重新开启 VoDog。"
        forCall && !telephonyReady -> "手机线路尚未准备好"
        forCall && !mediaReady -> "通话音频尚未准备好"
        !forCall && !smsReady -> "短信通道尚未准备好"
        else -> null
    }
}

internal fun JSONObject.toClientSim(): ClientSim = ClientSim(
    id = getString("id"),
    gatewayId = nullableText("gatewayId"),
    label = optString("label").ifBlank { "SIM" },
    phoneLabel = nullableText("phoneLabel"),
    slotIndex = if (!has("slotIndex") || isNull("slotIndex")) null else getInt("slotIndex"),
    countryIso = nullableText("countryIso")?.takeIf { it.matches(Regex("[A-Za-z]{2}")) }?.uppercase(),
    embedded = if (!has("embedded") || isNull("embedded")) null else getBoolean("embedded"),
    present = if (has("present")) optBoolean("present") else true,
    assignmentPending = optBoolean("assignmentPending"),
    online = optBoolean("online"),
    telephonyReady = optBoolean("telephonyReady"),
    smsReady = optBoolean("smsReady"),
    mediaReady = optBoolean("mediaReady"),
    version = if (!has("version") || isNull("version")) 0 else optLong("version"),
    timeZone = nullableText("timeZone"),
    answerMode = optJSONObject("settings")?.nullableText("mode"),
    gatewayKind = gatewayKind(),
)

/**
 * S58: 网关类型只用来选文字，从不判断能力；`gatewayKind` 缺失或未知一律按 pixel。
 * 线上语义值（`originatingPlatform='pixel'`、录音 `source=pixel`）不随它变。
 */
enum class GatewayKind(val shortPrefix: String, val deviceName: String, val directDialLabel: String, val archiveLabel: String) {
    PIXEL("PX", "手机", "通过手机拨打", "Pixel 原始归档"),
    DJI4G("DJI", "DJI 4G 模组", "通过 DJI 4G 模组拨打", "DJI 4G 原始归档");

    val occupiedLabel: String get() = "${deviceName}通话中"
    fun shortLabel(gatewayId: String): String = "$shortPrefix-${gatewayId.take(8)}"

    companion object {
        fun of(wire: String?): GatewayKind = if (wire == "dji4g") DJI4G else PIXEL
    }
}

/** `gatewayKind` on a `/sims` item or a call DTO. */
internal fun JSONObject.gatewayKind(): GatewayKind = GatewayKind.of(nullableText("gatewayKind"))

internal data class SmsConversationKey(val simId: String, val address: String) {
    val storageKey: String get() = "$simId\u0000$address"
}

internal data class ClientSmsMessage(
    val id: String,
    val simId: String,
    val direction: String,
    val remoteNumber: String,
    val conversationAddress: String,
    val replyNumber: String?,
    val canReply: Boolean,
    val body: String,
    val state: String,
    val timestamp: String,
    val raw: JSONObject,
) {
    val conversationKey = SmsConversationKey(simId, conversationAddress)
}

internal fun JSONObject.toClientSmsMessage(): ClientSmsMessage {
    val remote = optString("remoteNumber")
    val legacyAddress = !has("conversationAddress") && !has("replyNumber") && !has("canReply")
    val address = when {
        !has("conversationAddress") -> remote
        !nullableText("conversationAddress").isNullOrBlank() -> nullableText("conversationAddress").orEmpty()
        else -> "unresolved:${optString("id", remote)}"
    }
    val reply = if (has("replyNumber")) nullableText("replyNumber")
        else if (legacyAddress) remote.takeIf(String::isNotBlank) else null
    return ClientSmsMessage(
        id = optString("id", toString()),
        simId = optString("simId"),
        direction = optString("direction"),
        remoteNumber = remote,
        conversationAddress = address.ifBlank { remote.ifBlank { "号码未知" } },
        replyNumber = reply,
        canReply = if (legacyAddress) !reply.isNullOrBlank() else optBoolean("canReply") && !reply.isNullOrBlank(),
        body = optString("body"),
        state = optString("state"),
        timestamp = listOf("deliveredAt", "sentAt", "receivedAt", "createdAt")
            .firstNotNullOfOrNull { nullableText(it) }.orEmpty(),
        raw = this,
    )
}

internal data class SmsConversation(val key: SmsConversationKey, val messages: List<ClientSmsMessage>) {
    val latest: ClientSmsMessage get() = messages.last()

    /**
     * S21 §A — who the server says this thread belongs to. Messages are sorted oldest first, so the
     * newest row that carries an annotation wins: a name added (or a number unblocked) after an old
     * message arrived must not be overridden by that older row. A thread whose messages all predate
     * S21 reads as [ContactAnnotation.Empty], i.e. plain number, exactly as in S20.
     */
    val contact: ContactAnnotation
        get() = messages.asReversed().firstNotNullOfOrNull { message ->
            message.raw.toContactAnnotation().takeIf { it != ContactAnnotation.Empty }
        } ?: ContactAnnotation.Empty

    /** `号码 · 姓名` for the row and the thread header. */
    val title: String get() = numberWithContactName(key.address, contact.contactName)

    /**
     * The number the contact card should act on. `conversationAddress` can be a server placeholder
     * for an unresolved thread, so the real reply/remote number is preferred for 拨打 / 短信 / 屏蔽.
     */
    val contactNumber: String
        get() = latest.replyNumber?.takeIf(String::isNotBlank)
            ?: latest.remoteNumber.takeIf(String::isNotBlank)
            ?: key.address
}

internal fun smsConversations(items: List<JSONObject>, selectedSimId: String): List<SmsConversation> = items
    .mapNotNull { runCatching { it.toClientSmsMessage() }.getOrNull() }
    .filter { it.simId == selectedSimId }
    .groupBy(ClientSmsMessage::conversationKey)
    .map { (key, messages) -> SmsConversation(key, messages.sortedBy(ClientSmsMessage::timestamp)) }
    .sortedByDescending { it.latest.timestamp }

/**
 * S20 D6 — the server's own view of who holds `gateway_call_locks` for a call. Every field is
 * additive: an older control service omits `occupancy` entirely and the client falls back to the
 * state-based derivation it has always used.
 */
internal data class CallOccupancy(
    val holdsLock: Boolean,
    val lockedSince: String?,
    val occupantPlatform: String?,
    val occupantDevice: String?,
    val isCurrentSession: Boolean,
    val canRelease: Boolean,
)

internal fun JSONObject.toCallOccupancy(): CallOccupancy? {
    val raw = if (!has("occupancy") || isNull("occupancy")) null else optJSONObject("occupancy")
    raw ?: return null
    return CallOccupancy(
        holdsLock = raw.optBoolean("holdsLock"),
        lockedSince = raw.nullableText("lockedSince"),
        occupantPlatform = raw.nullableText("occupantPlatform")
            ?.takeIf { it in setOf("ios", "android", "macos", "web", "ai", "pixel") },
        occupantDevice = raw.nullableText("occupantDevice"),
        isCurrentSession = raw.optBoolean("isCurrentSession"),
        canRelease = raw.optBoolean("canRelease"),
    )
}

internal val OCCUPYING_CALL_STATES = setOf(
    "incoming_ringing", "outgoing_pending", "connecting", "active", "ending", "unknown",
)

/**
 * Busy is authoritative when the server says so: if any call on this gateway carries `occupancy`,
 * the one holding the lock is the occupant and nothing else counts. Without the field the old
 * state-based derivation stands, so mixed deployments keep working.
 */
internal fun gatewayBusyForSim(
    sim: ClientSim,
    calls: List<JSONObject>,
    knownSims: List<ClientSim> = listOf(sim),
): JSONObject? = sim.gatewayId?.let { gatewayId ->
    val onGateway = calls.filter { call ->
        val callGateway = call.optString("gatewayId").takeIf(String::isNotBlank)
            ?: knownSims.singleOrNull { it.id == call.optString("simId") }?.gatewayId
        callGateway == gatewayId
    }
    if (onGateway.any { it.toCallOccupancy() != null }) {
        onGateway.firstOrNull { it.toCallOccupancy()?.holdsLock == true }
    } else {
        onGateway.firstOrNull { it.optString("state") in OCCUPYING_CALL_STATES }
    }
}

/**
 * S72 A4 统一占用条：「通话中 · 由 {端/设备名} 接听 · 自 hh:mm」；内部通话按 E 节写
 * 「内部通话 · A → B · 由 {端} 接听」。占用者来自 [callOccupantLabel]，时间是锁的 `lockedSince`，缺省用通话开始。
 */
internal fun callOccupancyNotice(call: JSONObject, timeZone: String? = null): String {
    val by = "由 ${callOccupantName(call)} 接听"
    internalCallTitle(call)?.let { return "${it.replaceFirst("内部通话 ", "内部通话 · ")} · $by" }
    val since = call.toCallOccupancy()?.lockedSince?.takeIf(String::isNotBlank)
        ?: call.optString("startedAt")
    return "通话中 · $by · 自 ${formatGatewayTime(since, jsonDisplayTimeZone(call, timeZone))}"
}

/** 「由 X 接听」里的 X：[callOccupantLabel] 去掉会和「接听 / 通话中」重复的尾巴。 */
internal fun callOccupantName(call: JSONObject): String = callOccupantLabel(call).let { label ->
    when {
        label == "AI 接听" -> "AI"
        label == call.gatewayKind().occupiedLabel -> "${call.gatewayKind().deviceName}本机"
        else -> label
    }
}

/**
 * S22 决策 4. The one condition all three clients share: the call is in AI 即接 mode *and* the server
 * still has a live AI run on it. `answerMode` alone is not enough (a failed run falls back to a normal
 * ringing call) and `aiHandling` alone is not either — `timeout_ai` also carries a run while the call
 * is legitimately ringing on every device. A control service that predates S22 sends neither field,
 * so the expression is false and the call keeps its 接听/拒接 buttons.
 */
internal fun aiAnswerSuppressed(call: JSONObject): Boolean =
    call.optString("answerMode") == "ai" && call.optBoolean("aiHandling")

/** `normal` when the server does not say; `mode_snapshot` is passed through verbatim otherwise. */
internal fun callAnswerMode(call: JSONObject): String =
    call.optString("answerMode").takeIf { it.isNotBlank() && it != "null" } ?: "normal"

internal fun callOccupantLabel(call: JSONObject): String {
    val occupancy = call.toCallOccupancy()
    occupancy?.occupantDevice?.takeIf(String::isNotBlank)?.let { return it }
    // S38: 占用条说的是这台 Pixel 正忙，不是"怎么拨的" —— iOS/Web 在这里同样固定写「手机通话中」。
    if (occupancy?.occupantPlatform == "pixel" || isPixelOriginatedCall(call)) return call.gatewayKind().occupiedLabel
    occupancy?.occupantPlatform?.let { occupancyPlatformLabel(it, call.gatewayKind()) }?.let { return it }
    // No occupant platform, but the server says AI has this ringing call: naming the AI beats the
    // generic "其他设备", which reads as another phone of the user's (S22 决策 4).
    if (aiAnswerSuppressed(call)) return "AI 接听"
    return callOwnerLabel(call) ?: "其他设备"
}

/** The button only appears for a call this session does not hold and the server says we may end. */
internal fun canReleaseOccupiedCall(call: JSONObject): Boolean {
    // S38: a call dialled on the Pixel itself has no server-side control leg — the server already
    // answers `canRelease:false`, and this guard keeps an older/looser payload from showing a button
    // that can only fail with `CALL_NOT_CONTROLLABLE`.
    if (isPixelOriginatedCall(call)) return false
    val occupancy = call.toCallOccupancy() ?: return false
    return occupancy.canRelease && !occupancy.isCurrentSession
}

/** S38: the call was dialled on the Pixel's own dialer, not through VoDog. */
internal fun isPixelOriginatedCall(call: JSONObject): Boolean =
    call.nullableText("originatingPlatform") == "pixel"

/**
 * S38 三端合同 — the one extra line a 记录 row carries. 忙线 outcomes win over 拨打方式 because they
 * explain why the call has no audio at all; `null` means the row stays exactly as it was.
 */
internal fun s38CallBadgeLabel(call: JSONObject): String? = blockedCallSourceLabel(call) ?: when {
    call.nullableText("failureReason") == "busy_auto_rejected" -> "忙线未接"
    call.nullableText("conflictDisposition") == "ai_answered" -> "忙线 AI 代接"
    isPixelOriginatedCall(call) -> call.gatewayKind().directDialLabel
    else -> null
}

/**
 * S38b: 被拦截的来电（`failureReason == "number_blocked"`）。来源决定说法，没有来源就只说已拦截；
 * 不是拦截行就回 null，行的形状一点不变。
 */
internal fun blockedCallSourceLabel(call: JSONObject): String? =
    if (call.nullableText("failureReason") == "number_blocked") {
        interceptionSourceLabel(call.nullableText("blockedSource")) ?: "已拦截"
    } else {
        null
    }

/** 失败原因 in 记录详情: only the S38 reason is translated, everything else stays verbatim. */
internal fun failureReasonLabel(reason: String?): String? = when {
    reason.isNullOrBlank() || reason == "null" -> null
    reason == "busy_auto_rejected" -> "忙线未接"
    reason == "number_blocked" -> "号码已拦截"
    else -> reason
}

/** 拦截来源 (S38): 手机 = the Pixel's own screening app, ahead of the gateway. */
internal fun interceptionSourceLabel(source: String?): String? = when (source) {
    "phone" -> "手机自动拦截"
    "gateway" -> "网关拦截"
    "control" -> "服务器拦截"
    else -> null
}

/**
 * The guards the release request carries (S20 D6), mirroring the web `ringingEndGuard`: a ringing
 * call is ended as a decline under `onlyIfRinging`, so if another device answers between the tap and
 * the request the server refuses (409 `CALL_NOT_RINGING`) instead of hanging up a call that just
 * connected. Any other state carries no guard at all — `onlyIfCurrentSessionOwner` is precisely the
 * check this action exists to step past, and the server still authorises by snapshot owner.
 */
internal data class OccupancyEndGuard(
    val onlyIfRinging: Boolean,
    val onlyIfCurrentSessionOwner: Boolean,
)

internal fun occupancyEndGuard(state: String): OccupancyEndGuard = OccupancyEndGuard(
    onlyIfRinging = state == "incoming_ringing",
    onlyIfCurrentSessionOwner = false,
)

internal data class OccupancyReleasePrompt(
    val title: String,
    val message: String,
    val confirmLabel: String,
)

/**
 * Ending a ringing call on behalf of every device is a decline, not a hang-up, so it says so; any
 * other state is the other-device hang-up the S20 spec words verbatim.
 */
internal fun occupancyReleasePrompt(state: String): OccupancyReleasePrompt =
    if (state == "incoming_ringing") {
        OccupancyReleasePrompt(
            title = "拒接这通来电",
            message = "将替本账号所有设备拒接这通来电。",
            confirmLabel = "拒接",
        )
    } else {
        OccupancyReleasePrompt(
            title = "结束该通话",
            message = "将挂断本账号在另一台设备上的通话。",
            confirmLabel = "结束通话",
        )
    }

internal fun localMediaBlocks(callId: String?, media: CallMediaUiState): Boolean =
    media.callId != null && media.callId != callId && media.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)

internal fun newSmsDraftKey(accountId: String, simId: String): String = "new:$accountId:$simId"

internal fun newSmsNumberDraftKey(accountId: String, simId: String): String = "new-number:$accountId:$simId"

internal fun replySmsDraftKey(accountId: String, key: SmsConversationKey): String =
    "reply:$accountId:${key.storageKey}"

/**
 * S21 §A 架构决策 3 — the server decides who a number belongs to and whether it is blocked, and
 * hands the answer down on every call/SMS/interception/blocklist row. All four fields are optional:
 * during the staged rollout an older control service omits them entirely, which reads here as
 * "unknown contact, not blocked" rather than as a parse failure.
 */
data class ContactAnnotation(
    val contactId: String?,
    val contactName: String?,
    val blocked: Boolean,
    val blockedEntryId: String?,
) {
    companion object {
        val Empty = ContactAnnotation(null, null, false, null)
    }
}

internal fun JSONObject.toContactAnnotation(): ContactAnnotation = ContactAnnotation(
    contactId = nullableText("contactId"),
    contactName = nullableText("contactName"),
    blocked = optBoolean("blocked"),
    blockedEntryId = nullableText("blockedEntryId"),
)

data class ClientContactPhone(
    val id: String?,
    val rawNumber: String,
    val e164: String?,
    val label: String?,
    val isPrimary: Boolean,
) {
    val dialNumber: String get() = e164?.takeIf(String::isNotBlank) ?: rawNumber
}

data class ClientContactEmail(val id: String?, val address: String, val label: String?)

data class ClientContactAddress(
    val id: String?,
    val formatted: String?,
    val label: String?,
    val street: String?,
    val city: String?,
    val region: String?,
    val postalCode: String?,
    val country: String?,
) {
    /** The server may only store the parts; the card still needs one line to print. */
    val displayLine: String
        get() = formatted?.takeIf(String::isNotBlank)
            ?: listOfNotNull(country, region, city, street, postalCode)
                .filter(String::isNotBlank)
                .joinToString(" ")
                .ifBlank { "地址未填写" }
}

data class ClientContact(
    val id: String,
    val version: Long = 1,
    val displayName: String,
    val givenName: String?,
    val familyName: String?,
    val organization: String?,
    val notes: String?,
    val source: String?,
    val sourceDeviceId: String?,
    val sourceContactId: String?,
    val phones: List<ClientContactPhone>,
    val emails: List<ClientContactEmail>,
    val addresses: List<ClientContactAddress>,
    val blocked: Boolean,
    val createdAt: String?,
    val updatedAt: String?,
) {
    val primaryPhone: ClientContactPhone?
        get() = phones.firstOrNull { it.isPrimary } ?: phones.firstOrNull()
    val listSubtitle: String
        get() = primaryPhone?.rawNumber?.takeIf(String::isNotBlank)
            ?: emails.firstOrNull()?.address
            ?: organization
            ?: "无号码"
}

internal fun JSONObject.toClientContact(): ClientContact = ClientContact(
    id = getString("id"),
    version = optLong("version", 1L).coerceAtLeast(1L),
    displayName = optString("displayName").ifBlank { "未命名联系人" },
    givenName = nullableText("givenName"),
    familyName = nullableText("familyName"),
    organization = nullableText("organization"),
    notes = nullableText("notes"),
    source = nullableText("source"),
    sourceDeviceId = nullableText("sourceDeviceId"),
    sourceContactId = nullableText("sourceContactId"),
    phones = jsonObjects("phones").mapIndexedNotNull { index, phone ->
        val raw = phone.optString("rawNumber").takeIf(String::isNotBlank)
            ?: phone.nullableText("e164")
            ?: return@mapIndexedNotNull null
        ClientContactPhone(
            id = phone.nullableText("id"),
            rawNumber = raw,
            e164 = phone.nullableText("e164"),
            label = phone.nullableText("label"),
            // An older row without an explicit primary still needs one; the first phone wins.
            isPrimary = if (phone.has("isPrimary")) phone.optBoolean("isPrimary") else index == 0,
        )
    },
    emails = jsonObjects("emails").mapNotNull { email ->
        email.nullableText("address")?.let {
            ClientContactEmail(email.nullableText("id"), it, email.nullableText("label"))
        }
    },
    addresses = jsonObjects("addresses").map { address ->
        ClientContactAddress(
            id = address.nullableText("id"),
            formatted = address.nullableText("formatted"),
            label = address.nullableText("label"),
            street = address.nullableText("street"),
            city = address.nullableText("city"),
            region = address.nullableText("region"),
            postalCode = address.nullableText("postalCode"),
            country = address.nullableText("country"),
        )
    },
    blocked = optBoolean("blocked"),
    createdAt = nullableText("createdAt"),
    updatedAt = nullableText("updatedAt"),
)

data class ContactPhoneDraft(val rawNumber: String, val label: String? = null)
data class ContactEmailDraft(val address: String, val label: String? = null)
data class ContactAddressDraft(
    val formatted: String? = null,
    val label: String? = null,
    val street: String? = null,
    val city: String? = null,
    val region: String? = null,
    val postalCode: String? = null,
    val country: String? = null,
) {
    val empty: Boolean
        get() = listOf(formatted, street, city, region, postalCode, country).all { it.isNullOrBlank() }
}

/**
 * The `POST /contacts` / `PUT /contacts/:id` body (§A). `sourceContactId` only travels on import
 * entries; a hand-written contact leaves it null so the server never joins it to a device row.
 */
data class ContactDraft(
    val displayName: String,
    val givenName: String? = null,
    val familyName: String? = null,
    val organization: String? = null,
    val notes: String? = null,
    val phones: List<ContactPhoneDraft> = emptyList(),
    val emails: List<ContactEmailDraft> = emptyList(),
    val addresses: List<ContactAddressDraft> = emptyList(),
    val sourceContactId: String? = null,
) {
    /** The server's own floor: a name plus at least one phone or email. */
    val valid: Boolean get() = displayName.isNotBlank() && (phones.isNotEmpty() || emails.isNotEmpty())

    fun toJson(): JSONObject = JSONObject()
        .put("displayName", displayName.trim())
        .putTextOrNull("givenName", givenName)
        .putTextOrNull("familyName", familyName)
        .putTextOrNull("organization", organization)
        .putTextOrNull("notes", notes)
        .put("phones", JSONArray().also { array ->
            phones.forEach { phone ->
                array.put(
                    JSONObject().put("rawNumber", phone.rawNumber.trim())
                        .putTextOrNull("label", phone.label),
                )
            }
        })
        .put("emails", JSONArray().also { array ->
            emails.forEach { email ->
                array.put(
                    JSONObject().put("address", email.address.trim()).putTextOrNull("label", email.label),
                )
            }
        })
        .put("addresses", JSONArray().also { array ->
            addresses.filterNot(ContactAddressDraft::empty).forEach { address ->
                array.put(
                    JSONObject()
                        .putTextOrNull("formatted", address.formatted)
                        .putTextOrNull("label", address.label)
                        .putTextOrNull("street", address.street)
                        .putTextOrNull("city", address.city)
                        .putTextOrNull("region", address.region)
                        .putTextOrNull("postalCode", address.postalCode)
                        .putTextOrNull("country", address.country),
                )
            }
        })
        .apply { sourceContactId?.takeIf(String::isNotBlank)?.let { put("sourceContactId", it) } }
}

/** `POST /contacts/import` response counters (§A). */
data class ContactImportResult(
    val total: Int = 0,
    val created: Int = 0,
    val updated: Int = 0,
    val merged: Int = 0,
    val skipped: Int = 0,
    val phonesSkipped: Int = 0,
) {
    operator fun plus(other: ContactImportResult) = ContactImportResult(
        total = total + other.total,
        created = created + other.created,
        updated = updated + other.updated,
        merged = merged + other.merged,
        skipped = skipped + other.skipped,
        phonesSkipped = phonesSkipped + other.phonesSkipped,
    )

    val summary: String
        get() = "共 $total 条 · 新增 $created · 更新 $updated · 合并 $merged · 跳过 $skipped" +
            if (phonesSkipped > 0) " · 忽略号码 $phonesSkipped" else ""
}

internal fun parseContactImportResult(json: JSONObject): ContactImportResult = ContactImportResult(
    total = json.optInt("total"),
    created = json.optInt("created"),
    updated = json.optInt("updated"),
    merged = json.optInt("merged"),
    skipped = json.optInt("skipped"),
    phonesSkipped = json.optInt("phonesSkipped"),
)

/** One row of `GET /blocklist/interceptions` (§B). */
data class ClientInterception(
    val id: String,
    val kind: String,
    val simId: String?,
    val remoteNumber: String,
    val contactId: String?,
    val contactName: String?,
    val occurredAt: String,
    val bodyPreview: String?,
    val blockedEntryId: String?,
    val source: String?,
    val simLabel: String? = null,
    val gatewayTimeZone: String? = null,
)

internal fun JSONObject.toClientInterception(): ClientInterception = ClientInterception(
    id = optString("id").ifBlank { optString("occurredAt") + optString("remoteNumber") },
    kind = optString("kind").ifBlank { "call" },
    simId = nullableText("simId"),
    remoteNumber = optString("remoteNumber").ifBlank { "号码未知" },
    contactId = nullableText("contactId"),
    contactName = nullableText("contactName"),
    occurredAt = optString("occurredAt"),
    bodyPreview = nullableText("bodyPreview"),
    blockedEntryId = nullableText("blockedEntryId"),
    source = nullableText("source"),
    simLabel = nullableText("simLabel"),
    gatewayTimeZone = nullableText("gatewayTimeZone"),
)

/** `lastPowerResult` — what the Pixel reported back about the last remote ON/OFF attempt (§D). */
data class GatewayPowerResult(
    val desired: String?,
    val ok: Boolean,
    val reason: String?,
    val at: String?,
)

data class ClientGatewayPower(
    val gatewayId: String,
    val name: String,
    val controlEnabled: Boolean,
    val online: Boolean,
    val lastSeenAt: String?,
    val standbyOnline: Boolean,
    val standbySeenAt: String?,
    val remotePowerAllowed: Boolean,
    val desiredPower: String?,
    val desiredPowerRequestedAt: String?,
    val lastPowerResult: GatewayPowerResult?,
    val occupied: Boolean,
) {
    /** The switch shows ON while the gateway is up *or* while a requested ON is still in flight. */
    val powerOn: Boolean get() = online || desiredPower == "on"
    val pending: Boolean get() = desiredPower != null
}

internal fun JSONObject.toClientGatewayPower(): ClientGatewayPower = ClientGatewayPower(
    gatewayId = getString("gatewayId"),
    name = optString("name").ifBlank { "网关" },
    controlEnabled = optBoolean("controlEnabled"),
    online = optBoolean("online"),
    lastSeenAt = nullableText("lastSeenAt"),
    standbyOnline = optBoolean("standbyOnline"),
    standbySeenAt = nullableText("standbySeenAt"),
    remotePowerAllowed = optBoolean("remotePowerAllowed"),
    desiredPower = nullableText("desiredPower")?.takeIf { it == "on" || it == "off" },
    desiredPowerRequestedAt = nullableText("desiredPowerRequestedAt"),
    lastPowerResult = optJSONObject("lastPowerResult")?.let { result ->
        GatewayPowerResult(
            desired = result.nullableText("desired"),
            ok = result.optBoolean("ok"),
            reason = result.nullableText("reason"),
            at = result.nullableText("at"),
        )
    },
    occupied = optBoolean("occupied"),
)

/** `GET /calls/:id/ai-transcript` items (§E). */
data class ClientAiTranscriptSegment(val role: String, val text: String, val at: String?)

internal fun JSONObject.toAiTranscriptSegment(): ClientAiTranscriptSegment = ClientAiTranscriptSegment(
    role = optString("role").takeIf { it == "ai" || it == "caller" } ?: "caller",
    text = optString("text"),
    at = nullableText("at"),
)

private fun JSONObject.jsonObjects(key: String): List<JSONObject> {
    val array = optJSONArray(key) ?: return emptyList()
    return buildList {
        for (index in 0 until array.length()) array.optJSONObject(index)?.let(::add)
    }
}

private fun JSONObject.putTextOrNull(key: String, value: String?): JSONObject =
    put(key, value?.trim()?.takeIf(String::isNotEmpty) ?: JSONObject.NULL)

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf(String::isNotBlank)
