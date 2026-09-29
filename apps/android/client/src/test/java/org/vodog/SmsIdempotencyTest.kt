package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class SmsIdempotencyTest {
    @Test fun batchRetryKeepsExactPayloadIdentityAndSeparatesEditsSimAndAccount() {
        val persistence = MemorySmsRetryPersistence()
        var next = 0
        val coordinator = SmsIdempotencyCoordinator(persistence) { "id-${next++}" }
        coordinator.startSession("alice")
        val recipients = listOf("10086", "+886900000001")
        val first = coordinator.batchAttempt("sim-a", recipients, "draft")
        coordinator.failed(first, IOException("response lost"))
        coordinator.failed(first, ApiError(408, "TIMEOUT", "timeout"))
        assertEquals(first, coordinator.batchAttempt("sim-a", recipients, "draft"))
        assertNotEquals(first, coordinator.batchAttempt("sim-a", recipients.reversed(), "draft"))
        assertNotEquals(first, coordinator.batchAttempt("sim-a", recipients, "edited"))
        assertNotEquals(first, coordinator.batchAttempt("sim-b", recipients, "draft"))
        assertEquals(first, coordinator.batchAttempt("sim-a", recipients, "draft"))
        coordinator.confirmed(first)
        assertNotEquals(first, coordinator.batchAttempt("sim-a", recipients, "draft"))
        coordinator.startSession("bob")
        assertNotEquals(first, coordinator.batchAttempt("sim-a", recipients, "draft"))
        assertFalse(persistence.snapshot().toString().contains("900000001"))
    }

    @Test fun ambiguousRetryReusesPersistedKeyWithoutStoringMessagePlaintext() {
        val persistence = MemorySmsRetryPersistence()
        val ids = ArrayDeque(listOf("session-a", "idem-a", "should-not-be-used"))
        val first = SmsIdempotencyCoordinator(persistence) { ids.removeFirst() }
        first.startSession("alice@example.test")

        val attempt = first.attempt("sim-id", "+886900000003", "private message")
        assertFalse(SmsIdempotencyCoordinator.isDefinitiveFailure(IOException("response lost")))

        val afterRestart = SmsIdempotencyCoordinator(persistence) { ids.removeFirst() }
        afterRestart.resumeSession("alice@example.test")
        val retry = afterRestart.attempt("sim-id", "+886900000003", "private message")

        assertEquals("idem-a", attempt.idempotencyKey)
        assertEquals(attempt, retry)
        val persisted = persistence.snapshot().entries.joinToString("|") { "${it.key}=${it.value}" }
        assertFalse(persisted.contains("+886900000003"))
        assertFalse(persisted.contains("private message"))
        assertFalse(persisted.contains("sim-id"))
    }

    @Test fun confirmedRequestClearsKeyAndNextExplicitSendGetsANewOne() {
        val persistence = MemorySmsRetryPersistence()
        val ids = ArrayDeque(listOf("session-a", "idem-a", "idem-b"))
        val coordinator = SmsIdempotencyCoordinator(persistence) { ids.removeFirst() }
        coordinator.startSession("alice")
        val first = coordinator.attempt("sim", "10086", "hello")

        coordinator.confirmed(first)
        val explicitResend = coordinator.attempt("sim", "10086", "hello")

        assertNotEquals(first.idempotencyKey, explicitResend.idempotencyKey)
    }

    @Test fun newLoginClearsOldAccountNamespace() {
        val persistence = MemorySmsRetryPersistence()
        val ids = ArrayDeque(listOf("alice-session", "alice-idem", "bob-session", "bob-idem"))
        val coordinator = SmsIdempotencyCoordinator(persistence) { ids.removeFirst() }
        coordinator.startSession("alice")
        val alice = coordinator.attempt("sim", "10086", "hello")

        coordinator.startSession("bob")
        val bob = coordinator.attempt("sim", "10086", "hello")

        assertNotEquals(alice.idempotencyKey, bob.idempotencyKey)
        assertFalse(persistence.snapshot().values.contains(alice.idempotencyKey))
    }

    @Test fun uncertainFailureRetainsKeyButDefinitiveRejectionClearsIt() {
        val persistence = MemorySmsRetryPersistence()
        val ids = ArrayDeque(listOf("session", "idem-a", "idem-b"))
        val coordinator = SmsIdempotencyCoordinator(persistence) { ids.removeFirst() }
        coordinator.startSession("alice")
        val first = coordinator.attempt("sim", "10086", "hello")

        coordinator.failed(first, ApiError(503, "OFFLINE", "offline"))
        assertEquals("idem-a", coordinator.attempt("sim", "10086", "hello").idempotencyKey)

        coordinator.failed(first, ApiError(409, "CONFLICT", "conflict"))
        assertEquals("idem-b", coordinator.attempt("sim", "10086", "hello").idempotencyKey)
        assertFalse(SmsIdempotencyCoordinator.isDefinitiveFailure(IllegalStateException("bad response")))
    }

    @Test fun pendingCollectionIsBoundedWithoutEvictingUncertainRequests() {
        val persistence = MemorySmsRetryPersistence()
        var next = 0
        val coordinator = SmsIdempotencyCoordinator(persistence) { "id-${next++}" }
        coordinator.startSession("alice")
        repeat(128) { coordinator.attempt("sim-${it % 2}", "10086", "body-$it") }

        org.junit.Assert.assertThrows(IllegalStateException::class.java) {
            coordinator.attempt("sim-new", "10010", "overflow")
        }
        assertEquals(128, persistence.snapshot().keys.count { it.startsWith("pending.") })
        assertEquals("id-1", coordinator.attempt("sim-0", "10086", "body-0").idempotencyKey)
    }
}

private class MemorySmsRetryPersistence : SmsRetryPersistence {
    private val values = linkedMapOf<String, String>()
    override fun get(key: String): String? = values[key]
    override fun put(key: String, value: String) { values[key] = value }
    override fun remove(key: String) { values.remove(key) }
    override fun clear() = values.clear()
    override fun snapshot(): Map<String, String> = values.toMap()
}
