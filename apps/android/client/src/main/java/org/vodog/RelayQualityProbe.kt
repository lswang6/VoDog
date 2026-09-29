package org.vodog

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.io.Closeable
import java.io.IOException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.ceil

data class RelayProbeIceServer(val urls: List<String>, val username: String, val credential: String)
data class RelayProbeNode(
    val nodeId: String,
    val probeUrl: String,
    val expiresAt: String,
    val grant: String,
    val iceServers: List<RelayProbeIceServer>,
)
data class RelayProbeOptions(
    val networkGeneration: String,
    val lifetimeMs: Int,
    val sampleDurationMs: Int,
    val packetIntervalMs: Int,
    val maxPackets: Int,
    val maxPacketBytes: Int,
    val nodes: List<RelayProbeNode>,
)
data class RelayProbeSample(
    val nodeId: String,
    val outcome: String,
    val sent: Int,
    val received: Int,
    val sampleDurationMs: Double,
    val connectionMs: Double? = null,
    val rttMedianMs: Double? = null,
    val rttP95Ms: Double? = null,
    val jitterMs: Double? = null,
)

internal interface RelayProbeControl {
    suspend fun relayProbeOptions(networkGeneration: String): RelayProbeOptions
    suspend fun submitRelayProbeResults(networkGeneration: String, samples: List<RelayProbeSample>): String
}

internal fun interface RelayProbeNodeRunner {
    suspend fun measure(node: RelayProbeNode, remainsCurrent: () -> Boolean): RelayProbeSample
}

internal class RelayQualityProbeCoordinator(
    private val legacy: MediaProbeCoordinator,
    private val control: RelayProbeControl,
    private val generation: MediaProbeGeneration,
    private val runner: RelayProbeNodeRunner,
    private val sessionRemainsCurrent: () -> Boolean,
    private val now: () -> Instant = Instant::now,
) {
    private val mutex = Mutex()
    private val invalidation = AtomicLong()
    private val activeJob = AtomicReference<Job?>()
    private var accepted: AcceptedRelayProbe? = null
    private var unavailableForSession = false
    private var enrolledForSession = false

    suspend fun ensureCurrent(): String = mutex.withLock {
        val owner = checkNotNull(currentCoroutineContext()[Job]) { "relay probe requires a coroutine job" }
        val token = invalidation.get()
        check(activeJob.compareAndSet(null, owner)) { "relay probe already has an active owner" }
        try {
            if (invalidation.get() != token) throw CancellationException("relay probe invalidated before start")
            val current = legacy.ensureCurrent()
            currentCoroutineContext().ensureActive()
            check(invalidation.get() == token && generation.current() == current && sessionRemainsCurrent()) {
                "relay probe session changed before quality options"
            }
            accepted?.takeIf { it.networkGeneration == current && now().isBefore(it.expiresAt) }
                ?.let { return@withLock current }
            if (unavailableForSession) return@withLock current
            val options = try {
                control.relayProbeOptions(current)
            } catch (error: ApiError) {
                if (!enrolledForSession && error.status == 503 && error.code == "MEDIA_QUALITY_UNAVAILABLE") {
                    currentCoroutineContext().ensureActive()
                    check(invalidation.get() == token && generation.current() == current && sessionRemainsCurrent()) {
                        "relay probe unavailable result is stale"
                    }
                    unavailableForSession = true
                    return@withLock current
                }
                throw error
            }
            enrolledForSession = true
            require(options.networkGeneration == current && invalidation.get() == token &&
                generation.current() == current && sessionRemainsCurrent()) {
                "relay probe options are stale"
            }
            val samples = coroutineScope {
                options.nodes.map { node ->
                    async(Dispatchers.IO) {
                        runner.measure(node) {
                            invalidation.get() == token && generation.current() == current && sessionRemainsCurrent()
                        }
                    }
                }.awaitAll()
            }
            require(invalidation.get() == token && generation.current() == current && sessionRemainsCurrent()) { "relay probe session changed" }
            val expiresAt = control.submitRelayProbeResults(current, samples)
            require(invalidation.get() == token && generation.current() == current && sessionRemainsCurrent()) { "relay probe results are stale" }
            accepted = AcceptedRelayProbe(current, Instant.parse(expiresAt).also { require(now().isBefore(it)) })
            return current
        } finally {
            activeJob.compareAndSet(owner, null)
        }
    }

    fun invalidate() {
        invalidation.incrementAndGet()
        activeJob.getAndSet(null)?.cancel(CancellationException("relay probe invalidated"))
        accepted = null
        legacy.invalidate()
    }

    private data class AcceptedRelayProbe(val networkGeneration: String, val expiresAt: Instant)
}

