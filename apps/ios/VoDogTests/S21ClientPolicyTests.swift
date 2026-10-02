import Contacts
import SwiftUI
import UIKit
import XCTest
@testable import VoDog

/// S21 for the iOS client: 通讯录 (§A), 拦截记录/黑名单闭环 (§B), 网关总控 (§D), AI 转写 (§E), 三端 UI 合同 (§F)
/// and user item 4 (结束通话按钮红色).
final class S21ClientPolicyTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func encodedObject(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - 分阶段部署：新字段必须是可选的

    func testCallRecordDecodesWithoutTheS21Fields() throws {
        let call = try decode(CallRecord.self, #"{"id":"c1","remoteNumber":"2025550101","state":"ended"}"#)
        XCTAssertNil(call.contactId)
        XCTAssertNil(call.contactName)
        XCTAssertNil(call.blocked)
        XCTAssertNil(call.blockedEntryId)
        // Absent must read as "not blocked", never as unknown-and-therefore-shown-as-blocked.
        XCTAssertFalse(call.isBlocked)
    }

    func testCallRecordDecodesTheS21Fields() throws {
        let call = try decode(CallRecord.self, """
        {"id":"c1","remoteNumber":"2025550101","state":"failed","failureReason":"number_blocked",
         "contactId":"ct1","contactName":"张三","blocked":true,"blockedEntryId":"b1"}
        """)
        XCTAssertEqual(call.contactId, "ct1")
        XCTAssertEqual(call.contactName, "张三")
        XCTAssertTrue(call.isBlocked)
        XCTAssertEqual(call.blockedEntryId, "b1")
    }

    func testSMSMessageDecodesWithAndWithoutTheS21Fields() throws {
        let bare = try decode(SMSMessage.self, #"{"id":"m1","remoteNumber":"2025550101"}"#)
        XCTAssertNil(bare.contactName)
        XCTAssertNil(bare.blocked)
        let full = try decode(SMSMessage.self, """
        {"id":"m1","remoteNumber":"2025550101","contactId":"ct1","contactName":"张三",
         "blocked":true,"blockedEntryId":"b1"}
        """)
        XCTAssertEqual(full.contactName, "张三")
        XCTAssertEqual(full.blockedEntryId, "b1")
    }

    func testBlocklistItemDecodesWithoutContactName() throws {
        let item = try decode(BlocklistItem.self, #"{"id":"b1","remoteNumber":"2025550101","createdAt":"2026-09-11T00:00:00Z"}"#)
        XCTAssertNil(item.contactName)
        let named = try decode(BlocklistItem.self, """
        {"id":"b1","remoteNumber":"2025550101","createdAt":"2026-09-11T00:00:00Z","contactName":"张三"}
        """)
        XCTAssertEqual(named.contactName, "张三")
    }

    func testContactDecodesWithMissingChildArrays() throws {
        let contact = try decode(Contact.self, #"{"id":"ct1","displayName":"张三"}"#)
        XCTAssertEqual(contact.phones, [])
        XCTAssertEqual(contact.emails, [])
        XCTAssertEqual(contact.addresses, [])
        XCTAssertFalse(contact.isBlocked)
        XCTAssertNil(contact.primaryPhone)
    }

    func testContactPrimaryPhonePrefersTheFlaggedOne() throws {
        let contact = try decode(Contact.self, """
        {"id":"ct1","displayName":"张三","phones":[
          {"id":"p1","rawNumber":"010-1234","label":"home","isPrimary":false},
          {"id":"p2","rawNumber":"202 555 0101","e164":"+12025550101","label":"mobile","isPrimary":true}],
         "blocked":true}
        """)
        XCTAssertEqual(contact.primaryPhone?.id, "p2")
        // The E.164 the server parsed is what a row prints; the raw import stays available underneath.
        XCTAssertEqual(contact.primaryPhone?.displayNumber, "+12025550101")
        XCTAssertEqual(contact.phones.first?.displayNumber, "010-1234")
        XCTAssertTrue(contact.isBlocked)
    }

    func testContactLookupEnvelopeDecodesANullItem() throws {
        XCTAssertNil(try decode(ContactLookupEnvelope.self, #"{"item":null}"#).item)
        XCTAssertEqual(try decode(ContactLookupEnvelope.self, #"{"item":{"id":"ct1","displayName":"张三"}}"#).item?.id, "ct1")
    }

    func testAiTranscriptDecodesRoles() throws {
        let envelope = try decode(ItemEnvelope<AiTranscriptSegment>.self, """
        {"items":[{"role":"ai","text":"你好","at":"2026-09-11T10:00:00Z"},
                  {"role":"caller","text":"喂"}]}
        """)
        XCTAssertEqual(envelope.items.count, 2)
        XCTAssertTrue(envelope.items[0].isAI)
        XCTAssertEqual(envelope.items[0].roleTitle, "AI 助理")
        XCTAssertEqual(envelope.items[1].roleTitle, "对方")
        XCTAssertNil(envelope.items[1].at)
    }

    func testInterceptionDecodes() throws {
        let envelope = try decode(ItemEnvelope<Interception>.self, """
        {"items":[{"id":"i1","kind":"sms","simId":"s1","simLabel":"SIM 2", "gatewayTimeZone":"Asia/Tokyo",
                   "remoteNumber":"2025550101","contactId":null,
                   "contactName":null,"occurredAt":"2026-09-11T10:00:00Z","bodyPreview":"贷款",
                   "blockedEntryId":"b1","source":"gateway"}]}
        """)
        let item = try XCTUnwrap(envelope.items.first)
        XCTAssertTrue(item.isSMS)
        XCTAssertEqual(item.kindTitle, "短信")
        XCTAssertEqual(item.bodyPreview, "贷款")
        XCTAssertEqual(item.blockedEntryId, "b1")
        XCTAssertEqual(item.simLabel, "SIM 2")
        XCTAssertEqual(item.gatewayTimeZone, "Asia/Tokyo")

        let legacy = try decode(Interception.self, #"{"id":"i2","kind":"call"}"#)
        XCTAssertNil(legacy.simLabel)
        XCTAssertNil(legacy.gatewayTimeZone)
    }

    // MARK: - §A 导入映射

    func testNormalizedLabelStripsTheContactsFrameworkDecoration() {
        XCTAssertEqual(ContactImportMapping.normalizedLabel("_$!<Mobile>!$_"), "mobile")
        XCTAssertEqual(ContactImportMapping.normalizedLabel("_$!<HomeFAX>!$_"), "homefax")
        XCTAssertEqual(ContactImportMapping.normalizedLabel("  老家  "), "老家")
        XCTAssertNil(ContactImportMapping.normalizedLabel(nil))
        XCTAssertNil(ContactImportMapping.normalizedLabel("   "))
        XCTAssertNil(ContactImportMapping.normalizedLabel("_$!<>!$_"))
    }

    func testNormalizedRawNumberKeepsFormattingAndRejectsNonNumbers() {
        // Control parses with libphonenumber; stripping the formatting here would only lose information.
        XCTAssertEqual(ContactImportMapping.normalizedRawNumber("+1 202 555 0101"), "+1 202 555 0101")
        XCTAssertEqual(ContactImportMapping.normalizedRawNumber("  (010) 1234-5678\n"), "(010) 1234-5678")
        XCTAssertEqual(ContactImportMapping.normalizedRawNumber("202\t555\t0101"), "202 555 0101")
        XCTAssertNil(ContactImportMapping.normalizedRawNumber("no digits here"))
        XCTAssertNil(ContactImportMapping.normalizedRawNumber("   "))
    }

    func testNormalizedEmailRequiresAnAtSign() {
        XCTAssertEqual(ContactImportMapping.normalizedEmail(" a@example.com "), "a@example.com")
        XCTAssertNil(ContactImportMapping.normalizedEmail("not-an-email"))
    }

    func testDisplayNameFallsBackThroughFormatterNamePartsOrganizationThenNumber() {
        var contact = DeviceContact(identifier: "1", givenName: "三", familyName: "张", formattedName: "张三")
        XCTAssertEqual(ContactImportMapping.displayName(contact), "张三")
        contact.formattedName = nil
        XCTAssertEqual(ContactImportMapping.displayName(contact), "张 三")
        contact.givenName = ""; contact.familyName = ""
        contact.organizationName = "气候科技"
        XCTAssertEqual(ContactImportMapping.displayName(contact), "气候科技")
        contact.organizationName = ""
        contact.phones = [DeviceLabeledValue(label: nil, value: "202 555 0101")]
        XCTAssertEqual(ContactImportMapping.displayName(contact), "202 555 0101")
        contact.phones = []
        XCTAssertNil(ContactImportMapping.displayName(contact))
    }

    func testImportBodySkipsContactsThatCarryNeitherPhoneNorEmail() {
        let nameOnly = DeviceContact(identifier: "1", formattedName: "只有名字")
        XCTAssertNil(ContactImportMapping.body(for: nameOnly))
        let withEmail = DeviceContact(
            identifier: "2", formattedName: "有邮箱",
            emails: [DeviceLabeledValue(label: "_$!<Work>!$_", value: "a@example.com")]
        )
        XCTAssertNotNil(ContactImportMapping.body(for: withEmail))
    }

    func testImportBodyDeduplicatesPhonesAndEmails() throws {
        let contact = DeviceContact(
            identifier: "cn-1", givenName: "三", familyName: "张", formattedName: "张三",
            phones: [
                DeviceLabeledValue(label: "_$!<Mobile>!$_", value: "202 555 0101"),
                DeviceLabeledValue(label: "_$!<iPhone>!$_", value: "2025550101"),
                DeviceLabeledValue(label: nil, value: "010-1234"),
            ],
            emails: [
                DeviceLabeledValue(label: nil, value: "A@EXAMPLE.com"),
                DeviceLabeledValue(label: "_$!<Work>!$_", value: "a@example.com"),
            ]
        )
        let body = try XCTUnwrap(ContactImportMapping.body(for: contact))
        XCTAssertEqual(body.phones.count, 2)
        XCTAssertEqual(body.phones.first?.rawNumber, "202 555 0101")
        XCTAssertEqual(body.phones.first?.label, "mobile")
        XCTAssertEqual(body.emails.count, 1)
        XCTAssertEqual(body.sourceContactId, "cn-1")
        XCTAssertEqual(body.displayName, "张三")
        // The restricted note entitlement is not held, so notes are never read or sent.
        XCTAssertNil(body.notes)
    }

    func testImportBodyDropsEmptyPostalAddresses() throws {
        let contact = DeviceContact(
            identifier: "1", formattedName: "张三",
            phones: [DeviceLabeledValue(label: nil, value: "2025550101")],
            addresses: [
                DevicePostalAddress(label: "_$!<Home>!$_", formatted: "北京市朝阳区", city: "北京市"),
                DevicePostalAddress(label: "_$!<Work>!$_", formatted: "  "),
            ]
        )
        let body = try XCTUnwrap(ContactImportMapping.body(for: contact))
        XCTAssertEqual(body.addresses.count, 1)
        XCTAssertEqual(body.addresses.first?.label, "home")
        XCTAssertEqual(body.addresses.first?.formatted, "北京市朝阳区")
    }

    func testImportBatchesAtTwoThousand() {
        let bodies = (0..<4501).map {
            ContactUpsertBody(displayName: "n\($0)", phones: [ContactPhoneBody(rawNumber: "202555\($0)", label: nil)])
        }
        let batches = ContactImportMapping.batches(bodies)
        XCTAssertEqual(ContactImportMapping.maxBatchSize, 2000)
        XCTAssertEqual(batches.map(\.count), [2000, 2000, 501])
        XCTAssertEqual(batches.flatMap { $0 }.count, bodies.count)
        XCTAssertTrue(ContactImportMapping.batches([]).isEmpty)
    }

    func testImportRequestOmitsAbsentOptionalKeysInsteadOfSendingNull() throws {
        let request = ContactImportRequest(
            source: ContactImportMapping.source, sourceDeviceId: nil,
            contacts: [ContactUpsertBody(
                displayName: "张三", phones: [ContactPhoneBody(rawNumber: "2025550101", label: nil)]
            )]
        )
        let object = try encodedObject(request)
        XCTAssertEqual(object["source"] as? String, "ios")
        XCTAssertNil(object.index(forKey: "sourceDeviceId"))
        let contact = try XCTUnwrap((object["contacts"] as? [[String: Any]])?.first)
        XCTAssertEqual(contact["displayName"] as? String, "张三")
        for absent in ["givenName", "familyName", "organization", "notes", "sourceContactId", "emails", "addresses"] {
            XCTAssertNil(contact.index(forKey: absent), "\(absent) must be omitted, not null")
        }
        let phone = try XCTUnwrap((contact["phones"] as? [[String: Any]])?.first)
        XCTAssertEqual(phone["rawNumber"] as? String, "2025550101")
        XCTAssertNil(phone.index(forKey: "label"))
    }

    func testImportRequestKeepsTheDeviceIdWhenKnown() throws {
        let object = try encodedObject(ContactImportRequest(
            source: "ios", sourceDeviceId: "DEV-1",
            contacts: [ContactUpsertBody(displayName: "张三", phones: [ContactPhoneBody(rawNumber: "1", label: "mobile")])]
        ))
        XCTAssertEqual(object["sourceDeviceId"] as? String, "DEV-1")
    }

    func testImportResultDefaultsMissingCountersAndSumsBatches() throws {
        let partial = try decode(ContactImportResult.self, #"{"total":3,"created":3}"#)
        XCTAssertEqual(partial.merged, 0)
        XCTAssertEqual(partial.phonesSkipped, 0)
        let sum = partial + ContactImportResult(total: 2, created: 0, updated: 1, merged: 1, skipped: 0, phonesSkipped: 4)
        XCTAssertEqual(sum.total, 5)
        XCTAssertEqual(sum.updated, 1)
        XCTAssertEqual(sum.phonesSkipped, 4)
    }

    func testImportSummaryWording() {
        let base = ContactImportResult(total: 312, created: 200, updated: 12, merged: 3, skipped: 97)
        XCTAssertEqual(ContactImportSummary.text(base, locallySkipped: 0), "共 312 条 · 新增 200 · 更新 12 · 合并 3 · 跳过 97")
        let withExtras = ContactImportResult(total: 312, created: 200, updated: 12, merged: 3, skipped: 97, phonesSkipped: 4)
        XCTAssertEqual(
            ContactImportSummary.text(withExtras, locallySkipped: 2),
            "共 312 条 · 新增 200 · 更新 12 · 合并 3 · 跳过 97 · 号码跳过 4 · 本机跳过 2"
        )
    }

    func testAccessDeniedMessageOnlyForDeniedAndRestricted() {
        XCTAssertNotNil(ContactImportSummary.accessDeniedMessage(.denied))
        XCTAssertNotNil(ContactImportSummary.accessDeniedMessage(.restricted))
        XCTAssertNil(ContactImportSummary.accessDeniedMessage(.notDetermined))
        XCTAssertNil(ContactImportSummary.accessDeniedMessage(.authorized))
    }

    func testLookupPolicyRequiresEnoughDigitsAndBuildsTheListQuery() {
        XCTAssertFalse(ContactLookupPolicy.shouldLookup("18"))
        XCTAssertTrue(ContactLookupPolicy.shouldLookup("186"))
        XCTAssertFalse(ContactLookupPolicy.shouldLookup("+"))
        XCTAssertEqual(ContactLookupPolicy.listQuery(query: "  ").map(\.name), ["limit"])
        let searched = ContactLookupPolicy.listQuery(query: " 张三 ")
        XCTAssertEqual(searched.map(\.name), ["query", "limit"])
        XCTAssertEqual(searched.first?.value, "张三")
    }

    // MARK: - §F 联系人卡片

    func testCardOffersCreateAndBlockForAnUnmatchedNumber() {
        XCTAssertEqual(
            ContactCardActionPolicy.actions(hasNumber: true, hasContact: false, blocked: false, canBlock: true),
            [.call, .sms, .createContact, .addToExisting, .block]
        )
    }

    func testCardOffersUnblockAndNoCreationForAMatchedBlockedNumber() {
        XCTAssertEqual(
            ContactCardActionPolicy.actions(hasNumber: true, hasContact: true, blocked: true, canBlock: true),
            [.call, .sms, .unblock]
        )
    }

    func testCardNeverOffersBothBlockAndUnblock() {
        for hasContact in [true, false] {
            for blocked in [true, false] {
                let actions = ContactCardActionPolicy.actions(
                    hasNumber: true, hasContact: hasContact, blocked: blocked, canBlock: true
                )
                XCTAssertNotEqual(actions.contains(.block), actions.contains(.unblock))
            }
        }
    }

    /// An emergency number can never be blocked, but an already-blocked one must still be releasable.
    func testCardHidesBlockForANumberThatMayNotBeBlocked() {
        XCTAssertEqual(
            ContactCardActionPolicy.actions(hasNumber: true, hasContact: true, blocked: false, canBlock: false),
            [.call, .sms]
        )
        XCTAssertTrue(
            ContactCardActionPolicy.actions(hasNumber: true, hasContact: true, blocked: true, canBlock: false)
                .contains(.unblock)
        )
        XCTAssertFalse(HistoryRowActionPolicy.canBlock(remoteNumber: "112"))
    }

    func testCardWithoutANumberOffersNothing() {
        XCTAssertTrue(ContactCardActionPolicy.actions(hasNumber: false, hasContact: true, blocked: false, canBlock: true).isEmpty)
    }

    func testCardTargetsCarryTheBlockStateOfTheirSource() throws {
        let call = try decode(CallRecord.self, """
        {"id":"c1","simId":"s1","remoteNumber":"2025550101","contactName":"张三","blocked":true,"blockedEntryId":"b1"}
        """)
        let fromCall = ContactCardTarget(call: call)
        XCTAssertEqual(fromCall.rawNumber, "2025550101")
        XCTAssertEqual(fromCall.simId, "s1")
        XCTAssertEqual(fromCall.sourceCallId, "c1")
        XCTAssertTrue(fromCall.blocked)
        XCTAssertEqual(fromCall.blockedEntryId, "b1")

        let interception = try decode(Interception.self, """
        {"id":"i1","kind":"call","simId":"s1","remoteNumber":"2025550101","blockedEntryId":"b2"}
        """)
        // An interception exists because the number is blocked, so the card opens straight into 解除屏蔽.
        XCTAssertTrue(ContactCardTarget(interception: interception).blocked)
        // S66: an SMS interception is on 短信黑名单; the card's 屏蔽 is 来电黑名单, so nothing is seeded.
        let smsInterception = try decode(Interception.self, """
        {"id":"i2","kind":"sms","simId":"s1","remoteNumber":"2025550101","blockedEntryId":"b3"}
        """)
        XCTAssertFalse(ContactCardTarget(interception: smsInterception).blocked)
        XCTAssertNil(ContactCardTarget(interception: smsInterception).blockedEntryId)

        let contact = Contact(
            id: "ct1", displayName: "张三",
            phones: [ContactPhone(id: "p1", rawNumber: "202 555 0101", e164: "+12025550101", isPrimary: true)],
            blocked: false
        )
        let fromContact = ContactCardTarget(contact: contact)
        XCTAssertEqual(fromContact.rawNumber, "+12025550101")
        XCTAssertEqual(fromContact.contact?.id, "ct1")
        XCTAssertFalse(fromContact.blocked)
    }

    func testEveryCardPresentationGetsItsOwnIdentity() {
        let call = CallRecord(
            id: "c1", simId: nil, direction: nil, remoteNumber: "1", state: nil, startedAt: nil,
            answeredAt: nil, endedAt: nil, answeredByPlatform: nil, answeredByDevice: nil,
            originatingPlatform: nil, claimedByCurrentSession: nil, failureReason: nil,
            recordingStatus: nil, transcript: nil, gatewayTimeZone: nil, occupancy: nil,
            contactId: nil, contactName: nil, blocked: nil, blockedEntryId: nil
        )
        XCTAssertNotEqual(ContactCardTarget(call: call).id, ContactCardTarget(call: call).id)
    }

    // MARK: - §F 号码 · 姓名

    func testNumberWithNameWording() {
        XCTAssertEqual(ContactDisplay.numberWithName(number: "2025550101", contactName: "张三"), "2025550101 · 张三")
        XCTAssertEqual(ContactDisplay.numberWithName(number: "2025550101", contactName: nil), "2025550101")
        XCTAssertEqual(ContactDisplay.numberWithName(number: "2025550101", contactName: "  "), "2025550101")
        XCTAssertEqual(ContactDisplay.numberWithName(number: nil, contactName: "张三"), "张三")
        XCTAssertEqual(ContactDisplay.numberWithName(number: nil, contactName: nil), "未知号码")
    }

    func testTitleLeadsWithTheName() {
        XCTAssertEqual(ContactDisplay.title(number: "2025550101", contactName: "张三"), "张三")
        XCTAssertEqual(ContactDisplay.title(number: "2025550101", contactName: nil), "2025550101")
        XCTAssertEqual(ContactDisplay.title(number: " ", contactName: " "), "未知号码")
    }

    // MARK: - §A 追加：ContactDto 自带屏蔽条目，优先于 GET /blocklist 兜底

    func testContactPhoneDecodesTheBlockFieldsAsOptional() throws {
        let bare = try decode(ContactPhone.self, #"{"id":"p1","rawNumber":"2025550101"}"#)
        XCTAssertNil(bare.blocked)
        XCTAssertNil(bare.blockedEntryId)
        let stated = try decode(ContactPhone.self, """
        {"id":"p1","rawNumber":"2025550101","blocked":true,"blockedEntryId":"b9"}
        """)
        XCTAssertEqual(stated.blocked, true)
        XCTAssertEqual(stated.blockedEntryId, "b9")
        let contact = try decode(Contact.self, #"{"id":"ct1","displayName":"张三","blockedEntryId":"b1"}"#)
        XCTAssertEqual(contact.blockedEntryId, "b1")
        XCTAssertNil(try decode(Contact.self, #"{"id":"ct1","displayName":"张三"}"#).blockedEntryId)
    }

    func testBlockStatePrefersTheMatchingPhoneEntry() {
        let contact = Contact(
            id: "ct1", displayName: "张三",
            phones: [
                ContactPhone(id: "p1", rawNumber: "202-555-0106", blocked: false),
                ContactPhone(id: "p2", rawNumber: "202 555 0101", e164: "+12025550101",
                             isPrimary: true, blocked: true, blockedEntryId: "b9"),
            ],
            blocked: true, blockedEntryId: "b1"
        )
        let resolved = ContactBlockState.resolve(
            number: "2025550101", contact: contact, current: ContactBlockState(blocked: false, entryID: nil)
        )
        XCTAssertEqual(resolved, ContactBlockState(blocked: true, entryID: "b9"))
        // The contact's other number is clean and must not inherit the blocked one's state or entry id —
        // releasing that id would unblock the wrong line.
        XCTAssertEqual(
            ContactBlockState.resolve(
                number: "2025550106", contact: contact, current: ContactBlockState(blocked: false, entryID: nil)
            ),
            ContactBlockState(blocked: false, entryID: nil)
        )
        // A stale `blocked` from an older call row is corrected by the fresh per-phone reading.
        XCTAssertEqual(
            ContactBlockState.resolve(
                number: "2025550106", contact: contact, current: ContactBlockState(blocked: true, entryID: "b7")
            ),
            ContactBlockState(blocked: false, entryID: nil)
        )
    }

    func testBlockStateTreatsAPhoneEntryIdWithoutAFlagAsBlocked() {
        let contact = Contact(
            id: "ct1", displayName: "张三",
            phones: [ContactPhone(id: "p1", rawNumber: "2025550101", blockedEntryId: "b9")]
        )
        XCTAssertEqual(
            ContactBlockState.resolve(
                number: "2025550101", contact: contact, current: ContactBlockState(blocked: false, entryID: nil)
            ),
            ContactBlockState(blocked: true, entryID: "b9")
        )
    }

    func testBlockStateBorrowsTheContactEntryOnlyWhenTheNumberIsKnownBlocked() {
        let contact = Contact(
            id: "ct1", displayName: "张三",
            phones: [ContactPhone(id: "p1", rawNumber: "2025550101")],
            blocked: true, blockedEntryId: "b1"
        )
        // Blocked with no id from the call row: the contact-level id replaces the GET /blocklist scan.
        XCTAssertEqual(
            ContactBlockState.resolve(
                number: "2025550101", contact: contact, current: ContactBlockState(blocked: true, entryID: nil)
            ),
            ContactBlockState(blocked: true, entryID: "b1")
        )
        // Not blocked for this number: nothing is borrowed.
        XCTAssertEqual(
            ContactBlockState.resolve(
                number: "2025550101", contact: contact, current: ContactBlockState(blocked: false, entryID: nil)
            ),
            ContactBlockState(blocked: false, entryID: nil)
        )
        // An id the source already knew is never overwritten.
        XCTAssertEqual(
            ContactBlockState.resolve(
                number: "2025550101", contact: contact, current: ContactBlockState(blocked: true, entryID: "b7")
            ),
            ContactBlockState(blocked: true, entryID: "b7")
        )
    }

    func testBlockStateWithoutAContactKeepsWhatTheRowSaid() {
        let current = ContactBlockState(blocked: true, entryID: "b1")
        XCTAssertEqual(ContactBlockState.resolve(number: "2025550101", contact: nil, current: current), current)
        let bare = Contact(id: "ct1", displayName: "张三", phones: [ContactPhone(id: "p1", rawNumber: "2025550")])
        XCTAssertEqual(ContactBlockState.resolve(number: "2025550101", contact: bare, current: current), current)
    }

    func testCardFromAContactCarriesThePhoneLevelEntry() {
        let contact = Contact(
            id: "ct1", displayName: "张三",
            phones: [ContactPhone(id: "p1", rawNumber: "202 555 0101", e164: "+12025550101",
                                  isPrimary: true, blocked: true, blockedEntryId: "b9")],
            blocked: true, blockedEntryId: "b1"
        )
        let target = ContactCardTarget(contact: contact)
        XCTAssertTrue(target.blocked)
        XCTAssertEqual(target.blockedEntryId, "b9")
    }

    func testPhoneDialKeyMatching() {
        XCTAssertTrue(PhoneDialKey.matches("+1 202 555 0101", "2025550101"))
        XCTAssertTrue(PhoneDialKey.matches("2025550101", "+12025550101"))
        XCTAssertTrue(PhoneDialKey.matches("202-555-0106", "2025550106"))
        XCTAssertFalse(PhoneDialKey.matches("2025550101", "2025550104"))
        XCTAssertFalse(PhoneDialKey.matches("0101", "2025550101"))
        XCTAssertFalse(PhoneDialKey.matches("", "2025550101"))
    }

    // MARK: - §F 短信线程的姓名与卡片

    private func smsJSON(
        id: String, address: String, createdAt: String,
        contactName: String? = nil, blocked: Bool? = nil, blockedEntryId: String? = nil
    ) -> String {
        var fields = [
            #""id":"\#(id)""#, #""simId":"sim-a""#, #""remoteNumber":"\#(address)""#,
            #""conversationAddress":"\#(address)""#, #""direction":"incoming""#,
            #""body":"hi""#, #""createdAt":"\#(createdAt)""#,
        ]
        if let contactName { fields.append(#""contactName":"\#(contactName)""#) }
        if let blocked { fields.append(#""blocked":\#(blocked)"#) }
        if let blockedEntryId { fields.append(#""blockedEntryId":"\#(blockedEntryId)""#) }
        return "{" + fields.joined(separator: ",") + "}"
    }

    private func conversation(from json: [String]) throws -> MessageConversation {
        let messages = try decode(ItemEnvelope<SMSMessage>.self, "{\"items\":[\(json.joined(separator: ","))]}").items
        return try XCTUnwrap(MessageConversation.grouped(messages, selectedSIMID: "sim-a").first)
    }

    func testThreadTakesTheNewestStatedNameAndBlockState() throws {
        let thread = try conversation(from: [
            smsJSON(id: "m1", address: "2025550101", createdAt: "2026-09-11T10:00:00Z"),
            smsJSON(id: "m2", address: "2025550101", createdAt: "2026-09-11T11:00:00Z",
                    contactName: "张三", blocked: true, blockedEntryId: "b1"),
        ])
        XCTAssertEqual(thread.contactName, "张三")
        XCTAssertTrue(thread.blocked)
        XCTAssertEqual(thread.blockedEntryId, "b1")
        XCTAssertEqual(thread.displayTitle, "2025550101 · 张三")
    }

    func testThreadFollowsAnUnblockStatedByTheNewestMessage() throws {
        let thread = try conversation(from: [
            smsJSON(id: "m1", address: "2025550101", createdAt: "2026-09-11T10:00:00Z",
                    contactName: "张三", blocked: true, blockedEntryId: "b1"),
            smsJSON(id: "m2", address: "2025550101", createdAt: "2026-09-11T11:00:00Z", blocked: false),
        ])
        XCTAssertFalse(thread.blocked)
        // An older page that predates S21 must not blank out a name the server already stated.
        XCTAssertEqual(thread.contactName, "张三")
    }

    func testThreadOnAPreS21ServerPrintsTheNumberAlone() throws {
        let thread = try conversation(from: [
            smsJSON(id: "m1", address: "2025550101", createdAt: "2026-09-11T10:00:00Z"),
        ])
        XCTAssertNil(thread.contactName)
        XCTAssertFalse(thread.blocked)
        XCTAssertEqual(thread.displayTitle, "2025550101")
    }

    func testThreadBlankNameIsTreatedAsNoName() throws {
        let thread = try conversation(from: [
            smsJSON(id: "m1", address: "2025550101", createdAt: "2026-09-11T10:00:00Z", contactName: "   "),
        ])
        XCTAssertNil(thread.contactName)
        XCTAssertEqual(thread.displayTitle, "2025550101")
    }

    func testThreadCardTargetCarriesNumberSimAndBlockState() throws {
        let thread = try conversation(from: [
            smsJSON(id: "m1", address: "2025550101", createdAt: "2026-09-11T10:00:00Z",
                    contactName: "张三", blocked: true, blockedEntryId: "b1"),
        ])
        let target = try XCTUnwrap(ContactCardTarget(conversation: thread))
        XCTAssertEqual(target.rawNumber, "2025550101")
        XCTAssertEqual(target.simId, "sim-a")
        XCTAssertEqual(target.contactName, "张三")
        // S66: the thread's block state is the SMS list; the card reads the call list itself.
        XCTAssertFalse(target.blocked)
        XCTAssertNil(target.blockedEntryId)
        XCTAssertNil(target.sourceCallId)
    }

    func testConversationSummaryOfAnEmptyThreadIsEmpty() {
        XCTAssertEqual(ConversationContactSummary.from([]), ConversationContactSummary())
    }

    // MARK: - §B 解除屏蔽时的条目查找

    func testBlocklistEntryLookupMatchesExactlyThenBySignificantDigits() {
        let items = [
            BlocklistItem(id: "b1", remoteNumber: "+1 202 555 0101", createdAt: "t"),
            BlocklistItem(id: "b2", remoteNumber: "2025550106", createdAt: "t"),
        ]
        XCTAssertEqual(BlocklistEntryLookup.entryID(for: "+12025550101", in: items), "b1")
        XCTAssertEqual(BlocklistEntryLookup.entryID(for: "2025550101", in: items), "b1")
        XCTAssertEqual(BlocklistEntryLookup.entryID(for: "202 555 0106", in: items), "b2")
        XCTAssertNil(BlocklistEntryLookup.entryID(for: "2025550104", in: items))
        // Too short to identify a line: matching on it could unblock the wrong number.
        XCTAssertNil(BlocklistEntryLookup.entryID(for: "0101", in: items))
        XCTAssertNil(BlocklistEntryLookup.entryID(for: "", in: items))
    }

    func testInterceptionKindFilter() throws {
        let items = try decode(ItemEnvelope<Interception>.self, """
        {"items":[{"id":"i1","kind":"call"},{"id":"i2","kind":"sms"},{"id":"i3","kind":"call"}]}
        """).items
        XCTAssertEqual(InterceptionKindFilter.apply(.all, to: items).map(\.id), ["i1", "i2", "i3"])
        XCTAssertEqual(InterceptionKindFilter.apply(.call, to: items).map(\.id), ["i1", "i3"])
        XCTAssertEqual(InterceptionKindFilter.apply(.sms, to: items).map(\.id), ["i2"])
    }

    // MARK: - §D 网关总控

    func testGatewayPowerDecodesAPartialObjectConservatively() throws {
        let item = try decode(GatewayPower.self, #"{"gatewayId":"g1"}"#)
        XCTAssertFalse(item.online)
        XCTAssertFalse(item.standbyOnline)
        XCTAssertFalse(item.remotePowerAllowed)
        XCTAssertFalse(item.controlEnabled)
        XCTAssertFalse(item.occupied)
        XCTAssertNil(item.lastPowerResult)
        XCTAssertEqual(GatewayPowerPolicy.statusTitle(item), "离线")
        // Missing fields must not make a remote action look available.
        XCTAssertNotNil(GatewayPowerPolicy.toggleDisabledReason(item))
    }

    func testGatewayPowerDecodesTheFullDto() throws {
        let item = try decode(GatewayPower.self, """
        {"gatewayId":"g1","name":"Pixel 8","controlEnabled":false,"online":false,"lastSeenAt":"t1",
         "standbyOnline":true,"standbySeenAt":"t2","remotePowerAllowed":true,"desiredPower":"on",
         "desiredPowerRequestedAt":"t3","lastPowerResult":{"desired":"on","ok":false,"reason":"call_in_progress","at":"t4"},
         "occupied":false}
        """)
        XCTAssertEqual(GatewayPowerPolicy.displayName(item), "Pixel 8")
        XCTAssertEqual(GatewayPowerPolicy.statusTitle(item), "待命中")
        XCTAssertEqual(GatewayPowerPolicy.remotePowerTitle(item), "远程开启已允许")
        XCTAssertEqual(GatewayPowerPolicy.pendingTitle(item), "已请求开启，等待网关响应…")
        XCTAssertEqual(GatewayPowerPolicy.lastResultMessage(item), "上次远程开启失败：网关正在通话中")
        XCTAssertNil(GatewayPowerPolicy.toggleDisabledReason(item))
    }

    func testGatewayPowerStatusTitles() {
        XCTAssertEqual(GatewayPowerPolicy.statusTitle(GatewayPower(gatewayId: "g", online: true)), "在线")
        XCTAssertEqual(GatewayPowerPolicy.statusTitle(GatewayPower(gatewayId: "g", standbyOnline: true)), "待命中")
        XCTAssertEqual(GatewayPowerPolicy.statusTitle(GatewayPower(gatewayId: "g")), "离线")
        // Heartbeating wins: a gateway that is up is 在线 even if a stale standby row is still present.
        XCTAssertEqual(
            GatewayPowerPolicy.statusTitle(GatewayPower(gatewayId: "g", online: true, standbyOnline: true)), "在线"
        )
        XCTAssertEqual(GatewayPowerPolicy.displayName(GatewayPower(gatewayId: "0123456789abcdef")), "PX-01234567")
        XCTAssertEqual(
            GatewayPowerPolicy.remotePowerTitle(GatewayPower(gatewayId: "g")),
            "远程开启未允许（需在网关设备上打开）"
        )
    }

    func testGatewayToggleIsBlockedForEveryConditionTheServerWouldRefuse() {
        // remote_power_allowed=false → 409 GATEWAY_REMOTE_POWER_NOT_ALLOWED.
        XCTAssertEqual(
            GatewayPowerPolicy.toggleDisabledReason(GatewayPower(gatewayId: "g", online: true)),
            "需先在网关设备上打开「允许远程开启（待命）」"
        )
        // desired=off while a call lock exists → 409 GATEWAY_IN_USE (decision 6).
        XCTAssertEqual(
            GatewayPowerPolicy.toggleDisabledReason(GatewayPower(
                gatewayId: "g", controlEnabled: true, online: true, remotePowerAllowed: true, occupied: true
            )),
            "网关正在通话中，暂时无法远程关闭"
        )
        // desired=off while not online → 409 GATEWAY_OFFLINE.
        XCTAssertEqual(
            GatewayPowerPolicy.toggleDisabledReason(GatewayPower(
                gatewayId: "g", controlEnabled: true, online: false, remotePowerAllowed: true
            )),
            "网关不在线，暂时无法远程关闭"
        )
        // desired=on without a live standby beacon → 409 GATEWAY_STANDBY_OFFLINE.
        XCTAssertEqual(
            GatewayPowerPolicy.toggleDisabledReason(GatewayPower(
                gatewayId: "g", controlEnabled: false, standbyOnline: false, remotePowerAllowed: true
            )),
            "网关待命通道离线，暂时无法远程开启"
        )
        XCTAssertNil(GatewayPowerPolicy.toggleDisabledReason(GatewayPower(
            gatewayId: "g", controlEnabled: false, standbyOnline: true, remotePowerAllowed: true
        )))
        XCTAssertNil(GatewayPowerPolicy.toggleDisabledReason(GatewayPower(
            gatewayId: "g", controlEnabled: true, online: true, remotePowerAllowed: true
        )))
    }

    func testGatewayToggleMirrorsControlEnabledNotConnectivity() {
        XCTAssertTrue(GatewayPowerPolicy.isOn(GatewayPower(gatewayId: "g", controlEnabled: true, online: false)))
        XCTAssertFalse(GatewayPowerPolicy.isOn(GatewayPower(gatewayId: "g", controlEnabled: false, standbyOnline: true)))
    }

    func testGatewayPowerServerCodesMapToChinese() {
        let codes = [
            "GATEWAY_REMOTE_POWER_NOT_ALLOWED", "GATEWAY_STANDBY_OFFLINE", "GATEWAY_OFFLINE", "GATEWAY_IN_USE",
        ]
        for code in codes {
            let message = GatewayPowerPolicy.message(for: APIError.server(409, "conflict", code))
            XCTAssertEqual(message, GatewayPowerPolicy.codeMessages[code])
            XCTAssertNotEqual(message, "conflict", "\(code) must not leak the server wording")
        }
        // An unmapped failure still says something, rather than nothing.
        XCTAssertEqual(GatewayPowerPolicy.message(for: APIError.server(500, "服务器错误", "OOPS")), "服务器错误")
        XCTAssertFalse(GatewayPowerPolicy.message(for: APIError.unauthorized).isEmpty)
    }

    func testGatewayLastPowerResultOnlyReportsFailures() {
        let ok = GatewayPower(
            gatewayId: "g", lastPowerResult: GatewayPowerResult(desired: "on", ok: true, at: "t")
        )
        XCTAssertNil(GatewayPowerPolicy.lastResultMessage(ok))
        XCTAssertEqual(GatewayPowerPolicy.lastResultSuccessMessage(ok), "上次远程开启成功")
        let failedOff = GatewayPower(
            gatewayId: "g", lastPowerResult: GatewayPowerResult(desired: "off", ok: false, reason: "call_in_progress")
        )
        XCTAssertEqual(GatewayPowerPolicy.lastResultMessage(failedOff), "上次远程关闭失败：网关正在通话中")
        let unknownReason = GatewayPower(
            gatewayId: "g", lastPowerResult: GatewayPowerResult(desired: "on", ok: false, reason: "weird_thing")
        )
        XCTAssertEqual(GatewayPowerPolicy.lastResultMessage(unknownReason), "上次远程开启失败：weird_thing")
        XCTAssertNil(GatewayPowerPolicy.lastResultSuccessMessage(unknownReason))
        XCTAssertEqual(GatewayPowerPolicy.refreshInterval, .seconds(5))
    }

    func testSettingsRoleAndPermissionCopyUsesUserFacingChinese() {
        XCTAssertEqual(SettingsRolePolicy.title("admin"), "管理员")
        XCTAssertEqual(SettingsRolePolicy.title("user"), "用户")
        XCTAssertEqual(SettingsRolePolicy.title("unexpected"), "暂不可用")
        XCTAssertEqual(SettingsRolePolicy.title(nil), "暂不可用")

        XCTAssertEqual(SettingsPermissionPolicy.status(.allowed), "已允许")
        XCTAssertEqual(SettingsPermissionPolicy.status(.denied), "未允许")
        XCTAssertEqual(SettingsPermissionPolicy.status(.notDetermined), "尚未请求")
        XCTAssertNil(SettingsPermissionPolicy.action(.microphone, state: .allowed))
        XCTAssertEqual(
            SettingsPermissionPolicy.action(.notifications, state: .notDetermined), "允许来电通知"
        )
        XCTAssertEqual(
            SettingsPermissionPolicy.action(.microphone, state: .notDetermined), "允许通话麦克风"
        )
        XCTAssertEqual(SettingsPermissionPolicy.action(.notifications, state: .denied), "打开系统设置")
    }

    func testGatewayHeartbeatShowsLiveAndStandbyObservationsWithoutInventingOne() {
        let item = GatewayPower(
            gatewayId: "g", lastSeenAt: "live", standbySeenAt: "standby"
        )
        XCTAssertEqual(
            GatewayPowerPolicy.heartbeatTitle(item) { "[\($0)]" },
            "最近心跳 [live] · 待命心跳 [standby]"
        )
        XCTAssertEqual(
            GatewayPowerPolicy.heartbeatTitle(GatewayPower(gatewayId: "g")) { $0 },
            "尚未收到心跳"
        )
    }

    // MARK: - 用户第 4 项：结束通话按钮是红色

    func testDangerColourIsRedInBothSchemes() {
        for style: UIUserInterfaceStyle in [.light, .dark] {
            let resolved = UIColor(Color.callerDanger).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            let scheme = style == .dark ? "dark" : "light"
            // The S20 dark value was the pink (255,179,191) the user complained about: g≈0.70, b≈0.75. S95 Signal
            // danger (#C2302B / #FF7A73) is relative: green and blue stay at most half of red.
            XCTAssertLessThanOrEqual(green, 0.5 * red, "danger green channel in \(scheme)")
            XCTAssertLessThanOrEqual(blue, 0.5 * red, "danger blue channel in \(scheme)")
            XCTAssertGreaterThan(red - max(green, blue), 0.5, "danger must read as red, not rose, in \(scheme)")
        }
    }
}
