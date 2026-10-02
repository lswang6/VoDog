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

/**
 * S21 §F 记录详情页 — opened by tapping a 记录 row. Top: 拨打 / 短信 / 信息(i). Middle: the call's own
 * facts, then the existing 查看转录 / 查看录音 sheets unchanged. Bottom: an "AI 对话" group whenever
 * `GET /calls/:id/ai-transcript` has anything to show.
 */
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
    LaunchedEffect(callId, state.networkAvailable) {
        if (state.networkAvailable && callId.isNotBlank()) model.loadAiTranscript(callId)
    }
    LazyColumn(
        Modifier.fillMaxSize().testTag("history.detail.$callId"),
        contentPadding = PaddingValues(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack, modifier = Modifier.size(TouchTarget)) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回记录")
                }
                Column(Modifier.weight(1f)) {
                    Text(phoneNumberTitle(callTitle(call)), style = MaterialTheme.typography.titleLarge)
                    Text(
                        listOf(item.sim.label, directionLabel(item.direction), callStateLabel(call.optString("state")))
                            .joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
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
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = { model.openCallDetail(call, HistoryViewerKind.TRANSCRIPT) },
                    enabled = state.networkAvailable,
                    modifier = Modifier.weight(1f).heightIn(min = TouchTarget),
                ) { Text("查看转录") }
                OutlinedButton(
                    onClick = { model.openCallDetail(call, HistoryViewerKind.RECORDING) },
                    enabled = state.networkAvailable,
                    modifier = Modifier.weight(1f).heightIn(min = TouchTarget),
                ) { Text("查看录音") }
            }
        }
        val aiSegments = (aiTranscript as? RemoteResource.Loaded)?.value.orEmpty()
        if (!state.networkAvailable && aiTranscript !is RemoteResource.Loaded) item {
            Text("AI 对话未加载，联网后读取", Modifier.testTag("history.detail.offline"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (aiTranscript is RemoteResource.Loading) item { LoadingRow("正在读取 AI 对话…") }
        if (aiSegments.isNotEmpty()) {
            item { InlineSectionHeader("AI 对话") }
            item { AiTranscriptCard(aiSegments) }
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
        Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Filled.SmartToy, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.tertiary)
                Text(
                    "AI 实时转写（与录音转录分开保存）",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            segments.forEach { segment ->
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(
                        listOfNotNull(
                            aiTranscriptRoleLabel(segment.role),
                            segment.at?.let(::displayDateTime),
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(segment.text, style = MaterialTheme.typography.bodyMedium)
                }
            }
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
        FilledTonalButton(
            onClick = onDial,
            enabled = LocalNetworkAvailable.current && dialable,
            modifier = slot.then(buttonModifier).heightIn(min = 52.dp).testTag("history.detail.dial"),
        ) {
            Icon(Icons.Filled.Call, null)
            Spacer(Modifier.width(6.dp))
            Text("拨打")
        }
        FilledTonalButton(
            onClick = onSms,
            enabled = dialable,
            modifier = slot.then(buttonModifier).heightIn(min = 52.dp).testTag("history.detail.smsDraft"),
        ) {
            Icon(Icons.AutoMirrored.Filled.Message, null)
            Spacer(Modifier.width(6.dp))
            Text("短信")
        }
        OutlinedButton(
            onClick = onInfo,
            modifier = slot.then(buttonModifier).heightIn(min = 52.dp),
        ) {
            Icon(Icons.Outlined.Info, null)
            Spacer(Modifier.width(6.dp))
            Text("信息")
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