internal class AndroidRelayProbeRunner(
    context: Context,
    private val nanoTime: () -> Long = System::nanoTime,
    private val signaler: RelayProbeSignaler = HttpRelayProbeSignaler(),
) : RelayProbeNodeRunner {
    private val app = context.applicationContext

    override suspend fun measure(node: RelayProbeNode, remainsCurrent: () -> Boolean): RelayProbeSample {
        val started = nanoTime()
        var collector: RelayEchoCollector? = null
        var sampleStarted: Long? = null
        var sent = 0
        return try {
            withTimeout(RELAY_LIFETIME_MS.toLong()) {
                check(remainsCurrent()) { "relay probe session changed" }
                AndroidWebRtcRuntime.initialize(app)
                val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
                var peer: PeerConnection? = null
                var channel: DataChannel? = null
                var fence: Job? = null
                try {
                    fence = launch {
                        while (true) {
                            check(remainsCurrent()) { "relay probe session changed" }
                            delay(25)
                        }
                    }
                    val gathering = CompletableDeferred<Unit>()
                    val connected = CompletableDeferred<Unit>()
                    val messages = RelayEchoCollector(nanoTime).also { collector = it }
                    val config = PeerConnection.RTCConfiguration(node.iceServers.map { server ->
                        PeerConnection.IceServer.builder(server.urls)
                            .setUsername(server.username)
                            .setPassword(server.credential)
                            .setTlsCertPolicy(PeerConnection.TlsCertPolicy.TLS_CERT_POLICY_SECURE)
                            .createIceServer()
                    }).apply {
                        iceTransportsType = PeerConnection.IceTransportsType.RELAY
                        sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                        continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
                    }
                    peer = factory.createPeerConnection(config, RelayPeerObserver(gathering, connected))
                        ?: error("cannot create relay probe peer")
                    channel = peer.createDataChannel(RELAY_LABEL, DataChannel.Init().apply {
                        ordered = false
                        maxRetransmits = 0
                    }) ?: error("cannot create relay probe channel")
                    channel.registerObserver(messages)
                    val offer = peer.createRelayOffer()
                    peer.setRelayDescription(offer, local = true)
                    gathering.await()
                    check(remainsCurrent()) { "relay probe session changed" }
                    val local = checkNotNull(peer.localDescription)
                    val completeOffer = completeRelayProbeSdp(local.description)
                    val answer = signaler.offer(node, completeOffer)
                    peer.setRelayDescription(SessionDescription(SessionDescription.Type.ANSWER, answer), local = false)
                    connected.await()
                    while (channel.state() != DataChannel.State.OPEN) {
                        check(remainsCurrent()) { "relay probe session changed" }
                        delay(10)
                    }
                    val connectionMs = elapsedMs(started, nanoTime()).coerceAtMost(RELAY_LIFETIME_MS.toDouble())
                    sampleStarted = nanoTime()
                    while (sent < RELAY_MAX_PACKETS && elapsedMs(checkNotNull(sampleStarted), nanoTime()) < RELAY_SAMPLE_MS) {
                        check(remainsCurrent()) { "relay probe session changed" }
                        val frame = relayProbeFrame(sent, nanoTime() / 1_000)
                        messages.recordSent(sent, frame.sentMicros)
                        if (channel.send(DataChannel.Buffer(ByteBuffer.wrap(frame.bytes), true))) sent++
                        delay(RELAY_INTERVAL_MS.toLong())
                    }
                    val duration = elapsedMs(checkNotNull(sampleStarted), nanoTime()).coerceAtMost(RELAY_LIFETIME_MS.toDouble())
                    while (messages.receivedCount < sent && elapsedMs(started, nanoTime()) < RELAY_LIFETIME_MS - 25) {
                        check(remainsCurrent()) { "relay probe session changed" }
                        delay(10)
                    }
                    messages.sample(node.nodeId, sent, duration, connectionMs)
                } finally {
                    fence?.cancel()
                    runCatching { channel?.unregisterObserver() }
                    runCatching { channel?.close() }
                    runCatching { channel?.dispose() }
                    runCatching { peer?.close() }
                    runCatching { peer?.dispose() }
                    runCatching { factory.dispose() }
                }
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            RelayProbeSample(
                node.nodeId, "timeout", sent, collector?.receivedCount ?: 0,
                sampleStarted?.let { elapsedMs(it, nanoTime()).coerceAtMost(RELAY_LIFETIME_MS.toDouble()) } ?: 0.0,
            )
        } catch (_: CancellationException) {
            throw CancellationException("relay probe cancelled")
        } catch (_: Exception) {
            RelayProbeSample(
                node.nodeId, "network_error", sent, collector?.receivedCount ?: 0,
                sampleStarted?.let { elapsedMs(it, nanoTime()).coerceAtMost(RELAY_LIFETIME_MS.toDouble()) } ?: 0.0,
            )
        }
    }
}

internal fun interface RelayProbeSignaler {
    suspend fun offer(node: RelayProbeNode, sdp: String): String
}

internal class HttpRelayProbeSignaler(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).writeTimeout(5, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build(),
) : RelayProbeSignaler {
    override suspend fun offer(node: RelayProbeNode, sdp: String): String {
        val request = Request.Builder().url(node.probeUrl)
            .header("Authorization", "Bearer ${node.grant}")
            .header("Accept", "application/json")
            .post(JSONObject().put("type", "offer").put("sdp", sdp).toString()
                .toRequestBody("application/json".toMediaType()))
            .build()
        val response = http.newCall(request).awaitRelayResponse()
        require(response.code == 200) { "relay probe signaling failed" }
        val body = JSONObject(response.body)
        require(body.getString("type") == "answer") { "relay probe answer invalid" }
        return body.getString("sdp").also { answer -> require(answer.length in 1..65_536) }
    }
}

internal data class RelayProbeFrame(val bytes: ByteArray, val sentMicros: Long)

internal fun relayProbeFrame(sequence: Int, sentMicros: Long): RelayProbeFrame {
    require(sequence in 0 until RELAY_MAX_PACKETS && sentMicros >= 0)
    val bytes = ByteArray(RELAY_FRAME_BYTES)
    ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN).apply {
        put(byteArrayOf('C'.code.toByte(), 'C'.code.toByte(), 'Q'.code.toByte(), '1'.code.toByte()))
        putInt(sequence)
        putLong(sentMicros)
    }
    return RelayProbeFrame(bytes, sentMicros)
}

