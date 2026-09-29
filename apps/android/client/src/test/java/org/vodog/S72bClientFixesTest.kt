package org.vodog

import android.telecom.DisconnectCause
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.URL

/** S72b: Core-Telecom 断开码、蜂窝中转端点与换端点重试、中转 TURN hostname。 */
class S72bClientFixesTest {
    @After fun resetRelay() = ClientEndpoint.setRelayForTest(false)

    @Test fun transactionalDisconnectOnlyEmitsCodesCoreTelecomAccepts() {
        for (code in listOf(DisconnectCause.LOCAL, DisconnectCause.REMOTE, DisconnectCause.MISSED, DisconnectCause.REJECTED)) {
            assertEquals(code to null, transactionalDisconnectCode(code))
        }
        assertEquals(DisconnectCause.REMOTE to "已在其他设备接听", transactionalDisconnectCode(DisconnectCause.ANSWERED_ELSEWHERE))
        assertEquals(DisconnectCause.MISSED to null, transactionalDisconnectCode(DisconnectCause.CANCELED))
        assertEquals(DisconnectCause.LOCAL to null, transactionalDisconnectCode(DisconnectCause.ERROR))
        // 共享 helper 的所有出口都落在四个合法码内。
        val allowed = setOf(DisconnectCause.LOCAL, DisconnectCause.REMOTE, DisconnectCause.MISSED, DisconnectCause.REJECTED)
        for (detail in listOf(null, JSONObject().put("state", "active"), JSONObject().put("state", "ended"))) {
            assertTrue(transactionalDisconnectCode(ringingEndedDisconnectCause(detail)).first in allowed)
        }
    }

    @Test fun alternateUrlSwapsBetweenDirectAndRelay() {
        val direct = "https://control.example.com/api/v1"
        val relay = "https://relay.example.com:16800/api/v1"
        assertEquals("$relay/calls/x", ClientEndpoint.alternateUrl("$direct/calls/x", direct, relay))
        assertEquals("$direct/calls/x", ClientEndpoint.alternateUrl("$relay/calls/x", direct, relay))
        assertNull(ClientEndpoint.alternateUrl("https://other.example/api/v1/x", direct, relay))
        assertNull(ClientEndpoint.alternateUrl("$direct/x", direct, direct))
        ClientEndpoint.setRelayForTest(true)
        assertEquals(BuildConfig.RELAY_API_BASE_URL, ClientEndpoint.baseUrl())
    }

    @Test fun networkFailureRetriesIdempotentRequestOnceOnTheOtherEndpoint() {
        val urls = mutableListOf<URL>()
        val transport = UrlConnectionClientTransport(connectionFactory = { urls += it; throw IOException("connect timed out") })
        assertThrows(IOException::class.java) { transport.execute(ClientRequest("GET", "/calls/x", null, null, null)) }
        val expectedUrls = listOf("${BuildConfig.API_BASE_URL}/calls/x",
            "${BuildConfig.RELAY_API_BASE_URL}/calls/x").distinct()
        assertEquals(expectedUrls, urls.map(URL::toString))

        urls.clear()
        assertThrows(IOException::class.java) {
            transport.execute(ClientRequest("POST", "/calls/x/claim", JSONObject(), null, null))
        }
        assertEquals(1, urls.size) // 非幂等 POST 不重发

        urls.clear()
        assertThrows(IOException::class.java) {
            transport.execute(ClientRequest("POST", "/calls/outbound", JSONObject(), "key-1", null))
        }
        assertEquals(expectedUrls.size, urls.size) // Retry only when a distinct alternate exists.
    }

    @Test fun relayTurnWithIpUrlAndHostnameParses() {
        val json = JSONObject().put("iceTransportPolicy", "relay").put(
            "iceServers",
            JSONArray().put(
                JSONObject().put("urls", JSONArray().put("turns:203.0.113.29:16803?transport=tcp"))
                    .put("username", "u").put("credential", "c").put("hostname", "control.example.com"),
            ),
        )
        assertEquals("control.example.com", CallMediaOptions.parse(json, CallMediaTransport.TLS).iceServer.hostname)
        json.getJSONArray("iceServers").getJSONObject(0).put("hostname", "203.0.113.29")
        assertThrows(IllegalArgumentException::class.java) { CallMediaOptions.parse(json, CallMediaTransport.TLS) }
    }
}
