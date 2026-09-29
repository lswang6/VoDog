package org.vodog.gateway

import org.vodog.gateway.media.EncodedOpusFrame
import org.vodog.gateway.media.GatewayDataChannelTransport
import org.vodog.gateway.media.GatewayDataChannelListener
import org.vodog.gateway.media.IceTransport
import org.vodog.gateway.media.rejoinMediaLeg
import org.vodog.gateway.media.MediaDirection
import org.vodog.gateway.media.MediaPacket
import org.vodog.gateway.media.MediaSendResult
import org.vodog.gateway.media.OpusMediaCodecDecoder
import org.vodog.gateway.media.OpusMediaCodecEncoder
import org.vodog.gateway.media.LibOpusEncoder
import org.vodog.gateway.media.LibOpusDecoder
import org.vodog.gateway.media.OpusPlayoutBuffer
import org.vodog.gateway.media.OpusPlayoutProfile
import org.vodog.gateway.media.PlayoutDecoder
import org.vodog.gateway.media.PlayoutTick
import java.io.Closeable
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

object GatewayAudioMediaSessionApproval { const val APPROVED = GatewayPhoneFeatureApproval.APPROVED }

/**
 * How long [GatewayAudioMediaSession.start] waits for the first decoded caller frame before it
 * gives up. Nothing is muted and the native call audio is never taken over until that frame lands,
 * so this window is the fence that stops a live cellular call from being turned into silence.
 *
 * S37: this was 3 s, which is shorter than the remote client's own connect budget - 12 s of UDP
 * gathering, an options round-trip, then up to 12 s on the TLS fallback, plus the offer round-trip
 * and ICE connect (~26 s measured on 2026-09-17). Whenever the gateway leg connected first, the
 * client's fallback met a torn-down session and a withdrawn capability, and this call could never
 * get audio again: the recorder directory is single-shot, so no second leg can be built for it.
 * The window now covers that whole budget with margin; a healthy call still completes in under 1 s.
 */
internal const val PREBUFFER_TIMEOUT_MS = 45_000L

/**
 * The same fence for an AI-answered call (S22 decision 9). Control's Voice worker must still finish
 * ICE gathering and join the media room after the answer commits, which measured 3-7 s in the S22
 * baseline. The Voice worker is server-side and has no TLS-fallback round, so it keeps the shorter
 * window: an AI call that never joins the room is a real failure, not a slow phone.
 */
internal const val PREBUFFER_TIMEOUT_AI_MS = 8_000L

/** The caller may ask for anything; a session only ever waits between 50 ms and the longer window. */
internal fun clampPrebufferTimeoutMs(value: Long): Long =
    value.coerceIn(50L, maxOf(PREBUFFER_TIMEOUT_MS, PREBUFFER_TIMEOUT_AI_MS))

data class RecoveredAudio(val pcm: ByteArray, val timestampUs: Long, val kind: String)

/** S70: what one received packet carries (LBRR present, OPUS_BANDWIDTH_* 1101..1105). */
data class OpusPacketInfo(val hasLbrr: Boolean, val bandwidth: Int)

interface AudioSessionCodec : Closeable {
    val receiveRecoveryEnabled: Boolean get() = false
    fun resetDecoder() = Unit
    fun conceal(next: MediaPacket?, timestampUs: Long, durationMs: Int): RecoveredAudio =
        error("receive recovery unavailable")
    fun encodingStats(): Map<String, Long> = emptyMap()
    /** S70: inspected on the playout thread, never on the WebRTC callback. */
    fun inspect(packet: MediaPacket): OpusPacketInfo? = null
    val decoderComplexity: Int get() = 0
    fun encode(pcm: ByteArray, timestampUs: Long): List<EncodedOpusFrame>
    fun decode(packet: MediaPacket): List<Pair<ByteArray, Long>>
    fun finishEncode(timestampUs: Long): List<EncodedOpusFrame>
    fun finishDecode(timestampUs: Long): List<Pair<ByteArray, Long>>
}

class AndroidAudioSessionCodec : AudioSessionCodec {
    // An explicit build opt-in selects the candidate; never silently fall back during a call.
    private val nativeEncoder = if (BuildConfig.LIBOPUS_FEC_ENABLED) LibOpusEncoder() else null
    private val platformEncoder = if (BuildConfig.LIBOPUS_FEC_ENABLED) null else OpusMediaCodecEncoder()
    override val receiveRecoveryEnabled = BuildConfig.RECEIVE_RECOVERY_ENABLED
    private val nativeDecoder = try { if (BuildConfig.RECEIVE_RECOVERY_ENABLED) LibOpusDecoder() else null } catch (error: Throwable) {
        runCatching { nativeEncoder?.close() }; runCatching { platformEncoder?.close() }; throw error
    }
    private val decoder = try { if (BuildConfig.RECEIVE_RECOVERY_ENABLED) null else OpusMediaCodecDecoder() } catch (error: Throwable) {
        runCatching { nativeDecoder?.close() }
        runCatching { nativeEncoder?.close() }
        runCatching { platformEncoder?.close() }
        throw error
    }
    override fun encode(pcm: ByteArray, timestampUs: Long): List<EncodedOpusFrame> =
        nativeEncoder?.encode(pcm, timestampUs) ?: checkNotNull(platformEncoder).encode(pcm, timestampUs)
    override fun decode(packet: MediaPacket): List<Pair<ByteArray, Long>> = nativeDecoder?.let {
        val result = it.decode(packet.opus, packet.timestampUs)
        listOf(result.pcm16le to result.presentationTimeUs)
    } ?: checkNotNull(decoder).decode(EncodedOpusFrame(packet.opus, packet.timestampUs))
        .map { it.pcm16le to it.presentationTimeUs }
    override fun resetDecoder() { checkNotNull(nativeDecoder).reset() }
    override fun conceal(next: MediaPacket?, timestampUs: Long, durationMs: Int): RecoveredAudio {
        val d = checkNotNull(nativeDecoder)
        val result = if (next != null && next.durationMs == durationMs) d.decodePreviousFromNext(next.opus, timestampUs, durationMs)
            else d.plc(timestampUs, durationMs)
        return RecoveredAudio(result.pcm16le, result.presentationTimeUs,
            if (result.fecAttempted) "fec_attempt" else "plc")
    }
    override fun inspect(packet: MediaPacket): OpusPacketInfo? = nativeDecoder?.let { d ->
        runCatching { OpusPacketInfo(d.packetHasLbrr(packet.opus), d.packetBandwidth(packet.opus)) }.getOrNull()
    }
    // Read at construction: session-end diagnostics run after close(), when the decoder refuses calls.
    override val decoderComplexity: Int = nativeDecoder?.let { runCatching { it.complexity() }.getOrNull() } ?: 0
    override fun finishEncode(timestampUs: Long): List<EncodedOpusFrame> =
        nativeEncoder?.finish(timestampUs) ?: checkNotNull(platformEncoder).finish(timestampUs)
    override fun finishDecode(timestampUs: Long): List<Pair<ByteArray, Long>> =
        decoder?.finish(timestampUs)?.map { it.pcm16le to it.presentationTimeUs } ?: emptyList()
    override fun encodingStats() = mapOf(
        "encoderLibopus" to if (BuildConfig.LIBOPUS_FEC_ENABLED) 1L else 0L,
        "encoderFecConfigured" to if (nativeEncoder?.diagnostics?.fecEnabled == true) 1L else 0L,
        "encoderExpectedLossPercent" to (nativeEncoder?.diagnostics?.expectedLossPercent?.toLong() ?: 0L),
        "encoderBitrate" to (nativeEncoder?.diagnostics?.bitRate?.toLong() ?: 20_000L),
    )
    override fun close() {
        try { nativeEncoder?.close() } finally {
            try { platformEncoder?.close() } finally { try { decoder?.close() } finally { nativeDecoder?.close() } }
        }
    }
}

