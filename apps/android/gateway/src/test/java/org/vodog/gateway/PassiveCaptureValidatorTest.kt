package org.vodog.gateway

import org.vodog.gateway.media.MediaCaptureBinding
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Opt in with a locally built Go validator; no server, database, device, or network required. */
class PassiveCaptureValidatorTest {
    @Test fun goValidatorAcceptsPaddedFramesWithOverlappingCaptureLossIntervals() {
        val validator = System.getenv("VODOG_RECORDING_VALIDATOR")
        assumeTrue("VODOG_RECORDING_VALIDATOR must name the real Go binary", !validator.isNullOrBlank())
        val root = Files.createTempDirectory("passive-go-validator").toFile()
        try {
            val id = "88888888-8888-4888-8888-888888888888"
            val binding = MediaCaptureBinding(
                "99999999-9999-4999-8999-999999999999", id, "synthetic-device-call", 1L,
                1L, "control-node", 1L, "2026-09-20T06:34:46Z",
            )
            val recorder = LocalCallRecorder(root, id, binding) { Instant.parse("2026-09-20T06:34:46Z") }
            for (timestamp in listOf(0L, 20_000L)) {
                recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, timestamp)
                recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), timestamp)
                // First frame is system-silenced; second has only its last 10 ms padded.
                val offset = if (timestamp == 0L) 0L else 10_000L
                recorder.markCaptureGapDuration(OriginalAudioTrack.CALLER_ORIGINAL,
                    timestamp + offset, 20_000L - offset)
            }
            recorder.finish("ended")
            val directory = File(root, id)
            val manifest = JSONObject(File(directory, "manifest.json").readText())
            assertEquals(2, manifest.getInt("version"))
            val tracks = manifest.getJSONObject("tracks")
            assertFalse(tracks.getJSONObject("caller_original").getBoolean("captureComplete"))
            assertEquals(2, tracks.getJSONObject("caller_original").getInt("gapCount"))
            assertTrue(tracks.getJSONObject("remote_original").getBoolean("captureComplete"))
            for (name in listOf("remote_original.wav", "caller_original.wav", "timeline.jsonl")) {
                val source = File(directory, name)
                val gzip = File(directory, "$name.gz")
                DeterministicGzip.compress(source, gzip)
                val output = File(directory, "$name.verified")
                val args = mutableListOf(requireNotNull(validator), "--root", root.path,
                    "--input", gzip.path, "--output", output.path,
                    "--kind", if (name.endsWith("wav")) "wav" else "timeline",
                    "--max-output", source.length().toString())
                if (name.endsWith("jsonl")) args += listOf(
                    "--remote-bytes", File(directory, "remote_original.wav").length().toString(),
                    "--caller-bytes", File(directory, "caller_original.wav").length().toString())
                val log = File(directory, "$name.validator.log")
                val process = ProcessBuilder(args).redirectErrorStream(true).redirectOutput(log).start()
                if (!process.waitFor(30, TimeUnit.SECONDS)) {
                    process.destroyForcibly()
                    throw AssertionError("Go validator timed out")
                }
                assertEquals(log.readText(), 0, process.exitValue())
                assertTrue(source.readBytes().contentEquals(output.readBytes()))
                println("Go validator accepted $name: ${log.readText().trim()}")
            }
        } finally { root.deleteRecursively() }
    }
}
