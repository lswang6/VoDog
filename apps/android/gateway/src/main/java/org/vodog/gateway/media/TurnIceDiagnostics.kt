package org.vodog.gateway.media

import org.webrtc.IceCandidateErrorEvent

internal enum class IceFailureKind { DNS, TLS_CERTIFICATE, AUTHENTICATION, CONNECTION, UNREACHABLE }

internal data class IceFailureSummary(
    val errorCode: Int,
    val kind: IceFailureKind,
    val errorText: String? = null,
    val url: String? = null,
)

/**
 * Reduces native ICE errors to bounded telemetry. The local address is never kept; the TURN URL is
 * the one Control handed out and is kept without any userinfo, so no credential can ride along.
 */
internal fun summarizeIceFailure(event: IceCandidateErrorEvent): IceFailureSummary {
    val text = event.errorText.lowercase()
    val kind = when {
        event.errorCode == 401 || event.errorCode == 438 -> IceFailureKind.AUTHENTICATION
        listOf("certificate", "cert verify", "ssl", "tls").any(text::contains) ->
            IceFailureKind.TLS_CERTIFICATE
        listOf("host lookup", "resolve", "dns", "name not known").any(text::contains) ->
            IceFailureKind.DNS
        listOf("connect", "socket", "network", "timed out", "refused").any(text::contains) ->
            IceFailureKind.CONNECTION
        else -> IceFailureKind.UNREACHABLE
    }
    return IceFailureSummary(
        event.errorCode,
        kind,
        event.errorText.take(120).takeIf(String::isNotBlank),
        // `turns:user:pass@host:port` -> `turns:host:port`; a URL without userinfo is unchanged.
        (if ('@' in event.url) "${event.url.substringBefore(':')}:${event.url.substringAfterLast('@')}" else event.url)
            .take(80).takeIf(String::isNotBlank),
    )
}

/** S53: the last ICE candidate error, as the short `media.failed` fields; empty when there was none. */
internal fun iceFailureDiagFields(failure: IceFailureSummary?): Map<String, Any?> =
    if (failure == null) emptyMap() else mapOf(
        "iceErrorCode" to failure.errorCode,
        "iceErrorText" to failure.errorText,
        "iceUrl" to failure.url,
    )

private val RELAY_CANDIDATE = Regex("(?:^|\\s)typ\\s+relay(?:\\s|$)")

/**
 * A single candidate as `PeerConnection.Observer.onIceCandidate` delivers it: `IceCandidate.sdp`
 * carries the attribute value only, without the `a=candidate:` prefix that [relayCandidateCount]
 * matches inside a complete SDP.
 */
internal fun isRelayCandidate(sdp: String): Boolean = RELAY_CANDIDATE.containsMatchIn(sdp)

internal fun relayCandidateCount(sdp: String): Int = sdp.lineSequence().count { line ->
    line.startsWith("a=candidate:") && RELAY_CANDIDATE.containsMatchIn(line)
}

internal class RelayIceUnavailableException(
    transport: IceTransport,
    failure: IceFailureSummary?,
) : IllegalStateException(
    buildString {
        append(if (transport == IceTransport.TLS) "TURN TLS relay unavailable" else "TURN relay unavailable")
        failure?.let { append(" (${it.kind.name.lowercase()}, ${it.errorCode})") }
    },
)
