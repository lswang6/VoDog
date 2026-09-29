package org.vodog.gateway

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandDoorbellPolicyTest {
    private val closed = CommandDoorbellState()

    @Test fun `an unannounced or zero hold window keeps the loop from running at all`() {
        assertFalse(CommandDoorbellPolicy.plan(0, controlEnabled = true, state = closed).run)
        assertFalse(CommandDoorbellPolicy.plan(-1, controlEnabled = true, state = closed).run)
        assertEquals(0, CommandDoorbellPolicy.plan(0, true, closed).holdMs)
    }

    @Test fun `the local master switch closes the doorbell even while the server announces one`() {
        assertFalse(CommandDoorbellPolicy.plan(4_000, controlEnabled = false, state = closed).run)
        assertTrue(CommandDoorbellPolicy.plan(4_000, controlEnabled = true, state = closed).run)
    }

    @Test fun `the hold is the announcement capped at the frozen eight second ceiling`() {
        assertEquals(4_000, CommandDoorbellPolicy.plan(4_000, true, closed).holdMs)
        assertEquals(8_000, CommandDoorbellPolicy.plan(8_000, true, closed).holdMs)
        assertEquals(8_000, CommandDoorbellPolicy.plan(60_000, true, closed).holdMs)
        assertEquals(8_000, CommandDoorbellPolicy.MAX_HOLD_MS)
    }

    @Test fun `an announcement that turns to zero stops the loop on its next round`() {
        val running = CommandDoorbellPolicy.plan(4_000, true, closed)
        assertTrue(running.run)
        assertFalse(CommandDoorbellPolicy.plan(0, true, closed).run)
    }

    @Test fun `failures back off from five seconds to a thirty second ceiling`() {
        assertEquals(0L, CommandDoorbellPolicy.backoffMs(0))
        assertEquals(5_000L, CommandDoorbellPolicy.backoffMs(1))
        assertEquals(10_000L, CommandDoorbellPolicy.backoffMs(2))
        assertEquals(20_000L, CommandDoorbellPolicy.backoffMs(3))
        assertEquals(30_000L, CommandDoorbellPolicy.backoffMs(4))
        assertEquals(30_000L, CommandDoorbellPolicy.backoffMs(400))

        var state = closed
        listOf(5_000L, 10_000L, 20_000L, 30_000L, 30_000L).forEach { expected ->
            state = CommandDoorbellPolicy.onFailure(state)
            assertEquals(expected, CommandDoorbellPolicy.plan(4_000, true, state).backoffMs)
        }
    }

    @Test fun `any accepted response clears the backoff and only a wake records a timestamp`() {
        val failed = CommandDoorbellPolicy.onFailure(CommandDoorbellPolicy.onFailure(closed))
        assertEquals(10_000L, CommandDoorbellPolicy.plan(4_000, true, failed).backoffMs)

        val quiet = CommandDoorbellPolicy.onSuccess(failed, wake = false, nowWallClockMs = 99L, heartbeatCycle = 4L)
        assertEquals(0L, CommandDoorbellPolicy.plan(4_000, true, quiet).backoffMs)
        assertNull(quiet.lastWakeWallClockMs)
        assertNull(quiet.wakeCycle)

        val woken = CommandDoorbellPolicy.onSuccess(failed, wake = true, nowWallClockMs = 1_700L, heartbeatCycle = 4L)
        assertEquals(0L, CommandDoorbellPolicy.plan(4_000, true, woken).backoffMs)
        assertEquals(1_700L, woken.lastWakeWallClockMs)
        assertEquals(4L, woken.wakeCycle)
        // A later quiet round keeps the displayed wake time but drops the settle gate.
        val after = CommandDoorbellPolicy.onSuccess(woken, wake = false, nowWallClockMs = 9_000L, heartbeatCycle = 5L)
        assertEquals(1_700L, after.lastWakeWallClockMs)
        assertNull(after.wakeCycle)
    }

    /**
     * The control service answers `wake=true` while any command is still un-ACKed, so re-ringing
     * before the heartbeat drains it would spin at one request per round trip.
     */
    @Test fun `a woken doorbell waits for the heartbeat cycle that collects the command`() {
        val woken = CommandDoorbellPolicy.onSuccess(closed, wake = true, nowWallClockMs = 1L, heartbeatCycle = 7L)
        assertTrue(CommandDoorbellPolicy.shouldWaitForHeartbeat(woken, heartbeatCycle = 7L))
        assertFalse(CommandDoorbellPolicy.shouldWaitForHeartbeat(woken, heartbeatCycle = 8L))
        assertFalse(CommandDoorbellPolicy.shouldWaitForHeartbeat(closed, heartbeatCycle = 7L))
        assertEquals(3_000L, CommandDoorbellPolicy.POST_WAKE_SETTLE_MS)
    }

    /**
     * The failure mode this guards: the server wakes on any undelivered command, and a heartbeat can
     * fail *after* a 2xx and stay failed (quarantined replay horizon, fence mismatch). Ringing into
     * that pair would run at roughly two requests per round trip and defeat S18's failure backoff.
     */
    @Test fun `the doorbell stops ringing while the heartbeat itself is failing`() {
        assertTrue(CommandDoorbellPolicy.shouldPauseForHeartbeat(lastHeartbeatFailed = true))
        assertFalse(CommandDoorbellPolicy.shouldPauseForHeartbeat(lastHeartbeatFailed = false))
    }

    /** An instant no-wake answer is the server saying its own switch is off, not a real timeout. */
    @Test fun `an immediate no-wake answer is read as a server-side close, not a timeout`() {
        assertTrue(CommandDoorbellPolicy.serverClosedDoorbell(DoorbellResult(wake = false, heldMs = 0L)))
        assertFalse(CommandDoorbellPolicy.serverClosedDoorbell(DoorbellResult(wake = false, heldMs = 4_000L)))
        // An immediate wake is the fast path the doorbell exists for, never a close.
        assertFalse(CommandDoorbellPolicy.serverClosedDoorbell(DoorbellResult(wake = true, heldMs = 0L)))
    }

    @Test fun `the heartbeat announcement is read as closed unless it carries a positive window`() {
        assertEquals(0, parseCommandDoorbellMaxHoldMs(JSONObject()))
        assertEquals(0, parseCommandDoorbellMaxHoldMs(JSONObject().put("commandDoorbell", JSONObject())))
        assertEquals(
            0,
            parseCommandDoorbellMaxHoldMs(JSONObject().put("commandDoorbell", JSONObject().put("maxHoldMs", 0))),
        )
        assertEquals(
            0,
            parseCommandDoorbellMaxHoldMs(JSONObject().put("commandDoorbell", JSONObject().put("maxHoldMs", -5))),
        )
        assertEquals(
            4_000,
            parseCommandDoorbellMaxHoldMs(JSONObject().put("commandDoorbell", JSONObject().put("maxHoldMs", 4_000))),
        )
    }

    @Test fun `the heartbeat result carries the announcement the loop reads`() {
        val heartbeat = """{"gateway":{"id":"g-1","deviceEpoch":3,"serverSequence":9},"commands":[],
            "commandDoorbell":{"maxHoldMs":4000}}"""
        assertEquals(
            4_000,
            GatewayApi("token", { true }, GatewayHttpTransport { GatewayHttpResponse(200, heartbeat) })
                .heartbeat(controlEnabled = true, reportedSequence = 0L).commandDoorbellMaxHoldMs,
        )
        // An older control service that knows nothing about the doorbell keeps it closed.
        val legacy = """{"gateway":{"id":"g-1","deviceEpoch":3,"serverSequence":9},"commands":[]}"""
        assertEquals(
            0,
            GatewayApi("token", { true }, GatewayHttpTransport { GatewayHttpResponse(200, legacy) })
                .heartbeat(controlEnabled = true, reportedSequence = 0L).commandDoorbellMaxHoldMs,
        )
    }

    @Test fun `the doorbell posts its hold window and times out five seconds after it`() {
        lateinit var request: GatewayHttpRequest
        val result = GatewayApi("token", { true }, GatewayHttpTransport {
            request = it
            GatewayHttpResponse(200, """{"wake":true,"heldMs":1234}""")
        }).commandDoorbell(4_000)

        assertTrue(request.url.endsWith(GatewayApiRoutes.COMMAND_DOORBELL))
        assertEquals("/gateway/commands/doorbell", GatewayApiRoutes.COMMAND_DOORBELL)
        assertEquals("POST", request.method)
        assertEquals("Bearer token", request.authorization)
        assertEquals(9_000L, request.timeoutMs)
        assertEquals(4_000, JSONObject(String(requireNotNull(request.jsonBody))).getInt("holdMs"))
        assertTrue(result.wake)
        assertEquals(1_234L, result.heldMs)
    }

    @Test fun `a closed doorbell response is read as no wake and a non-2xx is an error`() {
        val quiet = GatewayApi("token", { true }, GatewayHttpTransport {
            GatewayHttpResponse(200, """{"wake":false,"heldMs":0}""")
        }).commandDoorbell(8_000)
        assertFalse(quiet.wake)
        assertEquals(0L, quiet.heldMs)

        assertThrows(GatewayApiHttpError::class.java) {
            GatewayApi("token", { true }, GatewayHttpTransport {
                GatewayHttpResponse(503, """{"error":{"code":"unavailable","message":"down"}}""")
            }).commandDoorbell(8_000)
        }
        // A disabled gateway never reaches the network.
        assertThrows(IllegalStateException::class.java) {
            GatewayApi("token", { false }, GatewayHttpTransport {
                throw AssertionError("doorbell must not run while the gateway is disabled")
            }).commandDoorbell(8_000)
        }
        assertThrows(IllegalArgumentException::class.java) {
            GatewayApi("token", { true }, GatewayHttpTransport {
                throw AssertionError("a non-positive hold must never be sent")
            }).commandDoorbell(0)
        }
    }

    @Test fun `the advanced card line names the state, the backoff and the last wake`() {
        val now = 1_800_000_000_000L
        assertEquals(
            "未启用",
            gatewayCommandDoorbellSummary(CommandDoorbellDisplayState.DISABLED, 0L, now, now),
        )
        assertEquals(
            "挂起中",
            gatewayCommandDoorbellSummary(CommandDoorbellDisplayState.HOLDING, 0L, null, now),
        )
        assertEquals(
            "挂起中 · 最近唤醒 12 秒前",
            gatewayCommandDoorbellSummary(CommandDoorbellDisplayState.HOLDING, 0L, now - 12_000L, now),
        )
        assertEquals(
            "退避中 · 退避 10 秒 · 最近唤醒 3 分钟前",
            gatewayCommandDoorbellSummary(CommandDoorbellDisplayState.BACKOFF, 10_000L, now - 180_000L, now),
        )
        assertEquals(
            "运行中 · 最近唤醒 刚刚",
            gatewayCommandDoorbellSummary(CommandDoorbellDisplayState.RUNNING, 0L, now, now),
        )
    }
}
