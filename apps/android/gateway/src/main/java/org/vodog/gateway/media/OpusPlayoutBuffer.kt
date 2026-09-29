package org.vodog.gateway.media

import java.util.TreeMap
import kotlin.math.sqrt

/**
 * S23 decision 1 / S70: the receive-side playout shape a single call runs with.
 *
 * [delayUs] is the S70 target depth T (human 60 ms, AI 200 ms, unchanged since S23). Since S70 the
 * playback clock pulls one 20 ms frame per tick, so the buffer only needs enough capacity for a
 * burst plus the forced catch-up threshold (T + 300 ms): [maxSpanUs] is T + 1 s for both profiles.
 * [resyncUs] is the source-timestamp jump that counts as a discontinuity and resets the decoder.
 * [decodeQueueFrames] is the WebRTC-callback -> playout hand-off; it drops oldest when full.
 */
data class OpusPlayoutProfile(
    val delayUs: Long,
    val maxPackets: Int,
    val maxSpanUs: Long,
    val resyncUs: Long,
    val decodeQueueFrames: Int,
    /** Depth above T at which frames are dropped even mid-speech. */
    val forcedCatchUpUs: Long = FORCED_CATCH_UP_US,
    /** Trim the mute/AudioTrack setup backlog at clock handoff (human legs only). */
    val trimSetupBacklog: Boolean = true,
) {
    val delayMs: Long get() = delayUs / 1_000L

    init {
        require(delayUs in 20_000L..200_000L)
        require(maxSpanUs >= delayUs + forcedCatchUpUs + 500_000L) { "capacity must hold the forced threshold plus a 500 ms burst" }
        require(maxPackets * 20_000L >= maxSpanUs)
        require(resyncUs >= delayUs)
        require(decodeQueueFrames in 12..128)
    }

    companion object {
        /** S70: sized for a 500 ms arrival burst landing between two 20 ms playback ticks. */
        const val ARRIVAL_QUEUE_FRAMES = 64
        val HUMAN = OpusPlayoutProfile(
            delayUs = 60_000L, maxPackets = 53, maxSpanUs = 1_060_000L, resyncUs = 200_000L,
            decodeQueueFrames = ARRIVAL_QUEUE_FRAMES,
        )
        /**
         * S70c: AI audio arrives in bursts (worker TLS tunnel, bridge SCTP at ~300 ms SRTT). Forced
         * drops at T+300 cut 0.84 s of AI speech on 2026-09-26 (call 59dd35e5); AI legs keep S23's
         * "latency over lost words" and catch up on the silence the worker pushes between turns.
         */
        val AI = OpusPlayoutProfile(
            delayUs = 200_000L, maxPackets = 85, maxSpanUs = 1_700_000L, resyncUs = 400_000L,
            decodeQueueFrames = ARRIVAL_QUEUE_FRAMES, forcedCatchUpUs = 1_000_000L, trimSetupBacklog = false,
        )
        fun forAnsweredByAi(answeredByAi: Boolean): OpusPlayoutProfile = if (answeredByAi) AI else HUMAN
    }
}

/** S70 catch-up thresholds (above T) and rules, shared with CellDock. */
internal const val CATCH_UP_US = 60_000L
internal const val FORCED_CATCH_UP_US = 300_000L
internal const val CATCH_UP_HOLD_TICKS = 50 // 1 s of 20 ms ticks
internal const val QUIET_RMS = 300.0
internal const val EMPTY_PLC_TICKS = 3
internal const val REPRIME_AFTER_DRY_US = 200_000L
internal const val FRAME_BYTES = 640
private const val FRAME_US = 20_000L
private const val BYTES_PER_US_DIVISOR = 32L // 32 bytes per ms of 16 kHz mono PCM16

/** What the playout engine needs from a decoder; the session adapts [AudioSessionCodec] to it. */
interface PlayoutDecoder {
    fun decode(packet: MediaPacket): ByteArray
    /** Returns PCM plus "fec_attempt" or "plc". */
    fun conceal(next: MediaPacket?, timestampUs: Long, durationMs: Int): Pair<ByteArray, String>
    fun resetDecoder()
}

/**
 * One playback tick. [pcm] is exactly one 20 ms frame, or null for priming silence at call start
 * (nothing has been played yet). [originals] are every normally decoded chunk produced this tick,
 * including frames that catch-up discarded (S10 `caller_original`). [missingSlots] are source slots
 * that never arrived and were concealed.
 */
