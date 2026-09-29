package org.vodog.gateway.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class LibOpusEncoderConfigTest {
    @Test
    fun defaultsAreBoundedExperimentValues() {
        val config = LibOpusEncoderConfig()
        assertEquals(28_000, config.bitRate)
        assertEquals(12, config.expectedLossPercent)
        assertEquals(true, config.fecEnabled)
    }

    @Test
    fun expectedLossRejectsValuesOutsideCandidateRange() {
        assertThrows(IllegalArgumentException::class.java) {
            LibOpusEncoderConfig(expectedLossPercent = 9)
        }
        assertThrows(IllegalArgumentException::class.java) {
            LibOpusEncoderConfig(expectedLossPercent = 16)
        }
    }

    @Test
    fun candidateCannotSilentlyDisableFec() {
        assertThrows(IllegalArgumentException::class.java) {
            LibOpusEncoderConfig(fecEnabled = false)
        }
    }
}
