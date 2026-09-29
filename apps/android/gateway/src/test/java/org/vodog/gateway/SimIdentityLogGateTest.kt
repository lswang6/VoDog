package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S25 decision 1. `activeSims()` is polled about once a second, so the unconditional identity line
 * was ~86 Info lines a minute and flushed the gateway's media logs out of logcat's ring buffer.
 * Pure logic, injected clock: no android.util.Log and no SystemClock are reachable from here.
 */
class SimIdentityLogGateTest {
    @Test fun `an unchanged identity prints once and then stays quiet`() {
        val gate = SimIdentityLogGate()
        assertEquals(listOf("slot=0 identityKind=iccid fingerprint=abcdef01"), gate.linesFor(slotZero(), 0))
        // 60 polls at one per second, i.e. the old cost of a minute, now costs nothing.
        repeat(60) { tick -> assertEquals(emptyList<String>(), gate.linesFor(slotZero(), 1_000L * (tick + 1))) }
    }

    @Test fun `the line format is byte-for-byte what it was before the gate`() {
        val gate = SimIdentityLogGate()
        assertEquals(
            listOf(describeSimIdentity(1, SimIdentityKind.CARD_ID, FINGERPRINT_B)),
            gate.linesFor(listOf(SimIdentityLogEntry(1, SimIdentityKind.CARD_ID, FINGERPRINT_B)), 0),
        )
    }

    @Test fun `any change in slot kind or fingerprint reopens the log`() {
        val gate = SimIdentityLogGate()
        assertEquals(1, gate.linesFor(slotZero(), 0).size)
        // A swapped fingerprint on the same slot is a different SIM and must be visible.
        assertEquals(
            listOf("slot=0 identityKind=iccid fingerprint=99887766"),
            gate.linesFor(listOf(SimIdentityLogEntry(0, SimIdentityKind.ICCID, FINGERPRINT_B)), 1_000),
        )
        // So is the same fingerprint resolved through a different domain.
        assertEquals(
            listOf("slot=0 identityKind=fallback fingerprint=99887766"),
            gate.linesFor(listOf(SimIdentityLogEntry(0, SimIdentityKind.FALLBACK, FINGERPRINT_B)), 2_000),
        )
        // And so is a move to another slot.
        assertEquals(
            listOf("slot=1 identityKind=fallback fingerprint=99887766"),
            gate.linesFor(listOf(SimIdentityLogEntry(1, SimIdentityKind.FALLBACK, FINGERPRINT_B)), 3_000),
        )
    }

    @Test fun `an added or removed sim is a change even though no surviving line moved`() {
        val gate = SimIdentityLogGate()
        assertEquals(1, gate.linesFor(slotZero(), 0).size)
        val both = slotZero() + SimIdentityLogEntry(1, SimIdentityKind.CARD_ID, FINGERPRINT_B)
        assertEquals(2, gate.linesFor(both, 1_000).size)
        assertEquals(emptyList<String>(), gate.linesFor(both.reversed(), 2_000)) // order is not a change
        assertEquals(1, gate.linesFor(slotZero(), 3_000).size) // slot 1 pulled out
        // Losing the last SIM must not be the one change that prints nothing.
        assertEquals(listOf("sims=0"), gate.linesFor(emptyList(), 4_000))
        assertEquals(emptyList<String>(), gate.linesFor(emptyList(), 5_000))
        assertEquals(1, gate.linesFor(slotZero(), 6_000).size) // and coming back is a change again
    }

    @Test fun `a quiet reader still proves itself once every five minutes`() {
        val gate = SimIdentityLogGate()
        assertEquals(1, gate.linesFor(slotZero(), 0).size)
        assertEquals(emptyList<String>(), gate.linesFor(slotZero(), SIM_IDENTITY_HEARTBEAT_MS - 1))
        val heartbeat = gate.linesFor(slotZero(), SIM_IDENTITY_HEARTBEAT_MS)
        assertEquals(1, heartbeat.size)
        assertEquals("heartbeat sims=1 [slot=0 identityKind=iccid fingerprint=abcdef01]", heartbeat.single())
        // The heartbeat re-anchors the window: the next one is five minutes after this one.
        assertEquals(emptyList<String>(), gate.linesFor(slotZero(), 2 * SIM_IDENTITY_HEARTBEAT_MS - 1))
        assertEquals(1, gate.linesFor(slotZero(), 2 * SIM_IDENTITY_HEARTBEAT_MS).size)
    }

    @Test fun `a change resets the heartbeat window instead of stacking on top of it`() {
        val gate = SimIdentityLogGate()
        assertEquals(1, gate.linesFor(slotZero(), 0).size)
        val moved = listOf(SimIdentityLogEntry(0, SimIdentityKind.ICCID, FINGERPRINT_B))
        assertEquals(1, gate.linesFor(moved, SIM_IDENTITY_HEARTBEAT_MS - 1).size)
        assertEquals(emptyList<String>(), gate.linesFor(moved, SIM_IDENTITY_HEARTBEAT_MS))
        assertEquals(1, gate.linesFor(moved, 2 * SIM_IDENTITY_HEARTBEAT_MS - 1).size)
    }

    @Test fun `a clock that walks backwards prints rather than going silent forever`() {
        val gate = SimIdentityLogGate()
        assertEquals(1, gate.linesFor(slotZero(), 10_000).size)
        val recovered = gate.linesFor(slotZero(), 0)
        assertEquals(1, recovered.size)
        assertTrue(recovered.single().startsWith("heartbeat sims=1 "))
    }

    @Test fun `an unresolved identity is still one line and still deduplicated`() {
        val gate = SimIdentityLogGate()
        val unresolved = listOf(SimIdentityLogEntry(0, null, null))
        assertEquals(listOf("slot=0 identityKind=none fingerprint=none"), gate.linesFor(unresolved, 0))
        assertEquals(emptyList<String>(), gate.linesFor(unresolved, 1_000))
    }

    private fun slotZero() = listOf(SimIdentityLogEntry(0, SimIdentityKind.ICCID, FINGERPRINT_A))

    private companion object {
        const val FINGERPRINT_A = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        const val FINGERPRINT_B = "99887766554433221100998877665544332211009988776655443322110099aa"
    }
}
