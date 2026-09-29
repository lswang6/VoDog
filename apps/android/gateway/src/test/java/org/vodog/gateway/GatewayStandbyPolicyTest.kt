package org.vodog.gateway

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** S21 §D — the standby beacon and the two channels that carry a remote power request. */
class GatewayStandbyPolicyTest {
    @Test fun theBeaconRunsOnlyWhileRemotePowerIsAllowedAndTheGatewayIsOff() {
        val idle = StandbyState()
        assertTrue(GatewayStandbyPolicy.plan(allowRemotePower = true, controlEnabled = false, idle).run)
        // The local switch is the only thing that opens the exception to "OFF = zero outbound".
        assertFalse(GatewayStandbyPolicy.plan(allowRemotePower = false, controlEnabled = false, idle).run)
        // An enabled gateway already has the heartbeat; a second owner would be duplicate traffic.
        assertFalse(GatewayStandbyPolicy.plan(allowRemotePower = true, controlEnabled = true, idle).run)
        assertFalse(GatewayStandbyPolicy.plan(allowRemotePower = false, controlEnabled = true, idle).run)
        assertEquals(20_000, GatewayStandbyPolicy.plan(true, false, idle).holdMs)
        assertEquals(20_000, GatewayStandbyPolicy.HOLD_MS)
        // The read timeout has to outlast a full hold by at least ten seconds.
        assertTrue(GatewayStandbyPolicy.READ_TIMEOUT_SECONDS * 1_000L >= GatewayStandbyPolicy.HOLD_MS + 10_000L)
    }

    @Test fun failureBackoffRunsFromTwoSecondsToThirtyAndAnyAcceptedRoundResetsIt() {
        assertEquals(0L, GatewayStandbyPolicy.backoffMs(0))
        assertEquals(2_000L, GatewayStandbyPolicy.backoffMs(1))
        assertEquals(4_000L, GatewayStandbyPolicy.backoffMs(2))
        assertEquals(8_000L, GatewayStandbyPolicy.backoffMs(3))
        assertEquals(16_000L, GatewayStandbyPolicy.backoffMs(4))
        assertEquals(30_000L, GatewayStandbyPolicy.backoffMs(5))
        assertEquals(30_000L, GatewayStandbyPolicy.backoffMs(50))
        assertEquals(GatewayStandbyPolicy.MAX_BACKOFF_MS, GatewayStandbyPolicy.backoffMs(50))
        var state = StandbyState()
        repeat(3) { state = GatewayStandbyPolicy.onFailure(state) }
        assertEquals(3, state.consecutiveFailures)
        assertEquals(8_000L, GatewayStandbyPolicy.plan(true, false, state).backoffMs)
        assertEquals(0, GatewayStandbyPolicy.onSuccess().consecutiveFailures)
        assertEquals(0L, GatewayStandbyPolicy.plan(true, false, GatewayStandbyPolicy.onSuccess()).backoffMs)
    }

    @Test fun theStandbyBodyCarriesOnlyTheHoldTheFlagAndTheCarriedResult() {
        val bare = standbyRequestBody(20_000, remotePowerAllowed = true, lastPowerResult = null)
        assertEquals(20_000, bare.getInt("holdMs"))
        assertTrue(bare.getBoolean("remotePowerAllowed"))
        assertFalse(bare.has("lastPowerResult"))
        assertEquals(setOf("holdMs", "remotePowerAllowed"), bare.keys().asSequence().toSet())
        // The server's own ceiling is never exceeded by the client.
        assertEquals(20_000, standbyRequestBody(99_000, true, null).getInt("holdMs"))
        val carried = standbyRequestBody(
            20_000, true, powerResultJson("on", ok = false, reason = "需要通知权限才能安全运行前台服务", at = AT),
        )
        val result = carried.getJSONObject("lastPowerResult")
        assertEquals("on", result.getString("desired"))
        assertFalse(result.getBoolean("ok"))
        assertEquals("需要通知权限才能安全运行前台服务", result.getString("reason"))
        assertEquals(AT, result.getString("at"))
    }

    @Test fun aSuccessfulPowerResultCarriesNoReason() {
        val ok = powerResultJson("off", ok = true, reason = null, at = AT)
        assertFalse(ok.has("reason"))
        assertTrue(ok.getBoolean("ok"))
        assertEquals("off", ok.getString("desired"))
        assertFalse(powerResultJson("on", ok = true, reason = "  ", at = AT).has("reason"))
        assertEquals("call_in_progress", powerResultJson("off", false, "call_in_progress", AT).getString("reason"))
    }

