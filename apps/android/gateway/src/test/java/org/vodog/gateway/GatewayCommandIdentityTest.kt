package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayCommandIdentityTest {
    private val credentialA = "a".repeat(64)
    private val credentialB = "b".repeat(64)

    @Test fun `queue namespace is stable only for exact gateway epoch and credential`() {
        val current = GatewayCommandIdentity("gateway-a", 7, credentialA)
        assertEquals(
            gatewayIdentityPreferenceName("gateway_call_ack_outbox", current),
            gatewayIdentityPreferenceName("gateway_call_ack_outbox", current.copy()),
        )
        assertNotEquals(current.storageSuffix, current.copy(gatewayId = "gateway-b").storageSuffix)
        assertNotEquals(current.storageSuffix, current.copy(generation = 8).storageSuffix)
        assertNotEquals(current.storageSuffix, current.copy(credentialFingerprint = credentialB).storageSuffix)
    }

    @Test fun `credential fingerprint keeps crash between token and pairing metadata isolated`() {
        val old = GatewayCommandIdentity("gateway-old", 4, credentialA)
        val tokenReplacedBeforeMetadata = old.copy(credentialFingerprint = credentialB)
        assertNotEquals(old.storageSuffix, tokenReplacedBeforeMetadata.storageSuffix)
    }

    @Test fun `preference bases cannot collide across queue types`() {
        val identity = GatewayCommandIdentity("gateway-a", 7, credentialA)
        assertNotEquals(
            gatewayIdentityPreferenceName("gateway_call_ack_outbox", identity),
            gatewayIdentityPreferenceName("gateway_command_results", identity),
        )
        assertTrue(gatewayIdentityPreferenceName("gateway_call_ack_outbox", identity).length < 100)
    }

    @Test fun `old identity cannot flush or handle commands in a new pairing`() {
        val old = GatewayCommandIdentity("gateway-a", 7, credentialA)
        assertTrue(commandOwnerFenceAllows(true, old, old, 7))
        assertFalse(commandOwnerFenceAllows(false, old, old, 7))
        assertFalse(commandOwnerFenceAllows(true, old.copy(generation = 8), old, 7))
        assertFalse(commandOwnerFenceAllows(true, old.copy(gatewayId = "gateway-b"), old, 7))
        assertFalse(commandOwnerFenceAllows(true, old.copy(credentialFingerprint = credentialB), old, 7))
        assertFalse(commandOwnerFenceAllows(true, null, old, 7))
    }
}
