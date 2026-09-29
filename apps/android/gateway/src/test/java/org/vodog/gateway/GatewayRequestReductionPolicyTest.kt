package org.vodog.gateway

import org.vodog.gateway.media.QUALITY_DISABLED_BACKOFF_MS
import org.vodog.gateway.media.qualityProbeSuppressed
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayRequestReductionPolicyTest {
    private fun sim(slot: Int, subId: Int, handle: String?, name: String, fingerprint: String) = SimSnapshot(
        slotIndex = slot,
        subscriptionId = subId,
        carrierName = "carrier",
        displayName = name,
        phoneAccountHandle = null,
        protectedPhoneAccountHandle = handle,
        iccidFingerprint = fingerprint,
    )

    private val sims = listOf(
        sim(0, 11, "handle-a", "移动", "f".repeat(64)),
        sim(1, 12, "handle-b", "联通", "e".repeat(64)),
    )

    @Test fun simFingerprintIsOrderIndependentAndCoversEveryRoutingField() {
        assertEquals(simSyncFingerprint(sims), simSyncFingerprint(sims.reversed()))
        listOf(
            sims.map { if (it.slotIndex == 0) it.copy(slotIndex = 2) else it },
            sims.map { if (it.slotIndex == 0) it.copy(subscriptionId = 99) else it },
            sims.map { if (it.slotIndex == 0) it.copy(protectedPhoneAccountHandle = "other") else it },
            sims.map { if (it.slotIndex == 0) it.copy(displayName = "renamed") else it },
            sims.map { if (it.slotIndex == 0) it.copy(iccidFingerprint = "a".repeat(64)) else it },
        ).forEach { changed -> assertNotEquals(simSyncFingerprint(sims), simSyncFingerprint(changed)) }
    }

    @Test fun unchangedSimsAreResyncedAtMostOncePerMinute() {
        val fingerprint = simSyncFingerprint(sims)
        fun should(lastFingerprint: String?, lastAt: Long?, now: Long, covers: Boolean = true) =
            shouldSyncSimFingerprints(fingerprint, lastFingerprint, lastAt, now, covers)

        assertTrue(should(null, null, 1_000L))
        assertTrue(should(fingerprint, null, 1_000L))
        assertFalse(should(fingerprint, 1_000L, 2_000L))
        assertFalse(should(fingerprint, 1_000L, 60_999L))
        assertTrue(should(fingerprint, 1_000L, 61_000L))
        assertTrue(should("other", 1_000L, 2_000L))
        // A reboot resets elapsedRealtime below the stored stamp: resync rather than trust it.
        assertTrue(should(fingerprint, 50_000L, 10L))
        // Stored bindings that no longer name the local SIMs always force a sync.
        assertTrue(should(fingerprint, 1_000L, 2_000L, covers = false))
    }

    @Test fun serverDisabledQualityProbeIsNotReaskedForAnHour() {
        assertEquals(3_600_000L, QUALITY_DISABLED_BACKOFF_MS)
        assertFalse(qualityProbeSuppressed(null, 0L))
        val disabledUntil = 10_000L + QUALITY_DISABLED_BACKOFF_MS
        assertTrue(qualityProbeSuppressed(disabledUntil, 10_000L))
        assertTrue(qualityProbeSuppressed(disabledUntil, disabledUntil - 1))
        assertFalse(qualityProbeSuppressed(disabledUntil, disabledUntil))
        assertFalse(qualityProbeSuppressed(disabledUntil, disabledUntil + 1))
    }
}