internal fun completeRelayProbeSdp(raw: String): String {
    val lines = raw.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
    require(lines.count { it.startsWith("m=") } == 1 && lines.single { it.startsWith("m=") }.startsWith("m=application ")) {
        "relay probe SDP must contain one data channel"
    }
    val candidates = lines.filter { it.startsWith("a=candidate:") }
    require(candidates.isNotEmpty() && candidates.all { line ->
        val fields = line.removePrefix("a=candidate:").split(Regex("\\s+"))
        fields.size >= 8 && fields[2].equals("udp", ignoreCase = true) &&
            fields[6] == "typ" && fields[7] == "relay"
    }) { "relay probe SDP contains a non-UDP relay candidate" }
    val endMarkers = lines.count { it == "a=end-of-candidates" }
    require(endMarkers <= 1) { "relay probe SDP has duplicate end markers" }
    if (endMarkers == 1) return raw
    return raw.trimEnd('\r', '\n') + "\r\na=end-of-candidates\r\n"
}

internal class RelayEchoCollector(private val nanoTime: () -> Long) : DataChannel.Observer {
    private val lock = Any()
    private val sent = mutableMapOf<Int, Long>()
    private val received = mutableMapOf<Int, Double>()
    val receivedCount get() = synchronized(lock) { received.size }
    fun recordSent(sequence: Int, sentMicros: Long) = synchronized(lock) { sent[sequence] = sentMicros; Unit }
    override fun onBufferedAmountChange(previousAmount: Long) = Unit
    override fun onStateChange() = Unit
    override fun onMessage(buffer: DataChannel.Buffer) {
        if (!buffer.binary || buffer.data.remaining() != RELAY_FRAME_BYTES) return
        val bytes = ByteArray(RELAY_FRAME_BYTES).also { buffer.data.slice().get(it) }
        val parsed = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        if (parsed.int != RELAY_MAGIC) return
        val sequence = parsed.int
        val sentMicros = parsed.long
        if (sequence !in 0 until RELAY_MAX_PACKETS || bytes.copyOfRange(16, 32).any { it != 0.toByte() }) return
        synchronized(lock) {
            if (sent[sequence] != sentMicros || received.containsKey(sequence)) return
            received[sequence] = ((nanoTime() / 1_000 - sentMicros).coerceAtLeast(0L) / 1_000.0)
        }
    }
    fun sample(nodeId: String, sentCount: Int, durationMs: Double, connectionMs: Double): RelayProbeSample = synchronized(lock) {
        val rtts = received.toSortedMap().values.toList()
        if (sentCount < 20 || rtts.isEmpty() || durationMs < RELAY_SAMPLE_MS) {
            return RelayProbeSample(nodeId, "network_error", sentCount, rtts.size, durationMs)
        }
        val jitter = rtts.zipWithNext { first, second -> kotlin.math.abs(second - first) }
        RelayProbeSample(
            nodeId, "ok", sentCount, rtts.size, durationMs, connectionMs,
            percentile(rtts, 0.5), percentile(rtts, 0.95), if (jitter.isEmpty()) 0.0 else percentile(jitter, 0.5),
        )
    }
}

