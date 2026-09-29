package org.vodog

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.Instant
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

class MediaProbeTest {
    @Test fun `probe evidence is cached only for the same live network generation`() = runBlocking {
        var currentGeneration = "network-a"
        var now = Instant.parse("2026-09-10T00:00:00Z")
        val optionRequests = mutableListOf<String>()
        val resultRequests = mutableListOf<Pair<String, List<MediaProbeSample>>>()
        val control = object : MediaProbeControl {
            override fun probeOptions(networkGeneration: String): MediaProbeOptions {
                optionRequests += networkGeneration
                return MediaProbeOptions(
                    networkGeneration,
                    now.plusSeconds(60).toString(),
                    listOf(node("control-node"), node("relay-node")),
                )
            }

            override fun submitProbeResults(networkGeneration: String, samples: List<MediaProbeSample>): String {
                resultRequests += networkGeneration to samples
                return now.plusSeconds(45).toString()
            }
        }
        val coordinator = MediaProbeCoordinator(
            control,
            MediaProbeGeneration { currentGeneration },
            MediaProbeNodeRunner { node ->
                List(3) { MediaProbeSample(node.nodeId, "ok", if (node.nodeId == "control-node") 10.0 else 20.0) }
            },
        ) { now }

        assertEquals("network-a", coordinator.ensureCurrent())
        assertEquals("network-a", coordinator.ensureCurrent())
        assertEquals(listOf("network-a"), optionRequests)
        assertEquals(setOf("control-node", "relay-node"), resultRequests.single().second.map { it.nodeId }.toSet())
        assertEquals(6, resultRequests.single().second.size)
        assertEquals(3, resultRequests.single().second.count { it.nodeId == "control-node" })
        assertEquals(3, resultRequests.single().second.count { it.nodeId == "relay-node" })

        coordinator.invalidate()
        assertEquals("network-a", coordinator.ensureCurrent())
        assertEquals(listOf("network-a", "network-a"), optionRequests)

        currentGeneration = "network-b"
        assertEquals("network-b", coordinator.ensureCurrent())
        assertEquals(listOf("network-a", "network-a", "network-b"), optionRequests)
    }

    @Test fun `parser requires server supplied HTTPS targets and preserves opaque node ids`() {
        val parsed = parseMediaProbeOptions(
            JSONObject()
                .put("networkGeneration", "opaque-generation")
                .put("expiresAt", "2026-09-10T01:00:00Z")
                .put("nodes", JSONArray().put(
                    JSONObject().put("nodeId", "future-node")
                        .put("probeUrl", "https://probe.example.test/probe")
                        .put("expiresAt", "2026-09-10T01:00:00Z")
                        .put("grants", JSONArray(listOf("a", "b", "c"))),
                )),
        )
        assertEquals("future-node", parsed.nodes.single().nodeId)
        assertFalse(samplesJson(listOf(MediaProbeSample("future-node", "timeout"))).getJSONObject(0).has("httpsRttMs"))
        assertThrows(IllegalArgumentException::class.java) {
            parseMediaProbeOptions(
                JSONObject().put("networkGeneration", "x").put("expiresAt", "2026-09-10T01:00:00Z")
                    .put("nodes", JSONArray().put(JSONObject().put("nodeId", "bad").put("probeUrl", "http://bad")
                        .put("expiresAt", "2026-09-10T01:00:00Z").put("grants", JSONArray(listOf("a", "b", "c"))))),
            )
        }
    }

    @Test fun `HTTPS runner consumes all three grants without body cookies content type or redirects`() {
        val opened = mutableListOf<FakeProbeConnection>()
        var clock = 0L
        val runner = HttpsMediaProbeRunner(
            connectionFactory = { url -> FakeProbeConnection(url, "future-node").also(opened::add) },
            nanoTime = { clock.also { clock += 10_000_000 } },
        )
        val result = runner.measure(node("future-node"))

        assertEquals(3, result.size)
        assertEquals(listOf("ok", "ok", "ok"), result.map { it.outcome })
        assertEquals(listOf(10.0, 10.0, 10.0), result.map { it.httpsRttMs })
        assertEquals(3, opened.size)
        opened.forEachIndexed { index, connection ->
            assertEquals("POST", connection.requestMethod)
            assertFalse(connection.doOutput)
            assertFalse(connection.instanceFollowRedirects)
            assertNull(connection.getRequestProperty("Cookie"))
            assertNull(connection.getRequestProperty("Content-Type"))
            assertEquals("Bearer ${listOf("one", "two", "three")[index]}", connection.getRequestProperty("Authorization"))
        }
    }

    @Test fun `HTTPS runner preserves two successes and one failure as independent samples`() {
        val statuses = ArrayDeque(listOf(200, 503, 200))
        val runner = HttpsMediaProbeRunner(
            connectionFactory = { url -> FakeProbeConnection(url, "future-node", statuses.removeFirst()) },
        )

        val samples = runner.measure(node("future-node"))

        assertEquals(listOf("ok", "network_error", "ok"), samples.map { it.outcome })
        assertEquals(2, samples.count { it.outcome == "ok" && it.httpsRttMs != null })
        assertNull(samples.single { it.outcome == "network_error" }.httpsRttMs)
    }

    private fun node(id: String) = MediaProbeNode(
        id,
        "https://$id.example.test/probe",
        "2026-09-10T01:00:00Z",
        listOf("one", "two", "three"),
    )

    private class FakeProbeConnection(
        url: URL,
        nodeId: String,
        private val status: Int = 200,
    ) : HttpURLConnection(url) {
        private val response = JSONObject().put("ok", true).put("nodeId", nodeId).toString().toByteArray()
        override fun connect() = Unit
        override fun disconnect() = Unit
        override fun usingProxy() = false
        override fun getResponseCode() = status
        override fun getInputStream() = ByteArrayInputStream(response)
    }
}
