import XCTest
@testable import VoDog

/// S30 三端删除. Everything the delete surfaces decide — may this row go, what the confirmation says, what the
/// list and the pager look like afterwards, which ids the request carries — is a pure function, and this is
/// where it is pinned.
final class S30ClientPolicyTests: XCTestCase {

    // MARK: - RecordDeletePolicy

    func testRecordDeleteOnlyOffersTerminalCallsAndFallsBackToEndedAt() throws {
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: "ended", endedAt: "2026-09-13T00:00:00Z"))
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: "failed", endedAt: nil))
        // A live call is Control's 409, so the row does not even offer the button.
        for live in ["incoming_ringing", "outgoing_pending", "connecting", "active", "ending"] {
            XCTAssertFalse(
                RecordDeletePolicy.canDelete(state: live, endedAt: nil),
                "\(live) is still running and must not be deletable"
            )
        }
        // Even an `ended_at` cannot make a state the client knows to be live deletable.
        XCTAssertFalse(RecordDeletePolicy.canDelete(state: "active", endedAt: "2026-09-13T00:00:00Z"))
        // A vocabulary this build has never seen is judged by `ended_at` alone, and fails closed without one.
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: "reconcile_unknown", endedAt: "2026-09-13T00:00:00Z"))
        XCTAssertFalse(RecordDeletePolicy.canDelete(state: "reconcile_unknown", endedAt: nil))
        XCTAssertFalse(RecordDeletePolicy.canDelete(state: nil, endedAt: "   "))
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: nil, endedAt: "2026-09-13T00:00:00Z"))
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: "ENDED", endedAt: nil))

        let ended = try decodeCall(#"{"id":"c1","state":"ended","endedAt":"2026-09-13T00:00:00Z"}"#)
        let ringing = try decodeCall(#"{"id":"c2","state":"incoming_ringing"}"#)
        XCTAssertTrue(RecordDeletePolicy.canDelete(ended))
        XCTAssertFalse(RecordDeletePolicy.canDelete(ringing))
    }

    func testRecordDeleteCopyIsTheFrozenS30Wording() {
        XCTAssertEqual(RecordDeletePolicy.actionTitle, "删除")
        XCTAssertEqual(RecordDeletePolicy.confirmTitle, "删除这条通话记录？")
        // S39 §G: the Pixel's own dialer log is deleted too, and the confirmation now says so.
        XCTAssertEqual(RecordDeletePolicy.confirmMessage, "录音、转写、报告条目和网关设备上的通话记录会一起删除，无法恢复。")
        XCTAssertEqual(RecordDeletePolicy.confirmButton, "删除")
        XCTAssertEqual(RecordDeletePolicy.cancelButton, "取消")
        XCTAssertEqual(RecordDeletePolicy.inUseMessage, "通话仍在进行或处理中，稍后再删")
        XCTAssertEqual(RecordDeletePolicy.accessibilityIdentifier, "records.delete")
    }

    func testRecordDelete409IsTheOnlyStatusWithItsOwnWording() {
        XCTAssertEqual(
            RecordDeletePolicy.errorMessage(APIError.server(409, "call is in use", "CALL_IN_USE")),
            RecordDeletePolicy.inUseMessage
        )
        // 404 means someone else already deleted it; the transport's own message stands.
        XCTAssertEqual(
            RecordDeletePolicy.errorMessage(APIError.server(404, "not found", nil)),
            APIError.server(404, "not found", nil).localizedDescription
        )
        XCTAssertEqual(
            RecordDeletePolicy.errorMessage(APIError.unauthorized),
            APIError.unauthorized.localizedDescription
        )
        XCTAssertNotEqual(
            RecordDeletePolicy.errorMessage(APIError.server(500, "", nil)),
            RecordDeletePolicy.inUseMessage
        )
    }

    func testRecordDeleteRemovesTheRowAndItsReportEntryTogether() throws {
        let calls = try [
            decodeCall(#"{"id":"c1","state":"ended"}"#),
            decodeCall(#"{"id":"c2","state":"ended"}"#),
        ]
        XCTAssertEqual(RecordDeletePolicy.callsAfterDelete(calls, id: "c1").map(\.id), ["c2"])
        XCTAssertEqual(RecordDeletePolicy.callsAfterDelete(calls, id: "nope").map(\.id), ["c1", "c2"])

        let items = try decodeReportItems(#"""
        {"items":[
          {"callId":"c1","startedAt":"2026-09-13T00:00:00Z","sim":{"id":"sim-a"}},
          {"callId":"c2","startedAt":"2026-09-13T00:01:00Z","sim":{"id":"sim-a"}}
        ]}
        """#)
        XCTAssertEqual(RecordDeletePolicy.reportItemsAfterDelete(items, callID: "c1").map(\.callId), ["c2"])
    }

    func testRecordDeleteDecrementsTheTotalAndRewindsOffAnEmptiedLastPage() {
        // 51 rows at 50 a page is two pages; deleting the only row on page 2 leaves one page and rewinds.
        let total = RecordDeletePolicy.totalAfterDelete(51)
        XCTAssertEqual(total, 50)
        let pages = RecordDeletePolicy.totalPagesAfterDelete(total: total, totalPages: 2, pageSize: 50)
        XCTAssertEqual(pages, 1)
        XCTAssertEqual(RecordDeletePolicy.pageAfterDelete(page: 2, totalPages: pages), 1)

        // A page that keeps rows stays where it is.
        let stillFour = RecordDeletePolicy.totalPagesAfterDelete(total: 187, totalPages: 4, pageSize: 50)
        XCTAssertEqual(stillFour, 4)
        XCTAssertEqual(RecordDeletePolicy.pageAfterDelete(page: 2, totalPages: stillFour), 2)

        // The last row of the whole list: zero rows still has a first page, and the total never goes negative.
        XCTAssertEqual(RecordDeletePolicy.totalAfterDelete(1), 0)
        XCTAssertEqual(RecordDeletePolicy.totalAfterDelete(0), 0)
        XCTAssertEqual(RecordDeletePolicy.totalPagesAfterDelete(total: 0, totalPages: 1, pageSize: 50), 1)
        XCTAssertEqual(RecordDeletePolicy.pageAfterDelete(page: 1, totalPages: 1), 1)

        // A Control that does not page must stay unpaged: nil is what hides the bar, 0 would show it.
        XCTAssertNil(RecordDeletePolicy.totalAfterDelete(nil))
        XCTAssertNil(RecordDeletePolicy.totalPagesAfterDelete(total: nil, totalPages: nil, pageSize: 50))
        XCTAssertEqual(RecordDeletePolicy.totalPagesAfterDelete(total: nil, totalPages: 3, pageSize: 50), 3)

        // A page size the server would reject falls back to the default before the arithmetic, never to 0.
        XCTAssertEqual(RecordDeletePolicy.totalPagesAfterDelete(total: 120, totalPages: 3, pageSize: 7), 3)
        XCTAssertEqual(RecordDeletePolicy.totalPagesAfterDelete(total: 201, totalPages: 2, pageSize: 200), 2)
    }

    @MainActor
    func testRecordDeleteAppliesToTheRealPagingStore() {
        let store = RecordsPagingStore(page: 2, pageSize: 50, total: 51, totalPages: 2)
        let total = RecordDeletePolicy.totalAfterDelete(store.total)
        let pages = RecordDeletePolicy.totalPagesAfterDelete(
            total: total, totalPages: store.totalPages, pageSize: store.pageSize
        )
        store.apply(
            page: RecordDeletePolicy.pageAfterDelete(page: store.page, totalPages: pages),
            total: total, totalPages: pages, requestedPage: store.page
        )
        XCTAssertEqual(store.total, 50)
        XCTAssertEqual(store.totalPages, 1)
        XCTAssertEqual(store.page, 1, "The emptied page 2 must rewind rather than stay on a page that is gone")
        XCTAssertFalse(store.showsPager, "One default-size page has nothing left to page through")
    }

    // MARK: - MessageSelectionPolicy

    func testMessageSelectionTogglesSelectsAllAndClears() {
        var selection = MessageSelectionPolicy.clear()
        XCTAssertTrue(selection.isEmpty)
        selection = MessageSelectionPolicy.toggle("m1", in: selection)
        XCTAssertEqual(selection, ["m1"])
        selection = MessageSelectionPolicy.toggle("m2", in: selection)
        XCTAssertEqual(selection, ["m1", "m2"])
        selection = MessageSelectionPolicy.toggle("m1", in: selection)
        XCTAssertEqual(selection, ["m2"], "A second tap on the same bubble deselects it")
        XCTAssertEqual(MessageSelectionPolicy.selectAll(["m1", "m2", "m3"]), ["m1", "m2", "m3"])
        XCTAssertTrue(MessageSelectionPolicy.clear().isEmpty)
    }

    func testMessageSelectionTitleAndTheFiveHundredIdCeiling() {
        XCTAssertEqual(MessageSelectionPolicy.title(count: 0), "已选 0 条")
        XCTAssertEqual(MessageSelectionPolicy.title(count: 3), "已选 3 条")
        XCTAssertFalse(MessageSelectionPolicy.canDelete([]))
        XCTAssertTrue(MessageSelectionPolicy.canDelete(["m1"]))
        let atCeiling = Set((0..<MessageSelectionPolicy.maximumBatch).map { "m\($0)" })
        XCTAssertEqual(atCeiling.count, 500)
        XCTAssertTrue(MessageSelectionPolicy.canDelete(atCeiling))
        XCTAssertFalse(MessageSelectionPolicy.isOverLimit(atCeiling))
        let overCeiling = atCeiling.union(["one-too-many"])
        XCTAssertFalse(MessageSelectionPolicy.canDelete(overCeiling), "POST /sms/delete takes 1–500 ids")
        XCTAssertTrue(MessageSelectionPolicy.isOverLimit(overCeiling))
        XCTAssertEqual(MessageSelectionPolicy.deleteSelectedTitle, "删除所选")
        XCTAssertEqual(MessageSelectionPolicy.selectAllTitle, "全选")
        XCTAssertEqual(MessageSelectionPolicy.cancelTitle, "取消")
        XCTAssertEqual(MessageSelectionPolicy.deleteSelectedAccessibilityIdentifier, "conversation.deleteSelected")
        XCTAssertEqual(MessageSelectionPolicy.selectModeAccessibilityIdentifier, "conversation.selectMode")
    }

    func testMessageSelectionRequestKeepsThreadOrderAndFiltersLocally() throws {
        let messages = try decodeMessages(#"""
        {"items":[
          {"id":"m1","simId":"sim-a","remoteNumber":"2025550102","direction":"incoming","body":"1","createdAt":"2026-09-13T00:00:00Z"},
          {"id":"m2","simId":"sim-a","remoteNumber":"2025550102","direction":"outgoing","body":"2","createdAt":"2026-09-13T00:01:00Z"},
          {"id":"m3","simId":"sim-a","remoteNumber":"2025550102","direction":"incoming","body":"3","createdAt":"2026-09-13T00:02:00Z"}
        ]}
        """#)
        // A `Set` has no order; the body must still be the thread's, so two identical taps send one identical request.
        XCTAssertEqual(MessageSelectionPolicy.orderedIDs(["m3", "m1"], in: messages), ["m1", "m3"])
        XCTAssertEqual(MessageSelectionPolicy.orderedIDs(["nope"], in: messages), [])
        XCTAssertEqual(
            MessageSelectionPolicy.remaining(messages, deleting: ["m1", "m3"]).map(\.id), ["m2"]
        )
        XCTAssertEqual(MessageSelectionPolicy.remaining(messages, deleting: []).map(\.id), ["m1", "m2", "m3"])
    }

    func testMessageSelectionHidesOnlyWhatTheServerActuallyDeleted() {
        let requested = ["m1", "m2", "m3"]
        let skipped = [SMSDeleteSkip(id: "m2", reason: "in_flight")]
        XCTAssertEqual(MessageSelectionPolicy.acceptedIDs(requested: requested, skipped: skipped), ["m1", "m3"])
        XCTAssertEqual(MessageSelectionPolicy.acceptedIDs(requested: requested, skipped: []), requested)
        XCTAssertEqual(MessageSelectionPolicy.skippedMessage(skipped), "1 条正在发送中，暂时无法删除。")
        XCTAssertNil(MessageSelectionPolicy.skippedMessage([]))
    }

    // MARK: - ThreadSwipeActionPolicy

    func testS66BlockCopyNamesOnlyTheListItWrites() {
        XCTAssertEqual(ThreadSwipeActionPolicy.deleteAndBlockConfirmMessage,
                       "这段对话会被彻底删除，之后不再接收这个号码的短信（来电不受影响）。")
        XCTAssertEqual(ContactCardActionPolicy.blockConfirmMessage, "屏蔽后，该号码的来电会被直接挂断，短信不受影响。")
        XCTAssertEqual(ContactCardActionPolicy.unblockConfirmMessage, "解除后，该号码的来电会恢复正常接听。")
        XCTAssertEqual(BlocklistScope.sms.unblockConfirmMessage, "解除后，这个号码的短信会恢复正常接收。")
        XCTAssertEqual(BlocklistScope.allCases.map(\.title), ["来电", "短信"])
        XCTAssertEqual(BlocklistSummaryPolicy.summary(call: 0, sms: 0), "暂无")
        XCTAssertEqual(BlocklistSummaryPolicy.summary(call: 429, sms: 1), "来电 429 · 短信 1")
    }

    func testThreadSwipeKeepsDeleteAtTheEdgeAndDropsBlockForEmergencyNumbers() {
        XCTAssertEqual(
            ThreadSwipeActionPolicy.actions(remoteNumber: "2025550102"), [.delete, .deleteAndBlock],
            "Declaration order is edge-first on a trailing swipe, so 删除 must be listed before 删除并屏蔽"
        )
        // 屏蔽 reuses the history row's judgement, which is what excludes 112 / 911 in exactly one place.
        XCTAssertEqual(ThreadSwipeActionPolicy.actions(remoteNumber: "112"), [.delete])
        XCTAssertEqual(ThreadSwipeActionPolicy.actions(remoteNumber: "911"), [.delete])
        XCTAssertEqual(ThreadSwipeActionPolicy.actions(remoteNumber: nil), [.delete])
        XCTAssertEqual(ThreadSwipeActionPolicy.actions(remoteNumber: "  "), [.delete])
        XCTAssertEqual(
            ThreadSwipeActionPolicy.canBlock(remoteNumber: "2025550102"),
            HistoryRowActionPolicy.canBlock(remoteNumber: "2025550102")
        )
        XCTAssertEqual(
            ThreadSwipeActionPolicy.canBlock(remoteNumber: "112"),
            HistoryRowActionPolicy.canBlock(remoteNumber: "112")
        )
    }

    func testThreadSwipeCopyAndIdentifiers() {
        XCTAssertEqual(ThreadSwipeActionPolicy.title(.delete), "删除")
        XCTAssertEqual(ThreadSwipeActionPolicy.title(.deleteAndBlock), "删除并屏蔽")
        XCTAssertEqual(ThreadSwipeActionPolicy.confirmTitle(.delete), "删除这段对话？")
        XCTAssertEqual(ThreadSwipeActionPolicy.confirmTitle(.deleteAndBlock), "删除并屏蔽此号码？")
        XCTAssertFalse(ThreadSwipeActionPolicy.confirmMessage(.delete).isEmpty)
        XCTAssertFalse(ThreadSwipeActionPolicy.confirmMessage(.deleteAndBlock).isEmpty)
        XCTAssertNotEqual(
            ThreadSwipeActionPolicy.confirmMessage(.delete),
            ThreadSwipeActionPolicy.confirmMessage(.deleteAndBlock)
        )
        XCTAssertEqual(ThreadSwipeActionPolicy.accessibilityIdentifier(.delete), "threads.delete")
        XCTAssertEqual(ThreadSwipeActionPolicy.accessibilityIdentifier(.deleteAndBlock), "threads.deleteAndBlock")
        XCTAssertEqual(ThreadSwipeActionPolicy.cancelTitle, "取消")
        XCTAssertEqual(ThreadSwipeActionPolicy.confirmButton, "删除")
    }

    func testThreadBlockRejectionIsTheOnlyStatusWithItsOwnWording() {
        XCTAssertEqual(
            ThreadSwipeActionPolicy.blockErrorMessage(APIError.server(400, "emergency", "EMERGENCY_NUMBER")),
            ThreadSwipeActionPolicy.blockRejectedMessage
        )
        XCTAssertTrue(
            ThreadSwipeActionPolicy.blockRejectedMessage.contains("没有删除"),
            "A refused block must say the thread is still there"
        )
        XCTAssertEqual(
            ThreadSwipeActionPolicy.blockErrorMessage(APIError.server(500, "boom", nil)),
            APIError.server(500, "boom", nil).localizedDescription
        )
    }

    func testThreadDeleteKeepsServerSkippedMessagesRowsAndReportsPartialSuccess() {
        let response = SMSDeleteResponseFixture.partial
        XCTAssertEqual(
            ThreadDeleteResultPolicy.acceptedIDs(requested: ["m1", "m2", "m3"], response: response),
            ["m1", "m3"]
        )
        XCTAssertEqual(ThreadDeleteResultPolicy.feedback(response), "1 条正在发送中，暂时无法删除。")
        XCTAssertEqual(
            ThreadSwipeActionPolicy.blockSucceededDeleteFailedMessage,
            "号码已屏蔽，但对话删除失败，请重试"
        )
    }

    func testThreadKeyIsTheServerAddressWhileTheBlockNumberStaysRaw() throws {
        let messages = try decodeMessages(#"""
        {"items":[
          {"id":"m1","simId":"sim-a","remoteNumber":"2025550102","conversationAddress":"+12025550102","direction":"incoming","body":"1","createdAt":"2026-09-13T00:00:00Z"},
          {"id":"m2","simId":"sim-a","remoteNumber":"+1 202-555-0102","conversationAddress":"+12025550102","direction":"outgoing","body":"2","createdAt":"2026-09-13T00:01:00Z"}
        ]}
        """#)
        let thread = try XCTUnwrap(MessageConversation.grouped(messages, selectedSIMID: "sim-a").first)
        XCTAssertEqual(thread.threadAddress, "+12025550102", "POST /sms/threads/delete is keyed by the server's address")
        XCTAssertEqual(thread.blockNumber, "+1 202-555-0102", "POST /blocklist takes the raw remote_number")
        XCTAssertNotEqual(thread.blockNumber, thread.id.remoteNumber)

        // A pre-S21 server sends no `conversationAddress`; the thread then keys on `remoteNumber` as §1.3 says.
        let legacy = try decodeMessages(#"""
        {"items":[{"id":"m3","simId":"sim-b","remoteNumber":"10086","direction":"incoming","body":"x","createdAt":"2026-09-13T00:00:00Z"}]}
        """#)
        let legacyThread = try XCTUnwrap(MessageConversation.grouped(legacy, selectedSIMID: "sim-b").first)
        XCTAssertEqual(legacyThread.threadAddress, "10086")
        XCTAssertEqual(legacyThread.blockNumber, "10086")
    }

    // MARK: - Helpers

    private func decodeCall(_ json: String) throws -> CallRecord {
        try JSONDecoder().decode(CallRecord.self, from: Data(json.utf8))
    }

    private func decodeMessages(_ json: String) throws -> [SMSMessage] {
        try JSONDecoder().decode(ItemEnvelope<SMSMessage>.self, from: Data(json.utf8)).items
    }

    private func decodeReportItems(_ json: String) throws -> [CallReportItem] {
        struct Envelope: Decodable { let items: [CallReportItem] }
        return try JSONDecoder().decode(Envelope.self, from: Data(json.utf8)).items
    }
}

private enum SMSDeleteResponseFixture {
    static var partial: SMSDeleteResponse {
        try! JSONDecoder().decode(
            SMSDeleteResponse.self,
            from: Data(#"{"deleted":2,"skipped":[{"id":"m2","reason":"in_flight"}]}"#.utf8)
        )
    }
}
