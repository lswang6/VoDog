package org.vodog.gateway

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class GatewayDtmfTest {
    @Test fun onlyTonesTelecomCanSendSurviveTheFilter() {
        assertEquals("12*#0", dtmfDigits("12*#0"))
        assertNull(dtmfDigits(null))
        assertNull(dtmfDigits(""))
        assertNull(dtmfDigits("12a3"))
        // Unicode digits look like digits to isDigit() and are not sendable.
        assertNull(dtmfDigits("１2"))
        assertNull(dtmfDigits("1".repeat(33)))
    }

    @Test fun anUnboundCommandOnlyResolvesWhenExactlyOneCallIsActive() {
        val active = TelecomCallSnapshot("call-a", ActualTelecomState.ACTIVE, null)
        val second = TelecomCallSnapshot("call-b", ActualTelecomState.ACTIVE, null)
        val ringing = TelecomCallSnapshot("call-c", ActualTelecomState.RINGING, null)
        assertEquals("bound", dtmfDeviceCallId("bound", listOf(active)))
        assertEquals("call-a", dtmfDeviceCallId("", listOf(active, ringing)))
        assertEquals("call-a", dtmfDeviceCallId(null, listOf(active)))
        assertNull(dtmfDeviceCallId(null, listOf(active, second)))
        assertNull(dtmfDeviceCallId(null, listOf(ringing)))
    }

    @Test fun everyDigitIsPlayedThenStoppedWithTheGapBetween() {
        val ops = mutableListOf<String>()
        playDtmfDigits("1#", play = { ops += "play:$it" }, stop = { ops += "stop" }, sleep = { ops += "sleep:$it" })
        assertEquals(
            listOf("play:1", "sleep:$DTMF_TONE_MS", "stop", "sleep:$DTMF_GAP_MS",
                "play:#", "sleep:$DTMF_TONE_MS", "stop", "sleep:$DTMF_GAP_MS"),
            ops,
        )
    }

    @Test fun anEmptyTelecomRegistryRejectsWithNoCallInsteadOfExecuting() {
        GatewayTelecomCallRegistry.clear()
        val acks = mutableListOf<JSONObject>()
        val api = GatewayApi("token", { true }, GatewayHttpTransport { request ->
            acks += JSONObject(String(requireNotNull(request.jsonBody)))
            GatewayHttpResponse(200, "{}")
        })
        GatewayDtmfCoordinator(api).handle(GatewayCommand(
            "command-a", generation = 2, sequence = 3, kind = "dtmf",
            payloadJson = JSONObject().put("digits", "123").toString(),
            expiresAt = Instant.now().plusSeconds(20).toString(),
        ))
        assertEquals("rejected", acks.single().getString("status"))
        assertEquals("no_call", acks.single().getJSONObject("result").getString("reason"))
    }

    @Test fun badDigitsAreRejectedBeforeAnyCallLookup() {
        val acks = mutableListOf<JSONObject>()
        val api = GatewayApi("token", { true }, GatewayHttpTransport { request ->
            acks += JSONObject(String(requireNotNull(request.jsonBody)))
            GatewayHttpResponse(200, "{}")
        })
        GatewayDtmfCoordinator(api).handle(GatewayCommand(
            "command-b", generation = 2, sequence = 4, kind = "dtmf",
            payloadJson = JSONObject().put("digits", "1-2").toString(),
            expiresAt = Instant.now().plusSeconds(20).toString(),
        ))
        assertEquals("invalid_digits", acks.single().getJSONObject("result").getString("reason"))
    }
}
