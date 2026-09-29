package org.vodog.gateway.media

import org.vodog.gateway.GatewayHttpRequest
import org.vodog.gateway.GatewayHttpResponse
import org.vodog.gateway.GatewayHttpTransport
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.Executors
import kotlin.system.measureTimeMillis

class GatewayMediaQualityProbeTest {
    @Test fun `fixed quality packet is exact and big endian`() {
        val bytes = encodeQualityPacket(17, 123456)
        assertEquals(32, bytes.size)
        assertArrayEquals(byteArrayOf(0x43, 0x43, 0x51, 0x31), bytes.copyOfRange(0, 4))
        assertEquals(17 to 123456L, decodeQualityPacket(bytes))
        assertTrue(bytes.copyOfRange(16, 32).all { it == 0.toByte() })
        assertEquals(null, decodeQualityPacket(bytes.copyOf().also { it[31] = 1 }))
    }

    @Test fun `success metrics use successive RTT differences`() {
        assertEquals(
            GatewayQualitySample("control-node", "ok", 20, 4, 2000.0, 50.0, 20.0, 40.0, 10.0),
            qualitySuccess("control-node", 20, 2000.0, 50.0, listOf(10.0, 20.0, 30.0, 40.0)),
        )
    }

    @Test fun `disabled quality endpoint preserves HTTPS readiness and backs off for five minutes`() = runBlocking {
        var snapshot: GatewayMediaQualityDiagnosticSnapshot? = null
        var optionsCalls = 0
        var elapsedMs = 1_000L
        val probe = GatewayMediaQualityProbe(object : GatewayQualityControl {
            override suspend fun options(networkGeneration: String): GatewayQualityOptions {
                optionsCalls++
                throw GatewayMediaHttpException(503, "MEDIA_QUALITY_UNAVAILABLE", "off")
            }
            override suspend fun results(networkGeneration: String, samples: List<GatewayQualitySample>) = error("unused")
        }, GatewayQualityRunner { _, _, _ -> error("unused") }, GatewayProbeGeneration { "generation" },
            GatewayMediaQualityDiagnosticRecorder { snapshot = it }, { Instant.parse("2026-09-10T10:00:00Z") }, { false },
            { elapsedMs })
        assertFalse(probe.measure("generation"))
        assertEquals("disabled", snapshot?.stage)
        assertEquals(null, snapshot?.expiresAt)
        assertEquals(0, snapshot?.acceptedCount)
        assertTrue(snapshot?.nodes?.isEmpty() == true)
        assertEquals(1, optionsCalls)

        // Every later probe cycle inside the window records the diagnostic without another request.
        elapsedMs += 10_000L
        assertFalse(probe.measure("generation"))
        assertEquals(1, optionsCalls)
        assertEquals("disabled", snapshot?.stage)
        elapsedMs += QUALITY_DISABLED_BACKOFF_MS
        assertFalse(probe.measure("generation"))
        assertEquals(2, optionsCalls)
    }

    @Test fun `S69 enabled false options back off for retryAfterMs`() = runBlocking {
        var optionsCalls = 0
        var elapsedMs = 1_000L
        val probe = GatewayMediaQualityProbe(object : GatewayQualityControl {
            override suspend fun options(networkGeneration: String): GatewayQualityOptions {
                optionsCalls++
                return parseGatewayQualityOptions(JSONObject().put("enabled", false).put("retryAfterMs", 60_000L))
            }
            override suspend fun results(networkGeneration: String, samples: List<GatewayQualitySample>) = error("unused")
        }, GatewayQualityRunner { _, _, _ -> error("unused") }, GatewayProbeGeneration { "generation" },
            GatewayMediaQualityDiagnosticRecorder {}, { Instant.parse("2026-09-26T10:00:00Z") }, { false }, { elapsedMs })
        assertFalse(probe.measure("generation"))
        elapsedMs += 59_000L
        assertFalse(probe.measure("generation"))
        assertEquals(1, optionsCalls)
        elapsedMs += 1_000L
        assertFalse(probe.measure("generation"))
        assertEquals(2, optionsCalls)
        // No retryAfterMs falls back to the hourly backoff.
        assertEquals(QUALITY_DISABLED_BACKOFF_MS,
            runCatching { parseGatewayQualityOptions(JSONObject().put("enabled", false)) }
                .exceptionOrNull().let { (it as GatewayQualityDisabled).retryAfterMs })
    }

