package org.vodog.gateway.media

import android.content.Context
import org.vodog.gateway.BuildConfig
import org.vodog.gateway.GatewayApiRoutes
import org.vodog.gateway.GatewayEndpoint
import org.vodog.gateway.GatewayHttpRequest
import org.vodog.gateway.GatewayHttpTransport
import org.vodog.gateway.OwnedGatewayHttpTransport
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import java.io.Closeable
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class MediaIceServer(
    val urls: List<String>,
    val username: String,
    val credential: String,
    /** S71: TLS SNI / certificate name for a TURN URL whose host is an IP (the relay-node relay). */
    val hostname: String? = null,
)

/** S71 `media.session_end.turnHost`: the host part of `turn(s):host:port?...`. */
internal fun turnUrlHost(url: String): String? =
    url.substringAfter(':', "").substringBefore('?').substringBeforeLast(':').takeIf(String::isNotBlank)

data class MediaOptions(
    val iceServers: List<MediaIceServer>,
    val iceTransportPolicy: String,
    /** S73b: Control handed out the S71 relay TURN (relay-node tunnel to control-node), which only carries TLS. */
    val relay: Boolean = false,
)

data class MediaSessionDescription(val type: String, val sdp: String)

data class MediaCaptureRequest(
    val deviceCallId: String,
    val telecomCreationTimeMillis: Long,
)

data class MediaCaptureBinding(
    val id: String,
    val callId: String,
    val deviceCallId: String,
    val telecomCreationTimeMillis: Long,
    val captureGeneration: Long,
    val mediaNodeId: String,
    val mediaEpoch: Long,
    val createdAt: String,
)

enum class IceTransport(val wireValue: String) { UDP("udp"), TLS("tls") }

interface GatewayMediaSignaling : Closeable {
    suspend fun options(callId: String, transport: IceTransport = IceTransport.UDP): MediaOptions
    suspend fun offer(callId: String, offer: MediaSessionDescription): MediaSessionDescription
    override fun close() = Unit
}

class HttpGatewayMediaSignaling(
    context: Context,
    private val deviceToken: String,
    private val apiBaseUrlOverride: String? = null,
    private val transport: GatewayHttpTransport = OwnedGatewayHttpTransport(),
    private val captureRequest: MediaCaptureRequest? = null,
    private val probeReadiness: GatewayProbeReadinessProvider,
) : GatewayMediaSignaling {
    @Volatile var captureBinding: MediaCaptureBinding? = null
        private set
    @Volatile private var authorizedNetworkGeneration: String? = null
    override suspend fun options(callId: String, transport: IceTransport): MediaOptions {
        authorizedNetworkGeneration = null
        val probe = probeReadiness.ensureCurrent()
        // S71: the relay path goes through the relay-node tunnel, not the probed node path.
        val relay = GatewayEndpoint.relay
        require(relay || probe.hasReachableNode) { "gateway has no reachable media node" }
        val networkGeneration = probe.networkGeneration
        val body = mediaOptionsRequestBody(transport, networkGeneration, relay, captureRequest)
        val json = retryMediaNodePending {
            withProbeGenerationFence(probeReadiness, networkGeneration) {
                post(
                    GatewayApiRoutes.mediaOptions(callId),
                    body,
                )
            }
        }
        captureBinding = optionsCaptureBinding(json, callId, captureRequest)
        val policy = json.getString("iceTransportPolicy")
        require(policy == "relay") { "gateway media must use relay ICE" }
        val servers = parseMediaOptionsIceServers(json, transport)
        probeReadiness.requireCurrent(networkGeneration)
        return MediaOptions(servers, policy, relay = json.optBoolean("relay", false)).also {
            // Publish only after the complete options response has passed every relay/capture check.
            authorizedNetworkGeneration = networkGeneration
        }
    }

    override suspend fun offer(callId: String, offer: MediaSessionDescription): MediaSessionDescription {
        require(offer.type == "offer")
        val networkGeneration = authorizedNetworkGeneration
        val json = retryMediaNodePending {
            withAuthorizedProbeGenerationFence(probeReadiness, networkGeneration) {
                post(
                    GatewayApiRoutes.mediaOffer(callId),
                    JSONObject().put("type", offer.type).put("sdp", offer.sdp),
                )
            }
        }
        return MediaSessionDescription(json.getString("type"), json.getString("sdp")).also {
            require(it.type == "answer") { "expected media answer" }
            probeReadiness.requireCurrent(requireNotNull(networkGeneration))
        }
    }

    private suspend fun post(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        require(deviceToken.isNotBlank())
        val response = transport.execute(GatewayHttpRequest(
            url = (apiBaseUrlOverride ?: GatewayEndpoint.baseUrl()) + path,
            method = "POST",
            authorization = "Bearer $deviceToken",
            jsonBody = body.toString().toByteArray(),
            timeoutMs = 20_000,
            responseLimitBytes = MAX_SIGNALING_RESPONSE_BYTES,
        ))
        if (response.status !in 200..299) {
            val error = runCatching { JSONObject(response.body).getJSONObject("error") }.getOrNull()
            val code = error?.optString("code").orEmpty().ifBlank { "HTTP_${response.status}" }
            val message = error?.optString("message").orEmpty().ifBlank { "gateway media request failed" }
            throw GatewayMediaHttpException(response.status, code, message)
        }
        JSONObject(response.body)
    }

    override fun close() {
        authorizedNetworkGeneration = null
        transport.close()
    }
}