class PlayoutTick(
    val pcm: ByteArray?,
    val zeroFill: Boolean,
    val recoveryKind: String?,
    val sourcePtsUs: Long,
    val originals: List<Pair<ByteArray, Long>>,
    val missingSlots: Int,
) {
    val audio: Boolean get() = pcm != null && !zeroFill
}

/**
 * S70 pull-mode jitter buffer. The playback clock (AudioTrack TYPE_TELEPHONY) calls [pull] once per
 * 20 ms tick; decode, FEC and PLC happen on demand, so there is no wall-clock-driven inject queue and
 * at most the remainder of one multi-frame packet sits decoded between the decoder and the track.
 * Not thread-safe: the session serializes [offer] and [pull] under one lock that the network
 * callback never takes.
 */
class OpusPlayoutBuffer(private val profile: OpusPlayoutProfile = OpusPlayoutProfile.HUMAN) {
    private val delayUs = profile.delayUs
    private val packets = TreeMap<Long, MediaPacket>()
    private val pending = ArrayDeque<Segment>()
    private var pendingBytes = 0
    private var nextUs: Long? = null
    private var initialSourceUs = 0L
    private var maxSeenUs = Long.MIN_VALUE
    private var started = false
    private var playing = false
    private var primeSinceUs: Long? = null
    private var reprime = false
    private var emptyTicks = 0
    private var overTicks = 0
    private var forcedCatchUp = false
    private var quietCatchUp = false
    private var lastPacketSequence: Long? = null
    private var missingStartUs: Long? = null
    private var lastOfferedSequence: Long? = null
    private var decoderResetPending = false
    private val depthHistogram = LongArray(DEPTH_BUCKETS)

    var lateDiscarded = 0L; private set
    var duplicates = 0L; private set
    var overflowDrops = 0L; private set
    var resyncs = 0L; private set
    var missingFrames = 0L; private set
    var reorderedPackets = 0L; private set
    var underrunTicks = 0L; private set
    var zeroFillFrames = 0L; private set
    var plcFrames = 0L; private set
    var fecRecoveredFrames = 0L; private set
    var catchUpQuietDrops = 0L; private set
    var catchUpForcedDrops = 0L; private set
    /** S73 D4: new legs / sequence discontinuities that restarted playout. */
    var streamResets = 0L; private set

    /** S75: the S74a catch-up latch, `forced` / `quiet`, or null when not catching up. */
    val catchUpMode: String? get() = if (forcedCatchUp) "forced" else if (quietCatchUp) "quiet" else null

    private class Segment(var pcm: ByteArray, val kind: String?, var ptsUs: Long)

    fun offer(packet: MediaPacket, nowUs: Long) {
        require(packet.direction == MediaDirection.USER_UPLINK)
        lastOfferedSequence?.let { if (isStreamDiscontinuity(it, packet)) resetStream() }
        lastOfferedSequence = packet.sequence
        if (packets.containsKey(packet.timestampUs)) { duplicates++; return }
        if (packet.timestampUs < maxSeenUs) reorderedPackets++
        maxSeenUs = maxOf(maxSeenUs, packet.timestampUs)
        val expected = nextUs
        if (expected != null && packet.timestampUs < expected) {
            // The startup reorder window is the cushion itself, as in S20/S23.
            if (!started && packet.timestampUs >= initialSourceUs - delayUs) nextUs = packet.timestampUs
            else { lateDiscarded++; return }
        }
        if (expected == null) { nextUs = packet.timestampUs; initialSourceUs = packet.timestampUs }
        packets[packet.timestampUs] = packet
        // Overflow drops the oldest audio: the newest is what the caller is saying now.
        while (packets.size > profile.maxPackets || spanUs() > profile.maxSpanUs) {
            packets.pollFirstEntry(); overflowDrops++
            nextUs = maxOf(checkNotNull(nextUs), packets.firstKey())
        }
        if (!playing && primeSinceUs == null) primeSinceUs = nowUs
    }

