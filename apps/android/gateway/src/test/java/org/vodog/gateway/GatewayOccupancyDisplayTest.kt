package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayOccupancyDisplayTest {
    private val slotOne = GatewayOccupancySim(slotIndex = 0, protectedPhoneAccountHandle = "handle-a")
    private val slotTwo = GatewayOccupancySim(slotIndex = 1, protectedPhoneAccountHandle = "handle-b")

    @Test fun `only live telecom states occupy a SIM`() {
        val records = listOf(
            record("r", DeviceCallState.RINGING, handle = "handle-a"),
            record("d", DeviceCallState.DIALING, handle = "handle-a"),
            record("a", DeviceCallState.ACTIVE, handle = "handle-a"),
            record("e", DeviceCallState.ENDED, handle = "handle-a"),
            // An unbound outgoing reservation is not an occupied SIM yet.
            record("u", DeviceCallState.UNKNOWN, handle = "handle-a"),
        )
        val rows = gatewayOccupancyRows(records, listOf(slotOne))
        assertEquals(3, rows.size)
        assertEquals(
            setOf(DeviceCallState.RINGING, DeviceCallState.DIALING, DeviceCallState.ACTIVE),
            rows.map(GatewayOccupancyRow::state).toSet(),
        )
        assertTrue(rows.all { it.slotIndex == 0 })
    }

    @Test fun `records are joined to their slot by the protected handle and sorted newest first`() {
        val rows = gatewayOccupancyRows(
            listOf(
                record("old", DeviceCallState.ACTIVE, handle = "handle-a", creationTimeMillis = 1_000L),
                record("new", DeviceCallState.RINGING, handle = "handle-b", creationTimeMillis = 9_000L),
                record("unmapped", DeviceCallState.ACTIVE, handle = "handle-z", creationTimeMillis = 5_000L),
            ),
            listOf(slotOne, slotTwo),
        )
        assertEquals(listOf(1, null, 0), rows.map(GatewayOccupancyRow::slotIndex))
        assertEquals(listOf(9_000L, 5_000L, 1_000L), rows.map(GatewayOccupancyRow::startedAtMs))
    }

    @Test fun `the start time falls back to the first observation when telecom reports none`() {
        val observed = record("x", DeviceCallState.ACTIVE, handle = "handle-a", creationTimeMillis = null)
        assertEquals(1_789_084_800_000L, gatewayOccupancyStartedAtMs(observed))
        assertEquals(
            4_000L,
            gatewayOccupancyStartedAtMs(observed.copy(creationTimeMillis = 4_000L)),
        )
        assertNull(gatewayOccupancyStartedAtMs(observed.copy(observedAt = "not-a-time")))
    }

    @Test fun `only the last four digits of a number are ever displayed`() {
        assertEquals("***0101", gatewayMaskedTailNumber("+8619900000101"))
        assertEquals("***0101", gatewayMaskedTailNumber("(199) 0000-0101"))
        assertEquals("***4321", gatewayMaskedTailNumber("4321"))
        assertNull(gatewayMaskedTailNumber("321"))
        assertNull(gatewayMaskedTailNumber(null))
        assertNull(gatewayMaskedTailNumber(""))
        // The full number must never appear in the masked form.
        assertEquals(false, gatewayMaskedTailNumber("+8619900000101")!!.contains("9900"))
    }

    @Test fun `the occupancy line names the slot, the direction, the start and the state`() {
        val now = 1_800_000_000_000L
        val row = GatewayOccupancyRow(
            slotIndex = 0,
            direction = DeviceCallDirection.INCOMING,
            state = DeviceCallState.RINGING,
            startedAtMs = now - 8_000L,
            maskedNumber = "***0101",
        )
        assertEquals("SIM 1 · 来电 · 开始于 8 秒前 · 振铃", gatewayOccupancyLine(row, now))
        assertEquals(
            "SIM 2 · 去电 · 开始于 3 分钟前 · 拨号",
            gatewayOccupancyLine(
                row.copy(
                    slotIndex = 1,
                    direction = DeviceCallDirection.OUTGOING,
                    state = DeviceCallState.DIALING,
                    startedAtMs = now - 180_000L,
                ),
                now,
            ),
        )
        assertEquals(
            "未知 SIM · 方向未知 · 开始于 时间未知 · 通话中",
            gatewayOccupancyLine(
                row.copy(
                    slotIndex = null,
                    direction = DeviceCallDirection.UNKNOWN,
                    state = DeviceCallState.ACTIVE,
                    startedAtMs = null,
                ),
                now,
            ),
        )
        // The number is never part of the line itself.
        assertEquals(false, gatewayOccupancyLine(row, now).contains("0101"))
    }

    @Test fun `the destructive confirmation names every occupied SIM and is absent when idle`() {
        assertNull(gatewayOccupancyInterruptionWarning(emptyList()))
        val one = GatewayOccupancyRow(0, DeviceCallDirection.INCOMING, DeviceCallState.ACTIVE, 1L, null)
        assertEquals("SIM 1 通话中，关闭将中断远程通话。", gatewayOccupancyInterruptionWarning(listOf(one)))
        assertEquals(
            "SIM 1、SIM 2 通话中，关闭将中断远程通话。",
            gatewayOccupancyInterruptionWarning(listOf(one, one.copy(slotIndex = 1))),
        )
        // Two live calls on one SIM must not repeat its name.
        assertEquals("SIM 1 通话中，关闭将中断远程通话。", gatewayOccupancyInterruptionWarning(listOf(one, one)))
    }

    private fun record(
        id: String,
        state: DeviceCallState,
        handle: String?,
        creationTimeMillis: Long? = 1_000L,
    ) = DeviceCallRecord(
        deviceCallId = id,
        phoneAccountHandle = handle,
        creationTimeMillis = creationTimeMillis,
        direction = DeviceCallDirection.INCOMING,
        state = state,
        observedAt = "2026-09-11T00:00:00Z",
        remoteNumber = "+8619900000101",
        incomingEventId = null,
        incomingPayload = null,
        incomingReported = false,
        serverCallId = null,
    )
}
