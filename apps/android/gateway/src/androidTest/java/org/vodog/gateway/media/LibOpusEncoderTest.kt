package org.vodog.gateway.media

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.vodog.gateway.BuildConfig
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.PI
import kotlin.math.sin

/** Synthetic PCM only; never opens telephony, microphone, network or an audio output. */
@RunWith(AndroidJUnit4::class)
class LibOpusEncoderTest {
    @Test fun nativePacketsKeepWireTimingAndDecodeBeforeEos() {
        assumeTrue(BuildConfig.LIBOPUS_FEC_ENABLED)
        val frames = LibOpusEncoder().use { encoder ->
            buildList {
                repeat(100) { index ->
                    val encoded = encoder.encode(frame(index), index * 20_000L)
                    assertEquals("one access unit per PCM frame", 1, encoded.size)
                    assertEquals(index * 20_000L, encoded.single().presentationTimeUs)
                    assertEquals(20, MediaPacketCodec.opusDurationMs(encoded.single().payload))
                    val packet = MediaPacket(MediaDirection.CELLULAR_DOWNLINK, 20, index.toLong(), index * 20_000L, encoded.single().payload)
                    assertEquals(packet, MediaPacketCodec.decode(MediaPacketCodec.encode(packet)))
                    addAll(encoded)
                }
                assertTrue("no invented tail frames", encoder.finish(2_000_000L).isEmpty())
            }
        }
        var pcmBytes = 0
        var firstPcmIndex = -1
        OpusMediaCodecDecoder().use { decoder ->
            frames.forEachIndexed { index, encoded ->
                val bytes = decoder.decode(encoded).sumOf { it.pcm16le.size }
                if (bytes > 0 && firstPcmIndex < 0) firstPcmIndex = index
                pcmBytes += bytes
            }
        }
        assertTrue("native Opus failed default decoder startup", firstPcmIndex in 0..10)
        assertTrue("native Opus failed sustained decoding", pcmBytes >= 50 * 640)
        Log.i("LibOpusEncoderTest", "synthetic=true frames=${frames.size} firstPcmIndex=$firstPcmIndex pcmBytes=$pcmBytes payloadBytes=${frames.sumOf { it.payload.size }}")
    }

    @Test fun closedEncoderRejectsUseAndCloseIsIdempotent() {
        assumeTrue(BuildConfig.LIBOPUS_FEC_ENABLED)
        val encoder = LibOpusEncoder()
        encoder.close()
        encoder.close()
        try {
            encoder.encode(frame(0), 0)
            fail("closed encoder accepted PCM")
        } catch (_: IllegalStateException) { }
    }

    @Test fun nativeEncoderMeetsFrameBudgetAgainstPlatformBaseline() {
        assumeTrue(BuildConfig.LIBOPUS_FEC_ENABLED)
        val nativeTimes = mutableListOf<Long>()
        val platformTimes = mutableListOf<Long>()
        LibOpusEncoder().use { encoder ->
            repeat(120) { index ->
                val pcm = frame(index)
                val started = System.nanoTime()
                encoder.encode(pcm, index * 20_000L)
                if (index >= 20) nativeTimes += (System.nanoTime() - started) / 1000
            }
        }
        OpusMediaCodecEncoder().use { encoder ->
            repeat(120) { index ->
                val pcm = frame(index)
                val started = System.nanoTime()
                encoder.encode(pcm, index * 20_000L)
                if (index >= 20) platformTimes += (System.nanoTime() - started) / 1000
            }
        }
        fun p95(values: List<Long>) = values.sorted()[values.size * 95 / 100]
        Log.i("LibOpusEncoderTest", "benchmarkSynthetic=true nativeP95Us=${p95(nativeTimes)} nativeMaxUs=${nativeTimes.max()} platformP95Us=${p95(platformTimes)} platformMaxUs=${platformTimes.max()}")
        assertTrue("native encoder cannot keep 20ms frame budget", p95(nativeTimes) < 20_000)
    }

    private fun frame(index: Int) = ByteArray(640).also { pcm ->
        repeat(320) { offset ->
            val sampleIndex = index * 320 + offset
            val t = sampleIndex / 16_000.0
            val envelope = 0.55 + 0.35 * sin(2 * PI * 3 * t)
            val wave = sin(2 * PI * 137 * t) + 0.4 * sin(2 * PI * 274 * t) + 0.2 * sin(2 * PI * 959 * t)
            val sample = (wave * envelope * 9000).toInt().coerceIn(-32768, 32767)
            pcm[offset * 2] = sample.toByte()
            pcm[offset * 2 + 1] = (sample shr 8).toByte()
        }
    }
}
