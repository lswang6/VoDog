package org.vodog

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

data class MediaProbeNode(
    val nodeId: String,
    val probeUrl: String,
    val expiresAt: String,
    val grants: List<String>,
)

data class MediaProbeOptions(
    val networkGeneration: String,
    val expiresAt: String,
    val nodes: List<MediaProbeNode>,
)

data class MediaProbeSample(
    val nodeId: String,
    val outcome: String,
    val httpsRttMs: Double? = null,
)

internal interface MediaProbeControl {
    fun probeOptions(networkGeneration: String): MediaProbeOptions
    fun submitProbeResults(networkGeneration: String, samples: List<MediaProbeSample>): String
}

internal fun interface MediaProbeGeneration {
    fun current(): String
}

internal fun interface MediaProbeNodeRunner {
    fun measure(node: MediaProbeNode): List<MediaProbeSample>
}

internal class MediaProbeCoordinator(
    private val control: MediaProbeControl,
    private val generation: MediaProbeGeneration,
    private val runner: MediaProbeNodeRunner,
    private val now: () -> Instant = Instant::now,
) {
    private val mutex = Mutex()
    private val invalidation = AtomicLong()
    @Volatile
    private var accepted: AcceptedProbe? = null

    suspend fun ensureCurrent(): String = mutex.withLock {
        val token = invalidation.get()
        val current = generation.current()
        accepted?.takeIf { it.networkGeneration == current && now().isBefore(it.expiresAt) }
            ?.let { return@withLock current }
        val options = withContext(Dispatchers.IO) { control.probeOptions(current) }
        require(options.networkGeneration == current && options.nodes.isNotEmpty()) { "probe options identity mismatch" }
        require(generation.current() == current) { "network changed during probe setup" }
        val samples = coroutineScope {
            options.nodes.map { node -> async(Dispatchers.IO) { runner.measure(node) } }.awaitAll().flatten()
        }
        require(generation.current() == current) { "network changed during probe measurement" }
        val acceptedUntil = withContext(Dispatchers.IO) { control.submitProbeResults(current, samples) }
        require(generation.current() == current) { "network changed before probe results were accepted" }
        require(invalidation.get() == token) { "probe session changed" }
        val expiry = minOf(Instant.parse(options.expiresAt), Instant.parse(acceptedUntil))
        require(now().isBefore(expiry)) { "probe evidence already expired" }
        accepted = AcceptedProbe(current, expiry)
        current
    }

    fun invalidate() {
        invalidation.incrementAndGet()
        accepted = null
    }

    private data class AcceptedProbe(val networkGeneration: String, val expiresAt: Instant)
}

internal class HttpsMediaProbeRunner(
    private val connectionFactory: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val nanoTime: () -> Long = System::nanoTime,
) : MediaProbeNodeRunner {
    override fun measure(node: MediaProbeNode): List<MediaProbeSample> {
        require(node.nodeId.isNotBlank() && node.probeUrl.startsWith("https://")) { "invalid probe target" }
        require(node.grants.size == 3 && node.grants.all(String::isNotBlank)) { "three probe grants required" }
        return node.grants.map { grant -> measureGrant(node, grant) }
    }

    private fun measureGrant(node: MediaProbeNode, grant: String): MediaProbeSample {
        val connection = connectionFactory(URL(node.probeUrl))
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = PROBE_TIMEOUT_MS
            connection.readTimeout = PROBE_TIMEOUT_MS
            connection.useCaches = false
            connection.doOutput = false
            connection.setRequestProperty("Authorization", "Bearer $grant")
            val started = nanoTime()
            val status = connection.responseCode
            val elapsed = (nanoTime() - started).coerceAtLeast(0L) / 1_000_000.0
            if (status != 200) return MediaProbeSample(node.nodeId, "network_error")
            val response = connection.inputStream.use { it.readBounded(PROBE_RESPONSE_LIMIT) }
            val json = JSONObject(response)
            if (!json.optBoolean("ok") || json.optString("nodeId") != node.nodeId) {
                return MediaProbeSample(node.nodeId, "network_error")
            }
            return MediaProbeSample(node.nodeId, "ok", elapsed.coerceAtMost(10_000.0))
        } catch (_: SocketTimeoutException) {
            return MediaProbeSample(node.nodeId, "timeout")
        } catch (_: Exception) {
            return MediaProbeSample(node.nodeId, "network_error")
        } finally {
            connection.disconnect()
        }
    }
}

internal class AndroidMediaProbeGeneration(context: Context) : MediaProbeGeneration, Closeable {
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

    override fun current(): String = synchronized(lock) {
        refreshLocked()
        generation
    }

    private fun refresh() = synchronized(lock) { refreshLocked() }

    private fun refreshLocked() {
        val network = connectivity.activeNetwork
        val capabilities = network?.let(connectivity::getNetworkCapabilities)
        val links = network?.let(connectivity::getLinkProperties)
        val next = buildString {
            append(network?.networkHandle ?: -1L)
            append('|')
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

    override fun close() {
        runCatching { connectivity.unregisterNetworkCallback(callback) }
    }
}

internal fun parseMediaProbeOptions(json: JSONObject): MediaProbeOptions {
    val generation = json.getString("networkGeneration").also { require(it.length in 1..96) }
    val nodes = json.getJSONArray("nodes")
    require(nodes.length() in 1..48) { "invalid probe node count" }
    return MediaProbeOptions(
        generation,
        json.getString("expiresAt"),
        List(nodes.length()) { index -> nodes.getJSONObject(index).let { node ->
            val grants = node.getJSONArray("grants")
            MediaProbeNode(
                node.getString("nodeId").also { require(it.isNotBlank()) },
                node.getString("probeUrl").also { require(it.startsWith("https://")) },
                node.getString("expiresAt"),
                List(grants.length()) { grants.getString(it) },
            )
        } },
    )
}

internal fun samplesJson(samples: List<MediaProbeSample>): JSONArray = JSONArray().also { array ->
    require(samples.size in 1..48)
    samples.forEach { sample ->
        require(sample.outcome in setOf("ok", "timeout", "network_error"))
        array.put(JSONObject().put("nodeId", sample.nodeId).put("outcome", sample.outcome).also { json ->
            if (sample.outcome == "ok") json.put("httpsRttMs", requireNotNull(sample.httpsRttMs))
        })
    }
}

private fun java.io.InputStream.readBounded(limit: Int): String {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(1024)
    while (output.size() <= limit) {
        val count = read(buffer, 0, minOf(buffer.size, limit + 1 - output.size()))
        if (count < 0) break
        output.write(buffer, 0, count)
    }
    require(output.size() <= limit) { "probe response too large" }
    return output.toString(Charsets.UTF_8.name())
}

private const val PROBE_TIMEOUT_MS = 2_000
private const val PROBE_RESPONSE_LIMIT = 16 * 1024
