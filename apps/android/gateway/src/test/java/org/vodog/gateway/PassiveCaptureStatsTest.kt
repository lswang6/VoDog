package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

class PassiveCaptureStatsTest {
    @Test fun unavailableThenSilencedThenUnavailableNeverBecomesHealthy() {
        val health = PassiveCaptureHealth()
        health.observe(null)
        assertNull(health.silenced)
        health.read()
        health.observe(true)
        assertTrue(health.everSilenced)
        health.observe(null)
        assertNull(health.silenced)
        assertTrue(health.incomplete)
        health.observe(false)
        assertTrue(health.incomplete)
    }

    @Test fun unavailableWithoutReadsDoesNotInvalidateLaterKnownUnsilencedCapture() {
        val health = PassiveCaptureHealth()
        health.observe(null)
        health.observe(false)
        health.read()
        assertFalse(health.incomplete)
        health.observe(null)
        health.read()
        assertTrue(health.incomplete)
        assertFalse(health.everSilenced)
    }

    @Test fun signedPcmIncludesNegativeFullScaleAndPreservesVeryQuietSpeech() {
        val stats = PassiveCaptureStats()
        stats.recordRead(byteArrayOf(0, 0, 1, 0, -1, -1, 0, -128), 8, 8)
        val fields = stats.fields()
        assertEquals(4L, fields["samples"])
        assertEquals(3L, fields["nonzeroSamples"])
        assertEquals(32768, fields["peak"])
        assertEquals(sqrt((1.0 + 1.0 + 32768.0 * 32768.0) / 4), fields["rms"] as Double, 0.001)
    }

    @Test fun distinguishesSilentSourceEmptyReadErrorShortReadAndPadding() {
        val stats = PassiveCaptureStats()
        stats.recordRead(ByteArray(640), 640, 640)
        stats.recordRead(ByteArray(640) { 127 }, 0, 640)
        stats.recordRead(ByteArray(640) { 127 }, -6, 640)
        stats.recordRead(byteArrayOf(1, 0, 127, 127), 2, 4)
        stats.recordPadding(640)
        val fields = stats.fields()
        assertEquals(4L, fields["reads"])
        assertEquals(642L, fields["readBytes"])
        assertEquals(321L, fields["samples"])
        assertEquals(1L, fields["nonzeroSamples"])
        assertEquals(1L, fields["allZeroReads"])
        assertEquals(1L, fields["zeroReads"])
        assertEquals(1L, fields["errorReads"])
        assertEquals(-6, fields["lastReadError"])
        assertEquals(1L, fields["shortReads"])
        assertEquals(640L, fields["paddedBytes"])
        assertEquals(1, fields["peak"])
    }
}
