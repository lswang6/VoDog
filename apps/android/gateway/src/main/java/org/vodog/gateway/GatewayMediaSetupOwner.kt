package org.vodog.gateway

import java.io.Closeable

/** One irreversible owner for media setup started by one foreground-service ON generation. */
internal class GatewayMediaSetupOwner(
    private val stopInstalledIngress: () -> Unit = GatewayActiveAudioSession::requestAllIngressStop,
) : Closeable {
    private val lock = Any()
    private var closed = false
    private var pending: Closeable? = null

    fun register(value: Closeable): Boolean = synchronized(lock) {
        if (closed || pending != null) false else { pending = value; true }
    }.also { accepted -> if (!accepted) runCatching(value::close) }

    /** Installation and removal from pending ownership share the close linearization point. */
    fun transfer(value: Closeable, install: () -> Unit): Boolean = synchronized(lock) {
        if (closed || pending !== value) return@synchronized false
        install()
        pending = null
        true
    }

    fun clear(value: Closeable) {
        synchronized(lock) { if (pending === value) pending = null }
    }

    /** Cancels only the current call setup. The ON-generation owner remains reusable. */
    fun cancelPending() {
        val pendingToClose = synchronized(lock) { pending.also { pending = null } }
        pendingToClose?.let { runCatching(it::close) }
    }

    override fun close() {
        val pendingToClose = synchronized(lock) {
            if (closed) return
            closed = true
            // If transfer won, its Holder is already globally visible at this exact point.
            runCatching(stopInstalledIngress)
            pending.also { pending = null }
        }
        pendingToClose?.let { runCatching(it::close) }
    }
}
