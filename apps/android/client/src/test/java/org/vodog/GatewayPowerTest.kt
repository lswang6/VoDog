package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S21 §D 远程开关 — the three status words, the "allowed / not allowed" line, and the four 409 codes.
 * A gateway that is off but reachable through its standby beacon reads 待命中, not 离线: that is the
 * whole difference between "you can turn it on from here" and "go touch the phone".
 */
class GatewayPowerTest {
    @Test fun `status reads online, standby or offline in that precedence`() {
        assertEquals("在线", gatewayPowerStatusLabel(power(online = true, standbyOnline = true)))
        assertEquals("待命中", gatewayPowerStatusLabel(power(online = false, standbyOnline = true)))
        assertEquals("离线", gatewayPowerStatusLabel(power(online = false, standbyOnline = false)))
    }

    @Test fun `the remote-power line tells the user where to fix it`() {
        assertEquals("远程开启已允许", gatewayRemotePowerLabel(power(remotePowerAllowed = true)))
        assertEquals(
            "远程开启未允许（需在网关设备上打开）",
            gatewayRemotePowerLabel(power(remotePowerAllowed = false)),
        )
    }

    @Test fun `a requested ON already reads as on so the switch does not snap back`() {
        val requested = power(online = false, standbyOnline = true, desiredPower = "on")
        assertTrue(requested.powerOn)
        assertTrue(requested.pending)
        val idle = power(online = false, standbyOnline = true)
        assertFalse(idle.powerOn)
        assertFalse(idle.pending)
        assertTrue(power(online = true).powerOn)
    }

    @Test fun `the four refusal codes have Chinese wording, anything else keeps the server message`() {
        assertEquals(
            "这台网关尚未允许远程开启，请先在网关设备上打开“允许远程开启（待命）”。",
            gatewayPowerErrorMessage("GATEWAY_REMOTE_POWER_NOT_ALLOWED", "fallback"),
        )
        assertEquals(
            "网关的待命通道已离线，无法远程开启；请在网关设备上手动开启。",
            gatewayPowerErrorMessage("GATEWAY_STANDBY_OFFLINE", "fallback"),
        )
        assertEquals("网关当前不在线，无法远程关闭。", gatewayPowerErrorMessage("GATEWAY_OFFLINE", "fallback"))
        assertEquals(
            "这台网关设备正在通话中，为安全起见已拒绝远程关闭。",
            gatewayPowerErrorMessage("GATEWAY_IN_USE", "fallback"),
        )
        assertEquals("服务器开小差了", gatewayPowerErrorMessage("HTTP_503", "服务器开小差了"))
    }

    @Test fun `an ApiError is mapped, a plain failure is not`() {
        assertEquals(
            "网关当前不在线，无法远程关闭。",
            ApiError(409, "GATEWAY_OFFLINE", "Gateway offline").gatewayPowerUserMessage(),
        )
        assertEquals("网络不可用", IllegalStateException("网络不可用").gatewayPowerUserMessage())
    }

    @Test fun `lastPowerResult explains what the Pixel actually did`() {
        val failed = power(
            lastPowerResult = JSONObject().put("desired", "off").put("ok", false)
                .put("reason", "call_in_progress"),
        )
        val label = checkNotNull(gatewayPowerResultLabel(failed.lastPowerResult))
        assertTrue(label.startsWith("远程关闭未完成：网关上仍有通话"))
        val ok = power(lastPowerResult = JSONObject().put("desired", "on").put("ok", true))
        assertEquals("远程开启已完成", gatewayPowerResultLabel(ok.lastPowerResult))
        // An unknown reason is shown verbatim rather than swallowed.
        val odd = power(lastPowerResult = JSONObject().put("desired", "on").put("ok", false).put("reason", "weird"))
        assertEquals("远程开启未完成：weird", gatewayPowerResultLabel(odd.lastPowerResult))
        assertNull(gatewayPowerResultLabel(null))
    }

    @Test fun `a pre-S21 gateway row parses with everything off instead of throwing`() {
        val bare = JSONObject().put("gatewayId", "g-1").toClientGatewayPower()
        assertEquals("网关", bare.name)
        assertFalse(bare.online)
        assertFalse(bare.standbyOnline)
        assertFalse(bare.remotePowerAllowed)
        assertFalse(bare.occupied)
        assertNull(bare.desiredPower)
        assertNull(bare.lastPowerResult)
        assertEquals("离线", gatewayPowerStatusLabel(bare))
    }

    @Test fun `an unexpected desiredPower value is ignored rather than shown`() {
        assertNull(power(desiredPower = "maybe").desiredPower)
        assertEquals("off", power(desiredPower = "off").desiredPower)
    }

    private fun power(
        online: Boolean = false,
        standbyOnline: Boolean = false,
        remotePowerAllowed: Boolean = true,
        desiredPower: String? = null,
        lastPowerResult: JSONObject? = null,
    ): ClientGatewayPower = JSONObject()
        .put("gatewayId", "g-1")
        .put("name", "客厅 Pixel")
        .put("controlEnabled", online)
        .put("online", online)
        .put("standbyOnline", standbyOnline)
        .put("remotePowerAllowed", remotePowerAllowed)
        .apply {
            desiredPower?.let { put("desiredPower", it) }
            lastPowerResult?.let { put("lastPowerResult", it) }
        }
        .toClientGatewayPower()
}
