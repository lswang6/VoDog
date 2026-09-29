package org.vodog.gateway.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/** S70 pull-mode playout: unit rules plus the spec's offline drift/burst/loss gate. */
class OpusPlayoutBufferTest {
    private val loud: Byte = 1
    private val quiet: Byte = 0

    private fun packet(index: Long, level: Byte = loud, durationMs: Int = 20, tsUs: Long = index * 20_000L) =
        MediaPacket(MediaDirection.USER_UPLINK, durationMs, index and 0xffff_ffffL, tsUs, byteArrayOf(level))

    private class FakeDecoder : PlayoutDecoder {
        var resets = 0
        val concealed = mutableListOf<String>()
        override fun decode(packet: MediaPacket): ByteArray = pcm(packet.durationMs, if (packet.opus[0] == 1.toByte()) 3_000 else 10)
        override fun conceal(next: MediaPacket?, timestampUs: Long, durationMs: Int): Pair<ByteArray, String> {
            val kind = if (next != null) "fec_attempt" else "plc"
            concealed += kind
            return pcm(durationMs, 900) to kind
        }
        override fun resetDecoder() { resets++ }
        companion object {
            fun pcm(durationMs: Int, value: Int) = ByteArray(durationMs * 32).also { out ->
                for (i in 0 until out.size / 2) { out[i * 2] = (value and 0xff).toByte(); out[i * 2 + 1] = (value shr 8).toByte() }
            }
        }
    }

    @Test fun `profiles keep the S23 targets and hold T plus 300 ms plus a 500 ms burst`() {
        assertEquals(60L, OpusPlayoutProfile.HUMAN.delayMs)
        assertEquals(200L, OpusPlayoutProfile.AI.delayMs)
        listOf(OpusPlayoutProfile.HUMAN, OpusPlayoutProfile.AI).forEach {
            assertTrue(it.maxSpanUs >= it.delayUs + 800_000L)
            assertEquals(64, it.decodeQueueFrames)
        }
        // S74a leaves the entry thresholds alone: human forced at T+300, AI at T+1000.
        assertEquals(300_000L, OpusPlayoutProfile.HUMAN.forcedCatchUpUs)
        assertEquals(1_000_000L, OpusPlayoutProfile.AI.forcedCatchUpUs)
    }