internal fun parseRelayProbeOptions(json: JSONObject): RelayProbeOptions {
    require(json.getString("measurement") == "relay_data_channel_echo_v1")
    require(json.relayStrictInt("lifetimeMs") == RELAY_LIFETIME_MS && json.relayStrictInt("sampleDurationMs") == RELAY_SAMPLE_MS &&
        json.relayStrictInt("packetIntervalMs") == RELAY_INTERVAL_MS && json.relayStrictInt("maxPackets") == RELAY_MAX_PACKETS &&
        json.relayStrictInt("maxPacketBytes") == 512 && json.getString("iceTransportPolicy") == "relay")
    val generation = json.getString("networkGeneration").also { require(it.matches(Regex("^[A-Za-z0-9._:-]{1,96}$"))) }
    val nodes = json.getJSONArray("nodes").also { require(it.length() in 1..16) }
    return RelayProbeOptions(generation, RELAY_LIFETIME_MS, RELAY_SAMPLE_MS, RELAY_INTERVAL_MS, RELAY_MAX_PACKETS, 512,
        List(nodes.length()) { index -> nodes.getJSONObject(index).let { node ->
            val url = node.getString("probeUrl").also(::requireRelayProbeUrl)
            val ice = node.getJSONArray("iceServers").also { require(it.length() == 1) }
            RelayProbeNode(
                node.getString("nodeId").also { require(it.matches(Regex("^[a-z][a-z0-9_-]{0,31}$"))) }, url,
                node.getString("expiresAt").also { Instant.parse(it) }, node.getString("grant").also { require(it.length in 32..4096) },
                List(ice.length()) { iceIndex -> ice.getJSONObject(iceIndex).let { server ->
                    val urls = when (val raw = server.get("urls")) {
                        is String -> listOf(raw)
                        is JSONArray -> List(raw.length()) { raw.getString(it) }
                        else -> error("invalid ICE urls")
                    }
                    require(urls.isNotEmpty() && urls.all { it.matches(Regex("^turn:[A-Za-z0-9.-]+:[0-9]+\\?transport=udp$")) })
                    RelayProbeIceServer(
                        urls,
                        server.getString("username").also { require(it.length in 1..512) },
                        server.getString("credential").also { require(it.length in 1..512) },
                    )
                } },
            )
        } })
}

internal fun relaySamplesJson(samples: List<RelayProbeSample>): JSONArray = JSONArray().also { array ->
    require(samples.size in 1..16 && samples.map { it.nodeId }.distinct().size == samples.size)
    samples.forEach { sample ->
        require(sample.outcome in setOf("ok", "timeout", "network_error") && sample.sent in 0..250 &&
            sample.received in 0..sample.sent && sample.sampleDurationMs in 0.0..5000.0)
        val json = JSONObject().put("nodeId", sample.nodeId).put("outcome", sample.outcome)
            .put("sent", sample.sent).put("received", sample.received).put("sampleDurationMs", sample.sampleDurationMs)
        if (sample.outcome == "ok") {
            val connection = requireNotNull(sample.connectionMs)
            val median = requireNotNull(sample.rttMedianMs)
            val p95 = requireNotNull(sample.rttP95Ms)
            val jitter = requireNotNull(sample.jitterMs)
            require(sample.sent >= 20 && sample.received >= 1 && sample.sampleDurationMs >= 2000 &&
                connection in 0.0..5000.0 && median in 0.0..5000.0 && p95 in 0.0..5000.0 &&
                jitter in 0.0..5000.0 && p95 >= median)
            json.put("connectionMs", connection).put("rttMedianMs", median)
                .put("rttP95Ms", p95).put("jitterMs", jitter)
        } else require(sample.rttMedianMs == null && sample.rttP95Ms == null && sample.jitterMs == null)
        array.put(json)
    }
}

internal object AndroidWebRtcRuntime {
    private val initialized = AtomicBoolean(false)
    fun initialize(context: Context) {
        if (initialized.compareAndSet(false, true)) {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
        }
    }
}

