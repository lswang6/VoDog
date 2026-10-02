package org.vodog

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.automirrored.filled.CallReceived
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDateRangePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LifecycleStartEffect
import kotlinx.coroutines.launch
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

/**
 * S22 决策 10: the 记录 tab is three segments, not two. 全部通话 and 报告 used to share one scroll —
 * the period picker, the report cards and the call list stacked in a single LazyColumn — which meant
 * neither could have its own search box and the report window silently governed a list it did not
 * filter. Each segment is now its own list with its own controls; 拦截记录 is unchanged.
 */
internal enum class HistoryView(val label: String) {
    ALL_CALLS("全部通话"),
    REPORTS("报告"),
    INTERCEPTIONS("拦截记录"),
}

@Composable
internal fun HistoryPage(state: ClientUiState, model: ClientViewModel, onDetailVisible: (Boolean) -> Unit) {
    val sims = (state.sims as? RemoteList.Loaded)?.items.orEmpty().mapNotNull {
        runCatching { it.toClientSim() }.getOrNull()
    }
    val simJsonById = (state.sims as? RemoteList.Loaded)?.items.orEmpty().associateBy { it.optString("id") }
    var selectedId by rememberSaveable(sims.map(ClientSim::id)) {
        mutableStateOf(state.reportSimId.ifBlank { sims.firstOrNull()?.id.orEmpty() })
    }
    // 全部通话有自己的 SIM 过滤，默认 "" = 全部 SIM；恢复 VM 里的选择，但那张 SIM 已不在就回到全部。
    var callsFilterId by rememberSaveable(sims.map(ClientSim::id)) {
        mutableStateOf(state.callsSimId.takeIf { id -> sims.any { it.id == id } }.orEmpty())
    }
    val selected = sims.singleOrNull { it.id == selectedId }
    val reportZone = gatewayDisplayTimeZone(selected?.timeZone)
    LaunchedEffect(state.session?.username, selectedId, reportZone, state.networkAvailable) {
        if (state.networkAvailable && state.session != null &&
            (state.reports is RemoteResource.NotLoaded ||
                state.reportTimeZone != reportZone ||
                state.reportSimId != selectedId)
        ) {
            model.loadReports(timeZone = reportZone, simId = selectedId, page = 1)
        }
    }
    // S28: 全部通话不再读拨号页轮询的 `state.calls`，而是自己拿一页（SIM 过滤也交给服务端）。第一次
    // 进来或换了 SIM 才请求，来回切底部 Tab 不会每次都重拉。
    LaunchedEffect(state.session?.username, callsFilterId, state.networkAvailable) {
        if (state.networkAvailable && state.session != null &&
            (state.callsPage is RemoteResource.NotLoaded || state.callsSimId != callsFilterId)
        ) {
            model.loadCallsPage(simId = callsFilterId, page = 1)
        }
    }
    val detail = state.callDetail
    val callsPage = (state.callsPage as? RemoteResource.Loaded)?.value
    // 旧 Control 忽略 `simId` 并回没有信封的老结果，这时退回 S22 的客户端过滤，换 SIM 才不会没反应。
    val calls = hideMergedInternalLegs(callsPage?.let { page ->
        if (page.supported) page.items
        else page.items.filter { callsFilterId.isBlank() || it.optString("simId") == callsFilterId }
    }.orEmpty())
    var view by rememberSaveable { mutableStateOf(HistoryView.ALL_CALLS) }
    val refreshScope = when (view) {
        HistoryView.ALL_CALLS -> ClientRefreshScope.HISTORY_CALLS
        HistoryView.REPORTS -> ClientRefreshScope.HISTORY_REPORTS
        HistoryView.INTERCEPTIONS -> ClientRefreshScope.HISTORY_INTERCEPTIONS
    }
    LifecycleStartEffect(refreshScope) {
        model.startForegroundRefresh(refreshScope)
        onStopOrDispose { model.stopForegroundRefresh(refreshScope) }
    }
    val openedCall = state.openedHistoryCall
    LaunchedEffect(openedCall != null) { onDetailVisible(openedCall != null) }
    if (openedCall != null) {
        BackHandler { model.closeHistoryRecord() }
        HistoryDetailPage(
            call = openedCall,
            sim = simJsonById[openedCall.optString("simId")],
            state = state,
            model = model,
            onBack = model::closeHistoryRecord,
        )
        return
    }
    Column(Modifier.fillMaxSize()) {
        // S30：胶囊下面原来还有一条 `CurrentLineBanner`，把号码 / PX 短号 / 在线状态再说一遍。胶囊
        // 本身已经写着这些，所以整条撤掉；`reportZone` 仍然决定报告窗口按哪个时区切自然日。
        if (view == HistoryView.INTERCEPTIONS) {
            Text(
                "范围：全部号码",
                modifier = Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 8.dp)
                    .testTag("history.interceptions.scope"),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else if (view == HistoryView.ALL_CALLS) {
            ClientSimPicker(sims, callsFilterId, enabled = state.networkAvailable, allLabel = "全部 SIM", badges = state.badges?.simTotal().orEmpty()) { callsFilterId = it }
        } else {
            ClientSimPicker(sims, selectedId, enabled = state.networkAvailable, badges = state.badges?.simTotal().orEmpty()) { selectedId = it }
        }
        // S92: at large font scales 拦截记录 wrapped to two lines. There the checkmark goes, the padding
        // shrinks and the label stays on one line, shrinking to fit; default scales are unchanged.
        val largeFont = isLargeFontScale(LocalDensity.current.fontScale)
        SingleChoiceSegmentedButtonRow(
            Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 6.dp).heightIn(min = TouchTarget),
        ) {
            HistoryView.entries.forEachIndexed { index, entry ->
                SegmentedButton(
                    selected = view == entry,
                    onClick = { view = entry },
                    shape = SegmentedButtonDefaults.itemShape(index, HistoryView.entries.size),
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("history.view.${entry.name.lowercase()}"),
                    icon = if (largeFont) ({}) else ({ SegmentedButtonDefaults.Icon(view == entry) }),
                    contentPadding = if (largeFont) PaddingValues(horizontal = 4.dp) else SegmentedButtonDefaults.ContentPadding,
                ) {
                    if (largeFont) {
                        Text(
                            entry.label,
                            maxLines = 1,
                            softWrap = false,
                            autoSize = TextAutoSize.StepBased(minFontSize = 10.sp, maxFontSize = LocalTextStyle.current.fontSize),
                        )
                    } else {
                        Text(entry.label)
                    }
                }
            }
        }
        when (view) {
            HistoryView.ALL_CALLS -> AllCallsList(
                callsPage = state.callsPage,
                refreshing = state.callsPageRefreshing,
                query = state.callQuery,
                calls = calls,
                simJsonById = simJsonById,
                onQueryChange = model::setCallQuery,
                // 下拉刷新连 SIM 和短信一起重读（和 S22 一样），其中也包含当前这一页。
                onRefresh = model::refreshAll,
                onPage = model::setCallsPage,
                onPageSize = model::setCallsPageSize,
                onOpen = { callId -> calls.firstOrNull { it.optString("id") == callId }?.let(model::openHistoryRecord) },
                onContactCard = { model.openContactCard(callContactCardTarget(it)) },
                onViewer = model::openHistoryViewer,
                onDelete = model::deleteCall,
                seenCallIds = state.seenCallIds,
            )
            HistoryView.REPORTS -> ReportList(state, model, selectedId, reportZone, model::openAiTranscript)
            HistoryView.INTERCEPTIONS -> InterceptionList(state, model)
        }
    }
    if (detail?.viewer == HistoryViewerKind.TRANSCRIPT) {
        TranscriptSheet(detail, model, model::closeReportCall)
    }
    if (detail?.viewer == HistoryViewerKind.RECORDING) {
        RecordingSheet(detail, model, model::closeReportCall)
    }
    // S39 §E: 这一位在 [ClientViewModel] 里，所以前台刷新能按 ID 校验它 —— 另一端删掉这通之后浮层
    // 自己会关，而不是继续显示一份已经没有出处的对话。
    state.aiTranscriptCallId?.let { callId ->
        AiTranscriptSheet(callId, state, model, model::closeAiTranscript)
    }
}

