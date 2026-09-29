package org.vodog

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

class RecordingPlaybackTest {
    @Test fun playbackPairsNeverReplaceAnOriginalWithDerivedAudio() {
        val originals = listOf(
            RecordingArtifact(RecordingAudioTrack.REMOTE_ORIGINAL, "audio/wav", 2044, "a".repeat(64), true, 0, 0),
            RecordingArtifact(RecordingAudioTrack.CALLER_ORIGINAL, "audio/wav", 2044, "b".repeat(64), false, 2, 3),
        )
        val derived = RecordingArtifact(
            RecordingAudioTrack.CALLER_PLAYOUT, "audio/wav", 3044, "c".repeat(64), null, 0, 0,
            sourceRole = "derived_playout", playoutComplete = true, recoveryFrames = 2,
        )
        val manifest = RecordingManifest(
            RecordingSource.PIXEL, 3, "22222222-2222-4222-8222-222222222222",
            "11111111-1111-4111-8111-111111111111", "2026-09-10T00:01:00Z", true, false,
            originals, listOf(derived),
        )
        assertEquals(listOf(RecordingAudioTrack.REMOTE_ORIGINAL, RecordingAudioTrack.CALLER_ORIGINAL),
            manifest.pairArtifacts(RecordingPairMode.ORIGINALS).map { it.track })
        assertEquals(listOf(RecordingAudioTrack.REMOTE_ORIGINAL, RecordingAudioTrack.CALLER_PLAYOUT),
            manifest.pairArtifacts(RecordingPairMode.COMPENSATED).map { it.track })
        assertTrue(manifest.copy(derivedArtifacts = emptyList()).pairArtifacts(RecordingPairMode.COMPENSATED).isEmpty())
        assertTrue(manifest.copy(version = 2).pairArtifacts(RecordingPairMode.COMPENSATED).isEmpty())
        assertEquals(0L, clampRecordingSeek(-10, 12_000))
        assertEquals(12_000L, clampRecordingSeek(99_000, 12_000))
        assertEquals(1_500L, clampRecordingSeek(1_500, 12_000))
        assertEquals(
            3_044L,
            manifest.copy(
                artifacts = originals.map { it.copy(durationMs = 2_044) },
                derivedArtifacts = listOf(derived.copy(durationMs = 3_044)),
            ).pairDurationMs(RecordingPairMode.COMPENSATED),
        )
    }

    @Test
    fun verifierRequiresManifestSizeAndSha() {
        val file = File.createTempFile("recording-verifier", ".ogg")
        try {
            file.writeBytes("vodog-recording".toByteArray())
            val valid = artifact(file, OriginalTranscriptTrack.REMOTE_ORIGINAL)
            assertTrue(RecordingFileVerifier.verify(file, valid))
            assertFalse(RecordingFileVerifier.verify(file, valid.copy(bytes = valid.bytes + 1)))
            assertFalse(RecordingFileVerifier.verify(file, valid.copy(sha256 = "00".repeat(32))))
        } finally {
            file.delete()
        }
    }

