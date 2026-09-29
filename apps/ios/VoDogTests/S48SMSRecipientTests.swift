import XCTest
@testable import VoDog

final class S48SMSRecipientTests: XCTestCase {
    func testOrdinaryEntryIgnoresPreviousRecipientAndExplicitEntryWins() {
        XCTAssertEqual(ComposeMessagePrefillPolicy.number(initialNumber: nil, draftNumber: "10086"), "")
        XCTAssertEqual(ComposeMessagePrefillPolicy.number(initialNumber: "", draftNumber: "10086"), "")
        XCTAssertEqual(ComposeMessagePrefillPolicy.number(initialNumber: "202 555 0111", draftNumber: "10086"), "202 555 0111")
    }

    func testMultipleNumbersAndContactsDeduplicateManualFormattingWithoutSuffixGuessing() {
        var recipients = SMSRecipientPolicy.adding(number: "+1 202 555 0111", name: "林", to: [])
        recipients = SMSRecipientPolicy.adding(number: "+1 202 555 0102", name: "林", to: recipients)
        recipients = SMSRecipientPolicy.adding(number: "2025550112", name: "陈", to: recipients)
        recipients = SMSRecipientPolicy.adding(number: "+1-202-555-0111", name: "重复", to: recipients)
        XCTAssertEqual(recipients.count, 3)
        XCTAssertEqual(recipients.first?.name, "林")
        XCTAssertEqual(SMSRecipientPolicy.resolved(recipients, manual: "202 555 0112"), recipients)
        recipients.removeAll { $0.number == "+12025550102" }
        XCTAssertEqual(recipients.map(\.number), ["+12025550111", "2025550112"])
        // Local and international spellings are left to the authoritative server's canonical dedup.
        XCTAssertEqual(SMSRecipientPolicy.adding(number: "2025550111", to: recipients).count, 3)
    }

    func testSearchMatchesNameAndEveryPhoneWithoutErasingSelection() {
        let contact = Contact(id: "c", displayName: "王小明", phones: [
            ContactPhone(id: "a", rawNumber: "2025550111"),
            ContactPhone(id: "b", rawNumber: "+1 202 555 0102")
        ])
        XCTAssertTrue(SMSRecipientPolicy.matches(contact, query: "小明"))
        XCTAssertTrue(SMSRecipientPolicy.matches(contact, query: "2025550"))
        XCTAssertFalse(SMSRecipientPolicy.matches(contact, query: "missing"))
        let items = SMSContactPagePolicy.query(query: " 小明 ", offset: 200)
        XCTAssertEqual(items.first { $0.name == "query" }?.value, "小明")
        XCTAssertEqual(items.first { $0.name == "offset" }?.value, "200")
        XCTAssertEqual(items.first { $0.name == "limit" }?.value, "200")
    }

    func testSingleNumberKeepsExistingPayloadAndMultipleNumbersAreOneBatch() throws {
        let one = try XCTUnwrap(SMSSubmission(simID: "a", recipients: [], manual: "202 555 0111", body: " hello "))
        XCTAssertEqual(one, .single(.init(simId: "a", remoteNumber: "2025550111", body: "hello")))
        let selected = SMSRecipientPolicy.adding(number: "10086", to: [])
        let many = try XCTUnwrap(SMSSubmission(simID: "a", recipients: selected, manual: "10010", body: " hello "))
        XCTAssertEqual(many, .batch(.init(simId: "a", recipients: ["10086", "10010"], body: "hello")))
        XCTAssertEqual(
            SMSSubmission(simID: "a", recipients: selected, manual: "100 86", body: "hello"),
            .single(.init(simId: "a", remoteNumber: "10086", body: "hello"))
        )
        XCTAssertNil(SMSSubmission(simID: "a", recipients: [], manual: "", body: "hello"))
        XCTAssertNil(SMSSubmission(simID: "a", recipients: selected, manual: "", body: " \n "))
        let tooMany = (0...100).map { SMSRecipient(number: "202555\($0)", name: nil) }
        XCTAssertNil(SMSSubmission(simID: "a", recipients: tooMany, manual: "", body: "hello"))
    }