private class RelayPeerObserver(
    private val gathering: CompletableDeferred<Unit>,
    private val connected: CompletableDeferred<Unit>,
) : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
        when (state) {
            PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> connected.complete(Unit)
            PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.CLOSED ->
                connected.completeExceptionally(IllegalStateException("relay connection failed"))
            else -> Unit
        }
    }
    override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit
    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = Unit
    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { if (state == PeerConnection.IceGatheringState.COMPLETE) gathering.complete(Unit) }
    override fun onIceCandidate(candidate: IceCandidate) = Unit
    override fun onIceCandidateError(event: org.webrtc.IceCandidateErrorEvent) = Unit
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
    override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) = Unit
    override fun onAddStream(stream: MediaStream) = Unit
    override fun onRemoveStream(stream: MediaStream) = Unit
    override fun onDataChannel(channel: DataChannel) = Unit
    override fun onRenegotiationNeeded() = Unit
    override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
    override fun onRemoveTrack(receiver: RtpReceiver) = Unit
    override fun onTrack(transceiver: org.webrtc.RtpTransceiver) = Unit
}

private suspend fun PeerConnection.createRelayOffer(): SessionDescription = suspendCancellableCoroutine { continuation ->
    createOffer(object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {
            if (continuation.isActive) continuation.resume(description) { _, _, _ -> }
        }
        override fun onCreateFailure(message: String) {
            if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException(message)))
        }
        override fun onSetSuccess() = Unit
        override fun onSetFailure(message: String) = Unit
    }, MediaConstraints())
}

private suspend fun PeerConnection.setRelayDescription(value: SessionDescription, local: Boolean): Unit =
    suspendCancellableCoroutine { continuation ->
        val observer = object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onCreateFailure(message: String) = Unit
            override fun onSetSuccess() {
                if (continuation.isActive) continuation.resume(Unit) { _, _, _ -> }
            }
            override fun onSetFailure(message: String) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException(message)))
            }
        }
        if (local) setLocalDescription(observer, value) else setRemoteDescription(observer, value)
    }

private data class RelayHttpResponse(val code: Int, val body: String)

private suspend fun Call.awaitRelayResponse(): RelayHttpResponse = suspendCancellableCoroutine { continuation ->
    val activeResponse = AtomicReference<Response?>()
    continuation.invokeOnCancellation {
        cancel()
        activeResponse.getAndSet(null)?.close()
    }
    enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) {
            if (continuation.isActive) continuation.resumeWith(Result.failure(error))
        }
        override fun onResponse(call: Call, response: Response) {
            activeResponse.set(response)
            try {
                response.use {
                    if (!continuation.isActive) return
                    val body = checkNotNull(it.body).byteStream().readRelayBounded(RELAY_SIGNAL_RESPONSE_BYTES)
                    if (continuation.isActive) {
                        continuation.resume(RelayHttpResponse(it.code, body)) { _, _, _ -> }
                    }
                }
            } catch (error: Throwable) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(error))
            } finally {
                activeResponse.compareAndSet(response, null)
            }
        }
    })
}

private fun java.io.InputStream.readRelayBounded(limit: Int): String {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(4 * 1024)
    while (output.size() <= limit) {
        val count = read(buffer, 0, minOf(buffer.size, limit + 1 - output.size()))
        if (count < 0) break
        output.write(buffer, 0, count)
    }
    require(output.size() <= limit) { "relay probe response too large" }
    return output.toString(Charsets.UTF_8.name())
}

private fun requireRelayProbeUrl(raw: String) {
    val uri = URI(raw)
    require(uri.scheme == "https" && uri.host != null && uri.userInfo == null && uri.path == "/webrtc-probe/offer" &&
        uri.rawQuery == null && uri.fragment == null)
}
private fun JSONObject.relayStrictInt(key: String): Int {
    val raw = get(key)
    require(raw is Number)
    val value = raw.toString().toBigDecimalOrNull()
    require(value != null && value.stripTrailingZeros().scale() <= 0)
    return value.intValueExact()
}
private fun elapsedMs(start: Long, end: Long) = (end - start).coerceAtLeast(0L) / 1_000_000.0
private fun percentile(values: List<Double>, fraction: Double): Double {
    val sorted = values.sorted()
    return sorted[(ceil(sorted.size * fraction).toInt() - 1).coerceIn(0, sorted.lastIndex)].coerceIn(0.0, 5000.0)
}
private const val RELAY_LABEL = "media-quality-v1"
private const val RELAY_FRAME_BYTES = 32
private const val RELAY_MAGIC = 0x43435131
private const val RELAY_LIFETIME_MS = 5_000
private const val RELAY_SAMPLE_MS = 2_000
private const val RELAY_INTERVAL_MS = 20
private const val RELAY_MAX_PACKETS = 250
private const val RELAY_SIGNAL_RESPONSE_BYTES = 65_536
