package org.vodog.gateway

import org.vodog.gateway.media.MediaCaptureBinding
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.zip.GZIPInputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayRecordingArchiveTest {
    @Test fun deterministicGzipIsSingleStableMemberAndRoundTrips() {
        val directory = Files.createTempDirectory("deterministic-gzip").toFile()
        val source = File(directory, "remote_original.wav").apply {
            writeBytes(ByteArray(50_003) { index -> (index * 31).toByte() })
        }
        val first = File(directory, "first.gz")
        val second = File(directory, "second.gz")
        val a = DeterministicGzip.compress(source, first)
        val b = DeterministicGzip.compress(source, second)

        assertArrayEquals(first.readBytes(), second.readBytes())
        assertArrayEquals(source.readBytes(), GZIPInputStream(first.inputStream()).use { it.readBytes() })
        assertEquals(a.compressedSha256, b.compressedSha256)
        assertEquals(listOf<Byte>(0x1f, 0x8b.toByte(), 8, 0, 0, 0, 0, 0), first.readBytes().take(8))
        directory.deleteRecursively()
    }

    @Test fun captureBindingIsDurableBeforeAudioAndManifestV2KeepsExactFence() {
        val root = Files.createTempDirectory("capture-binding").toFile()
        val callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val binding = binding(callId)
        val recorder = LocalCallRecorder(root, callId, binding) { Instant.parse("2026-09-10T00:00:00Z") }
        val directory = File(root, callId)
        assertTrue(File(directory, "capture.json").isFile)
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 0)
        recorder.finish("ended")
        val manifest = File(directory, "manifest.json").readText()
        assertTrue(manifest.contains("\"version\":2"))
        assertTrue(manifest.contains("\"id\":\"${binding.id}\""))
        assertTrue(manifest.contains("\"captureGeneration\":7"))
        root.deleteRecursively()
    }

    @Test fun existingCaptureCannotBeOverwrittenOrReusedAfterAudioCreation() {
        val root = Files.createTempDirectory("capture-conflict").toFile()
        val callId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        LocalCallRecorder(root, callId, binding(callId)).close()
        assertThrows(IllegalStateException::class.java) {
            LocalCallRecorder(root, callId, binding(callId).copy(id = "22222222-2222-4222-8222-222222222222"))
        }
        assertFalse(File(root, "$callId/capture.json").readText().contains("22222222"))
        root.deleteRecursively()
    }

    @Test fun journalPersistsOnlyFixedObjectsAndExactServerWatermarks() {
        val root = Files.createTempDirectory("archive-journal").toFile()
        val callId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        File(root, callId).mkdirs()
        val objects = listOf(
            ArchiveObject("remote_original.wav.gz", 12, "a".repeat(64), 44, "b".repeat(64), 7),
            ArchiveObject("caller_original.wav.gz", 13, "c".repeat(64), 44, "d".repeat(64), 8),
            ArchiveObject("timeline.jsonl.gz", 14, "e".repeat(64), 10, "f".repeat(64), 9),
        )
        val expected = ArchiveUploadState("dddddddd-dddd-4ddd-8ddd-dddddddddddd", callId, "0".repeat(64), objects, 2,
            "2026-09-10T00:01:00Z", failureCode = "HTTP_503")
        val journal = RecordingArchiveJournal(root)
        journal.write(expected)
        assertEquals(expected, journal.read(callId))
        val journalFile = File(root, "$callId/archive-upload.json")
        val raw = journalFile.readText()
        assertFalse(raw.contains("phone")); assertFalse(raw.contains("message"))
        val duplicate = JSONObject(raw)
        duplicate.getJSONArray("objects").getJSONObject(2).put("name", "remote_original.wav.gz")
        journalFile.writeText(duplicate.toString())
        assertThrows(IllegalArgumentException::class.java) { journal.read(callId) }
        journalFile.writeText(JSONObject(raw).put("attempt", "2").toString())
        assertThrows(IllegalArgumentException::class.java) { journal.read(callId) }
        journal.write(expected)
        File(root, "$callId/manifest.json").writeText("{}")
        File(root, "$callId/capture.json").writeText("{}")
        journal.write(expected.copy(state = "auth_required"))
        journal.reactivateAuthentication()
        assertEquals("uploading", journal.read(callId)?.state)
        root.deleteRecursively()
    }

    @Test fun preparationFailuresUseDurableBoundedBackoff() {
        val root = Files.createTempDirectory("archive-preparation").toFile()
        val callId = "abababab-abab-4bab-8bab-abababababab"
        File(root, callId).mkdirs()
        val journal = RecordingArchiveJournal(root)
        val now = Instant.parse("2026-09-10T00:00:00Z")
        journal.recordPreparationFailure(callId, now, "archive_prepare_failed")
        assertFalse(journal.preparationDue(callId, now.plusSeconds(1)))
        assertTrue(journal.preparationDue(callId, now.plusSeconds(2)))
        File(root, "$callId/archive-preparation.json").writeText("not-json")
        assertFalse(preparationDueOrBackoff(journal, callId, now))
        assertFalse(journal.preparationDue(callId, now.plusSeconds(1)))
        root.deleteRecursively()
    }

    @Test fun cancelledCompressionLeavesNoPublishedObject() {
        val directory = Files.createTempDirectory("gzip-cancel").toFile()
        val source = File(directory, "source").apply { writeBytes(ByteArray(128 * 1024)) }
        val target = File(directory, "target.gz")
        assertThrows(ArchivePausedException::class.java) {
            DeterministicGzip.compress(source, target) { false }
        }
        assertFalse(target.exists())
        assertTrue(File(directory, "target.gz.part").exists())
        directory.deleteRecursively()
    }

    @Test fun serverUploadDtoRejectsDuplicateObjectsCoercedNumbersAndWrongFingerprint() {
        val callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val fingerprint = "a".repeat(64)
        fun item(name: String) = JSONObject().put("name", name).put("expectedBytes", 10)
            .put("committedOffset", 0).put("state", "uploading")
        fun response(items: List<JSONObject>, hash: String = fingerprint) = JSONObject().put("upload", JSONObject()
            .put("id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").put("state", "uploading")
            .put("manifestSha256", hash).put("objects", org.json.JSONArray(items)))
        val valid = listOf(item("remote_original.wav.gz"), item("caller_original.wav.gz"), item("timeline.jsonl.gz"))
        assertEquals(3, parseUpload(callId, fingerprint, response(valid)).objects.size)
        assertThrows(IllegalArgumentException::class.java) {
            parseUpload(callId, fingerprint, response(listOf(valid[0], valid[0], valid[2])))
        }
        assertThrows(IllegalArgumentException::class.java) {
            parseUpload(callId, fingerprint, response(valid.map { JSONObject(it.toString()) }.also {
                it[0].put("expectedBytes", "10")
            }))
        }
        assertThrows(IllegalArgumentException::class.java) {
            parseUpload(callId, fingerprint, response(valid, "b".repeat(64)))
        }
    }

    @Test fun canonicalManifestFingerprintIgnoresObjectKeyInsertionOrder() {
        val first = JSONObject().put("z", 1).put("a", JSONObject().put("y", true).put("b", 2))
        val second = JSONObject().put("a", JSONObject().put("b", 2).put("y", true)).put("z", 1)
        assertEquals(canonicalFingerprint(first), canonicalFingerprint(second))
        assertEquals("{\"a\":{\"b\":2,\"y\":true},\"z\":1}", canonicalJson(first))
        assertEquals("da68fbb024ea63ef449e07781d6b1eacc879711edd25ae18288d13849c21cf06", canonicalFingerprint(first))
    }

    @Test fun canonicalManifestStringsMatchJavascriptForSlashesControlsUnicodeAndSurrogates() {
        val value = JSONObject()
            .put("slash", "https://x/y</z>")
            .put("controls", "\b\u000c\n\r\t\u0000")
            .put("unicode", "測試🐕")
            .put("lone", "\uD800")
            .put("integer", -0.0)
        assertEquals(
            "{\"controls\":\"\\b\\f\\n\\r\\t\\u0000\",\"integer\":0,\"lone\":\"\\ud800\",\"slash\":\"https://x/y</z>\",\"unicode\":\"測試🐕\"}",
            canonicalJson(value),
        )
        assertEquals("228a707ccc9476286a9d9ba332f45c9318836388a8c9dd0859b6d953b7a57c8a", canonicalFingerprint(value))
        assertEquals("5944e9de9670c227caaaf8f41f7c393fd75af5093172a48a4a243442da1f6e41", legacySlashEscapedCanonicalFingerprint(value))
        assertThrows(IllegalArgumentException::class.java) { canonicalJson(JSONObject().put("fraction", 1.5)) }
        assertThrows(IllegalArgumentException::class.java) { canonicalJson(java.math.BigDecimal("9007199254740990.5")) }
        assertEquals("9007199254740991", canonicalJson(java.math.BigDecimal("9007199254740991.0")))
        assertEquals("-9007199254740991", canonicalJson(java.math.BigDecimal("-9007199254740991")))
        assertThrows(IllegalArgumentException::class.java) { canonicalJson(java.math.BigInteger("9007199254740992")) }
        assertThrows(org.json.JSONException::class.java) { JSONObject().put("invalid", Double.NaN) }
    }

    @Test fun httpInitializeComparesControlCanonicalFingerprintRatherThanWireKeyOrder() {
        val server = MockWebServer()
        val manifest = JSONObject().put("z", 1).put("a", JSONObject().put("y", true).put("b", 2))
            .put("captureBinding", JSONObject().put("captureGeneration", 7))
        val fingerprint = canonicalFingerprint(manifest)
        val response = JSONObject().put("upload", JSONObject()
            .put("id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").put("state", "uploading")
            .put("manifestSha256", fingerprint).put("objects", org.json.JSONArray(listOf(
                serverObject("remote_original.wav.gz"), serverObject("caller_original.wav.gz"),
                serverObject("timeline.jsonl.gz"),
            ))))
        server.enqueue(MockResponse().setResponseCode(200).setBody(response.toString()))
        server.start()
        val control = HttpRecordingArchiveControl("device-token", server.url("/api/v1").toString().removeSuffix("/"))
        try {
            assertEquals(fingerprint, control.initialize("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", manifest).manifestSha256)
        } finally {
            control.close(); server.shutdown()
        }
    }

    @Test fun finalizeRequiresTheExactArchiveCallAndManifestIdentity() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{\"archive\":{\"state\":\"complete\"}}"))
        server.start()
        val control = HttpRecordingArchiveControl("device-token", server.url("/api/v1").toString().removeSuffix("/"))
        try {
            assertThrows(org.json.JSONException::class.java) {
                control.finalize(
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "a".repeat(64),
                    2,
                )
            }
        } finally {
            control.close(); server.shutdown()
        }
    }

    @Test fun archiveHttpOwnerCancelsARegisteredBlockingRequest() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}").setBodyDelay(1, TimeUnit.SECONDS))
        server.start()
        val control = HttpRecordingArchiveControl("device-token", server.url("/api/v1").toString().removeSuffix("/"))
        val executor = Executors.newSingleThreadExecutor()
        try {
            val future = executor.submit<ArchiveUploadState> {
                control.status(
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "a".repeat(64),
                    7,
                )
            }
            requireNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            control.cancelInFlight()
            assertThrows(java.util.concurrent.ExecutionException::class.java) { future.get(2, TimeUnit.SECONDS) }
        } finally {
            control.close(); executor.shutdownNow(); runCatching { server.shutdown() }
        }
    }

    @Test fun compressionBudgetPreservesConfiguredDiskReserve() {
        val directory = Files.createTempDirectory("archive-capacity").toFile()
        assertThrows(RecordingArchiveCapacityException::class.java) {
            // Free space can grow while other Gradle workers clean outputs; +1 is deterministically impossible.
            requireArchiveDiskCapacity(directory, listOf(44, 44, 1), directory.usableSpace + 1)
        }
        directory.deleteRecursively()
    }

    @Test fun lostChunkResponseReconcilesServerWatermarkWithoutResendingCommittedBytes() {
        val root = Files.createTempDirectory("archive-resume").toFile()
        val callId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        recorder.finish("ended")
        val control = WatermarkControl()
        val journal = RecordingArchiveJournal(root)

        assertThrows(java.io.IOException::class.java) {
            processRecordingArchive(journal, control, callId)
        }
        assertEquals(0, requireNotNull(journal.read(callId)).objects.first().committedOffset)
        assertThrows(ArchivePausedException::class.java) {
            processRecordingArchive(journal, control, callId, shouldContinue = { false })
        }
        assertEquals(1, control.uploadCalls.getValue("remote_original.wav.gz"))
        processRecordingArchive(journal, control, callId)

        assertFalse(File(root, callId).exists())
        assertEquals(1, control.uploadCalls.getValue("remote_original.wav.gz"))
        assertTrue(control.finalized)
        root.deleteRecursively()
    }

    @Test fun authoritativeCompleteStatusArchivesWithoutRepeatingFinalize() {
        val root = Files.createTempDirectory("archive-complete-status").toFile()
        val callId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 0)
        recorder.finish("ended")
        val control = WatermarkControl()
        val journal = RecordingArchiveJournal(root)
        assertThrows(java.io.IOException::class.java) { processRecordingArchive(journal, control, callId) }
        control.completeOnStatus = true
        processRecordingArchive(journal, control, callId)
        assertFalse(File(root, callId).exists())
        assertFalse(control.finalized)
        root.deleteRecursively()
    }

    @Test fun manifestV3UploadsDerivedPlayoutAsFourthObjectWithoutChangingOriginalCompleteness() {
        val root = Files.createTempDirectory("archive-v3").toFile()
        val callId = "45454545-4545-4545-8545-454545454545"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 20_000)
        recorder.markDropped(OriginalAudioTrack.CALLER_ORIGINAL, 40_000)
        recorder.appendPlayout(ByteArray(640) { 9 }, 40_000, null, "plc")
        recorder.finish("ended")
        val control = WatermarkControl().apply { loseFirstResponse = false }
        val journal = RecordingArchiveJournal(root)

        processRecordingArchive(journal, control, callId, cleanup = { _, _, _ -> Unit })

        val state = requireNotNull(journal.read(callId))
        assertEquals("cleanup_pending", state.state)
        assertEquals(setOf("remote_original.wav.gz", "caller_original.wav.gz", "timeline.jsonl.gz", "caller_playout.wav.gz"),
            state.objects.map { it.name }.toSet())
        val upload = JSONObject(File(root, "$callId/manifest.v3.upload.json").readText())
        assertEquals(3, upload.getInt("version"))
        assertFalse(upload.getJSONArray("tracks").getJSONObject(1).getBoolean("captureComplete"))
        assertEquals("derived_playout", upload.getJSONArray("derivedTracks").getJSONObject(0).getString("sourceRole"))
        assertTrue(upload.getJSONArray("derivedTracks").getJSONObject(0).getBoolean("playoutComplete"))
        root.deleteRecursively()
    }

    /** S94: v4 adds caller_uplink as an `uplink_capture` original; originals and derived are unchanged. */
    @Test fun manifestV4UploadsUplinkTrackAndFinalizesVersionFour() {
        val root = Files.createTempDirectory("archive-v4").toFile()
        val callId = "94949494-9494-4494-8494-949494949494"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-10-01T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        recorder.appendPlayout(ByteArray(640) { 9 }, 0, null, null)
        recorder.appendUplink(ByteArray(640) { 4 }, 0)
        recorder.markCaptureGapDuration(UplinkAudioTrack.CALLER_UPLINK, 0, 20_000)
        recorder.finish("ended")
        val control = WatermarkControl().apply { loseFirstResponse = false }
        val journal = RecordingArchiveJournal(root)

        processRecordingArchive(journal, control, callId, cleanup = { _, _, _ -> Unit })

        assertTrue(control.finalized)
        assertEquals(setOf("remote_original.wav.gz", "caller_original.wav.gz", "timeline.jsonl.gz", "caller_playout.wav.gz",
            "caller_uplink.wav.gz"), requireNotNull(journal.read(callId)).objects.map { it.name }.toSet())
        val upload = JSONObject(File(root, "$callId/manifest.v4.upload.json").readText())
        assertEquals(4, upload.getInt("version"))
        assertEquals(2, upload.getJSONArray("tracks").length())
        assertEquals(1, upload.getJSONArray("derivedTracks").length())
        val uplink = upload.getJSONArray("uplinkTracks").getJSONObject(0)
        assertEquals(setOf("track", "sourceRole", "objectName", "mediaType", "pcm", "compressedBytes", "compressedSha256",
            "originalBytes", "originalSha256", "pcmBytes", "gapCount", "droppedFrames", "captureComplete"), uplink.keys().asSequence().toSet())
        assertEquals("caller_uplink", uplink.getString("track"))
        assertEquals("uplink_capture", uplink.getString("sourceRole"))
        assertEquals("caller_uplink.wav.gz", uplink.getString("objectName"))
        assertEquals(640L, uplink.getLong("pcmBytes")); assertEquals(684L, uplink.getLong("originalBytes"))
        assertEquals(1L, uplink.getLong("gapCount")); assertFalse(uplink.getBoolean("captureComplete"))
        // The originals' completeness is unaffected by a silenced uplink.
        assertTrue(upload.getJSONArray("tracks").getJSONObject(0).getBoolean("captureComplete"))
        root.deleteRecursively()
    }

    @Test fun manifestV4WithoutPlayoutOmitsDerivedTracks() {
        val root = Files.createTempDirectory("archive-v4-nod").toFile()
        val callId = "94949494-9494-4494-8494-949494949495"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-10-01T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        recorder.appendUplink(ByteArray(640) { 4 }, 0)
        recorder.finish("ended")
        processRecordingArchive(RecordingArchiveJournal(root), WatermarkControl().apply { loseFirstResponse = false }, callId,
            cleanup = { _, _, _ -> Unit })
        val upload = JSONObject(File(root, "$callId/manifest.v4.upload.json").readText())
        assertFalse(upload.has("derivedTracks"))
        assertTrue(upload.getJSONArray("uplinkTracks").getJSONObject(0).getBoolean("captureComplete"))
        root.deleteRecursively()
    }

    @Test fun manifestV4FinalizeAcceptsServerVersionFour() {
        val server = MockWebServer()
        val uploadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc"
        val callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"
        val fingerprint = "a".repeat(64)
        val response = JSONObject().put("archive", JSONObject()
            .put("id", uploadId).put("callId", callId).put("source", "pixel").put("version", 4)
            .put("state", "complete").put("completedAt", "2026-10-01T00:00:00.000Z")
            .put("manifestSha256", fingerprint))
        server.enqueue(MockResponse().setResponseCode(200).setBody(response.toString()))
        server.start()
        val control = HttpRecordingArchiveControl("device-token", server.url("/api/v1").toString().removeSuffix("/"))
        try {
            assertEquals("complete", control.finalize(uploadId, callId, fingerprint, 4))
        } finally {
            control.close(); server.shutdown()
        }
    }

    /** S39 §决策3 revises the S31 B rule: a verified 410 deletes the local copy either way. */
    @Test fun deletedIncompleteArchiveIsCleanedUpBecauseTheUserDeletedTheCall() {
        val root = Files.createTempDirectory("archive-deleted-cleanup").toFile()
        val callId = "31313131-3131-4313-8313-313131313131"
        LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }.apply {
            append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
            append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 0)
            finish("ended")
        }
        val control = DeletedControl(CallDeletionProof(callId, 7, false, false))
        val journal = RecordingArchiveJournal(root)

        processRecordingArchive(journal, control, callId)
        assertFalse(File(root, callId).exists())
        assertEquals(1, control.initializeCalls)
        assertEquals(emptyList<String>(), journal.candidates())
        root.deleteRecursively()
    }

    /** A journal left in the old terminal state by an S38 gateway is finished on the next pass. */
    @Test fun anArchiveRetainedByTheOldDeletionRuleIsCleanedUpOnTheNextPass() {
        val root = Files.createTempDirectory("archive-deleted-retained-leftover").toFile()
        val callId = "34343434-3434-4343-8343-343434343434"
        LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }.apply {
            append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
            append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 0)
            finish("ended")
        }
        val journal = RecordingArchiveJournal(root)
        assertThrows(java.io.IOException::class.java) {
            processRecordingArchive(journal, WatermarkControl(), callId)
        }
        journal.write(requireNotNull(journal.read(callId)).copy(state = "deleted_retained"))
        assertTrue(journal.candidates().contains(callId))

        val control = DeletedControl(CallDeletionProof(callId, 7, false, false))
        processRecordingArchive(journal, control, callId)
        assertFalse(File(root, callId).exists())
        root.deleteRecursively()
    }

    @Test fun verifiedDeletionAndSuccessfulArchiveCleanupAreRestartSafe() {
        val root = Files.createTempDirectory("archive-cleanup-restart").toFile()
        val callId = "32323232-3232-4323-8323-323232323232"
        LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }.apply {
            append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
            append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 0)
            finish("ended")
        }
        val control = WatermarkControl().apply { loseFirstResponse = false }
        val firstJournal = RecordingArchiveJournal(root)
        assertThrows(java.io.IOException::class.java) {
            processRecordingArchive(firstJournal, control, callId, cleanup = { _, _, _ ->
                throw java.io.IOException("simulated cleanup crash")
            })
        }
        assertEquals("cleanup_pending", firstJournal.read(callId)?.state)
        assertTrue(File(root, callId).isDirectory)

        val interrupted = File(root, ".archive-cleanup-$callId")
        assertTrue(File(root, callId).renameTo(interrupted))
        val restartedJournal = RecordingArchiveJournal(root)
        assertTrue(callId in restartedJournal.candidates())
        assertFalse(interrupted.exists())
        processRecordingArchive(restartedJournal, control, callId)
        assertFalse(File(root, callId).exists())
        assertEquals(1, control.initializeCalls)
        root.deleteRecursively()
    }

    @Test fun verifiedDeletedProofCleansButUnsafeSymlinkAndLegacyArchiveStayRestartable() {
        val verifiedRoot = Files.createTempDirectory("archive-deleted-clean").toFile()
        val verifiedCall = "34343434-3434-4343-8343-343434343434"
        LocalCallRecorder(verifiedRoot, verifiedCall, binding(verifiedCall)) { Instant.parse("2026-09-10T00:00:00Z") }.apply {
            append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
            append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 0)
            finish("ended")
        }
        val deleted = DeletedControl(CallDeletionProof(verifiedCall, 7, true, true))
        processRecordingArchive(RecordingArchiveJournal(verifiedRoot), deleted, verifiedCall)
        assertFalse(File(verifiedRoot, verifiedCall).exists())

        val unsafeRoot = Files.createTempDirectory("archive-cleanup-symlink").toFile()
        val unsafeCall = "35353535-3535-4353-8353-353535353535"
        LocalCallRecorder(unsafeRoot, unsafeCall, binding(unsafeCall)) { Instant.parse("2026-09-10T00:00:00Z") }.apply {
            append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640), 0)
            append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640), 0)
            finish("ended")
        }
        val control = WatermarkControl().apply { loseFirstResponse = false }
        val journal = RecordingArchiveJournal(unsafeRoot)
        processRecordingArchive(journal, control, unsafeCall, cleanup = { _, _, _ -> Unit })
        val outside = File(unsafeRoot, "must-survive").apply { writeText("safe") }
        Files.createSymbolicLink(File(unsafeRoot, "$unsafeCall/unsafe-link").toPath(), outside.toPath())
        assertThrows(IllegalArgumentException::class.java) { cleanupArchivedRecording(journal, unsafeCall) }
        assertEquals("safe", outside.readText())
        assertEquals("cleanup_pending", journal.read(unsafeCall)?.state)
        File(unsafeRoot, "$unsafeCall/unsafe-link").delete()
        journal.write(requireNotNull(journal.read(unsafeCall)).copy(state = "archived"))
        processRecordingArchive(RecordingArchiveJournal(unsafeRoot), control, unsafeCall)
        assertFalse(File(unsafeRoot, unsafeCall).exists())
        verifiedRoot.deleteRecursively(); unsafeRoot.deleteRecursively()
    }

    @Test fun strictDeletedProofRejectsExtraOrMismatchedIdentityFields() {
        val callId = "33333333-3333-4333-8333-333333333333"
        fun body() = JSONObject().put("error", JSONObject()
            .put("code", "CALL_DELETED").put("message", "deleted").put("requestId", "request-1")
            .put("details", JSONObject().put("deletion", JSONObject()
                .put("callId", callId).put("gatewayGeneration", 7)
                .put("archive", JSONObject().put("previouslyVerified", true).put("previouslyComplete", true)))))
        assertEquals(CallDeletionProof(callId, 7, true, true),
            parseDeletionProof(body(), DeletedCallIdentity(callId, 7)))
        assertThrows(IllegalArgumentException::class.java) {
            parseDeletionProof(body().put("unexpected", true), DeletedCallIdentity(callId, 7))
        }
        assertThrows(IllegalArgumentException::class.java) {
            parseDeletionProof(body(), DeletedCallIdentity(callId, 8))
        }
    }

    @Test fun http410RequiresAndReturnsTheStrictDeletionProof() {
        val server = MockWebServer()
        val callId = "36363636-3636-4363-8363-363636363636"
        val response = JSONObject().put("error", JSONObject()
            .put("code", "CALL_DELETED").put("message", "deleted").put("requestId", "request-2")
            .put("details", JSONObject().put("deletion", JSONObject()
                .put("callId", callId).put("gatewayGeneration", 7)
                .put("archive", JSONObject().put("previouslyVerified", false).put("previouslyComplete", false)))))
        server.enqueue(MockResponse().setResponseCode(410).setBody(response.toString()))
        server.start()
        val control = HttpRecordingArchiveControl("device-token", server.url("/api/v1").toString().removeSuffix("/"))
        val manifest = JSONObject().put("captureBinding", JSONObject().put("captureGeneration", 7))
        try {
            val error = assertThrows(RecordingArchiveDeletedException::class.java) {
                control.initialize(callId, manifest)
            }
            assertEquals(CallDeletionProof(callId, 7, false, false), error.proof)
        } finally {
            control.close(); server.shutdown()
        }
    }

    @Test fun manifestV3FinalizeRequiresMatchingServerVersion() {
        val server = MockWebServer()
        val uploadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        val callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val fingerprint = "a".repeat(64)
        val response = JSONObject().put("archive", JSONObject()
            .put("id", uploadId).put("callId", callId).put("source", "pixel").put("version", 3)
            .put("state", "complete").put("completedAt", "2026-09-10T00:00:00.000Z")
            .put("manifestSha256", fingerprint))
        server.enqueue(MockResponse().setResponseCode(200).setBody(response.toString()))
        server.start()
        val control = HttpRecordingArchiveControl("device-token", server.url("/api/v1").toString().removeSuffix("/"))
        try {
            assertEquals("complete", control.finalize(uploadId, callId, fingerprint, 3))
        } finally {
            control.close(); server.shutdown()
        }
    }

    @Test fun resumedArchiveRejectsChangedFrozenObjectBeforeContactingControl() {
        val root = Files.createTempDirectory("archive-frozen-object").toFile()
        val callId = "56565656-5656-4565-8565-565656565656"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        recorder.finish("ended")
        val control = WatermarkControl().apply { loseFirstResponse = false }
        val journal = RecordingArchiveJournal(root)
        control.loseFirstResponse = true
        assertThrows(java.io.IOException::class.java) {
            processRecordingArchive(journal, control, callId)
        }
        val callsBeforeMutation = control.uploadCalls.toMap()
        val compressed = File(root, "$callId/remote_original.wav.gz")
        val bytes = compressed.readBytes()
        bytes[bytes.lastIndex / 2] = (bytes[bytes.lastIndex / 2].toInt() xor 1).toByte()
        compressed.writeBytes(bytes)
        assertThrows(IllegalArgumentException::class.java) {
            processRecordingArchive(journal, control, callId)
        }
        assertEquals(callsBeforeMutation, control.uploadCalls)
        root.deleteRecursively()
    }

    @Test fun exactLegacySlashJournalAfterLostInitializeMigratesAndReconcilesSameArchive() {
        val root = Files.createTempDirectory("archive-legacy-slash").toFile()
        val callId = "78787878-7878-4787-8787-787878787878"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        recorder.finish("ended")
        val control = WatermarkControl().apply { loseInitializeResponse = true; loseFirstResponse = false }
        val journal = RecordingArchiveJournal(root)
        assertThrows(java.io.IOException::class.java) { processRecordingArchive(journal, control, callId) }
        val manifestFile = File(root, "$callId/manifest.v2.upload.json")
        val immutableBytes = manifestFile.readBytes()
        val manifest = JSONObject(immutableBytes.toString(Charsets.UTF_8))
        val prepared = requireNotNull(journal.read(callId))
        assertEquals(null, prepared.uploadId)
        journal.write(prepared.copy(
            manifestSha256 = legacySlashEscapedCanonicalFingerprint(manifest),
            attempt = 8,
            nextAttemptAt = "2099-01-01T00:00:00Z",
            failureCode = "archive_io_failed",
        ))

        processRecordingArchive(journal, control, callId, cleanup = { _, _, _ -> Unit })

        val archived = requireNotNull(journal.read(callId))
        assertEquals("cleanup_pending", archived.state)
        assertEquals(canonicalFingerprint(manifest), archived.manifestSha256)
        assertEquals(2, control.initializeCalls)
        assertArrayEquals(immutableBytes, manifestFile.readBytes())
        root.deleteRecursively()
    }

    @Test fun legacyMigrationRejectsJournalAndFileTamperingBeforeHttp() {
        val root = Files.createTempDirectory("archive-legacy-tamper").toFile()
        val callId = "89898989-8989-4898-8989-898989898989"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        recorder.finish("ended")
        val control = WatermarkControl().apply { loseInitializeResponse = true; loseFirstResponse = false }
        val journal = RecordingArchiveJournal(root)
        assertThrows(java.io.IOException::class.java) { processRecordingArchive(journal, control, callId) }
        val manifest = JSONObject(File(root, "$callId/manifest.v2.upload.json").readText())
        val compressed = File(root, "$callId/remote_original.wav.gz")
        val changed = compressed.readBytes().also { it[it.lastIndex / 2] = (it[it.lastIndex / 2].toInt() xor 1).toByte() }
        compressed.writeBytes(changed)
        val prepared = requireNotNull(journal.read(callId))
        journal.write(prepared.copy(
            manifestSha256 = legacySlashEscapedCanonicalFingerprint(manifest),
            objects = prepared.objects.map {
                if (it.name == "remote_original.wav.gz") it.copy(compressedSha256 = archiveSha256(changed)) else it
            },
        ))
        val callsBefore = control.initializeCalls

        assertThrows(IllegalArgumentException::class.java) { processRecordingArchive(journal, control, callId) }
        assertEquals(callsBefore, control.initializeCalls)
        root.deleteRecursively()
    }

    @Test fun legacyMigrationRejectsUnknownHashAndAnyEstablishedLocalRemoteIdentity() {
        val root = Files.createTempDirectory("archive-legacy-identity").toFile()
        val callId = "90909090-9090-4090-8090-909090909090"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        recorder.finish("ended")
        val control = WatermarkControl().apply { loseInitializeResponse = true; loseFirstResponse = false }
        val journal = RecordingArchiveJournal(root)
        assertThrows(java.io.IOException::class.java) { processRecordingArchive(journal, control, callId) }
        val manifest = JSONObject(File(root, "$callId/manifest.v2.upload.json").readText())
        val prepared = requireNotNull(journal.read(callId))
        val callsBefore = control.initializeCalls

        journal.write(prepared.copy(manifestSha256 = "0".repeat(64)))
        assertThrows(IllegalArgumentException::class.java) { processRecordingArchive(journal, control, callId) }
        journal.write(prepared.copy(manifestSha256 = legacySlashEscapedCanonicalFingerprint(manifest),
            uploadId = "ffffffff-ffff-4fff-8fff-ffffffffffff"))
        assertThrows(IllegalArgumentException::class.java) { processRecordingArchive(journal, control, callId) }
        journal.write(prepared.copy(manifestSha256 = legacySlashEscapedCanonicalFingerprint(manifest),
            objects = prepared.objects.mapIndexed { index, item -> if (index == 0) item.copy(committedOffset = 1) else item }))
        assertThrows(IllegalArgumentException::class.java) { processRecordingArchive(journal, control, callId) }
        assertEquals(callsBefore, control.initializeCalls)
        root.deleteRecursively()
    }

    @Test fun crashRecoveryNeverReplacesAChangedUploadManifest() {
        val root = Files.createTempDirectory("archive-immutable-manifest").toFile()
        val callId = "67676767-6767-4676-8676-676767676767"
        val recorder = LocalCallRecorder(root, callId, binding(callId)) { Instant.parse("2026-09-10T00:00:00Z") }
        recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, ByteArray(640) { 1 }, 0)
        recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, ByteArray(640) { 2 }, 0)
        recorder.finish("ended")
        val control = WatermarkControl()
        val journal = RecordingArchiveJournal(root)
        assertThrows(java.io.IOException::class.java) { processRecordingArchive(journal, control, callId) }
        val manifest = File(root, "$callId/manifest.v2.upload.json")
        val changed = JSONObject(manifest.readText()).put("terminalState", "failed").toString()
        manifest.writeText(changed)
        assertTrue(File(root, "$callId/archive-upload.json").delete())
        assertThrows(IllegalArgumentException::class.java) { processRecordingArchive(journal, control, callId) }
        assertEquals(changed, manifest.readText())
        root.deleteRecursively()
    }

    private fun binding(callId: String) = MediaCaptureBinding(
        "11111111-1111-4111-8111-111111111111", callId, "device-call", 1234, 7, "control-node", 1,
        "2026-09-10T00:00:00Z",
    )

    private fun serverObject(name: String) = JSONObject().put("name", name).put("expectedBytes", 1)
        .put("committedOffset", 0).put("state", "uploading")
}

