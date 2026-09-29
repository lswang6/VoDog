package org.vodog.gateway.media

import android.content.Context
import org.vodog.gateway.GatewayHttpRequest
import org.vodog.gateway.GatewayHttpResponse
import org.vodog.gateway.GatewayHttpTransport
import org.vodog.gateway.OwnedGatewayHttpTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.asExecutor
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.io.Closeable
import java.io.InterruptedIOException
import java.nio.ByteBuffer
import java.time.Instant
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

internal data class GatewayQualityNode(val nodeId: String, val probeUrl: String, val expiresAt: Instant,
    val grant: String, val iceServers: List<MediaIceServer>)
internal data class GatewayQualityOptions(val networkGeneration: String, val lifetimeMs: Long,
    val sampleDurationMs: Long, val packetIntervalMs: Long, val maxPackets: Int, val nodes: List<GatewayQualityNode>)
internal data class GatewayQualitySample(val nodeId: String, val outcome: String, val sent: Int, val received: Int,
    val sampleDurationMs: Double, val connectionMs: Double? = null, val rttMedianMs: Double? = null,
    val rttP95Ms: Double? = null, val jitterMs: Double? = null)
internal interface GatewayQualityControl {
    suspend fun options(networkGeneration: String): GatewayQualityOptions
    suspend fun results(networkGeneration: String, samples: List<GatewayQualitySample>): Int
}
internal fun interface GatewayQualityRunner {
    suspend fun measure(node: GatewayQualityNode, options: GatewayQualityOptions, current: () -> Boolean): GatewayQualitySample
}

/** A server-disabled relay quality probe is re-asked at most every hour (observation only; a 5 min backoff was ~290 503s/day). */
internal const val QUALITY_DISABLED_BACKOFF_MS = 3_600_000L

/** S69: Control's 200 `{enabled:false, retryAfterMs}` - probing is off, ask again after that long. */
internal class GatewayQualityDisabled(val retryAfterMs: Long) : Exception("relay quality probe disabled")

internal fun qualityProbeSuppressed(disabledUntilMs: Long?, nowMs: Long): Boolean =
    disabledUntilMs != null && nowMs < disabledUntilMs

internal class GatewayMediaQualityProbe(private val control: GatewayQualityControl, private val runner: GatewayQualityRunner,
    private val generation: GatewayProbeGeneration,
    private val diagnostics: GatewayMediaQualityDiagnosticRecorder = GatewayMediaQualityDiagnosticRecorder {},
    private val now: () -> Instant = Instant::now, private val closed: () -> Boolean,
    private val elapsedRealtimeMs: () -> Long = { System.nanoTime() / 1_000_000 }) {
    @Volatile private var disabledUntilMs: Long? = null

    suspend fun measure(networkGeneration: String): Boolean {
        var options: GatewayQualityOptions? = null; var samples = emptyList<GatewayQualitySample>(); var acceptedCount = 0
        if (qualityProbeSuppressed(disabledUntilMs, elapsedRealtimeMs())) {
            recordDiagnostic("disabled", networkGeneration)
            return false
        }
        try {
            options = try { control.options(networkGeneration) } catch (error: GatewayMediaHttpException) {
                if (error.status == 503 && error.code == "MEDIA_QUALITY_UNAVAILABLE") {
                    disabledUntilMs = elapsedRealtimeMs() + QUALITY_DISABLED_BACKOFF_MS
                    recordDiagnostic("disabled", networkGeneration)
                    return false
                }
                throw error
            } catch (disabled: GatewayQualityDisabled) {
                disabledUntilMs = elapsedRealtimeMs() + disabled.retryAfterMs
                recordDiagnostic("disabled", networkGeneration)
                return false
            }
            disabledUntilMs = null
            val current = { !closed() && generation.current() == networkGeneration }
            require(options.networkGeneration == networkGeneration && current())
            samples = coroutineScope { options.nodes.map { async(Dispatchers.IO) { runner.measure(it, options, current) } }.awaitAll() }
            require(current()) { "network changed during relay quality probe" }
            acceptedCount = control.results(networkGeneration, samples)
            require(acceptedCount == samples.size) { "relay quality results were not fully accepted" }
            require(current()) { "network changed after relay quality probe" }
            recordDiagnostic("accepted", networkGeneration, options, samples, acceptedCount)
            return true
        } catch (cancelled: CancellationException) {
            recordDiagnostic("cancelled", networkGeneration, options, samples, acceptedCount)
            throw cancelled
        } catch (error: Throwable) {
            recordDiagnostic("failed", networkGeneration, options, samples, acceptedCount)
            throw error
        }
    }

    private fun recordDiagnostic(stage: String, generation: String, options: GatewayQualityOptions? = null,
        samples: List<GatewayQualitySample> = emptyList(), acceptedCount: Int = 0) {
        runCatching {
            diagnostics.record(GatewayMediaQualityDiagnosticSnapshot(
                stage, generation.take(96).ifBlank { "unknown" }, now(), options?.nodes?.minOfOrNull { it.expiresAt },
                acceptedCount.coerceIn(0, 16), samples.take(16).mapNotNull { it.sanitizedDiagnostic() },
            ))
        }
    }
}

