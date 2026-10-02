package org.vodog

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The single place a remote number is turned into a heading. S21 §F: when the server resolved the
 * number to a contact the row reads `199…0101 · 张三`; without a name (old control service, unknown
 * caller) it is exactly what it always was.
 */
internal fun callTitle(item: JSONObject): String = numberWithContactName(
    item.optString("remoteNumber", item.optString("id", "通话")),
    item.nullableContactName(),
)

/** `号码 · 姓名`, or just the number. A name equal to the number is not repeated. */
internal fun numberWithContactName(number: String, contactName: String?): String {
    val shown = number.takeIf { it.isNotBlank() && it != "null" } ?: "号码未知"
    val name = contactName?.trim()?.takeIf { it.isNotEmpty() && it != shown } ?: return shown
    return "$shown · $name"
}

/**
 * `姓名 · 号码` — the report card's title (S22 客户端合同 puts the name first there, unlike the 通话
 * rows frozen by S21 §F). Falls back to the plain number when there is no contact.
 */
internal fun contactNameWithNumber(number: String, contactName: String?): String {
    val shown = number.takeIf { it.isNotBlank() && it != "null" } ?: "号码未知"
    val name = contactName?.trim()?.takeIf { it.isNotEmpty() && it != shown } ?: return shown
    return "$name · $shown"
}

/**
 * S36 C5-a: the 最近/历史 row renders the same two facts on two lines — name first, then the number
 * in full — so a long number is never truncated by the name in front of it. [numberWithContactName]
 * stays the one-line form used for notifications and accessibility labels.
 */
internal fun callRowLines(item: JSONObject): Pair<String?, String> {
    // S72 E: 内部通话的第一行是「内部通话 A → B」，号码行照旧。
    val internalTitle = org.vodog.internalCallTitle(item)
    val shown = item.optString("remoteNumber", item.optString("id", "通话"))
        .takeIf { it.isNotBlank() && it != "null" } ?: "号码未知"
    internalTitle?.let { return it to shown }
    return item.nullableContactName()?.trim()?.takeIf { it.isNotEmpty() && it != shown } to shown
}

private fun JSONObject.nullableContactName(): String? =
    if (!has("contactName") || isNull("contactName")) null
    else optString("contactName").takeIf(String::isNotBlank)

internal fun interceptionKindLabel(kind: String): String = when (kind) {
    "call" -> "来电"
    "sms" -> "短信"
    else -> "拦截"
}

internal fun aiTranscriptRoleLabel(role: String): String = when (role) {
    "ai" -> "AI"
    "caller" -> "对方"
    else -> "未知"
}

/** iOS/Web print the same three words, so a gateway never reads 待命中 on one client and 离线 here. */
internal fun gatewayPowerStatusLabel(power: ClientGatewayPower): String = when {
    power.online -> "在线"
    power.standbyOnline -> "待命中"
    else -> "离线"
}

internal fun gatewayRemotePowerLabel(power: ClientGatewayPower): String =
    if (power.remotePowerAllowed) "远程开启已允许" else "远程开启未允许（需在网关设备上打开）"

/**
 * The four §D refusal codes in Chinese. Anything else (network, 5xx, a code a newer server invents)
 * falls through to the server's own message, so the user is never shown a bare code.
 */
internal fun gatewayPowerErrorMessage(code: String, fallback: String): String = when (code) {
    "GATEWAY_REMOTE_POWER_NOT_ALLOWED" -> "这台网关尚未允许远程开启，请先在网关设备上打开“允许远程开启（待命）”。"
    "GATEWAY_STANDBY_OFFLINE" -> "网关的待命通道已离线，无法远程开启；请在网关设备上手动开启。"
    "GATEWAY_OFFLINE" -> "网关当前不在线，无法远程关闭。"
    "GATEWAY_IN_USE" -> "这台网关设备正在通话中，为安全起见已拒绝远程关闭。"
    else -> fallback
}

/** The Pixel's own report on the last remote switch, shown under the card (§D `lastPowerResult`). */
internal fun gatewayPowerResultLabel(result: GatewayPowerResult?): String? {
    result ?: return null
    val action = when (result.desired) {
        "on" -> "远程开启"
        "off" -> "远程关闭"
        else -> "远程开关"
    }
    val outcome = if (result.ok) "已完成" else "未完成"
    val reason = result.reason?.takeIf(String::isNotBlank)?.let { "：${gatewayPowerReasonLabel(it)}" }.orEmpty()
    val at = result.at?.takeIf(String::isNotBlank)?.let { " · ${displayDateTime(it)}" }.orEmpty()
    return "$action$outcome$reason$at"
}

