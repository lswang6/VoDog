package org.vodog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

/**
 * S21 §F 记录详情页 — opened by tapping a 记录 row. Top: 拨打 / 短信 / 信息(i). Middle: the call's own
 * facts, then the existing 查看转录 / 查看录音 sheets unchanged. Bottom: an "AI 对话" group whenever
 * `GET /calls/:id/ai-transcript` has anything to show.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun HistoryDetailPage(
    call: JSONObject,
    sim: JSONObject?,
    state: ClientUiState,
    model: ClientViewModel,
    onBack: () -> Unit,
) {
    val callId = call.optString("id")
    val item = parseCallHistoryItem(call, sim)
    val annotation = call.toContactAnnotation()
    val number = call.optString("remoteNumber")
    val aiTranscript = state.aiTranscripts[callId]
    val detail = state.callDetail?.takeIf { it.item.callId == callId }
    val sims = (state.sims as? RemoteList.Loaded)?.items.orEmpty().mapNotNull { runCatching { it.toClientSim() }.getOrNull() }
    LaunchedEffect(callId, state.networkAvailable) {
        if (state.networkAvailable && callId.isNotBlank()) model.loadAiTranscript(callId)
    }
    LazyColumn(
        Modifier.fillMaxSize().testTag("history.detail.$callId"),
        contentPadding = PaddingValues(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Signal single-line top bar: back · 通话详情 · more.
            var menu by remember { mutableStateOf(false) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack, modifier = Modifier.size(TouchTarget)) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回记录")
                }
                Text("通话详情", Modifier.weight(1f).padding(start = 8.dp), style = MaterialTheme.typography.titleLarge, maxLines = 1)
                Box {
                    IconButton(onClick = { menu = true }, modifier = Modifier.size(TouchTarget)) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "更多")
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("联系人卡片") }, onClick = { menu = false; model.openContactCard(callContactCardTarget(call)) })
                        DropdownMenuItem(text = { Text("查看转录") }, enabled = state.networkAvailable,
                            onClick = { menu = false; model.openCallDetail(call, HistoryViewerKind.TRANSCRIPT) })
                        DropdownMenuItem(text = { Text("查看录音") }, enabled = state.networkAvailable,
                            onClick = { menu = false; model.openCallDetail(call, HistoryViewerKind.RECORDING) })
                    }
                }
            }
        }
        item {
            val signal = LocalSignal.current
            val title = callTitle(call)
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Box(Modifier.size(56.dp).background(signal.surface3, CircleShape), contentAlignment = Alignment.Center) {
                        val initial = title.trim().firstOrNull()
                        if (initial == null || initial.isDigit() || initial == '+') Icon(Icons.Filled.Call, null, tint = signal.ink2)
                        else Text(initial.toString(), style = MaterialTheme.typography.titleLarge, color = signal.ink2)
                    }
                    Column(Modifier.weight(1f)) {
                        Text(phoneNumberTitle(item.contactName ?: title), style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
                        if (item.contactName != null && number.isNotBlank()) {
                            Text(number, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace, color = signal.ink3)
                        }
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val tag = Modifier.heightIn(min = 32.dp)
                    Row(tag.background(signal.surface2, MaterialTheme.shapes.extraSmall).padding(horizontal = 10.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        sims.firstOrNull { it.id == item.sim.id }?.let { LineBlock(simColor(it, sims)) }
                        Text(item.sim.label, style = MaterialTheme.typography.bodyMedium, color = signal.ink2)
                    }
                    if (item.answeredByPlatform == "ai" || call.optString("conflictDisposition") == "ai_answered") {
                        Box(tag.background(signal.aiSoft, MaterialTheme.shapes.extraSmall).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                            Text("AI 代接", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = signal.ai)
                        }
                    }
                    Box(tag, contentAlignment = Alignment.Center) {
                        Text(
                            listOfNotNull(
                                directionLabel(item.direction),
                                formatGatewayDateTime(item.startedAt, item.gatewayTimeZone),
                                talkDurationShortLabel(item.answeredAt, item.endedAt),
                            ).joinToString(" · "),
                            style = MaterialTheme.typography.bodyMedium,
                            color = signal.ink3,
                        )
                    }
                }
            }
        }
        if (annotation.blocked) item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Filled.Block, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
                Text("这个号码已被屏蔽", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
        item {
            CallDetailActionRow(
                number = number,
                // S36 C5-b: the record knows which SIM took the call, so the confirmation names it.
                onDial = { model.requestDial(number, call.optString("simId").takeIf(String::isNotBlank)) },
                onSms = { model.requestSms(number) },
                onInfo = { model.openContactCard(callContactCardTarget(call)) },
            )
        }
        item {
            // Signal recording card. Playback, source switch and download stay in the existing sheet
            // (it owns manifest loading); no waveform — there is no decoded amplitude data here.
            val signal = LocalSignal.current
            SignalCard("通话录音") {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Surface(
                        onClick = { model.openCallDetail(call, HistoryViewerKind.RECORDING) },
                        enabled = state.networkAvailable,
                        shape = RoundedCornerShape(16.dp),
                        color = signal.brand,
                        contentColor = signal.onBrand,
                        modifier = Modifier.size(56.dp).testTag("history.detail.recording"),
                    ) {
                        Box(contentAlignment = Alignment.Center) { Icon(Icons.Filled.PlayArrow, contentDescription = "查看录音", Modifier.size(30.dp)) }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        LinearProgressIndicator(
                            progress = { 0f },
                            modifier = Modifier.fillMaxWidth().height(6.dp),
                            trackColor = signal.surface3,
                            drawStopIndicator = {},
                        )
                        Text(
                            listOfNotNull(recordingStatusLabel(item.recordingStatus), talkDurationShortLabel(item.answeredAt, item.endedAt))
                                .joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = signal.ink3,
                        )
                    }
                }
            }
        }
        val aiSegments = (aiTranscript as? RemoteResource.Loaded)?.value.orEmpty()
        if (!state.networkAvailable && aiTranscript !is RemoteResource.Loaded) item {
            Text("AI 对话未加载，联网后读取", Modifier.testTag("history.detail.offline"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (aiTranscript is RemoteResource.Loading) item { LoadingRow("正在读取 AI 对话…") }
        item {
            SignalCard("转录") {
                if (aiSegments.isNotEmpty()) AiTranscriptLines(aiSegments)
                FilledTonalButton(
                    onClick = { model.openCallDetail(call, HistoryViewerKind.TRANSCRIPT) },
                    enabled = state.networkAvailable,
                    modifier = Modifier.heightIn(min = TouchTarget),
                ) { Text("查看录音转录") }
            }
        }
        item {
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    DetailFact("号码", callTitle(call))
                    DetailFact("号码线路", item.sim.label)
                    DetailFact("方向", directionLabel(item.direction))
                    DetailFact("状态", callStateLabel(call.optString("state")))
                    DetailFact("开始", formatGatewayDateTime(item.startedAt, item.gatewayTimeZone))
                    item.answeredAt?.let { DetailFact("接通", formatGatewayDateTime(it, item.gatewayTimeZone)) }
                    item.endedAt?.let { DetailFact("结束", formatGatewayDateTime(it, item.gatewayTimeZone)) }
                    talkDurationShortLabel(item.answeredAt, item.endedAt)?.let { DetailFact("通话时长", it) }
                    DetailFact("录音", recordingStatusLabel(item.recordingStatus))
                    item.internalTitle?.let { DetailFact("内部通话", it.removePrefix("内部通话 ")) }
                    if (item.answeredByPlatform == "device") DetailFact("接听方", "网关本机")
                    if (isPixelOriginatedCall(call)) DetailFact("拨打方式", call.gatewayKind().directDialLabel)
                    if (call.optString("conflictDisposition") == "ai_answered") DetailFact("接听方式", "忙线 AI 代接")
                    blockedCallSourceLabel(call)?.let { DetailFact("拦截来源", it) }
                    failureReasonLabel(call.optString("failureReason"))?.let {
                        DetailFact("失败原因", it)
                    }
                }
            }
        }

    }
    if (detail?.viewer == HistoryViewerKind.TRANSCRIPT) TranscriptSheet(detail, model, model::closeReportCall)
    if (detail?.viewer == HistoryViewerKind.RECORDING) RecordingSheet(detail, model, model::closeReportCall)
}

/**
 * The AI conversation of one call. Shared by 记录详情 and the report card's "AI 对话" sheet, so both
 * render the same thing: `ai_run_transcripts` is a second record kept apart from the recording
 * transcript, and the caption says so.
 */
