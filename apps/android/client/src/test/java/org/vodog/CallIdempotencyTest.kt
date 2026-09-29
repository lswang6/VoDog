package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.io.IOException

class CallIdempotencyTest {
    @Test fun `different SIM routes keep separate pending call keys and ambiguous retry reuses each key`() {
        val persistence = CallMemoryPersistence()
        val ids = ArrayDeque(listOf("scope", "call-a", "call-b"))
        val coordinator = CallIdempotencyCoordinator(persistence) { ids.removeFirst() }
        coordinator.startSession("owner@example.test")

        val a = coordinator.attempt("sim-a", "+8613800000000")
        val b = coordinator.attempt("sim-b", "+8613800000000")
        coordinator.failed(a, IOException("response lost"))

        assertEquals("call-a", coordinator.attempt("sim-a", "+8613800000000").idempotencyKey)
        assertEquals("call-b", coordinator.attempt("sim-b", "+8613800000000").idempotencyKey)
        assertNotEquals(a.storageKey, b.storageKey)
        val persisted = persistence.snapshot().entries.joinToString("|") { "${it.key}=${it.value}" }
        assertFalse(persisted.contains("+8613800000000"))
        assertFalse(persisted.contains("sim-a"))
    }
}

private class CallMemoryPersistence : SmsRetryPersistence {
    private val values = linkedMapOf<String, String>()
    override fun get(key: String): String? = values[key]
    override fun put(key: String, value: String) { values[key] = value }
    override fun remove(key: String) { values.remove(key) }
    override fun clear() = values.clear()
    override fun snapshot(): Map<String, String> = values.toMap()
}
