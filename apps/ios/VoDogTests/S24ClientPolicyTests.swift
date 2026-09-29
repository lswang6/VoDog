import XCTest
@testable import VoDog

/// S24 决策 3 的三端合同：`GET /api/v1/ai/voice-providers` 的解码，以及设置页「AI 语音服务」分组的
/// 状态映射与禁用逻辑。iOS 是参考实现，Android (`S24ClientPolicyTest`) 与 Web (`voice-provider.test.ts`)
/// 逐条对齐同样的断言。
final class S24ClientPolicyTests: XCTestCase {

    private func decodeList(_ json: String) throws -> VoiceProviderList {
        try JSONDecoder().decode(VoiceProviderList.self, from: Data(json.utf8))
    }

    // MARK: - DTO 解码

    func testDecodesTheContractResponse() throws {
        let list = try decodeList("""
        {"items":[{"id":"xai","label":"xAI Grok","configured":true,"online":true},
                  {"id":"doubao","label":"豆包","configured":false,"online":false}],"selected":"xai","configVersion":7}
        """)
        XCTAssertEqual(list.items.count, 2)
        XCTAssertEqual(list.selected, "xai")
        XCTAssertEqual(list.configVersion, 7)
        XCTAssertEqual(list.items[0], VoiceProvider(id: "xai", label: "xAI Grok", configured: true, online: true))
        XCTAssertEqual(list.items[1], VoiceProvider(id: "doubao", label: "豆包", configured: false, online: false))
    }

