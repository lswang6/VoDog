package org.vodog.gateway

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.Closeable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class GatewayMediaSetupOwnerTest {
    @Test fun `off cancels pending signaling and old owner rejects the next ON generation`() {
        val stopped = AtomicInteger()
        val owner = GatewayMediaSetupOwner(stopped::incrementAndGet)
        val pending = FakeCloseable()
        assertTrue(owner.register(pending))

        owner.close()

        assertTrue(pending.closed)
        assertEquals(1, stopped.get())
        assertFalse(owner.register(FakeCloseable()))
    }

    @Test fun `transfer winning the off race installs before ingress stop and never closes transferred signaling`() {
        val order = mutableListOf<String>()
        val owner = GatewayMediaSetupOwner { order += "stop" }
        val signaling = FakeCloseable()
        assertTrue(owner.register(signaling))
        assertTrue(owner.transfer(signaling) { order += "install" })

        owner.close()

        assertEquals(listOf("install", "stop"), order)
        assertFalse(signaling.closed)
    }

    @Test fun `off winning transfer race closes pending and prevents holder install`() {
        val owner = GatewayMediaSetupOwner {}
        val signaling = FakeCloseable()
        assertTrue(owner.register(signaling))
        owner.close()
        var installed = false

        assertFalse(owner.transfer(signaling) { installed = true })
        assertFalse(installed)
        assertTrue(signaling.closed)
    }

    @Test fun `throwing ingress stop cannot skip pending signaling cancellation`() {
        val owner = GatewayMediaSetupOwner { error("ingress stop failed") }
        val signaling = FakeCloseable()
        assertTrue(owner.register(signaling))

        owner.close()

        assertTrue(signaling.closed)
        assertFalse(owner.register(FakeCloseable()))
    }

    @Test fun `terminal call cancels pending setup without closing the ON generation`() {
        val owner = GatewayMediaSetupOwner {}
        val first = FakeCloseable()
        assertTrue(owner.register(first))

        owner.cancelPending()

        assertTrue(first.closed)
        var staleInstalled = false
        assertFalse(owner.transfer(first) { staleInstalled = true })
        assertFalse(staleInstalled)
        val next = FakeCloseable()
        assertTrue(owner.register(next))
        assertTrue(owner.transfer(next) {})
    }

    @Test fun `concurrent transfer and off have exactly one cleanup owner`() {
        repeat(100) {
            val installed = AtomicInteger(); val stopped = AtomicInteger()
            val owner = GatewayMediaSetupOwner(stopped::incrementAndGet)
            val signaling = FakeCloseable(); assertTrue(owner.register(signaling))
            val gate = CountDownLatch(1); val pool = Executors.newFixedThreadPool(2)
            val transfer = pool.submit<Boolean> { gate.await(); owner.transfer(signaling) { installed.incrementAndGet() } }
            val close = pool.submit { gate.await(); owner.close() }
            gate.countDown(); val transferred = transfer.get(1, TimeUnit.SECONDS); close.get(1, TimeUnit.SECONDS)
            pool.shutdownNow()
            assertEquals(if (transferred) 1 else 0, installed.get())
            assertEquals(!transferred, signaling.closed)
            assertEquals(1, stopped.get())
        }
    }

    @Test fun `off cancels blocked options or offer transport before lifecycle mutex cleanup`() {
        listOf("options", "offer").forEach { operation ->
            val server = MockWebServer()
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)); server.start()
            val transport = OwnedGatewayHttpTransport()
            val owner = GatewayMediaSetupOwner {}
            assertTrue(owner.register(Closeable { transport.close() }))
            val executor = Executors.newSingleThreadExecutor()
            try {
                val result = executor.submit<GatewayHttpResponse> {
                    transport.execute(GatewayHttpRequest(server.url("/$operation").toString(), "POST", jsonBody = "{}".toByteArray(), timeoutMs = 10_000))
                }
                assertTrue(server.takeRequest(2, TimeUnit.SECONDS) != null)

                owner.close()

                val error = runCatching { result.get(2, TimeUnit.SECONDS) }.exceptionOrNull()
                assertTrue("$operation must be cancelled", error is java.util.concurrent.ExecutionException)
                assertTrue(error?.cause is java.io.IOException)
            } finally {
                owner.close(); transport.close(); executor.shutdownNow(); server.shutdown()
            }
        }
    }

    private class FakeCloseable : Closeable {
        @Volatile var closed = false
        override fun close() { closed = true }
    }
}
