package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.time.Instant

class LocalCallRecorderTest {
    @Test fun passiveLossPreservesBytesButOnlyInvalidatesAffectedTrack() {
        val root = Files.createTempDirectory("passive-loss").toFile()
        try {
            val id = "66666666-6666-4666-8666-666666666666"
            val recorder = LocalCallRecorder(root, id)
            OriginalAudioTrack.entries.forEach { recorder.append(it, ByteArray(640), 0) }
            recorder.markCaptureGapDuration(OriginalAudioTrack.CALLER_ORIGINAL, 10_000, 10_000)
            val result = recorder.finish("ended")
            assertFalse(result.tracks.getValue(OriginalAudioTrack.CALLER_ORIGINAL).captureComplete)
            assertTrue(result.tracks.getValue(OriginalAudioTrack.REMOTE_ORIGINAL).captureComplete)
            assertEquals(640L, result.tracks.getValue(OriginalAudioTrack.CALLER_ORIGINAL).pcmBytes)
            val gap = File(root, "$id/timeline.jsonl").readLines().single { it.contains("\"event\":\"gap\"") }
            assertTrue(gap.contains("\"durationUs\":10000"))
            assertFalse(gap.contains("\"reason\""))
        } finally { root.deleteRecursively() }
    }

    @Test fun platformSilencingInvalidatesCaptureWithoutInventingGapDuration() {
        val root = Files.createTempDirectory("passive-silenced").toFile()
        try {
            val id = "77777777-7777-4777-8777-777777777777"
            val recorder = LocalCallRecorder(root, id)
            OriginalAudioTrack.entries.forEach { recorder.append(it, ByteArray(640), 0) }
            val health = PassiveCaptureHealth()
            health.observe(null)
            health.read()
            health.observe(true)
            health.observe(null)
            if (health.incomplete) recorder.markCaptureIncomplete(OriginalAudioTrack.CALLER_ORIGINAL)
            val result = recorder.finish("ended")
            assertFalse(result.tracks.getValue(OriginalAudioTrack.CALLER_ORIGINAL).captureComplete)
            assertEquals(0L, result.tracks.getValue(OriginalAudioTrack.CALLER_ORIGINAL).gapCount)
            assertTrue(result.tracks.getValue(OriginalAudioTrack.REMOTE_ORIGINAL).captureComplete)
        } finally { root.deleteRecursively() }
    }

    @Test fun finalizesTwoDirectionalWavsManifestAndHashes() {
        val root = Files.createTempDirectory("call-recorder").toFile()
        val callId = "11111111-1111-4111-8111-111111111111"
        val recorder = LocalCallRecorder(root, callId) { Instant.parse("2026-09-09T01:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        val manifest = recorder.finish("ended", mapOf("networkSendDrops" to 9))
        OriginalAudioTrack.entries.forEach { track ->
            val result = requireNotNull(manifest.tracks[track]); val file = File(root, "$callId/${track.fileStem}.wav")
            assertEquals(684, file.length()); assertEquals(hash(file), result.sha256); assertTrue(result.captureComplete)
            assertEquals("RIFF", file.readBytes().copyOfRange(0, 4).toString(Charsets.US_ASCII))
        }
        val manifestJson = File(root, "$callId/manifest.json").readText()
        assertTrue(manifestJson.contains("\"version\":1"))
        assertTrue(manifestJson.contains("\"terminalState\":\"ended\""))
        assertFalse(manifestJson.contains("derivedTracks"))
        assertFalse(File(root, "$callId/caller_playout.wav").exists())
        assertTrue(manifest.tracks.values.all(TrackRecordingResult::captureComplete))
        assertTrue(manifestJson.contains("\"networkSendDrops\":9"))
        root.deleteRecursively()
    }

    @Test fun timestampGapAndQueueDropPreventCompleteness() {
        val root = Files.createTempDirectory("call-gap").toFile(); val id = "22222222-2222-4222-8222-222222222222"
        val recorder = LocalCallRecorder(root, id)
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 60_000)
        recorder.markDropped(OriginalAudioTrack.CALLER_ORIGINAL, 0, 2)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 40_000)
        val manifest = recorder.finish("ended")
        assertFalse(requireNotNull(manifest.tracks[OriginalAudioTrack.REMOTE_ORIGINAL]).captureComplete)
        assertFalse(requireNotNull(manifest.tracks[OriginalAudioTrack.CALLER_ORIGINAL]).captureComplete)
        assertTrue(File(root, "$id/timeline.jsonl").readText().contains("\"event\":\"gap\""))
        root.deleteRecursively()
    }

