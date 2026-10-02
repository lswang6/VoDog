package org.vodog.gateway

import org.vodog.gateway.media.EncodedOpusFrame
import org.vodog.gateway.media.IceTransport
import org.vodog.gateway.media.MediaDirection
import org.vodog.gateway.media.MediaPacket
import org.vodog.gateway.media.MediaSendResult
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** S94: owner-local takeover of an AI call and the bridged-session `caller_uplink` track. */
class GatewayOwnerLocalUplinkTest {
    private val lease = MuteLeaseRecord(MuteLeasePhase.MUTED, "lease", "device", 123L, false)

    @Test fun ownerJoinFiresOnlyOnUnmuteOfTheExactMutedArmedActiveCall() {
        assertTrue(isOwnerLocalJoin(lease, false, "device", 123L, holderArmed = true, callActive = true))
        assertFalse(isOwnerLocalJoin(lease, true, "device", 123L, true, true))
        // The gateway's own setMuted phases never qualify.
        assertFalse(isOwnerLocalJoin(lease.copy(phase = MuteLeasePhase.REQUESTING_MUTE), false, "device", 123L, true, true))
        assertFalse(isOwnerLocalJoin(lease.copy(phase = MuteLeasePhase.RESTORING), false, "device", 123L, true, true))
        assertFalse(isOwnerLocalJoin(lease.copy(phase = MuteLeasePhase.IDLE), false, "device", 123L, true, true))
        // Wrong call identity, unarmed early leg, or a call that is not ACTIVE.
        assertFalse(isOwnerLocalJoin(lease, false, "other", 123L, true, true))
        assertFalse(isOwnerLocalJoin(lease, false, "device", 124L, true, true))
        assertFalse(isOwnerLocalJoin(lease, false, "device", 123L, holderArmed = false, callActive = true))
        assertFalse(isOwnerLocalJoin(lease, false, "device", 123L, holderArmed = true, callActive = false))
        // Answering a call-waiting call makes Telecom unmute: never a takeover while another call is live.
        assertFalse(isOwnerLocalJoin(lease, false, "device", 123L, true, true, otherLiveCall = true))
    }

    @Test fun ownerJoinedCallIsNeverHungUpAfterMediaFailure() {
        val record = DeviceCallRecord(
            deviceCallId = "device", phoneAccountHandle = null, creationTimeMillis = 123,
            direction = DeviceCallDirection.INCOMING, state = DeviceCallState.ACTIVE,
            observedAt = "2026-10-01T00:00:00Z", remoteNumber = null, incomingEventId = null,
            incomingPayload = null, incomingReported = true, serverCallId = "server", answeredByAi = true,
            remoteAnswered = true,
        )
        assertTrue(shouldHangUpAfterMediaFailure(record, armed = true, ActualTelecomState.ACTIVE))
        assertFalse(shouldHangUpAfterMediaFailure(record.copy(ownerJoined = true), armed = true, ActualTelecomState.ACTIVE))
        // Durable: survives the journal round trip; older rows decode as not joined.
        assertTrue(record.copy(ownerJoined = true).toJson().toRecord().ownerJoined)
        assertFalse(record.toJson().apply { remove("ownerJoined") }.toRecord().ownerJoined)
    }

    @Test fun ownerJoinedReportSettlesOn2xxAnd409AndRetries5xxAndNetwork() = runBlocking {
        assertEquals("ok", ownerJoinedOutcome { })
        assertEquals("conflict:CALL_NOT_ACTIVE", ownerJoinedOutcome { throw GatewayApiHttpError(409, "CALL_NOT_ACTIVE", "x") })
        assertEquals("conflict:EVENT_ID_REUSED", ownerJoinedOutcome { throw GatewayApiHttpError(409, "EVENT_ID_REUSED", "x") })
        assertNull(ownerJoinedOutcome { throw GatewayApiHttpError(503, null, "x") })
        assertNull(ownerJoinedOutcome { throw GatewayApiHttpError(503, "CALL_STATE_PENDING", "x") })
        assertNull(ownerJoinedOutcome { throw java.io.IOException("offline") })
        assertEquals("rejected:400", ownerJoinedOutcome { throw GatewayApiHttpError(400, null, "x") })
        assertEquals("rejected:404", ownerJoinedOutcome { throw GatewayApiHttpError(404, "NOT_FOUND", "x") })
        assertEquals("conflict:FENCE_REJECTED", ownerJoinedOutcome { throw GatewayApiHttpError(409, "FENCE_REJECTED", "x") })
        assertEquals("stopped:IllegalStateException", ownerJoinedOutcome { error("gateway disabled") })
        assertEquals("/gateway/calls/c/owner-joined", GatewayApiRoutes.ownerJoined("c"))
        assertTrue(GatewayApiRoutes.isIdempotent(GatewayApiRoutes.ownerJoined("c")))
    }

