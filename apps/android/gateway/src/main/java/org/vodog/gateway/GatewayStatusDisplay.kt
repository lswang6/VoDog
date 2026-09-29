package org.vodog.gateway

import org.vodog.gateway.media.GatewayProbeNodeOutcomes
import java.time.Instant

/**
 * Pure text derivation for the gateway screen. Everything here is unit-tested so the status header
 * cannot start reporting a state the heartbeat never published.
 */

/** "上次心跳 3 秒前". Derived from the persisted wall clock, ticked once per second by the UI. */
internal fun gatewayHeartbeatAgeText(wallClockMs: Long?, nowMs: Long): String? {
    val stamp = wallClockMs ?: return null
    val seconds = ((nowMs - stamp) / 1_000L)
    return when {
        seconds < 2L -> "上次心跳 刚刚"
        seconds < 60L -> "上次心跳 $seconds 秒前"
        seconds < 3_600L -> "上次心跳 ${seconds / 60L} 分钟前"
        seconds < 86_400L -> "上次心跳 ${seconds / 3_600L} 小时前"
        else -> "上次心跳 ${seconds / 86_400L} 天前"
    }
}

/**
 * One subtitle line: the heartbeat age, or the placeholder that explains a state which has no
 * heartbeat at all. S20 D7 moved the capability segments out of this string and into their own pills,
 * so the subtitle stays one short, readable line instead of an ellipsised run-on.
 */
internal fun gatewayHeroSubtitle(
    heartbeatAge: String?,
    connection: ServerConnection,
): String = when (connection) {
    ServerConnection.DISABLED -> "使用 Pixel 本机接打电话和收发短信"
    ServerConnection.UNPAIRED -> "请先置入管理员发放的设备凭据"
    else -> heartbeatAge ?: "尚未收到心跳"
}

/**
 * The capability pills shown under the hero title. They are still lifted from the heartbeat's own
 * detail string, so the header can never advertise something the control service was not told.
 */
internal fun gatewayCapabilityPills(connectionDetail: String): List<String> =
    gatewayConnectionDetailSegments(connectionDetail).filter(::isCapabilitySegment)

/**
 * The remainder of the heartbeat detail: SIM counts, probe-refresh failures and sync diagnostics.
 * Splitting it this way is what lets the network card stop repeating the capability text the hero
 * already shows as pills, without losing the segments that appear nowhere else.
 */
internal fun gatewayConnectionDetailExtras(connectionDetail: String): List<String> =
    gatewayConnectionDetailSegments(connectionDetail)
        .filterNot(::isCapabilitySegment)
        .filterNot { it == "控制通道正常" }

private fun gatewayConnectionDetailSegments(connectionDetail: String): List<String> = connectionDetail
    .split("；")
    .map(String::trim)
    .filter(String::isNotBlank)

private fun isCapabilitySegment(segment: String): Boolean =
    segment.startsWith("短信") || segment.startsWith("远程通话")

internal fun gatewaySimOwnershipLabel(binding: ServerSimBinding?): String = when {
    binding == null -> "归属：等待同步"
    binding.routable -> "归属：已分配"
    else -> "归属：未分配"
}

internal fun gatewaySimAnswerModeLabel(settings: AppliedSimSettings?): String = when {
    settings == null -> "接听：等待同步"
    settings.mode == "normal" -> "接听：普通"
    settings.mode == "ai" -> "接听：AI 代接"
    else -> "接听：${settings.timeoutSeconds} 秒转 AI"
}

internal fun gatewayProbeNodeLine(outcome: GatewayProbeNodeOutcomes): String =
    "${outcome.nodeId}：成功 ${outcome.ok} · 超时 ${outcome.timeout} · 网络错误 ${outcome.networkError}"

/** Relative age of accepted probe evidence; an unparsable or absent stamp reads as 无. */
internal fun gatewayProbeValidityText(validUntil: String?, now: Instant): String {
    val instant = validUntil?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return "无有效期"
    val seconds = java.time.Duration.between(now, instant).seconds
    return if (seconds >= 0) "有效期剩余 $seconds 秒" else "有效期已过 ${-seconds} 秒"
}

/**
 * How the evidence line is coloured. The boundary is the heartbeat's own refresh lead
 * ([PROBE_REFRESH_AHEAD_SECONDS]): inside it a refresh is already being scheduled, so "临近过期" is
 * informational, while "已过期" and a missing stamp both mean the gateway is advertising no media
 * readiness at all and read as an error.
 */
internal enum class GatewayProbeFreshness { FRESH, EXPIRING, EXPIRED, UNKNOWN }

