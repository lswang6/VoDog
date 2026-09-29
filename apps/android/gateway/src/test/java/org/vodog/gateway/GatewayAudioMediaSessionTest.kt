package org.vodog.gateway

import org.vodog.gateway.media.EncodedOpusFrame
import org.vodog.gateway.media.IceTransport
import org.vodog.gateway.media.MediaDirection
import org.vodog.gateway.media.MediaPacket
import org.vodog.gateway.media.MediaSendResult
import org.vodog.gateway.media.OpusPlayoutProfile
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

class GatewayAudioMediaSessionTest {
    @Test fun mediaStatsCarriesCumulativeAndIntervalDeltas() {
        val first = mediaStatsFields(emptyMap(), mapOf("zeroFillFrames" to 5L, "txPackets" to 1500L))
        assertEquals(5L, first["zeroFillFrames"])
        assertEquals(5L, (first["delta"] as org.json.JSONObject).getLong("zeroFillFrames"))
        val second = mediaStatsFields(mapOf("zeroFillFrames" to 5L, "txPackets" to 1500L),
            mapOf("zeroFillFrames" to 1505L, "txPackets" to 1510L))
        val delta = second["delta"] as org.json.JSONObject
        assertEquals(1505L, second["zeroFillFrames"])
        assertEquals(1500L, delta.getLong("zeroFillFrames"))
        assertEquals(10L, delta.getLong("txPackets"))
        // Window p95 is the p95 of the histogram difference, not of the whole call.
        assertEquals(20L, org.vodog.gateway.media.OpusPlayoutBuffer.p95Ms(longArrayOf(0, 0, 100)))
        assertEquals(0L, org.vodog.gateway.media.OpusPlayoutBuffer.p95Ms(LongArray(3)))
    }

