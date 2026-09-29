package org.vodog

import org.json.JSONObject

/**
 * S24 决策 3 设置页「AI 语音服务」分组的全部判断。
 *
 * iOS (`VoiceProviderPolicy.swift`) 是三端参考实现；这里的文案、状态语义和禁用逻辑与它逐条对齐，
 * Web 的 `voice-provider.ts` 同理。两个布尔位来自两个来源：`configured` 是 Control 的
 * `AI_VOICE_PROVIDERS`（这台服务器允许哪些供应商），`online` 是 Voice worker 心跳宣告的 `providers`。
 * 缺配置永远压过离线——没配好的供应商即使有心跳也切不过去。
 */
enum class VoiceProviderAvailability { AVAILABLE, NOT_CONFIGURED, OFFLINE }

data class ClientVoiceProvider(
    val id: String,
    val label: String,
    val configured: Boolean,
    val online: Boolean,
)

/** `GET /ai/voice-providers` 与 `PUT /ai/voice-provider` 的同一个结构。 */
data class ClientVoiceProviderList(
    val items: List<ClientVoiceProvider>,
    val selected: String,
    val configVersion: Long = 1,
)

/** 分组底部说明：切换只改之后新建的 AI run，进行中的通话不受影响。 */
const val VOICE_PROVIDER_FOOTER = "切换只影响之后的 AI 即接 / 超时代接来电。"

internal fun JSONObject.toClientVoiceProvider(): ClientVoiceProvider {
    val id = getString("id")
    return ClientVoiceProvider(
        id = id,
        // A server that sends no label (or a blank one) still has to render as something clickable.
        label = optString("label").trim().ifBlank { id },
        configured = optBoolean("configured"),
        online = optBoolean("online"),
    )
}

internal fun JSONObject.toClientVoiceProviderList(): ClientVoiceProviderList {
    val array = optJSONArray("items")
    val items = buildList {
        for (index in 0 until (array?.length() ?: 0)) {
            val entry = array?.optJSONObject(index) ?: continue
            runCatching { entry.toClientVoiceProvider() }.getOrNull()?.let(::add)
        }
    }
    return ClientVoiceProviderList(
        items = items,
        selected = optString("selected").trim(),
        configVersion = optLong("configVersion", 1L).coerceAtLeast(1L),
    )
}

internal fun voiceProviderAvailability(provider: ClientVoiceProvider): VoiceProviderAvailability = when {
    !provider.configured -> VoiceProviderAvailability.NOT_CONFIGURED
    provider.online -> VoiceProviderAvailability.AVAILABLE
    else -> VoiceProviderAvailability.OFFLINE
}

/** iOS/Web 印同样的三个词。 */
internal fun voiceProviderStatusLabel(provider: ClientVoiceProvider): String =
    when (voiceProviderAvailability(provider)) {
        VoiceProviderAvailability.AVAILABLE -> "可用"
        VoiceProviderAvailability.NOT_CONFIGURED -> "未配置"
        VoiceProviderAvailability.OFFLINE -> "服务离线"
    }

/** 空串表示这一项可以点；否则就是不能点的原因，直接作为副标题显示。 */
internal fun voiceProviderDisabledReason(provider: ClientVoiceProvider): String =
    when (voiceProviderAvailability(provider)) {
        VoiceProviderAvailability.AVAILABLE -> ""
        VoiceProviderAvailability.NOT_CONFIGURED -> "服务器未配置这个语音服务"
        VoiceProviderAvailability.OFFLINE -> "语音服务当前离线，暂时无法切换"
    }

internal fun voiceProviderSelectable(provider: ClientVoiceProvider): Boolean =
    voiceProviderDisabledReason(provider).isEmpty()

/**
 * 是否打勾。被选中的供应商可能同时不可用（worker 掉线），勾还是要显示：它仍然是服务器上的设置。
 */
internal fun voiceProviderSelected(provider: ClientVoiceProvider, selected: String): Boolean =
    selected.isNotEmpty() && selected == provider.id

/** 是否值得发 PUT：不可用的不发，已经是当前选择的也不发（避免多一条审计记录）。 */
internal fun voiceProviderShouldSubmit(provider: ClientVoiceProvider, selected: String): Boolean =
    voiceProviderSelectable(provider) && !voiceProviderSelected(provider, selected)

/**
 * 409 的兜底文案。服务器的 `message` 优先，这里只在 message 为空时用——与 iOS 一致。
 */
internal fun voiceProviderErrorMessage(code: String, serverMessage: String): String = when {
    serverMessage.isNotBlank() -> serverMessage.trim()
    code == "PROVIDER_UNAVAILABLE" -> "这个语音服务当前不可用（未配置或服务离线），已保留原来的选择。"
    else -> "切换语音服务失败，请稍后重试。"
}
