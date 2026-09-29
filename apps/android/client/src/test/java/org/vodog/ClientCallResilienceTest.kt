package org.vodog

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class ClientCallResilienceTest {
    @Test
    fun ringVerifyOnlyStopsOnDefinitiveAnswers() {
        assertEquals("network", incomingVerifyFailureReason(IOException("timeout")))
        assertEquals("network", incomingVerifyFailureReason(ApiError(503, "UNAVAILABLE", "x")))
        assertEquals("network", incomingVerifyFailureReason(ApiError(429, "RATE_LIMITED", "x")))
        assertEquals("session", incomingVerifyFailureReason(SessionChangedException()))
        assertEquals("session", incomingVerifyFailureReason(ApiError(401, "UNAUTHORIZED", "x")))
        assertEquals("not_ringing", incomingVerifyFailureReason(ApiError(404, "NOT_FOUND", "x")))
        assertEquals("not_ringing", incomingVerifyFailureReason(ApiError(409, "CALL_NOT_RINGING", "x")))
    }

    @Test
    fun onlyPermanentFocusLossIsTerminal() {
        assertEquals("loss", audioFocusChangeName(AudioManager.AUDIOFOCUS_LOSS))
        assertEquals("loss_transient", audioFocusChangeName(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
        assertEquals("loss_transient_can_duck", audioFocusChangeName(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
        assertEquals("gain", audioFocusChangeName(AudioManager.AUDIOFOCUS_GAIN))
    }

    @Test
    fun livenessRefreshesOnlyForegroundAndNotOnRinging() {
        for (phase in listOf(ClientCallLivenessPhase.CLAIMED, ClientCallLivenessPhase.MEDIA_ACTIVE, ClientCallLivenessPhase.ENDED)) {
            assertTrue(livenessTriggersRefresh(phase, foregroundActive = true))
            assertFalse(livenessTriggersRefresh(phase, foregroundActive = false))
        }
        assertFalse(livenessTriggersRefresh(ClientCallLivenessPhase.RINGING, foregroundActive = true))
    }

    @Test
    fun killedMarkerOnlyForUncleanExitWithin24h() {
        val now = 100_000_000_000L
        assertEquals(90L, killedLastAliveAgoS(now - 90_000, cleanShutdown = false, nowMs = now))
        assertNull(killedLastAliveAgoS(now - 90_000, cleanShutdown = true, nowMs = now))
        assertNull(killedLastAliveAgoS(0L, cleanShutdown = false, nowMs = now))
        assertNull(killedLastAliveAgoS(now - 24 * 3_600_000L, cleanShutdown = false, nowMs = now))
        assertNull(killedLastAliveAgoS(now + 5_000, cleanShutdown = false, nowMs = now))
    }
}
