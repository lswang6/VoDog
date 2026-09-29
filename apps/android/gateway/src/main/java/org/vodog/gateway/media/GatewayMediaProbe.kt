package org.vodog.gateway.media

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import org.vodog.gateway.GatewayHttpRequest
import org.vodog.gateway.GatewayHttpResponse
import org.vodog.gateway.GatewayHttpTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.InterruptedIOException
import java.time.Instant
import java.util.UUID

internal data class GatewayProbeNode(
    val nodeId: String,
    val probeUrl: String,
    val expiresAt: String,
    val grants: List<String>,
)

internal data class GatewayProbeOptions(
    val networkGeneration: String,
    val expiresAt: String,
    val nodes: List<GatewayProbeNode>,
)

internal data class GatewayProbeSample(val nodeId: String, val outcome: String, val httpsRttMs: Double? = null)

internal interface GatewayProbeControl {
    suspend fun options(networkGeneration: String): GatewayProbeOptions
    suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>): String
}

internal fun interface GatewayProbeGeneration { fun current(): String }
internal fun interface GatewayProbeRunner { fun measure(node: GatewayProbeNode): List<GatewayProbeSample> }
internal fun interface GatewayProbeDiagnosticRecorder { fun record(snapshot: GatewayProbeDiagnosticSnapshot) }

internal data class GatewayProbeNodeOutcomes(
    val nodeId: String,
    val ok: Int,
    val timeout: Int,
    val networkError: Int,
)

/** One bounded, content-free summary of the most recent probe attempt. */
internal data class GatewayProbeDiagnosticSnapshot(
    val generation: String,
    val stage: String,
    val optionsStatus: String,
    val optionsDurationMs: Long?,
    val resultsStatus: String,
    val resultsDurationMs: Long?,
    val nodeOutcomes: List<GatewayProbeNodeOutcomes>,
    val validUntil: String?,
    val localReady: Boolean,
)

data class GatewayProbeReadiness(
    val networkGeneration: String,
    val hasReachableNode: Boolean,
    val validUntil: Instant,
    /**
     * When the control service accepted this evidence. Retention after expiry is measured from here,
     * so it must never be derived from the caller's clock. The default reconstructs it from the local
     * reuse window for callers that only know the expiry.
     */
    val acceptedAt: Instant = validUntil.minusSeconds(30),
)

interface GatewayProbeReadinessProvider {
    suspend fun ensureCurrent(): GatewayProbeReadiness
    fun requireCurrent(networkGeneration: String)
}

