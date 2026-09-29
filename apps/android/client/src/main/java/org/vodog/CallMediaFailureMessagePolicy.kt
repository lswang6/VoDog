package org.vodog

/**
 * Maps a server media error code to its own sentence (S19 port of the iOS
 * `MediaFailureMessagePolicy`, byte-identical to `apps/web/src/media-policy.ts`).
 *
 * Before this policy every server failure collapsed into one generic line and the `ApiError.code`
 * was discarded, so "the gateway is offline" and "no common media node" read the same.
 */
object CallMediaFailureMessagePolicy {
    private val MESSAGES = mapOf(
        "GATEWAY_OFFLINE" to "网关当前不在线（心跳超时），请稍后重试",
        "MEDIA_UNAVAILABLE" to "网关媒体能力暂不可用，请稍后重试",
        "MEDIA_NODE_UNAVAILABLE" to "当前网络与设备没有共同可用的媒体节点",
        "MEDIA_BRIDGE_UNAVAILABLE" to "媒体节点未接受连接，请重试",
        "MEDIA_REVOKED" to "通话已结束或媒体授权失效",
        "MEDIA_PROBE_REQUIRED" to "网络测量尚未完成，请重试",
        "MEDIA_NODE_MISMATCH" to "媒体节点不一致，请重新连接音频",
        "MEDIA_NOT_WINNER" to "此通话已由其他设备接听",
    )

    val codes: Set<String> = MESSAGES.keys

    /** The mapped sentence for a known code, or null so other callers can keep their own wording. */
    fun knownCodeMessage(code: String?): String? = code?.let(MESSAGES::get)

    fun message(
        code: String?,
        status: Int,
        serverMessage: String,
        transport: CallMediaTransport,
    ): String {
        knownCodeMessage(code)?.let { return it }
        val detail = code?.takeIf(String::isNotBlank) ?: status.toString()
        val trimmed = serverMessage.trim()
        return if (trimmed.isNotEmpty()) "$trimmed（$detail）"
        else "${transport.label} 音频连接失败（$detail）"
    }

    /**
     * Entry point for the `connect()` catch block. Server errors route through the table above;
     * everything else keeps the text it already carries (typed [CallMediaSessionException] kinds
     * name their own transport).
     */
    fun message(error: Throwable, transport: CallMediaTransport): String = when (error) {
        is ApiError -> message(error.code, error.status, error.message, transport)
        else -> error.message?.takeIf(String::isNotBlank) ?: "无法连接通话音频"
    }
}
