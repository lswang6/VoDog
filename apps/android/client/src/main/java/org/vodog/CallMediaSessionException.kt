package org.vodog

/**
 * Typed media-handshake failures (S19 port of the iOS `MediaSessionError`).
 *
 * Every transport-carrying kind names the transport that actually failed, so a TLS attempt never
 * tells the user to "try TLS". The retired pre-S18 wording "中继连接超时，可尝试 TLS" is exactly the
 * bug this shape prevents.
 */
enum class CallMediaFailureKind {
    INVALID_RELAY_OPTIONS,
    PEER_CREATION_FAILED,
    MISSING_LOCAL_DESCRIPTION,
    INVALID_ANSWER,
    ICE_GATHERING_TIMED_OUT,
    NO_RELAY_CANDIDATE,
    ICE_CONNECT_TIMED_OUT,
    ICE_CONNECTION_FAILED,
    AUDIO_SESSION_CONFIGURATION_FAILED,
    MICROPHONE_PERMISSION_DENIED,
}

fun callMediaFailureMessage(kind: CallMediaFailureKind, transport: CallMediaTransport): String = when (kind) {
    CallMediaFailureKind.INVALID_RELAY_OPTIONS -> "服务器返回的中继配置无效"
    CallMediaFailureKind.PEER_CREATION_FAILED -> "无法建立音频连接"
    CallMediaFailureKind.MISSING_LOCAL_DESCRIPTION -> "无法生成本地音频协商信息"
    CallMediaFailureKind.INVALID_ANSWER -> "服务器返回的音频协商信息无效"
    CallMediaFailureKind.ICE_GATHERING_TIMED_OUT,
    CallMediaFailureKind.NO_RELAY_CANDIDATE -> "未取得 ${transport.label} 中继候选，请检查网络或代理设置"
    CallMediaFailureKind.ICE_CONNECT_TIMED_OUT -> "${transport.label} 中继已取得候选但未能连通，请重试音频"
    CallMediaFailureKind.ICE_CONNECTION_FAILED -> "${transport.label} 音频中继连接失败"
    CallMediaFailureKind.AUDIO_SESSION_CONFIGURATION_FAILED -> "无法配置通话音频"
    CallMediaFailureKind.MICROPHONE_PERMISSION_DENIED ->
        "没有麦克风权限，通话无法传输声音。请在系统设置中允许 VoDog 使用麦克风。"
}

class CallMediaSessionException(
    val kind: CallMediaFailureKind,
    val transport: CallMediaTransport,
    override val message: String = callMediaFailureMessage(kind, transport),
) : Exception(message)

/**
 * A network-measurement failure that is identical on both transports, so it never earns a TLS
 * retry. Server-reported probe problems stay `ApiError` so their code still drives the copy.
 */
internal class CallMediaProbeException(cause: Throwable) :
    IllegalStateException(cause.message?.takeIf(String::isNotBlank) ?: "网络测量未完成，请重试", cause)

/** The attempt was superseded (new call, logout, stop); never retried and never surfaced. */
internal class CallMediaStaleAttempt(message: String) : IllegalStateException(message)
