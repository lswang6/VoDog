package org.vodog

import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class SessionSnapshot internal constructor(val epoch: Long, val session: Session?)

class SessionChangedException : Exception("登录会话已变更")

/** Owns the process-wide client session and serializes refresh-token rotation. */
class SessionCoordinator(
    initialSession: Session?,
    private val onSessionChanged: (Session?) -> Unit = {},
    private val onSessionInvalidated: () -> Unit = {},
) {
    private data class RefreshFlight(val epoch: Long, val result: CompletableFuture<SessionSnapshot>)

    private var epoch = 0L
    private var session = initialSession
    private var refreshFlight: RefreshFlight? = null

    @Synchronized
    fun snapshot(): SessionSnapshot = SessionSnapshot(epoch, session)

    @Synchronized
    fun isCurrent(expectedEpoch: Long): Boolean = epoch == expectedEpoch

    @Synchronized
    fun install(expectedEpoch: Long, replacement: Session): Boolean {
        if (epoch != expectedEpoch) return false
        epoch += 1
        session = replacement
        onSessionChanged(replacement)
        return true
    }

    @Synchronized
    fun clear(): Session? {
        val removed = session
        epoch += 1
        session = null
        onSessionChanged(null)
        return removed
    }

    fun refresh(expected: SessionSnapshot, refresher: (Session) -> Session): SessionSnapshot {
        val flight: RefreshFlight
        val leader: Boolean
        synchronized(this) {
            if (epoch != expected.epoch) throw SessionChangedException()
            val current = session ?: throw SessionChangedException()
            val expectedSession = expected.session ?: throw SessionChangedException()
            if (current.username != expectedSession.username) throw SessionChangedException()
            if (current.token != expectedSession.token || current.refreshToken != expectedSession.refreshToken) {
                return SessionSnapshot(epoch, current)
            }
            val existing = refreshFlight
            if (existing != null && existing.epoch == expected.epoch) {
                flight = existing
                leader = false
            } else {
                flight = RefreshFlight(expected.epoch, CompletableFuture())
                refreshFlight = flight
                leader = true
            }
        }

        if (leader) {
            try {
                val refreshed = refresher(requireNotNull(expected.session))
                val committed = synchronized(this) {
                    val current = requireRefreshCompatibleLocked(expected)
                    val merged = refreshed.copy(role = current.role)
                    session = merged
                    onSessionChanged(merged)
                    SessionSnapshot(epoch, merged)
                }
                flight.result.complete(committed)
            } catch (error: Throwable) {
                if (error is ApiError && error.status == 401) invalidate(expected)
                flight.result.completeExceptionally(error)
            } finally {
                synchronized(this) {
                    if (refreshFlight === flight) refreshFlight = null
                }
            }
        }

        return try {
            flight.result.get()
        } catch (error: ExecutionException) {
            throw (error.cause ?: error)
        }
    }

    suspend fun refreshCancellable(
        expected: SessionSnapshot,
        refresher: suspend (Session) -> Session,
    ): SessionSnapshot {
        val flight: RefreshFlight
        val leader: Boolean
        synchronized(this) {
            if (epoch != expected.epoch) throw SessionChangedException()
            val current = session ?: throw SessionChangedException()
            val expectedSession = expected.session ?: throw SessionChangedException()
            if (current.username != expectedSession.username) throw SessionChangedException()
            if (current.token != expectedSession.token || current.refreshToken != expectedSession.refreshToken) {
                return SessionSnapshot(epoch, current)
            }
            val existing = refreshFlight
            if (existing != null && existing.epoch == expected.epoch) {
                flight = existing
                leader = false
            } else {
                flight = RefreshFlight(expected.epoch, CompletableFuture())
                refreshFlight = flight
                leader = true
            }
        }
        if (leader) {
            try {
                val refreshed = refresher(requireNotNull(expected.session))
                val committed = synchronized(this) {
                    val current = requireRefreshCompatibleLocked(expected)
                    val merged = refreshed.copy(role = current.role)
                    session = merged
                    onSessionChanged(merged)
                    SessionSnapshot(epoch, merged)
                }
                flight.result.complete(committed)
            } catch (error: Throwable) {
                if (error is ApiError && error.status == 401) invalidate(expected)
                flight.result.completeExceptionally(error)
            } finally {
                synchronized(this) {
                    if (refreshFlight === flight) refreshFlight = null
                }
            }
        }
        return suspendCancellableCoroutine { continuation ->
            flight.result.whenComplete { value, error ->
                if (!continuation.isActive) return@whenComplete
                if (error == null) continuation.resume(value)
                else continuation.resumeWithException(
                    (error as? java.util.concurrent.CompletionException)?.cause ?: error
                )
            }
        }
    }

    @Synchronized
    fun invalidate(expected: SessionSnapshot): Boolean {
        if (!matchesCredentialsLocked(expected)) return false
        epoch += 1
        session = null
        onSessionChanged(null)
        onSessionInvalidated()
        return true
    }

    @Synchronized
    fun requireCurrent(expected: SessionSnapshot): SessionSnapshot {
        requireCurrentLocked(expected)
        return SessionSnapshot(epoch, session)
    }

    /** Resolves a refreshed bearer within one login epoch without accepting a logout/re-login replacement. */
    @Synchronized
    fun resolveSameLogin(expected: SessionSnapshot): SessionSnapshot {
        val expectedSession = expected.session ?: throw SessionChangedException()
        val currentSession = session ?: throw SessionChangedException()
        if (epoch != expected.epoch || currentSession.username != expectedSession.username) {
            throw SessionChangedException()
        }
        return SessionSnapshot(epoch, currentSession)
    }

    /** Applies an authenticated profile without replacing tokens or changing the login epoch. */
    @Synchronized
    fun updateProfile(expected: SessionSnapshot, username: String, role: String): SessionSnapshot {
        val expectedSession = expected.session ?: throw SessionChangedException()
        val currentSession = session ?: throw SessionChangedException()
        if (epoch != expected.epoch || currentSession.username != expectedSession.username || username != currentSession.username) {
            throw SessionChangedException()
        }
        val updated = currentSession.copy(role = role)
        if (updated != currentSession) {
            session = updated
            onSessionChanged(updated)
        }
        return SessionSnapshot(epoch, session)
    }

    private fun requireCurrentLocked(expected: SessionSnapshot) {
        if (!matchesLocked(expected)) throw SessionChangedException()
    }

    private fun requireRefreshCompatibleLocked(expected: SessionSnapshot): Session {
        val expectedSession = expected.session ?: throw SessionChangedException()
        val currentSession = session ?: throw SessionChangedException()
        if (
            epoch != expected.epoch ||
            currentSession.username != expectedSession.username ||
            currentSession.token != expectedSession.token ||
            currentSession.refreshToken != expectedSession.refreshToken
        ) throw SessionChangedException()
        return currentSession
    }

    private fun matchesLocked(expected: SessionSnapshot): Boolean =
        epoch == expected.epoch && session == expected.session

    private fun matchesCredentialsLocked(expected: SessionSnapshot): Boolean {
        val expectedSession = expected.session ?: return false
        val currentSession = session ?: return false
        return epoch == expected.epoch &&
            currentSession.username == expectedSession.username &&
            currentSession.token == expectedSession.token &&
            currentSession.refreshToken == expectedSession.refreshToken
    }
}