private fun GatewayQualitySample.sanitizedDiagnostic(): GatewayMediaQualityNodeDiagnostic? {
    if (!nodeId.matches(Regex("^[a-z][a-z0-9_-]{0,31}$")) || outcome !in setOf("ok", "timeout", "network_error") ||
        sent !in 0..250 || received !in 0..sent || !sampleDurationMs.isFinite() || sampleDurationMs !in 0.0..5000.0) return null
    fun metric(value: Double?) = value?.takeIf { it.isFinite() && it in 0.0..5000.0 }
    return GatewayMediaQualityNodeDiagnostic(nodeId, outcome, sent, received, sampleDurationMs,
        if (outcome == "ok") metric(connectionMs) else null, if (outcome == "ok") metric(rttP95Ms) else null,
        if (outcome == "ok") metric(jitterMs) else null)
}

internal class GatewayWebRtcQualityRunner(private val context: Context,
    private val transportFactory: () -> GatewayHttpTransport = { OwnedGatewayHttpTransport() },
    private val nanoTime: () -> Long = System::nanoTime) : GatewayQualityRunner, Closeable {
    private val closed = AtomicBoolean(false)
    private val sessionLock = Any()
    private val sessions = mutableSetOf<GatewayQualitySession>()
    override suspend fun measure(node: GatewayQualityNode, options: GatewayQualityOptions, current: () -> Boolean): GatewayQualitySample {
        val session = GatewayQualitySession(context.applicationContext, transportFactory, nanoTime)
        synchronized(sessionLock) { check(!closed.get() && current()); sessions += session }
        return try { session.measure(node, options) { !closed.get() && current() } } finally {
            synchronized(sessionLock) { sessions -= session }; session.close()
        }
    }
    override fun close() {
        val owned = synchronized(sessionLock) {
            if (!closed.compareAndSet(false, true)) return
            sessions.toList()
        }
        owned.forEach { it.close() }
    }
}

