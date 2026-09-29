package org.vodog.gateway.media

import java.io.Closeable

enum class LibOpusDecodeKind {
    NORMAL,
    FEC_ATTEMPT,
    PLC,
}

data class LibOpusDecodeResult(
    val pcm16le: ByteArray,
    val presentationTimeUs: Long,
    val sampleRate: Int,
    val sampleCount: Int,
    val kind: LibOpusDecodeKind,
    /** Capability evidence only; it does not prove that decoded FEC matched the missing audio. */
    val packetHasLbrr: Boolean,
    /** True only when libopus was actually called with decode_fec=1. */
    val fecAttempted: Boolean,
)

/** Stateful synchronous libopus decoder for 16 kHz mono raw Opus packets. */
class LibOpusDecoder : Closeable {
    private var nativeHandle: Long = nativeCreate()
    val codecVersion: String

    init {
        try {
            codecVersion = nativeVersion().also {
                check(it == "libopus ${LibOpusEncoder.LIBOPUS_VERSION}") {
                    "unexpected native libopus version: $it"
                }
            }
        } catch (error: Throwable) {
            nativeDestroy(nativeHandle)
            nativeHandle = 0
            throw error
        }
    }

    /** Accepts valid Opus packets from 2.5 through 120 ms and returns their actual PCM duration. */
    @Synchronized
    fun decode(payload: ByteArray, presentationTimeUs: Long): LibOpusDecodeResult {
        checkOpen()
        requirePayload(payload)
        require(presentationTimeUs >= 0) { "presentationTimeUs must be non-negative" }
        return result(
            pcm = nativeDecode(nativeHandle, payload, MAX_PACKET_SAMPLES, false),
            presentationTimeUs = presentationTimeUs,
            kind = LibOpusDecodeKind.NORMAL,
            packetHasLbrr = false,
            fecAttempted = false,
        )
    }

    /**
     * Reconstructs the previous 20 ms slot from the following packet when it advertises LBRR.
     * Without LBRR this explicitly returns PLC. FEC_ATTEMPT is not a recovery-quality claim.
     */
    @Synchronized
    fun decodePreviousFromNext(
        nextPayload: ByteArray,
        missingPresentationTimeUs: Long,
        durationMs: Int = 20,
    ): LibOpusDecodeResult {
        checkOpen()
        requirePayload(nextPayload)
        require(missingPresentationTimeUs >= 0) { "presentationTimeUs must be non-negative" }
        val missingSamples = samplesForMissingDuration(durationMs)
        val hasLbrr = nativePacketHasLbrr(nextPayload)
        return if (hasLbrr) {
            result(
                pcm = nativeDecode(nativeHandle, nextPayload, missingSamples, true),
                presentationTimeUs = missingPresentationTimeUs,
                kind = LibOpusDecodeKind.FEC_ATTEMPT,
                packetHasLbrr = true,
                fecAttempted = true,
            )
        } else {
            plcInternal(missingPresentationTimeUs, missingSamples, packetHasLbrr = false)
        }
    }

    /** Produces one bounded 20 ms PLC frame for a known missing packet. */
    @Synchronized
    fun plc(missingPresentationTimeUs: Long, durationMs: Int = 20): LibOpusDecodeResult {
        checkOpen()
        require(missingPresentationTimeUs >= 0) { "presentationTimeUs must be non-negative" }
        return plcInternal(
            missingPresentationTimeUs,
            samplesForMissingDuration(durationMs),
            packetHasLbrr = false,
        )
    }

    /** Public capability inspection; true only proves that the packet carries LBRR. */
    @Synchronized
    fun packetHasLbrr(payload: ByteArray): Boolean {
        checkOpen()
        requirePayload(payload)
        return nativePacketHasLbrr(payload)
    }

    /** S70: OPUS_BANDWIDTH_* (1101 NB .. 1105 FB) of the packet's first frame, or negative when invalid. */
    fun packetBandwidth(payload: ByteArray): Int = nativePacketBandwidth(payload)

    /** S70: the applied decoder complexity; >= 5 means deep PLC conceals missing frames. */
    @Synchronized
    fun complexity(): Int { checkOpen(); return nativeComplexity(nativeHandle) }

    /** Clears predictive decoder state after a confirmed source-clock discontinuity. */
    @Synchronized
    fun reset() {
        checkOpen()
        nativeReset(nativeHandle)
    }

    private fun plcInternal(
        presentationTimeUs: Long,
        sampleCount: Int,
        packetHasLbrr: Boolean,
    ): LibOpusDecodeResult = result(
        pcm = nativeDecode(nativeHandle, null, sampleCount, false),
        presentationTimeUs = presentationTimeUs,
        kind = LibOpusDecodeKind.PLC,
        packetHasLbrr = packetHasLbrr,
        fecAttempted = false,
    )

    private fun result(
        pcm: ByteArray,
        presentationTimeUs: Long,
        kind: LibOpusDecodeKind,
        packetHasLbrr: Boolean,
        fecAttempted: Boolean,
    ): LibOpusDecodeResult {
        check(pcm.isNotEmpty() && pcm.size % 2 == 0) { "native libopus returned invalid PCM16LE" }
        return LibOpusDecodeResult(
            pcm16le = pcm,
            presentationTimeUs = presentationTimeUs,
            sampleRate = SAMPLE_RATE,
            sampleCount = pcm.size / 2,
            kind = kind,
            packetHasLbrr = packetHasLbrr,
            fecAttempted = fecAttempted,
        )
    }

    private fun checkOpen() = check(nativeHandle != 0L) { "libopus decoder is closed" }

    private fun requirePayload(payload: ByteArray) {
        require(payload.size in 1..MAX_PACKET_BYTES) { "invalid Opus payload size" }
    }

    private fun samplesForMissingDuration(durationMs: Int): Int {
        require(durationMs == 10 || durationMs == 20) { "missing duration must be 10 or 20 ms" }
        return SAMPLE_RATE * durationMs / 1000
    }

    @Synchronized
    override fun close() {
        val handle = nativeHandle
        if (handle == 0L) return
        nativeHandle = 0
        nativeDestroy(handle)
    }

    private external fun nativeCreate(): Long
    private external fun nativeDecode(handle: Long, payload: ByteArray?, frameSize: Int, decodeFec: Boolean): ByteArray
    private external fun nativePacketHasLbrr(payload: ByteArray): Boolean
    private external fun nativeReset(handle: Long)
    private external fun nativePacketBandwidth(payload: ByteArray): Int
    private external fun nativeComplexity(handle: Long): Int
    private external fun nativeDestroy(handle: Long)
    private external fun nativeVersion(): String
    private external fun nativeRepacketizeForTest(packets: Array<ByteArray>): ByteArray

    @Synchronized
    internal fun repacketizeForTest(packets: Array<ByteArray>): ByteArray {
        checkOpen()
        require(packets.size in 2..6) { "test repacketizer requires 2..6 packets" }
        packets.forEach(::requirePayload)
        return nativeRepacketizeForTest(packets)
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val CHANNELS = 1
        const val PLC_SAMPLES = 320
        const val MAX_PACKET_SAMPLES = 1_920
        const val MAX_PACKET_BYTES = 1_024

        init {
            System.loadLibrary("vodog_opus")
        }
    }
}