    @Test fun `enrolled failed result is submitted and network generation is fenced`() {
        runBlocking {
            var generation = "generation-a"
            val submitted = mutableListOf<GatewayQualitySample>()
            val probe = GatewayMediaQualityProbe(object : GatewayQualityControl {
                override suspend fun options(networkGeneration: String) = fixtureOptions(networkGeneration)
                override suspend fun results(networkGeneration: String, samples: List<GatewayQualitySample>): Int {
                    submitted += samples; return samples.size
                }
            }, GatewayQualityRunner { node, _, _ -> GatewayQualitySample(node.nodeId, "timeout", 0, 0, 2000.0) },
                GatewayProbeGeneration { generation }, closed = { false })
            assertTrue(probe.measure(generation))
            assertEquals("timeout", submitted.single().outcome)
            generation = "generation-b"
            assertThrows(IllegalArgumentException::class.java) { runBlocking { probe.measure("generation-a") } }
        }
    }

    @Test fun `options samples and SDP enforce bounded UDP relay contract`() {
        val json = JSONObject().put("networkGeneration", "generation").put("measurement", "relay_data_channel_echo_v1")
            .put("lifetimeMs", 5000).put("sampleDurationMs", 2000).put("packetIntervalMs", 20).put("maxPackets", 250)
            .put("maxPacketBytes", 512).put("iceTransportPolicy", "relay").put("nodes", JSONArray().put(JSONObject()
                .put("nodeId", "control-node").put("probeUrl", "https://relay.example/webrtc-probe/offer")
                .put("expiresAt", "2026-09-10T10:00:00Z").put("grant", "grant").put("iceServers", JSONArray().put(JSONObject()
                    .put("urls", JSONArray().put("turn:relay.example:3478?transport=udp")).put("username", "user").put("credential", "secret")))))
        assertEquals("control-node", parseGatewayQualityOptions(json).nodes.single().nodeId)
        val failure = GatewayQualitySample("control-node", "timeout", 10, 0, 5000.0)
        assertFalse(gatewayQualitySamplesJson(listOf(failure)).getJSONObject(0).has("rttMedianMs"))
        assertThrows(IllegalArgumentException::class.java) { gatewayQualitySamplesJson(listOf(failure.copy(received = 11))) }
        val good = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 UDP 1 203.0.113.1 5000 typ relay\r\n"
        assertTrue(completedRelayOnlyUdpSdp(good).contains("typ relay\r\na=end-of-candidates"))
        assertThrows(IllegalArgumentException::class.java) { completedRelayOnlyUdpSdp(good.replace("relay", "host")) }
    }

    @Test fun `blocked offer HTTP is cancelled within the absolute budget and transport closes once`() {
        val released = CountDownLatch(1)
        val closes = AtomicInteger()
        val requestTimeout = AtomicLong()
        val transport = object : GatewayHttpTransport {
            override fun execute(request: GatewayHttpRequest): GatewayHttpResponse {
                requestTimeout.set(request.timeoutMs)
                released.await(5, TimeUnit.SECONDS)
                throw java.io.InterruptedIOException("cancelled")
            }
            override fun cancelAndEvict() { if (closes.incrementAndGet() == 1) released.countDown() }
        }
        val elapsed = measureTimeMillis {
            assertThrows(kotlinx.coroutines.TimeoutCancellationException::class.java) {
                runBlocking {
                    withTimeout(200) {
                        executeQualityRequestWithinDeadline({ transport }, GatewayHttpRequest("https://relay.example/webrtc-probe/offer", "POST"),
                            System.nanoTime(), 200, System::nanoTime)
                    }
                }
            }
        }
        assertTrue("blocked HTTP exceeded cancellation bound: ${elapsed}ms", elapsed < 1_000)
        assertTrue(requestTimeout.get() in 1..200)
        assertEquals(1, closes.get())
    }

