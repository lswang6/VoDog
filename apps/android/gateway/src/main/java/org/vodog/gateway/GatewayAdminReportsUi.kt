package org.vodog.gateway

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.TimeZone

enum class GatewayAdminReportPeriod(val value: String, val label: String) {
    SEVEN_DAYS("7d", "7 天"),
    ONE_MONTH("1m", "1 月"),
    SIX_MONTHS("6m", "6 月"),
    ONE_YEAR("1y", "1 年"),
}

data class GatewayAdminReportWindow(
    val period: String,
    val timeZone: String,
    val fromInclusive: String,
    val toExclusive: String,
)

data class GatewayAdminReportItem(
    val callId: String,
    val simId: String,
    val simLabel: String,
    val slotIndex: Int,
    val historicalOwnerUsername: String,
    val remoteNumberMasked: String?,
    val startedAt: String,
    val answeredAt: String?,
    val endedAt: String?,
    val state: String,
    val modeSnapshot: String,
    val transcriptStatus: String,
    val summary: String?,
    val actionItems: List<String>,
    val recordingStatus: String,
    val advertisingClassification: String,
    val transcriptCompletedAt: String?,
)

data class GatewayAdminReportPage(
    val window: GatewayAdminReportWindow,
    val items: List<GatewayAdminReportItem>,
    val nextCursor: String?,
)

internal fun parseGatewayAdminReportPage(response: JSONObject): GatewayAdminReportPage {
    val window = response.getJSONObject("window")
    val items = response.getJSONArray("items")
    return GatewayAdminReportPage(
        window = GatewayAdminReportWindow(
            period = window.getString("period"),
            timeZone = window.getString("timeZone"),
            fromInclusive = window.getString("fromInclusive"),
            toExclusive = window.getString("toExclusive"),
        ),
        items = (0 until items.length()).map { index ->
            val item = items.getJSONObject(index)
            val sim = item.getJSONObject("sim")
            val owner = item.getJSONObject("historicalOwner")
            val actions = item.getJSONArray("actionItems")
            require(item.getString("answeredByPlatform") == "ai") { "report item is not AI answered" }
            GatewayAdminReportItem(
                callId = item.getString("callId"),
                simId = sim.getString("id"),
                simLabel = sim.getString("label"),
                slotIndex = sim.getInt("slotIndex"),
                historicalOwnerUsername = owner.getString("username"),
                remoteNumberMasked = item.optNullableText("remoteNumberMasked"),
                startedAt = item.getString("startedAt"),
                answeredAt = item.optNullableText("answeredAt"),
                endedAt = item.optNullableText("endedAt"),
                state = item.getString("state"),
                modeSnapshot = item.getString("modeSnapshot"),
                transcriptStatus = item.getString("transcriptStatus"),
                summary = item.optNullableText("summary"),
                actionItems = (0 until actions.length()).map(actions::getString),
                recordingStatus = item.getString("recordingStatus"),
                advertisingClassification = item.getString("advertisingClassification"),
                transcriptCompletedAt = item.optNullableText("transcriptCompletedAt"),
            )
        },
        nextCursor = response.optNullableText("nextCursor"),
    )
}

internal fun mergeGatewayAdminReportPages(
    current: GatewayAdminReportPage,
    next: GatewayAdminReportPage,
): GatewayAdminReportPage {
    require(current.window == next.window) { "report window changed during pagination" }
    val existing = current.items.map { it.callId }.toSet()
    require(next.items.none { it.callId in existing }) { "report page contains duplicate calls" }
    return current.copy(items = current.items + next.items, nextCursor = next.nextCursor)
}

internal data class GatewayAdminReportRequestKey(
    val serial: Long,
    val gatewayId: String,
    val period: GatewayAdminReportPeriod,
    val cursor: String?,
    val sessionToken: String,
)

internal class GatewayAdminReportRequestGuard {
    private var serial = 0L

    fun begin(
        gatewayId: String,
        period: GatewayAdminReportPeriod,
        cursor: String?,
        sessionToken: String,
    ) = GatewayAdminReportRequestKey(++serial, gatewayId, period, cursor, sessionToken)

    fun invalidate() { serial++ }

    fun accepts(
        key: GatewayAdminReportRequestKey,
        gatewayId: String,
        period: GatewayAdminReportPeriod,
        sessionToken: String?,
        controlEnabled: Boolean,
    ): Boolean = controlEnabled && key.serial == serial && key.gatewayId == gatewayId &&
        key.period == period && key.sessionToken == sessionToken
}