/** Reasons the gateway sends back verbatim; unknown ones are shown as-is rather than hidden. */
internal fun gatewayPowerReasonLabel(reason: String): String = when (reason) {
    "call_in_progress" -> "网关上仍有通话"
    "not_allowed" -> "网关未允许远程开启"
    "feature_gate" -> "网关功能门控未通过"
    "permission" -> "网关缺少必要权限"
    else -> reason
}

internal fun contactSourceLabel(source: String?): String = when (source) {
    "android" -> "来自 Android 通讯录"
    "ios" -> "来自 iPhone 通讯录"
    "web_vcard" -> "来自 vCard 导入"
    "web_csv" -> "来自 CSV 导入"
    "web_picker" -> "来自浏览器选择"
    "manual" -> "手动创建"
    else -> "来源未知"
}

/** Contact phone/email/address labels; device imports carry English type names. */
internal fun contactLabelText(label: String?): String {
    val value = label?.trim().orEmpty()
    if (value.isEmpty()) return "其他"
    return when (value.lowercase()) {
        "mobile", "cell" -> "手机"
        "home" -> "住宅"
        "work" -> "工作"
        "main" -> "主要"
        "iphone" -> "iPhone"
        "work_mobile", "work mobile" -> "工作手机"
        "home_fax", "home fax" -> "住宅传真"
        "work_fax", "work fax" -> "工作传真"
        "fax" -> "传真"
        "pager" -> "寻呼机"
        "company_main", "company main" -> "公司总机"
        "other" -> "其他"
        else -> value
    }
}

internal fun directionLabel(value: String): String = when (value) {
    "incoming" -> "来电"
    "outgoing" -> "去电"
    else -> "通话"
}

/**
 * The one localized call-state map. iOS shows the raw server state in its 记录 list and a localized
 * title everywhere else; Android deliberately uses this map in both places so a call never reads
 * "ended" on one screen and "已结束" on another.
 */
internal fun callStateLabel(value: String): String = when (value) {
    "incoming_ringing" -> "来电响铃"
    "outgoing_pending" -> "等待拨号"
    "connecting" -> "连接中"
    "active" -> "通话中"
    "ending" -> "正在结束"
    "ended" -> "已结束"
    "failed" -> "失败"
    else -> "状态待确认"
}

internal fun recordingStatusLabel(value: String): String = when (value) {
    "ready", "complete", "completed" -> "录音已生成"
    "recording", "processing", "pending" -> "录音处理中"
    "incomplete" -> "录音不完整"
    "failed" -> "录音失败"
    else -> "录音状态待确认"
}

internal fun recordingSourceStatusLabel(value: RemoteResource<RecordingManifest?>?): String = when (value) {
    null, RemoteResource.NotLoaded -> "待加载"
    RemoteResource.Loading -> "核验中"
    is RemoteResource.Loaded -> if (value.value == null) "尚未生成" else {
        if (value.value.archiveComplete && value.value.captureComplete != false) "可播放" else "不完整"
    }
    is RemoteResource.Failed -> if (value.message == PIXEL_ARCHIVE_DISABLED_MESSAGE) "未开启" else "读取失败"
}

internal fun roleDisplayLabel(role: String): String = when (role) {
    "admin" -> "管理员"
    "user" -> "用户"
    else -> "暂不可用"
}

internal fun modeDisplayLabel(mode: String): String = when (mode) {
    "normal" -> "人工接听"
    "ai" -> "AI 即接"
    "timeout_ai" -> "超时转 AI"
    else -> "模式待确认"
}

/** S57：SIM 选择条的接听方式标记；没有 settings（或未知模式）时不显示。 */
internal fun simAnswerModeBadge(mode: String?): String? = when (mode) {
    "normal" -> "人工"
    "ai", "timeout_ai" -> "AI"
    else -> null
}

/**
 * 短信会话页顶部那一行号码说明，对齐 iOS 的 `ConversationLineCaption`（MessagesView.swift:464）：
 * 只印号码的显示名，没有设备/SIM id，没有信息图标，也只有一行。没有选中号码就返回 null——
 * 和 iOS 的 optional 一样，什么都不画，而不是印一句“未选择号码”。
 */
internal object ConversationLineCaption {
    /** `toClientSim` 给没有名字的号码兜底成这个词；它不该出现在会话页上。 */
    private const val PLACEHOLDER = "SIM"

    fun text(sim: ClientSim?): String? = sim?.let { channel ->
        val label = channel.displayLabel.trim()
        if (label.isNotEmpty() && label != PLACEHOLDER) label
        // 没有号码标注也没有名字时按卡槽说话（iOS 的 "SIM 2"），而不是光秃秃一个 "SIM"。
        else channel.slotIndex?.let { "SIM ${it + 1}" } ?: PLACEHOLDER
    }
}

