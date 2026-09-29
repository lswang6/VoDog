package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZeroPcmWatchdogTest {
    /** A restart is not audio, so an endpoint that never opened stays armed across both of them. */
    @Test fun downlinkDeadFromTheFirstSampleRestartsTwiceThenReportsOnceAndGoesQuiet() {
        val watchdog = ZeroPcmWatchdog()
        assertEquals(ZeroPcmDecision(ZeroPcmAction.RESTART, 3_000L, 1), zeroRun(watchdog))
        assertEquals(ZeroPcmDecision(ZeroPcmAction.RESTART, 3_000L, 2), zeroRun(watchdog))
        assertEquals(ZeroPcmDecision(ZeroPcmAction.REPORT, 3_000L, 2), zeroRun(watchdog))
        assertEquals(ZeroPcmDecision(ZeroPcmAction.QUIET, 3_000L, 2), zeroRun(watchdog))
    }

    /** IVR pauses read as bit-exact zeros on this device: once audio arrived, silence is silence. */
    @Test fun anySilenceAfterRealAudioNeverTriggersHoweverLong() {
        val watchdog = ZeroPcmWatchdog()
        repeat(149) { assertEquals(ZeroPcmAction.NONE, watchdog.onRead(true, 20L).action) }
        assertEquals(ZeroPcmDecision(ZeroPcmAction.NONE, 0L, 0), watchdog.onRead(false, 20L))
        repeat(3_000) { assertEquals(ZeroPcmDecision(ZeroPcmAction.NONE, 0L, 0), watchdog.onRead(true, 20L)) }
    }

    @Test fun allZeroLooksOnlyAtTheBytesThatWereRead() {
        val frame = ByteArray(640)
        assertTrue(isAllZeroPcm(frame, 640))
        frame[639] = 7
        assertFalse(isAllZeroPcm(frame, 640))
        assertTrue(isAllZeroPcm(frame, 639))
        assertEquals(20L, pcmDurationMs(640))
    }

    private fun zeroRun(watchdog: ZeroPcmWatchdog): ZeroPcmDecision {
        repeat(149) { watchdog.onRead(true, 20L) }
        return watchdog.onRead(true, 20L)
    }
}