    func testMissingFlagsDecodeAsUnconfigured() throws {
        // A partial object must read as "未配置" rather than inviting a switch the server would refuse.
        let list = try decodeList(#"{"items":[{"id":"xai"}]}"#)
        XCTAssertEqual(list.items, [VoiceProvider(id: "xai")])
        XCTAssertNil(list.selected)
        XCTAssertFalse(list.items[0].configured)
        XCTAssertFalse(list.items[0].online)
        XCTAssertEqual(VoiceProviderPolicy.availability(list.items[0]), .notConfigured)
    }

    func testAnEmptyResponseDecodesToAnEmptyList() throws {
        XCTAssertEqual(try decodeList("{}"), VoiceProviderList())
        XCTAssertEqual(try decodeList(#"{"items":[],"selected":null}"#), VoiceProviderList())
        XCTAssertEqual(try decodeList("{}").configVersion, 1)
    }

    func testTheSwitchBodyCarriesTheObservedConfigurationVersion() throws {
        let encoded = try JSONEncoder().encode(VoiceProviderBody(provider: "xai", expectedVersion: 7))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(object["provider"] as? String, "xai")
        XCTAssertEqual(object["expectedVersion"] as? Int, 7)
    }

    // MARK: - 状态映射

    func testStatusMapsTheTwoFlagsToThreeLabels() {
        let ready = VoiceProvider(id: "xai", label: "xAI Grok", configured: true, online: true)
        let offline = VoiceProvider(id: "xai", label: "xAI Grok", configured: true, online: false)
        let unconfigured = VoiceProvider(id: "doubao", label: "豆包", configured: false, online: false)
        XCTAssertEqual(VoiceProviderPolicy.statusTitle(ready), "可用")
        XCTAssertEqual(VoiceProviderPolicy.statusTitle(offline), "服务离线")
        XCTAssertEqual(VoiceProviderPolicy.statusTitle(unconfigured), "未配置")
    }

    func testMissingConfigurationOutranksAHeartbeat() {
        // 未配置 wins over 服务离线: an unconfigured provider cannot be selected even if a worker announces it.
        let announced = VoiceProvider(id: "doubao", label: "豆包", configured: false, online: true)
        XCTAssertEqual(VoiceProviderPolicy.availability(announced), .notConfigured)
        XCTAssertEqual(VoiceProviderPolicy.statusTitle(announced), "未配置")
        XCTAssertFalse(VoiceProviderPolicy.isSelectable(announced))
    }

    func testUnavailableRowsCarryTheirReasonAsASubtitle() {
        XCTAssertNil(VoiceProviderPolicy.disabledReason(VoiceProvider(id: "xai", configured: true, online: true)))
        XCTAssertEqual(
            VoiceProviderPolicy.disabledReason(VoiceProvider(id: "doubao", configured: false)),
            "服务器未配置这个语音服务"
        )
        XCTAssertEqual(
            VoiceProviderPolicy.disabledReason(VoiceProvider(id: "xai", configured: true, online: false)),
            "语音服务当前离线，暂时无法切换"
        )
    }

    func testLabelFallsBackToTheId() {
        XCTAssertEqual(VoiceProviderPolicy.displayLabel(VoiceProvider(id: "xai", label: "xAI Grok")), "xAI Grok")
        XCTAssertEqual(VoiceProviderPolicy.displayLabel(VoiceProvider(id: "xai", label: "   ")), "xai")
        XCTAssertEqual(VoiceProviderPolicy.displayLabel(VoiceProvider(id: "xai")), "xai")
    }

    // MARK: - 选中与提交

    func testTheSelectedRowKeepsItsCheckmarkEvenWhenItIsOffline() {
        let offline = VoiceProvider(id: "xai", label: "xAI Grok", configured: true, online: false)
        XCTAssertTrue(VoiceProviderPolicy.isSelected(offline, selected: "xai"), "服务器上的选择仍然是它")
        XCTAssertFalse(VoiceProviderPolicy.isSelectable(offline), "但这一行不能点")
        XCTAssertFalse(VoiceProviderPolicy.shouldSubmit(offline, selected: "xai"))
    }

    func testNoCheckmarkWhenTheServerSendsNoSelection() {
        let item = VoiceProvider(id: "xai", configured: true, online: true)
        XCTAssertFalse(VoiceProviderPolicy.isSelected(item, selected: nil))
        XCTAssertFalse(VoiceProviderPolicy.isSelected(item, selected: ""))
    }

    func testTappingTheCurrentSelectionIsANoOp() {
        let current = VoiceProvider(id: "xai", label: "xAI Grok", configured: true, online: true)
        let other = VoiceProvider(id: "doubao", label: "豆包", configured: true, online: true)
        XCTAssertFalse(VoiceProviderPolicy.shouldSubmit(current, selected: "xai"), "不重复写审计")
        XCTAssertTrue(VoiceProviderPolicy.shouldSubmit(other, selected: "xai"))
        XCTAssertTrue(VoiceProviderPolicy.shouldSubmit(current, selected: nil))
    }

    func testUnavailableRowsNeverSubmit() {
        XCTAssertFalse(VoiceProviderPolicy.shouldSubmit(VoiceProvider(id: "doubao", label: "豆包"), selected: "xai"))
        XCTAssertFalse(
            VoiceProviderPolicy.shouldSubmit(VoiceProvider(id: "doubao", configured: true, online: false), selected: "xai")
        )
    }

    // MARK: - 失败提示

    func testTheServerMessageIsShownFirst() {
        let error = APIError.server(409, "豆包尚未配置，无法切换。", "PROVIDER_UNAVAILABLE")
        XCTAssertEqual(VoiceProviderPolicy.message(for: error), "豆包尚未配置，无法切换。")
    }

    func testTheCodeIsOnlyAFallbackForAnEmptyMessage() {
        let error = APIError.server(409, "   ", "PROVIDER_UNAVAILABLE")
        XCTAssertEqual(
            VoiceProviderPolicy.message(for: error),
            "这个语音服务当前不可用（未配置或服务离线），已保留原来的选择。"
        )
    }

    func testAnUnknownFailureFallsBackToItsOwnDescription() {
        let error = APIError.server(500, "", "SERVER_ERROR")
        XCTAssertEqual(VoiceProviderPolicy.message(for: error), "请求失败（500）")
    }

    func testTheFooterExplainsWhatTheSwitchAffects() {
        XCTAssertEqual(VoiceProviderPolicy.footerText, "切换只影响之后的 AI 即接 / 超时代接来电。")
    }

    func testProviderConflictIsDistinctFromUnavailable409() {
        XCTAssertTrue(ProviderConcurrencyPolicy.isConflict(
            APIError.server(409, "stale", "PROVIDER_VERSION_CONFLICT")
        ))
        XCTAssertTrue(ProviderConcurrencyPolicy.isConflict(
            APIError.server(428, "required", "PROVIDER_VERSION_REQUIRED")
        ))
        XCTAssertFalse(ProviderConcurrencyPolicy.isConflict(
            APIError.server(409, "offline", "PROVIDER_UNAVAILABLE")
        ))
    }

    func testProviderConflictRetainsTheAttemptedChoiceUntilExplicitReload() {
        let conflict = ProviderConflictState(attemptedProviderID: "doubao", attemptedProviderLabel: "豆包")
        XCTAssertEqual(conflict.attemptedProviderID, "doubao")
        XCTAssertEqual(ProviderConcurrencyPolicy.attemptedChoiceMessage(conflict), "你刚才尝试选择：豆包")
        XCTAssertTrue(ProviderConcurrencyPolicy.conflictMessage.contains("载入并确认"))
    }
}

final class S32ContactConcurrencyTests: XCTestCase {
    func testContactVersionDefaultsToOneAndDecodesCurrentValue() throws {
        let legacy = try JSONDecoder().decode(Contact.self, from: Data(#"{"id":"c1","displayName":"张三"}"#.utf8))
        let current = try JSONDecoder().decode(Contact.self, from: Data(#"{"id":"c1","displayName":"张三","version":9}"#.utf8))
        XCTAssertEqual(legacy.version, 1)
        XCTAssertEqual(current.version, 9)
    }

    func testContactUpdateCarriesExpectedVersionButCreateOmitsIt() throws {
        let update = try JSONEncoder().encode(ContactUpsertBody(expectedVersion: 9, displayName: "张三"))
        let create = try JSONEncoder().encode(ContactUpsertBody(displayName: "张三"))
        let updateObject = try XCTUnwrap(JSONSerialization.jsonObject(with: update) as? [String: Any])
        let createObject = try XCTUnwrap(JSONSerialization.jsonObject(with: create) as? [String: Any])
        XCTAssertEqual(updateObject["expectedVersion"] as? Int, 9)
        XCTAssertNil(createObject["expectedVersion"])
    }

    func testOnlyContactCASFailuresRequireDraftReview() {
        XCTAssertTrue(ContactConcurrencyPolicy.isConflict(APIError.server(409, "", "CONTACT_VERSION_CONFLICT")))
        XCTAssertTrue(ContactConcurrencyPolicy.isConflict(APIError.server(428, "", "CONTACT_VERSION_REQUIRED")))
        XCTAssertFalse(ContactConcurrencyPolicy.isConflict(APIError.server(409, "", "PROVIDER_UNAVAILABLE")))
        XCTAssertEqual(ContactConcurrencyPolicy.deleteQuery(expectedVersion: 9).first?.name, "expectedVersion")
        XCTAssertEqual(ContactConcurrencyPolicy.deleteQuery(expectedVersion: 9).first?.value, "9")
        XCTAssertEqual(ForegroundRefreshPolicy.interval, .seconds(5))
    }

    func testDismissingConflictPromptDoesNotUnlockStaleDraft() {
        var gate = ContactDraftConflictGate()
        gate.recordConflict()
        XCTAssertTrue(gate.isLocked)
        // Alert presentation changes do not touch the gate. Only adopting a fresh server version unlocks it.
        XCTAssertTrue(gate.isLocked)
        gate.acceptFreshVersion()
        XCTAssertFalse(gate.isLocked)
    }

    func testSIMDraftVersionsNeverAdvanceAcrossADirtyExternalChange() {
        XCTAssertTrue(SIMDraftConcurrencyPolicy.hasExternalChange(
            currentVersion: 8, baseVersion: 7, draftIsDirty: true
        ))
        XCTAssertFalse(SIMDraftConcurrencyPolicy.hasExternalChange(
            currentVersion: 8, baseVersion: 7, draftIsDirty: false
        ))
        XCTAssertFalse(SIMDraftConcurrencyPolicy.hasExternalChange(
            currentVersion: 7, baseVersion: 7, draftIsDirty: true
        ))
        XCTAssertTrue(SIMDraftConcurrencyPolicy.isConflict(
            APIError.server(409, "stale", "VERSION_CONFLICT")
        ))
        XCTAssertFalse(SIMDraftConcurrencyPolicy.isConflict(
            APIError.server(409, "offline", "AI_UNAVAILABLE")
        ))
    }

    func testTranscriptResultDecodesFreshClassifierFieldsWithoutBreakingLegacyRows() throws {
        let fresh = try JSONDecoder().decode(TranscriptResult.self, from: Data(#"{"text":"x","segments":[],"providers":[],"advertisingClassification":"advertising","includeInReports":true,"summary":"摘要","actionItems":[],"blockRecommended":true,"blockCategory":"sales","blockReason":"推销"}"#.utf8))
        let legacy = try JSONDecoder().decode(TranscriptResult.self, from: Data(#"{"text":"x","segments":[],"providers":[],"advertisingClassification":"unknown","includeInReports":true,"summary":null,"actionItems":[]}"#.utf8))
        XCTAssertEqual(fresh.blockRecommended, true)
        XCTAssertEqual(fresh.blockReason, "推销")
        XCTAssertNil(legacy.blockRecommended)
        XCTAssertNil(legacy.blockReason)
    }
}