private class GatewayQualitySession(private val context: Context, private val transportFactory: () -> GatewayHttpTransport,
    private val nanoTime: () -> Long) : Closeable {
    private val resources = CloseAwareQualityResources()

    suspend fun measure(node: GatewayQualityNode, options: GatewayQualityOptions, current: () -> Boolean): GatewayQualitySample {
        val started = nanoTime(); var sampleStarted = started; var sent = 0
        return try { withTimeout(options.lifetimeMs) {
            check(current() && !resources.isClosed())
            initializeQualityPeer(context)
            val gathered = CompletableDeferred<Unit>(); val opened = CompletableDeferred<Unit>()
            val echoes = Collections.synchronizedMap(mutableMapOf<Int, Double>())
            val payloads = Collections.synchronizedMap(mutableMapOf<Int, ByteArray>())
            val config = PeerConnection.RTCConfiguration(node.iceServers.map { server ->
                PeerConnection.IceServer.builder(server.urls).setUsername(server.username).setPassword(server.credential)
                    .setTlsCertPolicy(PeerConnection.TlsCertPolicy.TLS_CERT_POLICY_SECURE).createIceServer()
            }).apply { iceTransportsType = PeerConnection.IceTransportsType.RELAY; sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE }
            val (_, pc, dc) = resources.construct {
                val builtOwner = adopt(dataOnlyPeerConnectionFactory(context)) { it.close() }
                val builtPeer = adopt(requireNotNull(builtOwner.factory.createPeerConnection(config, qualityObserver(gathered))) {
                    "failed to create quality peer"
                }) { runCatching { it.close() }; runCatching { it.dispose() } }
                val builtChannel = adopt(requireNotNull(builtPeer.createDataChannel(QUALITY_LABEL,
                    DataChannel.Init().apply { ordered = false; maxRetransmits = 0 })) {
                    "failed to create quality data channel"
                }) { runCatching { it.unregisterObserver() }; runCatching { it.close() }; runCatching { it.dispose() } }
                Triple(builtOwner, builtPeer, builtChannel)
            }
            resources.construct { dc.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit
                override fun onStateChange() {
                    if (runCatching { resources.construct { dc.state() } }.getOrNull() == DataChannel.State.OPEN) opened.complete(Unit)
                }
                override fun onMessage(buffer: DataChannel.Buffer) {
                    if (!buffer.binary || resources.isClosed()) return
                    val bytes = ByteArray(buffer.data.remaining()).also(buffer.data::get); val decoded = decodeQualityPacket(bytes) ?: return
                    val expected = payloads[decoded.first] ?: return
                    if (!bytes.contentEquals(expected) || echoes.containsKey(decoded.first)) return
                    echoes[decoded.first] = ((nanoTime() / 1_000L) - decoded.second).coerceAtLeast(0L) / 1_000.0
                }
            }) }
            require(current() && !resources.isClosed()); val offer = pc.createQualityOffer(resources); pc.setQualityDescription(offer, true, resources)
            if (resources.construct { pc.iceGatheringState() } != PeerConnection.IceGatheringState.COMPLETE)
                withTimeout(minOf(2_000L, remainingQualityBudgetMs(started, options.lifetimeMs, nanoTime()))) { gathered.await() }
            require(current() && !resources.isClosed()); val local = resources.construct { requireNotNull(pc.localDescription) }
            val completedSdp = completedRelayOnlyUdpSdp(local.description)
            val response = executeQualityRequestWithinDeadline({ resources.construct {
                adopt(CloseOnceQualityTransport(transportFactory())) { it.close() }
            } }, GatewayHttpRequest(node.probeUrl, "POST",
                authorization = "Bearer ${node.grant}", jsonBody = JSONObject().put("type", "offer").put("sdp", completedSdp).toString().toByteArray(),
                timeoutMs = options.lifetimeMs, responseLimitBytes = 1024 * 1024), started, options.lifetimeMs, nanoTime)
            require(response.status == 200); val answer = JSONObject(response.body); require(answer.getString("type") == "answer")
            pc.setQualityDescription(SessionDescription(SessionDescription.Type.ANSWER, answer.getString("sdp")), false, resources)
            if (resources.construct { dc.state() } != DataChannel.State.OPEN) opened.await()
            val connectedMs = elapsedMs(started, nanoTime()); sampleStarted = nanoTime()
            while (sent < options.maxPackets && elapsedMs(sampleStarted, nanoTime()) <= options.sampleDurationMs) {
                require(current() && !resources.isClosed()); val bytes = encodeQualityPacket(sent, nanoTime() / 1_000L); payloads[sent] = bytes
                if (!resources.construct { dc.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), true)) }) break
                sent += 1; delay(options.packetIntervalMs)
            }
            require(current() && !resources.isClosed()); val duration = elapsedMs(sampleStarted, nanoTime()).coerceAtMost(options.lifetimeMs.toDouble())
            val rtts = synchronized(echoes) { echoes.toSortedMap().values.toList() }
            if (sent < 20 || rtts.isEmpty() || duration < options.sampleDurationMs) GatewayQualitySample(node.nodeId, "timeout", sent, 0, duration.coerceIn(0.0, 5000.0))
            else qualitySuccess(node.nodeId, sent, duration, connectedMs, rtts)
        } } catch (cancelled: CancellationException) {
            if (!current() || resources.isClosed()) throw cancelled
            GatewayQualitySample(node.nodeId, "timeout", sent, 0, elapsedMs(sampleStarted, nanoTime()).coerceIn(0.0, 5000.0))
        } catch (_: InterruptedIOException) {
            GatewayQualitySample(node.nodeId, "timeout", sent, 0, elapsedMs(sampleStarted, nanoTime()).coerceIn(0.0, 5000.0))
        } catch (error: Exception) {
            if (!current() || resources.isClosed()) throw CancellationException("quality probe cancelled").also { it.initCause(error) }
            GatewayQualitySample(node.nodeId, "network_error", sent, 0, elapsedMs(sampleStarted, nanoTime()).coerceIn(0.0, 5000.0))
        } finally { close() }
    }
    override fun close() = resources.close()
}

