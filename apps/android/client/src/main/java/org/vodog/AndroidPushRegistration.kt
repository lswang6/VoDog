package org.vodog

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume

internal data class IncomingPush(
    val event: String,
    val callId: String,
    val notificationId: String,
    /** S21 §A: the server adds it when it resolved the caller; absent on every older payload. */
    val contactName: String? = null,
    /** S36 C1: the caller's number, so the first notification is not "号码未知". Gated server-side. */
    val remoteNumber: String? = null,
    /** S72 E: 内部通话（同一 owner 的托管卡互打）；FCM data 值是字符串 "true"。 */
    val internal: Boolean = false,
    /** S72 E: 主叫卡的显示名，响铃显示「{peerSimLabel}（内部）」。 */
    val peerSimLabel: String? = null,
)

/**
 * The payload stays exact — an unexpected key is still a rejected push — with exactly two additions:
 * S21 §A's `contactName` and S36 C1's `remoteNumber`, so the incoming-call notification can show
 * who is calling before `GET /calls/:id` answers. Anything else in the allow-list's absence still
 * drops the whole push, which is why Control gates FCM's `remoteNumber` behind a flag until this
 * build is out.
 */
internal fun parseIncomingPush(data: Map<String, String>): IncomingPush? {
    val required = setOf("version", "event", "callId", "notificationId")
    if (!data.keys.containsAll(required)) return null
    if (!(data.keys - required).all { it in OPTIONAL_PUSH_KEYS }) return null
    if (data["version"] != "1") return null
    val event = data["event"]?.takeIf { it == "call.incoming" || it == "call.cancelled" } ?: return null
    val callId = data["callId"]?.asUuid() ?: return null
    val notificationId = data["notificationId"]?.asUuid() ?: return null
    return IncomingPush(
        event,
        callId,
        notificationId,
        data["contactName"]?.trim()?.takeIf { it.isNotEmpty() && it.length <= 120 },
        data["remoteNumber"]?.trim()?.takeIf { it.isNotEmpty() && it.length <= 64 },
        data["internal"] == "true",
        data["peerSimLabel"]?.trim()?.takeIf { it.isNotEmpty() && it.length <= 120 },
    )
}

// S72: `internal` / `peerSimLabel` 之前的版本会整条丢弃带这两个键的推送——Control 须等本版装机后再发。
private val OPTIONAL_PUSH_KEYS = setOf("contactName", "remoteNumber", "internal", "peerSimLabel")

/** S72 B5: 响铃标题。内部来电显示主叫卡「{peerSimLabel}（内部） 来电」，否则 `号码 · 姓名 来电`。 */
internal fun incomingCallTitle(number: String?, contactName: String?, internal: Boolean, peerSimLabel: String?): String? = when {
    internal -> "${peerSimLabel?.takeIf { it.isNotBlank() && it != "null" } ?: "另一张卡"}（内部） 来电"
    number != null -> "${numberWithContactName(number, contactName)} 来电"
    contactName != null -> "$contactName 来电"
    else -> null
}

private fun String.asUuid(): String? = runCatching { UUID.fromString(this).toString() }.getOrNull()

internal class AndroidPushStore(context: Context) {
    private val prefs = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    val installationId: String
        get() = prefs.getString(KEY_INSTALLATION, null)?.asUuid() ?: UUID.randomUUID().toString().also {
            check(prefs.edit().putString(KEY_INSTALLATION, it).commit())
        }

    fun token(): String? = prefs.getString(KEY_TOKEN, null)?.takeIf { it.length in 32..4096 }

    fun saveToken(token: String) {
        require(token.length in 32..4096)
        if (prefs.getString(KEY_TOKEN, null) == token) return
        check(prefs.edit().putString(KEY_TOKEN, token).remove(KEY_BINDING).commit())
    }

    fun bindingMatches(session: Session, token: String, badge: BadgePrefs): Boolean =
        prefs.getString(KEY_BINDING, null) == bindingDigest(session, token, badge)

    fun markBound(session: Session, token: String, badge: BadgePrefs) {
        check(prefs.edit().putString(KEY_BINDING, bindingDigest(session, token, badge)).commit())
    }