    @Test fun mediaBufferDiscardIsACaptureGapWithoutDoubleCountingDroppedFrames() {
        val root = Files.createTempDirectory("call-buffer-discard").toFile()
        val id = "55555555-5555-4555-8555-555555555555"
        val recorder = LocalCallRecorder(root, id)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 0)
        recorder.markCaptureGap(OriginalAudioTrack.CALLER_ORIGINAL, 20_000)
        val result = requireNotNull(recorder.finish("ended").tracks[OriginalAudioTrack.CALLER_ORIGINAL])
        assertEquals(1, result.gapCount)
        assertEquals(0, result.droppedFrames)
        assertFalse(result.captureComplete)
        assertTrue(File(root, "$id/timeline.jsonl").readText().contains("\"reason\":\"media_buffer_discard\""))
        root.deleteRecursively()
    }

    @Test fun recoveredPlayoutIsDerivedAndNeverEntersCallerOriginal() {
        val root = Files.createTempDirectory("call-playout").toFile()
        val id = "44444444-4444-4444-8444-444444444444"
        val source = ByteArray(640) { 3 }
        val recovered = ByteArray(640) { 9 }
        val recorder = LocalCallRecorder(root, id)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, source, 0, 11_000)
        recorder.appendPlayout(source, 0, 11_000, null)
        recorder.markDropped(OriginalAudioTrack.CALLER_ORIGINAL, 20_000)
        recorder.appendPlayout(recovered, 20_000, 31_000, "fec_attempt")

        val manifest = recorder.finish("ended")
        val originalFile = File(root, "$id/caller_original.wav")
        val playoutFile = File(root, "$id/caller_playout.wav")
        assertEquals(640, requireNotNull(manifest.tracks[OriginalAudioTrack.CALLER_ORIGINAL]).pcmBytes)
        assertFalse(requireNotNull(manifest.tracks[OriginalAudioTrack.CALLER_ORIGINAL]).captureComplete)
        assertEquals(source.toList(), originalFile.readBytes().drop(LocalCallRecorder.WAV_HEADER_BYTES))
        assertEquals((source + recovered).toList(), playoutFile.readBytes().drop(LocalCallRecorder.WAV_HEADER_BYTES))
        val derived = requireNotNull(manifest.derivedTracks[DerivedAudioTrack.CALLER_PLAYOUT])
        assertEquals(1, derived.recoveryFrames)
        assertTrue(derived.playoutComplete)
        val timeline = File(root, "$id/timeline.jsonl").readText()
        assertTrue(timeline.contains("\"event\":\"playout_frame\""))
        assertTrue(timeline.contains("\"recoveryKind\":\"fec_attempt\""))
        val originalFrame = timeline.lineSequence().single {
            it.contains("\"event\":\"frame\"") && it.contains("\"track\":\"caller_original\"")
        }
        assertFalse(originalFrame.contains("recoveryKind"))
        assertTrue(File(root, "$id/manifest.json").readText().contains("\"version\":3"))
        root.deleteRecursively()
    }

    @Test fun orphanPartsRecoverAsExplicitlyIncomplete() {
        val root = Files.createTempDirectory("call-recover").toFile(); val id = "33333333-3333-4333-8333-333333333333"
        val dir = File(root, id).apply { mkdirs() }
        File(dir, "remote_original.wav.part").writeBytes(ByteArray(44 + 320))
        File(dir, "caller_original.wav.part").writeBytes(ByteArray(44 + 320))
        File(dir, "caller_playout.wav.part").writeBytes(ByteArray(44 + 640))
        val recovered = LocalCallRecorder.recoverIncomplete(root).single()
        assertEquals("recovered_incomplete", recovered.terminalState)
        assertTrue(recovered.tracks.values.all { !it.captureComplete && it.sha256.length == 64 })
        val playout = requireNotNull(recovered.derivedTracks[DerivedAudioTrack.CALLER_PLAYOUT])
        assertFalse(playout.playoutComplete)
        assertEquals(640, playout.pcmBytes)
        assertTrue(File(dir, "caller_playout.wav").exists())
        assertFalse(File(dir, "caller_playout.wav.part").exists())
        assertTrue(File(dir, "manifest.json").exists())
        root.deleteRecursively()
    }

    private fun hash(file: File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
        .joinToString("") { "%02x".format(it) }
}
