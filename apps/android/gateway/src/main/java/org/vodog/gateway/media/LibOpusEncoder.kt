package org.vodog.gateway.media

import java.io.Closeable

data class LibOpusEncoderConfig(
    // S70: opus_loss_harness at FEC 12% keeps 99.4% of voiced packets wideband at 20 kbps (16 kbps
    // drops LBRR entirely), so 20000 is the floor for the >= 95% WB rule. S73: 28 kbps for headroom
    // (audio analysis: LBRR at 12% eats most of 20 kbps); still WB, FEC on, complexity 10.
    val bitRate: Int = 28_000,
    val expectedLossPercent: Int = 12,
    val fecEnabled: Boolean = true,
) {
    init {
        require(bitRate in 6_000..64_000) { "bitRate must be between 6000 and 64000" }
        require(expectedLossPercent in 10..15) {
            "expectedLossPercent must be between 10 and 15 for this isolated candidate"
        }
        require(fecEnabled) { "this isolated libopus candidate requires in-band FEC" }
    }
}

data class LibOpusEncoderDiagnostics(
    val codecVersion: String,
    val sampleRate: Int,
    val channels: Int,
    val frameDurationMs: Int,
    val bitRate: Int,
    val fecEnabled: Boolean,
    val expectedLossPercent: Int,
)

/**
 * Synchronous libopus candidate for exactly one 20 ms, 16 kHz mono PCM16LE frame per call.
 *
 * The instance owns one native encoder. Public methods are synchronized because construction,
 * encoding, and teardown can occur on different session lifecycle threads.
 */
class LibOpusEncoder(
    config: LibOpusEncoderConfig = LibOpusEncoderConfig(),
) : Closeable {
    private var nativeHandle: Long
    val diagnostics: LibOpusEncoderDiagnostics

    init {
        nativeHandle = nativeCreate(
            config.bitRate,
            config.expectedLossPercent,
            config.fecEnabled,
        )
        try {
            val applied = nativeReadConfig(nativeHandle)
            check(applied.size == 6) { "invalid native libopus configuration response" }
            check(applied[0] == config.bitRate) { "native libopus bitrate CTL mismatch" }
            check(applied[1] == if (config.fecEnabled) 1 else 0) { "native libopus FEC CTL mismatch" }
            check(applied[2] == config.expectedLossPercent) { "native libopus loss CTL mismatch" }
            check(applied[3] == OPUS_SIGNAL_VOICE) { "native libopus signal CTL mismatch" }
            check(applied[4] == OPUS_BANDWIDTH_WIDEBAND) { "native libopus max bandwidth CTL mismatch" }
            check(applied[5] == ENCODER_COMPLEXITY) { "native libopus complexity CTL mismatch" }
            val version = nativeVersion()
            check(version == "libopus $LIBOPUS_VERSION") { "unexpected native libopus version: $version" }
            diagnostics = LibOpusEncoderDiagnostics(
                codecVersion = version,
                sampleRate = SAMPLE_RATE,
                channels = CHANNELS,
                frameDurationMs = FRAME_DURATION_MS,
                bitRate = applied[0],
                fecEnabled = applied[1] == 1,
                expectedLossPercent = applied[2],
            )
        } catch (error: Throwable) {
            nativeDestroy(nativeHandle)
            nativeHandle = 0
            throw error
        }
    }

    @Synchronized
    fun encode(pcm16le: ByteArray, presentationTimeUs: Long): List<EncodedOpusFrame> {
        check(nativeHandle != 0L) { "libopus encoder is closed" }
        require(pcm16le.size == BYTES_PER_FRAME) { "expected one 20ms PCM frame" }
        require(presentationTimeUs >= 0) { "presentationTimeUs must be non-negative" }
        return listOf(EncodedOpusFrame(nativeEncode(nativeHandle, pcm16le), presentationTimeUs))
    }

    /** libopus emits synchronously and therefore has no delayed tail packet. */
    @Synchronized
    fun finish(presentationTimeUs: Long): List<EncodedOpusFrame> {
        check(nativeHandle != 0L) { "libopus encoder is closed" }
        require(presentationTimeUs >= 0) { "presentationTimeUs must be non-negative" }
        @Suppress("UNUSED_VARIABLE")
        val retainedForApiParity = presentationTimeUs
        return emptyList()
    }

    @Synchronized
    override fun close() {
        val handle = nativeHandle
        if (handle == 0L) return
        nativeHandle = 0
        nativeDestroy(handle)
    }

    private external fun nativeCreate(bitRate: Int, expectedLossPercent: Int, fecEnabled: Boolean): Long
    private external fun nativeReadConfig(handle: Long): IntArray
    private external fun nativeEncode(handle: Long, pcm16le: ByteArray): ByteArray
    private external fun nativeDestroy(handle: Long)
    private external fun nativeVersion(): String

    companion object {
        const val LIBOPUS_VERSION = "1.6.1"
        const val SAMPLE_RATE = 16_000
        const val CHANNELS = 1
        const val FRAME_DURATION_MS = 20
        const val SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_DURATION_MS / 1000
        const val BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2
        /** S70 encoder CTLs, fixed in libopus_jni.cpp and read back on every construction. */
        const val OPUS_SIGNAL_VOICE = 3001
        const val OPUS_BANDWIDTH_WIDEBAND = 1103
        const val ENCODER_COMPLEXITY = 10

        init {
            System.loadLibrary("vodog_opus")
        }
    }
}