private class WatermarkControl : RecordingArchiveControl {
    private val id = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    private lateinit var objects: List<ArchiveObject>
    private val offsets = mutableMapOf<String, Long>()
    val uploadCalls = mutableMapOf<String, Int>()
    var finalized = false
    var completeOnStatus = false
    var loseFirstResponse = true
    var loseInitializeResponse = false
    var initializeCalls = 0
    private lateinit var fingerprint: String

    override fun initialize(callId: String, manifest: JSONObject): ArchiveUploadState {
        initializeCalls++
        fingerprint = canonicalFingerprint(manifest)
        val tracks = manifest.getJSONArray("tracks")
        objects = buildList {
            repeat(tracks.length()) { index ->
                val value = tracks.getJSONObject(index)
                add(ArchiveObject(value.getString("objectName"), value.getLong("compressedBytes"), "", 0, ""))
            }
            listOf("derivedTracks", "uplinkTracks").forEach { key -> manifest.optJSONArray(key)?.let { derived ->
                repeat(derived.length()) { index ->
                    val value = derived.getJSONObject(index)
                    add(ArchiveObject(value.getString("objectName"), value.getLong("compressedBytes"), "", 0, ""))
                }
            } }
            val timeline = manifest.getJSONObject("timeline")
            add(ArchiveObject(timeline.getString("objectName"), timeline.getLong("compressedBytes"), "", 0, ""))
        }
        objects.forEach { offsets[it.name] = 0 }
        if (loseInitializeResponse) {
            loseInitializeResponse = false
            throw java.io.IOException("response lost after archive initialize")
        }
        return state(callId)
    }

