import XCTest
@testable import VoDog

final class RecordsUXTests: XCTestCase {
    func testTranscriptPollsQueuedRunningRetryOnly() {
        XCTAssertTrue(TranscriptPollPolicy.shouldPoll("queued"))
        XCTAssertTrue(TranscriptPollPolicy.shouldPoll("running"))
        XCTAssertTrue(TranscriptPollPolicy.shouldPoll("retry"))
        XCTAssertFalse(TranscriptPollPolicy.shouldPoll("succeeded"))
        XCTAssertFalse(TranscriptPollPolicy.shouldPoll("failed"))
        XCTAssertEqual(TranscriptPollPolicy.interval, .seconds(5))
    }

    func testTranscriptSegmentCaptionMatchesWebTrackAndStart() throws {
        let remote = TranscriptSegment(
            track: "remote_original", speaker: "remote", text: "你好", startMs: 65_000, endMs: 70_000
        )
        let caller = TranscriptSegment(
            track: "caller_original", speaker: "vodog_user", text: "在", startMs: 1_500, endMs: nil
        )
        let other = TranscriptSegment(
            track: "other", speaker: "unknown", text: "…", startMs: nil, endMs: nil
        )
        XCTAssertEqual(remote.playbackCaption, "对方原声 · 1:05")
        XCTAssertEqual(caller.playbackCaption, "我的原声 · 0:01")
        XCTAssertEqual(other.playbackCaption, "其他声轨")
    }

    func testPlaybackClockUsesDurationMsNotAnsweredEndedSpan() {
        XCTAssertEqual(PlaybackClock.formatMilliseconds(12_000), "0:12")
        XCTAssertEqual(PlaybackClock.formatMilliseconds(0), "0:00")
        XCTAssertNil(PlaybackClock.formatMilliseconds(nil))
        XCTAssertEqual(
            GatewayTimeDisplay.talkSeconds(
                answeredAt: "2026-09-10T16:00:00Z",
                endedAt: "2026-09-10T16:01:05Z"
            ),
            65
        )
        XCTAssertNotEqual(PlaybackClock.formatMilliseconds(12_000), PlaybackClock.format(65))
    }

    func testAttachmentFilenameUsesQuotedHeaderOtherwiseNativeFallback() {
        let callID = "00000000-0000-4000-8000-000000000001"
        XCTAssertEqual(
            RecordingAttachmentName.filename(
                callID: callID, source: .mediaNode, track: "remote_original",
                header: #"attachment; filename="call-00000000-0000-4000-8000-000000000001-media_node-remote_original.ogg""#
            ),
            "call-00000000-0000-4000-8000-000000000001-media_node-remote_original.ogg"
        )
        XCTAssertEqual(
            RecordingAttachmentName.filename(
                callID: callID, source: .pixel, track: "caller_playout",
                header: #"attachment; filename="evil.bin""#
            ),
            "call-00000000-0000-4000-8000-000000000001-pixel-caller_playout.wav"
        )
        XCTAssertEqual(
            RecordingAttachmentName.filename(
                callID: callID, source: .mediaNode, track: "caller_original", header: nil
            ),
            "call-00000000-0000-4000-8000-000000000001-media_node-caller_original.ogg"
        )
    }

    func testPlaybackCacheKeepsSHAFileAndSkipsUnrelatedTemp() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("vodog-sha-cache-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RecordingPlaybackCache(directory: directory)
        let sha = String(repeating: "ab", count: 32)
        let sourceURL = FileManager.default.temporaryDirectory.appendingPathComponent("probe-\(UUID().uuidString).ogg")
        let payload = Data("ogg-bytes".utf8)
        try payload.write(to: sourceURL)
        XCTAssertNil(cache.existingURL(sha256: sha, bytes: Int64(payload.count), source: .mediaNode))
        let stored = try cache.store(sourceURL, sha256: sha, source: .mediaNode)
        XCTAssertTrue(cache.contains(stored))
        XCTAssertEqual(try Data(contentsOf: stored), payload)
        XCTAssertEqual(cache.existingURL(sha256: sha, bytes: Int64(payload.count), source: .mediaNode), stored)
        XCTAssertNil(cache.existingURL(sha256: sha, bytes: Int64(payload.count) + 1, source: .mediaNode))
        let stray = FileManager.default.temporaryDirectory.appendingPathComponent("vodog-recording-\(UUID().uuidString).ogg")
        XCTAssertFalse(cache.contains(stray))
    }

