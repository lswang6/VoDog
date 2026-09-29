package org.vodog

import org.webrtc.IceCandidateErrorEvent

internal enum class CallIceFailureKind { DNS, TLS_CERTIFICATE, AUTHENTICATION, CONNECTION, UNREACHABLE }

internal data class CallIceFailureSummary(val errorCode: Int, val kind: CallIceFailureKind)

internal fun summarizeCallIceFailure(event: IceCandidateErrorEvent): CallIceFailureSummary {
    val text = event.errorText.lowercase()
    val kind = when {
        event.errorCode == 401 || event.errorCode == 438 -> CallIceFailureKind.AUTHENTICATION
        listOf("certificate", "cert verify", "ssl", "tls").any(text::contains) ->
            CallIceFailureKind.TLS_CERTIFICATE
        listOf("host lookup", "resolve", "dns", "name not known").any(text::contains) ->
            CallIceFailureKind.DNS
        listOf("connect", "socket", "network", "timed out", "refused").any(text::contains) ->
            CallIceFailureKind.CONNECTION
        else -> CallIceFailureKind.UNREACHABLE
    }
    return CallIceFailureSummary(event.errorCode, kind)
}

internal fun callRelayCandidateCount(sdp: String): Int = sdp.lineSequence().count { line ->
    line.startsWith("a=candidate:") && Regex("(?:^|\\s)typ\\s+relay(?:\\s|$)").containsMatchIn(line)
}

internal fun callRelayUnavailableMessage(
    transport: CallMediaTransport,
    failure: CallIceFailureSummary?,
): String = when {
    transport == CallMediaTransport.TLS && failure?.kind == CallIceFailureKind.TLS_CERTIFICATE ->
        "TLS 中继证书无法通过安全验证，请改用 UDP 或联系管理员"
    transport == CallMediaTransport.TLS -> "TLS 中继不可达，请改用 UDP 或稍后重试"
    else -> "音频中继不可达，请改用 TLS 或稍后重试"
}
