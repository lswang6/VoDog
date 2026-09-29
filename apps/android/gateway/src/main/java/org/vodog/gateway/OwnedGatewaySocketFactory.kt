package org.vodog.gateway

import java.io.Closeable
import java.net.InetAddress
import java.net.Socket
import java.net.SocketException
import java.util.Collections
import java.util.IdentityHashMap
import javax.net.SocketFactory

/** Owns every raw socket created for one [OwnedGatewayHttpTransport]. */
internal class OwnedGatewaySocketFactory(
    private val delegate: SocketFactory = SocketFactory.getDefault(),
    private val maxOpenSockets: Int = DEFAULT_MAX_OPEN_SOCKETS,
) : SocketFactory(), Closeable {
    private val lock = Any()
    private val sockets = Collections.newSetFromMap(IdentityHashMap<Socket, Boolean>())
    private var creating = 0
    private var closed = false

    init {
        require(maxOpenSockets > 0) { "maxOpenSockets must be positive" }
    }

    override fun createSocket(): Socket = createOwned { delegate.createSocket() }

    override fun createSocket(host: String, port: Int): Socket =
        createOwned { delegate.createSocket(host, port) }

    override fun createSocket(
        host: String,
        port: Int,
        localHost: InetAddress,
        localPort: Int,
    ): Socket = createOwned { delegate.createSocket(host, port, localHost, localPort) }

    override fun createSocket(host: InetAddress, port: Int): Socket =
        createOwned { delegate.createSocket(host, port) }

    override fun createSocket(
        address: InetAddress,
        port: Int,
        localAddress: InetAddress,
        localPort: Int,
    ): Socket = createOwned { delegate.createSocket(address, port, localAddress, localPort) }

    override fun close() {
        val socketsToClose = synchronized(lock) {
            if (closed) return
            closed = true
            sockets.toList().also { sockets.clear() }
        }
        // Socket.close may perform provider work. Keep it outside the ownership lock and attempt
        // every socket even if one provider throws.
        socketsToClose.forEach { socket -> runCatching(socket::close) }
    }

    internal fun openSocketCount(): Int = synchronized(lock) {
        pruneClosedLocked()
        sockets.size
    }

    private fun createOwned(create: () -> Socket): Socket {
        synchronized(lock) {
            if (closed) throw ownerClosed()
            pruneClosedLocked()
            if (sockets.size + creating >= maxOpenSockets) throw capacityExceeded()
            creating++
        }

        // The delegate may block. close() must remain able to linearize while creation is in flight.
        val socket = try {
            create()
        } catch (error: Throwable) {
            synchronized(lock) { creating-- }
            throw error
        }
        val rejection = synchronized(lock) {
            creating--
            pruneClosedLocked()
            when {
                closed -> ownerClosed()
                sockets.size >= maxOpenSockets -> capacityExceeded()
                else -> {
                    sockets += socket
                    null
                }
            }
        }
        if (rejection != null) {
            runCatching(socket::close)
            throw rejection
        }
        return socket
    }

    private fun pruneClosedLocked() {
        sockets.removeAll { it.isClosed }
    }

    private fun ownerClosed() = SocketException("gateway socket owner closed")

    private fun capacityExceeded() = SocketException("gateway socket owner capacity exceeded")

    private companion object {
        const val DEFAULT_MAX_OPEN_SOCKETS = 128
    }
}
