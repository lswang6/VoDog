package org.vodog.gateway

import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class OwnedGatewayHttpTransportTest {
    @Test fun `active network call is cancelled without waiting for its request timeout`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<GatewayHttpResponse> {
                transport.execute(GatewayHttpRequest(server.url("/blocked").toString(), "GET", timeoutMs = 10_000))
            }
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS) != null)

            transport.close()

            val failure = assertThrows(java.util.concurrent.ExecutionException::class.java) {
                result.get(2, TimeUnit.SECONDS)
            }
            assertTrue(failure.cause is IOException)
            assertTrue(transport.isClosed())
        } finally {
            transport.close()
            executor.shutdownNow()
            server.shutdown()
        }
    }

    @Test fun `closed HTTP2 owner evicts a connection released after the initial eviction`() {
        val server = MockWebServer()
        server.protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE)
        server.enqueue(MockResponse().setBody("response"))
        server.start()
        val pool = ConnectionPool(5, 5, TimeUnit.MINUTES)
        val headersRead = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val transport = OwnedGatewayHttpTransport(
            pool = pool,
            protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE),
            interceptor = Interceptor { chain ->
                val response = chain.proceed(chain.request())
                headersRead.countDown()
                check(releaseResponse.await(5, TimeUnit.SECONDS))
                response
            },
        )
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<GatewayHttpResponse> {
                transport.execute(GatewayHttpRequest(server.url("/late-release").toString(), "GET"))
            }
            assertTrue(headersRead.await(2, TimeUnit.SECONDS))
            transport.close()
            assertEquals(1, pool.connectionCount())
            releaseResponse.countDown()
            runCatching { result.get(2, TimeUnit.SECONDS) }
            assertTrue(result.isDone)
            assertEquals(0, pool.connectionCount())
        } finally {
            releaseResponse.countDown()
            transport.close()
            pool.evictAll()
            executor.shutdownNow()
            server.shutdown()
        }
    }

    @Test fun `closed HTTP2 owner closes its socket at the late connection release event`() {
        val server = MockWebServer()
        server.protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE)
        server.enqueue(MockResponse().setBody("response"))
        server.start()
        val pool = ConnectionPool(5, 5, TimeUnit.MINUTES)
        val headersRead = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val connectionReleased = CountDownLatch(1)
        val inspectReleasedConnection = CountDownLatch(1)
        var releasedConnection: Connection? = null
        val transport = OwnedGatewayHttpTransport(
            pool = pool,
            protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE),
            interceptor = Interceptor { chain ->
                val response = chain.proceed(chain.request())
                headersRead.countDown()
                check(releaseResponse.await(5, TimeUnit.SECONDS))
                response
            },
            onClosedConnectionReleased = { connection ->
                releasedConnection = connection
                connectionReleased.countDown()
                check(inspectReleasedConnection.await(5, TimeUnit.SECONDS))
            },
        )
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<GatewayHttpResponse> {
                transport.execute(GatewayHttpRequest(server.url("/late-event").toString(), "GET"))
            }
            assertTrue(headersRead.await(2, TimeUnit.SECONDS))
            transport.close()
            releaseResponse.countDown()
            assertTrue(connectionReleased.await(2, TimeUnit.SECONDS))

            // The execute finally block cannot run while the event callback is held here.
            // The event itself must close this private owner's socket and remove it from the pool.
            assertTrue(requireNotNull(releasedConnection).socket().isClosed)
            assertEquals(0, pool.connectionCount())
            inspectReleasedConnection.countDown()
            runCatching { result.get(2, TimeUnit.SECONDS) }
            assertTrue(result.isDone)
        } finally {
            releaseResponse.countDown()
            inspectReleasedConnection.countDown()
            transport.close()
            pool.evictAll()
            executor.shutdownNow()
            server.shutdown()
        }
    }

    @Test fun `redirect is returned to caller and is never followed`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/followed"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("followed"))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        try {
            assertEquals(302, transport.execute(GatewayHttpRequest(server.url("/start").toString(), "GET")).status)
            assertEquals(1, server.requestCount)
        } finally {
            transport.close()
            server.shutdown()
        }
    }

    @Test fun `empty probe post has authorization but no json content type`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("{}"))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        try {
            transport.execute(GatewayHttpRequest(
                server.url("/probe").toString(), "POST", authorization = "Bearer grant", jsonBody = null,
            ))
            val request = requireNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            assertEquals("Bearer grant", request.getHeader("Authorization"))
            assertNull(request.getHeader("Content-Type"))
            assertEquals(0L, request.bodySize)
        } finally {
            transport.close()
            server.shutdown()
        }
    }

    @Test fun `response body over configured limit fails closed`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("123456789"))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        try {
            assertThrows(IOException::class.java) {
                transport.execute(GatewayHttpRequest(server.url("/large").toString(), "GET", responseLimitBytes = 8))
            }
        } finally {
            transport.close()
            server.shutdown()
        }
    }
}
