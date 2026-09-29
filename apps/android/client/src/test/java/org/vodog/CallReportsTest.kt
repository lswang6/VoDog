package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class CallReportsTest {
    @Test fun `report and all-calls rows have distinct lazy-list keys for the same call`() {
        val sharedCallId = "11111111-1111-4111-8111-111111111111"
        assertNotEquals(reportHistoryRowKey(sharedCallId), allCallsHistoryRowKey(sharedCallId))

        val reportIds = listOf(sharedCallId, "report-only")
        val historyIds = listOf(sharedCallId, "history-only")
        val siblingKeys = reportIds.map(::reportHistoryRowKey) + historyIds.map(::allCallsHistoryRowKey)
        assertEquals(siblingKeys.size, siblingKeys.toSet().size)
    }

    @Test fun callLineLabelMatchesWebNumberAndGatewayShortLabel() {
        val sim = JSONObject().put("id", "sim-1").put("label", "SIM 1").put("phoneLabel", "+8619900000101").put("gatewayId", "b3a67a31-0000")
        assertEquals("+8619900000101 · PX-b3a67a31", callLineLabel(sim))
        assertEquals("SIM 1 · DJI-b3a67a31", callLineLabel(JSONObject(sim.toString()).put("phoneLabel", "").put("gatewayKind", "dji4g")))
        assertEquals("未命名号码 · 网关待确认", callLineLabel(JSONObject().put("phoneLabel", JSONObject.NULL).put("gatewayId", JSONObject.NULL)))
        assertNull(callLineLabel(null))
    }

    @Test fun missedIncomingCallExcludesAnsweredOutgoingLiveAndBlockedCalls() {
        fun call(direction: String = "incoming", state: String = "ended", answeredAt: Any = JSONObject.NULL, reason: Any = JSONObject.NULL) =
            JSONObject().put("direction", direction).put("state", state).put("answeredAt", answeredAt).put("failureReason", reason)
        assertTrue(isMissedIncomingCall(call()))
        assertTrue(isMissedIncomingCall(call(state = "failed", reason = "no_answer")))
        assertTrue(isMissedIncomingCall(JSONObject().put("direction", "incoming").put("state", "ended")))
        assertFalse(isMissedIncomingCall(call(answeredAt = "2026-09-25T00:00:00Z")))
        assertFalse(isMissedIncomingCall(call(direction = "outgoing")))
        assertFalse(isMissedIncomingCall(call(state = "incoming_ringing")))
        assertFalse(isMissedIncomingCall(call(state = "failed", reason = "number_blocked")))
    }

    @Test fun pixelArchiveDisabledExplainsFallbackWithoutGenericRetry() {
        val message = ApiError(503, "PIXEL_ARCHIVE_DISABLED", "disabled").reportUserMessage()
        assertEquals(PIXEL_ARCHIVE_DISABLED_MESSAGE, message)
        assertTrue("服务器录音" in message)
    }

    @Test fun recordingSourceStatusDistinguishesUnavailableIncompleteAndReadyCopies() {
        assertEquals("未开启", recordingSourceStatusLabel(RemoteResource.Failed(PIXEL_ARCHIVE_DISABLED_MESSAGE)))
        assertEquals("读取失败", recordingSourceStatusLabel(RemoteResource.Failed("offline")))
        assertEquals("尚未生成", recordingSourceStatusLabel(RemoteResource.Loaded(null)))
        val ready = RecordingManifest(
            RecordingSource.MEDIA_NODE, 1, null, "call-1", "2026-09-10T00:00:00Z", true, null, emptyList()
        )
        assertEquals("可播放", recordingSourceStatusLabel(RemoteResource.Loaded(ready)))
        assertEquals("不完整", recordingSourceStatusLabel(RemoteResource.Loaded(ready.copy(archiveComplete = false))))
        assertEquals("不完整", recordingSourceStatusLabel(RemoteResource.Loaded(ready.copy(captureComplete = false))))
    }
    @Test fun reportParsesFrozenWindowAndOwnerItemShape() {
        val json = JSONObject()
            .put("window", JSONObject()
                .put("period", "7d").put("timeZone", "Europe/London")
                .put("fromInclusive", "2026-09-01T00:00:00Z").put("toExclusive", "2026-09-08T00:00:00Z"))
            .put("items", JSONArray().put(JSONObject()
                .put("callId", "call-1").put("startedAt", "2026-09-02T00:00:00Z")
                .put("direction", "incoming").put("remoteNumber", JSONObject.NULL)
                .put("sim", JSONObject().put("id", "sim-1").put("label", "Demo SIM").put("slotIndex", 0))
                .put("summary", "询价来电").put("actionItems", JSONArray().put("回电"))
                .put("advertisingClassification", "not_advertising").put("recordingStatus", "ready")
                .put("callUrl", "/api/v1/calls/call-1")
                .put("transcriptUrl", "/api/v1/calls/call-1/transcript")
                .put("recordingUrl", "/api/v1/calls/call-1/recordings")
                .put("transcriptCompletedAt", "2026-09-02T00:01:00Z")
                .put("answeredAt", "2026-09-02T00:00:10Z")
                .put("endedAt", "2026-09-02T00:01:15Z")
                .put("gatewayTimeZone", "Asia/Shanghai")))
        val report = parseCallReport(json)
        assertEquals(ReportPeriod.DAYS_7, report.window.period)
        assertEquals("Europe/London", report.window.timeZone)
        assertEquals("", report.items.single().remoteNumber)
        assertEquals(listOf("回电"), report.items.single().actionItems)
        assertEquals("Asia/Shanghai", report.items.single().gatewayTimeZone)
        assertEquals("通话时长 1 分 05 秒", talkDurationLabel(report.items.single().answeredAt, report.items.single().endedAt))
        // An S21-era row carries none of the S22 keys and must still decode, unclassified.
        val legacy = report.items.single()
        assertNull(legacy.blockRecommended)
        assertNull(legacy.blockReason)
        assertNull(legacy.answerMode)
        assertEquals(TRANSCRIPT_STATE_NONE, legacy.transcriptState)
        assertFalse(legacy.hasAiTranscript)
        assertFalse(legacy.blocked)
        assertTrue(reportClassificationUnknown(legacy))
    }

    /**
     * S22 决策 10: every call in the window gets a row, so the endpoint now returns rows with no
     * transcript at all — no `advertisingClassification`, no `transcriptCompletedAt`, and an explicit
     * `from`/`to` window with no `period`. None of that may fail the page.
     */
    @Test fun reportParsesTheS22WindowAndClassificationFields() {
        val json = JSONObject()
            .put("window", JSONObject()
                .put("timeZone", "Asia/Shanghai")
                .put("fromInclusive", "2026-09-06T00:00:00+08:00")
                .put("toExclusive", "2026-09-13T00:00:00+08:00"))
            .put("items", JSONArray()
                .put(JSONObject()
                    .put("callId", "call-ai").put("startedAt", "2026-09-12T02:00:00Z")
                    .put("direction", "incoming").put("remoteNumber", "+8619900000102")
                    .put("contactName", "张三").put("contactId", "contact-1")
                    .put("blocked", false).put("blockedEntryId", JSONObject.NULL)
                    .put("sim", JSONObject().put("id", "sim-1").put("label", "SIM1").put("slotIndex", 0))
                    .put("gatewayTimeZone", "Asia/Shanghai")
                    .put("answerMode", "ai").put("answeredByPlatform", "ai")
                    .put("recordingStatus", "complete")
                    .put("transcriptState", "succeeded")
                    .put("transcriptError", JSONObject.NULL)
                    .put("summary", "来电推销重疾险，用户已明确拒绝。")
                    .put("actionItems", JSONArray().put("无需回电"))
                    .put("classification", "advertising")
                    .put("blockRecommended", true)
                    .put("blockCategory", "insurance")
                    .put("blockReason", "保险销售")
                    .put("hasAiTranscript", true)
                    .put("transcriptCompletedAt", "2026-09-12T02:05:00Z")
                    .put("callUrl", "/api/v1/calls/call-ai")
                    .put("transcriptUrl", "/api/v1/calls/call-ai/transcript")
                    .put("recordingUrl", "/api/v1/calls/call-ai/recordings")
                    .put("aiTranscriptUrl", "/api/v1/calls/call-ai/ai-transcript")
                    .put("unseen", true))
                // A row with nothing but the identity columns: no transcript, no classification.
                .put(JSONObject()
                    .put("callId", "call-empty").put("startedAt", "2026-09-11T02:00:00Z")
                    .put("direction", "outgoing").put("remoteNumber", "10086")
                    .put("sim", JSONObject().put("id", "sim-1").put("label", "SIM1"))
                    .put("transcriptState", "failed")
                    .put("transcriptError", JSONObject().put("code", "RECORDING_EMPTY"))))
        val report = parseCallReport(json)
        assertNull("an explicit from/to window reports no preset", report.window.period)
        assertEquals("Asia/Shanghai", report.window.timeZone)

        val ai = report.items.first()
        assertTrue(reportShowsUnseenDot(ai, emptySet()))
        assertFalse(reportShowsUnseenDot(ai, setOf("call-ai")))
        assertFalse(reportShowsUnseenDot(report.items[1], emptySet())) // old Control: no field
        assertEquals("张三", ai.contactName)
        assertEquals("ai", ai.answerMode)
        assertEquals("AI 接听", reportAnswerModeLabel(ai.answerMode, ai.answeredByPlatform, ai.answeredAt))
        assertEquals(true, ai.blockRecommended)
        assertEquals("保险销售", ai.blockReason)
        assertEquals("insurance", ai.blockCategory)
        assertEquals("advertising", ai.classification)
        assertTrue(ai.hasAiTranscript)
        assertEquals("succeeded", ai.transcriptState)
        assertNull(ai.transcriptErrorCode)
        assertNull("succeeded shows the real summary", reportSummaryPlaceholder(ai.transcriptState))

        val empty = report.items[1]
        assertEquals(0, empty.sim.slotIndex)
        assertEquals("unknown", empty.advertisingClassification)
        assertEquals("", empty.transcriptCompletedAt)
        assertEquals("", empty.recordingStatus)
        assertEquals(emptyList<String>(), empty.actionItems)
        assertEquals("RECORDING_EMPTY", empty.transcriptErrorCode)
        assertEquals("转录失败，原始录音仍可查看", reportSummaryPlaceholder(empty.transcriptState))
        assertTrue(reportClassificationUnknown(empty))
    }

    @Test fun gatewayDisplayUsesCallThenSimThenShanghaiAndNeverBeijing() {
        assertEquals("Asia/Shanghai", DEFAULT_GATEWAY_TIME_ZONE)
        assertFalse(isIanaTimeZone("Invalid/Zone"))
        assertFalse(isIanaTimeZone("UTC+8"))
        assertEquals("Asia/Shanghai", gatewayDisplayTimeZone("Invalid/Zone", "UTC+8", null))
        assertEquals("Asia/Tokyo", gatewayDisplayTimeZone("Invalid/Zone", "Asia/Tokyo"))
        assertEquals("2026-09-02 08:00", formatGatewayDateTime("2026-09-02T00:00:00Z", "Asia/Shanghai"))
        assertEquals("2026-09-02 08:00", formatGatewayDateTime("2026-09-02T00:00:00Z", "Invalid/Zone"))
        assertEquals("2026-09-01 20:00", formatGatewayDateTime("2026-09-02T00:00:00Z", "America/New_York"))
        assertNull(talkDurationLabel(null, "2026-09-02T00:01:00Z"))
        assertNull(talkDurationLabel("2026-09-02T00:00:00Z", null))
        assertEquals("通话时长 0 秒", talkDurationLabel("2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z"))
        assertEquals("通话时长 2 分 05 秒", talkDurationLabel("2026-09-02T00:00:00Z", "2026-09-02T00:02:05Z"))
        assertEquals("0:05", formatPlayerTime(5_000))
        assertEquals("1:01", formatPlayerTime(61_000))
        assertEquals("transcript:call-1", historyDetailKey(HistoryViewerKind.TRANSCRIPT, "call-1"))
        assertNotEquals(
            historyDetailKey(HistoryViewerKind.TRANSCRIPT, "call-1"),
            historyDetailKey(HistoryViewerKind.RECORDING, "call-1", RecordingSource.MEDIA_NODE),
        )
        assertEquals(
            "call-call-1-pixel-caller_playout.wav",
            recordingAttachmentFileName("call-1", RecordingSource.PIXEL, RecordingAudioTrack.CALLER_PLAYOUT, "audio/wav"),
        )
        assertEquals(
            "call-call-1-media_node-remote_original.ogg",
            recordingAttachmentFileName("call-1", RecordingSource.MEDIA_NODE, RecordingAudioTrack.REMOTE_ORIGINAL, "audio/ogg"),
        )
        val call = JSONObject()
            .put("id", "call-1")
            .put("startedAt", "2026-09-02T00:00:00Z")
            .put("direction", "incoming")
            .put("remoteNumber", "+12025550123")
            .put("simId", "sim-1")
            .put("answeredAt", JSONObject.NULL)
            .put("endedAt", JSONObject.NULL)
            .put("gatewayTimeZone", "Invalid/Zone")
        val sim = JSONObject().put("label", "Demo SIM").put("phoneLabel", "Demo line").put("slotIndex", 1).put("timeZone", "Europe/London")
        val item = parseCallHistoryItem(call, sim)
        assertEquals("Demo line", item.sim.label)
        assertEquals("Europe/London", item.gatewayTimeZone)
        assertNull(talkDurationLabel(item.answeredAt, item.endedAt))
        assertEquals("Europe/London", jsonDisplayTimeZone(JSONObject().put("gatewayTimeZone", "Invalid/Zone"), "Europe/London"))
    }

    @Test fun transcriptKeepsBothOriginalTrackDirectionsAndAiResult() {
        val result = JSONObject()
            .put("text", "hello reply")
            .put("segments", JSONArray()
                .put(segment("remote_original", "customer", "hello", 0, 400))
                .put(segment("caller_original", "owner", "reply", 500, 900)))
            .put("providers", JSONArray().put(JSONObject()
                .put("track", "remote_original").put("provider", "xai")
                .put("model", "model-1").put("version", JSONObject.NULL)))
            .put("advertisingClassification", "advertising")
            .put("includeInReports", false)
            .put("summary", "广告内容")
            .put("actionItems", JSONArray())
        val envelope = JSONObject().put("transcript", JSONObject()
            .put("id", "tr-1").put("callId", "call-1").put("status", "succeeded").put("attempts", 1)
            .put("nextAttemptAt", JSONObject.NULL).put("error", JSONObject.NULL).put("result", result)
            .put("createdAt", "now").put("updatedAt", "now").put("completedAt", "now"))
        val transcript = requireNotNull(parseCallTranscript(envelope))
        val parsed = requireNotNull(transcript.result)
        assertEquals(OriginalTranscriptTrack.REMOTE_ORIGINAL, parsed.segments[0].track)
        assertEquals(OriginalTranscriptTrack.CALLER_ORIGINAL, parsed.segments[1].track)
        assertFalse(parsed.includeInReports)
        assertEquals("xai", parsed.providers.single().provider)
    }

    @Test fun nullTranscriptIsAnExplicitAbsentState() {
        assertNull(parseCallTranscript(JSONObject().put("transcript", JSONObject.NULL)))
    }

    @Test fun transcriptMergesPerWordSegmentsIntoOneReadableBlockPerTrack() {
        val words = "尊敬的客户，欢迎致电中国电信".map { it.toString() }
        val segments = words.mapIndexed { index, word ->
            TranscriptSegment(OriginalTranscriptTrack.REMOTE_ORIGINAL, "remote", word,
                index * 200.0, index * 200.0 + 200)
        }
        val blocks = mergeTranscriptSegments(segments)
        assertEquals(1, blocks.size)
        assertEquals("尊敬的客户，欢迎致电中国电信", blocks.single().text)
        assertEquals(0.0, blocks.single().startMs)
        assertEquals(OriginalTranscriptTrack.REMOTE_ORIGINAL, blocks.single().track)
    }

    @Test fun transcriptBlocksKeepTracksAndSpeakersApartAndSkipBlankText() {
        val segments = listOf(
            TranscriptSegment(OriginalTranscriptTrack.REMOTE_ORIGINAL, "remote", "你好", 0.0, 400.0),
            TranscriptSegment(OriginalTranscriptTrack.CALLER_ORIGINAL, "vodog_user", "你好，", 500.0, 700.0),
            TranscriptSegment(OriginalTranscriptTrack.CALLER_ORIGINAL, "vodog_user", "请问有什么可以帮您", 700.0, 1_400.0),
            TranscriptSegment(OriginalTranscriptTrack.CALLER_ORIGINAL, "spk_2", "另一人", 1_500.0, 1_900.0),
            TranscriptSegment(OriginalTranscriptTrack.REMOTE_ORIGINAL, "remote", "   ", null, null),
        )
        val blocks = mergeTranscriptSegments(segments)
        assertEquals(listOf("你好", "你好，请问有什么可以帮您", "另一人"), blocks.map { it.text })
        assertEquals(
            listOf(
                OriginalTranscriptTrack.REMOTE_ORIGINAL,
                OriginalTranscriptTrack.CALLER_ORIGINAL,
                OriginalTranscriptTrack.CALLER_ORIGINAL,
            ),
            blocks.map { it.track },
        )
        assertEquals("Hello world", joinTranscriptText(listOf("Hello", "world")))
        assertEquals("你好", joinTranscriptText(listOf("你", "好")))
        assertEquals("Hello 世界", joinTranscriptText(listOf("Hello", "世界")))
        assertEquals("你好，世界", joinTranscriptText(listOf("你好", "，", "世界")))
    }

    @Test fun transcriptPollsQueuedRunningRetryOnly() {
        assertTrue(transcriptStatusIsInFlight("queued"))
        assertTrue(transcriptStatusIsInFlight("running"))
        assertTrue(transcriptStatusIsInFlight("retry"))
        assertFalse(transcriptStatusIsInFlight("succeeded"))
        assertFalse(transcriptStatusIsInFlight("failed"))
        assertFalse(transcriptStatusIsInFlight(null))
    }

    @Test fun staleRequestGuardRejectsOldOwnerFilterAndCallResponses() {
        val guard = AsyncRequestGuard()
        val old = guard.next(4, "7d|Europe/London")
        val current = guard.next(4, "1m|Europe/London")
        assertFalse(guard.accepts(old, 4, old.key))
        assertTrue(guard.accepts(current, 4, current.key))
        assertFalse(guard.accepts(current, 5, current.key))
        assertFalse(guard.accepts(current, 4, "other-call"))
    }

    @Test fun deviceTimeZoneUsesIanaIdentifier() {
        assertEquals("Europe/London", deviceReportTimeZone(ZoneId.of("Europe/London")))
    }

    @Test fun recordingManifestRequiresExactOwnerCallAndAllFixedArtifacts() {
        val artifacts = JSONArray()
        listOf("remote_original.ogg", "caller_original.ogg", "timeline.jsonl").forEach {
            artifacts.put(JSONObject().put("name", it).put("bytes", 12).put("sha256", "a".repeat(64)))
        }
        val envelope = JSONObject().put("recording", JSONObject()
            .put("version", 1).put("callId", "call-1").put("finalizedAt", "2026-09-10T00:00:00Z")
            .put("complete", true).put("artifacts", artifacts))
        val manifest = requireNotNull(parseRecordingManifest(envelope, "call-1", RecordingSource.MEDIA_NODE))
        assertEquals(12L, manifest.artifact(OriginalTranscriptTrack.REMOTE_ORIGINAL)?.bytes)
        assertNull(manifest.artifact(OriginalTranscriptTrack.REMOTE_ORIGINAL)?.durationMs)
        assertNull(manifest.pairDurationMs(RecordingPairMode.ORIGINALS))
        assertTrue(runCatching { parseRecordingManifest(envelope, "other-call", RecordingSource.MEDIA_NODE) }.isFailure)
        assertTrue(runCatching { parseRecordingManifest(envelope, "call-1", RecordingSource.PIXEL) }.isFailure)
    }

    @Test fun pixelRecordingRequiresExactV2WavIdentityAndPreservesCaptureQuality() {
        val callId = "11111111-1111-4111-8111-111111111111"
        val tracks = JSONArray().apply {
            put(pixelTrack("remote_original", true, 0, 0))
            put(pixelTrack("caller_original", false, 2, 3))
        }
        val recording = JSONObject()
            .put("source", "pixel").put("version", 2)
            .put("archiveId", "22222222-2222-4222-8222-222222222222")
            .put("callId", callId).put("archiveComplete", true).put("captureComplete", false)
            .put("startedAt", "2026-09-10T00:00:00Z").put("endedAt", "2026-09-10T00:01:00Z")
            .put("tracks", tracks)
            .put("timeline", JSONObject().put("mediaType", "application/x-ndjson").put("bytes", 90).put("sha256", "b".repeat(64)))
        val manifest = requireNotNull(parseRecordingManifest(JSONObject().put("recording", recording), callId, RecordingSource.PIXEL))
        assertEquals(RecordingSource.PIXEL, manifest.source)
        assertFalse(manifest.captureComplete!!)
        assertEquals(2L, manifest.artifact(OriginalTranscriptTrack.CALLER_ORIGINAL)?.gapCount)
        assertTrue(runCatching {
            parseRecordingManifest(JSONObject().put("recording", JSONObject(recording.toString()).put("captureComplete", true)), callId, RecordingSource.PIXEL)
        }.isFailure)
        assertTrue(runCatching {
            val wrong = JSONObject(recording.toString()).put("version", 1)
            parseRecordingManifest(JSONObject().put("recording", wrong), callId, RecordingSource.PIXEL)
        }.isFailure)
        listOf(
            JSONObject(recording.toString()).put("version", 2.5),
            JSONObject(recording.toString()).put("captureComplete", "true"),
            JSONObject(recording.toString()).also {
                it.getJSONArray("tracks").getJSONObject(0).put("bytes", 45.5)
            },
        ).forEach { invalid ->
            assertTrue(runCatching {
                parseRecordingManifest(JSONObject().put("recording", invalid), callId, RecordingSource.PIXEL)
            }.isFailure)
        }
    }

    @Test fun pixelV3KeepsOriginalAndCompensatedPairsSeparate() {
        val callId = "11111111-1111-4111-8111-111111111111"
        val recording = JSONObject()
            .put("source", "pixel").put("version", 3)
            .put("archiveId", "22222222-2222-4222-8222-222222222222")
            .put("callId", callId).put("manifestSha256", "c".repeat(64))
            .put("archiveComplete", true).put("captureComplete", false)
            .put("startedAt", "2026-09-10T00:00:00Z").put("endedAt", "2026-09-10T00:01:00Z")
            .put("tracks", JSONArray()
                .put(pixelTrack("remote_original", true, 0, 0).put("sourceRole", "original_capture").put("durationMs", 8_000))
                .put(pixelTrack("caller_original", false, 2, 3).put("sourceRole", "original_capture").put("durationMs", 7_500)))
            .put("derivedTracks", JSONArray().put(JSONObject()
                .put("track", "caller_playout").put("sourceRole", "derived_playout")
                .put("mediaType", "audio/wav").put("bytes", 3044).put("sha256", "d".repeat(64))
                .put("playoutComplete", true).put("gapCount", 0).put("recoveryFrames", 2).put("durationMs", 12_000)))
            .put("timeline", JSONObject().put("mediaType", "application/x-ndjson").put("bytes", 90).put("sha256", "b".repeat(64)))

        val manifest = requireNotNull(parseRecordingManifest(JSONObject().put("recording", recording), callId, RecordingSource.PIXEL))
        assertEquals(3, manifest.version)
        assertFalse(manifest.captureComplete!!)
        assertEquals(
            listOf(RecordingAudioTrack.REMOTE_ORIGINAL, RecordingAudioTrack.CALLER_ORIGINAL),
            manifest.pairArtifacts(RecordingPairMode.ORIGINALS).map { it.track },
        )
        assertEquals(
            listOf(RecordingAudioTrack.REMOTE_ORIGINAL, RecordingAudioTrack.CALLER_PLAYOUT),
            manifest.pairArtifacts(RecordingPairMode.COMPENSATED).map { it.track },
        )
        val derived = requireNotNull(manifest.artifact(RecordingAudioTrack.CALLER_PLAYOUT))
        assertEquals("derived_playout", derived.sourceRole)
        assertTrue(derived.playoutComplete!!)
        assertEquals(2L, derived.recoveryFrames)
        assertEquals(12_000L, derived.durationMs)
        assertEquals(8_000L, manifest.pairDurationMs(RecordingPairMode.ORIGINALS))
        assertEquals(12_000L, manifest.pairDurationMs(RecordingPairMode.COMPENSATED))
        assertEquals(2L, manifest.artifact(OriginalTranscriptTrack.CALLER_ORIGINAL)?.gapCount)
    }

    @Test fun pixelVersionsRejectDerivedSubstitutionAndInvalidV3Roles() {
        val callId = "11111111-1111-4111-8111-111111111111"
        val v2 = JSONObject()
            .put("source", "pixel").put("version", 2)
            .put("archiveId", "22222222-2222-4222-8222-222222222222")
            .put("callId", callId).put("archiveComplete", true).put("captureComplete", true)
            .put("startedAt", "2026-09-10T00:00:00Z").put("endedAt", "2026-09-10T00:01:00Z")
            .put("tracks", JSONArray()
                .put(pixelTrack("remote_original", true, 0, 0))
                .put(pixelTrack("caller_original", true, 0, 0)))
            .put("timeline", JSONObject().put("mediaType", "application/x-ndjson").put("bytes", 90).put("sha256", "b".repeat(64)))
        assertTrue(runCatching {
            parseRecordingManifest(
                JSONObject().put("recording", JSONObject(v2.toString()).put("derivedTracks", JSONArray())),
                callId,
                RecordingSource.PIXEL,
            )
        }.isFailure)

        val invalidV3 = JSONObject(v2.toString()).put("version", 3).put("manifestSha256", "c".repeat(64))
            .put("derivedTracks", JSONArray().put(JSONObject()
                .put("track", "caller_playout").put("sourceRole", "derived_playout")
                .put("mediaType", "audio/wav").put("bytes", 3044).put("sha256", "d".repeat(64))
                .put("playoutComplete", true).put("gapCount", 0).put("recoveryFrames", 2)))
        assertTrue(runCatching {
            parseRecordingManifest(JSONObject().put("recording", invalidV3), callId, RecordingSource.PIXEL)
        }.isFailure)
    }

    private fun pixelTrack(track: String, complete: Boolean, gaps: Long, drops: Long) = JSONObject()
        .put("track", track).put("mediaType", "audio/wav").put("bytes", 2044)
        .put("sha256", "a".repeat(64)).put("captureComplete", complete)
        .put("gapCount", gaps).put("droppedFrames", drops)

    private fun segment(track: String, speaker: String, text: String, start: Long, end: Long) = JSONObject()
        .put("track", track).put("speaker", speaker).put("text", text).put("startMs", start).put("endMs", end)
}