@Composable
internal fun GatewayAdminReportsPanel(
    api: GatewayAdminApi,
    session: GatewayAdminSession,
    gatewayId: String,
    controlEnabled: () -> Boolean,
) {
    val scope = rememberCoroutineScope()
    val guard = remember { GatewayAdminReportRequestGuard() }
    val timeZone = remember { TimeZone.getDefault().id }
    var period by remember { mutableStateOf(GatewayAdminReportPeriod.SEVEN_DAYS) }
    var page by remember { mutableStateOf<GatewayAdminReportPage?>(null) }
    var loading by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun load(cursor: String?) {
        val token = session.token ?: return
        val networkToken = runCatching { api.beginRequest() }.getOrElse {
            error = gatewayAdminErrorMessage(it)
            return
        }
        val key = guard.begin(gatewayId, period, cursor, token)
        if (cursor == null) {
            loading = true
            page = null
        } else {
            loadingMore = true
        }
        error = null
        scope.launch {
            runCatching { withContext(Dispatchers.IO) {
                api.reports(networkToken, token, gatewayId, period, timeZone, cursor)
            } }.onSuccess { result ->
                if (!guard.accepts(key, gatewayId, period, session.token, controlEnabled())) return@onSuccess
                runCatching { if (cursor == null || page == null) result else mergeGatewayAdminReportPages(page!!, result) }
                    .onSuccess { page = it }
                    .onFailure { error = "报告分页状态已变化，请重新加载" }
                loading = false
                loadingMore = false
            }.onFailure {
                if (!guard.accepts(key, gatewayId, period, session.token, controlEnabled())) return@onFailure
                loading = false
                loadingMore = false
                if (it is GatewayAdminHttpException && it.status == 401) {
                    api.cancelAll()
                    session.clear()
                }
                error = gatewayAdminErrorMessage(it)
            }
        }
    }

    LaunchedEffect(gatewayId, period, session.token) {
        guard.invalidate()
        page = null
        error = null
        if (session.token != null && controlEnabled()) load(null)
    }
    DisposableEffect(Unit) { onDispose { guard.invalidate() } }

    Card(modifier = Modifier.fillMaxWidth(), shape = GATEWAY_CARD_SHAPE) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("AI 接听报告", style = MaterialTheme.typography.titleMedium)
            Text("只显示这个网关中实际由 AI 接听、且未被明确识别为广告的记录。",
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                GatewayAdminReportPeriod.entries.forEach { option ->
                    FilterChip(
                        selected = period == option,
                        onClick = { if (!loading && !loadingMore) period = option },
                        label = { Text(option.label) },
                    )
                }
            }
            when {
                loading -> {
                    CircularProgressIndicator()
                    Text("正在读取报告…")
                }
                error != null -> {
                    Text(error!!, color = MaterialTheme.colorScheme.error)
                    Button(onClick = { load(null) }) { Text("重新加载") }
                }
                page == null -> Text("尚未加载报告")
                page!!.items.isEmpty() -> Text("这个时间范围内暂无 AI 接听记录")
                else -> {
                    page!!.items.forEachIndexed { index, item ->
                        if (index > 0) HorizontalDivider(Modifier.padding(vertical = 4.dp))
                        GatewayAdminReportRow(item)
                    }
                    page!!.nextCursor?.let { cursor ->
                        Button(enabled = !loadingMore, onClick = { load(cursor) }) {
                            Text(if (loadingMore) "正在加载…" else "加载更多")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GatewayAdminReportRow(item: GatewayAdminReportItem) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("SIM ${item.slotIndex + 1} · ${item.simLabel}", style = MaterialTheme.typography.titleSmall)
        Text("${item.remoteNumberMasked ?: "号码未知"} · ${item.historicalOwnerUsername}")
        Text(gatewayLocalTimestampText(item.startedAt), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("转写：${transcriptStatusLabel(item.transcriptStatus)} · 录音：${recordingStatusLabel(item.recordingStatus)}")
        Text(item.summary ?: "摘要尚未生成")
        if (item.actionItems.isNotEmpty()) {
            Text("待办")
            item.actionItems.forEach { Text("• $it") }
        }
    }
}

private fun transcriptStatusLabel(value: String) = when (value) {
    "not_started" -> "尚未开始"
    "queued" -> "已排队"
    "running" -> "处理中"
    "retry" -> "等待重试"
    "succeeded" -> "已完成"
    "failed" -> "处理失败"
    else -> "状态待确认"
}

private fun recordingStatusLabel(value: String) = when (value) {
    "complete", "completed", "ready" -> "已生成"
    "recording", "processing", "pending" -> "处理中"
    "incomplete" -> "不完整"
    "failed" -> "失败"
    else -> "待确认"
}

private fun JSONObject.optNullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else getString(key).takeIf(String::isNotBlank)