internal class GatewayMediaProbeOwner(
    context: Context,
    private val deviceToken: String,
    private val apiBaseUrlOverride: String? = null,
    private val transport: GatewayHttpTransport = OwnedGatewayHttpTransport(),
) : GatewayProbeReadinessProvider, Closeable {
    private val closed = AtomicBoolean(false)
    private val generation = AndroidGatewayProbeGeneration(context.applicationContext)
    private val qualityTransport = OwnedGatewayHttpTransport()
    private val qualityRunner = GatewayWebRtcQualityRunner(context.applicationContext)
    private val quality = GatewayMediaQualityProbe(
        object : GatewayQualityControl {
            override suspend fun options(networkGeneration: String) = parseGatewayQualityOptions(
                qualityPost("/gateway/media/quality-probes/options", JSONObject().put("networkGeneration", networkGeneration)),
            )
            override suspend fun results(networkGeneration: String, samples: List<GatewayQualitySample>) = qualityPost(
                "/gateway/media/quality-probes/results",
                JSONObject().put("networkGeneration", networkGeneration).put("samples", gatewayQualitySamplesJson(samples)),
            ).getInt("accepted")
        },
        qualityRunner,
        generation,
        diagnostics = GatewayMediaQualityDiagnosticStore(context),
        closed = closed::get,
    )
    private val coordinator = GatewayMediaProbeCoordinator(
        object : GatewayProbeControl {
            override suspend fun options(networkGeneration: String): GatewayProbeOptions = parseGatewayProbeOptions(
                post(GatewayApiRoutes.MEDIA_PROBE_OPTIONS, JSONObject().put("networkGeneration", networkGeneration)),
            )

            override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>): String {
                val expiresAt = post(
                    GatewayApiRoutes.MEDIA_PROBE_RESULTS,
                    JSONObject().put("networkGeneration", networkGeneration).put("samples", gatewaySamplesJson(samples)),
                ).getString("expiresAt")
                // Relay quality is observability only. A WebRTC timeout here must never mark the
                // reachability probe failed, which would withdraw mediaReady during a live call.
                runCatching { quality.measure(networkGeneration) }
                    .exceptionOrNull()?.let { if (it is CancellationException) throw it }
                return expiresAt
            }
        },
        generation,
        GatewayTransportProbeRunner(transport),
        diagnostics = GatewayProbeDiagnosticStore(context),
    )

    override suspend fun ensureCurrent(): GatewayProbeReadiness {
        check(!closed.get()) { "gateway media probe owner closed" }
        return coordinator.ensureCurrent().also {
            check(!closed.get()) { "gateway media probe owner closed" }
        }
    }

    override fun requireCurrent(networkGeneration: String) {
        check(!closed.get()) { "gateway media probe owner closed" }
        coordinator.requireCurrentGeneration(networkGeneration)
        check(!closed.get()) { "gateway media probe owner closed" }
    }

    fun peekCurrent(): GatewayProbeReadiness? = if (closed.get()) null else coordinator.peekCurrent()

    fun peekLastAccepted(): GatewayProbeReadiness? = if (closed.get()) null else coordinator.peekLastAccepted()

    suspend fun refreshNow(): GatewayProbeReadiness {
        check(!closed.get()) { "gateway media probe owner closed" }
        return coordinator.ensureCurrent(forceRefresh = true).also {
            check(!closed.get()) { "gateway media probe owner closed" }
        }
    }

    private suspend fun post(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        require(deviceToken.isNotBlank())
        val response = transport.execute(GatewayHttpRequest(
            url = (apiBaseUrlOverride ?: GatewayEndpoint.baseUrl()) + path,
            method = "POST",
            authorization = "Bearer $deviceToken",
            jsonBody = body.toString().toByteArray(),
            timeoutMs = 20_000,
            responseLimitBytes = MAX_SIGNALING_RESPONSE_BYTES,
        ))
        if (response.status !in 200..299) {
            val error = runCatching { JSONObject(response.body).getJSONObject("error") }.getOrNull()
            throw GatewayMediaHttpException(
                response.status,
                error?.optString("code").orEmpty().ifBlank { "HTTP_${response.status}" },
                error?.optString("message").orEmpty().ifBlank { "gateway media probe request failed" },
            )
        }
        JSONObject(response.body)
    }

    private suspend fun qualityPost(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        require(deviceToken.isNotBlank())
        val response = qualityTransport.execute(GatewayHttpRequest(
            url = (apiBaseUrlOverride ?: GatewayEndpoint.baseUrl()) + path,
            method = "POST",
            authorization = "Bearer $deviceToken",
            jsonBody = body.toString().toByteArray(),
            timeoutMs = 20_000,
            responseLimitBytes = MAX_SIGNALING_RESPONSE_BYTES,
        ))
        if (response.status !in 200..299) {
            val error = runCatching { JSONObject(response.body).getJSONObject("error") }.getOrNull()
            throw GatewayMediaHttpException(
                response.status,
                error?.optString("code").orEmpty().ifBlank { "HTTP_${response.status}" },
                error?.optString("message").orEmpty().ifBlank { "gateway quality probe request failed" },
            )
        }
        JSONObject(response.body)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        qualityRunner.close()
        qualityTransport.close()
        transport.close()
        generation.close()
    }
}