    @Test fun callerPcmIsWrittenBeforeItCanBeInjectedAndStopRestoresMute() {
        val root = Files.createTempDirectory("media-session").toFile()
        val endpoint = FakeEndpoint(); val mute = FakeMute()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "44444444-4444-4444-8444-444444444444"), mute, { true }, monotonicUs = { 0 })
        val started = startAsync(session)
        Thread.sleep(20)
        assertFalse(endpoint.started); assertTrue(mute.acquireCount == 0)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640) { 7 }))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        var injected: ByteArray? = null
        repeat(50) {
            if (injected == null) {
                injected = endpoint.pull?.invoke()
                if (injected == null) Thread.sleep(10)
            }
        }
        assertTrue(injected?.all { it == 7.toByte() } == true)
        val part = root.resolve("44444444-4444-4444-8444-444444444444/caller_original.wav.part")
        // S70: recording is asynchronous and never gates injection; it still lands.
        repeat(100) { if (part.length() < 44 + 640) Thread.sleep(5) }
        assertTrue(part.length() >= 44 + 640)
        session.stop("ended"); session.stop("ended")
        assertTrue(mute.restored); assertTrue(endpoint.stopped)
        root.deleteRecursively()
    }

    @Test fun closedApprovalGateNeverStartsEndpointOrTouchesMute() {
        val root = Files.createTempDirectory("media-gate").toFile(); val endpoint = FakeEndpoint(); val mute = FakeMute()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "55555555-5555-4555-8555-555555555555"), mute, monotonicUs = { 0 })
        assertTrue(session.start().isFailure)
        assertFalse(endpoint.started); assertTrue(mute.acquireCount == 0); assertFalse(mute.restored)
        root.deleteRecursively()
    }

    @Test fun decoderPartialChunksAndFinishTailBecomeOneRecordedThenInjectableFrame() {
        val root = Files.createTempDirectory("media-partial").toFile(); val endpoint = FakeEndpoint()
        val session = GatewayAudioMediaSession(endpoint, TailCodec(), FakeTransport(),
            LocalCallRecorder(root, "66666666-6666-4666-8666-666666666666"), FakeMute(), { true },
            monotonicUs = { 1_000_000 })
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 77_000, byteArrayOf(1)))
        Thread.sleep(50)
        assertFalse(started.isDone); assertFalse(endpoint.started) // 638-byte partial output is not ready.
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 2, 97_000, byteArrayOf(1)))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        session.stop("ended") // The remaining incomplete tail is discarded, never injected.
        val wav = root.resolve("66666666-6666-4666-8666-666666666666/caller_original.wav")
        assertTrue(wav.length() == 44L + 640L)
        val timeline = root.resolve("66666666-6666-4666-8666-666666666666/timeline.jsonl").readText()
        assertTrue(timeline.contains("\"fileOffset\":44"))
        assertTrue(timeline.contains("\"sampleCount\":320"))
        assertTrue(timeline.contains("\"sourceTimestampUs\":77000"))
        root.deleteRecursively()
    }

    @Test fun concurrentFatalSignalsNotifyAndStopOnlyOnce() {
        val root = Files.createTempDirectory("media-fatal").toFile(); val failures = AtomicInteger()
        val session = GatewayAudioMediaSession(FakeEndpoint(), FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "77777777-7777-4777-8777-777777777777"), FakeMute(), { true },
            { failures.incrementAndGet() }, { 0 })
        val started=startAsync(session);session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK,20,1,0,ByteArray(640)))
        assertTrue(started.get(1,TimeUnit.SECONDS).isSuccess)
        session.onTransportFailure("transport_disconnected")
        session.onTransportFailure("transport_protocol_error")
        repeat(100) {
            if (!root.resolve("77777777-7777-4777-8777-777777777777/manifest.json").exists()) Thread.sleep(10)
        }
        assertTrue(failures.get() == 1)
        root.deleteRecursively()
    }

    @Test fun terminalIngressFenceIsImmediateAndPhysicalReleaseIsIdempotentDuringDrain() {
        val root = Files.createTempDirectory("media-terminal").toFile()
        val endpoint = FakeEndpoint(); val transport = FakeTransport()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), transport,
            LocalCallRecorder(root, "88888888-8888-4888-8888-888888888888"), FakeMute(), { true },
            monotonicUs = { 0 })
        val started=startAsync(session);session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK,20,1,0,ByteArray(640)))
        assertTrue(started.get(1,TimeUnit.SECONDS).isSuccess)
        session.requestIngressStop()
        session.requestIngressStop()
        assertTrue(endpoint.pull?.invoke() == null)
        assertTrue(endpoint.stopCount == 0)
        assertTrue(transport.closeCount == 0)
        session.stop("ended")
        assertTrue(endpoint.stopCount == 1)
        assertTrue(transport.closeCount == 1)
        root.deleteRecursively()
    }

    @Test fun prebufferTimeoutClosesResourcesWithoutMutingOrStartingEndpoint() {
        val root=Files.createTempDirectory("media-prebuffer-timeout").toFile()
        val endpoint=FakeEndpoint();val transport=FakeTransport();val mute=FakeMute();val codec=FakeCodec()
        val session=GatewayAudioMediaSession(endpoint,codec,transport,
            LocalCallRecorder(root,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),mute,{true},monotonicUs={0},prebufferTimeoutMs=75)
        assertTrue(session.start().isFailure)
        assertFalse(endpoint.started);assertTrue(endpoint.stopCount==1);assertTrue(transport.closeCount==1)
        assertTrue(mute.acquireCount==0);assertFalse(mute.restored);assertTrue(codec.closed)
        assertTrue(root.resolve("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/manifest.json").exists())
        root.deleteRecursively()
    }

    @Test fun prebufferWindowIsClampedToTheLongerOfTheTwoWindows() {
        // S22 decision 9 gave the AI call a longer window than the human one; S37 made the human
        // window the longer of the two. Either way the clamp must never cut a configured window
        // down - that is how the S37 fix would be silently reverted.
        assertTrue(clampPrebufferTimeoutMs(PREBUFFER_TIMEOUT_MS) == PREBUFFER_TIMEOUT_MS)
        assertTrue(clampPrebufferTimeoutMs(PREBUFFER_TIMEOUT_AI_MS) == 8_000L)
        assertTrue(clampPrebufferTimeoutMs(20_000L) == 20_000L)
        assertTrue(clampPrebufferTimeoutMs(Long.MAX_VALUE) ==
            maxOf(PREBUFFER_TIMEOUT_MS, PREBUFFER_TIMEOUT_AI_MS))
        assertTrue(clampPrebufferTimeoutMs(10L) == 50L)
        assertTrue(clampPrebufferTimeoutMs(0L) == 50L)
        assertTrue(clampPrebufferTimeoutMs(4_500L) == 4_500L)
    }

    @Test fun aiAnsweredSessionsReceiveTheDeeperPlayoutProfile() {
        // S23 decision 1: the playout shape travels the same constructor path as prebufferTimeoutMs,
        // and a session built without it keeps the S20 human buffer.
        val root = Files.createTempDirectory("media-playout-profile").toFile()
        val human = GatewayAudioMediaSession(FakeEndpoint(), FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"), FakeMute(), { true },
            monotonicUs = { 0 })
        assertEquals(OpusPlayoutProfile.HUMAN, human.playoutProfile)
        assertEquals(60L, human.playoutProfile.delayMs)
        val ai = GatewayAudioMediaSession(FakeEndpoint(), FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), FakeMute(), { true },
            monotonicUs = { 0 }, playoutProfile = mediaPlayoutProfile(answeredByAi = true))
        assertEquals(OpusPlayoutProfile.AI, ai.playoutProfile)
        assertEquals(200L, ai.playoutProfile.delayMs)
        root.deleteRecursively()
    }

    @Test fun fortyFrameBurstReachesTheRecorderOnBothProfiles() {
        // S70 replaces S25's per-profile queue depths: the arrival hand-off holds 64 frames for every
        // call and drops oldest, so an ~800 ms catch-up burst is recorded whole on either profile.
        val root = Files.createTempDirectory("media-queue-burst").toFile()
        listOf("17171717-1717-4717-8717-171717171717" to true, "18181818-1818-4818-8818-181818181818" to false)
            .forEach { (id, ai) ->
                val session = GatewayAudioMediaSession(FakeEndpoint(), FakeCodec(), FakeTransport(),
                    LocalCallRecorder(root, id), FakeMute(), { true },
                    monotonicUs = { 0 }, playoutProfile = mediaPlayoutProfile(answeredByAi = ai))
                val started = startAsync(session)
                repeat(BURST_FRAMES) { index -> session.onRemotePacket(burstPacket(index)) }
                assertTrue(started.get(2, TimeUnit.SECONDS).isSuccess)
                val part = root.resolve("$id/caller_original.wav.part")
                val expected = 44L + BURST_FRAMES * 640L
                repeat(400) { if (part.length() < expected) Thread.sleep(5) }
                assertEquals(expected, part.length())
                assertEquals(0L, session.stats().remotePacketDrops)
                session.stop("ended")
            }
        root.deleteRecursively()
    }

    @Test fun aiPrebufferWindowSurvivesPastTheThreeSecondHumanDeadline() {
        val root = Files.createTempDirectory("media-prebuffer-ai").toFile()
        val endpoint = FakeEndpoint(); val mute = FakeMute()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), mute, { true },
            monotonicUs = { 0 }, prebufferTimeoutMs = PREBUFFER_TIMEOUT_AI_MS)
        val started = startAsync(session)
        Thread.sleep(3_300) // Past the human window: the old clamp would already have failed here.
        assertFalse(started.isDone); assertFalse(endpoint.started); assertTrue(mute.acquireCount == 0)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640) { 3 }))
        assertTrue(started.get(2, TimeUnit.SECONDS).isSuccess)
        assertTrue(endpoint.started); assertTrue(mute.acquireCount == 1)
        session.stop("ended")
        root.deleteRecursively()
    }

    @Test fun cancellationDuringPrebufferReturnsPromptlyWithoutMuteAndRejectsLatePacket() {
        val root=Files.createTempDirectory("media-prebuffer-cancel").toFile()
        val endpoint=FakeEndpoint();val transport=FakeTransport();val mute=FakeMute()
        val session=GatewayAudioMediaSession(endpoint,FakeCodec(),transport,
            LocalCallRecorder(root,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),mute,{true},monotonicUs={0},prebufferTimeoutMs=3_000)
        val started=startAsync(session);Thread.sleep(20);session.requestIngressStop()
        assertTrue(started.get(500,TimeUnit.MILLISECONDS).isFailure)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK,20,1,0,ByteArray(640)))
        assertFalse(endpoint.started);assertTrue(mute.acquireCount==0);assertFalse(mute.restored)
        assertTrue(transport.closeCount==1)
        root.deleteRecursively()
    }

    @Test fun directStopInterruptsPrebufferWaitBeforeSynchronizedTeardown() {
        val root=Files.createTempDirectory("media-prebuffer-stop").toFile();val mute=FakeMute()
        val session=GatewayAudioMediaSession(FakeEndpoint(),FakeCodec(),FakeTransport(),
            LocalCallRecorder(root,"dddddddd-dddd-4ddd-8ddd-dddddddddddd"),mute,{true},monotonicUs={0},prebufferTimeoutMs=3_000)
        val started=startAsync(session);val stopped=CompletableFuture.runAsync { session.stop("ended") }
        assertTrue(started.get(500,TimeUnit.MILLISECONDS).isFailure);stopped.get(500,TimeUnit.MILLISECONDS)
        assertTrue(mute.acquireCount==0);assertFalse(mute.restored)
        root.deleteRecursively()
    }

    @Test fun muteAcquisitionFailureRunsExactRestoreAndNeverStartsEndpoint() {
        val root=Files.createTempDirectory("media-mute-failure").toFile()
        val endpoint=FakeEndpoint();val mute=FakeMute(acquireResult=false)
        val session=GatewayAudioMediaSession(endpoint,FakeCodec(),FakeTransport(),
            LocalCallRecorder(root,"cccccccc-cccc-4ccc-8ccc-cccccccccccc"),mute,{true},monotonicUs={0})
        val started=startAsync(session);session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK,20,1,0,ByteArray(640)))
        assertTrue(started.get(1,TimeUnit.SECONDS).isFailure)
        assertTrue(mute.acquireCount==1);assertTrue(mute.restored);assertFalse(endpoint.started)
        root.deleteRecursively()
    }

    @Test fun fatalDecodeDuringPrebufferCompletesStartupFailureAndCleanupWithoutMute() {
        val root=Files.createTempDirectory("media-prebuffer-fatal").toFile();val failures=AtomicInteger()
        val endpoint=FakeEndpoint();val transport=FakeTransport();val mute=FakeMute()
        val session=GatewayAudioMediaSession(endpoint,ThrowingDecodeCodec(),transport,
            LocalCallRecorder(root,"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),mute,{true},{failures.incrementAndGet()},{0})
        val started=startAsync(session);session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK,20,1,0,byteArrayOf(1)))
        assertTrue(started.get(1,TimeUnit.SECONDS).isFailure)
        repeat(100){if(transport.closeCount==0)Thread.sleep(5)}
        assertTrue(failures.get()==1);assertTrue(transport.closeCount==1)
        assertFalse(endpoint.started);assertTrue(mute.acquireCount==0);assertFalse(mute.restored)
        root.deleteRecursively()
    }

    @Test fun concurrentStopWaitsForWinningPhysicalTeardownBeforeReportingSuccess() {
        val root=Files.createTempDirectory("media-stop-order").toFile();val endpoint=BlockingStopEndpoint()
        val session=GatewayAudioMediaSession(endpoint,FakeCodec(),FakeTransport(),
            LocalCallRecorder(root,"ffffffff-ffff-4fff-8fff-ffffffffffff"),FakeMute(),{true},monotonicUs={0})
        val started=startAsync(session);session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK,20,1,0,ByteArray(640)))
        assertTrue(started.get(1,TimeUnit.SECONDS).isSuccess)
        session.onTransportFailure("synthetic_failure");assertTrue(endpoint.stopEntered.await(1,TimeUnit.SECONDS))
        val follower=CompletableFuture.supplyAsync { session.stop("failed") };Thread.sleep(30)
        assertFalse(follower.isDone)
        endpoint.allowStop.countDown()
        assertTrue(follower.get(2,TimeUnit.SECONDS))
        root.deleteRecursively()
    }

    @Test fun transportStatsFailureStillFinalizesRecordingAndRestoresMuteButStopFailsClosed() {
        val root=Files.createTempDirectory("media-stats-failure").toFile();val mute=FakeMute()
        val session=GatewayAudioMediaSession(FakeEndpoint(),FakeCodec(),ThrowingStatsTransport(),
            LocalCallRecorder(root,"12121212-1212-4212-8212-121212121212"),mute,{true},monotonicUs={0})
        val started=startAsync(session);session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK,20,1,0,ByteArray(640)))
        assertTrue(started.get(1,TimeUnit.SECONDS).isSuccess)
        assertFalse(session.stop("failed"));assertTrue(mute.restored)
        assertTrue(root.resolve("12121212-1212-4212-8212-121212121212/manifest.json").exists())
        root.deleteRecursively()
    }

    @Test fun terminalBeforeStartCannotRestartEndpoint() {
        val root = Files.createTempDirectory("media-preterminal").toFile()
        val endpoint = FakeEndpoint(); val transport = FakeTransport()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), transport,
            LocalCallRecorder(root, "99999999-9999-4999-8999-999999999999"), FakeMute(), { true },
            monotonicUs = { 0 })
        session.requestIngressStop()
        assertTrue(session.start().isFailure)
        assertFalse(endpoint.started)
        assertTrue(endpoint.stopCount == 1)
        assertTrue(transport.closeCount == 1)
        root.deleteRecursively()
    }

    @Test fun schedulerBatchedCaptureUsesContinuousSampleTimelineWithoutFalseGaps() {
        val root = Files.createTempDirectory("media-capture-clock").toFile()
        val endpoint = FakeEndpoint()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "13131313-1313-4313-8313-131313131313"), FakeMute(), { true },
            monotonicUs = { 1_000_000 })
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640)))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        listOf(1_000_000L, 1_040_000L, 1_040_100L, 1_080_000L).forEach { callbackTime ->
            requireNotNull(endpoint.downlink)(ByteArray(640), callbackTime)
        }
        session.stop("ended")
        val timeline = root.resolve("13131313-1313-4313-8313-131313131313/timeline.jsonl").readLines()
        assertTrue(timeline.none { "\"event\":\"gap\",\"track\":\"remote_original\"" in it })
        assertTrue(timeline.filter { "\"track\":\"remote_original\"" in it && "\"event\":\"frame\"" in it }
            .map { org.json.JSONObject(it).getLong("timestampUs") } == listOf(0L, 20_000L, 40_000L, 60_000L))
        root.deleteRecursively()
    }

    @Test fun burstWithinBoundedMediaCushionDoesNotDropDecodedOrInjectedFrames() {
        val root = Files.createTempDirectory("media-burst-cushion").toFile()
        val endpoint = FakeEndpoint()
        val clock = AtomicLong(0)
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "14141414-1414-4414-8414-141414141414"), FakeMute(), { true },
            monotonicUs = clock::get)
        val started = startAsync(session)
        repeat(8) { index ->
            clock.set(index * 37_000L)
            session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, index.toLong(),
                index * 20_000L, ByteArray(640)))
        }
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        repeat(100) {
            if (session.stats().remotePacketDrops == 0L && endpoint.pull?.invoke() == null) Thread.sleep(5)
        }
        assertTrue(session.stats().remotePacketDrops == 0L)
        assertTrue(session.stats().injectionDrops == 0L)
        session.stop("ended")
        val timeline = root.resolve("14141414-1414-4414-8414-141414141414/timeline.jsonl").readText()
        assertFalse(timeline.contains("\"event\":\"gap\",\"track\":\"caller_original\""))
        root.deleteRecursively()
    }

    @Test fun sourcePtsHoleRemainsAnExplicitCallerRecordingGapDespiteArrivalJitterNormalization() {
        val root = Files.createTempDirectory("media-source-hole").toFile()
        val endpoint = FakeEndpoint()
        val clock = AtomicLong(0)
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "16161616-1616-4616-8616-161616161616"), FakeMute(), { true },
            monotonicUs = clock::get)
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640)))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        clock.set(21_000)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 2, 60_000, ByteArray(640)))
        Thread.sleep(30)
        session.stop("ended")
        val timeline = root.resolve("16161616-1616-4616-8616-161616161616/timeline.jsonl").readText()
        assertTrue(timeline.contains("\"event\":\"gap\",\"track\":\"caller_original\""))
        assertTrue(timeline.contains("\"durationUs\":40000"))
        root.deleteRecursively()
    }

    @Test fun telecomEndedUpgradesConcurrentTransportFailureBeforeManifestPublication() {
        val root = Files.createTempDirectory("media-terminal-upgrade").toFile()
        val endpoint = BlockingStopEndpoint()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(),
            LocalCallRecorder(root, "15151515-1515-4515-8515-151515151515"), FakeMute(), { true },
            monotonicUs = { 0 })
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640)))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        session.onTransportFailure("transport_disconnected")
        assertTrue(endpoint.stopEntered.await(1, TimeUnit.SECONDS))
        val ended = CompletableFuture.supplyAsync { session.stop("ended") }
        endpoint.allowStop.countDown()
        assertTrue(ended.get(2, TimeUnit.SECONDS))
        val manifest = root.resolve("15151515-1515-4515-8515-151515151515/manifest.json").readText()
        assertTrue(manifest.contains("\"terminalState\":\"ended\""))
        assertTrue(manifest.contains("\"mediaFatalEvents\":1"))
        assertTrue(manifest.contains("\"terminalUpgradedAfterFailure\":1"))
        assertTrue(manifest.contains("\"captureComplete\":false"))
        root.deleteRecursively()
    }

    @Test fun sendDropStatsSeparateEncodeQueuePressureFromTransportFailureAndKeepLegacyTotal() {
        val root = Files.createTempDirectory("media-send-drop-stats").toFile()
        val endpoint = FakeEndpoint()
        val codec = BlockingEncodeCodec()
        val transport = DroppingTransport()
        val session = GatewayAudioMediaSession(endpoint, codec, transport,
            LocalCallRecorder(root, "17171717-1717-4717-8717-171717171717"), FakeMute(), { true },
            monotonicUs = { 0 })
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640)))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)

        requireNotNull(endpoint.downlink)(ByteArray(640), 0)
        assertTrue(codec.encodeEntered.await(1, TimeUnit.SECONDS))
        repeat(13) { index -> requireNotNull(endpoint.downlink)(ByteArray(640), (index + 1L) * 20_000L) }
        codec.allowEncode.countDown()
        repeat(100) {
            if (transport.sendCount.get() < 13) Thread.sleep(5)
        }
        assertEquals(13, transport.sendCount.get())

        assertTrue(session.stop("ended"))
        val stats = session.stats()
        assertEquals(1L, stats.encodeQueueDrops)
        assertEquals(13L, stats.transportSendDrops)
        assertEquals(14L, stats.networkSendDrops)
        assertEquals(12L, stats.encodeQueueHighWatermark)
        assertTrue(stats.encodeMaxDurationUs > 0L)
        val manifest = root.resolve("17171717-1717-4717-8717-171717171717/manifest.json").readText()
        assertTrue(manifest.contains("\"networkSendDrops\":14"))
        assertTrue(manifest.contains("\"encodeQueueDrops\":1"))
        assertTrue(manifest.contains("\"transportSendDrops\":13"))
        assertTrue(manifest.contains("\"encodeQueueHighWatermark\":12"))
        root.deleteRecursively()
    }
}