@Composable
internal fun AiTranscriptCard(segments: List<ClientAiTranscriptSegment>) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(8.dp)) { AiTranscriptLines(segments) }
    }
}

/** Speaker-colored lines: AI in `ai`, the other side in ink; times monospaced (S92). */
@Composable
private fun AiTranscriptLines(segments: List<ClientAiTranscriptSegment>) {
    val signal = LocalSignal.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.Filled.SmartToy, null, Modifier.size(18.dp), tint = signal.ai)
        Text(
            "AI 实时转写（与录音转录分开保存）",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    segments.forEach { segment ->
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.widthIn(min = 44.dp)) {
                Text(
                    aiTranscriptRoleLabel(segment.role),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (segment.role == "ai") signal.ai else signal.ink,
                )
                segment.at?.let {
                    Text(displayDateTime(it).takeLast(5), style = MaterialTheme.typography.labelSmall,
                        fontFamily = FontFamily.Monospace, color = signal.ink3)
                }
            }
            Text(segment.text, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
        }
    }
}

/** Signal surface card with a 17 Semibold section title. */
@Composable
private fun SignalCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

/** 拨打 / 短信 / 信息 — the §F "2.2" row; 信息 always opens the contact card. */
@Composable
internal fun CallDetailActionRow(
    number: String,
    onDial: () -> Unit,
    onSms: () -> Unit,
    onInfo: () -> Unit,
) {
    val dialable = dialableNumber(number)
    // S92: at large font scales three side-by-side buttons wrapped one character per line; stack them
    // as full-width rows instead. Default scales keep the original row.
    val stacked = isLargeFontScale(LocalDensity.current.fontScale)
    val buttonModifier = if (stacked) Modifier.fillMaxWidth() else Modifier
    val buttons: @Composable (Modifier) -> Unit = { slot ->
        val signal = LocalSignal.current
        FilledTonalButton(
            onClick = onDial,
            enabled = LocalNetworkAvailable.current && dialable,
            modifier = slot.then(buttonModifier).heightIn(min = 52.dp).testTag("history.detail.dial"),
            colors = ButtonDefaults.filledTonalButtonColors(containerColor = signal.callSoft, contentColor = signal.call),
        ) {
            Icon(Icons.Filled.Call, null)
            Spacer(Modifier.width(6.dp))
            Text("回拨", maxLines = 1, softWrap = false)
        }
        FilledTonalButton(
            onClick = onSms,
            enabled = dialable,
            modifier = slot.then(buttonModifier).heightIn(min = 52.dp).testTag("history.detail.smsDraft"),
            colors = ButtonDefaults.filledTonalButtonColors(containerColor = signal.surface2, contentColor = signal.ink),
        ) {
            Icon(Icons.AutoMirrored.Filled.Message, null)
            Spacer(Modifier.width(6.dp))
            Text("短信", maxLines = 1, softWrap = false)
        }
        FilledTonalButton(
            onClick = onInfo,
            modifier = slot.then(buttonModifier).heightIn(min = 52.dp),
            colors = ButtonDefaults.filledTonalButtonColors(containerColor = signal.surface2, contentColor = signal.ink),
        ) {
            Icon(Icons.Outlined.Person, null)
            Spacer(Modifier.width(6.dp))
            Text("联系人", maxLines = 1, softWrap = false)
        }
    }
    if (stacked) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) { buttons(Modifier) }
    } else {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) { buttons(Modifier.weight(1f)) }
    }
}

