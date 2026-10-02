import XCTest
@testable import VoDog

/// S95 presentation helpers: compact list time, day sections, client-side verification code detection.
final class SignalPresentationTests: XCTestCase {
    private let zone = TimeZone(identifier: "Asia/Shanghai")!
    private let now = GatewayTimeDisplay.parseISO("2026-10-02T12:00:00+08:00")!

    func testCompactTime() {
        XCTAssertEqual(CompactTime.text("2026-10-02T09:05:00+08:00", zone: zone, now: now), "09:05")
        XCTAssertEqual(CompactTime.text("2026-10-01T23:49:00+08:00", zone: zone, now: now), "昨天")
        XCTAssertEqual(CompactTime.text("2026-09-28T10:00:00+08:00", zone: zone, now: now), "周一")
        XCTAssertEqual(CompactTime.text("2026-08-15T10:00:00+08:00", zone: zone, now: now), "8/15")
        XCTAssertEqual(CompactTime.text("2025-12-31T10:00:00+08:00", zone: zone, now: now), "2025/12/31")
        XCTAssertEqual(CompactTime.text(nil, zone: zone, now: now), "—")
    }

    func testDayTitles() {
        XCTAssertEqual(RecordDaySection.dayTitle("2026-10-02T01:00:00+08:00", zone: zone, now: now), "今天")
        XCTAssertEqual(RecordDaySection.dayTitle("2026-10-01T01:00:00+08:00", zone: zone, now: now), "昨天")
        XCTAssertEqual(RecordDaySection.dayTitle("2026-09-20T01:00:00+08:00", zone: zone, now: now), "9月20日")
    }

    func testVerificationCodeNeedsKeywordAndDigitRun() {
        XCTAssertEqual(VerificationCodeText.code(in: "【某服务】验证码 123456，5 分钟内有效"), "123456")
        XCTAssertEqual(VerificationCodeText.code(in: "Your code is 4821"), "4821")
        XCTAssertNil(VerificationCodeText.code(in: "账单金额 123456 元"))
        XCTAssertNil(VerificationCodeText.code(in: "验证码已发送"))
        XCTAssertNil(VerificationCodeText.code(in: "验证码 123456789012"))
        XCTAssertNil(VerificationCodeText.code(in: nil))
    }

    // MARK: - S95b §A AiBadge

    func testAiBadgeTextAndAccessibility() {
        XCTAssertNil(AiBadge(mode: "normal"))
        XCTAssertNil(AiBadge(mode: nil))
        XCTAssertNil(AiBadge(mode: "unknown_mode"))
        XCTAssertEqual(AiBadge.text(mode: "ai", timeoutSeconds: nil, full: false), "AI")
        XCTAssertEqual(AiBadge.text(mode: "timeout_ai", timeoutSeconds: 18, full: false), "AI")
        XCTAssertEqual(AiBadge.text(mode: "ai", timeoutSeconds: 18, full: true), "AI 代接")
        XCTAssertEqual(AiBadge.text(mode: "timeout_ai", timeoutSeconds: 18, full: true), "AI · 18 秒后")
        XCTAssertEqual(AiBadge.text(mode: "timeout_ai", timeoutSeconds: nil, full: true), "AI 兜底")
        XCTAssertEqual(AiBadge.accessibility(mode: "ai", timeoutSeconds: nil), "AI 代接已开启，立即由 AI 接听")
        XCTAssertEqual(AiBadge.accessibility(mode: "timeout_ai", timeoutSeconds: 18),
                       "AI 代接已开启，响铃 18 秒无人接听后由 AI 接听")
        XCTAssertNil(AiBadge.accessibility(mode: "normal", timeoutSeconds: 18))
    }

    // MARK: - S95b §C no technical ids on screen

    func testTranscriptCaptionsNeverShowProviderOrModelIds() throws {
        let result = try JSONDecoder().decode(TranscriptResult.self, from: Data(#"{"text":"内容","segments":[],"providers":[{"track":"remote_original","provider":"openai-compatible","model":"gemini-3.8-flash-low","version":"v1"}],"advertisingClassification":"none","includeInReports":true,"summary":null,"actionItems":[]}"#.utf8))
        let shown = TranscriptDisplayPolicy.captionLines(result).joined(separator: "\n")
        XCTAssertFalse(shown.isEmpty)
        for id in ["openai-compatible", "gemini", "flash-low", "v1", "remote_original"] {
            XCTAssertFalse(shown.contains(id), "transcript caption leaked \(id)")
        }
        XCTAssertFalse(TranscriptDisplayPolicy.unknownStatusTitle.contains("_"))
    }
}
