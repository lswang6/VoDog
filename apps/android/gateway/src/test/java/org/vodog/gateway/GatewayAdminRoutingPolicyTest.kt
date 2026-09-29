package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

class GatewayAdminRoutingPolicyTest {
    @Test fun `all local sims must resolve to exactly one gateway`() {
        val result = GatewayAdminRoutingPolicy.resolve(
            setOf("sim-1", "sim-2"),
            listOf(sim("sim-other", "gateway-other", 0), sim("sim-2", "gateway-local", 1), sim("sim-1", "gateway-local", 0)),
        )

        assertTrue(result is GatewayResolution.Ready)
        result as GatewayResolution.Ready
        assertEquals("gateway-local", result.gatewayId)
        assertEquals(listOf("sim-1", "sim-2"), result.sims.map { it.id })
    }

    @Test fun `missing local sim blocks instead of selecting first admin gateway`() {
        val result = GatewayAdminRoutingPolicy.resolve(
            setOf("sim-1", "sim-2"),
            listOf(sim("sim-1", "gateway-local", 0), sim("unrelated", "gateway-other", 0)),
        )

        assertTrue(result is GatewayResolution.Blocked)
    }

    @Test fun `local sims split across gateways block assignment`() {
        val result = GatewayAdminRoutingPolicy.resolve(
            setOf("sim-1", "sim-2"),
            listOf(sim("sim-1", "gateway-a", 0), sim("sim-2", "gateway-b", 1)),
        )

        assertTrue(result is GatewayResolution.Blocked)
    }

    @Test fun `version conflict refreshes but never auto resubmits`() {
        assertTrue(GatewayAdminRoutingPolicy.refreshAfterFailure(
            GatewayAdminHttpException(409, "VERSION_CONFLICT", "changed")
        ))
        assertEquals(false, GatewayAdminRoutingPolicy.refreshAfterFailure(
            GatewayAdminHttpException(500, "SERVER_ERROR", "failed")
        ))
    }

    @Test fun `network guard fails closed while total control is off`() {
        val error = assertThrows(IllegalStateException::class.java) {
            GatewayAdminNetworkGate.requireEnabled(false)
        }
        assertTrue(error.message.orEmpty().contains("总控已关闭"))
        GatewayAdminNetworkGate.requireEnabled(true)
    }

    @Test fun `off guard prevents opening an admin connection`() {
        var opened = false
        val api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { false }) {
            opened = true
            FakeConnection(it, 500, "{}")
        }

