package org.vodog.gateway.media

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder

data class EncodedOpusFrame(val payload: ByteArray, val presentationTimeUs: Long)
data class DecodedPcmChunk(
    val pcm16le: ByteArray,
    val presentationTimeUs: Long,
    val codecOutputSampleRate: Int,
)

/** Thread-confined synchronous MediaCodec wrapper for 16 kHz mono PCM to Opus. */
class OpusMediaCodecEncoder(
    bitRate: Int = 20_000,
    private val frameDurationMs: Int = 20,
) : Closeable {
    private val codec = createEncoder(bitRate, frameDurationMs)
    private var closed = false
    private var negotiatedOutputFormat: MediaFormat? = null

    companion object {
        const val SAMPLE_RATE = 16_000
        const val CHANNELS = 1
        fun bytesForDuration(durationMs: Int) = SAMPLE_RATE * CHANNELS * 2 * durationMs / 1000

        private fun createEncoder(bitRate: Int, frameDurationMs: Int): MediaCodec {
            require(frameDurationMs in setOf(10, 20, 40, 60))
            val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
            try {
                codec.configure(
            MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, SAMPLE_RATE, CHANNELS).apply {
                setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, bytesForDuration(frameDurationMs))
                setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
            },
            null,
            null,
            MediaCodec.CONFIGURE_FLAG_ENCODE,
                )
                codec.start()
                return codec
            } catch (error: Throwable) {
                codec.release()
                throw error
            }
        }

        private const val DEQUEUE_US = 10_000L
        private const val FRAME_DEADLINE_NS = 80_000_000L
        private const val CODEC_DEADLINE_NS = 2_000_000_000L
    }

    fun encode(pcm16le: ByteArray, presentationTimeUs: Long): List<EncodedOpusFrame> {
        check(!closed)
        require(pcm16le.size == bytesForDuration(frameDurationMs)) {
            "expected one ${frameDurationMs}ms PCM frame"
        }
        queueInput(pcm16le, presentationTimeUs, 0)
        return drain(endOfStream = false)
    }

    fun finish(presentationTimeUs: Long): List<EncodedOpusFrame> {
        check(!closed)
        queueInput(ByteArray(0), presentationTimeUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        return drain(endOfStream = true)
    }

    fun outputFormat(): MediaFormat = checkNotNull(negotiatedOutputFormat) { "encoder has not produced output format" }

    private fun queueInput(bytes: ByteArray, ptsUs: Long, flags: Int) {
        val deadline = System.nanoTime() + CODEC_DEADLINE_NS
        while (true) {
            val index = codec.dequeueInputBuffer(DEQUEUE_US)
            if (index >= 0) {
                val input = checkNotNull(codec.getInputBuffer(index)).apply { clear() }
                require(input.capacity() >= bytes.size) { "codec input buffer too small" }
                input.put(bytes)
                codec.queueInputBuffer(index, 0, bytes.size, ptsUs, flags)
                return
            }
            check(System.nanoTime() < deadline) { "timed out waiting for Opus encoder input" }
        }
    }

    private fun drain(endOfStream: Boolean): List<EncodedOpusFrame> {
        val output = mutableListOf<EncodedOpusFrame>()
        val info = MediaCodec.BufferInfo()
        val deadline = System.nanoTime() + if (endOfStream) CODEC_DEADLINE_NS else FRAME_DEADLINE_NS
        while (System.nanoTime() < deadline) {
            when (val index = codec.dequeueOutputBuffer(info, DEQUEUE_US)) {
                MediaCodec.INFO_TRY_AGAIN_LATER -> if (!endOfStream) return output
                MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> negotiatedOutputFormat = codec.outputFormat
                MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> Unit
                else -> if (index >= 0) {
                    try {
                        val isConfig = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                        if (!isConfig && info.size > 0) {
                            output += EncodedOpusFrame(codec.getOutputBuffer(index).copy(info.offset, info.size), info.presentationTimeUs)
                        }
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return output
                    } finally {
                        codec.releaseOutputBuffer(index, false)
                    }
                }
            }
        }
        check(!endOfStream) { "timed out draining Opus encoder" }
        return output
    }

    override fun close() {
        if (closed) return
        closed = true
        runCatching { codec.stop() }
        codec.release()
    }

}

/** Thread-confined synchronous MediaCodec wrapper for Opus to 16 kHz mono PCM. */
class OpusMediaCodecDecoder(format: MediaFormat = defaultFormat()) : Closeable {
    private val codec = createDecoder(format)
    private val normalizer = Pcm16MonoNormalizer()
    private var closed = false
    private var outputSampleRate = OpusMediaCodecEncoder.SAMPLE_RATE

    fun decode(frame: EncodedOpusFrame): List<DecodedPcmChunk> {
        check(!closed)
        queueInput(frame.payload, frame.presentationTimeUs, 0)
        return drain(endOfStream = false)
    }