internal fun smsStateLabel(message: ClientSmsMessage): String = smsStateLabel(
    message.state, message.direction, message.raw.optString("failureReason"),
)

/** Delivery facts come from the DTO; a held queue is not a failed or safely retryable send. */
private fun smsStateLabel(state: String, direction: String, failureReason: String): String = when (state) {
    "queued" -> if (failureReason == "sms_gateway_execution_unresolved") "等待上一条短信状态确认" else "排队中"
    "sending" -> "发送中"
    "sent" -> "已发送"
    "delivered" -> if (direction == "incoming") "已收到" else "已送达"
    "failed" -> when (failureReason) {
        "sms_not_dispatched" -> "发送失败：短信未下发到号码设备"
        "sms_route_changed_before_release" -> "发送失败：发送前号码线路已变更"
        else -> "发送失败"
    }
    "unknown" -> if (failureReason == "sms_execution_unresolved") "短信执行结果待确认" else "结果待确认"
    else -> "状态未知"
}

/** Known failures are already described by the shared state label; keep legacy details intact. */
internal fun smsFailureDetail(item: JSONObject): String? = item.optString("failureReason").takeIf {
    item.optString("state") == "failed" && it.isNotBlank() && it != "null" &&
        it !in setOf("sms_not_dispatched", "sms_route_changed_before_release")
}

internal fun smsTitle(item: JSONObject): String {
    val direction = if (item.optString("direction") == "incoming") "收到" else "发出"
    return "$direction · ${item.optString("remoteNumber").ifBlank { "号码未知" }}"
}

internal fun smsSubtitle(item: JSONObject, simLabel: String): String {
    val state = smsStateLabel(item.optString("state"), item.optString("direction"), item.optString("failureReason"))
    val timestamp = when {
        item.optString("deliveredAt").isNotBlank() -> item.optString("deliveredAt")
        item.optString("sentAt").isNotBlank() -> item.optString("sentAt")
        item.optString("receivedAt").isNotBlank() -> item.optString("receivedAt")
        else -> item.optString("createdAt")
    }
    return listOf(
        simLabel,
        state,
        item.optString("body"),
        smsFailureDetail(item).orEmpty(),
        displayDateTime(timestamp),
    ).filter { it.isNotBlank() }.joinToString(" · ")
}

/**
 * Conversation-row caption: 收到/发出 · SIM · 投递状态. S92: an incoming message that arrived normally
 * already says 收到, so 「已收到」 is not repeated; anomalous incoming states still show.
 */
internal fun smsRowCaption(message: ClientSmsMessage, simLabel: String): String = listOf(
    if (message.direction == "incoming") "收到" else "发出",
    simLabel,
    if (message.direction == "incoming" && message.state in setOf("delivered", "received")) "" else smsStateLabel(message),
).filter(String::isNotBlank).joinToString(" · ")

/**
 * S92: Pixel font sizes are 1.0 / 1.15 / 1.3 / 1.5 / 1.8 / 2.0. From 1.5 the three side-by-side
 * detail buttons, the 84 dp fact-label column and the 记录 segmented labels no longer fit.
 */
internal fun isLargeFontScale(fontScale: Float): Boolean = fontScale > 1.3f

/**
 * S92: dial-key diameter (dp). Grows with the font so digit + letters stay inside the key; capped so
 * three keys per row still fit a 411 dp screen inside the dial card (≈103 dp per cell).
 */
internal fun keypadKeySizeDp(fontScale: Float): Float = 68f * fontScale.coerceIn(1f, 1.45f)

/**
 * S92: the character range of the phone number inside a `号码 · 姓名` / `姓名 · 号码` title, or null.
 * Only that range is monospaced — a monospaced name and separator read as 「10010  ·  联通服务」.
 */
internal fun phoneTitleNumberRange(title: String): IntRange? {
    var start = 0
    for (segment in title.split(" · ")) {
        if (segment.isNotBlank() && segment.all { it.isDigit() || it in "+*#()- " }) return start until start + segment.length
        start += segment.length + 3
    }
    return null
}

internal fun fileSizeLabel(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

private val clientDateTimeFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy年M月d日 HH:mm")

internal fun displayDateTime(value: String): String = value.takeUnless { it.isBlank() || it == "null" }
    ?.let { raw -> runCatching { Instant.parse(raw).atZone(ZoneId.systemDefault()).format(clientDateTimeFormatter) }.getOrNull() }
    ?: "时间待确认"
