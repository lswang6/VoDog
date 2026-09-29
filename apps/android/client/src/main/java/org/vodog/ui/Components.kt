package org.vodog

import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.SimCard
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import org.json.JSONObject
import java.time.Instant
import java.util.Locale

/** Horizontal gutter every screen shares, so cards line up across tabs. */
internal val ScreenPadding = 16.dp

/** Minimum touch target; applied to every icon-only and compact button. */
internal val TouchTarget = 48.dp

/** Handset network availability; gateway readiness still comes from each SIM's existing policy. */
internal val LocalNetworkAvailable = androidx.compose.runtime.compositionLocalOf { true }

internal fun simConnectionLabel(networkAvailable: Boolean, gatewayOnline: Boolean): String = when {
    !networkAvailable -> "设备未联网"
    !gatewayOnline -> "号码设备离线"
    else -> "在线"
}

/** S73e: the handset offline banner; during a live or rejoining media leg it promises the reconnect instead. */
internal fun offlineBannerText(media: CallMediaUiState): String =
    if (media.callId != null && media.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)) "网络已断开，恢复后通话将自动重连"
    else "设备未联网 · 可查看已加载的记录"

internal fun ongoingCallDuration(
    answeredAt: String?, callState: String, nowMillis: Long, endedAt: String? = null,
    frozenAtMillis: Long? = null,
): String? {
    if (callState !in setOf("active", "connecting", "ending", "unknown", "ended", "failed")) return null
    val answered = runCatching { Instant.parse(answeredAt).toEpochMilli() }.getOrNull() ?: return null
    val end = if (endedAt.isNullOrBlank() || endedAt == "null") {
        if (callState in setOf("ended", "failed")) return null
        frozenAtMillis ?: nowMillis
    } else runCatching { Instant.parse(endedAt).toEpochMilli() }.getOrNull() ?: return null
    val seconds = (end - answered).coerceAtLeast(0) / 1_000
    return if (seconds >= 3_600) String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3_600, seconds / 60 % 60, seconds % 60)
    else String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60)
}

internal val LocalCallDurationFrozenAt = staticCompositionLocalOf<Long?> { null }

/** Display ticker only; timestamps and call state remain owned by the existing call response. */
@Composable
internal fun CallDurationText(call: JSONObject, compact: Boolean = false) {
    val callId = call.optString("id")
    val answeredAt = call.optString("answeredAt")
    val endedAt = call.optString("endedAt")
    val callState = call.optString("state")
    var now by remember(callId, answeredAt) { mutableStateOf(System.currentTimeMillis()) }
    val frozenAt = LocalCallDurationFrozenAt.current
    val duration = ongoingCallDuration(answeredAt, callState, now, endedAt, frozenAt) ?: return
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(callId, answeredAt, endedAt, callState, frozenAt, lifecycle) {
        if (frozenAt == null && callState !in setOf("ending", "ended", "failed") &&
            (endedAt.isBlank() || endedAt == "null")) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                now = System.currentTimeMillis()
                delay(1_000)
            }
        }
    }
    // No liveRegion or accessibility announcement: ticking must not interrupt TalkBack.
    Text(if (compact) duration else "通话时长 $duration", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.testTag("call.duration").semantics { contentDescription = "通话时长 $duration" })
}

/** S67c: iOS-style leading unread dot; the slot keeps its width when hidden so rows stay aligned. */
@Composable
internal fun UnreadDot(visible: Boolean, label: String, modifier: Modifier = Modifier) {
    Box(modifier.width(8.dp), contentAlignment = Alignment.Center) {
        if (visible) {
            Box(
                Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape)
                    .semantics { contentDescription = label }.testTag("unread.dot"),
            )
        }
    }
}

