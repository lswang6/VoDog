package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CallMediaFailureMessagePolicyTest {
    private fun message(
        code: String?,
        status: Int = 503,
        serverMessage: String = "",
        transport: CallMediaTransport = CallMediaTransport.UDP,
    ) = CallMediaFailureMessagePolicy.message(code, status, serverMessage, transport)

    @Test fun everyKnownCodeHasItsOwnSentence() {
        assertEquals("网关当前不在线（心跳超时），请稍后重试", message("GATEWAY_OFFLINE"))
        assertEquals("网关媒体能力暂不可用，请稍后重试", message("MEDIA_UNAVAILABLE"))
        assertEquals("当前网络与设备没有共同可用的媒体节点", message("MEDIA_NODE_UNAVAILABLE"))
        assertEquals("媒体节点未接受连接，请重试", message("MEDIA_BRIDGE_UNAVAILABLE"))
        assertEquals("通话已结束或媒体授权失效", message("MEDIA_REVOKED"))
        assertEquals("网络测量尚未完成，请重试", message("MEDIA_PROBE_REQUIRED"))
        assertEquals("媒体节点不一致，请重新连接音频", message("MEDIA_NODE_MISMATCH"))
        assertEquals("此通话已由其他设备接听", message("MEDIA_NOT_WINNER"))
        assertEquals(8, CallMediaFailureMessagePolicy.codes.size)
    }

    @Test fun gatewayOfflineIsNotReportedAsMissingMediaNode() {
        assertNotEquals(message("GATEWAY_OFFLINE"), message("MEDIA_NODE_UNAVAILABLE"))
        assertNotEquals(message("MEDIA_UNAVAILABLE"), message("MEDIA_NODE_UNAVAILABLE"))
    }

    @Test fun unknownCodeFallsBackToServerMessageWithCode() {
        assertEquals(
            "服务器内部错误（SOMETHING_ELSE）",
            message("SOMETHING_ELSE", status = 500, serverMessage = "服务器内部错误"),
        )
    }

    @Test fun unknownCodelessErrorFallsBackToHttpStatus() {
        assertEquals("网关错误（502）", message(null, status = 502, serverMessage = "网关错误"))
        assertEquals("网关错误（502）", message("", status = 502, serverMessage = "网关错误"))
    }

    @Test fun emptyServerMessageNamesTheTransport() {
        assertEquals(
            "UDP 音频连接失败（500）",
            message(null, status = 500, serverMessage = "   ", transport = CallMediaTransport.UDP),
        )
        assertEquals(
            "TLS 音频连接失败（500）",
            message(null, status = 500, serverMessage = "", transport = CallMediaTransport.TLS),
        )
    }

    @Test fun serverErrorsAreMappedThroughTheErrorEntryPoint() {
        assertEquals(
            "网关当前不在线（心跳超时），请稍后重试",
            CallMediaFailureMessagePolicy.message(
                ApiError(503, "GATEWAY_OFFLINE", "Gateway is offline"),
                CallMediaTransport.UDP,
            ),
        )
    }

    @Test fun iceFailuresNameTheTransportThatFailed() {
        assertEquals(
            "未取得 UDP 中继候选，请检查网络或代理设置",
            callMediaFailureMessage(CallMediaFailureKind.ICE_GATHERING_TIMED_OUT, CallMediaTransport.UDP),
        )
        assertEquals(
            "未取得 TLS 中继候选，请检查网络或代理设置",
            callMediaFailureMessage(CallMediaFailureKind.NO_RELAY_CANDIDATE, CallMediaTransport.TLS),
        )
        assertEquals(
            "TLS 中继已取得候选但未能连通，请重试音频",
            callMediaFailureMessage(CallMediaFailureKind.ICE_CONNECT_TIMED_OUT, CallMediaTransport.TLS),
        )
        assertEquals(
            "UDP 音频中继连接失败",
            callMediaFailureMessage(CallMediaFailureKind.ICE_CONNECTION_FAILED, CallMediaTransport.UDP),
        )
    }

    @Test fun timeoutMessageNeverSuggestsRetryingTheTransportThatJustFailed() {
        val failed = CallMediaSessionException(
            CallMediaFailureKind.ICE_GATHERING_TIMED_OUT,
            CallMediaTransport.TLS,
        )
        val rendered = CallMediaFailureMessagePolicy.message(failed, CallMediaTransport.TLS)
        assertFalse(rendered.contains("可尝试 TLS"))
        assertTrue(rendered.contains("TLS"))
    }

    @Test fun microphoneAndContractErrorsKeepTheirOwnText() {
        val microphone = CallMediaSessionException(
            CallMediaFailureKind.MICROPHONE_PERMISSION_DENIED,
            CallMediaTransport.UDP,
        )
        assertEquals(
            microphone.message,
            CallMediaFailureMessagePolicy.message(microphone, CallMediaTransport.UDP),
        )
        assertEquals(
            "服务器返回的中继配置无效",
            CallMediaFailureMessagePolicy.message(
                CallMediaSessionException(CallMediaFailureKind.INVALID_RELAY_OPTIONS, CallMediaTransport.UDP),
                CallMediaTransport.UDP,
            ),
        )
    }

    @Test fun dialTimeErrorsReadTheSameAsHandshakeErrors() {
        // `ClientViewModel.userMessage()` routes through the same table, so a 503 at dial time and
        // a 503 during the handshake never tell the user two different stories.
        CallMediaFailureMessagePolicy.codes.forEach { code ->
            assertEquals(message(code), CallMediaFailureMessagePolicy.knownCodeMessage(code))
        }
        assertEquals(null, CallMediaFailureMessagePolicy.knownCodeMessage("GATEWAY_BUSY"))
    }
}