/** S73 D3/D5: a lost leg rebuilds only the transport. */
class GatewayMediaRejoinSessionTest {
    private class Rejoiner(private val block: suspend (IceTransport) -> AudioSessionTransport) : MediaLegRejoiner {
        val calls = AtomicInteger(); val transports = java.util.concurrent.CopyOnWriteArrayList<IceTransport>()
        override suspend fun connect(transport: IceTransport, budgetMs: Long): AudioSessionTransport {
            calls.incrementAndGet(); transports += transport; return block(transport)
        }
    }
    private class CountingTransport : AudioSessionTransport {
        val sent = AtomicInteger(); @Volatile var closeCount = 0
        override val iceTransport = "tls"
        override fun send(packet: MediaPacket): MediaSendResult { sent.incrementAndGet(); return MediaSendResult.SENT }
        override fun close() { closeCount++ }
    }

    private fun started(root: java.io.File, callId: String, endpoint: FakeEndpoint, mute: FakeMute, first: AudioSessionTransport,
        failures: AtomicInteger, rejoiner: MediaLegRejoiner): GatewayAudioMediaSession {
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), first, LocalCallRecorder(root, callId), mute, { true },
            { failures.incrementAndGet() }, { 0 }, rejoiner = rejoiner)
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640)))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        return session
    }

    @Test fun lostLegIsRebuiltWhileEndpointMuteAndRecordingStay() {
        val root = Files.createTempDirectory("media-rejoin").toFile(); val callId = "73737373-7373-4737-8737-737373737373"
        val endpoint = FakeEndpoint(); val mute = FakeMute(); val first = FakeTransport(); val second = CountingTransport()
        val failures = AtomicInteger(); val rejoiner = Rejoiner { second }
        val session = started(root, callId, endpoint, mute, first, failures, rejoiner)
        session.onTransportFailure("transport_disconnected", "dc_closed")
        session.onTransportFailure("transport_disconnected", "pc_failed") // One rejoin at a time.
        repeat(100) { if (session.sessionEndDiagnostics()["rejoins"] != 1L) Thread.sleep(10) }
        assertEquals(1L, session.sessionEndDiagnostics()["rejoins"]); assertEquals(1, rejoiner.calls.get())
        assertEquals(1, first.closeCount); assertEquals(0, endpoint.stopCount); assertFalse(mute.restored)
        assertEquals(0, failures.get())
        // The gateway's outgoing audio now leaves on the new leg.
        requireNotNull(endpoint.downlink)(ByteArray(640), 0)
        repeat(100) { if (second.sent.get() == 0) Thread.sleep(5) }
        assertTrue(second.sent.get() > 0)
        assertTrue(session.stop("ended"))
        assertEquals(1, second.closeCount); assertTrue(mute.restored)
        assertTrue(root.resolve("$callId/manifest.json").readText().contains("\"terminalState\":\"ended\""))
        root.deleteRecursively()
    }

    private class RelayTransport(override val relayTurn: Boolean) : AudioSessionTransport {
        override val iceTransport = "udp"
        override fun send(packet: MediaPacket) = MediaSendResult.SENT
        override fun close() = Unit
    }

    @Test fun rejoinIsTlsOnlyExactlyWhenTheLostLegRanOnTheRelayTurn() {
        // S73b: a UDP leg never has relayTurn in production; it isolates the flag from the lost transport.
        for ((relayTurn, expected) in listOf(true to IceTransport.TLS, false to IceTransport.UDP)) {
            val root = Files.createTempDirectory("media-rejoin-relay").toFile(); val callId = "76767676-7676-4767-8767-767676767676"
            val rejoiner = Rejoiner { CountingTransport() }
            val session = started(root, callId, FakeEndpoint(), FakeMute(), RelayTransport(relayTurn), AtomicInteger(), rejoiner)
            session.onTransportFailure("transport_disconnected", "dc_closed")
            repeat(100) { if (session.sessionEndDiagnostics()["rejoins"] != 1L) Thread.sleep(10) }
            assertEquals(listOf(expected), rejoiner.transports.toList())
            assertTrue(session.stop("ended"))
            root.deleteRecursively()
        }
    }

    @Test fun hangupDuringRejoinCancelsItAndEndsCleanly() {
        val root = Files.createTempDirectory("media-rejoin-hangup").toFile(); val callId = "74747474-7474-4747-8747-747474747474"
        val failures = AtomicInteger(); val entered = CountDownLatch(1)
        val rejoiner = Rejoiner { entered.countDown(); kotlinx.coroutines.awaitCancellation() }
        val session = started(root, callId, FakeEndpoint(), FakeMute(), FakeTransport(), failures, rejoiner)
        session.onTransportFailure("transport_disconnected", "ice_disconnected")
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        assertTrue(session.stop("ended"))
        Thread.sleep(50)
        assertEquals(0, failures.get())
        assertTrue(root.resolve("$callId/manifest.json").readText().contains("\"terminalState\":\"ended\""))
        root.deleteRecursively()
    }

    @Test fun controlRefusalEndsInTodaysFailurePathOnce() {
        val root = Files.createTempDirectory("media-rejoin-refused").toFile(); val callId = "75757575-7575-4757-8757-757575757575"
        val failures = AtomicInteger(); val endpoint = FakeEndpoint()
        val rejoiner = Rejoiner { throw org.vodog.gateway.media.GatewayMediaHttpException(404, "CALL_NOT_FOUND", "gone") }
        started(root, callId, endpoint, FakeMute(), FakeTransport(), failures, rejoiner)
            .onTransportFailure("transport_disconnected", "dc_closed")
        repeat(100) { if (!root.resolve("$callId/manifest.json").exists()) Thread.sleep(10) }
        assertEquals(1, failures.get()); assertEquals(1, rejoiner.calls.get()); assertEquals(1, endpoint.stopCount)
        assertTrue(root.resolve("$callId/manifest.json").readText().contains("\"terminalState\":\"failed\""))
        root.deleteRecursively()
    }
}