@Composable
internal fun SectionHeader(title: String, modifier: Modifier = Modifier) {
    Text(
        title,
        modifier = modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 4.dp),
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Section header for content that already sits inside a padded list. */
@Composable
internal fun InlineSectionHeader(title: String) {
    Text(
        title,
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 2.dp),
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
internal fun EmptyCard(text: String, modifier: Modifier = Modifier.padding(horizontal = ScreenPadding)) {
    Card(modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Text(text, Modifier.padding(ScreenPadding), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Icon + title (+ optional detail) empty state, the Material answer to iOS ContentUnavailableView. */
@Composable
internal fun EmptyStateCard(
    icon: ImageVector,
    title: String,
    detail: String? = null,
    modifier: Modifier = Modifier,
) {
    Card(modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Row(
            Modifier.padding(ScreenPadding),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Icon(icon, null, Modifier.size(30.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                detail?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/**
 * Filled destructive actions are the deliberate exception to the theme's bright dark-mode error
 * token. That token needs near-black content for contrast; the product rule requires white text on
 * red, so both themes use this deeper red (the light danger token) and retain 5.3:1 contrast.
 */
internal val FilledDestructiveRed = Color(0xFFD70015)

@Composable
internal fun destructiveButtonColors(): ButtonColors = ButtonDefaults.buttonColors(
    containerColor = FilledDestructiveRed,
    contentColor = Color.White,
    disabledContainerColor = FilledDestructiveRed.copy(alpha = 0.6f),
    disabledContentColor = Color.White.copy(alpha = 0.8f),
)

/** Destructive outlined button colours; pair with [destructiveBorder]. */
@Composable
internal fun destructiveOutlinedColors(): ButtonColors = ButtonDefaults.outlinedButtonColors(
    contentColor = MaterialTheme.colorScheme.error,
    disabledContentColor = MaterialTheme.colorScheme.error.copy(alpha = 0.6f),
)

/** Destructive text button colours — 立即屏蔽 on a report card, which sits beside neutral actions. */
@Composable
internal fun destructiveTextColors(): ButtonColors = ButtonDefaults.textButtonColors(
    contentColor = MaterialTheme.colorScheme.error,
    disabledContentColor = MaterialTheme.colorScheme.error.copy(alpha = 0.6f),
)

@Composable
internal fun destructiveBorder(): BorderStroke = BorderStroke(1.dp, MaterialTheme.colorScheme.error)

internal fun simPickerTitle(sim: ClientSim): String =
    sim.label.trim().takeIf { it.isNotEmpty() && it != "SIM" && it != sim.phoneLabel?.trim() }
        ?: sim.slotIndex?.takeIf { it >= 0 }?.let { "SIM ${it + 1}" }
        ?: "SIM"

internal fun simPickerDisplayOrder(sims: List<ClientSim>, networkAvailable: Boolean): List<ClientSim> =
    if (networkAvailable) sims.sortedByDescending { it.online } else sims.toList()

/** SIM chips. Green dot = the gateway for that number is online. */
@Composable
/** [allLabel] 非空时在最前面多一个「全部」选项，选中时回调 `""`（全部通话用，不按 SIM 过滤）。 */
internal fun ClientSimPicker(
    sims: List<ClientSim>,
    selectedId: String,
    enabled: Boolean = true,
    allLabel: String? = null,
    /** S67: per-SIM unread count shown at the chip's top-end corner. */
    badges: Map<String, Int> = emptyMap(),
    onSelect: (String) -> Unit,
) {
    val networkAvailable = LocalNetworkAvailable.current
    val haptic = LocalHapticFeedback.current
    if (sims.isEmpty()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Filled.SimCard, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("没有已分配的 SIM", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = ScreenPadding, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        allLabel?.let {
            FilterChip(
                selected = selectedId.isBlank(),
                onClick = { haptic.performHapticFeedback(HapticFeedbackType.VirtualKey); onSelect("") },
                enabled = enabled,
                modifier = Modifier.heightIn(min = TouchTarget).testTag("sim.picker.all"),
                shape = CircleShape,
                label = { Text(it, style = MaterialTheme.typography.labelLarge) },
            )
        }
        simPickerDisplayOrder(sims, networkAvailable).forEach { sim ->
            val selected = selectedId == sim.id
            val accent = simColor(sim, sims)
            val onAccent = simOnColor()
            BadgedBox(badge = { CountBadge(badges[sim.id] ?: 0) }) {
            FilterChip(
                selected = selected,
                onClick = { haptic.performHapticFeedback(HapticFeedbackType.VirtualKey); onSelect(sim.id) },
                enabled = enabled,
                modifier = Modifier.heightIn(min = TouchTarget).testTag("sim.picker.${sim.id}"),
                shape = CircleShape,
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = accent,
                    selectedLabelColor = onAccent,
                    selectedLeadingIconColor = onAccent,
                ),
                leadingIcon = {
                    Box(
                        Modifier.size(8.dp).background(
                            if (networkAvailable && sim.online) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.outline,
                            CircleShape,
                        ),
                    )
                },
                label = {
                    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(simPickerTitle(sim), style = MaterialTheme.typography.labelLarge, color = if (selected) Color.Unspecified else accent)
                            simAnswerModeBadge(sim.answerMode)?.let { badge ->
                                Text(
                                    badge,
                                    style = MaterialTheme.typography.labelSmall,
                                    modifier = Modifier.border(1.dp, LocalContentColor.current.copy(alpha = 0.5f), CircleShape).padding(horizontal = 6.dp, vertical = 1.dp),
                                )
                            }
                        }
                        Text(
                            listOfNotNull(sim.phoneLabel, simConnectionLabel(networkAvailable, sim.online)).joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                },
            )
            }
        }
    }
}

/** S67 red count badge; nothing for 0, `99+` above 99, read aloud as「N 条未读」. */
@Composable
internal fun CountBadge(count: Int) {
    val label = badgeLabel(count) ?: return
    Badge(Modifier.semantics { contentDescription = "$count 条未读" }) { Text(label) }
}

/**
 * 「点空白处收键盘」。
 *
 * S30 用户报的 bug：除了拨号页和短信会话页各自写过一份，其余每一个屏幕（包括登录页）点输入框以外的
 * 地方键盘都不收。这里把那段手势收成一个 modifier，贴在 [MainActivity] 最外层的 Box 上就覆盖登录页
 * 和 Workspace 的全部五个 tab；对话框和底部弹层活在各自的窗口里，命中测试到不了根 Box，所以那四个
 * 带输入框的弹层要各自再贴一次。
 *
 * 为什么不会吃掉按钮的点击：[detectTapGestures] 在按下时就消费事件，子节点（`clickable`、
 * `TextField`）比父节点先拿到 Main pass，于是父节点的 `awaitFirstDown(requireUnconsumed = true)`
 * 根本等不到那一下。滚动同理 —— 拖动被滚动容器消费，不构成 tap。拨号页与短信会话页里原有的两份
 * 局部处理保持原样：重复一次无害，删掉反而要证明根节点在那两处也一定生效。
 */
@Composable
internal fun Modifier.dismissKeyboardOnTapOutside(): Modifier {
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    return this.pointerInput(Unit) {
        detectTapGestures { focus.clearFocus(); keyboard?.hide() }
    }
}

// S30：号码胶囊底下那条「按 <时区> 统计 · PX-xxxxxxxx · 在线 + 设备：PX-…」的横条（原
// `CurrentLineBanner`）整条撤掉。胶囊自己已经写着号码和在线状态（S64 起胶囊不再带 PX/DJI 短号，设备身份
// 只在 设置 → SIM 与接听模式 里显示），这一条只是把同样的信息
// 再说一遍，还把设备 id 顶到了列表上方。报告列表里那句「按 <时区> 的自然日统计 …」不在此列，保留。

/** SIM identity detail, shown next to the number picker when composing a new SMS. */
@Composable
internal fun SimIdentityCard(sim: ClientSim) {
    val networkAvailable = LocalNetworkAvailable.current
    ItemCard(
        sim.displayLabel,
        listOfNotNull(
            sim.slotIndex?.let { "SIM ${it + 1}" },
            sim.countryIso,
            when (sim.embedded) { true -> "eSIM"; false -> "实体 SIM"; null -> null },
        ).joinToString(" · "),
    ) {
        Text(sim.gatewayFullLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            simConnectionLabel(networkAvailable, sim.online),
            color = if (networkAvailable && sim.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Pull-to-refresh wrapper (iOS `.refreshable` parity, R4 Part B must-fix). Kept in one place so the
 * 记录 and 通讯录 tabs cannot drift apart, and so the Material dependency is swapped once if it moves.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PullToRefresh(
    refreshing: Boolean,
    onRefresh: () -> Unit,
    // S28: 列表下面多了一条分页条，所以调用方要能把它压成 `weight(1f)` 而不是整屏。
    modifier: Modifier = Modifier.fillMaxSize(),
    content: @Composable () -> Unit,
) {
    val networkAvailable = LocalNetworkAvailable.current
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { if (networkAvailable) onRefresh() },
        modifier = modifier,
    ) { content() }
}

/**
 * S28 记录页分页条。三条列表（全部通话 / 报告 / 拦截记录）共用一条，钉在列表下面、导航栏上面：
 * 上一页 / 第 n / m 页（点开可跳页）/ 下一页 / 每页条数，全部 ≥ 48 dp。
 *
 * 旧 Control 没有分页信封（[Page.supported] 为 false），整条不出现——见 [RecordsPagingPolicy.pagerVisible]。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PagerBar(
    page: Int,
    pageSize: Int,
    total: Int,
    totalPages: Int,
    onPage: (Int) -> Unit,
    onPageSize: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    var jumping by rememberSaveable { mutableStateOf(false) }
    var pickingSize by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            "共 $total 条",
            Modifier.padding(start = ScreenPadding, end = ScreenPadding, top = 6.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FlowRow(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            IconButton(
                onClick = { onPage(page - 1) },
                enabled = LocalNetworkAvailable.current && page > 1,
                modifier = Modifier.size(TouchTarget),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "上一页")
            }
            TextButton(onClick = { jumping = true }, enabled = LocalNetworkAvailable.current, modifier = Modifier.heightIn(min = TouchTarget)) {
                Text("第 $page / $totalPages 页")
            }
            IconButton(
                onClick = { onPage(page + 1) },
                enabled = LocalNetworkAvailable.current && page < totalPages,
                modifier = Modifier.size(TouchTarget),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = "下一页")
            }
            Box {
                TextButton(onClick = { pickingSize = true }, enabled = LocalNetworkAvailable.current, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Text("每页 $pageSize 条")
                }
                DropdownMenu(expanded = pickingSize, onDismissRequest = { pickingSize = false }) {
                    RecordsPagingPolicy.PAGE_SIZES.forEach { size ->
                        DropdownMenuItem(
                            enabled = LocalNetworkAvailable.current,
                            text = { Text("每页 $size 条") },
                            onClick = {
                                pickingSize = false
                                if (size != pageSize) onPageSize(size)
                            },
                            modifier = Modifier.heightIn(min = TouchTarget),
                        )
                    }
                }
            }
        }
    }
    if (jumping) PagerJumpDialog(
        page = page,
        totalPages = totalPages,
        onDismiss = { jumping = false },
        onConfirm = {
            jumping = false
            onPage(it)
        },
    )
}

/** 「跳转到」：空输入不提交，越界的页码夹回 1..totalPages（服务端不会替客户端夹）。 */
@Composable
private fun PagerJumpDialog(page: Int, totalPages: Int, onDismiss: () -> Unit, onConfirm: (Int) -> Unit) {
    var text by rememberSaveable(page) { mutableStateOf(page.toString()) }
    val target = text.trim().toIntOrNull()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("跳转到") },
        text = {
            // S30：对话框自成一个窗口，根 Box 的「点空白处收键盘」够不着，这里自己贴一次。
            Column(Modifier.dismissKeyboardOnTapOutside(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { value -> text = value.filter(Char::isDigit).take(6) },
                    label = { Text("页码") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                Text(
                    "共 $totalPages 页",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { target?.let { onConfirm(RecordsPagingPolicy.clampPage(it, totalPages)) } },
                enabled = LocalNetworkAvailable.current && target != null,
                modifier = Modifier.heightIn(min = TouchTarget),
            ) { Text("确定") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = TouchTarget)) { Text("取消") }
        },
    )
}

@Preview(name = "分页条 第 3/7 页", showBackground = true)
@Composable
private fun PagerBarPreview() {
    VoDogTheme {
        PagerBar(page = 3, pageSize = 100, total = 640, totalPages = 7, onPage = {}, onPageSize = {})
    }
}

@Composable
internal fun HistoryCallActions(onTranscript: () -> Unit, onRecording: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = onTranscript, enabled = LocalNetworkAvailable.current, modifier = Modifier.heightIn(min = TouchTarget)) { Text("查看转录") }
        TextButton(onClick = onRecording, enabled = LocalNetworkAvailable.current, modifier = Modifier.heightIn(min = TouchTarget)) { Text("查看录音") }
    }
}

@Composable
internal fun RecordingDownloadButton(enabled: Boolean, busy: Boolean, label: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = Modifier.heightIn(min = TouchTarget),
    ) {
        Icon(Icons.Filled.Download, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text(if (busy) "正在保存…" else label)
    }
}

@Composable
internal fun ItemCard(title: String, subtitle: String, action: (@Composable () -> Unit)? = null) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.fillMaxWidth().padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title.ifBlank { "未提供标题" }, style = MaterialTheme.typography.titleMedium)
            Text(subtitle.ifBlank { "暂无详情" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            action?.invoke()
        }
    }
}

@Composable
internal fun RemoteStateText(state: RemoteList) = Text(
    when (state) {
        RemoteList.NotLoaded -> "尚未加载"
        RemoteList.Loading -> "正在加载…"
        is RemoteList.Failed -> "加载失败：${state.message}"
        is RemoteList.Loaded -> "共 ${state.items.size} 条"
    },
    color = MaterialTheme.colorScheme.onSurfaceVariant,
)

/**
 * Error banner. Long messages use errorContainer/onErrorContainer rather than raw `error` as a text
 * colour: the saturated red reads as a destructive *control*, but as body text on a dark surface it
 * sits below the 4.5:1 contrast floor.
 */
@Composable
internal fun MessageCard(message: String) = Card(
    Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
) {
    Row(
        Modifier.padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Filled.Warning, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onErrorContainer)
        Text(message, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
    }
}

/** Green confirmation line (iOS `checkmark.circle.fill` status row). */
@Composable
internal fun StatusLine(message: String) = Row(
    Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
) {
    Icon(Icons.Filled.CheckCircle, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.tertiary)
    Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
}

@Composable
internal fun LoadingRow(label: String) = Row(
    Modifier.fillMaxWidth().heightIn(min = TouchTarget),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
) {
    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
internal fun LoadingPage(label: String) = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator()
        Text(label, Modifier.padding(top = 12.dp))
    }
}

/** Monospaced phone number, used for every remote number in the app. */
@Composable
internal fun PhoneNumberText(
    number: String,
    modifier: Modifier = Modifier,
    color: androidx.compose.ui.graphics.Color = androidx.compose.ui.graphics.Color.Unspecified,
) = Text(
    number,
    modifier = modifier,
    style = MaterialTheme.typography.titleMedium,
    fontFamily = FontFamily.Monospace,
    color = color,
)