/** 搜索姓名或号码 — the same prompt and the same debounce the 通讯录 tab uses. */
@Composable
private fun HistorySearchField(value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = LocalNetworkAvailable.current,
        modifier = Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 4.dp)
            .testTag("history.search"),
        label = { Text("搜索姓名或号码") },
        singleLine = true,
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
        trailingIcon = {
            if (value.isNotEmpty()) {
                IconButton(onClick = { onValueChange("") }, enabled = LocalNetworkAvailable.current, modifier = Modifier.size(TouchTarget)) {
                    Icon(Icons.Filled.Close, contentDescription = "清除搜索")
                }
            }
        },
    )
}

/**
 * 全部通话. S28: 这一页是服务端切的 —— 搜索词、SIM 过滤和页码都在 `GET /calls` 的 WHERE 里，所以
 * 「第 3 页」显示的就是第 3 页，而不是把一页结果再筛一遍。列表下面钉着 [PagerBar]，行本身还是 S21 §F
 * 的样子：屏蔽图标 + `号码 · 姓名` + 行尾 "i"。
 *
 * 这个 composable 不认识 ViewModel（只收数据和回调），所以 [AllCallsListPreview] 不用登录就能渲染。
 */
@Composable
private fun AllCallsList(
    callsPage: RemoteResource<Page<JSONObject>>,
    refreshing: Boolean,
    query: String,
    calls: List<JSONObject>,
    simJsonById: Map<String, JSONObject>,
    onQueryChange: (String) -> Unit,
    onRefresh: () -> Unit,
    onPage: (Int) -> Unit,
    onPageSize: (Int) -> Unit,
    onOpen: (String) -> Unit,
    onContactCard: (JSONObject) -> Unit,
    onViewer: (CallReportItem, HistoryViewerKind) -> Unit,
    onDelete: (String) -> Unit,
    seenCallIds: Set<String> = emptySet(),
) {
    val loaded = (callsPage as? RemoteResource.Loaded)?.value
    Column(Modifier.fillMaxSize()) {
        HistorySearchField(query, onQueryChange)
        // 转圈直接读 state：重读当前页时列表不会打回 Loading，请求失败也有一个明确的落点。屏幕上还
        // 没有行的时候（首次加载 / 翻页 / 改搜索词）列表里已经有一个「正在读」，不再叠一个下拉转圈。
        PullToRefresh(refreshing && loaded != null, onRefresh, Modifier.fillMaxWidth().weight(1f)) {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(ScreenPadding),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                when (callsPage) {
                    RemoteResource.NotLoaded, RemoteResource.Loading -> item {
                        LoadingRow(if (query.isBlank()) "正在读取通话记录…" else "正在搜索通话…")
                    }
                    is RemoteResource.Failed -> item {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            MessageCard("加载失败：${callsPage.message}")
                            OutlinedButton(onClick = onRefresh, enabled = LocalNetworkAvailable.current, modifier = Modifier.heightIn(min = TouchTarget)) {
                                Text("重试")
                            }
                        }
                    }
                    is RemoteResource.Loaded -> if (calls.isEmpty()) item {
                        if (query.isNotBlank()) EmptyStateCard(Icons.Filled.Search, "没有匹配的通话", "换一个姓名或号码再试。")
                        else EmptyStateCard(Icons.Filled.History, "暂无通话记录")
                    } else items(calls, key = { allCallsHistoryRowKey(it.optString("id")) }) { call ->
                        AllCallsRow(call, simJsonById[call.optString("simId")], callShowsUnseenDot(call, seenCallIds), onOpen, onContactCard, onViewer, onDelete)
                    }
                }
            }
        }
        if (loaded != null && RecordsPagingPolicy.pagerVisible(loaded)) {
            PagerBar(loaded.page, loaded.pageSize, loaded.total, loaded.totalPages, onPage, onPageSize)
        }
    }
}

