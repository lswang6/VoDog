package org.vodog

import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallMediaRetryPolicyTest {
    private fun media(kind: CallMediaFailureKind, transport: CallMediaTransport = CallMediaTransport.UDP) =
        CallMediaSessionException(kind, transport)

    @Test fun relayPathFailuresAreRetriedOverTls() {
        listOf(
            CallMediaFailureKind.ICE_GATHERING_TIMED_OUT,
            CallMediaFailureKind.NO_RELAY_CANDIDATE,
            CallMediaFailureKind.ICE_CONNECT_TIMED_OUT,
            CallMediaFailureKind.ICE_CONNECTION_FAILED,
            CallMediaFailureKind.PEER_CREATION_FAILED,
            CallMediaFailureKind.MISSING_LOCAL_DESCRIPTION,
        ).forEach { kind ->
            assertTrue(kind.name, CallMediaRetryPolicy.shouldRetryTls(media(kind)))
        }
    }

    @Test fun contractAndDeviceFailuresAreNotRetried() {
        listOf(
            CallMediaFailureKind.INVALID_RELAY_OPTIONS,
            CallMediaFailureKind.INVALID_ANSWER,
            CallMediaFailureKind.MICROPHONE_PERMISSION_DENIED,
            CallMediaFailureKind.AUDIO_SESSION_CONFIGURATION_FAILED,
        ).forEach { kind ->
            assertFalse(kind.name, CallMediaRetryPolicy.shouldRetryTls(media(kind)))
        }
    }

    @Test fun serverErrorsAreNeverRetried() {
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(ApiError(409, "MEDIA_REVOKED", "")))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(ApiError(503, "GATEWAY_OFFLINE", "")))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(ApiError(401, "UNAUTHORIZED", "expired")))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(ApiError(500, "HTTP_500", "")))
    }

    @Test fun probeSessionAndCancellationAreNeverRetried() {
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(CallMediaProbeException(IllegalStateException("network changed"))))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(SessionChangedException()))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(CallMediaStaleAttempt("音频连接已取消")))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(CancellationException("cancelled")))
    }

    @Test fun webRtcErrorsAreRetried() {
        assertTrue(CallMediaRetryPolicy.shouldRetryTls(IllegalStateException("CreateOffer failed")))
        assertTrue(CallMediaRetryPolicy.shouldRetryTls(java.net.SocketTimeoutException("音频协商请求超时，请重试音频")))
    }
}