class GatewayEarlyMediaSessionTest {
    @Test fun armFailsLikeANormalStartWhenTheMuteLeaseIsRefused() {
        val endpoint = FakeEndpoint(); val failures = AtomicInteger()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(), null, FakeMute(acquireResult = false),
            { true }, { failures.incrementAndGet() }, { 0 })
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640)))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        assertFalse(session.arm())
        assertEquals(0, endpoint.armCount); assertEquals(1, failures.get())
        session.stop("failed")
    }

    @Test fun earlyLegDiscardsCallerFramesAndSkipsWatchdogAndRecorderUntilArmed() {
        val root = Files.createTempDirectory("media-early").toFile()
        val callId = "56565656-5656-4565-8565-565656565656"
        val endpoint = FakeEndpoint(); val mute = FakeMute()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(), null, mute, { true },
            monotonicUs = { 0 }, diagCallId = callId)
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640) { 7 }))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess) // Prebuffer is fed by the ingress as today.
        assertEquals(0, mute.acquireCount) // Telecom mutes only ACTIVE calls; the lease waits for arm().
        repeat(20) { assertTrue(endpoint.pull?.invoke() == null); Thread.sleep(5) }
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 2, 20_000, ByteArray(640) { 8 }))
        Thread.sleep(50)
        repeat(10) { assertTrue(endpoint.pull?.invoke() == null) } // Polled and dropped, never backlogged.
        endpoint.downlink?.invoke(ByteArray(640) { 1 }, 0)
        assertEquals(0, endpoint.armCount)
        assertFalse(root.resolve(callId).exists())

        assertTrue(session.arm())
        assertEquals(1, endpoint.armCount); assertEquals(1, mute.acquireCount)
        assertTrue(session.attachRecorder { LocalCallRecorder(root, callId) })
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 3, 40_000, ByteArray(640) { 9 }))
        var injected: ByteArray? = null
        repeat(50) { if (injected == null) { injected = endpoint.pull?.invoke(); if (injected == null) Thread.sleep(10) } }
        assertTrue(injected?.all { it == 9.toByte() } == true)
        assertTrue(session.stop("ended"))
        assertTrue(root.resolve("$callId/manifest.json").exists())
        assertEquals(44L + 640L, root.resolve("$callId/caller_original.wav").length())
        assertFalse(session.attachRecorder { error("a stopped session must not open a recorder") })
        root.deleteRecursively()
    }

    @Test fun earlyLegHungUpBeforeActiveStopsCleanlyWithoutAnArchive() {
        val root = Files.createTempDirectory("media-early-hangup").toFile()
        val endpoint = FakeEndpoint(); val mute = FakeMute()
        val session = GatewayAudioMediaSession(endpoint, FakeCodec(), FakeTransport(), null, mute, { true },
            monotonicUs = { 0 })
        val started = startAsync(session)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640)))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        assertTrue(session.stop("ended"))
        assertTrue(endpoint.stopped); assertEquals(0, endpoint.armCount); assertEquals(0, mute.acquireCount)
        assertTrue(root.listFiles().orEmpty().isEmpty())
        root.deleteRecursively()
    }
}

