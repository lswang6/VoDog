import XCTest
@testable import VoDog

final class ExpandedUIStateTests: XCTestCase {
    func testConversationUsesSIMAndServerCanonicalAddressWithoutCrossSIMMixing() throws {
        let messages = try decodeMessages(#"""
        {"items":[
          {"id":"1","simId":"sim-a","remoteNumber":"2025550102","conversationAddress":"+12025550102","replyNumber":"+12025550102","canReply":true,"direction":"incoming","body":"a1","state":"received","createdAt":"2026-09-09T00:00:00Z"},
          {"id":"2","simId":"sim-a","remoteNumber":"+1 202 555 0102","conversationAddress":"+12025550102","replyNumber":"+12025550102","canReply":true,"direction":"outgoing","body":"a2","state":"delivered","createdAt":"2026-09-09T00:01:00Z"},
          {"id":"3","simId":"sim-b","remoteNumber":"+12025550102","conversationAddress":"+12025550102","replyNumber":"+12025550102","canReply":true,"direction":"incoming","body":"b","state":"received","createdAt":"2026-09-09T00:02:00Z"}
        ]}
        """#)

        let simA = MessageConversation.grouped(messages, selectedSIMID: "sim-a")
        XCTAssertEqual(simA.count, 1)
        XCTAssertEqual(simA[0].id.simID, "sim-a")
        XCTAssertEqual(simA[0].id.remoteNumber, "+12025550102")
        XCTAssertEqual(simA[0].messages.map(\.id), ["1", "2"])
        XCTAssertEqual(simA[0].replyNumber, "+12025550102")

        let simB = MessageConversation.grouped(messages, selectedSIMID: "sim-b")
        XCTAssertEqual(simB.map(\.messages.count), [1])
    }

    func testRefreshedServerSentOutgoingSMSJoinsThreadAndPresentsAsOutgoingWithoutLocalSendState() throws {
        let messages = try decodeMessages(#"""
        {"items":[
          {"id":"other","simId":"sim-a","remoteNumber":"10086","conversationAddress":"10086","replyNumber":"10086","canReply":true,"direction":"incoming","body":"other thread","state":"received","createdAt":"2026-09-21T10:30:00Z","receivedAt":"2026-09-21T10:30:01Z"},
          {"id":"server-sent","simId":"sim-a","remoteNumber":"+1 202 555 0102","conversationAddress":"+12025550102","replyNumber":"+12025550102","canReply":true,"direction":"outgoing","body":"sent elsewhere","state":"sent","createdAt":"2026-09-21T11:00:00Z","sentAt":"2026-09-21T11:00:05Z"},
          {"id":"incoming-old","simId":"sim-a","remoteNumber":"2025550102","conversationAddress":"+12025550102","replyNumber":"+12025550102","canReply":true,"direction":"incoming","body":"earlier","state":"received","createdAt":"2026-09-21T10:00:00Z","receivedAt":"2026-09-21T10:00:01Z"}
        ]}
        """#)

        // This is the same data shape MessagesView receives from a refresh. No compose/send path is involved.
        let conversations = MessageConversation.grouped(messages, selectedSIMID: "sim-a")
        XCTAssertEqual(conversations.map(\.id.remoteNumber), ["+12025550102", "10086"])

        let thread = try XCTUnwrap(conversations.first)
        XCTAssertEqual(thread.messages.map(\.id), ["incoming-old", "server-sent"])
        XCTAssertEqual(thread.latest?.id, "server-sent")

        let sent = try XCTUnwrap(thread.latest)
        XCTAssertEqual(sent.direction, "outgoing")
        XCTAssertEqual(sent.directionTitle, "发出")
        XCTAssertEqual(sent.deliveryTitle, "已发送")
        XCTAssertEqual(sent.statusDate, "2026-09-21T11:00:05Z")
    }

    func testConversationFallsBackForLegacyServerButHonorsExplicitCannotReply() throws {
        let legacy = try decodeMessages(#"{"items":[{"id":"1","simId":"sim-a","remoteNumber":"10086","direction":"incoming","body":"legacy","state":"received","createdAt":"2026-09-09T00:00:00Z"}]}"#)
        let oldConversation = try XCTUnwrap(MessageConversation.grouped(legacy, selectedSIMID: "sim-a").first)
        XCTAssertTrue(oldConversation.canReply)
        XCTAssertEqual(oldConversation.replyNumber, "10086")

        let protected = try decodeMessages(#"{"items":[{"id":"2","simId":"sim-a","remoteNumber":"SERVICE","conversationAddress":"SERVICE","replyNumber":null,"canReply":false,"direction":"incoming","body":"notice","state":"received","createdAt":"2026-09-09T00:00:00Z"}]}"#)
        let protectedConversation = try XCTUnwrap(MessageConversation.grouped(protected, selectedSIMID: "sim-a").first)
        XCTAssertFalse(protectedConversation.canReply)
        XCTAssertNil(protectedConversation.replyNumber)
    }

    func testPhoneNumberFormattingDoesNotGuessCountryEquivalence() {
        XCTAssertEqual(PhoneNumberText.normalized("+1 202-555-0102"), "+12025550102")
        XCTAssertEqual(PhoneNumberText.normalized("202 555 0102"), "2025550102")
        XCTAssertNotEqual(PhoneNumberText.normalized("+1 2025550102"), PhoneNumberText.normalized("2025550102"))
        XCTAssertEqual(PhoneNumberText.appending("2", to: "1"), "12")
        XCTAssertEqual(PhoneNumberText.appending("A", to: "1"), "1")
        XCTAssertEqual(PhoneNumberText.deletingLast(from: ""), "")
    }

    func testBlocklistKeyDoesNotEquatePlus86AndNationalWithoutCountry() {
        XCTAssertNotEqual(
            OwnerBlockedNumberKey.canonicalKey("+12025550102", countryIso: nil),
            OwnerBlockedNumberKey.canonicalKey("2025550102", countryIso: nil)
        )
        XCTAssertEqual(
            OwnerBlockedNumberKey.canonicalKey("+1 202-555-0102", countryIso: nil),
            "+12025550102"
        )
    }

    func testConversationLineCaptionIsDisplayNameWithoutDeviceIdentity() throws {
        let sims: ItemEnvelope<SIMChannel> = try JSONDecoder().decode(
            ItemEnvelope<SIMChannel>.self,
            from: Data(#"{"items":[{"id":"sim-a","gatewayId":"gateway-aaaaaaaa","label":"办公卡","phoneLabel":"+12025550102","online":true},{"id":"sim-b","gatewayId":"gateway-bbbbbbbb","slotIndex":1,"online":true}]}"#.utf8)
        )
        XCTAssertEqual(ConversationLineCaption.text(sim: sims.items[0]), "办公卡")
        XCTAssertEqual(ConversationLineCaption.text(sim: sims.items[1]), "SIM 2")
        XCTAssertNil(ConversationLineCaption.text(sim: nil))

        let caption = try XCTUnwrap(ConversationLineCaption.text(sim: sims.items[0]))
        XCTAssertFalse(caption.contains("回复"))
        XCTAssertFalse(caption.contains("短信"))
        XCTAssertFalse(caption.contains("PX-"))
        XCTAssertFalse(caption.contains(sims.items[0].id))
        XCTAssertFalse(caption.contains(try XCTUnwrap(sims.items[0].gatewayId)))
        XCTAssertEqual(caption.components(separatedBy: .newlines).count, 1)
    }

    func testSIMSelectionRejectsOfflineAndMissingChoices() throws {
        let sims: ItemEnvelope<SIMChannel> = try JSONDecoder().decode(
            ItemEnvelope<SIMChannel>.self,
            from: Data(#"{"items":[{"id":"off","gatewayId":"gateway-one","label":"离线卡","online":false,"telephonyReady":true,"mediaReady":true,"smsReady":true},{"id":"on","gatewayId":"gateway-two","label":"在线卡","online":true,"telephonyReady":true,"mediaReady":true,"smsReady":true},{"id":"legacy","gatewayId":"gateway-three","label":"旧合同卡","online":true}]}"#.utf8)
        )
        XCTAssertEqual(SIMSelectionPolicy.preferredID(in: sims.items, current: nil), "on")
        XCTAssertEqual(SIMSelectionPolicy.preferredID(in: sims.items, current: "off"), "off")
        XCTAssertFalse(SIMSelectionPolicy.isOnline("off", sims: sims.items))
        XCTAssertFalse(SIMSelectionPolicy.canDial(on: "gone", sims: sims.items))
        XCTAssertTrue(SIMSelectionPolicy.canDial(on: "on", sims: sims.items))
        XCTAssertTrue(SIMSelectionPolicy.canSendSMS(on: "on", sims: sims.items))
        XCTAssertFalse(SIMSelectionPolicy.canDial(on: "legacy", sims: sims.items))
        XCTAssertFalse(SIMSelectionPolicy.canSendSMS(on: "legacy", sims: sims.items))
    }

    func testCallAvailabilityLocksOnlyTheSelectedGatewayAndKeepsAllActiveCalls() throws {
        let sims: ItemEnvelope<SIMChannel> = try JSONDecoder().decode(
            ItemEnvelope<SIMChannel>.self,
            from: Data(#"{"items":[{"id":"sim-a1","gatewayId":"gateway-a","online":true},{"id":"sim-a2","gatewayId":"gateway-a","online":true},{"id":"sim-b1","gatewayId":"gateway-b","online":true}]}"#.utf8)
        )
        let calls: ItemEnvelope<CallRecord> = try JSONDecoder().decode(
            ItemEnvelope<CallRecord>.self,
            from: Data(#"{"items":[{"id":"call-a","simId":"sim-a1","state":"active","claimedByCurrentSession":true},{"id":"call-b","simId":"sim-b1","state":"incoming_ringing"},{"id":"old","simId":"sim-b1","state":"ended"}]}"#.utf8)
        )
        XCTAssertEqual(CallAvailabilityPolicy.activeCalls(calls.items).map(\.id), ["call-a", "call-b"])
        XCTAssertTrue(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-a2", sims: sims.items, calls: calls.items))
        XCTAssertTrue(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-b1", sims: sims.items, calls: calls.items))

        let onlyGatewayA = Array(calls.items.prefix(1))
        XCTAssertFalse(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-b1", sims: sims.items, calls: onlyGatewayA))
    }

    func testMediaPolicyRequiresCurrentSessionOwnershipAndNeverReplacesAnotherCall() throws {
        let calls: ItemEnvelope<CallRecord> = try JSONDecoder().decode(
            ItemEnvelope<CallRecord>.self,
            from: Data(#"{"items":[{"id":"owned","state":"connecting","claimedByCurrentSession":true},{"id":"other","state":"active","claimedByCurrentSession":false},{"id":"ringing","state":"incoming_ringing","claimedByCurrentSession":true}]}"#.utf8)
        )
        XCTAssertTrue(CallAvailabilityPolicy.canUseMedia(for: calls.items[0], currentMediaCallID: nil))
        XCTAssertTrue(CallAvailabilityPolicy.canUseMedia(for: calls.items[0], currentMediaCallID: "owned"))
        XCTAssertFalse(CallAvailabilityPolicy.canUseMedia(for: calls.items[0], currentMediaCallID: "different"))
        XCTAssertFalse(CallAvailabilityPolicy.canUseMedia(for: calls.items[1], currentMediaCallID: nil))
        XCTAssertFalse(CallAvailabilityPolicy.canUseMedia(for: calls.items[2], currentMediaCallID: nil))
        XCTAssertTrue(CallAvailabilityPolicy.canStartOutbound(currentMediaCallID: nil))
        XCTAssertFalse(CallAvailabilityPolicy.canStartOutbound(currentMediaCallID: "owned"))
        XCTAssertEqual(CallAvailabilityPolicy.primaryOwnedCall(calls.items, currentMediaCallID: nil)?.id, "owned")
        XCTAssertNil(CallAvailabilityPolicy.primaryOwnedCall([calls.items[1]], currentMediaCallID: nil))
    }

    @MainActor
    func testDraftsSurviveNumberSwitchAndClearOnlySelectedConversation() {
        let store = MessageDraftStore()
        store.saveCompose(.init(remoteNumber: "10086", body: "SIM A draft"), accountID: "u1", simID: "sim-a")
        store.saveCompose(.init(remoteNumber: "10010", body: "SIM B draft"), accountID: "u1", simID: "sim-b")
        XCTAssertEqual(store.compose(accountID: "u1", simID: "sim-a").body, "SIM A draft")
        XCTAssertEqual(store.compose(accountID: "u1", simID: "sim-b").remoteNumber, "10010")
        store.clearCompose(accountID: "u1", simID: "sim-a")
        XCTAssertEqual(store.compose(accountID: "u1", simID: "sim-a"), .init())
        XCTAssertEqual(store.compose(accountID: "u1", simID: "sim-b").body, "SIM B draft")
    }

    @MainActor
    func testCallIdempotencyPersistsWithoutPlaintextAndIsBounded() throws {
        let suite = "VoDogTests.call-idempotency.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let storageKey = "pending"
        let payload = OutboundCallPayload(simId: "sim-a", remoteNumber: "+12025550102")
        let firstStore = OutboundCallIdempotencyStore(defaults: defaults, storageKey: storageKey)
        let key = firstStore.key(accountID: "account-a", payload: payload)
        let relaunched = OutboundCallIdempotencyStore(defaults: defaults, storageKey: storageKey)
        XCTAssertEqual(relaunched.key(accountID: "account-a", payload: payload), key)
        XCTAssertNotEqual(relaunched.key(accountID: "account-b", payload: payload), key)

        for index in 0..<140 {
            _ = relaunched.key(accountID: "account-a", payload: .init(simId: "sim-a", remoteNumber: "555\(index)"))
        }
        let data = try XCTUnwrap(defaults.data(forKey: storageKey))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertLessThanOrEqual(object.count, 128)
        let persisted = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(persisted.contains(payload.remoteNumber))
        XCTAssertFalse(persisted.contains("account-a"))

        relaunched.markSucceeded(accountID: "account-a", payload: payload, idempotencyKey: key)
        let confirmed = OutboundCallIdempotencyStore(defaults: defaults, storageKey: storageKey)
        XCTAssertNotEqual(confirmed.key(accountID: "account-a", payload: payload), key)
    }

    @MainActor
    func testSMSIdempotencyMapIsBoundedAndContainsNoMessagePlaintext() throws {
        let suite = "VoDogTests.sms-bounded.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let storageKey = "pending"
        let store = SMSIdempotencyStore(defaults: defaults, storageKey: storageKey)
        for index in 0..<128 {
            _ = try store.key(accountID: "account-a", payload: .init(simId: "sim-a", remoteNumber: "555\(index)", body: "secret body \(index)"))
        }
        let first = SMSOutboundPayload(simId: "sim-a", remoteNumber: "5550", body: "secret body 0")
        let originalKey = try store.key(accountID: "account-a", payload: first)
        XCTAssertThrowsError(try store.key(accountID: "account-a", payload: .init(simId: "sim-a", remoteNumber: "999", body: "new")))
        let restarted = SMSIdempotencyStore(defaults: defaults, storageKey: storageKey)
        XCTAssertEqual(try restarted.key(accountID: "account-a", payload: first), originalKey)
        let data = try XCTUnwrap(defaults.data(forKey: storageKey))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertLessThanOrEqual(object.count, 128)
        let persisted = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(persisted.contains("secret body"))
        XCTAssertFalse(persisted.contains("account-a"))
    }

    private func decodeMessages(_ json: String) throws -> [SMSMessage] {
        try JSONDecoder().decode(ItemEnvelope<SMSMessage>.self, from: Data(json.utf8)).items
    }
}