@Composable
private fun DetailFact(label: String, value: String) {
    // S92: the 84 dp label column wrapped 号码线路 / 通话时长 at large font scales; there the label
    // sits above its value instead.
    if (isLargeFontScale(LocalDensity.current.fontScale)) {
        Column(Modifier.fillMaxWidth()) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.bodyMedium)
        }
        return
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(
            label,
            Modifier.width(84.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * S21 §B 拦截记录 — calls rejected by the gateway's local blocklist and SMS that never reached the
 * inbox. Tapping a row opens the same contact card, where 解除屏蔽 lives.
 */
@Composable
internal fun InterceptionList(state: ClientUiState, model: ClientViewModel) {
    val page = (state.interceptionsPage as? RemoteResource.Loaded)?.value
    val items = page?.items.orEmpty().mapNotNull { runCatching { it.toClientInterception() }.getOrNull() }
    val sims = (state.sims as? RemoteList.Loaded)?.items.orEmpty().mapNotNull {
        runCatching { it.toClientSim() }.getOrNull()
    }.associateBy(ClientSim::id)
    LaunchedEffect(state.session?.username, state.networkAvailable) {
        if (state.session != null && state.networkAvailable) model.refreshInterceptions()
    }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(ScreenPadding),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when (val loaded = state.interceptionsPage) {
                RemoteResource.NotLoaded, RemoteResource.Loading -> item {
                    if (state.networkAvailable) LoadingRow("正在读取拦截记录…")
                    else Text("拦截记录未加载，联网后读取", Modifier.testTag("interceptions.offline"))
                }
                is RemoteResource.Failed -> item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        MessageCard("拦截记录读取失败：${loaded.message}")
                        OutlinedButton(
                            onClick = model::refreshInterceptions,
                            enabled = state.networkAvailable,
                            modifier = Modifier.heightIn(min = TouchTarget).testTag("interceptions.retry"),
                        ) { Text("重试") }
                    }
                }
                is RemoteResource.Loaded -> if (items.isEmpty()) item {
                    EmptyStateCard(Icons.Filled.Block, "暂无拦截记录", "屏蔽号码后，被拒接的来电和被拦下的短信会出现在这里。")
                } else items(items, key = ClientInterception::id) { interception ->
                    InterceptionRow(interception, sims[interception.simId]) {
                        model.openContactCard(interceptionContactCardTarget(interception))
                    }
                }
            }
        }
        page?.takeIf(RecordsPagingPolicy::pagerVisible)?.let {
            PagerBar(
                page = it.page,
                pageSize = it.pageSize,
                total = it.total,
                totalPages = it.totalPages,
                onPage = model::setInterceptionsPage,
                onPageSize = model::setInterceptionsPageSize,
            )
        }
    }
}