    @Test fun `remaining request timeout excludes work already spent`() {
        assertEquals(25L, remainingQualityBudgetMs(1_000_000_000L, 100, 1_075_000_000L))
        assertThrows(IllegalArgumentException::class.java) { remainingQualityBudgetMs(1_000_000_000L, 100, 1_100_000_000L) }
    }

    @Test fun `accepted diagnostic records expiry and failed outcomes without claiming node success`() = runBlocking {
        var snapshot: GatewayMediaQualityDiagnosticSnapshot? = null
        val probe = GatewayMediaQualityProbe(object : GatewayQualityControl {
            override suspend fun options(networkGeneration: String) = fixtureOptions(networkGeneration)
            override suspend fun results(networkGeneration: String, samples: List<GatewayQualitySample>) = samples.size
        }, GatewayQualityRunner { node, _, _ -> GatewayQualitySample(node.nodeId, "timeout", 12, 0, 2000.0) },
            GatewayProbeGeneration { "generation" }, GatewayMediaQualityDiagnosticRecorder { snapshot = it },
            { Instant.parse("2026-09-10T09:59:59Z") }, { false })

        assertTrue(probe.measure("generation"))
        val recorded = requireNotNull(snapshot)
        assertEquals("accepted", recorded.stage)
        assertEquals(1, recorded.acceptedCount)
        assertEquals(Instant.parse("2026-09-10T10:00:00Z"), recorded.expiresAt)
        assertEquals("timeout", recorded.nodes.single().outcome)
        val encoded = encodeGatewayMediaQualityDiagnostic(recorded)
        assertFalse(encoded.contains("grant")); assertFalse(encoded.contains("secret")); assertFalse(encoded.contains("probeUrl"))
    }

    @Test fun `failure and cancellation replace prior success diagnostics while recorder failure is isolated`() = runBlocking {
        val snapshots = mutableListOf<GatewayMediaQualityDiagnosticSnapshot>()
        var mode = "accepted"
        val probe = GatewayMediaQualityProbe(object : GatewayQualityControl {
            override suspend fun options(networkGeneration: String) = fixtureOptions(networkGeneration)
            override suspend fun results(networkGeneration: String, samples: List<GatewayQualitySample>): Int {
                if (mode == "failed") error("raw private failure")
                if (mode == "malformed_sample") gatewayQualitySamplesJson(samples)
                if (mode == "invalid_count") return -1
                return samples.size
            }
        }, GatewayQualityRunner { node, _, _ ->
            if (mode == "cancelled") throw CancellationException("raw cancellation")
            if (mode == "malformed_sample") return@GatewayQualityRunner GatewayQualitySample(node.nodeId, "ok", 20, 1, Double.NaN)
            GatewayQualitySample(node.nodeId, "timeout", 0, 0, 2000.0)
        }, GatewayProbeGeneration { "generation" }, GatewayMediaQualityDiagnosticRecorder { snapshots += it }, closed = { false })

        assertTrue(probe.measure("generation")); assertEquals("accepted", snapshots.last().stage)
        mode = "failed"; assertThrows(IllegalStateException::class.java) { runBlocking { probe.measure("generation") } }
        assertEquals("failed", snapshots.last().stage); assertFalse(encodeGatewayMediaQualityDiagnostic(snapshots.last()).contains("raw private failure"))
        mode = "cancelled"; assertThrows(CancellationException::class.java) { runBlocking { probe.measure("generation") } }
        assertEquals("cancelled", snapshots.last().stage); assertFalse(encodeGatewayMediaQualityDiagnostic(snapshots.last()).contains("raw cancellation"))
        mode = "invalid_count"; assertThrows(IllegalArgumentException::class.java) { runBlocking { probe.measure("generation") } }
        assertEquals("failed", snapshots.last().stage); assertEquals(0, snapshots.last().acceptedCount)
        mode = "malformed_sample"; assertThrows(IllegalArgumentException::class.java) { runBlocking { probe.measure("generation") } }
        assertEquals("failed", snapshots.last().stage); assertTrue(snapshots.last().nodes.isEmpty())

        val isolated = GatewayMediaQualityProbe(object : GatewayQualityControl {
            override suspend fun options(networkGeneration: String): GatewayQualityOptions =
                throw GatewayMediaHttpException(503, "MEDIA_QUALITY_UNAVAILABLE", "off")
            override suspend fun results(networkGeneration: String, samples: List<GatewayQualitySample>) = error("unused")
        }, GatewayQualityRunner { _, _, _ -> error("unused") }, GatewayProbeGeneration { "generation" },
            GatewayMediaQualityDiagnosticRecorder { error("storage unavailable") }, closed = { false })
        assertFalse(isolated.measure("generation"))
    }