/**
 * S30 §4：一行通话记录既能左滑删除，也能长按删除，两条路走同一个确认对话框。删除会连带录音、转写和
 * 报告条目，所以滑到位**不**让行消失：`onDismiss` 只负责弹对话框，然后立刻 `reset()` 把行滑回原位
 * （material3 1.4 起 `confirmValueChange` 已废弃，复位是官方留下的那条路）。确认之后才由 [onDelete]
 * 发那一条 `DELETE /calls/:id`；取消就什么都没发生过。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AllCallsRow(
    call: JSONObject,
    sim: JSONObject?,
    unseen: Boolean,
    onOpen: (String) -> Unit,
    onContactCard: (JSONObject) -> Unit,
    onViewer: (CallReportItem, HistoryViewerKind) -> Unit,
    onDelete: (String) -> Unit,
) {
    val item = parseCallHistoryItem(call, sim)
    val failed = call.optString("state") == "failed"
    // S38b: 拦截行本身就是被拦截的号码，哪怕联系人注解还没跟上。
    val blocked = call.toContactAnnotation().blocked || blockedCallSourceLabel(call) != null
    val callId = call.optString("id")
    var confirming by remember(callId) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val dismissState = rememberSwipeToDismissBoxState()
    if (confirming) {
        val confirm = callDeleteConfirm()
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(confirm.title) },
            text = { Text(confirm.message) },
            confirmButton = {
                TextButton(
                    onClick = { confirming = false; onDelete(callId) },
                    enabled = LocalNetworkAvailable.current,
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("records.delete.confirm"),
                    colors = destructiveTextColors(),
                ) { Text(confirm.confirmLabel) }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Text("取消")
                }
            },
        )
    }
    SwipeToDismissBox(
        state = dismissState,
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = callId.isNotBlank(),
        onDismiss = { direction ->
            if (direction == SwipeToDismissBoxValue.EndToStart && callId.isNotBlank()) confirming = true
            // 行不许被滑走：问过再说，所以到位之后立刻滑回原位。
            scope.launch { dismissState.reset() }
        },
        modifier = Modifier.fillMaxWidth().clip(CardDefaults.shape),
        backgroundContent = {
            Box(
                Modifier.fillMaxSize().background(MaterialTheme.colorScheme.errorContainer)
                    .testTag("records.delete"),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Row(
                    Modifier.padding(horizontal = ScreenPadding),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        Icons.Filled.Delete,
                        contentDescription = "删除通话记录",
                        tint = MaterialTheme.colorScheme.error,
                    )
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            }
        },
    ) {
        Card(
            modifier = Modifier.fillMaxWidth().clip(CardDefaults.shape).testTag("records.row").combinedClickable(
                onClick = { callId.takeIf(String::isNotBlank)?.let(onOpen) },
                // 长按是删除的第二个入口：滑动手势在有些设备上被列表抢走，长按永远在。
                onClickLabel = "打开通话详情",
                onLongClickLabel = "删除这条通话记录",
                onLongClick = { if (callId.isNotBlank()) confirming = true },
            ),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    UnreadDot(unseen, "未查看")
                    // §F: the blocked marker sits left of the direction icon, so a blocked
                    // number is visible before the row is read.
                    if (blocked) {
                        Icon(
                            Icons.Filled.Block,
                            contentDescription = "已屏蔽",
                            Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.error,
                        )
                    }
                    Icon(
                        if (call.optString("direction") == "incoming") Icons.AutoMirrored.Filled.CallReceived else Icons.AutoMirrored.Filled.CallMade,
                        contentDescription = directionLabel(call.optString("direction")),
                        tint = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    )
                    Column(Modifier.weight(1f)) {
                        // S36 C5-a: 有联系人时姓名单独一行，号码整行不截断。
                        val (rowName, rowNumber) = callRowLines(call)
                        rowName?.let {
                            Text(it, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        PhoneNumberText(
                            rowNumber,
                            color = if (rowName == null) androidx.compose.ui.graphics.Color.Unspecified
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        val missedLabel = missedCallLabel(call)
                        val missed = missedLabel != null
                        Text(
                            listOfNotNull(callLineLabel(sim), missedLabel ?: callStateLabel(call.optString("state"))).joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (missed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        // S38: 通过手机拨打 / 忙线自动拒接 / 忙线 AI 代接 — one extra line, never a new row shape.
                        s38CallBadgeLabel(call)?.takeIf { it != missedLabel }?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(
                            formatGatewayDateTime(item.startedAt, item.gatewayTimeZone),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        talkDurationLabel(item.answeredAt, item.endedAt)?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    IconButton(
                        onClick = { onContactCard(call) },
                        modifier = Modifier.size(TouchTarget),
                    ) {
                        Icon(
                            Icons.Outlined.Info,
                            contentDescription = "联系人卡片",
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                HistoryCallActions(
                    onTranscript = { onViewer(item, HistoryViewerKind.TRANSCRIPT) },
                    onRecording = { onViewer(item, HistoryViewerKind.RECORDING) },
                )
            }
        }
    }
}

/**
 * 报告. Every call inside the window has a card — S22 决策 6 removed the "only classified, only
 * non-advertising" admission rules, so the classification is a *marker* on the card now and the
 * empty state can no longer blame "没有符合报告条件的通话".
 */
