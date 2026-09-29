package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

class OwnedGatewaySocketFactoryTest {
    @Test fun `owner close releases a connected raw socket that never entered a call or pool`() {
        val loopback = InetAddress.getLoopbackAddress()
        val server = ServerSocket(0, 1, loopback)
        val owner = OwnedGatewaySocketFactory()
        var socket: Socket? = null
        var peer: Socket? = null
        try {
            val connected = owner.createSocket().also {
                it.connect(InetSocketAddress(loopback, server.localPort), 2_000)
            }
            socket = connected
            val accepted = server.accept().also { it.soTimeout = 2_000 }
            peer = accepted

            owner.close()

            assertTrue(connected.isClosed)
            assertEquals(-1, accepted.getInputStream().read())
            assertEquals(0, owner.openSocketCount())
        } finally {
            owner.close()
            runCatching { socket?.close() }
            runCatching { peer?.close() }
            server.close()
        }
    }

    @Test fun `close winning before delegate returns rejects and closes the late socket`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val lateSocket = Socket()
        val delegate = RecordingSocketFactory {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            lateSocket
        }
        val owner = OwnedGatewaySocketFactory(delegate)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<Socket> { owner.createSocket() }
            assertTrue(entered.await(2, TimeUnit.SECONDS))

            owner.close()
            release.countDown()

            val failure = assertThrows(ExecutionException::class.java) {
                result.get(2, TimeUnit.SECONDS)
            }
            assertTrue(failure.cause is SocketException)
            assertTrue(lateSocket.isClosed)
            assertEquals(0, owner.openSocketCount())
        } finally {
            release.countDown()
            owner.close()
            executor.shutdownNow()
        }
    }

    @Test fun `registration winning before close remains owned and is closed`() {
        val owner = OwnedGatewaySocketFactory(RecordingSocketFactory())
        val socket = owner.createSocket()
        assertEquals(1, owner.openSocketCount())

        owner.close()

        assertTrue(socket.isClosed)
        assertEquals(0, owner.openSocketCount())
        assertThrows(SocketException::class.java) { owner.createSocket() }
    }

    @Test fun `capacity is hard bounded and a locally closed socket is pruned`() {
        val delegate = RecordingSocketFactory()
        val owner = OwnedGatewaySocketFactory(delegate, maxOpenSockets = 2)
        val first = owner.createSocket()
        val second = owner.createSocket()

        assertThrows(SocketException::class.java) { owner.createSocket() }
        assertEquals(2, delegate.created.size)
        first.close()
        val replacement = owner.createSocket()

        assertEquals(2, owner.openSocketCount())
        owner.close()
        assertTrue(second.isClosed)
        assertTrue(replacement.isClosed)
    }

    @Test fun `all SocketFactory overloads return sockets owned by the same close boundary`() {
        val delegate = RecordingSocketFactory()
        val owner = OwnedGatewaySocketFactory(delegate)
        val loopback = InetAddress.getLoopbackAddress()
        val sockets = listOf(
            owner.createSocket(),
            owner.createSocket("localhost", 1),
            owner.createSocket("localhost", 1, loopback, 0),
            owner.createSocket(loopback, 1),
            owner.createSocket(loopback, 1, loopback, 0),
        )

        owner.close()

        assertEquals(5, delegate.created.size)
        assertTrue(sockets.all(Socket::isClosed))
    }

    @Test fun `one provider close failure does not skip the remaining raw sockets`() {
        val failed = ThrowingCloseSocket()
        val normal = Socket()
        val pending = ArrayDeque(listOf<Socket>(failed, normal))
        val owner = OwnedGatewaySocketFactory(RecordingSocketFactory { pending.removeFirst() })
        owner.createSocket()
        owner.createSocket()

        owner.close()

        assertEquals(1, failed.closeAttempts)
        assertTrue(normal.isClosed)
    }

    private class RecordingSocketFactory(
        private val create: () -> Socket = { Socket() },
    ) : SocketFactory() {
        val created = mutableListOf<Socket>()

        override fun createSocket(): Socket = next()
        override fun createSocket(host: String, port: Int): Socket = next()
        override fun createSocket(
            host: String,
            port: Int,
            localHost: InetAddress,
            localPort: Int,
        ): Socket = next()
        override fun createSocket(host: InetAddress, port: Int): Socket = next()
        override fun createSocket(
            address: InetAddress,
            port: Int,
            localAddress: InetAddress,
            localPort: Int,
        ): Socket = next()

        private fun next(): Socket = create().also(created::add)
    }

    private class ThrowingCloseSocket : Socket() {
        var closeAttempts = 0
        override fun close() {
            closeAttempts++
            throw SocketException("injected close failure")
        }
    }
}