    @Test fun `quality diagnostic encoder bounds nodes and rejects nonfinite metrics without serializing secrets`() {
        val snapshot = GatewayMediaQualityDiagnosticSnapshot("accepted", "generation", Instant.EPOCH, acceptedCount = 1,
            nodes = listOf(GatewayMediaQualityNodeDiagnostic("control-node", "ok", 20, 1, 2000.0, 10.0, 12.0, 2.0)))
        val json = JSONObject(encodeGatewayMediaQualityDiagnostic(snapshot))
        assertEquals(1, json.getInt("schemaVersion")); assertEquals(1, json.getJSONArray("nodes").length())
        assertEquals(1, json.getInt("okCount")); assertEquals(0, json.getInt("timeoutCount")); assertEquals(0, json.getInt("networkErrorCount"))
        assertFalse(json.toString().contains("rttMedianMs")); assertFalse(json.toString().contains("credential"))
        assertThrows(IllegalArgumentException::class.java) {
            encodeGatewayMediaQualityDiagnostic(snapshot.copy(nodes = snapshot.nodes.map { it.copy(jitterMs = Double.NaN) }))
        }
        assertThrows(IllegalArgumentException::class.java) {
            encodeGatewayMediaQualityDiagnostic(snapshot.copy(nodes = List(17) { snapshot.nodes.single().copy(nodeId = "n$it") }))
        }
    }

    @Test fun `resource construction serializes close and disposes every adopted resource once`() {
        val resources = CloseAwareQualityResources()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val closes = List(3) { AtomicInteger() }
        val executor = Executors.newFixedThreadPool(2)
        try {
            val building = executor.submit {
                resources.construct {
                    adopt("factory") { closes[0].incrementAndGet() }
                    entered.countDown(); release.await(2, TimeUnit.SECONDS)
                    adopt("peer") { closes[1].incrementAndGet() }
                    adopt("channel") { closes[2].incrementAndGet() }
                }
            }
            assertTrue(entered.await(1, TimeUnit.SECONDS))
            val closing = executor.submit { resources.close() }
            Thread.sleep(25)
            assertFalse(closing.isDone)
            release.countDown(); building.get(1, TimeUnit.SECONDS); closing.get(1, TimeUnit.SECONDS)
            resources.close()
            assertEquals(listOf(1, 1, 1), closes.map { it.get() })
        } finally { release.countDown(); executor.shutdownNow() }
    }

    @Test fun `preclosed resource owner rejects setup before allocation`() {
        val resources = CloseAwareQualityResources(); var allocations = 0; var httpAttempts = 0
        resources.close()
        assertThrows(IllegalStateException::class.java) { resources.construct { allocations++; adopt("peer") {} } }
        assertThrows(IllegalStateException::class.java) { runBlocking {
            executeQualityRequestWithinDeadline({ resources.construct {
                httpAttempts++
                adopt(CloseOnceQualityTransport(GatewayHttpTransport { error("must not execute") })) { it.close() }
            } }, GatewayHttpRequest("https://relay.example/webrtc-probe/offer", "POST"), System.nanoTime(), 5_000, System::nanoTime)
        } }
        assertEquals(0, allocations)
        assertEquals(0, httpAttempts)
    }

    private fun fixtureOptions(generation: String) = GatewayQualityOptions(generation, 5000, 2000, 20, 250, listOf(
        GatewayQualityNode("control-node", "https://relay.example/webrtc-probe/offer", Instant.parse("2026-09-10T10:00:00Z"),
            "grant", listOf(MediaIceServer(listOf("turn:relay.example:3478?transport=udp"), "user", "secret")))))
}