    @Test fun ownerLocalStopsInjectionClosesTransportOnceAndTransportLossIsNotFatal() {
        val root = Files.createTempDirectory("owner-local").toFile(); val callId = "94000000-0000-4000-8000-000000000001"
        val endpoint = Endpoint(); val transport = ClosingTransport(); val failures = AtomicInteger()
        val rejoins = AtomicInteger()
        val rejoiner = object : MediaLegRejoiner {
            override suspend fun connect(transport: IceTransport, budgetMs: Long): AudioSessionTransport {
                rejoins.incrementAndGet(); return ClosingTransport()
            }
        }
        val session = GatewayAudioMediaSession(endpoint, Codec(), transport, LocalCallRecorder(root, callId), Mute(), { true },
            { failures.incrementAndGet() }, { 0 }, rejoiner = rejoiner)
        val started = CompletableFuture.supplyAsync { session.start() }
        Thread.sleep(20)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640) { 7 }))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)

        session.markOwnerLocal()
        assertTrue(session.isOwnerLocal)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 2, 20_000, ByteArray(640) { 8 }))
        assertNull(requireNotNull(endpoint.pull)())
        assertTrue(session.enterOwnerLocal(CompletableFuture.completedFuture(Unit)))
        assertFalse(session.enterOwnerLocal(CompletableFuture.completedFuture(Unit))) // Idempotent.
        assertEquals(1, transport.closeCount)
        session.onTransportFailure("transport_disconnected", "dc_closed")
        session.onTransportFailure("transport_protocol_error")
        Thread.sleep(50)
        assertEquals(0, rejoins.get()); assertEquals(0, failures.get())
        // Cellular downlink keeps being recorded; nothing is sent and nothing counts as a send drop.
        requireNotNull(endpoint.downlink)(ByteArray(640) { 1 }, 0)
        Thread.sleep(50)
        assertEquals(0, transport.sent.get())

        assertTrue(session.stop("ended"))
        assertEquals(0L, session.stats().transportSendDrops)
        val manifest = JSONObject(File(root, "$callId/manifest.json").readText())
        assertEquals("ended", manifest.getString("terminalState"))
        assertEquals(0L, manifest.getJSONObject("sessionStats").getLong("mediaFatalEvents"))
        assertEquals(3L, manifest.getJSONObject("sessionStats").getLong("transportReceivedPackets")) // Snapshot stats.
        assertTrue(manifest.getJSONObject("tracks").getJSONObject("remote_original").getLong("pcmBytes") >= 640)
        root.deleteRecursively()
    }

    @Test fun silencedUplinkIsRecordedAsV4WithGapsAndOnlyTheUplinkIncomplete() {
        val root = Files.createTempDirectory("uplink-silenced").toFile(); val callId = "94000000-0000-4000-8000-000000000002"
        val endpoint = Endpoint(); val uplink = Uplink(silenced = true, sample = 1)
        val session = GatewayAudioMediaSession(endpoint, Codec(), PlainTransport(), LocalCallRecorder(root, callId), Mute(),
            { true }, monotonicUs = { 0 }, uplinkSource = { uplink })
        val started = CompletableFuture.supplyAsync { session.start() }
        Thread.sleep(20)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640) { 7 }))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        repeat(5) { requireNotNull(endpoint.downlink)(ByteArray(640) { 1 }, it * 20_000L) }
        repeat(100) { if (uplink.reads.get() < 5) Thread.sleep(10) }
        assertTrue(session.stop("ended"))
        assertTrue(uplink.closed); assertTrue(uplink.reportedFinal)

        val manifest = JSONObject(File(root, "$callId/manifest.json").readText())
        assertEquals(4, manifest.getInt("version"))
        val track = manifest.getJSONObject("uplinkTracks").getJSONObject("caller_uplink")
        assertEquals("caller_uplink.wav", track.getString("file"))
        assertTrue(track.getLong("pcmBytes") >= 640 * 5)
        assertTrue(track.getLong("gapCount") > 0)
        assertFalse(track.getBoolean("captureComplete"))
        assertTrue(manifest.getJSONObject("tracks").getJSONObject("remote_original").getBoolean("captureComplete"))
        assertEquals(0L, manifest.getJSONObject("sessionStats").getLong("mediaFatalEvents"))
        assertTrue(File(root, "$callId/timeline.jsonl").readText().contains("\"track\":\"caller_uplink\""))
        root.deleteRecursively()
    }

    @Test fun uplinkFailureNeverFailsTheSessionAndTheManifestFallsBackFromV4() {
        listOf<() -> UplinkPcmSource?>({ error("AudioRecord source 7 unavailable") }, { null },
            { Uplink(silenced = false, failStart = true) }).forEachIndexed { index, factory ->
            val root = Files.createTempDirectory("uplink-failed").toFile(); val callId = "94000000-0000-4000-8000-00000000001$index"
            val endpoint = Endpoint(); val failures = AtomicInteger()
            val session = GatewayAudioMediaSession(endpoint, Codec(), PlainTransport(), LocalCallRecorder(root, callId), Mute(),
                { true }, { failures.incrementAndGet() }, { 0 }, uplinkSource = factory)
            val started = CompletableFuture.supplyAsync { session.start() }
            Thread.sleep(20)
            session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640) { 7 }))
            assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
            requireNotNull(endpoint.downlink)(ByteArray(640) { 1 }, 0)
            Thread.sleep(50)
            assertTrue(session.stop("ended"))
            assertEquals(0, failures.get())
            val manifest = JSONObject(File(root, "$callId/manifest.json").readText())
            assertTrue(manifest.getInt("version") < 4); assertFalse(manifest.has("uplinkTracks"))
            assertFalse(File(root, "$callId/caller_uplink.wav").exists())
            root.deleteRecursively()
        }
    }

    @Test fun allZeroUplinkIsDroppedSoTheArchiveFallsBackFromV4() {
        val root = Files.createTempDirectory("uplink-zero").toFile(); val callId = "94000000-0000-4000-8000-000000000008"
        val endpoint = Endpoint(); val uplink = Uplink(silenced = false, sample = 0)
        val session = GatewayAudioMediaSession(endpoint, Codec(), PlainTransport(), LocalCallRecorder(root, callId), Mute(),
            { true }, monotonicUs = { 0 }, uplinkSource = { uplink })
        val started = CompletableFuture.supplyAsync { session.start() }
        Thread.sleep(20)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640) { 7 }))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        repeat(100) { if (uplink.reads.get() < 5) Thread.sleep(10) }
        assertTrue(session.stop("ended"))
        val manifest = JSONObject(File(root, "$callId/manifest.json").readText())
        assertTrue(manifest.getInt("version") < 4); assertFalse(manifest.has("uplinkTracks"))
        assertFalse(File(root, "$callId/timeline.jsonl").readText().contains("caller_uplink"))
        assertFalse(File(root, "$callId/caller_uplink.wav").exists())
        root.deleteRecursively()
    }

    @Test fun teardownUnblocksAnUplinkReadThatWouldBlockForever() {
        val root = Files.createTempDirectory("uplink-blocked").toFile(); val callId = "94000000-0000-4000-8000-000000000009"
        val uplink = object : UplinkPcmSource {
            val unblocked = java.util.concurrent.CountDownLatch(1); val entered = java.util.concurrent.CountDownLatch(1)
            override fun start() = Unit
            override fun read(buffer: ByteArray): Int { entered.countDown(); unblocked.await(); return 0 }
            override fun unblock() = unblocked.countDown()
            override fun close() = Unit
        }
        val session = GatewayAudioMediaSession(Endpoint(), Codec(), PlainTransport(), LocalCallRecorder(root, callId), Mute(),
            { true }, monotonicUs = { 0 }, uplinkSource = { uplink })
        val started = CompletableFuture.supplyAsync { session.start() }
        Thread.sleep(20)
        session.onRemotePacket(MediaPacket(MediaDirection.USER_UPLINK, 20, 1, 0, ByteArray(640) { 7 }))
        assertTrue(started.get(1, TimeUnit.SECONDS).isSuccess)
        assertTrue(uplink.entered.await(1, TimeUnit.SECONDS))
        assertTrue(session.stop("ended")) // Would be worker_stop_timeout without unblock().
        assertEquals(0L, uplink.unblocked.count)
        root.deleteRecursively()
    }

    @Test fun recorderUplinkIsLazyMarkersBeforePcmAreNoOpsAndAbortLeavesNoPart() {
        val root = Files.createTempDirectory("uplink-recorder").toFile(); val callId = "94000000-0000-4000-8000-000000000003"
        val recorder = LocalCallRecorder(root, callId)
        recorder.markDropped(UplinkAudioTrack.CALLER_UPLINK, 0, 2)
        recorder.markCaptureIncomplete(UplinkAudioTrack.CALLER_UPLINK)
        assertFalse(File(root, "$callId/caller_uplink.wav.part").exists())
        recorder.abortUplink() // Nothing written: no-op.
        assertFalse(File(root, "$callId/caller_uplink.wav.part").exists())
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
        val manifest = recorder.finish("ended")
        assertTrue(manifest.uplinkTracks.isEmpty())
        assertFalse(File(root, "$callId/manifest.json").readText().contains("uplinkTracks"))

        // Frame rows already exist: the track goes whole and its rows leave the timeline.
        val written = "94000000-0000-4000-8000-000000000007"
        val second = LocalCallRecorder(root, written)
        second.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        second.appendUplink(ByteArray(640) { 3 }, 0, 55)
        second.markCaptureGapDuration(UplinkAudioTrack.CALLER_UPLINK, 0, 20_000)
        second.abortUplink()
        second.appendUplink(ByteArray(640) { 3 }, 20_000) // Ignored after the drop.
        assertTrue(second.finish("ended").uplinkTracks.isEmpty())
        val timeline = File(root, "$written/timeline.jsonl").readText()
        assertFalse(timeline.contains("caller_uplink")); assertTrue(timeline.contains("\"track\":\"remote_original\""))
        assertTrue(timeline.endsWith("{\"event\":\"stop\",\"state\":\"ended\"}\n"))
        assertFalse(File(root, "$written/caller_uplink.wav").exists())
        assertFalse(File(root, "$written/caller_uplink.wav.part").exists())
        assertFalse(File(root, "$written/timeline.jsonl.part.filtered").exists())
        root.deleteRecursively()
    }

    @Test fun recorderWritesV4ManifestAndCrashRecoveryRestoresTheUplinkPart() {
        val root = Files.createTempDirectory("uplink-v4").toFile(); val callId = "94000000-0000-4000-8000-000000000004"
        LocalCallRecorder(root, callId).apply {
            append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
            appendUplink(ByteArray(640) { 2 }, 0, 99)
            appendUplink(ByteArray(640) { 2 }, 20_000)
            markDropped(UplinkAudioTrack.CALLER_UPLINK, 40_000, 1)
        }.finish("ended")
        val json = JSONObject(File(root, "$callId/manifest.json").readText())
        assertEquals(4, json.getInt("version"))
        val track = json.getJSONObject("uplinkTracks").getJSONObject("caller_uplink")
        assertEquals(setOf("file", "bytes", "sha256", "pcmBytes", "gapCount", "droppedFrames", "captureComplete"), track.keys().asSequence().toSet())
        assertEquals(1280L, track.getLong("pcmBytes")); assertEquals(1324L, track.getLong("bytes"))
        assertEquals(1L, track.getLong("droppedFrames")); assertFalse(track.getBoolean("captureComplete"))
        assertTrue(File(root, "$callId/timeline.jsonl").readText()
            .contains("{\"event\":\"frame\",\"track\":\"caller_uplink\",\"timestampUs\":0,\"sourceTimestampUs\":99,"))

        // Crash mid-call: the part files survive without a manifest.
        val crashed = "94000000-0000-4000-8000-000000000005"
        LocalCallRecorder(root, crashed).apply {
            append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
            appendUplink(ByteArray(640) { 2 }, 0)
        } // Never finished.
        val recovered = LocalCallRecorder.recoverIncomplete(root).single { it.callId == crashed }
        assertEquals("recovered_incomplete", recovered.terminalState)
        val uplink = requireNotNull(recovered.uplinkTracks[UplinkAudioTrack.CALLER_UPLINK])
        assertEquals(640L, uplink.pcmBytes); assertFalse(uplink.captureComplete)
        assertTrue(File(root, "$crashed/caller_uplink.wav").exists())
        assertFalse(File(root, "$crashed/caller_uplink.wav.part").exists())
        assertEquals(4, JSONObject(File(root, "$crashed/manifest.json").readText()).getInt("version"))
        root.deleteRecursively()
    }

    @Test fun headerOnlyUplinkPartIsDroppedOnRecovery() {
        val root = Files.createTempDirectory("uplink-header-only").toFile(); val callId = "94000000-0000-4000-8000-000000000006"
        LocalCallRecorder(root, callId).append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
        File(root, "$callId/caller_uplink.wav.part").writeBytes(ByteArray(44))
        val recovered = LocalCallRecorder.recoverIncomplete(root).single()
        assertTrue(recovered.uplinkTracks.isEmpty())
        assertFalse(File(root, "$callId/caller_uplink.wav.part").exists())
        assertFalse(JSONObject(File(root, "$callId/manifest.json").readText()).has("uplinkTracks"))
        root.deleteRecursively()
    }

    private class Endpoint : TelephonyAudioEndpoint {
        override val capability = TelephonyAudioEndpoint.Capability.Ready
        @Volatile var pull: (() -> ByteArray?)? = null
        @Volatile var downlink: ((ByteArray, Long) -> Unit)? = null
        override fun start(onDownlinkPcm: (ByteArray, Long) -> Unit, nextUplinkPcm: () -> ByteArray?,
            onFailure: (TelephonyAudioEndpoint.Failure) -> Unit): Result<Unit> {
            pull = nextUplinkPcm; downlink = onDownlinkPcm; return Result.success(Unit)
        }
        override fun stopAndRelease() = Unit
    }

    private class Codec : AudioSessionCodec {
        override fun encode(pcm: ByteArray, timestampUs: Long) = listOf(EncodedOpusFrame(byteArrayOf(0x78), timestampUs))
        override fun decode(packet: MediaPacket) = listOf(packet.opus to packet.timestampUs)
        override fun finishEncode(timestampUs: Long) = emptyList<EncodedOpusFrame>()
        override fun finishDecode(timestampUs: Long) = emptyList<Pair<ByteArray, Long>>()
        override fun close() = Unit
    }

    /** Stats fail once closed, so a passing teardown proves the owner-local snapshot was used. */
    private class ClosingTransport : AudioSessionTransport {
        val sent = AtomicInteger(); @Volatile var closeCount = 0
        override fun send(packet: MediaPacket): MediaSendResult { sent.incrementAndGet(); return MediaSendResult.SENT }
        override fun networkStats(): Map<String, Long> {
            check(closeCount == 0) { "closed" }
            return mapOf("transportReceivedPackets" to 3L)
        }
        override fun close() { closeCount++ }
    }

    private class PlainTransport : AudioSessionTransport {
        override fun send(packet: MediaPacket) = MediaSendResult.SENT
        override fun close() = Unit
    }

    private class Mute : GatewayMuteLease {
        override fun acquireAndMute() = true
        override fun restoreOriginalState() = true
    }

    private class Uplink(override val silenced: Boolean, private val failStart: Boolean = false,
        private val sample: Byte = 1) : UplinkPcmSource {
        val reads = AtomicInteger(); @Volatile var closed = false; @Volatile var reportedFinal = false
        override val incomplete: Boolean get() = silenced
        override fun start() { check(!failStart) { "VOICE_UPLINK did not start" } }
        override fun read(buffer: ByteArray): Int {
            Thread.sleep(5); reads.incrementAndGet(); buffer.fill(sample); return buffer.size
        }
        override fun report(final: Boolean, terminalState: String) { if (final) reportedFinal = true }
        override fun close() { closed = true }
    }
}