internal fun gatewayProbeFreshness(validUntil: String?, now: Instant): GatewayProbeFreshness {
    val instant = validUntil?.let { runCatching { Instant.parse(it) }.getOrNull() }
        ?: return GatewayProbeFreshness.UNKNOWN
    val seconds = java.time.Duration.between(now, instant).seconds
    return when {
        seconds < 0L -> GatewayProbeFreshness.EXPIRED
        seconds <= PROBE_REFRESH_AHEAD_SECONDS -> GatewayProbeFreshness.EXPIRING
        else -> GatewayProbeFreshness.FRESH
    }
}

internal fun gatewayReplayHorizonSummary(state: ReplayHorizonState?): String = when {
    state == null -> "未启用或暂不可读"
    state.quarantined -> "已隔离，需人工处理"
    state.ready -> "已就绪（阻断序号 ${state.blockingFloor} · 已提交 ${state.committedFloor}）"
    else -> "登记中（阻断序号 ${state.blockingFloor}）"
}

internal fun gatewayBuildGateLabel(enabled: Boolean): String = if (enabled) "已开启" else "未开启"

/**
 * Server stamps are RFC 3339 in UTC. Showing that raw string next to Chinese labels forced the
 * reader to do the offset arithmetic; render it in the device's own zone instead. An unparsable
 * value falls back to the original text rather than disappearing.
 */
internal fun gatewayLocalTimestampText(
    value: String?,
    zone: java.time.ZoneId = java.time.ZoneId.systemDefault(),
): String {
    val text = value?.trim().orEmpty()
    if (text.isEmpty()) return "时间未知"
    val instant = runCatching { Instant.parse(text) }.getOrNull() ?: return text
    return java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
        .format(instant.atZone(zone))
}

/**
 * S20 D4: one line for the advanced card so the doorbell can be confirmed without reading logcat.
 * Backoff and the last wake are only appended when they carry information.
 */
internal fun gatewayCommandDoorbellSummary(
    state: CommandDoorbellDisplayState,
    backoffMs: Long,
    lastWakeWallClockMs: Long?,
    nowMs: Long,
): String {
    if (state == CommandDoorbellDisplayState.DISABLED) return CommandDoorbellDisplayState.DISABLED.label
    return buildList {
        add(state.label)
        if (backoffMs > 0L) add("退避 ${backoffMs / 1_000L} 秒")
        lastWakeWallClockMs?.let { add("最近唤醒 ${gatewayRelativeAgeText(it, nowMs)}") }
    }.joinToString(" · ")
}

/**
 * S21 §D. One line under the "允许远程开启" switch. The beacon only runs while the gateway is OFF, so
 * an enabled gateway says so instead of showing an idle beacon as a failure.
 */
internal fun gatewayStandbySummary(
    allowRemotePower: Boolean,
    controlEnabled: Boolean,
    state: StandbyDisplayState,
    backoffMs: Long,
): String = when {
    !allowRemotePower -> "当前状态：未启用（关闭总控后不再连接控制服务）"
    controlEnabled -> "当前状态：总控开启中，由心跳接收远程关闭请求"
    state == StandbyDisplayState.BACKOFF && backoffMs > 0L ->
        "当前状态：${state.label} · 退避 ${backoffMs / 1_000L} 秒"
    state == StandbyDisplayState.DISABLED -> "当前状态：正在启动待命"
    else -> "当前状态：${state.label}"
}

/** The remote power result still waiting for a request that can carry it, rendered for diagnostics. */
internal fun gatewayPowerResultSummary(raw: String?): String {
    val value = raw?.takeIf(String::isNotBlank) ?: return "无待上报结果"
    val json = runCatching { org.json.JSONObject(value) }.getOrNull() ?: return "结果不可读"
    val desired = if (json.optString("desired") == "on") "远程开启" else "远程关闭"
    val ok = if (json.optBoolean("ok")) "成功" else "未执行"
    val reason = json.optString("reason").takeIf(String::isNotBlank)
    return listOfNotNull("$desired$ok", reason, json.optString("at").takeIf(String::isNotBlank))
        .joinToString(" · ")
}

/** "刚刚" / "12 秒前" / "3 分钟前". A stamp from the future reads as 刚刚 rather than a negative age. */
internal fun gatewayRelativeAgeText(wallClockMs: Long, nowMs: Long): String {
    val seconds = ((nowMs - wallClockMs) / 1_000L).coerceAtLeast(0L)
    return when {
        seconds < 2L -> "刚刚"
        seconds < 60L -> "$seconds 秒前"
        seconds < 3_600L -> "${seconds / 60L} 分钟前"
        seconds < 86_400L -> "${seconds / 3_600L} 小时前"
        else -> "${seconds / 86_400L} 天前"
    }
}