@Composable
private fun InterceptionRow(item: ClientInterception, sim: ClientSim?, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().testTag("interception.row.${item.id}"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(
                    if (item.kind == "sms") Icons.AutoMirrored.Filled.Message else Icons.Filled.Block,
                    contentDescription = interceptionKindLabel(item.kind),
                    tint = MaterialTheme.colorScheme.error,
                )
                Column(Modifier.weight(1f)) {
                    PhoneNumberText(numberWithContactName(item.remoteNumber, item.contactName))
                    Text(
                        listOfNotNull(
                            interceptionKindLabel(item.kind),
                            interceptionSimDisplayLabel(item, sim),
                            formatGatewayDateTime(item.occurredAt, interceptionGatewayTimeZone(item, sim)),
                            // S38: 手机自动拦截 happens before the gateway ever sees the call.
                            interceptionSourceLabel(item.source),
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            item.bodyPreview?.takeIf(String::isNotBlank)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Text("点按查看联系人卡片并可解除屏蔽", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

internal fun interceptionSimDisplayLabel(item: ClientInterception, sim: ClientSim?): String =
    item.simLabel?.takeIf(String::isNotBlank) ?: sim?.displayLabel ?: "号码已移除"

internal fun interceptionGatewayTimeZone(item: ClientInterception, sim: ClientSim?): String =
    gatewayDisplayTimeZone(item.gatewayTimeZone, sim?.timeZone)
