package org.vodog

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class RelayQualityProbeTest {
    @Test fun `packet is exact 32 byte CCQ1 big endian frame with zero tail`() {
        val frame = relayProbeFrame(249, 0x0102030405060708)
        assertEquals(32, frame.bytes.size)
        assertEquals("CCQ1", frame.bytes.copyOfRange(0, 4).toString(Charsets.US_ASCII))
        val buffer = ByteBuffer.wrap(frame.bytes).order(ByteOrder.BIG_ENDIAN)
        buffer.position(4)
        assertEquals(249, buffer.int)
        assertEquals(0x0102030405060708, buffer.long)
        assertTrue(frame.bytes.copyOfRange(16, 32).all { it == 0.toByte() })
        assertThrows(IllegalArgumentException::class.java) { relayProbeFrame(250, 1) }
    }

    @Test fun `completed probe SDP contains only UDP relay candidates and truthful end marker`() {
        val data = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
            "a=candidate:1 1 udp 1 203.0.113.1 40000 typ relay raddr 0.0.0.0 rport 0\r\n"
        val complete = completeRelayProbeSdp(data)
        assertTrue(complete.endsWith("a=end-of-candidates\r\n"))
        assertEquals(1, complete.lineSequence().count { it.trim() == "a=end-of-candidates" })
        assertThrows(IllegalArgumentException::class.java) {
            completeRelayProbeSdp(data.replace("typ relay", "typ host"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            completeRelayProbeSdp(data.replace(" 1 udp ", " 1 tcp "))
        }
    }

    @Test fun `options parser freezes relay only data channel contract`() {
        val parsed = parseRelayProbeOptions(optionsJson())
        assertEquals("network-1", parsed.networkGeneration)
        assertEquals(5000, parsed.lifetimeMs)
        assertEquals("https://control-node.example/webrtc-probe/offer", parsed.nodes.single().probeUrl)
        assertEquals("turn:control-node.example:3478?transport=udp", parsed.nodes.single().iceServers.single().urls.single())
        assertThrows(IllegalArgumentException::class.java) {
            parseRelayProbeOptions(JSONObject(optionsJson().toString()).put("iceTransportPolicy", "all"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            val invalid = JSONObject(optionsJson().toString())
            invalid.getJSONArray("nodes").getJSONObject(0).put("probeUrl", "https://evil.example/redirect")
            parseRelayProbeOptions(invalid)
        }
    }

    @Test fun `result payload has bounded echo metrics and no loss ratio`() {
        val sample = RelayProbeSample("control-node", "ok", 100, 97, 2000.0, 80.0, 20.0, 40.0, 3.0)
        val json = relaySamplesJson(listOf(sample)).getJSONObject(0)
        assertEquals(97, json.getInt("received"))
        assertEquals(3.0, json.getDouble("jitterMs"), 0.0)
        assertFalse(json.has("lossRatio"))
        val timeout = relaySamplesJson(listOf(RelayProbeSample("control-node", "timeout", 47, 43, 913.0))).getJSONObject(0)
        assertEquals(47, timeout.getInt("sent"))
        assertEquals(43, timeout.getInt("received"))
        assertFalse(timeout.has("rttMedianMs"))
        assertThrows(IllegalArgumentException::class.java) {
            relaySamplesJson(listOf(sample.copy(received = 101)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            relaySamplesJson(listOf(sample.copy(outcome = "timeout")))
        }
    }

    @Test fun `feature off 503 uses cached legacy HTTPS evidence only`() = runBlocking {
        val legacyCalls = intArrayOf(0)
        val legacy = legacyCoordinator(legacyCalls)
        val qualityCalls = intArrayOf(0)
        val coordinator = RelayQualityProbeCoordinator(
            legacy,
            object : RelayProbeControl {
                override suspend fun relayProbeOptions(networkGeneration: String): RelayProbeOptions {
                    qualityCalls[0]++
                    throw ApiError(503, "MEDIA_QUALITY_UNAVAILABLE", "off")
                }
                override suspend fun submitRelayProbeResults(networkGeneration: String, samples: List<RelayProbeSample>) = error("unused")
            },
            MediaProbeGeneration { "network-1" },
            RelayProbeNodeRunner { _, _ -> error("unused") },
            sessionRemainsCurrent = { true },
        )
        assertEquals("network-1", coordinator.ensureCurrent())
        assertEquals("network-1", coordinator.ensureCurrent())
        assertEquals(1, legacyCalls[0])
        assertEquals(1, qualityCalls[0])
    }

    @Test fun `enabled quality submits failures and never downgrades to HTTPS`() = runBlocking {
        val legacyCalls = intArrayOf(0)
        val submitted = mutableListOf<RelayProbeSample>()
        val coordinator = RelayQualityProbeCoordinator(
            legacyCoordinator(legacyCalls),
            object : RelayProbeControl {
                override suspend fun relayProbeOptions(networkGeneration: String) = parsedOptions()
                override suspend fun submitRelayProbeResults(networkGeneration: String, samples: List<RelayProbeSample>): String {
                    submitted += samples
                    return "2099-01-01T00:01:00Z"
                }
            },
            MediaProbeGeneration { "network-1" },
            RelayProbeNodeRunner { node, current ->
                assertTrue(current())
                RelayProbeSample(node.nodeId, "network_error", 0, 0, 0.0)
            },
            sessionRemainsCurrent = { true },
        )
        assertEquals("network-1", coordinator.ensureCurrent())
        assertEquals(listOf("network_error"), submitted.map { it.outcome })
        assertEquals(1, legacyCalls[0])
    }

    @Test fun `enrolled session fails closed if quality endpoint later disappears`() = runBlocking {
        var optionsCalls = 0
        val coordinator = RelayQualityProbeCoordinator(
            legacyCoordinator(intArrayOf(0)),
            object : RelayProbeControl {
                override suspend fun relayProbeOptions(networkGeneration: String): RelayProbeOptions {
                    optionsCalls++
                    if (optionsCalls > 1) throw ApiError(503, "MEDIA_QUALITY_UNAVAILABLE", "gone")
                    return parsedOptions()
                }
                override suspend fun submitRelayProbeResults(networkGeneration: String, samples: List<RelayProbeSample>) = "2099-01-01T00:01:00Z"
            },
            MediaProbeGeneration { "network-1" },
            RelayProbeNodeRunner { node, _ -> RelayProbeSample(node.nodeId, "network_error", 0, 0, 0.0) },
            sessionRemainsCurrent = { true },
        )
        coordinator.ensureCurrent()
        coordinator.invalidate()
        val error = runCatching { coordinator.ensureCurrent() }.exceptionOrNull()
        assertTrue(error is ApiError)
        assertEquals("MEDIA_QUALITY_UNAVAILABLE", (error as ApiError).code)
    }

    @Test fun `invalidate cancels in flight options request carrying old bearer`() = runBlocking {
        val requestStarted = CompletableDeferred<ClientRequest>()
        val requestCancelled = CompletableDeferred<Unit>()
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "owner", "user"))
        val api = ClientApi(sessions, object : ClientTransport {
            override fun execute(request: ClientRequest): JSONObject = error("cancellable path required")
            override suspend fun executeCancellable(request: ClientRequest): JSONObject {
                requestStarted.complete(request)
                try {
                    awaitCancellation()
                } finally {
                    requestCancelled.complete(Unit)
                }
            }
        })
        val coordinator = RelayQualityProbeCoordinator(
            legacyCoordinator(intArrayOf(0)), api, MediaProbeGeneration { "network-1" },
            RelayProbeNodeRunner { _, _ -> error("runner must not start") },
            sessionRemainsCurrent = { true },
        )
        val flight = async { coordinator.ensureCurrent() }
        val request = withTimeout(1_000) { requestStarted.await() }
        assertEquals(ClientApiRoutes.MEDIA_QUALITY_PROBE_OPTIONS, request.path)
        assertEquals("old-access", request.bearerToken)

        coordinator.invalidate()

        withTimeout(1_000) { requestCancelled.await() }
        flight.join()
        assertTrue(flight.isCancelled)
    }

    @Test fun `pre-cancelled URL worker performs zero connection IO`() = runBlocking {
        val connections = AtomicInteger()
        val captured = CompletableDeferred<Thread>()
        val transport = UrlConnectionClientTransport(
            connectionFactory = {
                connections.incrementAndGet()
                error("connection must not open after cancellation")
            },
            startWorker = { captured.complete(it) },
        )
        val flight = async {
            transport.executeCancellable(ClientRequest("POST", "/quality", JSONObject(), null, "old-access"))
        }
        val worker = withTimeout(1_000) { captured.await() }
        flight.cancelAndJoin()
        worker.run()
        assertEquals(0, connections.get())
    }

    @Test fun `invalidate also cancels cancellable token refresh after options 401`() = runBlocking {
        val refreshStarted = CompletableDeferred<ClientRequest>()
        val refreshCancelled = CompletableDeferred<Unit>()
        val calls = AtomicInteger()
        val transport = object : ClientTransport {
            override fun execute(request: ClientRequest): JSONObject = error("cancellable path required")
            override suspend fun executeCancellable(request: ClientRequest): JSONObject {
                if (calls.incrementAndGet() == 1) throw ApiError(401, "UNAUTHORIZED", "expired")
                refreshStarted.complete(request)
                try {
                    awaitCancellation()
                } finally {
                    refreshCancelled.complete(Unit)
                }
            }
        }
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "owner", "user"))
        val coordinator = RelayQualityProbeCoordinator(
            legacyCoordinator(intArrayOf(0)), ClientApi(sessions, transport),
            MediaProbeGeneration { "network-1" }, RelayProbeNodeRunner { _, _ -> error("unused") },
            sessionRemainsCurrent = { true },
        )
        val flight = async { coordinator.ensureCurrent() }
        val refresh = withTimeout(1_000) { refreshStarted.await() }
        assertEquals(ClientApiRoutes.REFRESH, refresh.path)
        assertEquals(null, refresh.bearerToken)
        coordinator.invalidate()
        withTimeout(1_000) { refreshCancelled.await() }
        flight.join()
        assertTrue(flight.isCancelled)
    }

    @Test fun `invalidate disconnects active URL connection and worker exits`() = runBlocking {
        val enteredResponse = CountDownLatch(1)
        val disconnected = CountDownLatch(1)
        val workerExited = CountDownLatch(1)
        val workerThread = AtomicReference<Thread>()
        val connection = object : HttpURLConnection(URL("https://vodog.invalid")) {
            override fun connect() = Unit
            override fun usingProxy() = false
            override fun disconnect() { disconnected.countDown() }
            override fun getOutputStream() = ByteArrayOutputStream()
            override fun getResponseCode(): Int {
                enteredResponse.countDown()
                try {
                    disconnected.await(2, TimeUnit.SECONDS)
                    throw IOException("disconnected")
                } finally {
                    workerExited.countDown()
                }
            }
        }
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "owner", "user"))
        val api = ClientApi(sessions, UrlConnectionClientTransport(
            connectionFactory = { connection },
            startWorker = { workerThread.set(it); it.start() },
        ))
        val coordinator = RelayQualityProbeCoordinator(
            legacyCoordinator(intArrayOf(0)), api, MediaProbeGeneration { "network-1" },
            RelayProbeNodeRunner { _, _ -> error("runner must not start") },
            sessionRemainsCurrent = { true },
        )
        val flight = async(kotlinx.coroutines.Dispatchers.IO) { coordinator.ensureCurrent() }
        assertTrue(enteredResponse.await(1, TimeUnit.SECONDS))
        coordinator.invalidate()
        assertTrue(disconnected.await(1, TimeUnit.SECONDS))
        assertTrue(workerExited.await(1, TimeUnit.SECONDS))
        workerThread.get().join(1_000)
        assertFalse(workerThread.get().isAlive)
        flight.join()
        assertTrue(flight.isCancelled)
    }

    @Test fun `signaling cancellation closes a response whose body is delayed`() = runBlocking {
        val server = ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
        val clientClosed = CountDownLatch(1)
        val serverThread = thread(name = "relay-slow-body-server", isDaemon = true) {
            server.accept().use { socket ->
                val input = socket.getInputStream()
                val header = ByteArrayOutputStream()
                var tail = ""
                while (!tail.endsWith("\r\n\r\n")) {
                    val byte = input.read()
                    if (byte < 0) return@use
                    header.write(byte)
                    tail = (tail + byte.toChar()).takeLast(4)
                }
                val contentLength = Regex("(?i)Content-Length: (\\d+)")
                    .find(header.toString(Charsets.US_ASCII.name()))?.groupValues?.get(1)?.toInt() ?: 0
                repeat(contentLength) { if (input.read() < 0) return@use }
                socket.getOutputStream().apply {
                    write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 65536\r\n\r\n{".toByteArray())
                    flush()
                }
                while (input.read() >= 0) Unit
                clientClosed.countDown()
            }
        }
        try {
            val probeUrl = "http://127.0.0.1:${server.localPort}/webrtc-probe/offer"
            val node = parsedOptions().nodes.single().copy(probeUrl = probeUrl)
            val bodyStarted = CompletableDeferred<Unit>()
            val http = OkHttpClient.Builder().eventListener(object : EventListener() {
                override fun responseBodyStart(call: Call) { bodyStarted.complete(Unit) }
            }).build()
            supervisorScope {
                val flight = async(kotlinx.coroutines.Dispatchers.IO) { HttpRelayProbeSignaler(http).offer(node, "v=0") }
                withTimeout(1_000) { bodyStarted.await() }
                withTimeout(1_000) { flight.cancelAndJoin() }
                assertTrue(flight.isCancelled)
            }
        } finally {
            assertTrue(clientClosed.await(1, TimeUnit.SECONDS))
            server.close()
            serverThread.join(1_000)
            assertFalse(serverThread.isAlive)
        }
    }

    private fun legacyCoordinator(calls: IntArray): MediaProbeCoordinator {
        val expiry = "2099-01-01T00:01:00Z"
        return MediaProbeCoordinator(
            object : MediaProbeControl {
                override fun probeOptions(networkGeneration: String): MediaProbeOptions {
                    calls[0]++
                    return MediaProbeOptions(networkGeneration, expiry, listOf(MediaProbeNode("control-node", "https://control-node.example/probe", expiry, listOf("a", "b", "c"))))
                }
                override fun submitProbeResults(networkGeneration: String, samples: List<MediaProbeSample>) = expiry
            },
            MediaProbeGeneration { "network-1" },
            MediaProbeNodeRunner { listOf(MediaProbeSample(it.nodeId, "ok", 10.0)) },
            now = { Instant.parse("2026-09-10T00:00:00Z") },
        )
    }

    private fun parsedOptions() = parseRelayProbeOptions(optionsJson())

    private fun optionsJson() = JSONObject()
        .put("networkGeneration", "network-1")
        .put("measurement", "relay_data_channel_echo_v1")
        .put("lifetimeMs", 5000).put("sampleDurationMs", 2000).put("packetIntervalMs", 20)
        .put("maxPackets", 250).put("maxPacketBytes", 512).put("iceTransportPolicy", "relay")
        .put("nodes", JSONArray().put(JSONObject()
            .put("nodeId", "control-node").put("probeUrl", "https://control-node.example/webrtc-probe/offer")
            .put("expiresAt", "2099-01-01T00:00:30Z").put("grant", "g".repeat(32))
            .put("iceServers", JSONArray().put(JSONObject()
                .put("urls", JSONArray().put("turn:control-node.example:3478?transport=udp"))
                .put("username", "user").put("credential", "credential")))))
}
