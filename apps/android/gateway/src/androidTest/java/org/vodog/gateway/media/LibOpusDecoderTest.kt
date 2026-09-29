package org.vodog.gateway.media

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.vodog.gateway.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.PI
import kotlin.math.sin

/** Pure synthetic codec checks; no telephony, microphone, network, or audio output is opened. */
@RunWith(AndroidJUnit4::class)
class LibOpusDecoderTest {
    @Test
    fun normalDecodePreservesPtsAndSupportsTwentyThroughOneHundredTwentyMsPackets() {
        assumeTrue(BuildConfig.LIBOPUS_FEC_ENABLED)
        val packets = LibOpusEncoder().use { encoder ->
            List(12) { index -> encoder.encode(frame(index), index * 20_000L).single().payload }
        }
        LibOpusDecoder().use { decoder ->
            val normal = decoder.decode(packets.first(), 40_000L)
            assertEquals(LibOpusDecodeKind.NORMAL, normal.kind)
            assertEquals(320, normal.sampleCount)
            assertEquals(640, normal.pcm16le.size)
            assertEquals(40_000L, normal.presentationTimeUs)
            assertFalse(normal.fecAttempted)

            val packet120ms = decoder.repacketizeForTest(packets.subList(6, 12).toTypedArray())
            val long = decoder.decode(packet120ms, 60_000L)
            assertEquals(1_920, long.sampleCount)
            assertEquals(3_840, long.pcm16le.size)
            assertEquals(LibOpusDecodeKind.NORMAL, long.kind)
        }
    }

    @Test
    fun missingSlotsAreExplicitFecAttemptsOrBoundedPlc() {
        assumeTrue(BuildConfig.LIBOPUS_FEC_ENABLED)
        val packets = LibOpusEncoder().use { encoder ->
            List(100) { index -> encoder.encode(frame(index), index * 20_000L).single().payload }
        }
        LibOpusDecoder().use { decoder ->
            val nextIndex = (2 until packets.size).first { decoder.packetHasLbrr(packets[it]) }
            repeat(nextIndex - 1) { decoder.decode(packets[it], it * 20_000L) }
            val attempt = decoder.decodePreviousFromNext(
                nextPayload = packets[nextIndex],
                missingPresentationTimeUs = (nextIndex - 1) * 20_000L,
            )
            assertEquals(LibOpusDecodeKind.FEC_ATTEMPT, attempt.kind)
            assertEquals(320, attempt.sampleCount)
            assertTrue(attempt.packetHasLbrr)
            assertTrue(attempt.fecAttempted)
            val next = decoder.decode(packets[nextIndex], nextIndex * 20_000L)
            assertEquals(320, next.sampleCount)
        }

        LibOpusDecoder().use { decoder ->
            val directPlc10 = decoder.plc(0, durationMs = 10)
            assertEquals(LibOpusDecodeKind.PLC, directPlc10.kind)
            assertEquals(160, directPlc10.sampleCount)
            assertFalse(directPlc10.fecAttempted)

            val noLbrrPacket = packets.first { !decoder.packetHasLbrr(it) }
            val fallback = decoder.decodePreviousFromNext(noLbrrPacket, 10_000L, durationMs = 10)
            assertEquals(LibOpusDecodeKind.PLC, fallback.kind)
            assertEquals(160, fallback.sampleCount)
            assertFalse(fallback.packetHasLbrr)
            assertFalse(fallback.fecAttempted)
        }
    }

    @Test
    fun decodeFitsFrameBudgetAndClosedDecoderRejectsAllUse() {
        assumeTrue(BuildConfig.LIBOPUS_FEC_ENABLED)
        val packets = LibOpusEncoder().use { encoder ->
            List(120) { index -> encoder.encode(frame(index), index * 20_000L).single().payload }
        }
        val decoder = LibOpusDecoder()
        val durationsUs = packets.mapIndexed { index, packet ->
            val started = System.nanoTime()
            decoder.decode(packet, index * 20_000L)
            (System.nanoTime() - started) / 1_000
        }.drop(20).sorted()
        val p95 = durationsUs[durationsUs.size * 95 / 100]
        Log.i("LibOpusDecoderTest", "synthetic=true p95Us=$p95 maxUs=${durationsUs.last()}")
        assertTrue("native decoder cannot keep 20ms frame budget", p95 < 20_000)

        decoder.reset()
        val afterReset = decoder.decode(packets.first(), 3_000_000L)
        assertEquals(LibOpusDecodeKind.NORMAL, afterReset.kind)
        assertEquals(320, afterReset.sampleCount)

        decoder.close()
        decoder.close()
        assertThrows(IllegalStateException::class.java) { decoder.decode(packets.first(), 0) }
        assertThrows(IllegalStateException::class.java) { decoder.plc(0) }
        assertThrows(IllegalStateException::class.java) { decoder.packetHasLbrr(packets.first()) }
        assertThrows(IllegalStateException::class.java) { decoder.reset() }
    }

    private fun frame(index: Int) = ByteArray(640).also { pcm ->
        repeat(320) { offset ->
            val sampleIndex = index * 320 + offset
            val time = sampleIndex / 16_000.0
            val envelope = 0.55 + 0.35 * sin(2 * PI * 3 * time)
            val wave = sin(2 * PI * 137 * time) + 0.4 * sin(2 * PI * 274 * time) +
                0.2 * sin(2 * PI * 959 * time)
            val sample = (wave * envelope * 9_000).toInt().coerceIn(-32_768, 32_767)
            pcm[offset * 2] = sample.toByte()
            pcm[offset * 2 + 1] = (sample shr 8).toByte()
        }
    }
}