    @Test fun eachChannelOnlyAcceptsTheDirectionItOwns() {
        // The beacon may only be told to switch the gateway on; the heartbeat only to switch it off.
        assertEquals("on", parseDesiredPower(JSONObject().put("desiredPower", "on"), accepted = "on"))
        assertNull(parseDesiredPower(JSONObject().put("desiredPower", "off"), accepted = "on"))
        assertEquals("off", parseDesiredPower(JSONObject().put("desiredPower", "off"), accepted = "off"))
        assertNull(parseDesiredPower(JSONObject().put("desiredPower", "on"), accepted = "off"))
        // Absent, null or unknown all read as "no request", so an old control service is harmless.
        assertNull(parseDesiredPower(JSONObject(), accepted = "off"))
        assertNull(parseDesiredPower(JSONObject().put("desiredPower", JSONObject.NULL), accepted = "off"))
        assertNull(parseDesiredPower(JSONObject().put("desiredPower", "ON"), accepted = "on"))
        assertNull(parseDesiredPower(JSONObject().put("desiredPower", ""), accepted = "on"))
    }

    @Test fun standbyResponseReadsTheRequestAndTheHeldWindow() {
        val woken = parseStandbyResult(JSONObject().put("desiredPower", "on").put("heldMs", 12L))
        assertEquals("on", woken.desiredPower)
        assertEquals(12L, woken.heldMs)
        val timeout = parseStandbyResult(JSONObject().put("desiredPower", JSONObject.NULL).put("heldMs", 20_000L))
        assertNull(timeout.desiredPower)
        assertEquals(20_000L, timeout.heldMs)
        // A negative or missing hold never becomes a negative delay.
        assertEquals(0L, parseStandbyResult(JSONObject()).heldMs)
        assertEquals(0L, parseStandbyResult(JSONObject().put("heldMs", -5L)).heldMs)
    }

    @Test fun aBlockedEnableIsReportedWithItsLocalGateReason() {
        val blocked = GatewayEnablePolicy.evaluate(
            EnableRequirements(paired = false, phonePermission = true, notificationPermission = true),
        )
        assertEquals("请先置入管理员发放的设备凭据", remotePowerBlockedReason(blocked))
        assertNull(remotePowerBlockedReason(EnableDecision.Allowed))
        val carried = powerResultJson("on", ok = false, reason = remotePowerBlockedReason(blocked), at = AT)
        assertFalse(carried.getBoolean("ok"))
        assertEquals("请先置入管理员发放的设备凭据", carried.getString("reason"))
    }

    @Test fun theStandbyRouteIsItsOwnEndpointAndTheHeartbeatDefaultsToNoPowerRequest() {
        assertEquals("/gateway/standby", GatewayApiRoutes.STANDBY)
        assertEquals("/gateway/heartbeat", GatewayApiRoutes.HEARTBEAT)
        // Every existing caller keeps its behaviour: no remote power request unless one is delivered.
        assertNull(HeartbeatResult("gateway", 1L, 0L, emptyList()).desiredPower)
    }

    @Test fun anAppUpdateRestartsTheGatewayLikeABoot() {
        assertEquals(
            setOf("android.intent.action.BOOT_COMPLETED", "android.intent.action.MY_PACKAGE_REPLACED"),
            GATEWAY_RESTART_ACTIONS,
        )
    }

    @Test fun rebootRestartsTheMasterSwitchFirstAndTheBeaconOnlyWhenItIsAllowed() {
        assertEquals(
            GatewayBootStart.MAIN,
            gatewayBootStartDecision(enabled = true, allowRemotePower = false),
        )
        assertEquals(
            GatewayBootStart.MAIN,
            gatewayBootStartDecision(enabled = true, allowRemotePower = true),
        )
        assertEquals(
            GatewayBootStart.STANDBY,
            gatewayBootStartDecision(enabled = false, allowRemotePower = true),
        )
        assertEquals(
            GatewayBootStart.NONE,
            gatewayBootStartDecision(enabled = false, allowRemotePower = false),
        )
    }

    @Test fun theStandbyLineNeverShowsAnIdleBeaconAsAFailure() {
        assertTrue(gatewayStandbySummary(false, false, StandbyDisplayState.DISABLED, 0L).contains("未启用"))
        assertTrue(gatewayStandbySummary(true, true, StandbyDisplayState.DISABLED, 0L).contains("心跳"))
        assertTrue(gatewayStandbySummary(true, false, StandbyDisplayState.HOLDING, 0L).contains("待命中"))
        assertTrue(gatewayStandbySummary(true, false, StandbyDisplayState.BACKOFF, 8_000L).contains("退避 8 秒"))
        assertTrue(gatewayStandbySummary(true, false, StandbyDisplayState.DISABLED, 0L).contains("正在启动"))
        assertEquals("无待上报结果", gatewayPowerResultSummary(null))
        assertEquals("结果不可读", gatewayPowerResultSummary("not json"))
        assertTrue(
            gatewayPowerResultSummary(powerResultJson("off", false, "call_in_progress", AT).toString())
                .contains("远程关闭未执行"),
        )
        assertTrue(
            gatewayPowerResultSummary(powerResultJson("on", true, null, AT).toString())
                .contains("远程开启成功"),
        )
    }

    private companion object {
        const val AT = "2026-09-11T12:00:00Z"
    }
}
