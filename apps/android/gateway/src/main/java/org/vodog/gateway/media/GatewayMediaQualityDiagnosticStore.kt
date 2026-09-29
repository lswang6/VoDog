package org.vodog.gateway.media

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

internal fun interface GatewayMediaQualityDiagnosticRecorder {
    fun record(snapshot: GatewayMediaQualityDiagnosticSnapshot)
}

internal data class GatewayMediaQualityDiagnosticSnapshot(
    val stage: String,
    val networkGeneration: String,
    val measuredAt: Instant,
    val expiresAt: Instant? = null,
    val acceptedCount: Int = 0,
    val nodes: List<GatewayMediaQualityNodeDiagnostic> = emptyList(),
)

internal data class GatewayMediaQualityNodeDiagnostic(
    val nodeId: String,
    val outcome: String,
    val sent: Int,
    val received: Int,
    val sampleDurationMs: Double,
    val connectionMs: Double? = null,
    val rttP95Ms: Double? = null,
    val jitterMs: Double? = null,
)

/** Private last-snapshot storage. Probe grants, relay credentials, SDP, numbers and raw errors never enter it. */
internal class GatewayMediaQualityDiagnosticStore(context: Context) : GatewayMediaQualityDiagnosticRecorder {
    private val context = context.applicationContext ?: context

    override fun record(snapshot: GatewayMediaQualityDiagnosticSnapshot) {
        context.createDeviceProtectedStorageContext()
            .getSharedPreferences(NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, encodeGatewayMediaQualityDiagnostic(snapshot))
            .apply()
    }

    internal companion object {
        const val NAME = "gateway_media_quality_diagnostic"
        const val KEY = "latest"
    }
}

/** Chinese label for the relay-quality stage shown in the gateway's 网络与媒体 card. */
internal fun gatewayMediaQualityStageLabel(stage: String?): String = when (stage) {
    null -> "尚无记录"
    "disabled" -> "服务端未开启"
    "accepted" -> "已上报"
    "failed" -> "测量失败"
    "cancelled" -> "已取消"
    else -> stage
}

internal fun readGatewayMediaQualityDiagnostic(context: Context): GatewayMediaQualityDiagnosticSnapshot? = runCatching {
    context.createDeviceProtectedStorageContext()
        .getSharedPreferences(GatewayMediaQualityDiagnosticStore.NAME, Context.MODE_PRIVATE)
        .getString(GatewayMediaQualityDiagnosticStore.KEY, null)
        ?.let(::decodeGatewayMediaQualityDiagnostic)
}.getOrNull()

internal fun decodeGatewayMediaQualityDiagnostic(raw: String): GatewayMediaQualityDiagnosticSnapshot? = runCatching {
    val json = JSONObject(raw)
    val nodes = json.optJSONArray("nodes") ?: JSONArray()
    GatewayMediaQualityDiagnosticSnapshot(
        stage = json.optString("stage").ifBlank { "unknown" },
        networkGeneration = json.optString("networkGeneration").take(96),
        measuredAt = Instant.parse(json.getString("measuredAt")),
        expiresAt = if (json.isNull("expiresAt")) null else {
            json.optString("expiresAt").takeIf(String::isNotBlank)?.let(Instant::parse)
        },
        acceptedCount = json.optInt("acceptedCount").coerceIn(0, 16),
        nodes = List(minOf(nodes.length(), 16)) { index ->
            nodes.getJSONObject(index).let { node ->
                GatewayMediaQualityNodeDiagnostic(
                    nodeId = node.optString("nodeId").take(32),
                    outcome = node.optString("outcome").ifBlank { "unknown" },
                    sent = node.optInt("sent").coerceIn(0, 250),
                    received = node.optInt("received").coerceIn(0, 250),
                    sampleDurationMs = node.optDouble("sampleDurationMs", 0.0),
                    connectionMs = node.optDoubleOrNull("connectionMs"),
                    rttP95Ms = node.optDoubleOrNull("rttP95Ms"),
                    jitterMs = node.optDoubleOrNull("jitterMs"),
                )
            }
        },
    )
}.getOrNull()

private fun JSONObject.optDoubleOrNull(key: String): Double? =
    if (isNull(key)) null else optDouble(key).takeIf { it.isFinite() }

internal fun encodeGatewayMediaQualityDiagnostic(snapshot: GatewayMediaQualityDiagnosticSnapshot): String {
    require(snapshot.stage in QUALITY_DIAGNOSTIC_STAGES)
    require(snapshot.networkGeneration.length in 1..96)
    require(snapshot.acceptedCount in 0..16)
    require(snapshot.nodes.size <= 16 && snapshot.nodes.map { it.nodeId }.distinct().size == snapshot.nodes.size)
    if (snapshot.stage == "disabled") require(snapshot.expiresAt == null && snapshot.acceptedCount == 0 && snapshot.nodes.isEmpty())
    val nodes = JSONArray()
    snapshot.nodes.forEach { node ->
        require(node.nodeId.matches(Regex("^[a-z][a-z0-9_-]{0,31}$")))
        require(node.outcome in QUALITY_DIAGNOSTIC_OUTCOMES && node.sent in 0..250 && node.received in 0..node.sent)
        require(node.sampleDurationMs.finiteQualityMetric())
        val json = JSONObject().put("nodeId", node.nodeId).put("outcome", node.outcome)
            .put("sent", node.sent).put("received", node.received).put("sampleDurationMs", node.sampleDurationMs)
        listOf("connectionMs" to node.connectionMs, "rttP95Ms" to node.rttP95Ms, "jitterMs" to node.jitterMs).forEach { (key, value) ->
            if (value != null) { require(value.finiteQualityMetric()); json.put(key, value) }
        }
        nodes.put(json)
    }
    return JSONObject().put("schemaVersion", 1).put("stage", snapshot.stage)
        .put("networkGeneration", snapshot.networkGeneration).put("measuredAt", snapshot.measuredAt.toString())
        .put("acceptedCount", snapshot.acceptedCount)
        .put("okCount", snapshot.nodes.count { it.outcome == "ok" })
        .put("timeoutCount", snapshot.nodes.count { it.outcome == "timeout" })
        .put("networkErrorCount", snapshot.nodes.count { it.outcome == "network_error" })
        .put("nodes", nodes)
        .also { if (snapshot.expiresAt != null) it.put("expiresAt", snapshot.expiresAt.toString()) }
        .toString()
}

private fun Double.finiteQualityMetric() = isFinite() && this in 0.0..5000.0
private val QUALITY_DIAGNOSTIC_STAGES = setOf("disabled", "accepted", "failed", "cancelled")
private val QUALITY_DIAGNOSTIC_OUTCOMES = setOf("ok", "timeout", "network_error")
