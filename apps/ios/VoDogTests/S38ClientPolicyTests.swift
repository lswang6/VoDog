import XCTest
@testable import VoDog

/// S38「三端合同」的客户端规则：手机自动拦截、通过手机拨打、忙线自动拒接、忙线 AI 代接，
/// 以及手机拨出通话的单声轨录音。iOS 是参考实现，这些断言就是 Android/Web 要对齐的文字。
final class S38ClientPolicyTests: XCTestCase {

    private func decodeCall(_ json: String) throws -> CallRecord {
        try JSONDecoder().decode(CallRecord.self, from: Data(json.utf8))
    }

    // MARK: - 解码：未知字段/缺字段都不能让解码失败

    func testCallDecodesS38FieldsAndLegacyRowsAlike() throws {
        let pixel = try decodeCall(#"""
        {"id":"c1","simId":"s1","direction":"outgoing","remoteNumber":"10010","state":"ended",
         "originatingPlatform":"pixel","conflictDisposition":null,"unknownFutureField":"x"}
        """#)
        XCTAssertEqual(pixel.originatingPlatform, "pixel")
        XCTAssertNil(pixel.conflictDisposition)
        XCTAssertEqual(pixel.s38BadgeTitle, "通过手机拨打")

        let rejected = try decodeCall(#"""
        {"id":"c2","simId":"s2","direction":"incoming","remoteNumber":"2025550101","state":"failed",
         "failureReason":"busy_auto_rejected","conflictDisposition":"rejected"}
        """#)
        XCTAssertEqual(rejected.conflictDisposition, "rejected")
        XCTAssertEqual(rejected.s38BadgeTitle, "忙线自动拒接")

        let aiAnswered = try decodeCall(#"""
        {"id":"c3","simId":"s2","direction":"incoming","remoteNumber":"2025550101","state":"ended",
         "answeredAt":"2026-09-18T02:00:01Z","answeredByPlatform":"ai","answerMode":"ai",
         "conflictDisposition":"ai_answered"}
        """#)
        XCTAssertEqual(aiAnswered.s38BadgeTitle, "忙线 AI 代接")

        let legacy = try decodeCall(#"{"id":"c4","simId":"s1","direction":"incoming","state":"ended"}"#)
        XCTAssertNil(legacy.conflictDisposition)
        XCTAssertNil(legacy.s38BadgeTitle, "pre-S38 的 Control 不能凭空长出标记")

        // 未知枚举值只是没有标签，不是崩溃，也不能漏出原始代码。
        let unknown = try decodeCall(#"{"id":"c5","originatingPlatform":"toaster","conflictDisposition":"who_knows"}"#)
        XCTAssertNil(unknown.s38BadgeTitle)
    }

    // MARK: - 标记文字与优先级

    func testBadgePrefersTheConflictDispositionOverTheOrigin() throws {
        let both = try decodeCall(#"""
        {"id":"c6","originatingPlatform":"pixel","conflictDisposition":"ai_answered"}
        """#)
        XCTAssertEqual(both.s38BadgeTitle, "忙线 AI 代接")

        // 老字段齐、新字段缺：failureReason 单独出现时也算拒接。
        let reasonOnly = try decodeCall(#"{"id":"c7","state":"failed","failureReason":"busy_auto_rejected"}"#)
        XCTAssertEqual(reasonOnly.s38BadgeTitle, "忙线自动拒接")
    }

    // MARK: - 被拦截的来电也留在全部通话里

    func testInterceptedCallDecodesBlockedSourceAndCarriesTheSourceBadge() throws {
        func badge(_ source: String) throws -> String? {
            try decodeCall(#"""
            {"id":"b1","simId":"s1","direction":"incoming","remoteNumber":"2025550101","state":"failed",
             "failureReason":"number_blocked","blockedSource":\#(source)}
            """#).s38BadgeTitle
        }
        XCTAssertEqual(try badge(#""phone""#), "手机自动拦截")
        XCTAssertEqual(try badge(#""gateway""#), "网关拦截")
        XCTAssertEqual(try badge(#""control""#), "服务器拦截")
        // 来源缺失或是没见过的枚举值：仍然说明这是被拦下的通话，但不泄漏原始代码。
        XCTAssertEqual(try badge("null"), "已拦截")
        XCTAssertEqual(try badge(#""martian""#), "已拦截")

        let legacy = try decodeCall(#"{"id":"b2","state":"failed","failureReason":"number_blocked"}"#)
        XCTAssertNil(legacy.blockedSource)
        XCTAssertEqual(legacy.s38BadgeTitle, "已拦截")

        // blockedSource 单独出现不算拦截：判定拦截的只有 failureReason。
        let notBlocked = try decodeCall(#"{"id":"b3","state":"ended","blockedSource":"phone"}"#)
        XCTAssertNil(notBlocked.s38BadgeTitle)
        XCTAssertFalse(notBlocked.showsBlockedMark)
    }

    func testBadgePrefersTheInterceptionOverOriginAndConflict() throws {
        let pixelBlocked = try decodeCall(#"""
        {"id":"b4","state":"failed","failureReason":"number_blocked","blockedSource":"phone",
         "originatingPlatform":"pixel","conflictDisposition":"rejected"}
        """#)
        XCTAssertEqual(pixelBlocked.s38BadgeTitle, "手机自动拦截")
    }

    func testInterceptedRowShowsTheBlockedMarkEvenAfterTheNumberIsUnblocked() throws {
        // `blocked` 是号码此刻还在不在黑名单上，解除屏蔽以后会变 false；那通电话仍然是被拦下的。
        let unblockedLater = try decodeCall(#"""
        {"id":"b5","state":"failed","failureReason":"number_blocked","blocked":false}
        """#)
        XCTAssertTrue(unblockedLater.showsBlockedMark)
        XCTAssertFalse(unblockedLater.isBlocked, "取消屏蔽入口仍看 blocked，不能被通话标记带偏")

        let plainFailure = try decodeCall(#"{"id":"b6","state":"failed","failureReason":"no_answer"}"#)
        XCTAssertFalse(plainFailure.showsBlockedMark)
        let stillBlocked = try decodeCall(#"{"id":"b7","state":"ended","blocked":true}"#)
        XCTAssertTrue(stillBlocked.showsBlockedMark)
    }

    /// 全部通话的每一条请求——普通、分页、按线路筛——都要带 `includeBlocked=true`，
    /// 否则服务端默认把 `number_blocked` 的行藏起来，列表里就什么都看不到。
    func testEveryCallsListRequestAsksForBlockedRows() {
        func includeBlocked(_ items: [URLQueryItem]) -> String? {
            items.first { $0.name == "includeBlocked" }?.value
        }
        XCTAssertEqual(includeBlocked(RecordSearchPolicy.callsQuery(query: "")), "true")
        XCTAssertEqual(includeBlocked(RecordSearchPolicy.callsQuery(query: "张三")), "true")
        XCTAssertEqual(includeBlocked(RecordSearchPolicy.callsQuery(query: "", page: 2, pageSize: 50)), "true")
        XCTAssertEqual(
            includeBlocked(RecordSearchPolicy.callsQuery(query: "", simId: "sim-1", page: 1, pageSize: 50)), "true"
        )
    }

    // MARK: - 接听方式仍显示 AI

    func testBusyAiAnsweredStillReadsAsAiInTheAnswerMethod() {
        XCTAssertEqual(
            CallAnswerMethod.resolve(
                answerMode: "ai", answeredByPlatform: "ai", answeredAt: "2026-09-18T02:00:01Z"
            ).title,
            "AI 接听"
        )
    }

    // MARK: - 失败原因

    func testBusyAutoRejectedPrintsChineseWhileUnknownCodesStayRaw() {
        XCTAssertEqual(
            FailureReasonDisplayPolicy.visibleReason(
                failureReason: "busy_auto_rejected", state: "failed", answeredAt: nil, recordingStatus: nil
            ),
            "忙线自动拒接"
        )
        XCTAssertEqual(
            FailureReasonDisplayPolicy.visibleReason(
                failureReason: "command_expired", state: "failed", answeredAt: nil, recordingStatus: nil
            ),
            "command_expired"
        )
    }

    // MARK: - 平台文字与占用条

    func testPixelPlatformWording() throws {
        XCTAssertEqual(callPlatformTitle("pixel"), "通过手机拨打")
        let call = try decodeCall(#"""
        {"id":"c8","simId":"s1","state":"active","originatingPlatform":"pixel",
         "occupancy":{"holdsLock":true,"isCurrentSession":false,"canRelease":true}}
        """#)
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(call), "手机通话中")
        XCTAssertFalse(
            SIMOccupancyDisplayPolicy.canRelease(call),
            "手机自己拨的通话，网络这一侧不提供结束按钮"
        )
    }

    // MARK: - 拦截来源

    func testInterceptionSourceTitles() throws {
        func source(_ value: String) throws -> String? {
            try JSONDecoder().decode(
                Interception.self, from: Data(#"{"id":"i1","kind":"call","source":"\#(value)"}"#.utf8)
            ).sourceTitle
        }
        XCTAssertEqual(try source("phone"), "手机自动拦截")
        XCTAssertEqual(try source("gateway"), "网关拦截")
        XCTAssertEqual(try source("control"), "服务器拦截")
        XCTAssertNil(try source("martian"))
        let legacy = try JSONDecoder().decode(Interception.self, from: Data(#"{"id":"i2","kind":"sms"}"#.utf8))
        XCTAssertNil(legacy.sourceTitle)
    }
}