internal fun parseCaptureBinding(
    value: JSONObject,
    callId: String,
    expected: MediaCaptureRequest,
): MediaCaptureBinding = MediaCaptureBinding(
    id = value.getString("id"),
    callId = value.getString("callId"),
    deviceCallId = value.getString("deviceCallId"),
    telecomCreationTimeMillis = value.getLong("telecomCreationTimeMillis"),
    captureGeneration = value.getLong("captureGeneration"),
    mediaNodeId = value.getString("mediaNodeId"),
    mediaEpoch = value.getLong("mediaEpoch"),
    createdAt = value.getString("createdAt"),
).also { parsed ->
    require(UUID.fromString(parsed.id).toString() == parsed.id && UUID.fromString(parsed.callId).toString() == parsed.callId)
    Instant.parse(parsed.createdAt)
    require(parsed.callId == callId && parsed.deviceCallId == expected.deviceCallId &&
        parsed.telecomCreationTimeMillis == expected.telecomCreationTimeMillis &&
        parsed.captureGeneration > 0 && parsed.mediaEpoch > 0 && parsed.mediaNodeId.isNotBlank()) {
        "capture binding does not match exact active call"
    }
}

/** S56: an options call made without `capture` (early media) is valid without a binding; one made with it is not. */
internal fun optionsCaptureBinding(json: JSONObject, callId: String, requested: MediaCaptureRequest?): MediaCaptureBinding? =
    requested?.let {
        parseCaptureBinding(json.optJSONObject("captureBinding") ?: error("capture binding missing from media options"), callId, it)
    }

