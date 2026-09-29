package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S24 决策 3「AI 语音服务」的客户端规则。iOS (`S24ClientPolicyTests.swift`) 是参考实现，这里逐条对齐
 * 同样的断言：状态映射、`未配置` 压过 `服务离线`、禁用原因、打勾与是否值得发 PUT、409 文案。
 */
class S24ClientPolicyTest {

    private val contract = JSONObject(
        """
        {"items":[{"id":"xai","label":"xAI Grok","configured":true,"online":true},
                  {"id":"doubao","label":"豆包","configured":false,"online":false}],"selected":"xai"}
        """.trimIndent(),
    )

    private fun provider(
        id: String = "xai",
        label: String = "xAI Grok",
        configured: Boolean = true,
        online: Boolean = true,
    ) = ClientVoiceProvider(id, label, configured, online)

    // ---- DTO 解码 -----------------------------------------------------------------------------

    @Test fun decodesTheContractResponse() {
        val list = contract.toClientVoiceProviderList()
        assertEquals("xai", list.selected)
        assertEquals(2, list.items.size)
        assertEquals(ClientVoiceProvider("xai", "xAI Grok", true, true), list.items[0])
        assertEquals(ClientVoiceProvider("doubao", "豆包", false, false), list.items[1])
        assertEquals(1L, list.configVersion)
    }

    @Test fun providerConfigVersionUsesTheServerValueAndCompatibilityFloor() {
        assertEquals(7L, JSONObject("""{"configVersion":7}""").toClientVoiceProviderList().configVersion)
        assertEquals(1L, JSONObject("""{"configVersion":0}""").toClientVoiceProviderList().configVersion)
    }

    @Test fun missingFlagsDecodeAsUnconfigured() {
        // A partial object must read as 未配置 rather than inviting a switch the server would refuse.
        val list = JSONObject("""{"items":[{"id":"xai"}]}""").toClientVoiceProviderList()
        assertEquals(ClientVoiceProvider("xai", "xai", false, false), list.items.single())
        assertEquals("", list.selected)
        assertEquals(VoiceProviderAvailability.NOT_CONFIGURED, voiceProviderAvailability(list.items.single()))
    }

    @Test fun anEmptyResponseDecodesToAnEmptyList() {
        val list = JSONObject("{}").toClientVoiceProviderList()
        assertTrue(list.items.isEmpty())
        assertEquals("", list.selected)
    }

    @Test fun aBlankLabelFallsBackToTheId() {
        val list = JSONObject("""{"items":[{"id":"xai","label":"  "}]}""").toClientVoiceProviderList()
        assertEquals("xai", list.items.single().label)
    }

    @Test fun theSwitchRoutesAreTheContractPaths() {
        assertEquals("/ai/voice-providers", ClientApiRoutes.AI_VOICE_PROVIDERS)
        assertEquals("/ai/voice-provider", ClientApiRoutes.AI_VOICE_PROVIDER)
    }

    // ---- 状态映射 -----------------------------------------------------------------------------

    @Test fun statusMapsTheTwoFlagsToThreeLabels() {
        assertEquals("可用", voiceProviderStatusLabel(provider()))
        assertEquals("服务离线", voiceProviderStatusLabel(provider(online = false)))
        assertEquals("未配置", voiceProviderStatusLabel(provider(id = "doubao", label = "豆包", configured = false)))
    }

    @Test fun missingConfigurationOutranksAHeartbeat() {
        // 未配置 wins over 服务离线: an unconfigured provider cannot be selected even if a worker announces it.
        val announced = provider(id = "doubao", label = "豆包", configured = false, online = true)
        assertEquals(VoiceProviderAvailability.NOT_CONFIGURED, voiceProviderAvailability(announced))
        assertEquals("未配置", voiceProviderStatusLabel(announced))
        assertFalse(voiceProviderSelectable(announced))
    }

    @Test fun unavailableRowsCarryTheirReasonAsASubtitle() {
        assertEquals("", voiceProviderDisabledReason(provider()))
        assertEquals("服务器未配置这个语音服务", voiceProviderDisabledReason(provider(configured = false)))
        assertEquals("语音服务当前离线，暂时无法切换", voiceProviderDisabledReason(provider(online = false)))
    }

    // ---- 选中与提交 ---------------------------------------------------------------------------

    @Test fun theSelectedRowKeepsItsCheckmarkEvenWhenItIsOffline() {
        val offline = provider(online = false)
        assertTrue(voiceProviderSelected(offline, "xai"))
        assertFalse(voiceProviderSelectable(offline))
        assertFalse(voiceProviderShouldSubmit(offline, "xai"))
    }

    @Test fun noCheckmarkWhenTheServerSendsNoSelection() {
        assertFalse(voiceProviderSelected(provider(), ""))
    }

    @Test fun tappingTheCurrentSelectionIsANoOp() {
        assertFalse(voiceProviderShouldSubmit(provider(), "xai"))
        assertTrue(voiceProviderShouldSubmit(provider(id = "doubao", label = "豆包"), "xai"))
        assertTrue(voiceProviderShouldSubmit(provider(), ""))
    }

    @Test fun unavailableRowsNeverSubmit() {
        assertFalse(voiceProviderShouldSubmit(provider(id = "doubao", label = "豆包", configured = false), "xai"))
        assertFalse(voiceProviderShouldSubmit(provider(id = "doubao", label = "豆包", online = false), "xai"))
    }

    // ---- 失败提示 -----------------------------------------------------------------------------

    @Test fun theServerMessageIsShownFirst() {
        val error = ApiError(409, "PROVIDER_UNAVAILABLE", "豆包尚未配置，无法切换。")
        assertEquals("豆包尚未配置，无法切换。", error.voiceProviderUserMessage())
    }

    @Test fun versionConflictUsesReviewCopyAndKeepsTheServerVersion() {
        val conflict = ApiError(
            409,
            "PROVIDER_VERSION_CONFLICT",
            "stale",
            JSONObject().put("currentVersion", 12),
        )
        assertTrue(conflict.isVoiceProviderVersionConflict())
        assertEquals(12L, conflict.voiceProviderConflictVersion())
        assertEquals("设置已被另一端更新，请核对后重试", conflict.voiceProviderUserMessage())
    }

    @Test fun theCodeIsOnlyAFallbackForAnEmptyMessage() {
        assertEquals(
            "这个语音服务当前不可用（未配置或服务离线），已保留原来的选择。",
            voiceProviderErrorMessage("PROVIDER_UNAVAILABLE", "  "),
        )
        assertEquals("切换语音服务失败，请稍后重试。", voiceProviderErrorMessage("", ""))
    }

    @Test fun theFooterExplainsWhatTheSwitchAffects() {
        assertEquals("切换只影响之后的 AI 即接 / 超时代接来电。", VOICE_PROVIDER_FOOTER)
    }
}
