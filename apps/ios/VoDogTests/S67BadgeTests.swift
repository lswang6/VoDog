import XCTest
@testable import VoDog

final class S67BadgeTests: XCTestCase {
    func testDecodesBadgesAndPerSIMLookups() throws {
        let json = #"{"calls":3,"sms":120,"sims":[{"simId":"a","calls":2,"sms":0},{"simId":"b","calls":1,"sms":120}]}"#
        let counts = try JSONDecoder().decode(BadgeCounts.self, from: Data(json.utf8))
        XCTAssertEqual(counts.calls, 3)
        XCTAssertEqual(counts.sms, 120)
        XCTAssertEqual(counts.callsBySIM, ["a": 2, "b": 1])
        XCTAssertEqual(counts.smsBySIM["b"], 120)
        XCTAssertNil(counts.callsBySIM["missing"])
    }

    func testDecodeToleratesMissingSims() throws {
        let counts = try JSONDecoder().decode(BadgeCounts.self, from: Data(#"{"calls":1,"sms":0}"#.utf8))
        XCTAssertEqual(counts, BadgeCounts(calls: 1, sms: 0, sims: []))
    }

    func testLabel() {
        XCTAssertNil(BadgeLabelPolicy.text(0))
        XCTAssertNil(BadgeLabelPolicy.text(-1))
        XCTAssertEqual(BadgeLabelPolicy.text(1), "1")
        XCTAssertEqual(BadgeLabelPolicy.text(99), "99")
        XCTAssertEqual(BadgeLabelPolicy.text(100), "99+")
        XCTAssertEqual(BadgeLabelPolicy.accessibility(3), "3 条未读")
        XCTAssertNil(BadgeLabelPolicy.accessibility(0))
    }

    func testIconValueFollowsPreferences() {
        let counts = BadgeCounts(calls: 2, sms: 5)
        typealias P = BadgePreferences.Values
        XCTAssertEqual(BadgePreferences.iconValue(counts, P()), 7)
        XCTAssertEqual(BadgePreferences.iconValue(counts, P(enabled: true, calls: true, sms: false)), 2)
        XCTAssertEqual(BadgePreferences.iconValue(counts, P(enabled: true, calls: false, sms: true)), 5)
        XCTAssertEqual(BadgePreferences.iconValue(counts, P(enabled: false, calls: true, sms: true)), 0)
        XCTAssertTrue(BadgePreferences.push(P(enabled: false, calls: true, sms: true)) == (false, false))
        XCTAssertTrue(BadgePreferences.push(P(enabled: true, calls: true, sms: false)) == (true, false))
    }

    func testPreferencesDefaultToOn() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "S67BadgeTests"))
        defaults.removePersistentDomain(forName: "S67BadgeTests")
        XCTAssertEqual(BadgePreferences.current(defaults), BadgePreferences.Values())
        defaults.set(false, forKey: BadgePreferences.smsKey)
        XCTAssertEqual(BadgePreferences.current(defaults).sms, false)
        defaults.removePersistentDomain(forName: "S67BadgeTests")
    }

    func testOptimisticDecrementsNeverGoNegative() {
        var counts = BadgeCounts(calls: 1, sms: 3, sims: [.init(simId: "a", calls: 1, sms: 3)])
        counts.decrementCall(simID: "a")
        counts.decrementCall(simID: "a")
        XCTAssertEqual(counts.calls, 0)
        XCTAssertEqual(counts.callsBySIM["a"], 0)
        counts.decrementSMS(simID: "a", by: 5)
        XCTAssertEqual(counts.sms, 0)
        XCTAssertEqual(counts.smsBySIM["a"], 0)
    }

    // S67c row dots.
    func testUnseenAndUnreadDecodeAsOptionalDefaultFalse() throws {
        let calls = try JSONDecoder().decode([CallRecord].self, from: Data(#"[{"id":"c1","unseen":true},{"id":"c2"}]"#.utf8))
        XCTAssertEqual(calls.map(\.unseen), [true, nil])
        XCTAssertTrue(UnreadDotPolicy.callUnseen(calls[0], locallySeen: []))
        XCTAssertFalse(UnreadDotPolicy.callUnseen(calls[1], locallySeen: []))
        XCTAssertFalse(UnreadDotPolicy.callUnseen(calls[0], locallySeen: ["c1"]))

        let sms = try JSONDecoder().decode([SMSMessage].self, from: Data(#"[{"id":"s1","unread":true},{"id":"s2","unread":false},{"id":"s3"}]"#.utf8))
        XCTAssertEqual(sms.map(\.unread), [true, false, nil])
    }

    func testConversationUnreadWhenAnyMessageUnreadAndNotOpened() throws {
        let sms = try JSONDecoder().decode([SMSMessage].self, from: Data(#"[{"id":"s1"},{"id":"s2","unread":true},{"id":"s3","unread":true}]"#.utf8))
        XCTAssertTrue(UnreadDotPolicy.conversationUnread(sms, locallyRead: []))
        XCTAssertTrue(UnreadDotPolicy.conversationUnread(sms, locallyRead: ["s2"]))
        XCTAssertFalse(UnreadDotPolicy.conversationUnread(sms, locallyRead: ["s2", "s3"]))
        XCTAssertFalse(UnreadDotPolicy.conversationUnread(Array(sms.prefix(1)), locallyRead: []))
        XCTAssertFalse(UnreadDotPolicy.conversationUnread([], locallyRead: []))
    }

    func testReportItemUnseenDecodesDefaultFalseAndHonoursLocallySeen() throws {
        struct Envelope: Decodable { let items: [CallReportItem] }
        let json = #"{"items":[{"callId":"c1","startedAt":"2026-09-26T00:00:00Z","sim":{"id":"a","label":"A"},"unseen":true},{"callId":"c2","startedAt":"2026-09-26T00:01:00Z","sim":{"id":"a","label":"A"}},{"callId":"c3","startedAt":"2026-09-26T00:02:00Z","sim":{"id":"a","label":"A"},"unseen":false}]}"#
        let items = try JSONDecoder().decode(Envelope.self, from: Data(json.utf8)).items
        XCTAssertEqual(items.map(\.unseen), [true, false, false])
        XCTAssertTrue(UnreadDotPolicy.reportUnseen(items[0], locallySeen: []))
        XCTAssertFalse(UnreadDotPolicy.reportUnseen(items[0], locallySeen: ["c1"]))
        XCTAssertFalse(UnreadDotPolicy.reportUnseen(items[1], locallySeen: []))
        XCTAssertFalse(UnreadDotPolicy.reportUnseen(items[2], locallySeen: []))
    }
}