    fun clearBinding() { check(prefs.edit().remove(KEY_BINDING).commit()) }

    private fun digest(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

    // S67: the badge settings are part of the binding, so changing them re-PUTs the registration.
    private fun bindingDigest(session: Session, token: String, badge: BadgePrefs) =
        digest("${session.username}\u0000${session.refreshToken}\u0000$token\u0000$badge")

    private companion object {
        const val NAME = "android_push_registration"
        const val KEY_INSTALLATION = "installation_id"
        const val KEY_TOKEN = "fcm_token"
        const val KEY_BINDING = "bound_session_digest"
    }
}

internal interface AndroidPushTokenProvider {
    suspend fun token(): String?
}

internal class FirebasePushTokenProvider(private val context: Context) : AndroidPushTokenProvider {
    override suspend fun token(): String? {
        if (runCatching {
            FirebaseApp.getApps(context.applicationContext).firstOrNull()
                ?: FirebaseApp.initializeApp(context.applicationContext)
        }.getOrNull() == null) return null
        return suspendCancellableCoroutine { continuation ->
            runCatching { FirebaseMessaging.getInstance().token }
                .onFailure { continuation.resume(null) }
                .onSuccess { task -> task.addOnCompleteListener { result ->
                    if (continuation.isActive) {
                        continuation.resume(if (result.isSuccessful) result.result else null)
                    }
                } }
        }?.takeIf { it.length in 32..4096 }
    }
}

sealed interface PushRegistrationState {
    data object Unavailable : PushRegistrationState
    data object Registering : PushRegistrationState
    data object Ready : PushRegistrationState
    data object Failed : PushRegistrationState
}

internal interface AndroidPushRegistrationApi {
    fun register(installationId: String, token: String, badge: BadgePrefs): JSONObject
    fun delete(installationId: String): JSONObject
}

private class NetworkAndroidPushRegistrationApi(private val api: ClientApi) : AndroidPushRegistrationApi {
    override fun register(installationId: String, token: String, badge: BadgePrefs) =
        api.registerAndroidPush(installationId, token, badge)
    override fun delete(installationId: String) = api.deletePushRegistration(installationId)
}

internal class AndroidPushRegistrationCoordinator(
    context: Context,
    private val sessions: SessionCoordinator,
    api: ClientApi,
    private val tokens: AndroidPushTokenProvider = FirebasePushTokenProvider(context),
    private val registrationApi: AndroidPushRegistrationApi = NetworkAndroidPushRegistrationApi(api),
) {
    private val store = AndroidPushStore(context.applicationContext)
    private val badgePrefs = BadgePrefsStore(context)

    suspend fun ensureCurrent(): PushRegistrationState = PROCESS_MUTATION.withLock {
        val expected = sessions.snapshot()
        val session = expected.session ?: return PushRegistrationState.Unavailable
        val fresh = tokens.token() ?: store.token() ?: return PushRegistrationState.Unavailable
        store.saveToken(fresh)
        val badge = badgePrefs.read()
        if (store.bindingMatches(session, fresh, badge)) return PushRegistrationState.Ready
        return runCatching { registrationApi.register(store.installationId, fresh, badge) }.fold(
            onSuccess = {
                val current = sessions.snapshot()
                val currentSession = current.session
                if (current.epoch != expected.epoch || currentSession?.username != session.username) {
                    return PushRegistrationState.Failed
                }
                store.markBound(currentSession, fresh, badge)
                PushRegistrationState.Ready
            },
            // S36b D1: 推送注册失败 = 之后所有来电都不会响，异常必须进诊断时间线。
            onFailure = { ClientDiag.appError("push.register", it); PushRegistrationState.Failed },
        )
    }

    suspend fun unregisterCurrent() = PROCESS_MUTATION.withLock {
        val expected = sessions.snapshot()
        if (expected.session != null) runCatching { registrationApi.delete(store.installationId) }
        store.clearBinding()
    }

    fun acceptRotatedToken(token: String) = store.saveToken(token)

    private companion object {
        val PROCESS_MUTATION = Mutex()
    }
}