    override fun status(uploadId: String, callId: String, manifestSha256: String, gatewayGeneration: Long): ArchiveUploadState {
        assertEquals(fingerprint, manifestSha256)
        assertEquals(7, gatewayGeneration)
        if (completeOnStatus) objects.forEach { offsets[it.name] = it.compressedBytes }
        return state(callId, if (completeOnStatus) "complete" else "uploading")
    }

    override fun upload(uploadId: String, objectValue: ArchiveObject, source: File, offset: Long): Long {
        uploadCalls[objectValue.name] = uploadCalls.getOrDefault(objectValue.name, 0) + 1
        assertEquals(offsets.getValue(objectValue.name), offset)
        val next = minOf(offset + ARCHIVE_CHUNK_BYTES, objectValue.compressedBytes)
        offsets[objectValue.name] = next
        if (loseFirstResponse) {
            loseFirstResponse = false
            throw java.io.IOException("response lost after server commit")
        }
        return next
    }

    override fun finalize(uploadId: String, callId: String, manifestSha256: String, version: Int): String {
        assertTrue(objects.all { offsets.getValue(it.name) == it.compressedBytes })
        assertEquals(fingerprint, manifestSha256)
        assertEquals(when {
            objects.any { it.name == "caller_uplink.wav.gz" } -> 4
            objects.any { it.name == "caller_playout.wav.gz" } -> 3
            else -> 2
        }, version)
        finalized = true
        return "complete"
    }
    override fun close() = Unit
    private fun state(callId: String, archiveState: String = "uploading") = ArchiveUploadState(id, callId, fingerprint, objects.map {
        it.copy(committedOffset = offsets.getValue(it.name), state = when {
            archiveState == "complete" -> "verified"
            offsets.getValue(it.name) == it.compressedBytes -> "uploaded"
            else -> "uploading"
        })
    }, state = archiveState)
}

private class DeletedControl(private val proof: CallDeletionProof) : RecordingArchiveControl {
    var initializeCalls = 0
    override fun initialize(callId: String, manifest: JSONObject): ArchiveUploadState {
        initializeCalls++
        throw RecordingArchiveDeletedException(proof)
    }
    override fun status(uploadId: String, callId: String, manifestSha256: String, gatewayGeneration: Long): ArchiveUploadState =
        throw RecordingArchiveDeletedException(proof)
    override fun upload(uploadId: String, objectValue: ArchiveObject, source: File, offset: Long): Long = error("not reached")
    override fun finalize(uploadId: String, callId: String, manifestSha256: String, version: Int): String = error("not reached")
    override fun close() = Unit
}
