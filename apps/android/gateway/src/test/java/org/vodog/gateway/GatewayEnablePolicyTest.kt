package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayEnablePolicyTest {
    @Test fun unpairedIsFailClosed() {
        val result = GatewayEnablePolicy.evaluate(EnableRequirements(false, true, true, true, true))
        assertTrue(result is EnableDecision.Blocked)
    }

    @Test fun missingPhonePermissionIsFailClosed() {
        val result = GatewayEnablePolicy.evaluate(EnableRequirements(true, false, true, true, true))
        assertTrue(result is EnableDecision.Blocked)
    }

    @Test fun allRequirementsAllowService() {
        assertEquals(
            EnableDecision.Allowed,
            GatewayEnablePolicy.evaluate(EnableRequirements(true, true, true, true, true)),
        )
    }

    @Test fun missingPrivilegedTelephonyIsFailClosed() {
        val result = GatewayEnablePolicy.evaluate(EnableRequirements(true, true, true, false, true))
        assertTrue(result is EnableDecision.Blocked)
    }

    @Test fun missingActionRuntimePermissionsIsFailClosed() {
        val result = GatewayEnablePolicy.evaluate(EnableRequirements(true, true, true, true, false))
        assertTrue(result is EnableDecision.Blocked)
    }
}