    func testGatewayRetryClockNeverUsesProcessTimeZone() {
        let text = GatewayTimeDisplay.compact(
            "2026-09-10T16:00:00Z",
            timeZone: GatewayTimeDisplay.resolvedTimeZone(callZone: "Asia/Shanghai")
        )
        XCTAssertEqual(text, "2026-09-11 00:00")
        XCTAssertEqual(GatewayTimeDisplay.fallbackIANA, "Asia/Shanghai")
        XCTAssertNil(TimeZone(identifier: "Asia/Beijing"))
    }

    func testPerWordSegmentsMergeIntoOneReadableBlockPerTrack() {
        let words = "尊敬的客户，欢迎致电中国电信".map { String($0) }
        let segments = words.enumerated().map { index, word in
            TranscriptSegment(track: "remote_original", speaker: "remote", text: word,
                startMs: Double(index) * 200, endMs: Double(index) * 200 + 200)
        }
        let blocks = TranscriptText.blocks(from: segments)
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks.first?.text, "尊敬的客户，欢迎致电中国电信")
        XCTAssertEqual(blocks.first?.trackTitle, "对方原声")
        XCTAssertEqual(blocks.first?.startMs, 0)
    }

    func testHistoryRowActionsDisableWhenRemoteOrSIMMissingAndWhenMediaLive() {
        XCTAssertFalse(HistoryRowActionPolicy.canRedial(remoteNumber: nil, simId: "sim", mediaLive: false))
        XCTAssertFalse(HistoryRowActionPolicy.canRedial(remoteNumber: "2025550102", simId: nil, mediaLive: false))
        XCTAssertFalse(HistoryRowActionPolicy.canRedial(remoteNumber: "2025550102", simId: "sim", mediaLive: true))
        XCTAssertTrue(HistoryRowActionPolicy.canRedial(remoteNumber: "2025550102", simId: "sim", mediaLive: false))
        XCTAssertFalse(HistoryRowActionPolicy.canRedial(remoteNumber: "5", simId: "sim", mediaLive: false))
        XCTAssertFalse(HistoryRowActionPolicy.canSendSMS(remoteNumber: nil, simId: "sim"))
        XCTAssertTrue(HistoryRowActionPolicy.canSendSMS(remoteNumber: "2025550102", simId: "sim"))
        XCTAssertFalse(HistoryRowActionPolicy.canBlock(remoteNumber: nil))
        XCTAssertFalse(HistoryRowActionPolicy.canBlock(remoteNumber: "112"))
        XCTAssertFalse(HistoryRowActionPolicy.canBlock(remoteNumber: "911"))
        XCTAssertTrue(HistoryRowActionPolicy.canBlock(remoteNumber: "2025550102"))
        XCTAssertEqual(HistoryRowActionPolicy.redialTitle, "回拨")
        XCTAssertEqual(HistoryRowActionPolicy.smsTitle, "发短信")
        XCTAssertEqual(HistoryRowActionPolicy.blockTitle, "屏蔽")
    }

    /// S22 decision 10 / R3 §6: 拉黑 is gone. The history row and the contact card are the same action and
    /// must not be described two different ways in the same app.
    func testHistoryBlockConfirmationCopyMatchesTheContactCard() {
        XCTAssertEqual(HistoryRowActionPolicy.blockConfirmationTitle, "屏蔽此号码？")
        XCTAssertEqual(HistoryRowActionPolicy.blockConfirmationTitle, ContactCardActionPolicy.blockConfirmTitle)
        XCTAssertEqual(HistoryRowActionPolicy.blockConfirmationMessage, ContactCardActionPolicy.blockConfirmMessage)
        XCTAssertFalse(HistoryRowActionPolicy.blockConfirmationTitle.contains("拉黑"))
        XCTAssertFalse(HistoryRowActionPolicy.blockConfirmationMessage.contains("拉黑"))
        XCTAssertFalse(HistoryRowActionPolicy.blockTitle.contains("拉黑"))
    }

    func testFailureReasonHidesInternalReclaimCodesWhenConnected() {
        XCTAssertNil(FailureReasonDisplayPolicy.visibleReason(
            failureReason: "device_snapshot_confirmed_absent",
            state: "ended",
            answeredAt: "2026-09-09T00:00:01Z",
            recordingStatus: "none"
        ))
        XCTAssertNil(FailureReasonDisplayPolicy.visibleReason(
            failureReason: "device_snapshot_stale_lock_reclaimed",
            state: "ended",
            answeredAt: nil,
            recordingStatus: "uploaded"
        ))
        XCTAssertNil(FailureReasonDisplayPolicy.visibleReason(
            failureReason: "device_snapshot_confirmed_never_started",
            state: "ended",
            answeredAt: nil,
            recordingStatus: nil,
            transcript: "hello"
        ))
        XCTAssertNil(
            FailureReasonDisplayPolicy.visibleReason(
                failureReason: "device_snapshot_confirmed_absent",
                state: "failed",
                answeredAt: nil,
                recordingStatus: "none"
            )
        )
        XCTAssertEqual(
            FailureReasonDisplayPolicy.visibleReason(
                failureReason: "command_expired",
                state: "failed",
                answeredAt: nil,
                recordingStatus: nil
            ),
            "command_expired"
        )
    }

    func testTranscriptBlocksKeepTracksAndSpeakersApart() {
        let segments = [
            TranscriptSegment(track: "remote_original", speaker: "remote", text: "你好", startMs: 0, endMs: 400),
            TranscriptSegment(track: "caller_original", speaker: "vodog_user", text: "你好，", startMs: 500, endMs: 700),
            TranscriptSegment(track: "caller_original", speaker: "vodog_user", text: "请问有什么可以帮您", startMs: 700, endMs: 1_400),
            TranscriptSegment(track: "caller_original", speaker: "spk_2", text: "另一人", startMs: 1_500, endMs: 1_900),
            TranscriptSegment(track: "remote_original", speaker: "remote", text: "   ", startMs: nil, endMs: nil),
        ]
        let blocks = TranscriptText.blocks(from: segments)
        XCTAssertEqual(blocks.map(\.text), ["你好", "你好，请问有什么可以帮您", "另一人"])
        XCTAssertEqual(blocks.map(\.track), ["remote_original", "caller_original", "caller_original"])
        XCTAssertEqual(blocks[0].trackTitle, "对方原声")
        XCTAssertEqual(blocks[1].trackTitle, "我的原声")
        XCTAssertEqual(TranscriptText.join(["Hello", "world"]), "Hello world")
        XCTAssertEqual(TranscriptText.join(["你", "好"]), "你好")
        XCTAssertEqual(TranscriptText.join(["Hello", "世界"]), "Hello 世界")
        XCTAssertEqual(TranscriptText.join(["你好", "，", "世界"]), "你好，世界")
    }

    func testDialableMirrorsControlOutboundNumberRule() {
        for ok in ["10086", "123", "202555010212345", "+86", "+12025550102", "+123456789012345"] {
            XCTAssertTrue(PhoneNumberText.isDialable(ok), ok)
        }
        for bad in ["", "5", "12", "2025550102123456", "+", "+0123", "+1234567890123456", "*#06#", "10086#", "112", "911"] {
            XCTAssertFalse(PhoneNumberText.isDialable(bad), bad)
        }
        XCTAssertTrue(PhoneNumberText.isDialable(PhoneNumberText.normalized(" 202-555-0102 ")))
    }

    func testDialErrorsAreChinese() {
        XCTAssertEqual(APIError.dialMessage(for: APIError.server(400, "Request validation failed", "INVALID_REQUEST")), "号码格式不正确，无法拨打")
        XCTAssertEqual(APIError.dialMessage(for: APIError.server(401, "Sign in again before starting a call", "SESSION_UPGRADE_REQUIRED")), "拨打失败（SESSION_UPGRADE_REQUIRED）")
        XCTAssertEqual(APIError.dialMessage(for: APIError.server(500, "", nil)), "请求失败（500）")
        XCTAssertEqual(APIError.dialMessage(for: APIError.server(409, "请刷新 VoDog 后再拨打或接听电话", "CLIENT_UPGRADE_REQUIRED")), "请刷新 VoDog 后再拨打或接听电话")
        XCTAssertEqual(APIError.dialMessage(for: APIError.server(409, "x", "SAME_DEVICE_INTERNAL")), "同一设备上的两张卡不能互打")
    }
}
