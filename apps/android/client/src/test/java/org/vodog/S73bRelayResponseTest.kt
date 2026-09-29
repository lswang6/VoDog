package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** S73b: TLS is forced (connect fallback aside) only when the options RESPONSE says `relay: true`. */
class S73bRelayResponseTest {
    private fun options(url: String, relay: Any?) = JSONObject().put("iceTransportPolicy", "relay").put(
        "iceServers",
        JSONArray().put(JSONObject().put("urls", JSONArray().put(url)).put("username", "u").put("credential", "c")),
    ).also { if (relay != null) it.put("relay", relay) }

    @Test fun relayFieldParsedStrictlyAbsentIsFalse() {
        val udp = "turn:relay.example.com:16801?transport=udp"
        val tls = "turns:203.0.113.29:16803?transport=tcp"
        assertEquals(false, CallMediaOptions.parse(options(udp, null), CallMediaTransport.UDP).relay)
        assertEquals(false, CallMediaOptions.parse(options(udp, false), CallMediaTransport.UDP).relay)
        assertEquals(true, CallMediaOptions.parse(options(tls, true), CallMediaTransport.TLS).relay)
        assertEquals(false, CallMediaOptions.parse(options(tls, "true"), CallMediaTransport.TLS).relay)
        assertEquals(false, CallMediaOptions.parse(options(tls, 1), CallMediaTransport.TLS).relay)
    }

    @Test fun rejoinFollowsResponseRelayNotCellular() {
        // Cellular but the room is not on the relay node (relay:false) → normal UDP↔TLS alternation.
        assertEquals(CallMediaTransport.UDP, CallMediaRejoinPolicy.transport(1, CallMediaTransport.UDP, relay = false))
        assertEquals(CallMediaTransport.TLS, CallMediaRejoinPolicy.transport(2, CallMediaTransport.UDP, relay = false))
        assertEquals(CallMediaTransport.UDP, CallMediaRejoinPolicy.transport(3, CallMediaTransport.TLS, relay = false))
        assertEquals(CallMediaTransport.TLS, CallMediaRejoinPolicy.transport(2, CallMediaTransport.TLS, relay = true))
    }
}