    /**
     * S73 D4: a sequence jump > [STREAM_RESET_SEQUENCE_GAP] either way, or a newer packet whose timestamp
     * sits further behind the play point than the buffer can hold (the bridge's per-leg RTP clock
     * restarts at 0 when a client rejoins while its seq stays room-level), starts a new stream.
     */
    private fun isStreamDiscontinuity(previous: Long, packet: MediaPacket): Boolean {
        val delta = ((packet.sequence - previous) and 0xffff_ffffL).toInt()
        if (delta > STREAM_RESET_SEQUENCE_GAP || delta < -STREAM_RESET_SEQUENCE_GAP) return true
        val playPoint = nextUs ?: return false
        return delta > 0 && packet.timestampUs < playPoint - profile.maxSpanUs
    }

    /**
     * S73 D4: a new leg (or a discontinuity) is a new stream, not stale packets: drop what is queued,
     * forget the play point and prime again; the decoder restarts clean. Counters are kept.
     */
    fun resetStream() {
        packets.clear(); pending.clear(); pendingBytes = 0
        nextUs = null; initialSourceUs = 0L; maxSeenUs = Long.MIN_VALUE
        started = false; playing = false; primeSinceUs = null; reprime = false
        emptyTicks = 0; overTicks = 0; forcedCatchUp = false; quietCatchUp = false
        lastPacketSequence = null; missingStartUs = null; lastOfferedSequence = null
        decoderResetPending = true; streamResets++
    }

    /**
     * Audio queued ahead of the play point: decoded remainder plus the span from the play point to
     * the end of the newest arrived packet. A lost packet inside that span is still latency (it will
     * be concealed in its slot), so it counts; otherwise every loss would read as a shallow buffer.
     */
    fun depthUs(): Long = depthFromUs(nextUs ?: return 0L)

    private fun depthFromUs(from: Long): Long {
        val pendingUs = pendingBytes * 1_000L / BYTES_PER_US_DIVISOR
        val last = packets.lastEntry()?.value ?: return pendingUs
        return pendingUs + maxOf(0L, last.timestampUs + last.durationMs * 1_000L - from)
    }

    /**
     * Called once when the telephony sink takes the clock: audio queued while the mute lease and
     * AudioTrack came up is trimmed to T+20 by the forced catch-up (one extra frame per tick), instead
     * of waiting for quiet frames that a talking caller may never produce (S70 acceptance: +100 ms
     * standing depth on human calls). S74a: T+20, not T+60 — stopping at the entry threshold parked
     * the buffer at T+60 and arrival jitter pushed the window p95 to T+100.
     */
    fun trimSetupBacklog() {
        if (profile.trimSetupBacklog && depthUs() > delayUs + CATCH_UP_US) forcedCatchUp = true
    }

    fun pull(nowUs: Long, decoder: PlayoutDecoder): PlayoutTick {
        val originals = mutableListOf<Pair<ByteArray, Long>>()
        val missing = IntArray(1)
        if (nextUs == null) return silence(false)
        if (!playing) {
            // After a dry spell the play point still sits at the start of the hole; measure the
            // cushion from the first queued packet so a resume after a long gap re-primes to T.
            val primeDepthUs = if (reprime && packets.isNotEmpty()) {
                depthFromUs(maxOf(checkNotNull(nextUs), packets.firstKey()))
            } else depthUs()
            val primed = packets.isNotEmpty() && (primeDepthUs >= delayUs ||
                primeSinceUs?.let { nowUs - it >= delayUs } == true)
            if (!primed) {
                if (reprime) { underrunTicks++; zeroFillFrames++ }
                return silence(reprime)
            }
            playing = true; started = true; emptyTicks = 0; overTicks = 0
            if (reprime) {
                // The hole was already filled with PLC and zeros in real time; resume at the audio.
                val first = packets.firstKey()
                if (first > checkNotNull(nextUs)) nextUs = first
                reprime = false
            }
        }
        var frame = takeFrame(decoder, originals, missing)
        if (frame == null) {
            underrunTicks++; emptyTicks++
            recordDepth()
            if (emptyTicks <= EMPTY_PLC_TICKS) {
                // Stretch, do not skip: the media clock stays put so a late packet still plays.
                val (pcm, _) = decoder.conceal(null, checkNotNull(nextUs), 20)
                plcFrames++
                return PlayoutTick(fit(pcm), false, "plc", checkNotNull(nextUs), originals, missing[0])
            }
            zeroFillFrames++
            if (emptyTicks * FRAME_US >= REPRIME_AFTER_DRY_US) {
                playing = false; reprime = true; primeSinceUs = if (packets.isEmpty()) null else nowUs
            }
            return PlayoutTick(ByteArray(FRAME_BYTES), true, null, checkNotNull(nextUs), originals, missing[0])
        }
        emptyTicks = 0
        val depth = depthUs()
        // S74a: 1 s of ticks above T+60 since the buffer last reached T+20. Jitter dips in between
        // do not restart the count (S70 reset at T+40 let drift and jitter park the buffer at T+60..T+100).
        overTicks = when {
            depth > delayUs + CATCH_UP_US -> overTicks + 1
            depth > delayUs + FRAME_US -> overTicks
            else -> 0
        }
        if (depth > delayUs + profile.forcedCatchUpUs) forcedCatchUp = true
        // S74a: quiet catch-up latches once depth has held above T+60 for 1 s and keeps dropping
        // silent frames until T+20; both modes exit at T+20 so the buffer does not park at T+60.
        if (overTicks >= CATCH_UP_HOLD_TICKS) quietCatchUp = true
        if (depth <= delayUs + FRAME_US) { forcedCatchUp = false; quietCatchUp = false }
        val quiet = quietCatchUp && frame.recoveryKind == null && rms(frame.pcm) < QUIET_RMS
        if (forcedCatchUp || quiet) {
            // Decoded already (decoder state kept); discard it and take one more frame this tick.
            val replacement = takeFrame(decoder, originals, missing)
            if (replacement != null) {
                if (forcedCatchUp) catchUpForcedDrops++ else catchUpQuietDrops++
                frame = replacement
                if (depthUs() <= delayUs + FRAME_US) { forcedCatchUp = false; quietCatchUp = false }
            }
        }
        recordDepth()
        return PlayoutTick(frame.pcm, false, frame.recoveryKind, frame.ptsUs, originals, missing[0])
    }