    @Test fun `S73 an explicit stream reset reprimes and restarts the decoder`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        (0L..5L).forEach { buffer.offer(packet(it), 0) }
        repeat(3) { assertTrue(buffer.pull(0, decoder).audio) }
        buffer.resetStream()
        assertNull(buffer.pull(0, decoder).pcm) // Nothing queued: silence, not a zero-fill underrun.
        // The new leg's clock restarted far behind the old play point; it is a stream, not stale.
        (0L..2L).forEach { buffer.offer(packet(100 + it, tsUs = it * 20_000L), 0) }
        val first = buffer.pull(0, decoder)
        assertTrue(first.audio); assertEquals(0L, first.sourcePtsUs)
        assertEquals(1, decoder.resets); assertEquals(1L, buffer.streamResets); assertEquals(0L, buffer.lateDiscarded)
    }

    @Test fun `S73 a sequence jump over 50 is a stream reset`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        (0L..5L).forEach { buffer.offer(packet(it), 0) }
        repeat(3) { buffer.pull(0, decoder) }
        buffer.offer(packet(55), 0); assertEquals(0L, buffer.streamResets) // A step of 50 is still loss, not a new stream.
        buffer.offer(packet(107, tsUs = 10_000_000L), 0)
        assertEquals(1L, buffer.streamResets)
        buffer.offer(packet(108, tsUs = 10_020_000L), 0); buffer.offer(packet(109, tsUs = 10_040_000L), 0)
        assertEquals(10_000_000L, buffer.pull(0, decoder).sourcePtsUs)
    }

    @Test fun `S73 continuous seq with timestamps restarting behind the play point resets`() {
        // Bridge rtpClock is per client leg (restarts at 0), seq is room-level: a client rejoin.
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        (0L..99L).forEach { buffer.offer(packet(it), 0); buffer.pull(0, decoder) }
        buffer.offer(packet(100, tsUs = 0L), 0)
        assertEquals(1L, buffer.streamResets)
        buffer.offer(packet(101, tsUs = 20_000L), 0); buffer.offer(packet(102, tsUs = 40_000L), 0)
        assertTrue(buffer.pull(0, decoder).audio)
        // An ordinary late packet (small seq step back, just behind the play point) is not a reset.
        buffer.offer(packet(99, tsUs = 0L), 0)
        assertEquals(1L, buffer.streamResets)
    }

    @Test fun `priming waits for T of audio then plays in order`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        buffer.offer(packet(0), 0); buffer.offer(packet(1), 0)
        assertNull(buffer.pull(0, decoder).pcm) // 40 ms < T: priming silence, not counted
        buffer.offer(packet(2), 0)
        val first = buffer.pull(0, decoder)
        assertTrue(first.audio); assertEquals(0L, first.sourcePtsUs); assertEquals(1, first.originals.size)
        assertEquals(0L, buffer.zeroFillFrames); assertEquals(0L, buffer.underrunTicks)
    }

    @Test fun `priming also releases a single packet after T of wall time`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        buffer.offer(packet(0), 1_000)
        assertNull(buffer.pull(30_000, decoder).pcm)
        assertTrue(buffer.pull(61_000, decoder).audio)
    }

    @Test fun `startup reorder within T is accepted and duplicate or late packets are counted`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        buffer.offer(packet(3), 0); buffer.offer(packet(2), 0) // older than first arrival, within T
        buffer.offer(packet(4), 0); buffer.offer(packet(4), 0)
        assertEquals(1L, buffer.duplicates); assertEquals(1L, buffer.reorderedPackets)
        assertEquals(40_000L, buffer.pull(0, decoder).sourcePtsUs)
        buffer.offer(packet(1), 0)
        assertEquals(1L, buffer.lateDiscarded)
    }

    @Test fun `a single loss uses FEC from the next adjacent packet and a burst uses PLC`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        listOf(0L, 1L, 3L, 4L, 7L, 8L, 9L).forEach { buffer.offer(packet(it), 0) }
        val kinds = (0 until 10).map { buffer.pull(0, decoder).recoveryKind }
        // The last slot of a two-packet burst is never FEC'd from its neighbour (S20 rule kept).
        assertEquals(listOf(null, null, "fec_attempt", null, null, "plc", "plc", null, null, null), kinds)
        assertEquals(1L, buffer.fecRecoveredFrames); assertEquals(2L, buffer.plcFrames)
        assertEquals(3L, buffer.missingFrames)
    }

    @Test fun `empty buffer stretches with three PLC frames then zero fills then reprimes after 200 ms dry`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        (0L..2L).forEach { buffer.offer(packet(it), 0) }
        repeat(3) { assertTrue(buffer.pull(0, decoder).audio) }
        val stretch = (0 until 3).map { buffer.pull(0, decoder) }
        assertTrue(stretch.all { it.recoveryKind == "plc" && !it.zeroFill })
        assertTrue(buffer.pull(0, decoder).zeroFill) // 4th empty tick
        assertEquals(4L, buffer.underrunTicks); assertEquals(1L, buffer.zeroFillFrames)
        // A late packet within the dry window still plays: the stretch did not advance the media clock.
        buffer.offer(packet(3), 0)
        assertEquals(60_000L, buffer.pull(0, decoder).sourcePtsUs)
        assertEquals(0L, buffer.lateDiscarded)
        repeat(10) { buffer.pull(0, decoder) } // 3 PLC + 7 zero = 200 ms dry -> reprime
        buffer.offer(packet(4), 400_000)
        val waiting = buffer.pull(410_000, decoder)
        assertTrue(waiting.zeroFill) // re-prime silence counts as zero fill (it follows the underrun)
        assertTrue(buffer.pull(460_000, decoder).audio)
    }

    @Test fun `AI legs keep a 500 ms burst of speech and never trim the setup backlog`() {
        val buffer = OpusPlayoutBuffer(OpusPlayoutProfile.AI); val decoder = FakeDecoder()
        (0L until 35L).forEach { buffer.offer(packet(it), 0) } // 700 ms queued: T + 500
        buffer.trimSetupBacklog()
        var next = 35L
        repeat(100) { buffer.offer(packet(next++), 0); buffer.pull(0, decoder) }
        assertEquals(0L, buffer.catchUpForcedDrops)
        assertEquals(0L, buffer.catchUpQuietDrops) // loud speech: no drops at all
        repeat(60) { buffer.offer(packet(next++, quiet), 0); buffer.pull(0, decoder) }
        assertTrue(buffer.catchUpQuietDrops > 0) // the silence between turns catches up
    }

    @Test fun `setup backlog is trimmed to T plus 20 without waiting for quiet frames`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        (0L until 14L).forEach { buffer.offer(packet(it), 0) } // 280 ms queued while the sink came up
        buffer.trimSetupBacklog()
        var next = 14L
        repeat(15) { buffer.offer(packet(next++), 0); buffer.pull(0, decoder) }
        assertTrue(buffer.depthUs() <= 80_000L)
        assertTrue(buffer.catchUpForcedDrops > 0)
        assertEquals(0L, buffer.catchUpQuietDrops)
    }

    @Test fun `resume after a long gap re-primes to T from the first queued packet`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        (0L..2L).forEach { buffer.offer(packet(it), 0) }
        repeat(3) { buffer.pull(0, decoder) }
        repeat(10) { buffer.pull(0, decoder) } // 200 ms dry -> reprime
        buffer.offer(packet(30), 400_000) // new audio 540 ms past the hole
        assertTrue(buffer.pull(410_000, decoder).zeroFill) // one packet is not a T cushion
        buffer.offer(packet(31), 420_000); buffer.offer(packet(32), 440_000)
        val resumed = buffer.pull(445_000, decoder)
        assertTrue(resumed.audio)
        assertEquals(600_000L, resumed.sourcePtsUs)
    }

    @Test fun `quiet frames are dropped only after depth stays above T plus 60 for one second`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        var next = 0L
        fun feed(n: Int, level: Byte) = repeat(n) { buffer.offer(packet(next++, level), 0) }
        feed(8, quiet) // 160 ms queued: T + 100
        buffer.pull(0, decoder)
        repeat(CATCH_UP_HOLD_TICKS - 2) { feed(1, quiet); buffer.pull(0, decoder) }
        assertEquals(0L, buffer.catchUpQuietDrops)
        feed(1, quiet)
        val tick = buffer.pull(0, decoder)
        assertEquals(1L, buffer.catchUpQuietDrops)
        assertEquals(2, tick.originals.size) // the dropped frame still reaches caller_original
        // S74a latched: the silence still queued drains to T+20 (two more drops), then the loud
        // audio behind it is never dropped by quiet catch-up.
        repeat(20) {
            feed(1, loud)
            val t = buffer.pull(0, decoder)
            if (t.originals.size == 2) assertTrue(rms(t.originals[0].first) < QUIET_RMS)
        }
        assertEquals(3L, buffer.catchUpQuietDrops)
        assertTrue(buffer.depthUs() <= 80_000L)
        assertEquals(0L, buffer.catchUpForcedDrops)
    }

    @Test fun `depth above T plus 300 forces drops of any frame until T plus 20`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        var next = 0L
        (0 until 25).forEach { buffer.offer(packet(next++, loud), 0) } // 500 ms burst
        var ticks = 0
        // Real time: one packet arrives per tick, so only the drops shrink the depth.
        while (buffer.depthUs() > 80_000L && ticks < 200) { buffer.offer(packet(next++, loud), 0); buffer.pull(0, decoder); ticks++ }
        assertTrue(buffer.catchUpForcedDrops > 0)
        assertTrue("forced catch-up takes at most one extra frame per tick", ticks >= buffer.catchUpForcedDrops)
        assertEquals(0L, buffer.catchUpQuietDrops)
        // S74a: it no longer parks at T+60; once at T+20 steady speech keeps the depth there, no drops.
        val drops = buffer.catchUpForcedDrops
        repeat(100) { buffer.offer(packet(next++, loud), 0); buffer.pull(0, decoder); assertTrue(buffer.depthUs() <= 80_000L) }
        assertEquals(drops, buffer.catchUpForcedDrops)
    }

    @Test fun `S74a quiet catch-up latches drops only silent frames and unlatches at T plus 20`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        var next = 0L
        fun feed(n: Int, level: Byte) = repeat(n) { buffer.offer(packet(next++, level), 0) }
        feed(8, loud) // 160 ms queued: T + 100, speech so nothing is dropped while the hold runs
        buffer.pull(0, decoder)
        repeat(CATCH_UP_HOLD_TICKS + 5) { feed(1, loud); buffer.pull(0, decoder) }
        assertEquals(0L, buffer.catchUpQuietDrops)
        assertTrue(buffer.depthUs() > 120_000L)
        // Latched: alternate loud and quiet; only the quiet frames go, even below T+60.
        repeat(40) {
            feed(1, if (it % 2 == 0) loud else quiet)
            val tick = buffer.pull(0, decoder)
            // A dropped frame is the first decoded original of a two-frame tick: it must be silent.
            if (tick.originals.size == 2) assertTrue(rms(tick.originals[0].first) < QUIET_RMS)
            assertTrue(rms(tick.pcm!!) >= QUIET_RMS || tick.originals.size == 1)
        }
        assertTrue(buffer.depthUs() <= 80_000L)
        assertEquals(0L, buffer.catchUpForcedDrops)
        // Unlatched at T+20: silence at a steady T+20..T+40 is played, not dropped.
        val drops = buffer.catchUpQuietDrops
        assertTrue(drops in 1L..4L)
        feed(1, quiet) // one frame of jitter: depth T+40, under the T+60 entry
        repeat(100) { feed(1, quiet); buffer.pull(0, decoder) }
        assertEquals(drops, buffer.catchUpQuietDrops)
    }

    @Test fun `S74a human steady state with plus minus 20 ms jitter keeps underruns rare and p95 at most T plus 40`() {
        val random = Random(74L)
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        val arrivals = (0L until 15_000L).map { i -> i * 20_000L + 20_000L + random.nextInt(40_001) - 20_000L to packet(i, if ((i / 50) % 4 == 3L) quiet else loud) }
            .sortedBy { it.first }
        var cursor = 0
        (0L until 15_000L).forEach { tick ->
            val nowUs = tick * 20_000L + 60_000L
            while (cursor < arrivals.size && arrivals[cursor].first <= nowUs) { buffer.offer(arrivals[cursor].second, arrivals[cursor].first); cursor++ }
            buffer.pull(nowUs, decoder)
        }
        println("S74a jitter human p95=${buffer.depthP95Ms()} " + buffer.diagnostics())
        assertTrue("underruns ${buffer.underrunTicks}", buffer.underrunTicks * 100 <= 15_000L) // <= 1 %
        assertTrue("p95 ${buffer.depthP95Ms()}", buffer.depthP95Ms() <= 100L)
    }

    @Test fun `a source jump beyond the resync horizon resets the decoder once without a concealment train`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        (0L..2L).forEach { buffer.offer(packet(it), 0) }
        repeat(3) { buffer.pull(0, decoder) }
        // S73: continuous seq, so this stays a resync (a seq jump > 50 is a stream reset instead).
        (0L..2L).forEach { buffer.offer(packet(3 + it, tsUs = (100 + it) * 20_000L), 0) }
        val tick = buffer.pull(0, decoder)
        assertEquals(2_000_000L, tick.sourcePtsUs); assertNull(tick.recoveryKind)
        assertEquals(1, decoder.resets); assertEquals(1L, buffer.resyncs); assertTrue(decoder.concealed.isEmpty())
    }

    @Test fun `overflow drops the oldest packets`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        (0L until 60L).forEach { buffer.offer(packet(it), 0) }
        assertTrue(buffer.overflowDrops > 0)
        assertTrue(buffer.pull(0, decoder).sourcePtsUs > 0L)
    }

    @Test fun `ten forty and sixty millisecond packets become exact twenty millisecond ticks`() {
        val buffer = OpusPlayoutBuffer(); val decoder = FakeDecoder()
        buffer.offer(packet(0, durationMs = 10, tsUs = 0), 0)
        buffer.offer(packet(1, durationMs = 10, tsUs = 10_000), 0)
        buffer.offer(packet(2, durationMs = 40, tsUs = 20_000), 0)
        buffer.offer(packet(3, durationMs = 60, tsUs = 60_000), 0)
        val ticks = (0 until 6).map { buffer.pull(0, decoder) }
        assertTrue(ticks.all { it.audio && it.pcm!!.size == FRAME_BYTES && it.recoveryKind == null })
        assertEquals(listOf(0L, 20_000L, 40_000L, 60_000L, 80_000L, 100_000L), ticks.map { it.sourcePtsUs })
    }

    @Test fun `offline gate human`() = gate(OpusPlayoutProfile.HUMAN)
    @Test fun `offline gate ai`() = gate(OpusPlayoutProfile.AI)

    /**
     * S70 离线闸门: playback clock +-100 ppm against the sender, a 500 ms arrival burst mid-call,
     * 2% random loss, 0-20 ms arrival jitter, 20 simulated minutes. Depth must be back at or under
     * T+60 within 5 s of the burst, must not grow over the call, and zero fill may only follow a
     * truly empty buffer (three PLC stretch ticks first).
     */
    private fun gate(profile: OpusPlayoutProfile) {
        for (ppm in listOf(100.0, -100.0)) {
            val random = Random(if (ppm > 0) 70L else 71L)
            val buffer = OpusPlayoutBuffer(profile); val decoder = FakeDecoder()
            val totalUs = 20L * 60 * 1_000_000
            val burstStartUs = 600_000_000L; val burstEndUs = burstStartUs + 500_000L
            // Sender: 20 ms packets; talk 3 s / pause 1 s; burst packets are held and land together.
            val arrivals = ArrayList<Pair<Long, MediaPacket>>()
            var index = 0L
            while (index * 20_000L < totalUs) {
                val sentUs = index * 20_000L
                if (random.nextDouble() >= 0.02) {
                    val level = if ((sentUs / 1_000_000L) % 4L == 3L) quiet else loud
                    val arrival = if (sentUs in burstStartUs until burstEndUs) burstEndUs + random.nextInt(2_000)
                        else sentUs + random.nextInt(20_000)
                    arrivals += arrival to packet(index, level)
                }
                index++
            }
            arrivals.sortBy { it.first }
            val periodUs = 20_000.0 * (1.0 - ppm / 1_000_000.0) // +ppm = playback clock runs fast
            var cursor = 0
            var tickIndex = 0L
            var emptyStreak = 0
            val depthAfterBurst = mutableListOf<Long>()
            val windowP95 = mutableListOf<Long>() // 1-minute windows before the burst
            val postBurstP95 = mutableListOf<Long>() // and after it
            val window = ArrayList<Long>()
            while (true) {
                val nowUs = (tickIndex * periodUs).toLong() + 30_000L
                if (nowUs >= totalUs) break
                while (cursor < arrivals.size && arrivals[cursor].first <= nowUs) {
                    buffer.offer(arrivals[cursor].second, arrivals[cursor].first); cursor++
                }
                val tick = buffer.pull(nowUs, decoder)
                val emptyTick = tick.zeroFill || (tick.recoveryKind == "plc" && tick.originals.isEmpty() && tick.missingSlots == 0)
                if (tick.zeroFill) assertTrue("zero fill before three empty PLC ticks at $nowUs", emptyStreak >= EMPTY_PLC_TICKS)
                emptyStreak = if (emptyTick) emptyStreak + 1 else 0
                val depth = buffer.depthUs()
                if (nowUs in burstEndUs..burstEndUs + 5_000_000L) depthAfterBurst += depth
                if (nowUs > 5_000_000L && nowUs !in burstStartUs..burstEndUs + 5_000_000L) window += depth
                if (window.size == 3_000) {
                    (if (nowUs < burstStartUs) windowP95 else postBurstP95) += window.sorted()[window.size * 95 / 100]
                    window.clear()
                }
                tickIndex++
            }
            val limit = profile.delayUs + CATCH_UP_US
            println("gate ${profile.delayMs}ms ${ppm}ppm p95=${windowP95 + postBurstP95} " + buffer.diagnostics())
            assertTrue("burst drained ($ppm ppm): ${depthAfterBurst.maxOrNull()}", depthAfterBurst.max() > limit)
            val peak = depthAfterBurst.indexOf(depthAfterBurst.max())
            assertTrue("depth back to T+60 within 5 s ($ppm ppm)", depthAfterBurst.drop(peak).any { it <= limit })
            // Growth = drift accumulating without bound (100 ppm over 20 min would add 120 ms). The
            // catch-up threshold is T+60, so slow-clock drift parks there: the whole-call p95 (the
            // media.session_end field and the device acceptance metric) must be <= T+60, and every
            // one-minute p95 within one 20 ms frame of it, burst minute excluded.
            val all = windowP95 + postBurstP95
            assertTrue("call p95 ${buffer.depthP95Ms()} ms ($ppm ppm)", buffer.depthP95Ms() * 1_000L <= limit)
            assertTrue("bounded per-minute p95 ($ppm ppm): $all", all.all { it <= limit + 20_000L })
            assertTrue(buffer.catchUpForcedDrops + buffer.catchUpQuietDrops > 0)
            assertFalse(buffer.zeroFillFrames > 0 && buffer.underrunTicks == 0L)
        }
    }
}
