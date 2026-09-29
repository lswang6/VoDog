package org.vodog.gateway

import org.vodog.gateway.media.MediaCaptureBinding
import java.nio.file.Files
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Opt-in cross-runtime contract test. The infra harness supplies only synthetic identities and a
 * localhost Control backed by a disposable database; an ordinary Gradle run skips this test.
 */
class GatewayRecordingArchiveHttpIntegrationTest {
    @Test fun kotlinV3ManifestGzipAndHttpClientFinalizeAgainstRealControl() {
        val config = IntegrationConfig.fromEnvironment()
        assumeTrue("run through infra/test-android-recording-archive-integration.ts", config != null)
        val requiredConfig = requireNotNull(config)
        val root = Files.createTempDirectory("gateway-archive-http-it").toFile()
        val binding = MediaCaptureBinding(
            id = requiredConfig.bindingId,
            callId = requiredConfig.callId,
            deviceCallId = requiredConfig.deviceCallId,
            telecomCreationTimeMillis = requiredConfig.creationTimeMillis,
            captureGeneration = requiredConfig.captureGeneration,
            mediaNodeId = "control-node",
            mediaEpoch = 1,
            createdAt = "2026-09-10T01:00:00.000Z",
        )
        val recorder = LocalCallRecorder(root, requiredConfig.callId, binding) {
            Instant.parse("2026-09-10T01:00:00.000Z")
        }
        try {
            recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, syntheticPcm(11), 0, 0)
            recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, syntheticPcm(29), 0, 0)
            recorder.markDropped(OriginalAudioTrack.CALLER_ORIGINAL, 20_000, 1)
            recorder.markCaptureGap(OriginalAudioTrack.REMOTE_ORIGINAL, 20_000)
            recorder.appendPlayout(syntheticPcm(37), 0, 0, null)
            recorder.finish("ended", mapOf("networkSendDrops" to 2))

            val journal = RecordingArchiveJournal(root)
            HttpRecordingArchiveControl(requiredConfig.deviceToken, requiredConfig.baseUrl).use { control ->
                processRecordingArchive(journal, control, requiredConfig.callId, cleanup = { _, _, _ -> Unit })
                val local = requireNotNull(journal.read(requiredConfig.callId))
                assertEquals("cleanup_pending", local.state)
                val uploadId = requireNotNull(local.uploadId)
                val remote = control.status(uploadId, requiredConfig.callId, local.manifestSha256, requiredConfig.captureGeneration)
                assertEquals("complete", remote.state)
                assertEquals(local.manifestSha256, remote.manifestSha256)
                assertTrue(remote.objects.all { it.committedOffset == it.compressedBytes })
            }
        } finally {
            root.deleteRecursively()
        }
    }

    private fun syntheticPcm(seed: Int) = ByteArray(640) { index -> ((index * seed) and 0xff).toByte() }
}

private data class IntegrationConfig(
    val baseUrl: String,
    val deviceToken: String,
    val callId: String,
    val bindingId: String,
    val deviceCallId: String,
    val creationTimeMillis: Long,
    val captureGeneration: Long,
) {
    companion object {
        fun fromEnvironment(): IntegrationConfig? {
            val enabled = System.getenv("VODOG_ARCHIVE_IT_ENABLED") ?: return null
            require(enabled == "1")
            fun required(name: String) = requireNotNull(System.getenv(name)) { "$name is required" }
            val baseUrl = required("VODOG_ARCHIVE_IT_BASE_URL")
            require(baseUrl.startsWith("http://127.0.0.1:") && "/api/v1" in baseUrl)
            return IntegrationConfig(
                baseUrl = baseUrl,
                deviceToken = required("VODOG_ARCHIVE_IT_DEVICE_TOKEN"),
                callId = required("VODOG_ARCHIVE_IT_CALL_ID"),
                bindingId = required("VODOG_ARCHIVE_IT_BINDING_ID"),
                deviceCallId = required("VODOG_ARCHIVE_IT_DEVICE_CALL_ID"),
                creationTimeMillis = required("VODOG_ARCHIVE_IT_CREATION_TIME_MILLIS").toLong(),
                captureGeneration = required("VODOG_ARCHIVE_IT_CAPTURE_GENERATION").toLong(),
            )
        }
    }
}