    @Test
    fun replacementSessionCannotAuthorizeDownloadedRecording() {
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "caller_test"))
        val expected = sessions.snapshot()
        val file = File.createTempFile("recording-session", ".ogg")
        try {
            file.writeBytes("verified".toByteArray())
            val artifact = artifact(file, OriginalTranscriptTrack.CALLER_ORIGINAL)
            sessions.install(expected.epoch, Session("new-access", "new-refresh", "caller_test"))
            assertThrows(SessionChangedException::class.java) {
                RecordingPlaybackAdmission.verifyCurrent(sessions, expected, file, artifact)
            }
        } finally {
            file.delete()
        }
    }

    @Test
    fun tokenRefreshWithinLoginStillAuthorizesVerifiedRecording() {
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "caller_test"))
        val expected = sessions.snapshot()
        val file = File.createTempFile("recording-refresh", ".ogg")
        try {
            file.writeBytes("verified-after-refresh".toByteArray())
            val artifact = artifact(file, OriginalTranscriptTrack.REMOTE_ORIGINAL)
            sessions.refresh(expected) { Session("new-access", "new-refresh", it.username) }
            assertTrue(RecordingPlaybackAdmission.verifyCurrent(sessions, expected, file, artifact))
        } finally {
            file.delete()
        }
    }

    @Test
    fun cancellationAndLatePrepareAreFenced() {
        val cancellation = RecordingDownloadCancellation()
        val call = OkHttpClient().newCall(okhttp3.Request.Builder().url("https://example.invalid/recording").build())
        cancellation.attach(call)
        cancellation.cancel()
        assertTrue(call.isCanceled())
        assertThrows(kotlinx.coroutines.CancellationException::class.java) {
            cancellation.throwIfCancelled()
        }
        assertTrue(playbackOperationCurrent(8, 8))
        assertFalse(playbackOperationCurrent(8, 9))
    }

    @Test fun cancellationBeforeAttachCancelsTheLaterCallWithoutStartingIt() {
        val cancellation = RecordingDownloadCancellation()
        cancellation.cancel()
        val call = OkHttpClient().newCall(okhttp3.Request.Builder().url("https://example.invalid/recording").build())
        assertThrows(kotlinx.coroutines.CancellationException::class.java) { cancellation.attach(call) }
        assertTrue(call.isCanceled())
        assertFalse(call.isExecuted())
    }

    @Test
    fun unauthorizedRecordingDownloadRefreshesOnceAndUsesLatestBearer() {
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "caller_test"))
        val expected = sessions.snapshot()
        var attempts = 0
        var refreshes = 0
        val token = withRecordingBearerRetry(
            sessions,
            expected,
            refreshAfterUnauthorized = { request ->
                refreshes += 1
                sessions.refresh(request) { Session("new-access", "new-refresh", it.username) }
            },
        ) { request ->
            attempts += 1
            if (attempts == 1) throw RecordingUnauthorizedException()
            request.session!!.token
        }
        assertEquals("new-access", token)
        assertEquals(2, attempts)
        assertEquals(1, refreshes)
    }

    @Test
    fun nonUnauthorizedRecordingFailureDoesNotRefresh() {
        val sessions = SessionCoordinator(Session("access", "refresh", "caller_test"))
        val expected = sessions.snapshot()
        var refreshes = 0
        assertThrows(IllegalStateException::class.java) {
            withRecordingBearerRetry(
                sessions,
                expected,
                refreshAfterUnauthorized = { refreshes += 1; it },
            ) { throw IllegalStateException("forbidden") }
        }
        assertEquals(0, refreshes)
    }

    @Test fun rangePreflightRequiresExactEtagMimeAndBoundsForOggAndWav() {
        val ogg = artifact(File("unused"), OriginalTranscriptTrack.REMOTE_ORIGINAL, bytes = 123, sha = "a".repeat(64))
        validateRecordingPreflight(206, "audio/ogg; charset=binary", 1, "\"${ogg.sha256}\"", "Bytes", "bytes 0-0/123", ogg)
        validateRecordingPreflight(200, "audio/ogg", 123, "\"${ogg.sha256}\"", "bytes", null, ogg)
        assertThrows(IllegalArgumentException::class.java) {
            validateRecordingPreflight(206, "audio/ogg", 1, "\"${"b".repeat(64)}\"", "bytes", "bytes 0-0/123", ogg)
        }
        val wav = ogg.copy(mediaType = "audio/wav", bytes = 2044)
        validateFullRecordingResponse("audio/wav", 2044, "\"${wav.sha256}\"", wav)
        assertThrows(IllegalArgumentException::class.java) {
            validateRecordingPreflight(206, "audio/wav", 1, "\"${wav.sha256}\"", "bytes", "bytes 1-1/2044", wav)
        }
        assertThrows(IllegalArgumentException::class.java) {
            validateFullRecordingResponse("audio/ogg", 2044, "\"${wav.sha256}\"", wav)
        }
    }

    @Test fun downloaderUsesRangeOnlyForPreflightAndLatestBearerForFullGet() {
        val payload = "vodog-recording".toByteArray()
        val file = File.createTempFile("recording-download", ".ogg")
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "caller_test"))
        val expected = sessions.snapshot()
        val artifact = RecordingArtifact(
            OriginalTranscriptTrack.REMOTE_ORIGINAL,
            "audio/ogg",
            payload.size.toLong(),
            java.security.MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) },
            null,
            0,
            0,
        )
        MockWebServer().use { server ->
            var requestNumber = 0
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requestNumber += 1
                    return if (requestNumber == 1) {
                        sessions.refresh(expected) { Session("new-access", "new-refresh", it.username) }
                        MockResponse().setResponseCode(206)
                            .setHeader("Content-Type", "audio/ogg")
                            .setHeader("Content-Length", "1")
                            .setHeader("ETag", quotedRecordingEtag(artifact))
                            .setHeader("Accept-Ranges", "bytes")
                            .setHeader("Content-Range", "bytes 0-0/${payload.size}")
                            .setBody("c")
                    } else {
                        MockResponse().setResponseCode(200)
                            .setHeader("Content-Type", "audio/ogg")
                            .setHeader("Content-Length", payload.size)
                            .setHeader("ETag", quotedRecordingEtag(artifact))
                            .setBody(okio.Buffer().write(payload))
                    }
                }
            }
            try {
                HttpRecordingTrackDownloader(
                    sessions = sessions,
                    refreshAfterUnauthorized = { error("refresh should not be needed") },
                    baseUrl = server.url("/").toString(),
                ).download(
                    "call-1", RecordingSource.MEDIA_NODE, 1, OriginalTranscriptTrack.REMOTE_ORIGINAL.recordingAudioTrack(),
                    expected, artifact, file, RecordingDownloadCancellation(),
                )
                val preflight = server.takeRequest()
                val full = server.takeRequest()
                assertEquals("bytes=0-0", preflight.getHeader("Range"))
                assertEquals(quotedRecordingEtag(artifact), preflight.getHeader("If-Range"))
                assertEquals("Bearer old-access", preflight.getHeader("Authorization"))
                assertEquals(null, full.getHeader("Range"))
                assertEquals(null, full.getHeader("If-Range"))
                assertEquals("Bearer new-access", full.getHeader("Authorization"))
                assertTrue(file.readBytes().contentEquals(payload))
            } finally {
                file.delete()
            }
        }
    }

    private fun artifact(
        file: File,
        track: OriginalTranscriptTrack,
        bytes: Long = file.length(),
        sha: String = if (file.exists()) RecordingFileVerifier.sha256(file) else "a".repeat(64),
    ) = RecordingArtifact(track, "audio/ogg", bytes, sha, null, 0, 0)
}
