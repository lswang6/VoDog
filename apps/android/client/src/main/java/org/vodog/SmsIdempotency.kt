package org.vodog

import android.content.Context
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID

internal data class SmsAttempt(val storageKey: String, val idempotencyKey: String)

internal interface SmsRetryPersistence {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
    fun clear()
    fun snapshot(): Map<String, String>
}

internal class SharedPreferencesSmsRetryPersistence(
    context: Context,
    name: String = "sms_retry_v1",
) : SmsRetryPersistence {
    private val preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    override fun get(key: String): String? = preferences.getString(key, null)
    override fun put(key: String, value: String) = preferences.edit().putString(key, value).commit().let { Unit }
    override fun remove(key: String) = preferences.edit().remove(key).commit().let { Unit }
    override fun clear() = preferences.edit().clear().commit().let { Unit }
    override fun snapshot(): Map<String, String> = preferences.all.mapValues { it.value.toString() }

}

/** Persists only random keys and salted digests; SMS numbers and bodies never enter storage. */
internal class SmsIdempotencyCoordinator(
    private val persistence: SmsRetryPersistence,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    @Synchronized
    fun resumeSession(username: String) {
        val scope = persistence.get(SCOPE)
        val expectedTag = scope?.let { digest(it, normalizedAccount(username)) }
        if (scope == null || persistence.get(ACCOUNT_TAG) != expectedTag) startSession(username)
    }

    @Synchronized
    fun startSession(username: String) {
        persistence.clear()
        val scope = newId()
        persistence.put(SCOPE, scope)
        persistence.put(ACCOUNT_TAG, digest(scope, normalizedAccount(username)))
    }

    @Synchronized
    fun clearSession() = persistence.clear()

    @Synchronized
    fun attempt(simId: String, remoteNumber: String, body: String): SmsAttempt {
        val scope = checkNotNull(persistence.get(SCOPE)) { "SMS retry session is unavailable" }
        val storageKey = "$PENDING_PREFIX${digest(scope, simId, remoteNumber, body)}"
        val key = persistence.get(storageKey) ?: run {
            check(persistence.snapshot().keys.count { it.startsWith(PENDING_PREFIX) } < MAX_PENDING) {
                "待确认短信过多，请刷新发送状态后重试"
            }
            newId().also { persistence.put(storageKey, it) }
        }
        return SmsAttempt(storageKey, key)
    }

    @Synchronized
    fun batchAttempt(simId: String, recipients: List<String>, body: String): SmsAttempt {
        // Length-prefixing distinguishes ordered payloads and cannot collide with a phone number.
        val identity = "batch:" + recipients.joinToString("") { "${it.length}:$it" }
        return attempt(simId, identity, body)
    }

    @Synchronized
    fun confirmed(attempt: SmsAttempt) = persistence.remove(attempt.storageKey)

    @Synchronized
    fun failed(attempt: SmsAttempt, error: Throwable) {
        if (isDefinitiveFailure(error)) confirmed(attempt)
    }

    companion object {
        private const val SCOPE = "session_scope"
        private const val ACCOUNT_TAG = "account_tag"
        private const val PENDING_PREFIX = "pending."
        private const val MAX_PENDING = 128

        /** 5xx and transport/parsing failures may occur after the server committed the request. */
        fun isDefinitiveFailure(error: Throwable): Boolean = error is ApiError && error.status in 400..499 && error.status != 408

        private fun normalizedAccount(username: String) = username.trim().lowercase(Locale.ROOT)

        private fun digest(vararg parts: String): String {
            val hash = MessageDigest.getInstance("SHA-256")
            parts.forEach { part ->
                val bytes = part.toByteArray(Charsets.UTF_8)
                hash.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(bytes.size).array())
                hash.update(bytes)
            }
            return hash.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