@Composable
private fun ReportList(
    state: ClientUiState,
    model: ClientViewModel,
    selectedId: String,
    reportZone: String,
    onOpenAiTranscript: (String) -> Unit,
) {
    var pickingRange by remember { mutableStateOf(false) }
    val today = remember(reportZone) { reportToday(reportZone) }
    val range = state.reportRange
        ?: reportRangeFor(state.reportPreset, today)
        ?: checkNotNull(reportRangeFor(ReportRangePreset.DAYS_7, today))
    var refreshing by remember { mutableStateOf(false) }
    // `loadReports` publishes Loading synchronously, so clearing on any change would hide the
    // indicator on the very frame the pull started it.
    LaunchedEffect(state.reports) { if (state.reports !is RemoteResource.Loading) refreshing = false }
    Column(Modifier.fillMaxSize()) {
        SingleChoiceSegmentedButtonRow(
            Modifier.fillMaxWidth().padding(horizontal = ScreenPadding).heightIn(min = TouchTarget),
        ) {
            ReportRangePreset.entries.forEachIndexed { index, preset ->
                SegmentedButton(
                    selected = state.reportPreset == preset,
                    enabled = state.networkAvailable,
                    onClick = {
                        if (preset == ReportRangePreset.CUSTOM) pickingRange = true
                        else model.loadReports(preset = preset, range = null, timeZone = reportZone)
                    },
                    shape = SegmentedButtonDefaults.itemShape(index, ReportRangePreset.entries.size),
                    modifier = Modifier.heightIn(min = TouchTarget)
                        .testTag("history.report.preset.${preset.name.lowercase()}"),
                ) { Text(preset.label) }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                Icons.Filled.DateRange,
                contentDescription = null,
                Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "${range.label} · $reportZone",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { pickingRange = true }, enabled = state.networkAvailable, modifier = Modifier.heightIn(min = TouchTarget)) {
                Text("选择日期")
            }
        }
        HistorySearchField(state.reportQuery, model::setReportQuery)
        if (state.reportMessage.isNotBlank()) {
            Box(Modifier.padding(horizontal = ScreenPadding, vertical = 4.dp)) { MessageCard(state.reportMessage) }
        }
        PullToRefresh(
            refreshing,
            { refreshing = true; model.loadReports(timeZone = reportZone) },
            Modifier.fillMaxWidth().weight(1f),
        ) {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(ScreenPadding),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                when (val reports = state.reports) {
                    RemoteResource.NotLoaded -> item {
                        EmptyStateCard(Icons.Filled.BarChart, "尚未加载通话报告", "选择日期范围查看报告")
                    }
                    RemoteResource.Loading -> item { LoadingRow("正在读取报告…") }
                    is RemoteResource.Failed -> item {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            MessageCard("报告读取失败：${reports.message}")
                            OutlinedButton(
                                onClick = { model.loadReports(timeZone = reportZone) },
                                enabled = state.networkAvailable,
                                modifier = Modifier.heightIn(min = TouchTarget),
                            ) { Text("重试") }
                        }
                    }
                    is RemoteResource.Loaded -> {
                        // S28: SIM 过滤进了服务端的 WHERE；只有旧 Control（没有分页信封）才退回客户端筛。
                        val reportItems = reports.value.items.filter {
                            reports.value.paging.supported || selectedId.isBlank() || it.sim.id == selectedId
                        }
                        if (reportItems.isEmpty()) item {
                            EmptyStateCard(
                                Icons.Filled.BarChart,
                                "这段时间没有通话",
                                "换一个日期范围或搜索词再试。",
                            )
                        }
                        items(reportItems, key = { reportHistoryRowKey(it.callId) }) { report ->
                            ReportCard(report, state, model, onOpenAiTranscript)
                        }
                    }
                }
            }
        }
        (state.reports as? RemoteResource.Loaded)?.value?.paging
            ?.takeIf(RecordsPagingPolicy::pagerVisible)
            ?.let { paging ->
                PagerBar(
                    page = paging.page,
                    pageSize = paging.pageSize,
                    total = paging.total,
                    totalPages = paging.totalPages,
                    onPage = model::setReportsPage,
                    onPageSize = model::setReportsPageSize,
                )
            }
    }
    if (pickingRange) ReportRangeDialog(
        current = range,
        onDismiss = { pickingRange = false },
        onConfirm = { picked ->
            pickingRange = false
            model.loadReports(preset = ReportRangePreset.CUSTOM, range = picked, timeZone = reportZone)
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReportRangeDialog(
    current: ReportDateRange,
    onDismiss: () -> Unit,
    onConfirm: (ReportDateRange) -> Unit,
) {
    val picker = rememberDateRangePickerState(
        initialSelectedStartDateMillis = reportPickerMillis(current.from),
        initialSelectedEndDateMillis = reportPickerMillis(current.to),
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = {
                    val start = picker.selectedStartDateMillis
                    if (start == null) onDismiss() else onConfirm(
                        ReportDateRange(
                            reportDateFromPickerMillis(start),
                            reportDateFromPickerMillis(picker.selectedEndDateMillis ?: start),
                        ),
                    )
                },
                enabled = LocalNetworkAvailable.current && picker.selectedStartDateMillis != null,
            ) { Text("确定") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    ) {
        DateRangePicker(
            state = picker,
            modifier = Modifier.heightIn(max = 520.dp),
            title = {
                Text("选择起止日期", Modifier.padding(start = ScreenPadding, end = ScreenPadding, top = 12.dp))
            },
        )
    }
}

/** 危险实心 pill (推荐拦截) / 中性 tonal pill (分类理由) / 静态 已屏蔽 pill. */
@Composable
private fun ReportPill(text: String, container: Color, content: Color) {
    Text(
        text,
        Modifier.background(container, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp),
        style = MaterialTheme.typography.labelSmall,
        color = content,
    )
}

@Composable
private fun ReportCard(
    item: CallReportItem,
    state: ClientUiState,
    model: ClientViewModel,
    onOpenAiTranscript: (String) -> Unit,
) {
    var confirmingBlock by remember(item.callId) { mutableStateOf(false) }
    val blocking = item.callId in state.reportBlocking
    val placeholder = reportSummaryPlaceholder(item.transcriptState)
    val summary = item.summary?.takeIf(String::isNotBlank)
    // 有 AI 对话而录音转录不可用时，"查看转录" 指向 AI 对话——两者是两份独立的文字记录。
    val preferAiTranscript = item.hasAiTranscript && item.transcriptState != "succeeded"
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                UnreadDot(reportShowsUnseenDot(item, state.seenCallIds), "未查看")
                if (item.blocked) {
                    Icon(
                        Icons.Filled.Block,
                        contentDescription = "已屏蔽",
                        Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
                PhoneNumberText(
                    item.internalTitle ?: contactNameWithNumber(item.remoteNumber, item.contactName),
                    Modifier.weight(1f),
                )
                Text(
                    formatCompactGatewayDateTime(item.startedAt, item.gatewayTimeZone),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                listOf(
                    item.sim.label,
                    directionLabel(item.direction),
                    talkDurationShortLabel(item.answeredAt, item.endedAt) ?: "未接通",
                    reportAnswerModeLabel(item.answerMode, item.answeredByPlatform, item.answeredAt, item.internal),
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (item.blockRecommended == true) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    ReportPill(
                        "推荐拦截",
                        MaterialTheme.colorScheme.errorContainer,
                        MaterialTheme.colorScheme.onErrorContainer,
                    )
                    item.blockReason?.takeIf(String::isNotBlank)?.let {
                        ReportPill(
                            it,
                            MaterialTheme.colorScheme.secondaryContainer,
                            MaterialTheme.colorScheme.onSecondaryContainer,
                        )
                    }
                }
            } else if (reportClassificationUnknown(item)) {
                Text(
                    "未分类",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                placeholder ?: summary ?: "这通电话没有可用摘要",
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium,
                color = if (placeholder != null || summary == null) MaterialTheme.colorScheme.onSurfaceVariant
                else MaterialTheme.colorScheme.onSurface,
            )
            item.actionItems.forEach {
                Text("• $it", style = MaterialTheme.typography.bodySmall)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (item.blocked) {
                    ReportPill(
                        "已屏蔽",
                        MaterialTheme.colorScheme.errorContainer,
                        MaterialTheme.colorScheme.onErrorContainer,
                    )
                } else {
                    TextButton(
                        onClick = { confirmingBlock = true },
                        enabled = state.networkAvailable && !blocking && dialableNumber(item.remoteNumber),
                        colors = destructiveTextColors(),
                        modifier = Modifier.heightIn(min = TouchTarget),
                    ) { Text(if (blocking) "正在屏蔽…" else "立即屏蔽") }
                }
                TextButton(
                    onClick = {
                        if (preferAiTranscript) onOpenAiTranscript(item.callId)
                        else model.openHistoryViewer(item, HistoryViewerKind.TRANSCRIPT)
                    },
                    enabled = state.networkAvailable || (preferAiTranscript && state.aiTranscripts[item.callId] is RemoteResource.Loaded),
                    modifier = Modifier.heightIn(min = TouchTarget),
                ) { Text(if (preferAiTranscript) "AI 对话" else "查看转录") }
                TextButton(
                    onClick = { model.openHistoryViewer(item, HistoryViewerKind.RECORDING) },
                    enabled = state.networkAvailable,
                    modifier = Modifier.heightIn(min = TouchTarget),
                ) { Text("查看录音") }
                TextButton(
                    onClick = { model.requestDial(item.remoteNumber) },
                    enabled = state.networkAvailable && dialableNumber(item.remoteNumber),
                    modifier = Modifier.heightIn(min = TouchTarget),
                ) { Text("回拨") }
            }
        }
    }
    if (confirmingBlock) {
        // Reuses the contact card's confirmation verbatim so the app has exactly one way of asking.
        val confirm = contactBlockConfirm(
            ContactCardTarget(
                number = item.remoteNumber,
                sourceCallId = item.callId,
                annotation = ContactAnnotation(item.contactId, item.contactName, item.blocked, item.blockedEntryId),
            ),
            blocked = false,
        )
        AlertDialog(
            onDismissRequest = { confirmingBlock = false },
            title = { Text(confirm.title) },
            text = { Text(confirm.message) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingBlock = false
                        model.blockReportNumber(item.callId, item.remoteNumber)
                    },
                    colors = destructiveTextColors(),
                    modifier = Modifier.testTag("reports.block.confirm"),
                    enabled = state.networkAvailable && !blocking,
                ) { Text(confirm.confirmLabel) }
            },
            dismissButton = { TextButton(onClick = { confirmingBlock = false }) { Text("取消") } },
        )
    }
}

/**
 * The AI leg of a call, opened from a report card. `GET /calls/:id/ai-transcript` is a second,
 * independent record from the recording transcript, so it gets its own sheet rather than being
 * folded into 查看转录.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AiTranscriptSheet(
    callId: String,
    state: ClientUiState,
    model: ClientViewModel,
    onBack: () -> Unit,
) {
    LaunchedEffect(callId, state.networkAvailable) { if (state.networkAvailable) model.loadAiTranscript(callId) }
    val transcript = state.aiTranscripts[callId]
    ModalBottomSheet(
        onDismissRequest = onBack,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = ScreenPadding).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("AI 对话", style = MaterialTheme.typography.titleLarge)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            when {
                transcript is RemoteResource.Failed -> MessageCard(transcript.message)
                transcript is RemoteResource.Loaded && transcript.value.isEmpty() ->
                    Text("这通电话没有 AI 对话记录。")
                transcript is RemoteResource.Loaded -> AiTranscriptCard(transcript.value)
                !state.networkAvailable -> Text("AI 对话未加载，联网后读取")
                else -> LoadingRow("正在读取 AI 对话…")
            }
        }
    }
}

@Composable
private fun DetailHeader(detail: CallDetailUiState) {
    Text(detail.item.remoteNumber.ifBlank { "号码未知" }, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace)
    Text(
        listOf(
            detail.item.sim.label,
            directionLabel(detail.item.direction),
            formatGatewayDateTime(detail.item.startedAt, detail.item.gatewayTimeZone),
        ).joinToString(" · "),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TranscriptSheet(detail: CallDetailUiState, model: ClientViewModel, onBack: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onBack,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = ScreenPadding).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("转录", style = MaterialTheme.typography.titleLarge)
            DetailHeader(detail)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            TranscriptSection(detail.transcript, model::retryHistoryViewer)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RecordingSheet(detail: CallDetailUiState, model: ClientViewModel, onBack: () -> Unit) {
    val context = LocalContext.current
    // S39 §F: 导出是这个浮层里唯一会写 `cacheDir/exports/` 的入口，离开时顺手收掉过期的残骸。
    DisposableEffect(Unit) { onDispose { pruneRecordingExports(context) } }
    ModalBottomSheet(
        onDismissRequest = onBack,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = ScreenPadding).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("录音", style = MaterialTheme.typography.titleLarge)
            DetailHeader(detail)
            talkDurationLabel(detail.item.answeredAt, detail.item.endedAt)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            RecordingSection(
                callId = detail.item.callId,
                recordingStatus = detail.item.recordingStatus,
                gatewayKind = detail.item.gatewayKind,
                ownerJoinedLocal = detail.item.ownerJoinedLocal,
                recordings = detail.recordings,
                selectedSource = detail.selectedRecordingSource,
                onSelectSource = { source ->
                    RecordingPlaybackController.get(context).stop()
                    model.selectRecordingSource(source)
                },
                onRetry = model::retryHistoryViewer,
            )
        }
    }
}

@Composable
private fun TranscriptSection(state: RemoteResource<CallTranscript?>, onRetry: () -> Unit) {
    Text("转写", style = MaterialTheme.typography.titleMedium)
    when (state) {
        RemoteResource.NotLoaded -> Text(if (LocalNetworkAvailable.current) "尚未加载" else "转写未加载，联网后读取")
        RemoteResource.Loading -> if (LocalNetworkAvailable.current) LoadingRow("正在加载转写…") else Text("转写未加载，联网后读取")
        is RemoteResource.Failed -> {
            MessageCard("转写加载失败：${state.message}")
            OutlinedButton(onClick = onRetry, enabled = LocalNetworkAvailable.current, modifier = Modifier.heightIn(min = TouchTarget)) { Text("重试") }
        }
        is RemoteResource.Loaded -> {
            val transcript = state.value
            if (transcript == null) Text("这通电话尚无转写任务") else when (transcript.status) {
                "queued" -> Text("转写已排队")
                "running" -> Text("正在转写（第 ${transcript.attempts} 次处理）")
                "retry" -> Text(
                    "转写等待重试${transcript.nextAttemptAt?.let { " · $it" }.orEmpty()}",
                    color = warningColor(),
                )
                "failed" -> MessageCard(transcript.errorMessage ?: "转写失败${transcript.errorCode?.let { "：$it" }.orEmpty()}")
                "succeeded" -> TranscriptResultContent(transcript.result)
                else -> Text("暂时无法识别转写状态")
            }
        }
    }
}

@Composable
private fun TranscriptResultContent(result: TranscriptResult?) {
    if (result == null) { Text("转写内容尚未生成"); return }
    // S22 决策 10: reports have no admission rules any more, so this is a label on the transcript,
    // not a statement about whether the call "counted". The 报告 card carries the actionable
    // 推荐拦截 / 分类理由 pills.
    if (result.advertisingClassification == "advertising") {
        Text("已识别为广告或推销", style = MaterialTheme.typography.bodySmall, color = warningColor())
    }
    result.summary?.takeIf(String::isNotBlank)?.let {
        Text("摘要", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(it)
    }
    if (result.actionItems.isNotEmpty()) {
        Text("行动项", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        result.actionItems.forEach { Text("• $it") }
    }
    if (result.segments.isEmpty()) {
        Text(result.text.ifBlank { "转写结果为空" })
    } else {
        val blocks = mergeTranscriptSegments(result.segments)
        TranscriptTrack.entries.forEach { track ->
            val trackBlocks = blocks.filter { it.track == track }
            if (trackBlocks.isEmpty()) return@forEach
            Text(track.label, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            trackBlocks.forEach { block ->
                Column(Modifier.padding(vertical = 4.dp)) {
                    if (trackBlocks.size > 1) {
                        Text(block.speaker, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(block.text)
                }
            }
        }
    }
    if (result.providers.isNotEmpty()) {
        Text(
            result.providers.joinToString(" / ") { provider ->
                listOfNotNull(provider.provider, provider.model, provider.version).joinToString(" · ")
            },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RecordingSection(
    callId: String,
    recordingStatus: String,
    gatewayKind: GatewayKind,
    ownerJoinedLocal: Boolean,
    recordings: Map<RecordingSource, RemoteResource<RecordingManifest?>>,
    selectedSource: RecordingSource,
    onSelectSource: (RecordingSource) -> Unit,
    onRetry: () -> Unit,
) {
    val context = LocalContext.current
    val playback = remember(context) { RecordingPlaybackController.get(context) }
    val playbackState by playback.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var downloadingKey by remember(callId, selectedSource) { mutableStateOf<String?>(null) }
    var downloadError by remember(callId, selectedSource) { mutableStateOf("") }
    val state = recordings[selectedSource] ?: RemoteResource.NotLoaded
    DisposableEffect(callId, selectedSource) { onDispose(playback::stop) }
    Text("原始录音", style = MaterialTheme.typography.titleMedium)
    Text(
        "录音 · ${recordingStatusLabel(recordingStatus)}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().heightIn(min = TouchTarget)) {
        RecordingSource.entries.forEachIndexed { index, source ->
            SegmentedButton(
                selected = source == selectedSource,
                onClick = { if (source != selectedSource) onSelectSource(source) },
                enabled = LocalNetworkAvailable.current || recordings[source] is RemoteResource.Loaded,
                shape = SegmentedButtonDefaults.itemShape(index, RecordingSource.entries.size),
                modifier = Modifier.heightIn(min = TouchTarget),
            ) { Text(source.label(gatewayKind, ownerJoinedLocal)) }
        }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        RecordingSource.entries.forEach { source ->
            Text(
                "${source.label(gatewayKind, ownerJoinedLocal)}：${recordingSourceStatusLabel(recordings[source])}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    when (state) {
        RemoteResource.NotLoaded -> Text(if (LocalNetworkAvailable.current) "尚未加载" else "录音清单未加载，联网后读取")
        RemoteResource.Loading -> if (LocalNetworkAvailable.current) LoadingRow("正在核验录音清单…") else Text("录音清单未加载，联网后读取")
        is RemoteResource.Failed -> {
            MessageCard("录音清单加载失败：${state.message}")
            if (selectedSource != RecordingSource.PIXEL || state.message != PIXEL_ARCHIVE_DISABLED_MESSAGE) {
                OutlinedButton(onClick = onRetry, enabled = LocalNetworkAvailable.current, modifier = Modifier.heightIn(min = TouchTarget)) { Text("重试") }
            }
        }
        is RemoteResource.Loaded -> {
            val recording = state.value
            if (recording == null) Text("所选录音副本尚未生成") else {
                fun save(key: String, tracks: List<RecordingAudioTrack>) {
                    if (downloadingKey != null) return
                    downloadingKey = key
                    downloadError = ""
                    scope.launch {
                        runCatching {
                            // S36 C4: 导出一律要服务器转码后的 MP3，播放仍用原始编码。
                            val files = playback.exportTracks(callId, recording, tracks, format = "mp3")
                            try {
                                tracks.zip(files).forEach { (track, file) ->
                                    persistRecordingDownload(
                                        context,
                                        file,
                                        recordingAttachmentFileName(callId, recording.source, track, "audio/mpeg"),
                                        "audio/mpeg",
                                    )
                                }
                            } finally {
                                files.forEach { it.delete() }
                            }
                        }.onFailure {
                            downloadError = it.message ?: "下载失败，请稍后重试。"
                            if (it !is kotlinx.coroutines.CancellationException) downloadError.asUiError("recording.download", it.javaClass.simpleName)
                        }
                        downloadingKey = null
                    }
                }
                if (recording.archiveComplete) {
                    Text("归档已完成", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    Text("归档尚未完成", style = MaterialTheme.typography.bodySmall, color = warningColor())
                }
                if (recording.source == RecordingSource.MEDIA_NODE && recording.version == 1) {
                    Text(
                        "这是服务器 Ogg 原始副本；双方音轨只能各自从文件开头播放，不代表精确同步。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (recording.captureComplete == false) {
                    Text(
                        "录制过程中有缺失，回放可能出现缺音。",
                        style = MaterialTheme.typography.bodySmall,
                        color = warningColor(),
                    )
                }
                // S36 C4: 服务器混音只有一份（按 callId+source），所以整页只保留这一个「下载对话 MP3」，挂在默认那一对上。
                // S94: 有本机上行轨时默认一对是「通话双方（含本机接入）」，Control 的 conversation 混音也用这一对。
                val defaultPair = recording.defaultPairMode
                val downloadConversation = {
                    save(RecordingAudioTrack.CONVERSATION.wireValue, listOf(RecordingAudioTrack.CONVERSATION))
                }
                if (defaultPair == RecordingPairMode.OWNER_JOINED) {
                    RecordingPairControl(
                        callId = callId,
                        recording = recording,
                        mode = RecordingPairMode.OWNER_JOINED,
                        title = "通话双方（含本机接入）",
                        detail = "对方原声 + 本机上行（含本机接入）",
                        playbackState = playbackState,
                        playback = playback,
                        downloading = downloadingKey == RecordingAudioTrack.CONVERSATION.wireValue,
                        onDownload = downloadConversation,
                    )
                }
                RecordingPairControl(
                    callId = callId,
                    recording = recording,
                    mode = RecordingPairMode.ORIGINALS,
                    title = "双向原始录音",
                    detail = "对方原声 + 我的原声；原始缺口会保留。",
                    playbackState = playbackState,
                    playback = playback,
                    downloading = defaultPair == RecordingPairMode.ORIGINALS &&
                        downloadingKey == RecordingAudioTrack.CONVERSATION.wireValue,
                    onDownload = downloadConversation.takeIf { defaultPair == RecordingPairMode.ORIGINALS },
                )
                val derived = recording.artifact(RecordingAudioTrack.CALLER_PLAYOUT)
                if (derived != null) {
                    RecordingPairControl(
                        callId = callId,
                        recording = recording,
                        mode = RecordingPairMode.COMPENSATED,
                        title = "补偿后双向播放",
                        detail = "对方原声 + 通话播放声（含补偿）",
                        playbackState = playbackState,
                        playback = playback,
                        downloading = false,
                        onDownload = null,
                    )
                    Text(
                        "派生播放轨 · 补偿帧 ${derived.recoveryFrames} · 剩余缺口 ${derived.gapCount}" +
                            if (derived.playoutComplete == true) "" else " · 播放轨不完整",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "这是独立的听取轨，不会覆盖本端原声缺口，也不改变原始录音完整性。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Text("分别播放原声", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                listOf(
                    RecordingAudioTrack.REMOTE_ORIGINAL,
                    RecordingAudioTrack.CALLER_ORIGINAL,
                    RecordingAudioTrack.CALLER_PLAYOUT,
                    RecordingAudioTrack.CALLER_UPLINK,
                ).forEach { playbackTrack ->
                    val artifact = recording.artifact(playbackTrack) ?: return@forEach
                    if ((playbackTrack == RecordingAudioTrack.CALLER_PLAYOUT || playbackTrack == RecordingAudioTrack.CALLER_UPLINK) &&
                        recording.source != RecordingSource.PIXEL) return@forEach
                    RecordingTrackControl(
                        callId = callId,
                        recording = recording,
                        track = playbackTrack,
                        artifact = artifact,
                        playbackState = playbackState,
                        playback = playback,
                        downloading = downloadingKey == playbackTrack.wireValue,
                        onDownload = { save(playbackTrack.wireValue, listOf(playbackTrack)) },
                    )
                }
                if (downloadError.isNotBlank()) MessageCard(downloadError)
                Text(
                    "录音不会自动播放；播放前会核验文件大小和完整性。下载一律是服务器转码的 MP3：" +
                        "「下载对话 MP3」是双人混音，单条声轨的「下载」仍只有那一个人的声音。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun RecordingPairControl(
    callId: String,
    recording: RecordingManifest,
    mode: RecordingPairMode,
    title: String,
    detail: String,
    playbackState: RecordingPlaybackState,
    playback: RecordingPlaybackController,
    downloading: Boolean,
    onDownload: (() -> Unit)?,
) {
    val artifacts = recording.pairArtifacts(mode)
    val loading = playbackState is RecordingPlaybackState.LoadingPair &&
        playbackState.callId == callId && playbackState.source == recording.source && playbackState.mode == mode
    val playing = playbackState is RecordingPlaybackState.PlayingPair &&
        playbackState.callId == callId && playbackState.source == recording.source && playbackState.mode == mode
    val paused = playbackState is RecordingPlaybackState.PausedPair &&
        playbackState.callId == callId && playbackState.source == recording.source && playbackState.mode == mode
    val active = playing || paused
    val contractDuration = recording.pairDurationMs(mode) ?: 0
    val duration = if (active) recordingPlaybackDurationMs(playbackState).takeIf { it > 0 } ?: contractDuration else contractDuration
    val position = if (active) recordingPlaybackPositionMs(playbackState) else 0
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title)
                Text(
                    if (artifacts.size == 2) detail else "双方声轨尚未齐全",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (artifacts.size == 2) MaterialTheme.colorScheme.onSurfaceVariant else warningColor(),
                )
                if (duration > 0) {
                    Text(
                        if (active) "${formatPlayerTime(position)} / ${formatPlayerTime(duration)}" else formatPlayerTime(duration),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            when {
                loading -> CircularProgressIndicator(Modifier.size(24.dp))
                playing -> OutlinedButton(onClick = playback::pause, modifier = Modifier.heightIn(min = TouchTarget)) { Text("暂停") }
                paused -> OutlinedButton(onClick = playback::resume, modifier = Modifier.heightIn(min = TouchTarget)) { Text("继续") }
                else -> OutlinedButton(
                    onClick = { playback.playPair(callId, recording, mode) },
                    enabled = artifacts.size == 2,
                    modifier = Modifier.heightIn(min = TouchTarget),
                ) { Text("播放") }
            }
            if (onDownload != null) {
                RecordingDownloadButton(
                    enabled = artifacts.size == 2,
                    busy = downloading,
                    label = "下载对话 MP3",
                    onClick = onDownload,
                )
            }
        }
        if (onDownload != null) {
            Text(
                "下载的是服务器按时间轴混好的一条双人对话 MP3；这里的播放仍是两条声轨。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (duration > 0) {
            Slider(
                value = position.toFloat().coerceAtMost(duration.toFloat()),
                onValueChange = { if (active) playback.seek(it.toLong()) },
                valueRange = 0f..duration.toFloat().coerceAtLeast(1f),
                enabled = active,
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
            )
        }
    }
    val failure = playbackState as? RecordingPlaybackState.FailedPair
    if (failure?.callId == callId && failure.source == recording.source && failure.mode == mode) {
        LaunchedEffect(failure) { failure.message.asUiError("recording.playPair") }
        Text(failure.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun RecordingTrackControl(
    callId: String,
    recording: RecordingManifest,
    track: RecordingAudioTrack,
    artifact: RecordingArtifact,
    playbackState: RecordingPlaybackState,
    playback: RecordingPlaybackController,
    downloading: Boolean,
    onDownload: () -> Unit,
) {
    val currentPlayback = playbackState
    val loadingThis = currentPlayback is RecordingPlaybackState.Loading &&
        currentPlayback.callId == callId && currentPlayback.source == recording.source && currentPlayback.track == track
    val playingThis = currentPlayback is RecordingPlaybackState.Playing &&
        currentPlayback.callId == callId && currentPlayback.source == recording.source && currentPlayback.track == track
    val pausedThis = currentPlayback is RecordingPlaybackState.Paused &&
        currentPlayback.callId == callId && currentPlayback.source == recording.source && currentPlayback.track == track
    val active = playingThis || pausedThis
    val contractDuration = artifact.durationMs ?: 0
    val duration = if (active) recordingPlaybackDurationMs(playbackState).takeIf { it > 0 } ?: contractDuration else contractDuration
    val position = if (active) recordingPlaybackPositionMs(playbackState) else 0
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(track.label)
                Text(
                    "${fileSizeLabel(artifact.bytes)} · ${if (artifact.mediaType == "audio/wav") "WAV" else "Ogg Opus"}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (duration > 0) {
                    Text(
                        if (active) "${formatPlayerTime(position)} / ${formatPlayerTime(duration)}" else formatPlayerTime(duration),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (artifact.captureComplete == false) {
                    Text(
                        "此轨道录制不完整 · 缺口 ${artifact.gapCount} · 丢帧 ${artifact.droppedFrames}",
                        style = MaterialTheme.typography.labelSmall,
                        color = warningColor(),
                    )
                }
            }
            when {
                loadingThis -> CircularProgressIndicator(Modifier.size(24.dp))
                playingThis -> OutlinedButton(onClick = playback::pause, modifier = Modifier.heightIn(min = TouchTarget)) { Text("暂停") }
                pausedThis -> OutlinedButton(onClick = playback::resume, modifier = Modifier.heightIn(min = TouchTarget)) { Text("继续") }
                else -> OutlinedButton(
                    onClick = { playback.play(callId, recording, track, artifact) },
                    enabled = artifact.bytes > 0,
                    modifier = Modifier.heightIn(min = TouchTarget),
                ) { Text("播放") }
            }
            RecordingDownloadButton(
                enabled = artifact.bytes > 0,
                busy = downloading,
                label = "下载",
                onClick = onDownload,
            )
        }
        if (duration > 0) {
            Slider(
                value = position.toFloat().coerceAtMost(duration.toFloat()),
                onValueChange = { if (active) playback.seek(it.toLong()) },
                valueRange = 0f..duration.toFloat().coerceAtLeast(1f),
                enabled = active,
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
            )
        }
    }
    val failure = playbackState as? RecordingPlaybackState.Failed
    if (failure?.callId == callId && failure.source == recording.source && failure.track == track) {
        LaunchedEffect(failure) { failure.message.asUiError("recording.play") }
        Text(failure.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * 不用登录也能渲染的「全部通话」：60 行假数据，停在第 2 页（共 2 页、160 条），底部是 [PagerBar]。
 * [AllCallsList] 只收数据和回调，没有 ViewModel，所以 Android Studio 的预览能直接画出来。
 */
@Preview(name = "全部通话 第 2 页", showBackground = true, heightDp = 900)
@Composable
private fun AllCallsListPreview() {
    val sim = JSONObject()
        .put("id", "sim-1")
        .put("label", "北京号")
        .put("phoneLabel", "北京号")
        .put("timeZone", "Asia/Shanghai")
    val calls = List(60) { index ->
        JSONObject()
            .put("id", "preview-call-$index")
            .put("simId", "sim-1")
            .put("direction", if (index % 2 == 0) "incoming" else "outgoing")
            .put("remoteNumber", "+861380000%04d".format(index))
            .put("state", if (index % 7 == 0) "failed" else "completed")
            .put("startedAt", "2026-09-13T%02d:%02d:00Z".format(index % 24, index % 60))
            .put("answeredAt", "2026-09-13T%02d:%02d:10Z".format(index % 24, index % 60))
            .put("endedAt", "2026-09-13T%02d:%02d:55Z".format(index % 24, index % 60))
            .put("blocked", index % 11 == 0)
    }
    VoDogTheme {
        AllCallsList(
            callsPage = RemoteResource.Loaded(Page(calls, page = 2, pageSize = 100, total = 160, totalPages = 2)),
            refreshing = false,
            query = "",
            calls = calls,
            simJsonById = mapOf("sim-1" to sim),
            onQueryChange = {},
            onRefresh = {},
            onPage = {},
            onPageSize = {},
            onOpen = {},
            onContactCard = {},
            onViewer = { _, _ -> },
            onDelete = {},
        )
    }
}