        assertThrows(IllegalStateException::class.java) { api.beginRequest() }
        assertEquals(false, opened)
    }

    @Test fun `assignment sends frozen expected version and bearer`() {
        lateinit var connection: FakeConnection
        val api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { true }) {
            FakeConnection(it, 200, """{"sim":{"id":"sim/one","ownerUserId":"user-2","version":8}}""")
                .also { created -> connection = created }
        }
        val result = api.assignOwner(
            api.beginRequest(), "admin-token", sim("sim/one", "gateway", 0).copy(version = 7), "user-2"
        )

        assertEquals("/api/v1/admin/sims/sim%2Fone/owner", connection.url.path)
        assertEquals(false, connection.instanceFollowRedirects)
        assertEquals("close", connection.getRequestProperty("Connection"))
        assertTrue(connection.disconnected)
        assertEquals("Bearer admin-token", connection.getRequestProperty("Authorization"))
        val body = JSONObject(connection.body.toString(Charsets.UTF_8.name()))
        assertEquals(7, body.getInt("expectedVersion"))
        assertEquals("user-2", body.getString("ownerUserId"))
        assertEquals(8, result.version)
    }

    @Test fun `request token from before off cannot send after control is reenabled`() {
        var enabled = true
        var opened = false
        val api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { enabled }) {
            opened = true
            FakeConnection(it, 200, adminLoginResponse())
        }
        val oldToken = api.beginRequest()
        enabled = false
        api.cancelAll()
        enabled = true

        assertThrows(GatewayAdminRequestCancelledException::class.java) {
            api.login(oldToken, "admin", "password")
        }
        assertEquals(false, opened)
    }

    @Test fun `closed admin owner cannot rotate back to an open transport`() {
        var opened = false
        val api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { true }) {
            opened = true
            FakeConnection(it, 200, adminLoginResponse())
        }

        api.close()
        api.cancelAll()

        assertThrows(IllegalStateException::class.java) { api.beginRequest() }
        assertEquals(false, opened)
    }

    @Test fun `off during connection registration disconnects before output`() {
        lateinit var api: GatewayAdminApi
        lateinit var connection: FakeConnection
        api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { true }) { url ->
            FakeConnection(url, 200, adminLoginResponse()).also {
                connection = it
                api.cancelAll()
            }
        }
        val token = api.beginRequest()

        assertThrows(GatewayAdminRequestCancelledException::class.java) {
            api.login(token, "admin", "password")
        }
        assertTrue(connection.disconnected)
        assertEquals(0, connection.outputRequests)
    }

    @Test fun `cancelled generation cannot apply response`() {
        lateinit var api: GatewayAdminApi
        lateinit var connection: FakeConnection
        api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { true }) { url ->
            FakeConnection(url, 200, adminLoginResponse(), onResponseCode = { api.cancelAll() })
                .also { connection = it }
        }
        val token = api.beginRequest()

        assertThrows(GatewayAdminRequestCancelledException::class.java) {
            api.login(token, "admin", "password")
        }
        assertTrue(connection.disconnected)
    }

    @Test fun `admin response body is limited to one mebibyte`() {
        val oversized = "x".repeat(1024 * 1024 + 1)
        val api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { true }) {
            FakeConnection(it, 200, oversized)
        }

        val error = assertThrows(GatewayAdminHttpException::class.java) {
            api.login(api.beginRequest(), "admin", "password")
        }
        assertEquals("RESPONSE_TOO_LARGE", error.code)
    }

    @Test fun `report request binds period timezone cursor and parses only summary fields`() {
        lateinit var connection: FakeConnection
        val response = """{
          "window":{"period":"1m","timeZone":"Asia/Taipei","fromInclusive":"2024-02-01T00:00:00Z","toExclusive":"2024-03-01T00:00:00Z"},
          "items":[{"callId":"call-1","sim":{"id":"sim-1","label":"SIM 1","slotIndex":0},
            "historicalOwner":{"id":"owner-1","username":"owner@example.test"},"remoteNumberMasked":"••••0101",
            "startedAt":"2024-02-20T00:00:00Z","answeredAt":null,"endedAt":null,"state":"ended",
            "modeSnapshot":"timeout_ai","answeredByPlatform":"ai","transcriptStatus":"not_started","summary":null,
            "actionItems":[],"recordingStatus":"none","advertisingClassification":"unknown","transcriptCompletedAt":null}],
          "nextCursor":"cursor.value"
        }"""
        val api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { true }) {
            FakeConnection(it, 200, response).also { created -> connection = created }
        }

        val page = api.reports(
            api.beginRequest(), "admin-token", "gateway/id", GatewayAdminReportPeriod.ONE_MONTH,
            "Asia/Taipei", cursor = "old cursor", limit = 25,
        )

        assertEquals(
            "/api/v1/admin/gateways/gateway%2Fid/reports/calls?period=1m&timeZone=Asia%2FTaipei&answeredBy=ai&limit=25&cursor=old+cursor",
            connection.url.file,
        )
        assertEquals("Bearer admin-token", connection.getRequestProperty("Authorization"))
        assertEquals("owner@example.test", page.items.single().historicalOwnerUsername)
        assertEquals("not_started", page.items.single().transcriptStatus)
        assertEquals("cursor.value", page.nextCursor)
    }

    @Test fun `report stale guard rejects prior period session and off responses`() {
        val guard = GatewayAdminReportRequestGuard()
        val first = guard.begin("gateway", GatewayAdminReportPeriod.SEVEN_DAYS, null, "token-1")
        assertTrue(guard.accepts(first, "gateway", GatewayAdminReportPeriod.SEVEN_DAYS, "token-1", true))
        guard.begin("gateway", GatewayAdminReportPeriod.ONE_MONTH, null, "token-1")
        assertFalse(guard.accepts(first, "gateway", GatewayAdminReportPeriod.SEVEN_DAYS, "token-1", true))
        val current = guard.begin("gateway", GatewayAdminReportPeriod.ONE_MONTH, null, "token-1")
        assertFalse(guard.accepts(current, "gateway", GatewayAdminReportPeriod.ONE_MONTH, "token-2", true))
        assertFalse(guard.accepts(current, "gateway", GatewayAdminReportPeriod.ONE_MONTH, "token-1", false))
        guard.invalidate()
        assertFalse(guard.accepts(current, "gateway", GatewayAdminReportPeriod.ONE_MONTH, "token-1", true))
    }

    @Test fun `report pagination rejects duplicate calls and changed frozen window`() {
        val item = reportItem("call-1")
        val window = GatewayAdminReportWindow("7d", "Asia/Taipei", "from", "to")
        val current = GatewayAdminReportPage(window, listOf(item), "next")
        assertThrows(IllegalArgumentException::class.java) {
            mergeGatewayAdminReportPages(current, GatewayAdminReportPage(window, listOf(item), null))
        }
        assertThrows(IllegalArgumentException::class.java) {
            mergeGatewayAdminReportPages(current, GatewayAdminReportPage(window.copy(toExclusive = "changed"), emptyList(), null))
        }
    }

    @Test fun `admin SIM settings preserve availability and applied version`() {
        val api = GatewayAdminApi.forUrlConnectionTest("https://example.test/api/v1", controlEnabled = { true }) { url ->
            val response = when (url.path) {
                "/api/v1/admin/users" -> """{"items":[]}"""
                "/api/v1/admin/gateways" -> """{"items":[]}"""
                else -> """{"items":[{"id":"sim-1","gatewayId":"gateway-1","slotIndex":0,"ownerUserId":null,
                  "label":"SIM 1","countryIso":"CN","embedded":true,"version":3,"assignmentPending":false,"present":true,
                  "settings":{"mode":"normal","timeoutSeconds":45,"version":7,"appliedVersion":6,
                  "availableModes":["normal"],"aiUnavailableReason":"AI 接听服务尚未就绪"}},
                  {"id":"sim-old","gatewayId":"gateway-1","slotIndex":null,"ownerUserId":"owner-1",
                  "label":"历史 eSIM","version":4,"assignmentPending":false,"present":false}]}"""
            }
            FakeConnection(url, 200, response)
        }

        val sims = api.load(api.beginRequest(), "token").sims
        val settings = sims.single { it.id == "sim-1" }.settings!!
        assertEquals("normal", settings.mode)
        assertEquals(7, settings.version)
        assertEquals(6, settings.appliedVersion)
        assertEquals(setOf("normal"), settings.availableModes)
        assertEquals("AI 接听服务尚未就绪", settings.aiUnavailableReason)
        assertEquals("CN", sims.single { it.id == "sim-1" }.countryIso)
        assertEquals(true, sims.single { it.id == "sim-1" }.embedded)
        assertEquals(null, sims.single { it.id == "sim-old" }.slotIndex)
    }

    private fun sim(id: String, gatewayId: String, slotIndex: Int) = GatewayAdminSim(
        id = id,
        gatewayId = gatewayId,
        slotIndex = slotIndex,
        ownerUserId = null,
        label = "SIM ${slotIndex + 1}",
        version = 1,
        assignmentPending = false,
        present = true,
        settings = null,
    )

    private class FakeConnection(
        url: URL,
        private val status: Int,
        response: String,
        private val onResponseCode: () -> Unit = {},
    ) : HttpURLConnection(url) {
        val body = ByteArrayOutputStream()
        private val responseBytes = response.toByteArray()
        var disconnected = false
        var outputRequests = 0

        override fun connect() = Unit
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun getResponseCode(): Int {
            onResponseCode()
            return status
        }
        override fun getInputStream() = ByteArrayInputStream(responseBytes)
        override fun getErrorStream() = ByteArrayInputStream(responseBytes)
        override fun getOutputStream(): ByteArrayOutputStream {
            outputRequests++
            return body
        }
    }

    private fun adminLoginResponse() =
        """{"user":{"id":"admin-id","username":"admin","role":"admin"},"token":"token"}"""

    private fun reportItem(callId: String) = GatewayAdminReportItem(
        callId, "sim", "SIM", 0, "owner", "••••0101", "started", null, null,
        "ended", "ai", "succeeded", "summary", emptyList(), "complete", "unknown", null,
    )
}
