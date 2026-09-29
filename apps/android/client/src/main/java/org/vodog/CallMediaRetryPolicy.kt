package org.vodog

import kotlinx.coroutines.CancellationException

/**
 * Whether a failed UDP relay attempt earns one automatic TLS attempt (S19 port of the iOS
 * `MediaRetryPolicy`).
 *
 * Server, contract, probe, lifecycle and device-permission failures are identical on TLS, so they
 * are never retried. Relay-path failures are exactly the ones a TCP/TLS relay can fix.
 */
object CallMediaRetryPolicy {
    fun shouldRetryTls(error: Throwable): Boolean = when (error) {
        is ApiError,
        is CallMediaProbeException,
        is CallMediaStaleAttempt,
        is SessionChangedException,
        is CancellationException -> false
        is CallMediaSessionException -> shouldRetryTls(error.kind)
        else -> true
    }

    fun shouldRetryTls(kind: CallMediaFailureKind): Boolean = when (kind) {
        CallMediaFailureKind.INVALID_RELAY_OPTIONS,
        CallMediaFailureKind.INVALID_ANSWER,
        CallMediaFailureKind.MICROPHONE_PERMISSION_DENIED,
        CallMediaFailureKind.AUDIO_SESSION_CONFIGURATION_FAILED -> false
        CallMediaFailureKind.ICE_GATHERING_TIMED_OUT,
        CallMediaFailureKind.NO_RELAY_CANDIDATE,
        CallMediaFailureKind.ICE_CONNECT_TIMED_OUT,
        CallMediaFailureKind.ICE_CONNECTION_FAILED,
        CallMediaFailureKind.PEER_CREATION_FAILED,
        CallMediaFailureKind.MISSING_LOCAL_DESCRIPTION -> true
    }
}
