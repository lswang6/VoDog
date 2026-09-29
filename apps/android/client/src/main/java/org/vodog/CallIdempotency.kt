package org.vodog

import android.content.Context

internal data class CallAttempt(val storageKey: String, val idempotencyKey: String)

/** Keeps call request keys in a digest-only namespace separate from SMS retries. */
internal class CallIdempotencyCoordinator(
    private val delegate: SmsIdempotencyCoordinator,
) {
    constructor(context: Context, newId: () -> String = { java.util.UUID.randomUUID().toString() }) : this(
        SmsIdempotencyCoordinator(SharedPreferencesSmsRetryPersistence(context, "call_retry_v1"), newId),
    )

    internal constructor(persistence: SmsRetryPersistence, newId: () -> String) : this(
        SmsIdempotencyCoordinator(persistence, newId),
    )

    fun resumeSession(username: String) = delegate.resumeSession(username)
    fun startSession(username: String) = delegate.startSession(username)
    fun clearSession() = delegate.clearSession()
    fun attempt(simId: String, remoteNumber: String): CallAttempt =
        delegate.attempt(simId, remoteNumber, "outbound-call").let { CallAttempt(it.storageKey, it.idempotencyKey) }
    fun confirmed(attempt: CallAttempt) = delegate.confirmed(SmsAttempt(attempt.storageKey, attempt.idempotencyKey))
    fun failed(attempt: CallAttempt, error: Throwable) =
        delegate.failed(SmsAttempt(attempt.storageKey, attempt.idempotencyKey), error)
}