interface AudioSessionTransport : Closeable {
    fun send(packet: MediaPacket): MediaSendResult
    fun networkStats(): Map<String, Long> = emptyMap()
    val turnHost: String? get() = null
    /** S72c: negotiated ICE transport (udp/tls) for media.stats / media.session_end. */
    val iceTransport: String? get() = null
    /** S73b: the leg used the S71 relay TURN (options `relay: true`); its rejoin is TLS-only. */
    val relayTurn: Boolean get() = false
}
class DataChannelAudioSessionTransport(private val transport: GatewayDataChannelTransport) : AudioSessionTransport {
    override fun send(packet: MediaPacket) = transport.send(packet)
    override fun networkStats() = transport.stats().let { mapOf(
        "transportReceivedPackets" to it.receivedPackets,
        "transportDroppedPackets" to it.droppedPackets,
        "transportMissingPackets" to it.missingPackets,
        "transportBackpressureDrops" to it.backpressureDrops,
    ) }
    override val turnHost: String? get() = transport.turnHost
    override val iceTransport: String get() = transport.negotiatedTransport.name.lowercase()
    override val relayTurn: Boolean get() = transport.relayTurn
    override fun close() = transport.close()
}

/** Listener proxy used while signaling constructs the DataChannel before the session exists. */
class GatewayAudioPacketIngress : GatewayDataChannelListener {
    private val session = AtomicReference<GatewayAudioMediaSession?>(null)
    fun attach(value: GatewayAudioMediaSession) { check(session.compareAndSet(null, value)) }
    fun detach() { session.set(null) }
    override fun onPacket(packet: MediaPacket) { session.get()?.onRemotePacket(packet) }
    // S73: no detach - a rejoined leg delivers into this same ingress.
    override fun onTransportLost(reason: String) { session.get()?.onTransportFailure("transport_disconnected", reason) }
    override fun onProtocolError(error: IllegalArgumentException) {
        session.get()?.onTransportFailure("transport_protocol_error")
    }
}

/**
 * S73 D1/D5: builds a fresh leg (new options + offer, same ingress) for [transport] within [budgetMs].
 * S73b: TLS-only follows the lost leg's [AudioSessionTransport.relayTurn], not the API relay mode.
 */
interface MediaLegRejoiner {
    suspend fun connect(transport: IceTransport, budgetMs: Long): AudioSessionTransport
    /** S73b: this failure happened with no usable network; it spends no rejoin attempt. */
    fun isOffline(error: Throwable): Boolean = false
    /** S73b: suspends until a network is back (true) or [budgetMs] ran out (false). */
    suspend fun awaitNetwork(budgetMs: Long): Boolean = true
}

/** Captures the user's mute state before this session and restores that exact value on close. */
interface GatewayMuteLease {
    fun acquireAndMute(): Boolean
    fun restoreOriginalState(): Boolean
}

/**
 * S72c `media.stats`: cumulative counters plus a nested `delta` (same keys) since the previous sample,
 * so a zero-fill burst can be placed in time. Keys match `media.session_end`.
 */
internal fun mediaStatsFields(previous: Map<String, Long>, current: Map<String, Long>): Map<String, Any?> =
    current + ("delta" to org.json.JSONObject(current.mapValues { (key, value) -> value - (previous[key] ?: 0L) }))

data class AudioMediaSessionStats(
    val localRemoteDrops: Long,
    val localCallerDrops: Long,
    val encodeQueueDrops: Long,
    val transportSendDrops: Long,
    val encodeQueueHighWatermark: Long,
    val encodeMaxDurationUs: Long,
    val remotePacketDrops: Long,
    val injectionDrops: Long,
) {
    val networkSendDrops: Long get() = encodeQueueDrops + transportSendDrops
}

/**
 * Approval-gated cellular media session. Network and AudioRecord callbacks only enqueue bounded work.
 *
 * S70 receive path (receive recovery on): the telephony AudioTrack's playback thread is the clock.
 * Each write pulls one 20 ms frame from [OpusPlayoutBuffer], which decodes/FEC/PLCs on demand, then
 * the frame is posted to the recording queue (recording is never on the injection path). Before the
 * playback thread owns the clock (prebuffer, or an unarmed early leg) the decode worker pulls at the
 * same 20 ms rate and discards, so nothing backlogs. Every hand-off queue drops its oldest entry.
 */
