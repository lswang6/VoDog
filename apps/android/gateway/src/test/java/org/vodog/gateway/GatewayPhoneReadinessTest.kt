package org.vodog.gateway

import org.junit.Assert.*
import org.junit.Test

class GatewayPhoneReadinessTest {
    @Test fun `release approval and enabled control and prepared handoff are all required`() {
        for (approved in listOf(false, true)) for (enabled in listOf(false, true)) for (prepared in listOf(false, true)) {
            val result = GatewayPhoneReadinessPolicy.capabilities(approved, enabled, prepared)
            assertEquals(approved && enabled && prepared, result.telephonyReady)
            assertEquals(result.telephonyReady, result.mediaReady)
        }
    }

    @Test fun `telephony can remain ready while verified media nodes are unavailable`() {
        val result = GatewayPhoneReadinessPolicy.capabilities(
            approved = true,
            controlEnabled = true,
            handoffPrepared = true,
            mediaReachable = false,
        )
        assertTrue(result.telephonyReady)
        assertFalse(result.mediaReady)
    }

    @Test fun `all production entry points share the same explicit build gate`() {
        assertEquals(BuildConfig.CELLULAR_ACCEPTANCE_ENABLED, GatewayPhoneFeatureApproval.APPROVED)
        assertEquals(GatewayPhoneFeatureApproval.APPROVED, GatewayCallExecutionApproval.READY)
        assertEquals(GatewayPhoneFeatureApproval.APPROVED, GatewayAudioMediaSessionApproval.APPROVED)
    }
}
