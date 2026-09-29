package org.vodog.gateway

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PcmIoTest {
    @Test fun partialReadsAccumulateIntoIndependentCompleteFrames() {
        val source = ByteArray(1_360) { (it % 251).toByte() }
        val accumulator = PcmFrameAccumulator(640)
        val frames = mutableListOf<ByteArray>()
        accumulator.append(source, 0, 17, frames::add)
        accumulator.append(source, 17, 623, frames::add)
        accumulator.append(source, 640, 511, frames::add)
        accumulator.append(source, 1_151, 209, frames::add)

        assertEquals(2, frames.size)
        assertArrayEquals(source.copyOfRange(0, 640), frames[0])
        assertArrayEquals(source.copyOfRange(640, 1_280), frames[1])
        assertEquals(80, accumulator.pendingByteCount())
        frames[0][0] = 99
        assertTrue(frames[1][0] != 99.toByte())
    }

    @Test fun partialAndZeroWritesRetryUntilWholeFrameIsWritten() {
        val frame = ByteArray(640) { (it % 127).toByte() }
        val output = ArrayList<Byte>()
        val writes = ArrayDeque(listOf(100, 0, 13, 527))
        var zeroBackoffs = 0
        val complete = writePcmFrameFully(
            frame,
            shouldContinue = { true },
            write = { offset, length ->
                val count = minOf(writes.removeFirst(), length)
                repeat(count) { output += frame[offset + it] }
                count
            },
            onZeroProgress = { zeroBackoffs++ },
        )

        assertTrue(complete)
        assertEquals(1, zeroBackoffs)
        assertArrayEquals(frame, output.toByteArray())
    }

    @Test fun cancellationStopsBeforeWritingRemainingSuffix() {
        val frame = ByteArray(640)
        var calls = 0
        val complete = writePcmFrameFully(
            frame,
            shouldContinue = { calls < 1 },
            write = { _, _ -> calls++; 100 },
            onZeroProgress = {},
        )
        assertFalse(complete)
        assertEquals(1, calls)
    }

    @Test(expected = IllegalStateException::class)
    fun negativeWriteFailsInsteadOfSpinning() {
        writePcmFrameFully(ByteArray(640), { true }, { _, _ -> -6 }, {})
    }

    @Test fun stopHelperNeverJoinsCallingThread() {
        assertTrue(joinUnlessCurrent(Thread.currentThread(), 10))
    }

    @Test fun stopHelperReportsWhetherWorkerActuallyExited() {
        val finished = Thread { Thread.sleep(5) }.also(Thread::start)
        assertTrue(joinUnlessCurrent(finished, 500))

        val blocked = Thread { Thread.sleep(500) }.also(Thread::start)
        try {
            assertFalse(joinUnlessCurrent(blocked, 1))
        } finally {
            blocked.interrupt()
            blocked.join(500)
        }
    }

    @Test fun simultaneousWorkerFailuresProduceOneCallbackPerRun() {
        val signal = OnceSignal()
        var callbacks = 0
        assertTrue(signal.run { callbacks++ })
        assertFalse(signal.run { callbacks++ })
        assertEquals(1, callbacks)
        signal.reset()
        assertTrue(signal.run { callbacks++ })
        assertEquals(2, callbacks)
    }
}