internal class GatewayMediaProbeCoordinator(
    private val control: GatewayProbeControl,
    private val generation: GatewayProbeGeneration,
    private val runner: GatewayProbeRunner,
    private val localReuseSeconds: Long = 30,
    private val diagnostics: GatewayProbeDiagnosticRecorder = GatewayProbeDiagnosticRecorder {},
    private val elapsedRealtimeMs: () -> Long = { System.nanoTime() / 1_000_000 },
    private val now: () -> Instant = Instant::now,
) {
    private val mutex = Mutex()
    @Volatile private var accepted: Accepted? = null

    init { require(localReuseSeconds in 1..120) }

    fun peekCurrent(): GatewayProbeReadiness? {
        val current = generation.current()
        return accepted?.takeIf { it.generation == current && now().isBefore(it.expiresAt) }
            ?.let { GatewayProbeReadiness(current, it.hasReachableNode, it.expiresAt, it.acceptedAt) }
    }

    /** The most recent accepted evidence, expired or not. Retention policy decides whether it still counts. */
    fun peekLastAccepted(): GatewayProbeReadiness? = accepted?.let {
        GatewayProbeReadiness(it.generation, it.hasReachableNode, it.expiresAt, it.acceptedAt)
    }

    fun requireCurrentGeneration(expected: String) {
        check(generation.current() == expected) { "probe network generation changed" }
    }

    suspend fun ensureCurrent(forceRefresh: Boolean = false): GatewayProbeReadiness = mutex.withLock {
        val current = generation.current()
        if (!forceRefresh) accepted?.takeIf { it.generation == current && now().isBefore(it.expiresAt) }
            ?.let { return@withLock GatewayProbeReadiness(current, it.hasReachableNode, it.expiresAt, it.acceptedAt) }
        var stage = "options"
        var optionsStatus = "not_started"
        var optionsDurationMs: Long? = null
        var resultsStatus = "not_started"
        var resultsDurationMs: Long? = null
        var samples = emptyList<GatewayProbeSample>()
        try {
            val optionsStarted = elapsedRealtimeMs()
            val options = try {
                control.options(current).also { optionsStatus = "ok" }
            } catch (error: Exception) {
                optionsStatus = diagnosticStatus(error)
                throw error
            } finally {
                optionsDurationMs = boundedDuration(optionsStarted, elapsedRealtimeMs())
            }
            require(options.networkGeneration == current && options.nodes.isNotEmpty()) { "probe options identity mismatch" }
            require(generation.current() == current) { "network changed during probe setup" }
            stage = "measure"
            samples = coroutineScope {
                options.nodes.map { async(Dispatchers.IO) { runner.measure(it) } }.awaitAll()
            }.flatten()
            require(generation.current() == current) { "network changed during probe measurement" }
            stage = "results"
            val resultsStarted = elapsedRealtimeMs()
            val acceptedUntil = try {
                control.results(current, samples).also { resultsStatus = "ok" }
            } catch (error: Exception) {
                resultsStatus = diagnosticStatus(error)
                throw error
            } finally {
                resultsDurationMs = boundedDuration(resultsStarted, elapsedRealtimeMs())
            }
            require(generation.current() == current) { "network changed before probe results were accepted" }
            val expiry = minOf(
                Instant.parse(options.expiresAt),
                Instant.parse(acceptedUntil),
                now().plusSeconds(localReuseSeconds),
            )
            require(now().isBefore(expiry)) { "probe evidence already expired" }
            val reachable = samples.groupBy { it.nodeId }.values.any { attempts ->
                val successes = attempts.count { it.outcome == "ok" }
                successes >= 2 && successes * 3 >= attempts.size * 2
            }
            val acceptedAt = now()
            accepted = Accepted(current, expiry, reachable, acceptedAt)
            recordDiagnostic(diagnosticSnapshot(current, "accepted", optionsStatus, optionsDurationMs,
                resultsStatus, resultsDurationMs, samples, expiry.toString(), reachable))
            GatewayProbeReadiness(current, reachable, expiry, acceptedAt)
        } catch (cancelled: CancellationException) {
            recordDiagnostic(diagnosticSnapshot(current, "cancelled", optionsStatus, optionsDurationMs,
                resultsStatus, resultsDurationMs, samples, null, false))
            throw cancelled
        } catch (error: Exception) {
            recordDiagnostic(diagnosticSnapshot(current, stage, optionsStatus, optionsDurationMs,
                resultsStatus, resultsDurationMs, samples, null, false))
            throw error
        }
    }

    private data class Accepted(
        val generation: String,
        val expiresAt: Instant,
        val hasReachableNode: Boolean,
        val acceptedAt: Instant,
    )
    private fun recordDiagnostic(snapshot: GatewayProbeDiagnosticSnapshot) {
        // Observability must never change readiness or retry behavior.
        runCatching { diagnostics.record(snapshot) }
    }
}

internal suspend fun <T> withProbeGenerationFence(
    provider: GatewayProbeReadinessProvider,
    networkGeneration: String,
    operation: suspend () -> T,
): T {
    provider.requireCurrent(networkGeneration)
    return operation().also { provider.requireCurrent(networkGeneration) }
}

internal suspend fun <T> withAuthorizedProbeGenerationFence(
    provider: GatewayProbeReadinessProvider,
    authorizedNetworkGeneration: String?,
    operation: suspend () -> T,
): T = withProbeGenerationFence(
    provider,
    checkNotNull(authorizedNetworkGeneration) { "media options must authorize a network generation before offer" },
    operation,
)

private fun boundedDuration(started: Long, ended: Long): Long = (ended - started).coerceIn(0, 120_000)

private fun diagnosticStatus(error: Exception): String = when (error) {
    is CancellationException -> "cancelled"
    is GatewayMediaHttpException -> "http_${error.status.coerceIn(100, 599)}"
    is InterruptedIOException -> "timeout"
    else -> "failed"
}

private fun diagnosticSnapshot(
    generation: String,
    stage: String,
    optionsStatus: String,
    optionsDurationMs: Long?,
    resultsStatus: String,
    resultsDurationMs: Long?,
    samples: List<GatewayProbeSample>,
    validUntil: String?,
    localReady: Boolean,
) = GatewayProbeDiagnosticSnapshot(
    generation = generation.take(96),
    stage = stage,
    optionsStatus = optionsStatus,
    optionsDurationMs = optionsDurationMs,
    resultsStatus = resultsStatus,
    resultsDurationMs = resultsDurationMs,
    nodeOutcomes = samples.groupBy { it.nodeId }.entries.take(16).map { (nodeId, attempts) ->
        GatewayProbeNodeOutcomes(
            nodeId.take(32),
            attempts.count { it.outcome == "ok" },
            attempts.count { it.outcome == "timeout" },
            attempts.count { it.outcome == "network_error" },
        )
    },
    validUntil = validUntil,
    localReady = localReady,
)

