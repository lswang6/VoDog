import XCTest
@testable import VoDog

/// S22 决策 4 / 10 / 11 的客户端规则。iOS 是三端参考实现，所以这些断言就是 Android/Web 要对齐的合同。
final class S22ClientPolicyTests: XCTestCase {

    // MARK: - 决策 4：AI 即接不响铃

    private func call(answerMode: String?, aiHandling: Bool?, state: String? = "incoming_ringing") -> CallRecord {
        CallRecord(
            id: "c1", simId: "s1", direction: "incoming", remoteNumber: "2025550101", state: state,
            startedAt: "2026-09-11T14:57:43.689Z", answeredAt: nil, endedAt: nil, answeredByPlatform: nil,
            answeredByDevice: nil, originatingPlatform: nil, claimedByCurrentSession: nil, failureReason: nil,
            recordingStatus: nil, transcript: nil, gatewayTimeZone: "Asia/Shanghai", occupancy: nil,
            contactId: nil, contactName: nil, blocked: nil, blockedEntryId: nil,
            answerMode: answerMode, aiHandling: aiHandling, aiTriggerAt: nil
        )
    }

    func testMissedIncomingIsUnansweredEndedIncomingButNotBlocked() {
        func record(direction: String = "incoming", state: String = "ended", answeredAt: String? = nil,
                    failureReason: String? = nil) -> CallRecord {
            CallRecord(
                id: "c1", simId: "s1", direction: direction, remoteNumber: "2025550101", state: state,
                startedAt: nil, answeredAt: answeredAt, endedAt: nil, answeredByPlatform: nil, answeredByDevice: nil,
                originatingPlatform: nil, claimedByCurrentSession: nil, failureReason: failureReason,
                recordingStatus: nil, transcript: nil, gatewayTimeZone: nil, occupancy: nil, contactId: nil,
                contactName: nil, blocked: nil, blockedEntryId: nil
            )
        }
        XCTAssertTrue(record().isMissedIncoming)
        XCTAssertTrue(record(state: "failed", answeredAt: "").isMissedIncoming)
        XCTAssertEqual(record().rowStateTitle, "未接来电")
        XCTAssertFalse(record(answeredAt: "2026-09-25T01:00:00Z").isMissedIncoming)
        XCTAssertFalse(record(direction: "outgoing").isMissedIncoming)
        XCTAssertFalse(record(state: "incoming_ringing").isMissedIncoming)
        XCTAssertFalse(record(failureReason: "number_blocked").isMissedIncoming)
        XCTAssertEqual(record(direction: "outgoing").rowStateTitle, "已结束")
    }

    func testSuppressionNeedsBothAiModeAndAnActiveRun() {
        XCTAssertTrue(call(answerMode: "ai", aiHandling: true).suppressesRinging)
        XCTAssertFalse(call(answerMode: "ai", aiHandling: false).suppressesRinging)
        XCTAssertFalse(call(answerMode: "ai", aiHandling: nil).suppressesRinging)
        // 超时代接仍然响铃，人可以在计时器触发前抢接。
        XCTAssertFalse(call(answerMode: "timeout_ai", aiHandling: true).suppressesRinging)
        XCTAssertFalse(call(answerMode: "normal", aiHandling: true).suppressesRinging)
        XCTAssertFalse(call(answerMode: nil, aiHandling: nil).suppressesRinging)
    }