    /** Teardown: every packet still queued at or after the play point, in order, for the original track. */
    fun drainReceived(): List<MediaPacket> {
        val from = nextUs ?: return emptyList()
        return packets.tailMap(from, true).values.toList().also { packets.clear() }
    }

    fun stats() = mapOf("playoutLateDiscarded" to lateDiscarded, "playoutDuplicates" to duplicates,
        "playoutOverflowDrops" to overflowDrops, "playoutResyncs" to resyncs,
        "playoutMissingFrames" to missingFrames)

    /** S70 diagnostic counters (media.session_end only; never the archive manifest). */
    fun diagnostics(): Map<String, Long> = mapOf(
        "playoutTargetMs" to profile.delayMs, "playoutDepthP95Ms" to depthP95Ms(),
        "underrunTicks" to underrunTicks, "zeroFillFrames" to zeroFillFrames, "plcFrames" to plcFrames,
        "fecRecoveredFrames" to fecRecoveredFrames, "catchUpQuietDrops" to catchUpQuietDrops,
        "catchUpForcedDrops" to catchUpForcedDrops, "reorderedPackets" to reorderedPackets,
        "streamResets" to streamResets,
    )

    fun depthP95Ms(): Long = p95Ms(depthHistogram)

    /** S72c: copied per `media.stats` window; p95 of the window = [p95Ms] of (now - previous). */
    fun depthHistogramSnapshot(): LongArray = depthHistogram.copyOf()

    private class Frame(val pcm: ByteArray, val recoveryKind: String?, val ptsUs: Long)

    private fun silence(zero: Boolean) = PlayoutTick(if (zero) ByteArray(FRAME_BYTES) else null, zero, null,
        nextUs ?: 0L, emptyList(), 0)

    private fun takeFrame(decoder: PlayoutDecoder, originals: MutableList<Pair<ByteArray, Long>>, missing: IntArray): Frame? {
        while (pendingBytes < FRAME_BYTES) {
            if (!decodeNext(decoder, originals, missing)) {
                if (pendingBytes == 0) return null
                // A 10 ms remainder with nothing behind it: conceal the other half rather than stall.
                val (pcm, kind) = decoder.conceal(null, checkNotNull(nextUs), 10)
                plcFrames++
                push(Segment(pcm, kind, checkNotNull(nextUs)))
                if (pendingBytes < FRAME_BYTES) push(Segment(ByteArray(FRAME_BYTES - pendingBytes), kind, checkNotNull(nextUs)))
            }
        }
        val out = ByteArray(FRAME_BYTES)
        var filled = 0
        var kind: String? = null
        var first = true
        var pts = 0L
        while (filled < FRAME_BYTES) {
            val segment = pending.first()
            if (first) { kind = segment.kind; pts = segment.ptsUs; first = false }
            else if (kind != segment.kind) kind = "mixed_recovery"
            val count = minOf(segment.pcm.size, FRAME_BYTES - filled)
            System.arraycopy(segment.pcm, 0, out, filled, count)
            filled += count
            if (count == segment.pcm.size) pending.removeFirst()
            else {
                segment.pcm = segment.pcm.copyOfRange(count, segment.pcm.size)
                segment.ptsUs += count * 1_000L / BYTES_PER_US_DIVISOR
            }
        }
        pendingBytes -= FRAME_BYTES
        return Frame(out, kind, pts)
    }

