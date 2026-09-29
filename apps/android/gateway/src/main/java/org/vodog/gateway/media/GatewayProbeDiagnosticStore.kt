package org.vodog.gateway.media

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Replaces one private snapshot; it never stores grants, URLs, credentials, numbers, or raw errors. */
internal class GatewayProbeDiagnosticStore(context: Context) : GatewayProbeDiagnosticRecorder {
    // The FGS may be recreated before credential-encrypted storage is available. Construction is
    // side-effect free; the coordinator isolates any later diagnostic write failure.
    private val context = context.applicationContext ?: context

    override fun record(snapshot: GatewayProbeDiagnosticSnapshot) {
        context.createDeviceProtectedStorageContext()
            .getSharedPreferences(NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, encodeGatewayProbeDiagnostic(snapshot))
            .apply()
    }

    internal companion object {
        const val NAME = "gateway_media_probe_diagnostic"
        const val KEY = "latest"
    }
}

/** Reads the last reachability snapshot for the diagnostics UI. Never throws; absence is null. */
internal fun readGatewayProbeDiagnostic(context: Context): GatewayProbeDiagnosticSnapshot? = runCatching {
    context.createDeviceProtectedStorageContext()
        .getSharedPreferences(GatewayProbeDiagnosticStore.NAME, Context.MODE_PRIVATE)
        .getString(GatewayProbeDiagnosticStore.KEY, null)
        ?.let(::decodeGatewayProbeDiagnostic)
}.getOrNull()

internal fun decodeGatewayProbeDiagnostic(raw: String): GatewayProbeDiagnosticSnapshot? = runCatching {
    val json = JSONObject(raw)
    val nodes = json.optJSONArray("nodes") ?: JSONArray()
    GatewayProbeDiagnosticSnapshot(
        generation = json.optString("generation").take(96),
        stage = json.optString("stage").ifBlank { "unknown" },
        optionsStatus = json.optString("optionsStatus").ifBlank { "unknown" },
        optionsDurationMs = json.optLongOrNull("optionsDurationMs"),
        resultsStatus = json.optString("resultsStatus").ifBlank { "unknown" },
        resultsDurationMs = json.optLongOrNull("resultsDurationMs"),
        nodeOutcomes = List(minOf(nodes.length(), 16)) { index ->
            nodes.getJSONObject(index).let { node ->
                GatewayProbeNodeOutcomes(
                    node.optString("nodeId").take(32),
                    node.optInt("ok").coerceIn(0, 3),
                    node.optInt("timeout").coerceIn(0, 3),
                    node.optInt("networkError").coerceIn(0, 3),
                )
            }
        },
        validUntil = if (json.isNull("validUntil")) null else json.optString("validUntil").takeIf(String::isNotBlank),
        localReady = json.optBoolean("localReady"),
    )
}.getOrNull()

private fun JSONObject.optLongOrNull(key: String): Long? = if (isNull(key)) null else optLong(key, -1L).takeIf { it >= 0 }

internal fun encodeGatewayProbeDiagnostic(snapshot: GatewayProbeDiagnosticSnapshot): String = JSONObject()
    .put("generation", snapshot.generation.take(96))
    .put("stage", snapshot.stage)
    .put("optionsStatus", snapshot.optionsStatus)
    .put("optionsDurationMs", snapshot.optionsDurationMs)
    .put("resultsStatus", snapshot.resultsStatus)
    .put("resultsDurationMs", snapshot.resultsDurationMs)
    .put("validUntil", snapshot.validUntil)
    .put("localReady", snapshot.localReady)
    .put("nodes", JSONArray(snapshot.nodeOutcomes.take(16).map { outcome ->
        JSONObject()
            .put("nodeId", outcome.nodeId.take(32))
            .put("ok", outcome.ok.coerceIn(0, 3))
            .put("timeout", outcome.timeout.coerceIn(0, 3))
            .put("networkError", outcome.networkError.coerceIn(0, 3))
    })).toString()