    fun finish(presentationTimeUs: Long): List<DecodedPcmChunk> {
        check(!closed)
        queueInput(ByteArray(0), presentationTimeUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        return drain(endOfStream = true)
    }

    private fun queueInput(bytes: ByteArray, ptsUs: Long, flags: Int) {
        val deadline = System.nanoTime() + CODEC_DEADLINE_NS
        while (true) {
            val index = codec.dequeueInputBuffer(DEQUEUE_US)
            if (index >= 0) {
                val input = checkNotNull(codec.getInputBuffer(index)).apply { clear() }
                require(input.capacity() >= bytes.size) { "codec input buffer too small" }
                input.put(bytes)
                codec.queueInputBuffer(index, 0, bytes.size, ptsUs, flags)
                return
            }
            check(System.nanoTime() < deadline) { "timed out waiting for Opus decoder input" }
        }
    }

    private fun drain(endOfStream: Boolean): List<DecodedPcmChunk> {
        val output = mutableListOf<DecodedPcmChunk>()
        val info = MediaCodec.BufferInfo()
        val deadline = System.nanoTime() + if (endOfStream) CODEC_DEADLINE_NS else FRAME_DEADLINE_NS
        while (System.nanoTime() < deadline) {
            when (val index = codec.dequeueOutputBuffer(info, DEQUEUE_US)) {
                MediaCodec.INFO_TRY_AGAIN_LATER -> if (!endOfStream) return output
                MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    outputSampleRate = codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                }
                MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> Unit
                else -> if (index >= 0) {
                    try {
                        if (info.size > 0) {
                            val normalized = normalizer.to16k(
                                codec.getOutputBuffer(index).copy(info.offset, info.size),
                                outputSampleRate,
                            )
                            if (normalized.isNotEmpty()) {
                                output += DecodedPcmChunk(normalized, info.presentationTimeUs, outputSampleRate)
                            }
                        }
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return output
                    } finally {
                        codec.releaseOutputBuffer(index, false)
                    }
                }
            }
        }
        check(!endOfStream) { "timed out draining Opus decoder" }
        return output
    }

    override fun close() {
        if (closed) return
        closed = true
        runCatching { codec.stop() }
        codec.release()
    }

    companion object {
        private fun createDecoder(format: MediaFormat): MediaCodec {
            val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
            try {
                codec.configure(format, null, null, 0)
                codec.start()
                return codec
            } catch (error: Throwable) {
                codec.release()
                throw error
            }
        }

        fun defaultFormat(): MediaFormat = MediaFormat.createAudioFormat(
            MediaFormat.MIMETYPE_AUDIO_OPUS,
            OpusMediaCodecEncoder.SAMPLE_RATE,
            OpusMediaCodecEncoder.CHANNELS,
        ).apply {
            val identificationHeader = opusHead16kMono()
            setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
            setByteBuffer("csd-0", ByteBuffer.wrap(identificationHeader))
            setByteBuffer("csd-1", nativeLong(opusPreSkipNanos(identificationHeader)))
            setByteBuffer("csd-2", nativeLong(OPUS_SEEK_PREROLL_NS))
        }

        private fun opusPreSkipNanos(header: ByteArray): Long {
            val samples = (header[10].toInt() and 0xff) or ((header[11].toInt() and 0xff) shl 8)
            return samples * 1_000_000_000L / OPUS_NATIVE_SAMPLE_RATE
        }

        private fun nativeLong(value: Long): ByteBuffer =
            ByteBuffer.allocate(java.lang.Long.BYTES).order(ByteOrder.nativeOrder()).apply {
                putLong(value)
                flip()
            }

        private fun opusHead16kMono() = byteArrayOf(
            0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // OpusHead
            0x01, 0x01, // version, channels
            0x00, 0x00, // pre-skip, little endian
            0x80.toByte(), 0x3e, 0x00, 0x00, // original input rate 16000, little endian
            0x00, 0x00, 0x00, // gain, channel mapping family
        )

        private const val DEQUEUE_US = 10_000L
        private const val FRAME_DEADLINE_NS = 80_000_000L
        private const val CODEC_DEADLINE_NS = 2_000_000_000L
        private const val OPUS_NATIVE_SAMPLE_RATE = 48_000L
        private const val OPUS_SEEK_PREROLL_NS = 80_000_000L
    }
}

/** Stateful mono PCM normalizer. Pixel's Opus decoder outputs 48 kHz regardless of 16 kHz input. */
private class Pcm16MonoNormalizer {
    private val pending48k = ArrayList<Int>(3)

    fun to16k(pcm16le: ByteArray, sourceSampleRate: Int): ByteArray {
        require(pcm16le.size % 2 == 0) { "unaligned PCM16" }
        if (sourceSampleRate == 16_000) return pcm16le.copyOf()
        require(sourceSampleRate == 48_000) { "unsupported decoder output rate $sourceSampleRate" }
        val samples = ArrayList<Int>(pending48k.size + pcm16le.size / 2)
        samples.addAll(pending48k)
        pending48k.clear()
        var index = 0
        while (index < pcm16le.size) {
            samples += ((pcm16le[index].toInt() and 0xff) or (pcm16le[index + 1].toInt() shl 8)).toShort().toInt()
            index += 2
        }
        val completeGroups = samples.size / 3
        val output = ByteArray(completeGroups * 2)
        repeat(completeGroups) { group ->
            val base = group * 3
            // This small box filter attenuates aliases; it is not a production-quality speech resampler.
            val value = (samples[base] + samples[base + 1] + samples[base + 2]) / 3
            output[group * 2] = (value and 0xff).toByte()
            output[group * 2 + 1] = ((value shr 8) and 0xff).toByte()
        }
        for (tail in completeGroups * 3 until samples.size) pending48k += samples[tail]
        return output
    }
}

private fun ByteBuffer?.copy(offset: Int, size: Int): ByteArray {
    val source = checkNotNull(this).duplicate()
    source.position(offset)
    source.limit(offset + size)
    return ByteArray(size).also(source::get)
}
