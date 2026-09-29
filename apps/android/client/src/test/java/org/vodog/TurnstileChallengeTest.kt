package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnstileChallengeTest {
    @Test fun `bridge token payload becomes a token event`() {
        val event = parseTurnstileBridgeMessage("""{"type":"token","token":"0.abc-token"}""")
        assertEquals(TurnstileEvent.Token("0.abc-token"), event)
    }

    @Test fun `bridge error, expiry and unknown payloads never yield a token`() {
        assertEquals(TurnstileEvent.Expired, parseTurnstileBridgeMessage("""{"type":"expired"}"""))
        assertEquals(TurnstileEvent.Failed("验证超时"), parseTurnstileBridgeMessage("""{"type":"error","message":"验证超时"}"""))
        assertTrue(parseTurnstileBridgeMessage("""{"type":"token","token":""}""") is TurnstileEvent.Failed)
        assertTrue(parseTurnstileBridgeMessage("not json") is TurnstileEvent.Failed)
        assertTrue(parseTurnstileBridgeMessage(null) is TurnstileEvent.Failed)
        assertTrue(parseTurnstileBridgeMessage("""{"type":"weird"}""") is TurnstileEvent.Failed)
    }

    @Test fun `a challenge is only required when the server advertises a site key`() {
        assertFalse(TurnstileUiState().required)
        assertFalse(TurnstileUiState(enabled = true, siteKey = null).required)
        assertFalse(TurnstileUiState(enabled = false, siteKey = "1x00000000000000000000AA").required)
        val required = TurnstileUiState(enabled = true, siteKey = "1x00000000000000000000AA")
        assertTrue(required.required)
        assertEquals(0, required.generation)
        assertEquals(null, required.token)
    }
}
