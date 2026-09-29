package org.vodog.gateway

import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class GatewayHttpConnectionPolicyTest {
    @Test fun `control success requests close the transport instead of returning it to keepalive pool`() {
        val connection = FakeConnection(
            200,
            """{"gateway":{"id":"gateway-a","deviceEpoch":1,"serverSequence":0},"commands":[]}""",
        )
        val transport = UrlConnectionGatewayHttpTransport { connection }
        val result = GatewayApi("token", { true }, transport)
            .heartbeat(controlEnabled = true, reportedSequence = 0)

        assertEquals(1L, result.deviceEpoch)
        assertConnectionClosed(connection)
    }

    @Test fun `control error requests also close the transport`() {
        val connection = FakeConnection(503, """{"error":{"message":"offline"}}""")

        assertThrows(IllegalStateException::class.java) {
            GatewayApi("token", { true }, UrlConnectionGatewayHttpTransport { connection })
                .heartbeat(controlEnabled = true, reportedSequence = 0)
        }
        assertConnectionClosed(connection)
    }

    @Test fun `disabled control refuses before creating another connection`() {
        var opens = 0
        assertThrows(IllegalStateException::class.java) {
            GatewayApi("token", { false }, GatewayHttpTransport {
                opens += 1
                GatewayHttpResponse(200, "{}")
            }).heartbeat(controlEnabled = false, reportedSequence = 0)
        }
        assertEquals(0, opens)
    }

    @Test fun `heartbeat advertises reconciliation and parses delivery metadata`() {
        lateinit var request: GatewayHttpRequest
        val result = GatewayApi("token", { true }, GatewayHttpTransport {
            request = it
            GatewayHttpResponse(200, """{
                "gateway":{"id":"gateway-a","deviceEpoch":7,"serverSequence":9},
                "commands":[{
                    "id":"11111111-1111-4111-8111-111111111111",
                    "callId":"22222222-2222-4222-8222-222222222222",
                    "generation":7,
                    "sequence":8,
                    "kind":"hangup",
                    "expiresAt":"2026-09-10T00:00:00Z",
                    "reconciliationOnly":true,
                    "payload":{"callId":"22222222-2222-4222-8222-222222222222","deviceCallId":"device-a"}
                }]
            }""")
        }).heartbeat(controlEnabled = true, reportedSequence = 7)

        assertTrue(JSONObject(String(requireNotNull(request.jsonBody)))
            .getJSONObject("capabilities").getBoolean("commandReconciliationReady"))
        assertTrue(result.commands.single().reconciliationOnly)
        assertEquals("gateway-a", result.gatewayId)
    }

    @Test fun `pairing transport follows the same close policy`() {
        val connection = FakeConnection(
            200,
            """{"deviceToken":"token","gateway":{"id":"gateway","deviceEpoch":2}}""",
        )

        assertEquals(
            "gateway",
            GatewayPairingApi(UrlConnectionGatewayHttpTransport { connection }).pair("code", "Pixel").gatewayId,
        )
        assertConnectionClosed(connection)
    }

    @Test fun `connection owner disconnects active work and rejects requests registered after off`() {
        val owner = GatewayHttpConnectionOwner()
        val active = FakeConnection(200, "{}")
        val late = FakeConnection(200, "{}")
        assertTrue(owner.register(active))

        owner.close()

        assertTrue(active.disconnected)
        assertFalse(owner.register(late))
        assertTrue(late.disconnected)
    }

    @Test fun `one broken disconnect does not skip remaining active cleanup`() {
        val owner = GatewayHttpConnectionOwner()
        val broken = FakeConnection(200, "{}").also { it.throwOnDisconnect = true }
        val healthy = FakeConnection(200, "{}")
        assertTrue(owner.register(broken))
        assertTrue(owner.register(healthy))

        owner.close()

        assertTrue(broken.disconnectAttempted)
        assertTrue(healthy.disconnected)
        assertFalse(owner.isOpen())
    }

    @Test fun `owned transport closed after registration cannot start the queued call`() {
        var registeredCallWasCancelled = false
        lateinit var transport: OwnedGatewayHttpTransport
        transport = OwnedGatewayHttpTransport(
            interceptor = Interceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            },
            onCallRegistered = { call ->
                transport.close()
                registeredCallWasCancelled = call.isCanceled()
            },
        )

        assertThrows(java.io.IOException::class.java) {
            transport.execute(GatewayHttpRequest("https://example.test/blocked", "GET"))
        }
        assertTrue(registeredCallWasCancelled)
        assertTrue(transport.isClosed())
    }

    private fun assertConnectionClosed(connection: FakeConnection) {
        assertEquals("close", connection.getRequestProperty("Connection"))
        assertFalse(connection.useCaches)
        assertTrue(connection.disconnected)
    }

    private class FakeConnection(
        private val status: Int,
        response: String,
    ) : HttpURLConnection(URL("https://example.test")) {
        private val responseBytes = response.toByteArray()
        val body = ByteArrayOutputStream()
        var disconnected = false
        var disconnectAttempted = false
        var throwOnDisconnect = false

        override fun connect() = Unit
        override fun disconnect() {
            disconnectAttempted = true
            if (throwOnDisconnect) error("disconnect failed")
            disconnected = true
        }
        override fun usingProxy() = false
        override fun getResponseCode() = status
        override fun getInputStream() = ByteArrayInputStream(responseBytes)
        override fun getErrorStream() = ByteArrayInputStream(responseBytes)
        override fun getOutputStream() = body
    }
}