internal class CloseAwareQualityResources : Closeable {
    private val lock = Any()
    private var closed = false
    private val cleanup = mutableListOf<() -> Unit>()
    fun isClosed() = synchronized(lock) { closed }
    fun <T> construct(block: CloseAwareQualityResources.() -> T): T = synchronized(lock) {
        check(!closed) { "quality resources closed" }; block()
    }
    fun <T> adopt(value: T, close: (T) -> Unit): T {
        check(Thread.holdsLock(lock)) { "quality resource adoption must be serialized" }
        if (closed) { close(value); error("quality resources closed") }
        cleanup += { close(value) }
        return value
    }
    override fun close() {
        val owned = synchronized(lock) { if (closed) return; closed = true; cleanup.asReversed().toList().also { cleanup.clear() } }
        owned.forEach { runCatching(it) }
    }
}

internal suspend fun executeQualityRequestWithinDeadline(transportFactory: () -> GatewayHttpTransport,
    request: GatewayHttpRequest, startedNanos: Long, lifetimeMs: Long, nanoTime: () -> Long): GatewayHttpResponse {
    val attempt = CloseOnceQualityTransport(transportFactory())
    return try {
        val bounded = request.copy(timeoutMs = remainingQualityBudgetMs(startedNanos, lifetimeMs, nanoTime()))
        suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { attempt.close() }
            Dispatchers.IO.asExecutor().execute {
                runCatching { attempt.execute(bounded) }.fold(
                    onSuccess = { if (continuation.isActive) continuation.resume(it) { _, _, _ -> } },
                    onFailure = { if (continuation.isActive) continuation.resumeWith(Result.failure(it)) },
                )
            }
        }
    } finally { attempt.close() }
}

internal class CloseOnceQualityTransport(private val delegate: GatewayHttpTransport) : GatewayHttpTransport {
    private val closed = AtomicBoolean(false)
    override fun execute(request: GatewayHttpRequest) = delegate.execute(request)
    override fun cancelAndEvict() { if (closed.compareAndSet(false, true)) delegate.cancelAndEvict() }
}

internal fun remainingQualityBudgetMs(startedNanos: Long, lifetimeMs: Long, nowNanos: Long): Long {
    val remainingNanos = lifetimeMs * 1_000_000L - (nowNanos - startedNanos).coerceAtLeast(0L)
    require(remainingNanos > 0L) { "relay quality lifetime exhausted" }
    return ((remainingNanos + 999_999L) / 1_000_000L).coerceAtMost(lifetimeMs)
}

internal fun encodeQualityPacket(sequence: Int, sentUs: Long): ByteArray { require(sequence in 0..249 && sentUs >= 0)
    return ByteBuffer.allocate(32).put(byteArrayOf(0x43, 0x43, 0x51, 0x31)).putInt(sequence).putLong(sentUs).array() }