/** S25 decision 1: the burst size the AI queues are sized for; it overflows the 12-deep human ones. */
private const val BURST_FRAMES = 40

private fun burstPacket(index: Int) =
    MediaPacket(MediaDirection.USER_UPLINK, 20, index.toLong(), index * 20_000L, ByteArray(640))

private fun startAsync(session:GatewayAudioMediaSession):CompletableFuture<Result<Unit>> {
    val future=CompletableFuture.supplyAsync { session.start() }
    Thread.sleep(20) // Let start enter its bounded prebuffer wait before delivering the test packet.
    return future
}

private class FakeEndpoint : TelephonyAudioEndpoint {
    override val capability = TelephonyAudioEndpoint.Capability.Ready
    var pull: (() -> ByteArray?)? = null; var downlink: ((ByteArray, Long) -> Unit)? = null
    var started = false; var stopped = false; var stopCount = 0
    override fun start(onDownlinkPcm: (ByteArray, Long) -> Unit, nextUplinkPcm: () -> ByteArray?,
        onFailure: (TelephonyAudioEndpoint.Failure) -> Unit): Result<Unit> {
        started = true; pull = nextUplinkPcm; downlink = onDownlinkPcm; return Result.success(Unit)
    }
    override fun stopAndRelease() { stopped = true; stopCount++ }
    var armCount = 0
    override fun arm() { armCount++ }
}
private class FakeCodec : AudioSessionCodec {
    var closed=false
    override fun encode(pcm: ByteArray, timestampUs: Long) = listOf(EncodedOpusFrame(byteArrayOf(0x78), timestampUs))
    override fun decode(packet: MediaPacket) = listOf(packet.opus to packet.timestampUs)
    override fun finishEncode(timestampUs: Long) = emptyList<EncodedOpusFrame>()
    override fun finishDecode(timestampUs: Long) = emptyList<Pair<ByteArray, Long>>()
    override fun close() { closed=true }
}
private class BlockingEncodeCodec : AudioSessionCodec {
    val encodeEntered = CountDownLatch(1)
    val allowEncode = CountDownLatch(1)
    override fun encode(pcm: ByteArray, timestampUs: Long): List<EncodedOpusFrame> {
        encodeEntered.countDown()
        check(allowEncode.await(1, TimeUnit.SECONDS))
        return listOf(EncodedOpusFrame(byteArrayOf(0x78), timestampUs))
    }
    override fun decode(packet: MediaPacket) = listOf(packet.opus to packet.timestampUs)
    override fun finishEncode(timestampUs: Long) = emptyList<EncodedOpusFrame>()
    override fun finishDecode(timestampUs: Long) = emptyList<Pair<ByteArray, Long>>()
    override fun close() = Unit
}
private class TailCodec : AudioSessionCodec {
    override fun encode(pcm: ByteArray, timestampUs: Long) = emptyList<EncodedOpusFrame>()
    override fun decode(packet: MediaPacket) = listOf(ByteArray(638) { 3 } to packet.timestampUs)
    override fun finishEncode(timestampUs: Long) = emptyList<EncodedOpusFrame>()
    override fun finishDecode(timestampUs: Long) = listOf(ByteArray(2) { 3 } to 77_000L)
    override fun close() = Unit
}
private class ThrowingDecodeCodec : AudioSessionCodec {
    override fun encode(pcm:ByteArray,timestampUs:Long)=emptyList<EncodedOpusFrame>()
    override fun decode(packet:MediaPacket):List<Pair<ByteArray,Long>> = error("synthetic decode failure")
    override fun finishEncode(timestampUs:Long)=emptyList<EncodedOpusFrame>()
    override fun finishDecode(timestampUs:Long)=emptyList<Pair<ByteArray,Long>>()
    override fun close()=Unit
}
private class FakeTransport : AudioSessionTransport {
    var closeCount = 0
    override fun send(packet: MediaPacket) = MediaSendResult.SENT
    override fun close() { closeCount++ }
}
private class DroppingTransport : AudioSessionTransport {
    val sendCount = AtomicInteger()
    override fun send(packet: MediaPacket): MediaSendResult {
        sendCount.incrementAndGet()
        return MediaSendResult.BACKPRESSURE
    }
    override fun close() = Unit
}
private class ThrowingStatsTransport : AudioSessionTransport {
    override fun send(packet:MediaPacket)=MediaSendResult.SENT
    override fun networkStats():Map<String,Long> = error("synthetic stats failure")
    override fun close()=Unit
}
private class FakeMute(private val acquireResult:Boolean=true) : GatewayMuteLease {
    var restored = false;var acquireCount=0
    override fun acquireAndMute():Boolean { acquireCount++;return acquireResult }
    override fun restoreOriginalState(): Boolean { restored = true; return true }
}
private class BlockingStopEndpoint : TelephonyAudioEndpoint {
    override val capability=TelephonyAudioEndpoint.Capability.Ready
    val stopEntered=CountDownLatch(1);val allowStop=CountDownLatch(1)
    override fun start(onDownlinkPcm:(ByteArray,Long)->Unit,nextUplinkPcm:()->ByteArray?,
        onFailure:(TelephonyAudioEndpoint.Failure)->Unit)=Result.success(Unit)
    override fun stopAndRelease(){stopEntered.countDown();allowStop.await(1,TimeUnit.SECONDS)}
}
