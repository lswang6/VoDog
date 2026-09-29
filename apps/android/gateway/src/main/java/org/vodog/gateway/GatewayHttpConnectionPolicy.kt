package org.vodog.gateway

import java.net.HttpURLConnection

/**
 * Gateway network traffic must not outlive the explicitly enabled runtime.
 *
 * Android's HttpURLConnection implementation may otherwise return a fully-read
 * HTTPS connection to a process-wide keep-alive pool. That pooled socket cannot
 * be reached by GatewayForegroundService when the operator turns the gateway
 * off, so require the peer to close every gateway HTTP connection after its
 * response instead of pooling it.
 */
internal object GatewayHttpConnectionPolicy {
    fun apply(connection: HttpURLConnection) {
        connection.useCaches = false
        connection.setRequestProperty("Connection", "close")
    }
}

/** Owns only currently executing control requests and rejects registration after OFF. */
internal class GatewayHttpConnectionOwner {
    private val lock = Any()
    private val active = mutableSetOf<HttpURLConnection>()
    private var closed = false

    fun register(connection: HttpURLConnection) = synchronized(lock) {
        if (closed) {
            connection.disconnect()
            false
        } else {
            active += connection
            true
        }
    }

    fun unregister(connection: HttpURLConnection) = synchronized(lock) { active -= connection }

    fun isOpen(): Boolean = synchronized(lock) { !closed }

    fun close() {
        val snapshot = synchronized(lock) {
            if (closed) return
            closed = true
            active.toList().also { active.clear() }
        }
        snapshot.forEach { connection -> runCatching(connection::disconnect) }
    }
}