    private fun push(segment: Segment) { pending.addLast(segment); pendingBytes += segment.pcm.size }

    private fun decodeNext(decoder: PlayoutDecoder, originals: MutableList<Pair<ByteArray, Long>>, missing: IntArray): Boolean {
        var expected = nextUs ?: return false
        if (decoderResetPending && packets.isNotEmpty()) { decoder.resetDecoder(); decoderResetPending = false }
        while (packets.isNotEmpty() && packets.firstKey() < expected) { packets.pollFirstEntry(); lateDiscarded++ }
        val first = packets.firstEntry()?.value ?: return false
        if (first.timestampUs - expected > profile.resyncUs) {
            // DTX or a source-clock jump: no concealment train, and the decoder starts clean.
            decoder.resetDecoder(); resyncs++
            lastPacketSequence = null; missingStartUs = null
            expected = first.timestampUs; nextUs = expected
        }
        val packet = packets.remove(expected)
        if (packet != null) {
            nextUs = expected + packet.durationMs * 1_000L
            lastPacketSequence = packet.sequence; missingStartUs = null
            val pcm = decoder.decode(packet)
            originals += pcm to packet.timestampUs
            push(Segment(pcm, null, packet.timestampUs))
            return true
        }
        val next = packets.firstEntry()?.value
        if (missingStartUs == null) missingStartUs = expected
        val duration = if (next != null && next.timestampUs - expected == 10_000L) 10 else 20
        nextUs = expected + duration * 1_000L
        missingFrames++; missing[0]++
        val fecCandidate = next?.takeIf {
            it.timestampUs == nextUs && it.timestampUs - checkNotNull(missingStartUs) == duration * 1_000L &&
                it.durationMs == duration && lastPacketSequence?.let { previous ->
                    ((it.sequence - previous) and 0xffff_ffffL) == 2L
                } == true
        }
        val (pcm, kind) = decoder.conceal(fecCandidate, expected, duration)
        if (kind == "fec_attempt") fecRecoveredFrames++ else plcFrames++
        push(Segment(pcm, kind, expected))
        return true
    }

    private fun spanUs(): Long {
        if (packets.isEmpty()) return 0L
        val last = packets.lastEntry().value
        return last.timestampUs + last.durationMs * 1_000L - packets.firstKey()
    }

    private fun recordDepth() {
        val bucket = (depthUs() / 1_000L / DEPTH_BUCKET_MS).toInt().coerceIn(0, DEPTH_BUCKETS - 1)
        depthHistogram[bucket]++
    }

    private fun fit(pcm: ByteArray): ByteArray = if (pcm.size == FRAME_BYTES) pcm else pcm.copyOf(FRAME_BYTES)

    companion object {
        private const val DEPTH_BUCKET_MS = 10L
        internal const val STREAM_RESET_SEQUENCE_GAP = 50
        internal fun p95Ms(histogram: LongArray): Long {
            val total = histogram.sum()
            if (total == 0L) return 0L
            var seen = 0L
            for (index in histogram.indices) {
                seen += histogram[index]
                if (seen * 100 >= total * 95) return index * DEPTH_BUCKET_MS
            }
            return (histogram.size - 1) * DEPTH_BUCKET_MS
        }
        private const val DEPTH_BUCKETS = 301 // 0..3000 ms
    }
}

/** RMS of a PCM16LE buffer, in int16 units. */
internal fun rms(pcm: ByteArray): Double {
    var total = 0.0
    val samples = pcm.size / 2
    for (index in 0 until samples) {
        val value = ((pcm[index * 2 + 1].toInt() shl 8) or (pcm[index * 2].toInt() and 0xff)).toShort().toDouble()
        total += value * value
    }
    return if (samples == 0) 0.0 else sqrt(total / samples)
}
