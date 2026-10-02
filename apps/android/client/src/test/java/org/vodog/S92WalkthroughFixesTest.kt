package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class S92WalkthroughFixesTest {
    private fun sms(direction: String, state: String, reason: String = ""): ClientSmsMessage = JSONObject()
        .put("id", "sms-s92").put("simId", "sim-a").put("direction", direction)
        .put("remoteNumber", "+8618600000001").put("body", "hi")
        .put("state", state).put("failureReason", reason).toClientSmsMessage()

    @Test fun incomingDeliveredOrReceivedDoesNotRepeatTheState() {
        assertEquals("收到 · +8618600000001", smsRowCaption(sms("incoming", "delivered"), "+8618600000001"))
        assertEquals("收到 · +8618600000001", smsRowCaption(sms("incoming", "received"), "+8618600000001"))
    }

    @Test fun anomalousIncomingAndAllOutgoingStatesStillShow() {
        assertEquals("收到 · SIM 1 · 结果待确认", smsRowCaption(sms("incoming", "unknown"), "SIM 1"))
        assertEquals("收到 · SIM 1 · 发送失败", smsRowCaption(sms("incoming", "failed"), "SIM 1"))
        assertEquals("发出 · SIM 1 · 已送达", smsRowCaption(sms("outgoing", "delivered"), "SIM 1"))
    }

    @Test fun largeFontScaleStartsAboveThirteenTenths() {
        assertFalse(isLargeFontScale(1.0f))
        assertFalse(isLargeFontScale(1.3f))
        assertTrue(isLargeFontScale(1.5f))
        assertTrue(isLargeFontScale(2.0f))
    }

    @Test fun keypadKeyKeepsDefaultSizeAndFitsThreePerRowAtTwo() {
        assertEquals(68f, keypadKeySizeDp(1.0f), 0.001f)
        assertTrue(keypadKeySizeDp(1.3f) > 68f)
        // 411 dp − 2×16 screen − 2×16 card − 2×18 row padding = 311 dp → 103 dp per key cell.
        assertTrue(keypadKeySizeDp(2.0f) <= 103f)
    }

    @Test fun onlyTheNumberPartOfATitleIsMonospaced() {
        assertEquals(0 until 5, phoneTitleNumberRange("10010 · 联通服务"))
        assertEquals(10 until 24, phoneTitleNumberRange("张三 · 李四 · +8618600000001"))
        assertEquals(7 until 21, phoneTitleNumberRange("联通服务 · +8618600000001"))
        assertEquals(0 until 14, phoneTitleNumberRange("+8618600000001"))
        assertNull(phoneTitleNumberRange("号码未知"))
    }
}
