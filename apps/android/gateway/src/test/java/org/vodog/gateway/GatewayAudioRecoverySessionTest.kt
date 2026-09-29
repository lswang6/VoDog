package org.vodog.gateway

import org.vodog.gateway.media.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class GatewayAudioRecoverySessionTest {
    private fun packet(index: Long) =
        MediaPacket(MediaDirection.USER_UPLINK, 20, index, index * 20_000, ByteArray(640) { (index + 1).toByte() })

    /** S70: the AudioTrack pulls; FEC/PLC only reach caller_playout, originals never wait on injection. */
    @Test fun playbackPullsConcealmentIntoDerivedTrackOnlyAndOriginalsStayComplete() {
        val root = Files.createTempDirectory("receive-recovery").toFile()
        val id = "18181818-1818-4818-8818-181818181818"
        val clock = AtomicLong()
        val codec = RecoveryFakeCodec(); val endpoint = RecoveryFakeEndpoint(); val mute = RecoveryFakeMute()
        val session = GatewayAudioMediaSession(endpoint, codec, object : AudioSessionTransport {
            override fun send(packet: MediaPacket) = MediaSendResult.SENT
            override fun close() = Unit
        }, LocalCallRecorder(root, id), mute, { true }, monotonicUs = clock::get)
        try {
            val future = CompletableFuture.supplyAsync { session.start() }
            Thread.sleep(20)
            (0L..2L).forEach { session.onRemotePacket(packet(it)) } // T = 60 ms primes at once
            assertTrue(future.get(1, TimeUnit.SECONDS).isSuccess)
            listOf(3L, 5L, 6L).forEach { session.onRemotePacket(packet(it)) } // slot 4 lost
            val played = (0 until 12).mapNotNull { endpoint.pull?.invoke() }
            assertEquals(12, played.size) // one frame per tick, never null while running
            assertTrue(played.any { frame -> frame.all { it == 9.toByte() } }) // FEC frame reached the track
            assertTrue(session.stop("ended"))
            assertTrue(codec.closed); assertTrue(mute.restored); assertTrue(endpoint.stopped)
            val source = root.resolve("$id/caller_original.wav").readBytes().drop(44)
            assertEquals(6 * 640, source.size)
            assertFalse("synthetic bytes must never enter original WAV", source.any { it == 9.toByte() })
            val derived = root.resolve("$id/caller_playout.wav").readBytes().drop(44)
            assertTrue(derived.any { it == 9.toByte() })
            val timeline = root.resolve("$id/timeline.jsonl").readText()
            assertTrue(timeline.contains("\"recoveryKind\":\"fec_attempt\""))
            assertTrue(timeline.contains("\"event\":\"playout_frame\""))
            val diag = session.sessionEndDiagnostics()
            assertEquals(6L, diag["rxPackets"]); assertEquals(0L, diag["callerRecordDrops"])
            assertEquals(60L, diag["playoutTargetMs"]); assertEquals(1L, diag["fecRecoveredFrames"])
        } finally { session.stop("ended"); root.deleteRecursively() }
    }

    @Test fun orderlyStopDrainsBufferedOriginalsWithoutInjectingTail() {
        val root = Files.createTempDirectory("receive-recovery-tail").toFile()
        val id = "19191919-1919-4919-8919-191919191919"
        val endpoint = RecoveryFakeEndpoint()
        val session = GatewayAudioMediaSession(endpoint, RecoveryFakeCodec(), object : AudioSessionTransport {
            override fun send(packet: MediaPacket) = MediaSendResult.SENT
            override fun close() = Unit
        }, LocalCallRecorder(root, id), RecoveryFakeMute(), { true }, monotonicUs = { 0 })
        try {
            val future = CompletableFuture.supplyAsync { session.start() }
            Thread.sleep(20)
            (0L..4L).forEach { session.onRemotePacket(packet(it)) }
            assertTrue(future.get(1, TimeUnit.SECONDS).isSuccess)
            assertTrue(session.stop("ended"))
            assertEquals(5 * 640, root.resolve("$id/caller_original.wav").readBytes().size - 44)
            assertFalse(root.resolve("$id/caller_playout.wav").exists() &&
                root.resolve("$id/caller_playout.wav").length() > 44L)
        } finally { session.stop("ended"); root.deleteRecursively() }
    }
}
private class RecoveryFakeCodec : AudioSessionCodec {
    override val receiveRecoveryEnabled = true
    var closed = false
    override fun encode(pcm: ByteArray, timestampUs: Long) = emptyList<EncodedOpusFrame>()
    override fun decode(packet: MediaPacket) = listOf(packet.opus to packet.timestampUs)
    override fun conceal(next: MediaPacket?, timestampUs: Long, durationMs: Int) =
        RecoveredAudio(ByteArray(durationMs * 32) { 9 }, timestampUs, if (next == null) "plc" else "fec_attempt")
    override fun finishEncode(timestampUs: Long) = emptyList<EncodedOpusFrame>()
    override fun finishDecode(timestampUs: Long) = emptyList<Pair<ByteArray, Long>>()
    override fun close() { closed = true }
}
private class RecoveryFakeEndpoint : TelephonyAudioEndpoint {
    override val capability = TelephonyAudioEndpoint.Capability.Ready
    @Volatile var started = false
    @Volatile var pull: (() -> ByteArray?)? = null
    var stopped = false
    override fun start(onDownlinkPcm: (ByteArray, Long) -> Unit, nextUplinkPcm: () -> ByteArray?, onFailure: (TelephonyAudioEndpoint.Failure) -> Unit): Result<Unit> {
        pull = nextUplinkPcm; started = true; return Result.success(Unit)
    }
    override fun stopAndRelease() { stopped = true }
}
private class RecoveryFakeMute : GatewayMuteLease {
    var restored = false
    override fun acquireAndMute() = true
    override fun restoreOriginalState(): Boolean { restored = true; return true }
}