    func testOccupantTitleFallsBackToAiAnsweringOnlyForSuppressedCalls() {
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(call(answerMode: "ai", aiHandling: true)), "AI 接听")
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(call(answerMode: "timeout_ai", aiHandling: true)), "其他设备")
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(call(answerMode: nil, aiHandling: nil)), "其他设备")
    }

    // MARK: - 决策 10：接听方式

    func testAnswerMethodDerivation() {
        XCTAssertEqual(
            CallAnswerMethod.resolve(answerMode: "ai", answeredByPlatform: "ai", answeredAt: nil), .missed,
            "没有接通时间就是未接，无论当时是什么模式"
        )
        XCTAssertEqual(CallAnswerMethod.resolve(answerMode: "ai", answeredByPlatform: "ai", answeredAt: " "), .missed)
        XCTAssertEqual(
            CallAnswerMethod.resolve(answerMode: "ai", answeredByPlatform: "ai", answeredAt: "2026-09-11T14:57:45Z"),
            .ai
        )
        XCTAssertEqual(
            CallAnswerMethod.resolve(answerMode: "timeout_ai", answeredByPlatform: "ai", answeredAt: "2026-09-11T14:57:45Z"),
            .timeoutAI
        )
        XCTAssertEqual(
            CallAnswerMethod.resolve(answerMode: "timeout_ai", answeredByPlatform: "ios", answeredAt: "2026-09-11T14:57:45Z"),
            .human,
            "超时代接被人抢接仍然是真人接听"
        )
        XCTAssertEqual(
            CallAnswerMethod.resolve(answerMode: nil, answeredByPlatform: nil, answeredAt: "2026-09-11T14:57:45Z"),
            .human
        )
        XCTAssertEqual(CallAnswerMethod.missed.title, "未接")
        XCTAssertEqual(CallAnswerMethod.ai.title, "AI 接听")
        XCTAssertEqual(CallAnswerMethod.timeoutAI.title, "超时 AI")
        XCTAssertEqual(CallAnswerMethod.human.title, "真人")
    }

    func testReportCardSecondLineOrderAndMissingParts() {
        XCTAssertEqual(
            ReportCardFacts.line(simLabel: "SIM 1", direction: "incoming", duration: "0:48", answerMethod: .ai),
            "SIM 1 · 呼入 · 0:48 · AI 接听"
        )
        XCTAssertEqual(
            ReportCardFacts.line(simLabel: "", direction: "outgoing", duration: nil, answerMethod: .missed),
            "未知线路 · 呼出 · 未接"
        )
    }

    func testDurationLabelUsesTalkTimeAndIsAbsentForUnansweredCalls() {
        XCTAssertEqual(
            CallDurationLabel.text(answeredAt: "2026-09-11T14:57:45Z", endedAt: "2026-09-11T14:58:33Z"), "48 秒"
        )
        XCTAssertEqual(
            CallDurationLabel.text(answeredAt: "2026-09-11T14:57:45.689Z", endedAt: "2026-09-11T14:58:50.689Z"), "1 分 05 秒"
        )
        // S82: minutes never roll into hours.
        XCTAssertEqual(
            CallDurationLabel.text(answeredAt: "2026-09-11T14:00:00Z", endedAt: "2026-09-11T15:02:05Z"), "62 分 05 秒"
        )
        XCTAssertEqual(
            CallDurationLabel.text(answeredAt: "2026-09-11T14:57:45Z", endedAt: "2026-09-11T14:59:50Z"), "2 分 05 秒"
        )
        XCTAssertNil(CallDurationLabel.text(answeredAt: nil, endedAt: "2026-09-11T14:58:33Z"))
    }

    // MARK: - 决策 10：日期范围

    func testDatePresetsAreInclusiveCalendarDaysInTheGatewayZone() throws {
        let zone = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        // 2026-09-11 23:30 +08:00 — 一个只有按网关时区算才落在 9/11 的时刻。
        let today = try XCTUnwrap(GatewayTimeDisplay.parseISO("2026-09-11T15:30:00Z"))
        XCTAssertEqual(ReportDateRangePolicy.default, .sevenDays)

        let single = try XCTUnwrap(ReportDateRangePolicy.range(for: .today, today: today, timeZone: zone))
        XCTAssertEqual(ReportDateRangePolicy.day(single.from, timeZone: zone), "2026-09-11")
        XCTAssertEqual(ReportDateRangePolicy.day(single.to, timeZone: zone), "2026-09-11")

        let week = try XCTUnwrap(ReportDateRangePolicy.range(for: .sevenDays, today: today, timeZone: zone))
        XCTAssertEqual(ReportDateRangePolicy.day(week.from, timeZone: zone), "2026-09-05")
        XCTAssertEqual(ReportDateRangePolicy.day(week.to, timeZone: zone), "2026-09-11")

        let month = try XCTUnwrap(ReportDateRangePolicy.range(for: .thirtyDays, today: today, timeZone: zone))
        XCTAssertEqual(ReportDateRangePolicy.day(month.from, timeZone: zone), "2026-08-13")
        XCTAssertEqual(ReportDateRangePolicy.day(month.to, timeZone: zone), "2026-09-11")

        XCTAssertNil(ReportDateRangePolicy.range(for: .custom, today: today, timeZone: zone), "自定义由两个选择器决定")
        let swapped = ReportDateRangePolicy.ordered(from: today, to: week.from)
        XCTAssertEqual(swapped.from, week.from, "倒置的自定义区间会被纠正而不是查出空窗口")
        XCTAssertEqual(
            ReportDatePreset.allCases.map(\.title), ["今天", "7 天", "30 天", "自定义"]
        )
    }

    // MARK: - 决策 10：报告卡片文案

    func testSummarySlotExplainsWhyThereIsNoSummary() {
        XCTAssertEqual(
            ReportSummaryPolicy.presentation(transcriptState: "succeeded", transcriptErrorCode: nil, summary: "来电推销重疾险。"),
            .summary("来电推销重疾险。")
        )
        XCTAssertEqual(
            ReportSummaryPolicy.presentation(transcriptState: "none", transcriptErrorCode: nil, summary: nil),
            .placeholder("无转录：录音为空")
        )
        XCTAssertEqual(
            ReportSummaryPolicy.presentation(transcriptState: "failed", transcriptErrorCode: "RECORDING_EMPTY", summary: nil),
            .placeholder("无转录：录音为空")
        )
        XCTAssertEqual(
            ReportSummaryPolicy.presentation(transcriptState: "failed", transcriptErrorCode: "PROVIDER_HTTP_ERROR", summary: nil),
            .placeholder("转录失败，原始录音仍可查看")
        )
        for state in ["queued", "running", "retry"] {
            XCTAssertEqual(
                ReportSummaryPolicy.presentation(transcriptState: state, transcriptErrorCode: nil, summary: nil),
                .placeholder("转录处理中…")
            )
        }
        XCTAssertEqual(
            ReportSummaryPolicy.presentation(transcriptState: nil, transcriptErrorCode: nil, summary: "  "),
            .placeholder("暂无摘要")
        )
        XCTAssertEqual(ReportSummaryPolicy.summaryLineLimit, 3)
    }

    func testBlockBadgeDistinguishesUnclassifiedFromNotRecommended() {
        XCTAssertEqual(
            ReportBlockBadgePolicy.badge(blockRecommended: true, blockReason: "保险销售"),
            .recommended(reason: "保险销售")
        )
        XCTAssertEqual(ReportBlockBadgePolicy.badge(blockRecommended: true, blockReason: "  "), .recommended(reason: nil))
        XCTAssertEqual(ReportBlockBadgePolicy.badge(blockRecommended: false, blockReason: nil), ReportBlockBadgePolicy.Badge.none)
        XCTAssertEqual(ReportBlockBadgePolicy.badge(blockRecommended: nil, blockReason: nil), .unclassified)
        XCTAssertEqual(ReportBlockBadgePolicy.recommendedTitle, "推荐拦截")
        XCTAssertEqual(ReportBlockBadgePolicy.unclassifiedTitle, "未分类")
        XCTAssertEqual(ReportBlockBadgePolicy.blockNowTitle, "立即屏蔽")
        XCTAssertEqual(ReportBlockBadgePolicy.blockedTitle, "已屏蔽")
    }

    func testTranscriptButtonPrefersTheAiConversationWhenTheRecordedOneFailed() {
        XCTAssertEqual(
            ReportTranscriptDestination.resolve(hasAiTranscript: true, transcriptState: "failed"), .aiConversation
        )
        XCTAssertEqual(
            ReportTranscriptDestination.resolve(hasAiTranscript: true, transcriptState: "none"), .aiConversation
        )
        XCTAssertEqual(
            ReportTranscriptDestination.resolve(hasAiTranscript: true, transcriptState: "succeeded"), .transcript,
            "转录成功时仍以正式转录为主，AI 对话在详情页里"
        )
        XCTAssertEqual(
            ReportTranscriptDestination.resolve(hasAiTranscript: nil, transcriptState: "failed"), .transcript
        )
    }

    func testRecordsTabsAndSearchPromptMatchTheThreeEndContract() {
        XCTAssertEqual(RecordsTab.allCases.map(\.title), ["通话", "转录报告", "拦截"])
        XCTAssertEqual(RecordsTab.allCases.first, .calls)
        XCTAssertEqual(RecordSearchPolicy.searchPrompt, "搜索姓名或号码")
        XCTAssertEqual(RecordSearchPolicy.debounce, .milliseconds(350))
        XCTAssertEqual(RecordSearchPolicy.debounce, ContactLookupPolicy.debounce)
    }

    func testReportCardLeadsWithTheNameWhileHistoryRowsLeadWithTheNumber() {
        XCTAssertEqual(ContactDisplay.nameWithNumber(number: "2025550101", contactName: "张三"), "张三 · 2025550101")
        XCTAssertEqual(ContactDisplay.nameWithNumber(number: "2025550101", contactName: nil), "2025550101")
        XCTAssertEqual(ContactDisplay.nameWithNumber(number: nil, contactName: "张三"), "张三")
        XCTAssertEqual(ContactDisplay.nameWithNumber(number: nil, contactName: nil), "未知号码")
        // §F 的通话记录行没有变：号码在前。
        XCTAssertEqual(ContactDisplay.numberWithName(number: "2025550101", contactName: "张三"), "2025550101 · 张三")
    }
}