internal fun decodeQualityPacket(bytes: ByteArray): Pair<Int, Long>? {
    if (bytes.size != 32 || !bytes.copyOfRange(0, 4).contentEquals(byteArrayOf(0x43, 0x43, 0x51, 0x31)) || bytes.copyOfRange(16, 32).any { it != 0.toByte() }) return null
    val value = ByteBuffer.wrap(bytes); value.position(4); val sequence = value.int; val sentUs = value.long
    return if (sequence in 0..249 && sentUs >= 0) sequence to sentUs else null
}
internal fun qualitySuccess(nodeId: String, sent: Int, durationMs: Double, connectionMs: Double, rtts: List<Double>): GatewayQualitySample {
    require(sent in 20..250 && rtts.isNotEmpty() && rtts.size <= sent && durationMs in 2000.0..5000.0 && connectionMs in 0.0..5000.0)
    val sorted = rtts.sorted(); fun percentile(fraction: Double) = sorted[(kotlin.math.ceil(sorted.size * fraction).toInt() - 1).coerceIn(0, sorted.lastIndex)]
    val median = percentile(.5); val p95 = maxOf(median, percentile(.95)); val differences = rtts.zipWithNext { a, b -> kotlin.math.abs(b - a) }
    return GatewayQualitySample(nodeId, "ok", sent, rtts.size, durationMs, connectionMs, median, p95,
        if (differences.isEmpty()) 0.0 else differences.average())
}
internal fun gatewayQualitySamplesJson(samples: List<GatewayQualitySample>) = JSONArray().also { array ->
    require(samples.size in 1..16 && samples.map { it.nodeId }.distinct().size == samples.size)
    samples.forEach { sample -> require(sample.outcome in QUALITY_OUTCOMES && sample.sent in 0..250 && sample.received in 0..sample.sent && sample.sampleDurationMs in 0.0..5000.0)
        array.put(JSONObject().put("nodeId", sample.nodeId).put("outcome", sample.outcome).put("sent", sample.sent).put("received", sample.received)
            .put("sampleDurationMs", sample.sampleDurationMs).also { json -> if (sample.outcome == "ok") {
                require(sample.sent >= 20 && sample.received >= 1 && sample.sampleDurationMs >= 2000 && requireNotNull(sample.rttP95Ms) >= requireNotNull(sample.rttMedianMs))
                json.put("connectionMs", requireNotNull(sample.connectionMs)).put("rttMedianMs", sample.rttMedianMs)
                    .put("rttP95Ms", sample.rttP95Ms).put("jitterMs", requireNotNull(sample.jitterMs))
            } else require(listOf(sample.connectionMs, sample.rttMedianMs, sample.rttP95Ms, sample.jitterMs).all { it == null }) }) }
}
internal fun parseGatewayQualityOptions(json: JSONObject): GatewayQualityOptions {
    if (!json.optBoolean("enabled", true)) {
        throw GatewayQualityDisabled(json.optLong("retryAfterMs", 0L).takeIf { it > 0L } ?: QUALITY_DISABLED_BACKOFF_MS)
    }
    require(json.getString("measurement") == "relay_data_channel_echo_v1" && json.getLong("lifetimeMs") == 5000L &&
        json.getLong("sampleDurationMs") == 2000L && json.getLong("packetIntervalMs") == 20L && json.getInt("maxPackets") == 250 &&
        json.getInt("maxPacketBytes") == 512 && json.getString("iceTransportPolicy") == "relay")
    val nodes = json.getJSONArray("nodes"); require(nodes.length() in 1..16)
    val parsed = List(nodes.length()) { index -> nodes.getJSONObject(index).let { node -> val servers = node.getJSONArray("iceServers"); require(servers.length() == 1)
        val server = servers.getJSONObject(0); val urls = server.getJSONArray("urls"); require(urls.length() == 1); val url = urls.getString(0)
        require(url.matches(Regex("^turn:[A-Za-z0-9.-]+:[0-9]+\\?transport=udp$")))
        GatewayQualityNode(node.getString("nodeId").also { require(it.matches(Regex("^[a-z][a-z0-9_-]{0,31}$"))) },
            node.getString("probeUrl").also { require(it.startsWith("https://") && it.endsWith("/webrtc-probe/offer")) }, Instant.parse(node.getString("expiresAt")),
            node.getString("grant").also { require(it.length in 1..4096) }, listOf(MediaIceServer(listOf(url), server.getString("username"), server.getString("credential")))) } }
    require(parsed.map { it.nodeId }.distinct().size == parsed.size)
    return GatewayQualityOptions(json.getString("networkGeneration").also { require(it.length in 1..96) }, 5000, 2000, 20, 250, parsed)
}
internal fun completedRelayOnlyUdpSdp(sdp: String): String {
    val lines = sdp.split(Regex("\\r?\\n")).toMutableList()
    val media = lines.indices.filter { lines[it].startsWith("m=") }
    val candidates = lines.indices.filter { lines[it].startsWith("a=candidate:") }
    require(media.size == 1 && lines[media.single()].startsWith("m=application ") && candidates.isNotEmpty() && candidates.all {
        Regex("(?:^| )typ relay(?: |$)").containsMatchIn(lines[it]) && Regex("(?:^| )udp(?: |$)", RegexOption.IGNORE_CASE).containsMatchIn(lines[it])
    }) { "quality SDP must contain only UDP relay candidates in one application section" }
    if (lines.none { it == "a=end-of-candidates" }) lines.add(candidates.last() + 1, "a=end-of-candidates")
    return lines.joinToString("\r\n")
}
private fun elapsedMs(start: Long, end: Long) = (end - start).coerceAtLeast(0L) / 1_000_000.0
private fun qualityObserver(gathered: CompletableDeferred<Unit>) = object : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit; override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
    override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit; override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = Unit
    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit) }
    override fun onIceCandidate(candidate: IceCandidate) = Unit; override fun onIceCandidateError(event: org.webrtc.IceCandidateErrorEvent) = Unit
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit; override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) = Unit
    override fun onAddStream(stream: MediaStream) = Unit; override fun onRemoveStream(stream: MediaStream) = Unit; override fun onDataChannel(channel: DataChannel) = Unit
    override fun onRenegotiationNeeded() = Unit; override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
    override fun onRemoveTrack(receiver: RtpReceiver) = Unit; override fun onTrack(transceiver: org.webrtc.RtpTransceiver) = Unit
}
private suspend fun PeerConnection.createQualityOffer(resources: CloseAwareQualityResources): SessionDescription = suspendCancellableCoroutine { continuation ->
    resources.construct { createOffer(object : SdpObserver { override fun onCreateSuccess(value: SessionDescription) { if (continuation.isActive) continuation.resume(value) { _, _, _ -> } }
        override fun onCreateFailure(message: String) { if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException(message))) }
        override fun onSetSuccess() = Unit; override fun onSetFailure(message: String) = Unit }, org.webrtc.MediaConstraints()) } }
private suspend fun PeerConnection.setQualityDescription(value: SessionDescription, local: Boolean,
    resources: CloseAwareQualityResources): Unit = suspendCancellableCoroutine { continuation ->
    val observer = object : SdpObserver { override fun onCreateSuccess(value: SessionDescription) = Unit; override fun onCreateFailure(message: String) = Unit
        override fun onSetSuccess() { if (continuation.isActive) continuation.resume(Unit) { _, _, _ -> } }
        override fun onSetFailure(message: String) { if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException(message))) } }
    resources.construct { if (local) setLocalDescription(observer, value) else setRemoteDescription(observer, value) } }
private val QUALITY_OUTCOMES = setOf("ok", "timeout", "network_error")
private const val QUALITY_LABEL = "media-quality-v1"
private val qualityInitialized = AtomicBoolean(false)
@Synchronized private fun initializeQualityPeer(context: Context) { if (qualityInitialized.compareAndSet(false, true))
    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).setEnableInternalTracer(false).createInitializationOptions()) }