internal class GatewayTransportProbeRunner(
    private val transport: GatewayHttpTransport,
    private val nanoTime: () -> Long = System::nanoTime,
) : GatewayProbeRunner {
    override fun measure(node: GatewayProbeNode): List<GatewayProbeSample> {
        require(node.nodeId.isNotBlank() && node.probeUrl.startsWith("https://")) { "invalid probe target" }
        require(node.grants.size == 3 && node.grants.all(String::isNotBlank)) { "three probe grants required" }
        return node.grants.map { grant ->
            try {
                val started = nanoTime()
                val response = transport.execute(GatewayHttpRequest(
                    url = node.probeUrl,
                    method = "POST",
                    authorization = "Bearer $grant",
                    timeoutMs = PROBE_TIMEOUT_MS.toLong(),
                    responseLimitBytes = PROBE_RESPONSE_LIMIT,
                ))
                val elapsed = (nanoTime() - started).coerceAtLeast(0L) / 1_000_000.0
                val json = runCatching { JSONObject(response.body) }.getOrNull()
                if (response.status == 200 && json?.optBoolean("ok") == true && json.optString("nodeId") == node.nodeId) {
                    GatewayProbeSample(node.nodeId, "ok", elapsed.coerceAtMost(10_000.0))
                } else GatewayProbeSample(node.nodeId, "network_error")
            } catch (_: java.io.InterruptedIOException) {
                GatewayProbeSample(node.nodeId, "timeout")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                GatewayProbeSample(node.nodeId, "network_error")
            }
        }
    }
}

internal class AndroidGatewayProbeGeneration(context: Context) : GatewayProbeGeneration, Closeable {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val lock = Any()
    private var signature: String? = null
    private var generation = UUID.randomUUID().toString()
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = refresh()
        override fun onLost(network: Network) = refresh()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = refresh()
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) = refresh()
    }

    init {
        refresh()
        connectivity.registerDefaultNetworkCallback(callback)
    }

    override fun current(): String = synchronized(lock) { refreshLocked(); generation }
    private fun refresh() = synchronized(lock) { refreshLocked() }

    private fun refreshLocked() {
        val network = connectivity.activeNetwork
        val capabilities = network?.let(connectivity::getNetworkCapabilities)
        val links = network?.let(connectivity::getLinkProperties)
        val next = buildString {
            append(network?.networkHandle ?: -1L).append('|')
            listOf(
                NetworkCapabilities.TRANSPORT_CELLULAR,
                NetworkCapabilities.TRANSPORT_WIFI,
                NetworkCapabilities.TRANSPORT_ETHERNET,
                NetworkCapabilities.TRANSPORT_VPN,
            ).forEach { append(if (capabilities?.hasTransport(it) == true) '1' else '0') }
            append('|').append(links?.interfaceName.orEmpty())
            append('|').append(links?.linkAddresses?.map { it.toString() }?.sorted()?.joinToString(",").orEmpty())
        }
        if (signature != null && signature != next) generation = UUID.randomUUID().toString()
        signature = next
    }

    override fun close() { runCatching { connectivity.unregisterNetworkCallback(callback) } }
}

internal fun parseGatewayProbeOptions(json: JSONObject): GatewayProbeOptions {
    val generation = json.getString("networkGeneration").also { require(it.length in 1..96) }
    val nodes = json.getJSONArray("nodes")
    require(nodes.length() in 1..48)
    return GatewayProbeOptions(generation, json.getString("expiresAt"), List(nodes.length()) { index ->
        nodes.getJSONObject(index).let { node ->
            val grants = node.getJSONArray("grants")
            GatewayProbeNode(
                node.getString("nodeId").also { require(it.isNotBlank()) },
                node.getString("probeUrl").also { require(it.startsWith("https://")) },
                node.getString("expiresAt"),
                List(grants.length()) { grants.getString(it) },
            )
        }
    })
}

internal fun gatewaySamplesJson(samples: List<GatewayProbeSample>): JSONArray = JSONArray().also { array ->
    require(samples.size in 1..48)
    samples.forEach { sample ->
        require(sample.outcome in setOf("ok", "timeout", "network_error"))
        array.put(JSONObject().put("nodeId", sample.nodeId).put("outcome", sample.outcome).also { json ->
            if (sample.outcome == "ok") json.put("httpsRttMs", requireNotNull(sample.httpsRttMs))
        })
    }
}

private const val PROBE_TIMEOUT_MS = 2_000
private const val PROBE_RESPONSE_LIMIT = 16 * 1024