internal class GatewayMediaHttpException(
    val status: Int,
    val code: String,
    override val message: String,
) : Exception(message)

/**
 * Control answers 409 with one of these while a fact it needs is still in flight: the winning
 * client has not pinned a media node yet, or (S22) the gateway's own next Telecom snapshot has not
 * yet confirmed the call it just answered as active. Media setup starts on the device's ACTIVE
 * transition, which is up to one heartbeat ahead of that snapshot, so these are retried within the
 * same bounded window instead of failing the setup and releasing the audio handoff.
 */
internal val MEDIA_SETUP_TRANSIENT_409_CODES = setOf("MEDIA_NODE_PENDING", "CAPTURE_NOT_ACTIVE", "CAPTURE_NOT_CONFIRMED")

internal fun isTransientMediaSetupError(error: GatewayMediaHttpException): Boolean =
    error.status == 409 && error.code in MEDIA_SETUP_TRANSIENT_409_CODES

internal suspend fun <T> retryMediaNodePending(
    timeoutMs: Long = 12_000,
    delays: LongArray = longArrayOf(250, 500, 1_000, 1_500, 2_000, 2_500, 3_000),
    action: suspend () -> T,
): T = withTimeout(timeoutMs) {
    require(delays.isNotEmpty() && delays.all { it >= 0 })
    var attempt = 0
    while (true) {
        try {
            return@withTimeout action()
        } catch (error: GatewayMediaHttpException) {
            if (!isTransientMediaSetupError(error)) throw error
            delay(delays[minOf(attempt, delays.lastIndex)])
            attempt += 1
        }
    }
    @Suppress("UNREACHABLE_CODE")
    error("unreachable")
}

private inline fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> =
    List(length()) { transform(getJSONObject(it)) }

internal fun mediaOptionsRequestBody(
    transport: IceTransport,
    networkGeneration: String,
    relay: Boolean,
    captureRequest: MediaCaptureRequest?,
): JSONObject = JSONObject().put("transport", transport.wireValue).put("networkGeneration", networkGeneration)
    .put("relay", relay)
    .also { body ->
        captureRequest?.let { capture ->
            body.put("capture", JSONObject()
                .put("deviceCallId", capture.deviceCallId)
                .put("telecomCreationTimeMillis", capture.telecomCreationTimeMillis))
        }
    }

/** Exactly one TURN URL matching [transport]; S71 allows an IP host when a TLS `hostname` is supplied. */
internal fun parseMediaOptionsIceServers(json: JSONObject, transport: IceTransport): List<MediaIceServer> {
    val servers = json.getJSONArray("iceServers").mapObjects { server ->
        val urlsJson = server.getJSONArray("urls")
        MediaIceServer(
            urls = List(urlsJson.length()) { urlsJson.getString(it) },
            username = server.optString("username"),
            credential = server.optString("credential"),
            hostname = server.optString("hostname").takeIf(String::isNotBlank),
        )
    }
    require(servers.isNotEmpty() && servers.all { it.urls.isNotEmpty() }) { "missing relay ICE server" }
    require(servers.sumOf { it.urls.size } == 1) { "exactly one TURN URL is required per media grant" }
    val onlyUrl = servers.single().urls.single()
    require(
        (transport == IceTransport.UDP && onlyUrl.startsWith("turn:") && "transport=udp" in onlyUrl) ||
            (transport == IceTransport.TLS && onlyUrl.startsWith("turns:") && "transport=tcp" in onlyUrl)
    ) { "TURN URL does not match requested transport" }
    servers.single().hostname?.let { hostname ->
        require(transport == IceTransport.TLS && TURN_HOSTNAME.matches(hostname)) { "invalid TURN hostname" }
    }
    return servers
}

private const val MAX_SIGNALING_RESPONSE_BYTES = 1024 * 1024
private val TURN_HOSTNAME = Regex("^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", RegexOption.IGNORE_CASE)