    @MainActor
    func testBodyDraftsAndConversationRepliesRemainAccountAndSIMScoped() throws {
        let drafts = MessageDraftStore()
        let threadA = try XCTUnwrap(MessageConversationID(simID: "a", remoteNumber: "10086"))
        let threadB = try XCTUnwrap(MessageConversationID(simID: "b", remoteNumber: "10086"))
        drafts.saveCompose(.init(remoteNumber: "old", body: "A body"), accountID: "owner", simID: "a")
        drafts.saveCompose(.init(body: "B body"), accountID: "owner", simID: "b")
        drafts.saveReply("A reply", accountID: "owner", conversation: threadA)
        drafts.saveReply("B reply", accountID: "owner", conversation: threadB)
        XCTAssertEqual(drafts.compose(accountID: "owner", simID: "a").body, "A body")
        XCTAssertEqual(drafts.compose(accountID: "owner", simID: "b").body, "B body")
        XCTAssertEqual(drafts.compose(accountID: "other", simID: "a").body, "")
        XCTAssertEqual(drafts.reply(accountID: "other", conversation: threadA), "")
        drafts.clearCompose(accountID: "owner", simID: "a")
        XCTAssertEqual(drafts.compose(accountID: "owner", simID: "b").body, "B body")
        XCTAssertEqual(drafts.reply(accountID: "owner", conversation: threadA), "A reply")
        XCTAssertEqual(drafts.reply(accountID: "owner", conversation: threadB), "B reply")
    }

    @MainActor
    func testUncertainBatchRetryPreservesKeyAcrossRestartAndSeparatesEditsAccountsAndSIMs() throws {
        let suite = "S48SMS.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let payload = SMSBatchPayload(simId: "a", recipients: ["10086", "10010"], body: "private message")
        let store = SMSIdempotencyStore(defaults: defaults)
        let key = try store.key(accountID: "u", payload: payload)
        let restarted = SMSIdempotencyStore(defaults: defaults)
        XCTAssertEqual(try restarted.key(accountID: "u", payload: payload), key)
        XCTAssertNotEqual(try restarted.key(accountID: "other", payload: payload), key)
        XCTAssertNotEqual(try restarted.key(accountID: "u", payload: .init(simId: "b", recipients: payload.recipients, body: payload.body)), key)
        XCTAssertNotEqual(try restarted.key(accountID: "u", payload: .init(simId: "a", recipients: ["10086", "10000"], body: payload.body)), key)
        XCTAssertNotEqual(try restarted.key(accountID: "u", payload: .init(simId: "a", recipients: payload.recipients, body: "edited")), key)
        restarted.markSucceeded(accountID: "u", payload: payload, idempotencyKey: "stale")
        XCTAssertEqual(try restarted.key(accountID: "u", payload: payload), key)
        restarted.markSucceeded(accountID: "u", payload: payload, idempotencyKey: key)
        XCTAssertNotEqual(try restarted.key(accountID: "u", payload: payload), key)
        let persisted = String(decoding: try XCTUnwrap(defaults.data(forKey: "sms-pending-idempotency-v1")), as: UTF8.self)
        XCTAssertFalse(persisted.contains("private message"))
        XCTAssertFalse(persisted.contains("10086"))
    }

    func testBatchResponseDecodesFlatQueuedMessages() throws {
        let data = Data(#"{"batchId":"b","intervalSeconds":5,"items":[{"id":"m1","state":"queued"},{"id":"m2","state":"queued"}]}"#.utf8)
        let response = try JSONDecoder().decode(SMSBatchResponse.self, from: data)
        XCTAssertEqual(response.batchId, "b")
        XCTAssertEqual(response.intervalSeconds, 5)
        XCTAssertEqual(response.items.map(\.id), ["m1", "m2"])
        XCTAssertEqual(response.items.map(\.deliveryTitle), ["等待发送", "等待发送"])
    }
    func testQueuedExecutionHoldAndUncertainFailureReasonsHaveReadableTitles() throws {
        let cases: [(String, String?, String)] = [
            ("queued", "sms_gateway_execution_unresolved", "等待上一条短信状态确认"),
            ("pending", "sms_gateway_execution_unresolved", "等待上一条短信状态确认"),
            ("unknown", "sms_execution_unresolved", "发送结果待确认，请勿重复发送"),
            ("failed", "sms_not_dispatched", "短信未下发"),
            ("failed", "sms_route_changed_before_release", "发送线路已变更，短信未下发"),
            ("queued", nil, "等待发送"),
            ("queued", "future_code", "等待发送"),
            ("unknown", nil, "状态待确认"),
            ("failed", "future_code", "发送失败"),
            // The authoritative state wins over a leftover diagnostic reason.
            ("sent", "sms_execution_unresolved", "已发送"),
            ("delivered", "sms_gateway_execution_unresolved", "已送达")
        ]
        for (state, reason, expected) in cases {
            var object = ["id": "fixture", "state": state]
            if let reason { object["failureReason"] = reason }
            let message = try JSONDecoder().decode(
                SMSMessage.self, from: JSONSerialization.data(withJSONObject: object)
            )
            XCTAssertEqual(message.deliveryTitle, expected, "\(state): \(reason ?? "none")")
        }
    }

}
