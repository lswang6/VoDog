package org.vodog.gateway.media

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import kotlin.math.PI
import kotlin.math.sin

/** Covers the exact default decoder construction used by AndroidAudioSessionCodec. */
@RunWith(AndroidJUnit4::class)
class OpusDefaultDecoderTest {
    @Test fun wireFormatDefaultsProducePcmBeforeEndOfStream() {
        val encoded = OpusMediaCodecEncoder(frameDurationMs = FRAME_MS).use { encoder ->
            buildList {
                repeat(FRAME_COUNT) { index ->
                    addAll(encoder.encode(sineFrame(index), index * FRAME_US))
                }
                addAll(encoder.finish(FRAME_COUNT * FRAME_US))
            }
        }
        assertTrue("encoder produced no Opus access units", encoded.isNotEmpty())

        val result = decodeBeforeEndOfStream(encoded)
        assertPrebufferCanBecomeReady(result, "synthetic")
    }

    @Test fun capturedWireFramesProducePcmBeforeEndOfStream() {
        val fixturePath = InstrumentationRegistry.getArguments().getString(FIXTURE_ARGUMENT)
        assumeTrue("pass -e $FIXTURE_ARGUMENT <private-path> to run captured-frame regression", !fixturePath.isNullOrBlank())
        val frames = readLengthPrefixedFrames(File(requireNotNull(fixturePath)))
        assertTrue("captured fixture contained no Opus frames", frames.isNotEmpty())

        val result = decodeBeforeEndOfStream(frames.mapIndexed { index, payload ->
            EncodedOpusFrame(payload, index * FRAME_US)
        })
        assertPrebufferCanBecomeReady(result, "captured")
    }

    private fun decodeBeforeEndOfStream(frames: List<EncodedOpusFrame>): DecodeResult {
        var firstPcmFrameIndex: Int? = null
        var pcmBytesBeforeEos = 0
        OpusMediaCodecDecoder().use { decoder ->
            frames.forEachIndexed { index, frame ->
                val decodedBytes = decoder.decode(frame).sumOf { it.pcm16le.size }
                if (decodedBytes > 0 && firstPcmFrameIndex == null) firstPcmFrameIndex = index
                pcmBytesBeforeEos += decodedBytes
            }
        }
        return DecodeResult(requireNotNull(firstPcmFrameIndex) {
            "default decoder produced no PCM before EOS; production prebuffer cannot become ready"
        }, pcmBytesBeforeEos)
    }

    private fun assertPrebufferCanBecomeReady(result: DecodeResult, fixture: String) {
        Log.i(TAG, "fixture=$fixture firstPcmFrameIndex=${result.firstPcmFrameIndex} pcmBytesBeforeEos=${result.pcmBytesBeforeEos}")
        assertTrue(
            "first PCM arrived after one second of media; production prebuffer is too late",
            result.firstPcmFrameIndex < MAX_FIRST_PCM_FRAME_INDEX,
        )
        assertTrue(
            "default decoder produced less than one 20ms PCM frame before EOS",
            result.pcmBytesBeforeEos >= OpusMediaCodecEncoder.bytesForDuration(FRAME_MS),
        )
    }

    private fun readLengthPrefixedFrames(file: File): List<ByteArray> {
        require(file.isFile && file.length() in 1..MAX_FIXTURE_BYTES) { "invalid private Opus fixture" }
        return DataInputStream(FileInputStream(file).buffered()).use { input ->
            buildList {
                while (input.available() > 0) {
                    require(size < MAX_FIXTURE_FRAMES) { "too many Opus frames" }
                    val length = input.readInt()
                    require(length in 1..MAX_OPUS_FRAME_BYTES) { "invalid Opus frame length" }
                    require(input.available() >= length) { "truncated Opus frame" }
                    add(ByteArray(length).also(input::readFully))
                }
            }
        }
    }

    private fun sineFrame(frameIndex: Int): ByteArray {
        val samples = OpusMediaCodecEncoder.bytesForDuration(FRAME_MS) / 2
        return ByteArray(samples * 2).also { output ->
            repeat(samples) { index ->
                val absoluteSample = frameIndex * samples + index
                val sample = (sin(2.0 * PI * 440.0 * absoluteSample / OpusMediaCodecEncoder.SAMPLE_RATE) * 10_000)
                    .toInt()
                output[index * 2] = (sample and 0xff).toByte()
                output[index * 2 + 1] = ((sample shr 8) and 0xff).toByte()
            }
        }
    }

    private companion object {
        const val TAG = "OpusDefaultDecoderTest"
        const val FRAME_MS = 20
        const val FRAME_US = 20_000L
        const val FRAME_COUNT = 50
        const val MAX_FIRST_PCM_FRAME_INDEX = 50
        const val FIXTURE_ARGUMENT = "opusFixturePath"
        const val MAX_FIXTURE_BYTES = 1_048_576L
        const val MAX_FIXTURE_FRAMES = 10_000
        const val MAX_OPUS_FRAME_BYTES = 1_500
    }

    private data class DecodeResult(val firstPcmFrameIndex: Int, val pcmBytesBeforeEos: Int)
}
