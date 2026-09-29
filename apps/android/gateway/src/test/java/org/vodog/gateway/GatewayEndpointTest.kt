package org.vodog.gateway

import org.vodog.gateway.media.IceTransport
import org.vodog.gateway.media.mediaOptionsRequestBody
import org.vodog.gateway.media.parseMediaOptionsIceServers
import org.vodog.gateway.media.turnUrlHost
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Collections

/** S71 Pixel gateway contract: endpoint choice, one alternate retry, relay media options. */
class GatewayEndpointTest {
    private val direct = BuildConfig.API_BASE_URL
    private val relay = BuildConfig.RELAY_API_BASE_URL

    @After fun reset() = GatewayEndpoint.setRelayForTest(false)

    @Test fun `cellular default network selects the relay and wifi returns to direct`() {
        assertTrue(relay.startsWith("https://") && relay.endsWith("/api/v1"))
        GatewayEndpoint.onDefaultNetwork("cellular")
        assertTrue(GatewayEndpoint.relay)
        assertEquals(relay, GatewayEndpoint.baseUrl())
        assertEquals(direct, GatewayEndpoint.alternate())
        GatewayEndpoint.onDefaultNetwork("wifi")
        assertFalse(GatewayEndpoint.relay)
        assertEquals(direct, GatewayEndpoint.baseUrl())
        assertEquals(relay, GatewayEndpoint.alternate())
        assertEquals("$relay/gateway/heartbeat", GatewayEndpoint.alternateUrl("$direct/gateway/heartbeat"))
        assertEquals("$direct/x", GatewayEndpoint.alternateUrl("$relay/x"))
        assertNull(GatewayEndpoint.alternateUrl("http://127.0.0.1/x"))
    }

    @Test fun `network failure on an idempotent request retries once on the alternate endpoint`() {
        val (transport, seen) = failingDirectTransport()
        val response = transport.use { it.execute(GatewayHttpRequest("$direct/gateway/heartbeat", "POST", idempotent = true)) }
        assertEquals(200, response.status)
        assertEquals(listOf("$direct/gateway/heartbeat", "$relay/gateway/heartbeat"), seen)
    }

    @Test fun `GET and Idempotency-Key requests are idempotent by default`() {
        assertTrue(GatewayHttpRequest("$direct/x", "GET").idempotent)
        assertTrue(GatewayHttpRequest("$direct/x", "POST", headers = mapOf("idempotency-key" to "k")).idempotent)
        assertFalse(GatewayHttpRequest("$direct/x", "POST").idempotent)
        assertTrue(GatewayApiRoutes.isIdempotent(GatewayApiRoutes.HEARTBEAT))
        assertTrue(GatewayApiRoutes.isIdempotent(GatewayApiRoutes.ack("c1")))
        assertFalse(GatewayApiRoutes.isIdempotent(GatewayApiRoutes.STANDBY))
        assertFalse(GatewayApiRoutes.isIdempotent(GatewayApiRoutes.mediaOptions("c1")))
    }

    @Test fun `non-idempotent and standby requests are never retried`() {
        listOf(
            GatewayHttpRequest("$direct/gateway/calls/c1/media/offer", "POST"),
            GatewayHttpRequest("$direct/gateway/standby", "POST", idempotent = true, alternateRetry = false),
        ).forEach { request ->
            val (transport, seen) = failingDirectTransport()
            transport.use { assertThrows(IOException::class.java) { it.execute(request) } }
            assertEquals(listOf(request.url), seen)
        }
    }

    @Test fun `an HTTP error status is not a network failure and is not retried`() {
        val seen = Collections.synchronizedList(mutableListOf<String>())
        OwnedGatewayHttpTransport(interceptor = Interceptor { chain ->
            seen += chain.request().url.toString()
            reply(chain, 503)
        }).use { assertEquals(503, it.execute(GatewayHttpRequest("$direct/x", "GET")).status) }
        assertEquals(1, seen.size)
    }

    @Test fun `media options body carries relay and relay mode no longer forces TLS for human calls`() {
        assertTrue(mediaOptionsRequestBody(IceTransport.TLS, "g1", relay = true, captureRequest = null).getBoolean("relay"))
        assertFalse(mediaOptionsRequestBody(IceTransport.UDP, "g1", relay = false, captureRequest = null).getBoolean("relay"))
        // S73b: the planned transport ignores API relay mode; TLS comes from an options `relay: true` grant.
        assertEquals(IceTransport.UDP, mediaPlannedTransport(answeredByAi = false, remembered = IceTransport.UDP))
        assertEquals(IceTransport.TLS, mediaPlannedTransport(answeredByAi = false, remembered = IceTransport.TLS))
    }

    @Test fun `TURN URL with an IP host is accepted with a TLS hostname`() {
        val servers = parseMediaOptionsIceServers(options("turns:203.0.113.29:16801?transport=tcp", "control.example.com"), IceTransport.TLS)
        assertEquals("control.example.com", servers.single().hostname)
        assertEquals("203.0.113.29", turnUrlHost(servers.single().urls.single()))
        assertNull(parseMediaOptionsIceServers(options("turns:control.example.com:16802?transport=tcp", null), IceTransport.TLS).single().hostname)
        assertThrows(IllegalArgumentException::class.java) {
            parseMediaOptionsIceServers(options("turns:203.0.113.29:16801?transport=tcp", "not a host"), IceTransport.TLS)
        }
        assertThrows(IllegalArgumentException::class.java) {
            parseMediaOptionsIceServers(options("turn:203.0.113.29:16801?transport=udp", "control.example.com"), IceTransport.UDP)
        }
    }

    private fun options(url: String, hostname: String?) = JSONObject().put("iceServers", JSONArray().put(
        JSONObject().put("urls", JSONArray().put(url)).put("username", "u").put("credential", "c")
            .apply { hostname?.let { put("hostname", it) } },
    ))

    private fun failingDirectTransport(): Pair<OwnedGatewayHttpTransport, List<String>> {
        val seen = Collections.synchronizedList(mutableListOf<String>())
        val transport = OwnedGatewayHttpTransport(interceptor = Interceptor { chain ->
            val url = chain.request().url.toString()
            seen += url
            if (seen.size == 1) throw IOException("unreachable") else reply(chain, 200)
        })
        return transport to seen
    }

    private fun reply(chain: Interceptor.Chain, code: Int): Response = Response.Builder()
        .request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x")
        .body("{}".toResponseBody()).build()
}