class GatewayAudioMediaSession(
    private val endpoint: TelephonyAudioEndpoint,
    private val codec: AudioSessionCodec,
    transport: AudioSessionTransport,
    // S56: null for an early-media leg until ACTIVE; see [attachRecorder].
    recorder: LocalCallRecorder?,
    private val muteLease: GatewayMuteLease,
    private val approved: () -> Boolean = { GatewayAudioMediaSessionApproval.APPROVED },
    private val onFatal: (String) -> Unit = {},
    monotonicUs: () -> Long = { android.os.SystemClock.elapsedRealtimeNanos() / 1_000 },
    prebufferTimeoutMs: Long = PREBUFFER_TIMEOUT_MS,
    terminalUpgradeGraceMs: Long = TERMINAL_UPGRADE_GRACE_MS,
    // S23 decision 1: resolved by the coordinator from DeviceCallRecord.answeredByAi, on the same
    // path as prebufferTimeoutMs. A human call keeps the S20 playout shape exactly.
    internal val playoutProfile: OpusPlayoutProfile = OpusPlayoutProfile.HUMAN,
    private val diagCallId: String? = recorder?.callId,
    // S70: Connection.EXTRA_AUDIO_CODEC of the live call, sampled at start/arm/teardown.
    carrierAudioCodec: () -> String? = { null },
    // S73: null = a transport loss is fatal (pre-S73 behaviour, and every unit fixture).
    private val rejoiner: MediaLegRejoiner? = null,
) : Closeable {
    private val monotonicUs = monotonicUs
    // S73 D5: swapped under [setupLock] by a rejoin; teardown closes whichever leg is current.
    @Volatile private var transport: AudioSessionTransport = transport
    private val established = AtomicBoolean(false)
    private val rejoining = AtomicBoolean(false)
    private val rejoins = AtomicLong()
    // S73 D4: the next arrival is the first packet of a new leg.
    private val newLeg = AtomicBoolean(false)
    private var seenStreamResets = 0L
    private val rejoinScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var recorder: LocalCallRecorder? = recorder
    // S56 决策 2: an early-media leg (no recorder yet) discards caller frames at injection until [arm].
    private val injectionArmed = AtomicBoolean(recorder != null)
    private val timelineOriginUs = monotonicUs()
    private val running = AtomicBoolean(false)
    private val stopping = AtomicBoolean(false)
    private val setupLock = Any()
    private val teardownDone = CountDownLatch(1)
    private val teardownResult = AtomicReference<Boolean?>(null)
    private val ingressStopped = AtomicBoolean(false)
    private val muteAttempted = AtomicBoolean(false)
    private val prebufferReady = CompletableFuture<Boolean>()
    private val prebufferTimeoutMs = clampPrebufferTimeoutMs(prebufferTimeoutMs)
    private val terminalUpgradeGraceMs = terminalUpgradeGraceMs.coerceIn(0L, TERMINAL_UPGRADE_GRACE_MS)
    private val recordQueue = ArrayBlockingQueue<RecordWork>(RECORD_QUEUE_FRAMES)
    private val encodeQueue = ArrayBlockingQueue<PcmWork>(ENCODE_QUEUE_FRAMES)
    // S70: the WebRTC callback -> playout hand-off (drop oldest). The legacy MediaCodec path, which
    // cannot conceal, keeps a small decoded-frame queue in front of the AudioTrack (drop oldest).
    private val decodeQueue = ArrayBlockingQueue<RemoteWork>(playoutProfile.decodeQueueFrames)
    private val legacyPlayoutQueue = ArrayBlockingQueue<ByteArray>(LEGACY_PLAYOUT_FRAMES)
    private val remoteDrops = AtomicLong()
    private val callerDrops = AtomicLong()
    private val pendingRemoteDrops = AtomicLong()
    private val pendingCallerDrops = AtomicLong()
    private val encodeQueueDrops = AtomicLong()
    private val transportSendDrops = AtomicLong()
    private val encodeQueueHighWatermark = AtomicLong()
    private val encodeMaxDurationUs = AtomicLong()
    private val packetDrops = AtomicLong()
    private val injectionDrops = AtomicLong()
    private val playout = if (codec.receiveRecoveryEnabled) OpusPlayoutBuffer(playoutProfile) else null
    private val playoutLock = Any()
    private val playbackOwnsClock = AtomicBoolean(false)
    private val callerRecordDrops = AtomicLong()
    private val rxPackets = AtomicLong()
    private val txPackets = AtomicLong()
    // S72c media.stats: previous sample (recording thread only).
    private var statsPrevious = emptyMap<String, Long>()
    private var statsPreviousHistogram: LongArray? = null
    private var statsPreviousUs = 0L
    private val rxLbrrPackets = AtomicLong()
    private val rxBandwidth = LongArray(5)
    @Volatile private var carrierCodec = "unknown"
    private val playoutDecoder = object : PlayoutDecoder {
        override fun decode(packet: MediaPacket): ByteArray {
            val chunks = codec.decode(packet)
            return if (chunks.size == 1) chunks[0].first
            else chunks.fold(ByteArray(0)) { acc, chunk -> acc + chunk.first }
        }
        override fun conceal(next: MediaPacket?, timestampUs: Long, durationMs: Int) =
            codec.conceal(next, timestampUs, durationMs).let { it.pcm to it.kind }
        override fun resetDecoder() = codec.resetDecoder()
    }
    // Recording timelines for the pull path: caller_original follows source PTS, caller_playout
    // follows playback ticks (a zero-fill tick is a gap there, never an appended frame).
    private var originalSourceAnchor: Long? = null
    private var originalTimelineAnchor = 0L
    private var playoutTimelineAnchor: Long? = null
    private var playoutTicks = 0L
    private val sequence = AtomicLong()
    private val workers = mutableListOf<Thread>()
    private val mediaProducersDone = CountDownLatch(2)
    private val fatalSignaled = AtomicBoolean(false)
    private val fatalCode = AtomicReference<String?>(null)
    private val requestedTerminalState = AtomicReference("incomplete")
    private val terminalUpgradedAfterFailure = AtomicBoolean(false)
    private val definitiveTerminal = CountDownLatch(1)
    private val nextRemoteTimelineUs = AtomicLong(-1L)
    private val carrierAudioCodecSource: () -> String? = carrierAudioCodec

    fun start(): Result<Unit> {
        val result = synchronized(setupLock) {
            runCatching {
                check(approved()) { "audio media session not approved" }
                check(!ingressStopped.get()) { "audio media session ingress already stopped" }
                check(running.compareAndSet(false, true)) { "audio media session already running" }
                startWorkers()
                check(prebufferReady.get(prebufferTimeoutMs, TimeUnit.MILLISECONDS) == true) {
                    // With the S37 window, hanging up mid-connect is the common way out of this
                    // wait; it must not be reported as "the remote leg never produced audio".
                    if (ingressStopped.get()) "audio media session stopped during prebuffer"
                    else "valid caller audio prebuffer unavailable"
                }
                check(approved() && running.get() && !ingressStopped.get()) {
                    "audio media session stopped before mute setup"
                }
                // S56: Telecom mutes only an ACTIVE call, so an early leg takes the lease in [arm].
                if (injectionArmed.get()) {
                    muteAttempted.set(true)
                    check(muteLease.acquireAndMute()) { "failed to acquire mute lease" }
                }
                check(running.get() && !ingressStopped.get()) { "audio media session stopped during mute setup" }
                endpoint.start(::onCellularDownlink, ::nextPlaybackFrame, ::onEndpointFailure).getOrThrow()
                check(running.get() && !ingressStopped.get()) {
                    "audio media session stopped during endpoint setup"
                }
                if (injectionArmed.get()) {
                    synchronized(playoutLock) { playout?.trimSetupBacklog() }
                    playbackOwnsClock.set(true)
                }
                sampleCarrierCodec()
                established.set(true)
            }
        }
        if (result.isFailure) stop("failed")
        return result
    }

    /** Called by the DataChannel listener; it never decodes or writes files on the WebRTC thread. */
    fun onRemotePacket(packet: MediaPacket) {
        if (!running.get() || packet.direction != MediaDirection.USER_UPLINK) return
        val work = RemoteWork(packet, relativeNow())
        while (!decodeQueue.offer(work)) {
            // S70: drop the oldest; the newest packet is what the caller is saying now.
            if (decodeQueue.poll() != null) {
                packetDrops.incrementAndGet(); callerDrops.incrementAndGet(); pendingCallerDrops.incrementAndGet()
            }
        }
    }

    /** AudioTrack playback thread: one 20 ms frame per write, or null for endpoint silence. */
    private fun nextPlaybackFrame(): ByteArray? {
        if (!running.get() || ingressStopped.get() || !injectionArmed.get()) return null
        if (playout == null) return legacyPlayoutQueue.poll()
        return try {
            synchronized(playoutLock) { pullLocked(fromPlayback = true)?.pcm }
        } catch (_: Exception) {
            signalFatal("decode_or_record_failed"); null
        }
    }

    private var catchUpOn = false
    private var catchUpEdges = 0

    /**
     * S75 `media.catchup` on each latch enter / exit, at most [CATCHUP_DIAG_ROWS] per call (drops keep
     * counting in `media.session_end`). Caller holds [playoutLock] on the playback thread: only plain
     * values are read here and the row is built on the diag worker (an unbounded single-thread queue).
     */
    private fun logCatchUpEdgeLocked(buffer: OpusPlayoutBuffer) {
        val mode = buffer.catchUpMode
        if ((mode != null) == catchUpOn) return
        catchUpOn = mode != null
        if (++catchUpEdges > CATCHUP_DIAG_ROWS) return
        val fields = mapOf("state" to if (catchUpOn) "on" else "off", "mode" to mode, "depthMs" to buffer.depthUs() / 1_000,
            "targetMs" to playoutProfile.delayMs, "quietDrops" to buffer.catchUpQuietDrops,
            "forcedDrops" to buffer.catchUpForcedDrops, "edge" to catchUpEdges)
        val callId = diagCallId
        GatewayDiag.post { GatewayDiag.log("media.catchup", fields, callId = callId) }
    }

    /** Caller holds [playoutLock]. Drains arrivals, pulls one tick and posts its recording work. */
    private fun pullLocked(fromPlayback: Boolean): PlayoutTick? {
        val buffer = checkNotNull(playout)
        drainArrivalsLocked(buffer)
        val tick = buffer.pull(relativeNow(), playoutDecoder)
        logCatchUpEdgeLocked(buffer)
        if (tick.missingSlots > 0) {
            callerDrops.addAndGet(tick.missingSlots.toLong()); pendingCallerDrops.addAndGet(tick.missingSlots.toLong())
        }
        tick.originals.forEach { (pcm, pts) ->
            val anchor = originalSourceAnchor ?: pts.also { originalSourceAnchor = it; originalTimelineAnchor = relativeNow() }
            val timeline = (originalTimelineAnchor + pts - anchor).coerceAtLeast(0L)
            postRecord(RecordWork(OriginalAudioTrack.CALLER_ORIGINAL, pcm, timeline, pts))
        }
        if (tick.audio) prebufferReady.complete(true)
        if (!fromPlayback) return tick
        if (tick.audio && playoutTimelineAnchor == null) playoutTimelineAnchor = relativeNow()
        val anchor = playoutTimelineAnchor ?: return tick
        val timeline = anchor + playoutTicks * FRAME_US
        playoutTicks++
        if (tick.audio) postRecord(RecordWork(OriginalAudioTrack.CALLER_ORIGINAL, checkNotNull(tick.pcm).copyOf(),
            timeline, tick.sourcePtsUs, tick.recoveryKind, derivedPlayout = true, originalToo = false))
        return tick
    }

    private fun drainArrivalsLocked(buffer: OpusPlayoutBuffer) {
        while (true) {
            val arrival = decodeQueue.poll() ?: return
            ingestLocked(buffer, arrival)
        }
    }

    private fun ingestLocked(buffer: OpusPlayoutBuffer, arrival: RemoteWork) {
        rxPackets.incrementAndGet()
        codec.inspect(arrival.packet)?.let { info ->
            if (info.hasLbrr) rxLbrrPackets.incrementAndGet()
            (info.bandwidth - 1101).takeIf { it in 0..4 }?.let { rxBandwidth[it]++ }
        }
        if (newLeg.compareAndSet(true, false)) buffer.resetStream()
        buffer.offer(arrival.packet, arrival.receivedTimelineUs)
        if (buffer.streamResets != seenStreamResets) {
            // A new stream's PTS says nothing about the old one: caller_original re-anchors at now.
            seenStreamResets = buffer.streamResets; originalSourceAnchor = null
        }
    }

    /** S70: every recording hand-off drops its oldest entry; lost caller frames are counted. */
    private fun postRecord(work: RecordWork) {
        while (!recordQueue.offer(work)) {
            val dropped = recordQueue.poll() ?: continue
            when {
                dropped.track == OriginalAudioTrack.REMOTE_ORIGINAL -> {
                    remoteDrops.incrementAndGet(); pendingRemoteDrops.incrementAndGet()
                }
                else -> {
                    callerRecordDrops.incrementAndGet()
                    if (dropped.originalToo) { callerDrops.incrementAndGet(); pendingCallerDrops.incrementAndGet() }
                }
            }
        }
    }

    private fun sampleCarrierCodec() {
        runCatching { carrierAudioCodecSource() }.getOrNull()?.takeIf { it != "unknown" }?.let { carrierCodec = it }
    }

    /** S70 媒体会话结束 diagnostics; never part of the archive manifest. */
    internal fun sessionEndDiagnostics(): Map<String, Any?> {
        val buffer = playout
        val playoutFields: Map<String, Any?> = synchronized(playoutLock) {
            buffer?.diagnostics() ?: mapOf("playoutTargetMs" to playoutProfile.delayMs, "playoutDepthP95Ms" to 0L,
                "underrunTicks" to 0L, "zeroFillFrames" to 0L, "plcFrames" to 0L, "fecRecoveredFrames" to 0L,
                "catchUpQuietDrops" to 0L, "catchUpForcedDrops" to 0L, "reorderedPackets" to 0L)
        }
        val bands = synchronized(playoutLock) { rxBandwidth.copyOf() }
        return playoutFields + sendCounters() + mapOf(
            "rxPackets" to rxPackets.get(), "rxLbrrPackets" to rxLbrrPackets.get(),
            "rxBandwidth" to org.json.JSONObject(mapOf("nb" to bands[0], "mb" to bands[1], "wb" to bands[2],
                "swb" to bands[3], "fb" to bands[4])),
            "callerRecordDrops" to callerRecordDrops.get(), "decoderComplexity" to codec.decoderComplexity,
            "carrierAudioCodec" to carrierCodec, "captureSampleRate" to endpoint.captureSampleRate(),
            "remotePacketDrops" to packetDrops.get(), "injectionDrops" to injectionDrops.get(),
            "turnHost" to transport.turnHost, "transport" to transport.iceTransport,
            "rejoins" to rejoins.get(),
        )
    }

    /** S72c: send side (mic -> DataChannel); read after close() too, so stats failures read as 0. */
    private fun sendCounters(): Map<String, Long> = mapOf(
        "txPackets" to txPackets.get(), "encodeQueueDrops" to encodeQueueDrops.get(),
        "transportSendDrops" to transportSendDrops.get(),
        "transportBackpressureDrops" to (runCatching { transport.networkStats()["transportBackpressureDrops"] }.getOrNull() ?: 0L),
    )

    /** S72c: one `media.stats` row per [STATS_INTERVAL_US] while running; called from [recordingLoop]. */
    private fun maybeLogStats() {
        val now = relativeNow()
        if (!running.get() || now - statsPreviousUs < STATS_INTERVAL_US) return
        val buffer = playout
        val (playoutCounters, depthMs, histogram) = synchronized(playoutLock) {
            Triple(buffer?.diagnostics().orEmpty() - setOf("playoutTargetMs", "playoutDepthP95Ms"),
                (buffer?.depthUs() ?: 0L) / 1_000L, buffer?.depthHistogramSnapshot())
        }
        val current = playoutCounters + sendCounters() + mapOf("rxPackets" to rxPackets.get(), "rejoins" to rejoins.get())
        val window = histogram?.let { h -> statsPreviousHistogram?.let { p -> LongArray(h.size) { h[it] - p[it] } } ?: h }
        runCatching {
            GatewayDiag.log("media.stats", mediaStatsFields(statsPrevious, current) + mapOf(
                "ms" to now / 1_000, "intervalMs" to (now - statsPreviousUs) / 1_000,
                "playoutDepthMs" to depthMs, "playoutDepthP95WindowMs" to (window?.let(OpusPlayoutBuffer::p95Ms) ?: 0L),
                "transport" to transport.iceTransport,
            ), callId = diagCallId)
        }
        statsPrevious = current; statsPreviousHistogram = histogram; statsPreviousUs = now
    }

    /**
     * S73 D3/D5: an established leg's loss rebuilds only the transport; endpoint, capture/injection,
     * recording and mute lease stay. Protocol errors, pre-start losses and sessions without a
     * [rejoiner] keep the old fatal path, as does an exhausted rejoin (same `transport_disconnected`
     * code, so a racing hangup still upgrades the terminal state).
     */
    internal fun onTransportFailure(code: String, reason: String = code) {
        val rejoiner = rejoiner
        if (rejoiner == null || code != "transport_disconnected" || !established.get() || !running.get()) {
            signalFatal(code); return
        }
        if (!rejoining.compareAndSet(false, true)) return
        rejoinScope.launch {
            val lostUs = relativeNow()
            val failed = transport
            val original = IceTransport.entries.firstOrNull { it.wireValue == failed.iceTransport } ?: IceTransport.UDP
            // Frees the TURN allocation and lets the bridge see the old leg go (fewer 409s).
            runCatching { failed.close() }
            val next = rejoinMediaLeg(original, failed.relayTurn, { relativeNow() / 1_000 }, { delay(it) },
                { attempt, used, ok, error, attemptMs ->
                    // S75 共同约定: ms = this attempt, downMs = since the leg dropped.
                    GatewayDiag.log("media.rejoin", mapOf("attempt" to attempt, "reason" to reason,
                        "transport" to used.wireValue, "ms" to attemptMs, "downMs" to (relativeNow() - lostUs) / 1_000,
                        "ok" to ok) +
                        (error?.let { mapOf("error" to (it.message ?: it.javaClass.simpleName).take(120),
                            "offline" to rejoiner.isOffline(it)) } ?: emptyMap()),
                        callId = diagCallId, level = if (ok) "info" else "warn")
                }, rejoiner::isOffline, rejoiner::awaitNetwork) { used, budgetMs -> rejoiner.connect(used, budgetMs) }
            if (next == null) { signalFatal("transport_disconnected"); return@launch }
            val installed = synchronized(setupLock) {
                if (!running.get() || ingressStopped.get()) false
                else { transport = next; newLeg.set(true); rejoins.incrementAndGet(); true }
            }
            if (!installed) runCatching { next.close() }
            rejoining.set(false)
        }
    }

    /**
     * S56: ACTIVE on an early-media leg; caller audio reaches the cellular uplink from now on. The mute
     * lease comes first, as in [start]; failing it is the same fatal teardown a normal leg gets.
     */
    fun arm(): Boolean = synchronized(setupLock) {
        if (!running.get() || ingressStopped.get()) return false
        muteAttempted.set(true)
        if (!muteLease.acquireAndMute()) { signalFatal("mute_acquire_failed"); return false }
        injectionArmed.set(true)
        endpoint.arm()
        synchronized(playoutLock) { playout?.trimSetupBacklog() }
        playbackOwnsClock.set(true)
        sampleCarrierCodec()
        true
    }

    /** S56: opens the ACTIVE-time recorder unless teardown began, which would publish an empty archive. */
    fun attachRecorder(create: () -> LocalCallRecorder): Boolean = synchronized(setupLock) {
        if (!running.get() || recorder != null) return false
        pendingRemoteDrops.set(0); pendingCallerDrops.set(0)
        recorder = create()
        true
    }

    fun stats() = AudioMediaSessionStats(
        localRemoteDrops = remoteDrops.get(),
        localCallerDrops = callerDrops.get(),
        encodeQueueDrops = encodeQueueDrops.get(),
        transportSendDrops = transportSendDrops.get(),
        encodeQueueHighWatermark = encodeQueueHighWatermark.get(),
        encodeMaxDurationUs = encodeMaxDurationUs.get(),
        remotePacketDrops = packetDrops.get(),
        injectionDrops = injectionDrops.get(),
    )

    fun stop(terminalState: String = "ended"): Boolean {
        requestTerminalState(terminalState)
        // This fence must run before waiting for the synchronized physical teardown: start() may
        // currently own that monitor while waiting for the prebuffer future.
        requestIngressStop()
        if (!stopping.compareAndSet(false, true)) {
            if (workers.any { it === Thread.currentThread() }) return false
            return teardownDone.await(TEARDOWN_WAIT_MS, TimeUnit.MILLISECONDS) && teardownResult.get() == true
        }
        val success = runCatching { performTeardown(terminalState) }.getOrDefault(false)
        teardownResult.set(success)
        teardownDone.countDown()
        return success
    }

    private fun performTeardown(terminalState: String): Boolean {
        val physical = synchronized(setupLock) {
            requestIngressStop()
            val endpointStopped = runCatching { endpoint.stopAndRelease() }.isSuccess
            val transportStopped = runCatching { transport.close() }.isSuccess
            endpointStopped && transportStopped
        }
        // running=false makes the listener reject new ingress while queued encode/decode work drains.
        workers.filter { it.name != "VoDog.recording" }.forEach { worker ->
            if (worker !== Thread.currentThread()) runCatching { worker.join(JOIN_MS) }
        }
        workers.filter { it.name == "VoDog.recording" }.forEach { worker ->
            if (worker !== Thread.currentThread()) runCatching { worker.join(JOIN_MS) }
        }
        val workersStopped = workers.none(Thread::isAlive)
        flushDropMarkers()
        val codecStopped = workersStopped && runCatching { codec.close() }.isSuccess
        val transportStatsResult = runCatching { transport.networkStats() }
            .onFailure { signalFatal("transport_stats_failed") }
        val transportStats = transportStatsResult.getOrDefault(emptyMap())
        val recorder = recorder
        val recordingFinished = if (workersStopped && recorder == null) true else if (workersStopped && recorder != null) {
            if (requestedTerminalState.get() == "failed" && fatalCode.get() == "transport_disconnected" &&
                terminalUpgradeGraceMs > 0) {
                definitiveTerminal.await(terminalUpgradeGraceMs, TimeUnit.MILLISECONDS)
            }
            val finalStats = stats()
            if ((playout?.overflowDrops ?: 0) > 0) {
                recorder.markCaptureGap(OriginalAudioTrack.CALLER_ORIGINAL, relativeNow(), "media_buffer_discard")
            }
            transportStats["transportMissingPackets"]?.takeIf { it > 0 }?.let { missing ->
                runCatching { recorder.markDropped(OriginalAudioTrack.CALLER_ORIGINAL, relativeNow(), missing) }
            }
            runCatching { recorder.finish(requestedTerminalState.get(), transportStats + codec.encodingStats() + (playout?.stats() ?: emptyMap()) + mapOf(
                        "decoderLibopus" to if (codec.receiveRecoveryEnabled) 1L else 0L,
                        "playoutPlcFrames" to (playout?.plcFrames ?: 0L), "playoutFecAttemptFrames" to (playout?.fecRecoveredFrames ?: 0L)) + mapOf(
                "networkSendDrops" to finalStats.networkSendDrops,
                "encodeQueueDrops" to finalStats.encodeQueueDrops,
                "transportSendDrops" to finalStats.transportSendDrops,
                "encodeQueueHighWatermark" to finalStats.encodeQueueHighWatermark,
                "encodeMaxDurationUs" to finalStats.encodeMaxDurationUs,
                "remotePacketDrops" to finalStats.remotePacketDrops,
                "injectionDrops" to finalStats.injectionDrops,
                "mediaFatalEvents" to if (fatalSignaled.get()) 1L else 0L,
                "terminalUpgradedAfterFailure" to if (terminalUpgradedAfterFailure.get()) 1L else 0L,
            )) }.onFailure { signalFatal("recording_finalize_failed") }.isSuccess
        } else {
            signalFatal("worker_stop_timeout") // Leave .part files for crash recovery; do not race the writer.
            false
        }
        sampleCarrierCodec()
        runCatching { GatewayDiag.log("media.session_end", sessionEndDiagnostics(), callId = diagCallId) }
        val muteRestored = !muteAttempted.get() || runCatching { muteLease.restoreOriginalState() }.getOrDefault(false).also {
            if (!it) signalFatal("mute_restore_failed")
        }
        return physical && workersStopped && codecStopped && transportStatsResult.isSuccess && recordingFinished && muteRestored
    }

    override fun close() { stop() }

    /** Stops cellular injection/capture and network ingress immediately; file/codec drain follows. */
    fun stopEndpointIngress() = synchronized(setupLock) {
        requestIngressStop()
        runCatching { endpoint.stopAndRelease() }
        runCatching { transport.close() }
    }

    /** Main-thread-safe cancellation fence. Physical release is performed by the cleanup worker. */
    fun requestIngressStop() {
        ingressStopped.set(true)
        running.set(false)
        prebufferReady.complete(false)
        // A hangup cancels an in-flight rejoin; the negotiation releases its PC on cancellation.
        rejoinScope.cancel()
    }

    private fun onCellularDownlink(pcm: ByteArray, timestampUs: Long) {
        if (!running.get()) return
        val observedTimelineUs = (timestampUs - timelineOriginUs).coerceAtLeast(0)
        val durationUs = pcm.size * 1_000_000L / PCM_BYTES_PER_SECOND
        val previous = nextRemoteTimelineUs.getAndUpdate { next ->
            (if (next < 0) observedTimelineUs else next) + durationUs
        }
        // AudioRecord may deliver several already-buffered frames in one scheduler turn. Its
        // callback wall time is audit metadata, while the PCM sample count owns the media timeline.
        val timelineUs = if (previous < 0) observedTimelineUs else previous
        postRecord(RecordWork(OriginalAudioTrack.REMOTE_ORIGINAL, pcm.copyOf(), timelineUs, timestampUs))
        // Recording and network are independent; a network queue/drop never changes captureComplete.
        // S70: a full encode queue drops its oldest frame, so the newest audio still goes out.
        val work = PcmWork(pcm.copyOf(), timelineUs)
        while (!encodeQueue.offer(work)) {
            if (encodeQueue.poll() != null) encodeQueueDrops.incrementAndGet()
        }
        encodeQueueHighWatermark.accumulateAndGet(encodeQueue.size.toLong()) { current, observed ->
            maxOf(current, observed)
        }
    }

    private fun startWorkers() {
        workers += worker("VoDog.recording") { recordingLoop() }
        workers += worker("VoDog.opus.encode") { encodeLoop() }
        workers += worker("VoDog.opus.decode") { decodeLoop() }
        workers.forEach(Thread::start)
    }

    private fun recordingLoop() {
        while (mediaProducersDone.count > 0 || recordQueue.isNotEmpty()) {
            maybeLogStats()
            val work = try { recordQueue.poll(100, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {
                Thread.currentThread().interrupt(); return
            }
                ?: continue
            val recorder = recorder ?: continue
            try {
                consumeDrops(recorder, work.track, work.timestampUs)
                if (work.originalToo && work.recoveryKind == null) recorder.append(work.track, work.pcm, work.timestampUs, work.sourceTimestampUs)
                if (work.derivedPlayout) recorder.appendPlayout(work.pcm, work.timestampUs, work.sourceTimestampUs, work.recoveryKind)
            } catch (_: Exception) {
                signalFatal("recording_write_failed")
                return
            }
        }
    }

    private fun encodeLoop() {
        try {
            while (running.get() || encodeQueue.isNotEmpty()) {
                val work = encodeQueue.poll(100, TimeUnit.MILLISECONDS) ?: continue
                val startedNs = System.nanoTime()
                val encodedFrames = try {
                    codec.encode(work.pcm, work.timestampUs)
                } finally {
                    val durationUs = (System.nanoTime() - startedNs).coerceAtLeast(0L) / 1_000L
                    encodeMaxDurationUs.accumulateAndGet(durationUs) { current, observed -> maxOf(current, observed) }
                }
                encodedFrames.forEach { encoded ->
                    sendEncoded(encoded)
                }
            }
            codec.finishEncode(relativeNow()).forEach(::sendEncoded)
        } catch (_: Exception) {
            signalFatal("encode_or_send_failed")
        } finally {
            mediaProducersDone.countDown()
        }
    }

    private fun sendEncoded(encoded: EncodedOpusFrame) {
        val packet = MediaPacket(MediaDirection.CELLULAR_DOWNLINK, FRAME_MS,
            sequence.getAndIncrement() and 0xffff_ffffL, encoded.presentationTimeUs, encoded.payload)
        if (transport.send(packet) == MediaSendResult.SENT) txPackets.incrementAndGet() else transportSendDrops.incrementAndGet()
    }

    private fun decodeLoop() {
        if (codec.receiveRecoveryEnabled) { decodeRecoveryLoop(); return }
        val frames = PcmFrameAccumulator(PCM_FRAME_BYTES)
        var nextSourcePts: Long? = null
        var sourceAnchorUs: Long? = null
        var timelineAnchorUs: Long? = null
        try {
            while (running.get() || decodeQueue.isNotEmpty()) {
                val work = decodeQueue.poll(100, TimeUnit.MILLISECONDS) ?: continue
                codec.decode(work.packet).forEach { (pcm, sourcePts) ->
                    if (frames.pendingByteCount() == 0) {
                        nextSourcePts = sourcePts
                    }
                    frames.append(pcm) { frame ->
                        val frameSourcePts = requireNotNull(nextSourcePts)
                        if (sourceAnchorUs == null) {
                            sourceAnchorUs = frameSourcePts
                            timelineAnchorUs = work.receivedTimelineUs
                        }
                        check(frameSourcePts >= requireNotNull(sourceAnchorUs)) { "decoder PTS regressed" }
                        val timelineUs = requireNotNull(timelineAnchorUs) +
                            (frameSourcePts - requireNotNull(sourceAnchorUs))
                        recordThenQueueForInjection(frame, timelineUs, frameSourcePts)
                        nextSourcePts = requireNotNull(nextSourcePts) + FRAME_US
                    }
                }
            }
            codec.finishDecode(relativeNow()).forEach { (pcm, sourcePts) ->
                if (frames.pendingByteCount() == 0) {
                    nextSourcePts = sourcePts
                }
                frames.append(pcm) { frame ->
                    val frameSourcePts = requireNotNull(nextSourcePts)
                    if (sourceAnchorUs == null) {
                        sourceAnchorUs = frameSourcePts
                        timelineAnchorUs = relativeNow()
                    }
                    check(frameSourcePts >= requireNotNull(sourceAnchorUs)) { "decoder PTS regressed" }
                    val timelineUs = requireNotNull(timelineAnchorUs) +
                        (frameSourcePts - requireNotNull(sourceAnchorUs))
                    recordThenQueueForInjection(frame, timelineUs, frameSourcePts)
                    nextSourcePts = requireNotNull(nextSourcePts) + FRAME_US
                }
            }
            if (frames.pendingByteCount() > 0) {
                callerDrops.incrementAndGet(); pendingCallerDrops.incrementAndGet(); frames.discardPartial()
            }
        } catch (_: Exception) {
            signalFatal("decode_or_record_failed")
        } finally {
            mediaProducersDone.countDown()
        }
    }

    /**
     * S70 decode worker for the pull path. It moves arrivals into the playout buffer promptly and,
     * while the AudioTrack does not own the clock (prebuffer, unarmed early leg), pulls and discards
     * one frame per 20 ms so no backlog forms (S37). On teardown it drains received originals.
     */
    private fun decodeRecoveryLoop() {
        val buffer = checkNotNull(playout)
        var nextIdleTickUs = Long.MIN_VALUE
        try {
            while (running.get()) {
                val arrival = decodeQueue.poll(5, TimeUnit.MILLISECONDS)
                synchronized(playoutLock) {
                    if (arrival != null) ingestLocked(buffer, arrival)
                    drainArrivalsLocked(buffer)
                    // Once an armed leg has its prebuffer, stop discarding: the frames queued while
                    // the mute lease and AudioTrack come up are the start of the caller's audio (the
                    // AI greeting); catch-up trims the extra depth once playback owns the clock.
                    val armedAndPrimed = injectionArmed.get() && prebufferReady.isDone
                    if (!playbackOwnsClock.get() && running.get() && !armedAndPrimed) {
                        val now = relativeNow()
                        if (nextIdleTickUs == Long.MIN_VALUE || now >= nextIdleTickUs) {
                            // Priming silence consumes no idle tick; only a played-equivalent tick does.
                            if (pullLocked(fromPlayback = false)?.pcm != null) nextIdleTickUs = if (nextIdleTickUs == Long.MIN_VALUE || now - nextIdleTickUs > IDLE_RESYNC_US) now + FRAME_US
                                else nextIdleTickUs + FRAME_US
                        }
                    }
                }
            }
            synchronized(playoutLock) {
                drainArrivalsLocked(buffer)
                buffer.drainReceived().forEach { packet ->
                    val pcm = playoutDecoder.decode(packet)
                    val anchor = originalSourceAnchor ?: packet.timestampUs.also {
                        originalSourceAnchor = it; originalTimelineAnchor = relativeNow()
                    }
                    postRecord(RecordWork(OriginalAudioTrack.CALLER_ORIGINAL, pcm,
                        (originalTimelineAnchor + packet.timestampUs - anchor).coerceAtLeast(0L), packet.timestampUs))
                }
            }
        } catch (_: Exception) { signalFatal("decode_or_record_failed") }
        finally { mediaProducersDone.countDown() }
    }

    /** Legacy MediaCodec path (no concealment possible): record asynchronously, then hand to playback. */
    private fun recordThenQueueForInjection(pcm: ByteArray, timelineUs: Long, sourcePtsUs: Long) {
        postRecord(RecordWork(OriginalAudioTrack.CALLER_ORIGINAL, pcm.copyOf(), timelineUs, sourcePtsUs))
        // Dropped, not queued: a backlog would burst ringing-time caller audio into the call at ACTIVE.
        if (injectionArmed.get()) {
            while (!legacyPlayoutQueue.offer(pcm.copyOf())) {
                if (legacyPlayoutQueue.poll() != null) injectionDrops.incrementAndGet()
            }
        }
        prebufferReady.complete(true)
    }

    private fun consumeDrops(recorder: LocalCallRecorder, track: OriginalAudioTrack, timestampUs: Long) {
        val count = when (track) {
            OriginalAudioTrack.REMOTE_ORIGINAL -> pendingRemoteDrops.getAndSet(0)
            OriginalAudioTrack.CALLER_ORIGINAL -> pendingCallerDrops.getAndSet(0)
        }
        if (count > 0) recorder.markDropped(track, timestampUs, count)
    }

    private fun flushDropMarkers() {
        val recorder = recorder ?: return
        listOf(OriginalAudioTrack.REMOTE_ORIGINAL to pendingRemoteDrops.getAndSet(0),
            OriginalAudioTrack.CALLER_ORIGINAL to pendingCallerDrops.getAndSet(0)).forEach { (track, count) ->
            if (count > 0) runCatching { recorder.markDropped(track, 0, count) }
        }
    }

    private fun onEndpointFailure(failure: TelephonyAudioEndpoint.Failure) =
        signalFatal("endpoint_${failure.stage.name.lowercase()}_${failure.code.name.lowercase()}")

    private fun signalFatal(code: String) {
        if (!fatalSignaled.compareAndSet(false, true)) return
        fatalCode.set(code)
        requestTerminalState("failed")
        prebufferReady.complete(false)
        GatewayDiag.log("media.session_failed", mapOf("code" to code, "ms" to relativeNow() / 1_000),
            callId = diagCallId, level = "error")
        runCatching { onFatal(code) }
        if (running.get()) Thread { stop("failed") }.start()
    }
    internal fun requestTerminalState(value: String) {
        if (value in setOf("ended", "completed")) {
            while (true) {
                val current = requestedTerminalState.get()
                val mayUpgradeFailure = current == "failed" && fatalCode.get() == "transport_disconnected"
                if (current == "failed" && !mayUpgradeFailure) break
                if (requestedTerminalState.compareAndSet(current, value)) {
                    if (mayUpgradeFailure) terminalUpgradedAfterFailure.set(true)
                    break
                }
            }
            definitiveTerminal.countDown()
        } else {
            requestedTerminalState.compareAndSet("incomplete", value)
        }
    }
    private fun worker(name: String, block: () -> Unit) = Thread({
        // S70: the decode worker drives playout before ACTIVE; recording/encode stay default.
        if (name == "VoDog.opus.decode") runCatching {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
        }
        block()
    }, name)
    private fun relativeNow() = (monotonicUs() - timelineOriginUs).coerceAtLeast(0)

    private data class PcmWork(val pcm: ByteArray, val timestampUs: Long)
    private data class RemoteWork(val packet: MediaPacket, val receivedTimelineUs: Long)
    private data class RecordWork(
        val track: OriginalAudioTrack,
        val pcm: ByteArray,
        val timestampUs: Long,
        val sourceTimestampUs: Long?,
        val recoveryKind: String? = null,
        val derivedPlayout: Boolean = false,
        val originalToo: Boolean = true,
    )

    private companion object {
        const val FRAME_MS = 20
        const val CATCHUP_DIAG_ROWS = 20
        const val FRAME_US = 20_000L
        const val PCM_FRAME_BYTES = 640
        const val RECORD_QUEUE_FRAMES = 100
        const val LEGACY_PLAYOUT_FRAMES = 12
        const val IDLE_RESYNC_US = 100_000L
        // Send side only (mic -> encoder). Real AudioRecord delivery is bursty even when its sample
        // clock is continuous; a bounded 240 ms cushion admits that without permitting stale audio.
        // The receive-side depths moved to OpusPlayoutProfile in S25 decision 1.
        const val ENCODE_QUEUE_FRAMES = 12
        const val PCM_BYTES_PER_SECOND = 32_000L
        const val JOIN_MS = 1_000L
        const val TEARDOWN_WAIT_MS = 8_000L
        const val TERMINAL_UPGRADE_GRACE_MS = 400L
        const val STATS_INTERVAL_US = 30_000_000L
    }
}
