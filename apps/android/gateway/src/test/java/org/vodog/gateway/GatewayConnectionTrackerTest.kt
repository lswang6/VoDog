package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayConnectionTrackerTest {
    private val fresh = GatewayConnectionTracker.initial(null, 0, ServerConnection.DISABLED)

    @Test fun firstFailuresBeforeAnySuccessStayConnecting() {
        var state = fresh
        assertEquals(ServerConnection.CONNECTING, state.connection)
        repeat(6) { attempt ->
            state = GatewayConnectionTracker.onFailure(state, nowMs = 1_000L + attempt * 5_000L, callOrAudioActive = false)
            assertEquals(ServerConnection.CONNECTING, state.connection)
        }
        assertEquals(6, state.consecutiveFailures)
    }

    @Test fun oneLostHeartbeatAfterSuccessIsDegradedNotOffline() {
        val online = GatewayConnectionTracker.onSuccess(fresh, nowMs = 10_000L, callOrAudioActive = false)
        assertEquals(ServerConnection.ONLINE, online.connection)
        assertEquals(GatewayConnectionTracker.NORMAL_POLL_MS, online.nextPollMs)

        val first = GatewayConnectionTracker.onFailure(online, nowMs = 12_000L, callOrAudioActive = false)
        assertEquals(ServerConnection.DEGRADED, first.connection)
        val second = GatewayConnectionTracker.onFailure(first, nowMs = 16_000L, callOrAudioActive = false)
        assertEquals(ServerConnection.DEGRADED, second.connection)
        // Third failure, but only 14 s of silence: still a retry.
        val third = GatewayConnectionTracker.onFailure(second, nowMs = 24_000L, callOrAudioActive = false)
        assertEquals(ServerConnection.DEGRADED, third.connection)
    }

    @Test fun offlineNeedsBothThreeFailuresAndTwentySecondsOfSilence() {
        val online = GatewayConnectionTracker.onSuccess(fresh, nowMs = 10_000L, callOrAudioActive = false)
        // Twenty seconds of silence but only two failures.
        val twoFailures = GatewayConnectionTracker.onFailure(
            GatewayConnectionTracker.onFailure(online, 15_000L, false), 31_000L, false,
        )
        assertEquals(ServerConnection.DEGRADED, twoFailures.connection)
        val third = GatewayConnectionTracker.onFailure(twoFailures, nowMs = 30_000L, callOrAudioActive = false)
        assertEquals(ServerConnection.OFFLINE, third.connection)
        assertEquals(3, third.consecutiveFailures)
    }

    @Test fun successAfterOfflineReturnsOnlineAndResetsFailures() {
        var state = GatewayConnectionTracker.onSuccess(fresh, nowMs = 1_000L, callOrAudioActive = false)
        repeat(5) { state = GatewayConnectionTracker.onFailure(state, nowMs = 40_000L, callOrAudioActive = false) }
        assertEquals(ServerConnection.OFFLINE, state.connection)
        val recovered = GatewayConnectionTracker.onSuccess(state, nowMs = 50_000L, callOrAudioActive = false)
        assertEquals(ServerConnection.ONLINE, recovered.connection)
        assertEquals(0, recovered.consecutiveFailures)
        assertEquals(50_000L, recovered.lastSuccessAtMs)
    }

    @Test fun failureBackoffIsBoundedAndTighterDuringCalls() {
        assertEquals(2_000L, GatewayConnectionTracker.backoffMs(1, GatewayConnectionTracker.MAX_FAILURE_BACKOFF_MS))
        assertEquals(4_000L, GatewayConnectionTracker.backoffMs(2, GatewayConnectionTracker.MAX_FAILURE_BACKOFF_MS))
        assertEquals(8_000L, GatewayConnectionTracker.backoffMs(3, GatewayConnectionTracker.MAX_FAILURE_BACKOFF_MS))
        assertEquals(8_000L, GatewayConnectionTracker.backoffMs(40, GatewayConnectionTracker.MAX_FAILURE_BACKOFF_MS))
        assertEquals(2_000L, GatewayConnectionTracker.backoffMs(1, GatewayConnectionTracker.ACTIVE_CALL_FAILURE_BACKOFF_MS))
        assertEquals(3_000L, GatewayConnectionTracker.backoffMs(9, GatewayConnectionTracker.ACTIVE_CALL_FAILURE_BACKOFF_MS))

        val online = GatewayConnectionTracker.onSuccess(fresh, nowMs = 0L, callOrAudioActive = false)
        var inCall = online
        repeat(5) { inCall = GatewayConnectionTracker.onFailure(inCall, nowMs = 5_000L, callOrAudioActive = true) }
        assertEquals(GatewayConnectionTracker.ACTIVE_CALL_FAILURE_BACKOFF_MS, inCall.nextPollMs)
    }

    @Test fun initialStateKeepsPersistedDisplayWhenASuccessExists() {
        assertEquals(
            ServerConnection.DEGRADED,
            GatewayConnectionTracker.initial(5_000L, 2, ServerConnection.DEGRADED).connection,
        )
        assertEquals(
            ServerConnection.CONNECTING,
            GatewayConnectionTracker.initial(null, 2, ServerConnection.OFFLINE).connection,
        )
    }

    /** S20 D4: command latency, not connection health, is what tightens the successful poll. */
    @Test fun successfulPollTightensToOneSecondOnlyWhileACallOrAudioSessionIsAlive() {
        val idle = GatewayConnectionTracker.onSuccess(fresh, nowMs = 10_000L, callOrAudioActive = false)
        assertEquals(GatewayConnectionTracker.NORMAL_POLL_MS, idle.nextPollMs)
        assertEquals(2_000L, idle.nextPollMs)

        val active = GatewayConnectionTracker.onSuccess(fresh, nowMs = 10_000L, callOrAudioActive = true)
        assertEquals(GatewayConnectionTracker.ACTIVE_CALL_POLL_MS, active.nextPollMs)
        assertEquals(1_000L, active.nextPollMs)
        // Everything else about a success is unchanged by the new argument.
        assertEquals(ServerConnection.ONLINE, active.connection)
        assertEquals(0, active.consecutiveFailures)
        assertEquals(10_000L, active.lastSuccessAtMs)

        // A call that ends returns the cadence to normal on the very next accepted heartbeat.
        assertEquals(
            GatewayConnectionTracker.NORMAL_POLL_MS,
            GatewayConnectionTracker.onSuccess(active, nowMs = 12_000L, callOrAudioActive = false).nextPollMs,
        )
    }

    @Test fun failureDetailNamesTheRetryCountAndStaysBounded() {
        val retry = GatewayConnectionTracker.failureDetail(ServerConnection.DEGRADED, 2, "timeout")
        assertEquals("控制通道重试中（第 2 次）：timeout", retry)
        val offline = GatewayConnectionTracker.failureDetail(ServerConnection.OFFLINE, 7, "timeout")
        assertEquals("控制服务连接失败（已重试 7 次）：timeout", offline)
        val long = GatewayConnectionTracker.failureDetail(ServerConnection.OFFLINE, 7, "x".repeat(400))
        assertEquals(GatewayConnectionTracker.MAX_ERROR_CHARS, long.length)
    }

    /** The hero card shows the headline alone, so OFFLINE and DEGRADED must not read alike. */
    @Test fun failureHeadlineDistinguishesOfflineFromDegradedWithoutTheErrorText() {
        assertEquals(
            "控制通道重试中（第 2 次）",
            GatewayConnectionTracker.failureHeadline(ServerConnection.DEGRADED, 2),
        )
        assertEquals(
            "控制服务连接失败（已重试 7 次）",
            GatewayConnectionTracker.failureHeadline(ServerConnection.OFFLINE, 7),
        )
        assertEquals(
            "控制通道重试中（第 1 次）",
            GatewayConnectionTracker.failureHeadline(ServerConnection.CONNECTING, 1),
        )
    }
}
