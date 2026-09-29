import XCTest
@testable import VoDog

/// 设置页「应用状态」的规则。The PUT response's `appliedVersion` is stale by design, so 应用成功 may only ever
/// come from a later read in which the gateway really did confirm *this* version.
final class SettingsApplyPolicyTests: XCTestCase {

    private let start = Date(timeIntervalSince1970: 1_757_700_000)

    // MARK: - 轮询节奏

    func testThePollWindowIsTwoSecondsAndThirtySeconds() {
        XCTAssertEqual(SettingsApplyPolicy.pollInterval, .seconds(2))
        XCTAssertEqual(SettingsApplyPolicy.timeout, .seconds(30))
    }

    // MARK: - 状态机

    func testApplyingBecomesAppliedWhenTheVersionCatchesUp() {
        let state = SettingsApplyPolicy.State.applying(started: start, target: 4)
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(2), appliedVersion: 4, version: 4),
            .applied
        )
    }

    func testApplyingIsSupersededWhenAnotherClientAdvancesTheServerVersion() {
        let state = SettingsApplyPolicy.State.applying(started: start, target: 4)
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(2), appliedVersion: 4, version: 5),
            .superseded
        )
        XCTAssertEqual(
            SettingsApplyPolicy.label(state, appliedVersion: 5, version: 5).text,
            SettingsApplyPolicy.supersededText
        )
        let label = SettingsApplyPolicy.label(.superseded, appliedVersion: 5, version: 5)
        XCTAssertEqual(label.text, "设置已被另一客户端的新版本替代，请刷新后查看。")
        XCTAssertEqual(label.tone, .warning)
    }

    func testAckAtOrBeyondTheCurrentTargetCountsOnlyWhenCurrentVersionStillMatches() {
        let state = SettingsApplyPolicy.State.applying(started: start, target: 4)
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(2), appliedVersion: 6, version: 4),
            .applied
        )
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(2), appliedVersion: 6, version: 5),
            .superseded
        )
    }

    func testApplyingStaysApplyingWhileTheGatewayHasNotAnsweredYet() {
        let state = SettingsApplyPolicy.State.applying(started: start, target: 4)
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(2), appliedVersion: 3, version: 4),
            state,
            "落后一个版本就是还没确认"
        )
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(29), appliedVersion: nil, version: 4),
            state,
            "从未确认过的号码也要等满 30 秒"
        )
    }

    func testApplyingTimesOutAtThirtySeconds() {
        let state = SettingsApplyPolicy.State.applying(started: start, target: 4)
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(29.5), appliedVersion: 3, version: 4),
            state
        )
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(30), appliedVersion: 3, version: 4),
            .timedOut
        )
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(120), appliedVersion: 3, version: 4),
            .timedOut
        )
    }

    func testAnAckThatArrivesOnTheTimeoutTickStillCounts() {
        // 先判成功再判超时：网关在第 30 秒确认，不该被判成「尚未确认」。
        let state = SettingsApplyPolicy.State.applying(started: start, target: 4)
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: start.addingTimeInterval(30), appliedVersion: 4, version: 4),
            .applied
        )
    }

    func testTheOtherStatesNeverMoveOnTheirOwn() {
        // 只有保存会把状态推回 applying；轮询不会让 applied 退回去。
        for state in [SettingsApplyPolicy.State.idle, .applied, .superseded, .timedOut] {
            XCTAssertEqual(
                SettingsApplyPolicy.next(state, now: start.addingTimeInterval(600), appliedVersion: 1, version: 9),
                state
            )
        }
    }

    func testANewSaveResetsAppliedBackToApplying() {
        // 「再保存一次」是视图的动作，不是 next 的：applied 收到新的 applying 后照常重新计时。
        var state = SettingsApplyPolicy.State.applying(started: start, target: 4)
        state = SettingsApplyPolicy.next(state, now: start.addingTimeInterval(2), appliedVersion: 4, version: 4)
        XCTAssertEqual(state, .applied)

        let second = start.addingTimeInterval(60)
        state = .applying(started: second, target: 5)
        XCTAssertEqual(SettingsApplyPolicy.label(state, appliedVersion: 4, version: 5).tone, .pending)
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: second.addingTimeInterval(2), appliedVersion: 4, version: 5),
            state,
            "第二次保存重新开始计时，不吃第一次的 30 秒"
        )
        XCTAssertEqual(
            SettingsApplyPolicy.next(state, now: second.addingTimeInterval(4), appliedVersion: 5, version: 5),
            .applied
        )
    }

    // MARK: - 文案与颜色

    func testApplyingReadsAsPendingEvenThoughTheVersionsStillDisagree() {
        let state = SettingsApplyPolicy.State.applying(started: start, target: 4)
        let label = SettingsApplyPolicy.label(state, appliedVersion: 3, version: 4)
        XCTAssertEqual(label.text, "正在应用中…")
        XCTAssertEqual(label.tone, .pending)
    }

    func testAConfirmedVersionReadsAsSuccess() {
        for state in [SettingsApplyPolicy.State.applied, .idle, .timedOut] {
            let label = SettingsApplyPolicy.label(state, appliedVersion: 4, version: 4)
            XCTAssertEqual(label.text, "应用成功")
            XCTAssertEqual(label.tone, .success, "确认过就是成功，和当时处在哪个状态无关")
        }
    }

    func testSuccessIsNeverShownUnlessTheDeviceConfirmedThisVersion() {
        // applied 之后别的客户端又改了一版：这时候仍然是「尚未确认」，不是成功。
        XCTAssertEqual(SettingsApplyPolicy.label(.applied, appliedVersion: 5, version: 6).tone, .warning)
        XCTAssertEqual(SettingsApplyPolicy.label(.applied, appliedVersion: nil, version: 6).tone, .warning)
        XCTAssertEqual(SettingsApplyPolicy.label(.idle, appliedVersion: nil, version: 1).tone, .warning)
    }

    func testATimeoutFallsBackToTheOriginalOrangeSentence() {
        let label = SettingsApplyPolicy.label(.timedOut, appliedVersion: 3, version: 4)
        XCTAssertEqual(label.text, "设置已保存，但设备尚未确认应用。")
        XCTAssertEqual(label.tone, .warning)
    }

    func testAStaleUnconfirmedVersionWarnsWithoutAnySaveHavingHappened() {
        // 进入页面就落后（别的端刚保存过）：橙字照旧，不需要先点保存。
        let label = SettingsApplyPolicy.label(.idle, appliedVersion: 2, version: 3)
        XCTAssertEqual(label.text, "设置已保存，但设备尚未确认应用。")
        XCTAssertEqual(label.tone, .warning)
    }

    func testNoSettingsAtAllSaysNothing() {
        // 两个 nil 相等，但「没有设置」不是「已确认」——那一行干脆不出现。
        let label = SettingsApplyPolicy.label(.idle, appliedVersion: nil, version: nil)
        XCTAssertEqual(label.tone, .none)
        XCTAssertEqual(label.text, "")
        XCTAssertEqual(SettingsApplyPolicy.label(.idle, appliedVersion: 3, version: nil).tone, .none)
    }

    // MARK: - 行内副标题（三端同一套说法）

    func testTheRowSubtitleFollowsTheSameRule() {
        XCTAssertEqual(SettingsApplyPolicy.subtitle(appliedVersion: 4, version: 4), "网关已确认")
        XCTAssertEqual(SettingsApplyPolicy.subtitle(appliedVersion: 3, version: 4), "等待网关确认")
        XCTAssertEqual(SettingsApplyPolicy.subtitle(appliedVersion: nil, version: 4), "等待网关确认")
        XCTAssertEqual(
            SettingsApplyPolicy.subtitle(appliedVersion: nil, version: nil), "等待网关确认",
            "没有版本信息时也不能声称已确认"
        )
    }
}
