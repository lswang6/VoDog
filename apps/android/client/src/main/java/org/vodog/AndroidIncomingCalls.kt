package org.vodog

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.telecom.TelecomManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.telecom.DisconnectCause
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallsManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet

internal data class StoredIncomingCall(
    val callId: String,
    val notificationId: String,
    val accountDigest: String,
    val sessionGeneration: String,
    val actionToken: String,
    val createdAtMs: Long,
)

internal fun freshIncomingRecords(records: List<StoredIncomingCall>, nowMs: Long): List<StoredIncomingCall> =
    records.filter { incomingRecordFresh(it, nowMs) }

private fun incomingRecordFresh(record: StoredIncomingCall, nowMs: Long): Boolean =
    record.createdAtMs in 1..nowMs && nowMs - record.createdAtMs <= INCOMING_RECORD_TTL_MS

internal const val INCOMING_RECORD_TTL_MS = 5 * 60 * 1000L

/** Small private action journal. Corruption and capacity exhaustion fail closed. */
internal class IncomingCallStore(context: Context) {
    private val prefs = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun ingest(push: IncomingPush, username: String, sessionGeneration: String): StoredIncomingCall? {
        val now = System.currentTimeMillis()
        val records = freshIncomingRecords(read(), now).toMutableList()
        val digest = accountDigest(username)
        records.firstOrNull { it.notificationId == push.notificationId }?.let {
            return it.takeIf { record ->
                record.callId == push.callId && record.accountDigest == digest &&
                    record.sessionGeneration == sessionGeneration
            }
        }
        records.removeAll { it.callId == push.callId && it.sessionGeneration != sessionGeneration }
        val existing = records.firstOrNull {
            it.callId == push.callId && it.accountDigest == digest && it.sessionGeneration == sessionGeneration
        }
        if (push.event == "call.cancelled") return existing
        if (existing != null) return existing
        check(records.size < MAX_RECORDS) { "来电操作队列已满" }
        return StoredIncomingCall(
            push.callId,
            push.notificationId,
            digest,
            sessionGeneration,
            UUID.randomUUID().toString(),
            now,
        ).also { records += it; write(records) }
    }

    @Synchronized
    fun action(callId: String, token: String, username: String, sessionGeneration: String): StoredIncomingCall? =
        read().singleOrNull {
            it.callId == callId && it.actionToken == token && it.accountDigest == accountDigest(username) &&
                it.sessionGeneration == sessionGeneration && incomingRecordFresh(it, System.currentTimeMillis())
        }

    @Synchronized
    fun authorize(callId: String, username: String, sessionGeneration: String): StoredIncomingCall {
        val push = IncomingPush("call.incoming", callId, UUID.randomUUID().toString())
        return checkNotNull(ingest(push, username, sessionGeneration))
    }

    @Synchronized
    fun remove(callId: String) = write(read().filterNot { it.callId == callId })

    @Synchronized
    fun clear() = check(prefs.edit().clear().commit())

    private fun read(): List<StoredIncomingCall> {
        val array = JSONArray(prefs.getString(KEY, "[]") ?: error("来电操作记录损坏"))
        return List(array.length()) { index -> array.getJSONObject(index).let {
            StoredIncomingCall(
                it.getString("callId").validUuid() ?: error("来电标识损坏"),
                it.getString("notificationId").validUuid() ?: error("通知标识损坏"),
                it.getString("accountDigest").takeIf(String::isNotBlank) ?: error("账号标识损坏"),
                it.getString("sessionGeneration").validUuid() ?: error("会话代次损坏"),
                it.getString("actionToken").validUuid() ?: error("操作标识损坏"),
                it.getLong("createdAtMs").takeIf { time -> time > 0 } ?: error("来电时间损坏"),
            )
        } }
    }

    private fun write(records: List<StoredIncomingCall>) {
        val array = JSONArray()
        records.forEach { record -> array.put(JSONObject()
            .put("callId", record.callId)
            .put("notificationId", record.notificationId)
            .put("accountDigest", record.accountDigest)
            .put("sessionGeneration", record.sessionGeneration)
            .put("actionToken", record.actionToken)
            .put("createdAtMs", record.createdAtMs)) }
        check(prefs.edit().putString(KEY, array.toString()).commit())
    }

    companion object {
        internal fun accountDigest(username: String): String = MessageDigest.getInstance("SHA-256")
            .digest(username.toByteArray()).joinToString("") { "%02x".format(it) }
        private const val NAME = "incoming_call_journal"
        private const val KEY = "records_v2"
        private const val MAX_RECORDS = 16
    }
}

class VoDogMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        if (BuildConfig.S33_UI_TEST) return
        if (token.length !in 32..4096) return
        val sessions = ClientSessionProcess.coordinator(this)
        val coordinator = AndroidPushRegistrationCoordinator(this, sessions, ClientApi(sessions))
        runCatching { coordinator.acceptRotatedToken(token) }
        scope.launch { coordinator.ensureCurrent() }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (BuildConfig.S33_UI_TEST) return
        // S67: badge.update carries keys parseIncomingPush rejects, so it is routed first.
        if (message.data["event"] == "badge.update") {
            val badge = parseBadgePush(message.data) ?: return
            if (ClientSessionProcess.coordinator(this).snapshot().session == null) return
            val (calls, sms) = iconBadgeCounts(badge.calls, badge.sms, BadgePrefsStore(this).read())
            // Control already applied the registered prefs to `badge`; the local split only words the text.
            if (badge.badge == 0) BadgeNotifier.cancel(this) else BadgeNotifier.show(this, calls, sms)
            return
        }
        val push = parseIncomingPush(message.data) ?: return
        ClientDiag.attach(this)
        ClientDiag.log("push.fcm", mapOf("event" to push.event, "named" to (push.contactName != null)), callId = push.callId)
        val session = ClientSessionProcess.coordinator(this).snapshot().session ?: return
        val generation = ClientSessionProcess.generation(this) ?: return
        val stored = runCatching {
            IncomingCallStore(this).ingest(push, session.username, generation)
        }.getOrNull() ?: return
        if (push.event == "call.cancelled") {
            OngoingCallService.cancelRinging(this, stored.callId)
        } else if (canShowCallNotification(this)) {
            // S72 D3: 读在本来电加入 Telecom 之前，重复推送（本来电已在响）不算忙。内部来电由 Control 自己跳过代接。
            val ownerBusy = !push.internal && !ActiveCallServices.contains(stored.callId) && deviceInCall(this)
            OngoingCallService.ring(
                this,
                stored.callId,
                stored.actionToken,
                push.contactName,
                push.remoteNumber,
                System.currentTimeMillis(),
                internal = push.internal,
                peerSimLabel = push.peerSimLabel,
                ownerBusy = ownerBusy,
            )
        }
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}

/**
 * Why a media attempt ended. A media failure is not a reason to hang up: the call is held for
 * [CallMediaGracePolicy.GRACE_SECONDS] with a retry choice, so only [REJECTED] (nothing was ever
 * attempted because the call is no longer ours) ends the call at once.
 */
internal enum class CallMediaConnectOutcome { CONNECTED, FAILED, REJECTED }

internal object ClientCallRuntime {
    private val _state = MutableStateFlow(CallMediaUiState())
    val state: StateFlow<CallMediaUiState> = _state
    @Volatile private var media: AndroidCallMediaSession? = null
    @Volatile private var ownerEpoch: Long? = null
    @Volatile private var appContext: Context? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Held on its own monitor so the publish path never waits on the attach/stop monitor. */
    private val graceLock = Any()
    private val grace = CallMediaGraceTracker()
    private var graceJob: Job? = null

    /**
     * Any published state that is not a media failure — a reconnect, a reconcile to a terminal
     * call state, or [stop] — cancels the pending grace and its auto-end timer.
     */
    private fun publish(state: CallMediaUiState) {
        _state.value = state
        if (state.phase != CallMediaPhase.FAILED) cancelGrace()
    }

    private fun cancelGrace() = synchronized(graceLock) {
        graceJob?.cancel()
        graceJob = null
        grace.cancel()
    }

    @Synchronized
    private fun attach(context: Context, epoch: Long): AndroidCallMediaSession {
        if (ownerEpoch != null && ownerEpoch != epoch) stop()
        ownerEpoch = epoch
        appContext = context.applicationContext
        return media ?: AndroidCallMediaSession(
            context.applicationContext,
            ClientApi(ClientSessionProcess.coordinator(context)),
            ::publish,
            ::handleTerminalFailure,
        ).also { media = it }
    }

    /**
     * The single terminal-failure handler for the process; it runs without a ViewModel because
     * background calls live in [OngoingCallService].
     */
    private fun handleTerminalFailure(callId: String, transport: CallMediaTransport, error: Throwable) {
        val context = appContext ?: return
        when (CallMediaGracePolicy.plan(error)) {
            CallMediaGracePolicy.Plan.END_IMMEDIATELY -> {
                cancelGrace()
                OngoingCallService.autoEnd(context, callId)
            }
            CallMediaGracePolicy.Plan.HOLD_FOR_GRACE -> beginGrace(context, callId)
        }
    }

    private fun beginGrace(context: Context, callId: String) {
        val job = synchronized(graceLock) {
            graceJob?.cancel()
            grace.begin(callId)
            scope.launch {
                delay(CallMediaGracePolicy.GRACE_MILLIS)
                val current = _state.value
                if (current.callId != callId || current.phase != CallMediaPhase.FAILED) return@launch
                if (!grace.consume(callId)) return@launch
                OngoingCallService.autoEnd(context, callId)
            }.also { graceJob = it }
        }
        // A failure that resolved while the job was being installed must not outlive it.
        if (_state.value.phase != CallMediaPhase.FAILED) {
            job.cancel()
            cancelGrace()
        }
    }

    suspend fun connect(
        context: Context,
        callId: String,
        transport: CallMediaTransport,
    ): CallMediaConnectOutcome {
        val current = _state.value
        if (current.callId != null && current.callId != callId &&
            current.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)
        ) return CallMediaConnectOutcome.REJECTED
        RecordingPlaybackController.get(context).stop()
        val sessions = ClientSessionProcess.coordinator(context)
        val expected = sessions.snapshot()
        expected.session ?: return CallMediaConnectOutcome.REJECTED
        val detail = withContext(Dispatchers.IO) { runCatching { ClientApi(sessions).call(callId) }.getOrNull() }
            ?: return CallMediaConnectOutcome.REJECTED
        if (!sessions.isCurrent(expected.epoch) || !detail.optBoolean("claimedByCurrentSession") ||
            detail.optString("state") !in MEDIA_STATES
        ) return CallMediaConnectOutcome.REJECTED
        attach(context, expected.epoch).connect(callId, transport)
        val completed = _state.value
        if (!sessions.isCurrent(expected.epoch) || completed.callId != callId) {
            return CallMediaConnectOutcome.REJECTED
        }
        return when (completed.phase) {
            CallMediaPhase.CONNECTED -> CallMediaConnectOutcome.CONNECTED
            CallMediaPhase.FAILED -> CallMediaConnectOutcome.FAILED
            else -> CallMediaConnectOutcome.REJECTED
        }
    }

    fun reconcile(calls: List<JSONObject>) { media?.reconcile(calls) }
    fun speaker(enabled: Boolean) { media?.setSpeaker(enabled) }
    fun mute(muted: Boolean): Boolean = media?.setMuted(muted) == true
    fun invalidateProbe() { media?.invalidateProbe() }
    fun owns(callId: String): Boolean = _state.value.let {
        it.callId == callId && it.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED, CallMediaPhase.FAILED)
    }

    @Synchronized
    fun stop() {
        cancelGrace()
        media?.close()
        media = null
        ownerEpoch = null
        _state.value = CallMediaUiState()
    }

    fun permissionDenied(context: Context, callId: String, transport: CallMediaTransport) {
        stop()
        appContext = context.applicationContext
        val error = CallMediaSessionException(CallMediaFailureKind.MICROPHONE_PERMISSION_DENIED, transport)
        _state.value = CallMediaUiState(callId, CallMediaPhase.FAILED, transport, error.message)
        handleTerminalFailure(callId, transport, error)
    }

    private val MEDIA_STATES = setOf("outgoing_pending", "connecting", "active")
}

internal enum class CancelledCallDisposition { KEEP_ONGOING, END_LOCAL }

internal fun cancelledCallDisposition(claimedByCurrentSession: Boolean, state: String): CancelledCallDisposition =
    if (claimedByCurrentSession && state in OngoingCallService.NON_TERMINAL) {
        CancelledCallDisposition.KEEP_ONGOING
    } else {
        CancelledCallDisposition.END_LOCAL
    }

/** Local lifecycle signal only. A future server lease may observe this without changing call authority. */
internal enum class ClientCallLivenessPhase { RINGING, CLAIMED, MEDIA_ACTIVE, ENDED }

internal object ClientCallLiveness {
    private val listeners = CopyOnWriteArraySet<(String, ClientCallLivenessPhase) -> Unit>()
    fun listen(listener: (String, ClientCallLivenessPhase) -> Unit): Closeable {
        listeners += listener
        return Closeable { listeners -= listener }
    }
    fun publish(callId: String, phase: ClientCallLivenessPhase) {
        listeners.forEach { listener -> runCatching { listener(callId, phase) } }
    }
}

internal data class ServiceSessionIdentity(
    val epoch: Long,
    val generation: String,
    val username: String,
)

internal fun currentServiceIdentity(context: Context): ServiceSessionIdentity? {
    val snapshot = ClientSessionProcess.coordinator(context).snapshot()
    val session = snapshot.session ?: return null
    val generation = ClientSessionProcess.generation(context) ?: return null
    return ServiceSessionIdentity(snapshot.epoch, generation, session.username)
}

internal fun serviceIdentityMatches(expected: ServiceSessionIdentity, current: ServiceSessionIdentity?): Boolean =
    current?.epoch == expected.epoch && current.generation == expected.generation &&
        current.username == expected.username

internal fun serviceActionPermitted(
    action: String,
    hasExactTokenRecord: Boolean,
    isActiveCall: Boolean,
    ownsMedia: Boolean,
): Boolean = when (action) {
    OngoingCallService.ACTION_RING,
    OngoingCallService.ACTION_ANSWER,
    OngoingCallService.ACTION_DECLINE,
    OngoingCallService.ACTION_END,
    OngoingCallService.ACTION_CONNECT -> hasExactTokenRecord
    OngoingCallService.ACTION_CANCEL_RINGING -> isActiveCall
    OngoingCallService.ACTION_SPEAKER,
    OngoingCallService.ACTION_MUTE,
    OngoingCallService.ACTION_STOP_MEDIA,
    OngoingCallService.ACTION_AUTO_END -> ownsMedia
    else -> false
}

/**
 * Why the ring-time `GET /calls/:id` failed. Only `network` (no HTTP answer, or a 5xx/408/429) is
 * "unknown": the phone still rings on the push and `reconcileRingingLoop` settles it. `session` and
 * `not_ringing` are definitive answers and stop the ring.
 */
internal fun incomingVerifyFailureReason(error: Throwable): String = when {
    error is SessionChangedException -> "session"
    error !is ApiError -> "network"
    error.status == 401 || error.status == 403 -> "session"
    error.status >= 500 || error.status == 408 || error.status == 429 -> "network"
    else -> "not_ringing"
}

internal class AndroidTelecomCalls(
    context: Context,
    private val onAnswer: suspend (String) -> Boolean,
    private val onAnswered: suspend (String) -> Unit,
    private val onDisconnect: suspend (String) -> Unit,
) {
    private val calls = CallsManager(context.applicationContext).also {
        it.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
    }
    private val scopes = ConcurrentHashMap<String, CallControlScope>()
    private val readyScopes = ConcurrentHashMap<String, CompletableDeferred<CallControlScope>>()

    suspend fun addIncoming(callId: String, displayName: String) {
        lateinit var control: CallControlScope
        val ready = CompletableDeferred<CallControlScope>()
        readyScopes[callId] = ready
        val attributes = CallAttributesCompat(
            displayName,
            Uri.parse("vodog:$callId"),
            CallAttributesCompat.DIRECTION_INCOMING,
            CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
            0,
        )
        calls.addCall(
            attributes,
            onAnswer = { type ->
                if (onAnswer(callId)) {
                    control.answer(type)
                    onAnswered(callId)
                }
            },
            onDisconnect = { cause ->
                scopes.remove(callId)
                onDisconnect(callId)
            },
            onSetActive = { control.setActive() },
            onSetInactive = { control.setInactive() },
        ) {
            // Core-Telecom 1.0.1 awaits its internal blockingSessionExecution after this DSL returns.
            control = this
            scopes[callId] = this
            ready.complete(this)
        }
        scopes.remove(callId)
        readyScopes.remove(callId)?.cancel()
    }

    suspend fun answer(callId: String): Boolean {
        val control = scopes[callId] ?: withTimeoutOrNull(5_000) {
            readyScopes[callId]?.await()
        } ?: return false
        if (!onAnswer(callId)) return false
        control.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL)
        onAnswered(callId)
        return true
    }

    suspend fun disconnect(callId: String, notifyServer: Boolean, cause: Int = DisconnectCause.LOCAL) {
        val (code, label) = transactionalDisconnectCode(cause)
        scopes.remove(callId)?.disconnect(DisconnectCause(code, label, null, label))
        if (notifyServer) onDisconnect(callId)
    }
}

private object ActiveCallServices {
    private val calls = ConcurrentHashMap.newKeySet<String>()
    fun add(callId: String) { calls += callId }
    fun remove(callId: String) { calls -= callId }
    fun contains(callId: String) = callId in calls
    fun removeAll(callIds: Collection<String>) { calls.removeAll(callIds.toSet()) }
}

/**
 * Calls whose server state [OngoingCallService] is already polling (`reconcileRingingUntilSettled`,
 * 5 s while ringing and 15 s once ongoing). Membership in [ActiveCallServices] is not the same
 * thing — every service action joins that set, including a media connect nobody polls for — so the
 * S20 D5 page loop consults this narrower registry to avoid duplicating requests for the same call.
 */
internal object ReconcilingCalls {
    private val calls = ConcurrentHashMap.newKeySet<String>()
    fun add(callId: String) { calls += callId }
    fun remove(callId: String) { calls -= callId }
    fun snapshot(): Set<String> = calls.toSet()
}

private data class IncomingCallDisplay(val title: String, val subtitle: String)

/**
 * S79: calls [OngoingCallService] still holds a token for but nothing owns any more — no ringing /
 * authority poll, no media connect in flight, and not the runtime's live (or grace-held FAILED)
 * media call. A server-side end reaches only the runtime, so these would otherwise keep the
 * foreground service and its "in call" notification alive forever.
 */
internal fun orphanedServiceCalls(
    tracked: Set<String>,
    polled: Set<String>,
    connecting: Set<String>,
    media: CallMediaUiState,
): Set<String> = tracked - polled - connecting -
    setOfNotNull(media.callId?.takeIf { media.phase != CallMediaPhase.IDLE })

class OngoingCallService : Service() {
    // An uncaught throw in any call job must leave a trace and not take the whole process down.
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
            ClientDiag.log(
                "service.error",
                mapOf(
                    "thread" to Thread.currentThread().name,
                    "type" to error.javaClass.name,
                    "message" to (error.message ?: "").take(200),
                    "stack" to error.stackTraceToString().take(3000),
                ),
                level = "error",
            )
        },
    )
    private lateinit var telecom: AndroidTelecomCalls
    private val claimInFlight = ConcurrentHashMap.newKeySet<String>()
    private val endInFlight = ConcurrentHashMap.newKeySet<String>()
    private val actionTokens = ConcurrentHashMap<String, String>()
    private val callIdentities = ConcurrentHashMap<String, ServiceSessionIdentity>()
    private val callSnapshots = ConcurrentHashMap<String, SessionSnapshot>()
    private val telecomJobs = ConcurrentHashMap<String, Job>()
    private val authorityJobs = ConcurrentHashMap<String, Job>()
    private val callDisplays = ConcurrentHashMap<String, IncomingCallDisplay>()
    private val callPushNames = ConcurrentHashMap<String, String>()
    private val callPeerLabels = ConcurrentHashMap<String, String>()
    private val internalCalls = ConcurrentHashMap.newKeySet<String>()
    /** S72 D3: 手机在系统通话中收到的来电——静音通知、不全屏，已向 Control 报 owner-busy。 */
    private val quietCalls = ConcurrentHashMap.newKeySet<String>()
    private lateinit var sessionListener: Closeable
    @Volatile private var mediaCallId: String? = null
    /** ACTION_CONNECT between onStartCommand and its outcome: tracked, but the runtime does not own it yet. */
    private val connectInFlight = ConcurrentHashMap.newKeySet<String>()
    /** Expected main thread (stopCall callers run on [scope] or onStartCommand); a re-entrancy guard, not a lock. */
    private var sweeping = false

    override fun onCreate() {
        super.onCreate()
        ClientDiag.attach(this)
        createCallChannel(this)
        telecom = AndroidTelecomCalls(this, ::claim, ::connectAfterClaim, ::endOwnedAndStop)
        sessionListener = ClientSessionProcess.listen {
            scope.launch { stopCallsFromReplacedSession() }
        }
        scope.launch { ClientCallRuntime.state.collect { stopOrphanedCalls() } }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: return START_NOT_STICKY
        val callId = intent.getStringExtra(EXTRA_CALL_ID)?.validUuid() ?: return START_NOT_STICKY
        val suppliedToken = intent.getStringExtra(EXTRA_ACTION_TOKEN)
        val identity = currentServiceIdentity(this)
        if (identity == null || !validStart(action, callId, suppliedToken, identity)) {
            if (actionTokens.isEmpty()) stopRejectedStart(callId, startId)
            return START_NOT_STICKY
        }
        val token = actionTokens[callId] ?: suppliedToken?.validUuid()?.also {
            actionTokens[callId] = it
        }
        if (token == null) {
            // Nothing to authorise a notification with; bail instead of crashing the service.
            if (actionTokens.isEmpty()) stopRejectedStart(callId, startId)
            return START_NOT_STICKY
        }
        // S21 §A / S36 C1: the push may already know who is calling, so the very first notification
        // can carry the number and the name in the same `号码 · 姓名 来电` shape `verifyIncoming`
        // refines from the call DTO a moment later.
        val pushAtMillis = intent.getLongExtra(EXTRA_PUSH_AT, 0L)
        val pushName = intent.getStringExtra(EXTRA_CONTACT_NAME)?.trim()?.takeIf(String::isNotEmpty)
        val pushNumber = intent.getStringExtra(EXTRA_REMOTE_NUMBER)?.trim()?.takeIf(String::isNotEmpty)
        pushName?.let { callPushNames[callId] = it }
        val pushInternal = intent.getBooleanExtra(EXTRA_INTERNAL, false)
        val pushPeer = intent.getStringExtra(EXTRA_PEER_SIM_LABEL)
        if (pushInternal) internalCalls += callId
        pushPeer?.let { callPeerLabels[callId] = it }
        if (action == ACTION_RING && intent.getBooleanExtra(EXTRA_OWNER_BUSY, false)) quietCalls += callId
        incomingCallTitle(pushNumber, pushName, pushInternal, pushPeer)?.let { title ->
            callDisplays.putIfAbsent(
                callId,
                IncomingCallDisplay(title, if (callId in quietCalls) "你正在通话中，这通来电不响铃" else "正在核验来电"),
            )
        }
        callIdentities.putIfAbsent(callId, identity)
        callSnapshots.putIfAbsent(callId, ClientSessionProcess.coordinator(this).snapshot())
        ActiveCallServices.add(callId)
        startForeground(notificationId(callId), notification(callId, token, action == ACTION_RING))
        when (action) {
            ACTION_RING -> if (telecomJobs[callId]?.isActive != true) {
                if (callId in quietCalls) reportOwnerBusy(callId)
                telecomJobs[callId] = scope.launch {
                    // null = Control unreachable: ring on the push display, reconcileRingingLoop verifies.
                    if (verifyIncoming(callId) == false) return@launch stopCall(callId)
                    authorityJobs[callId] = scope.launch { reconcileRingingUntilSettled(callId) }
                    runCatching {
                        telecom.addIncoming(callId, callDisplays[callId]?.title ?: "VoDog 来电")
                    }.onSuccess {
                        // S36 C3: 推送到达 → 系统来电界面出现，这一段是「响铃慢/不响」的唯一量尺。
                        ClientDiag.log(
                            "telecom.added",
                            mapOf("ms" to (System.currentTimeMillis() - pushAtMillis).takeIf { pushAtMillis > 0 }),
                            callId = callId,
                        )
                    }.onFailure {
                        // S36b D1: 系统来电界面没拉起来是「不响铃」的根因，异常本身必须留痕。
                        // S72b: stopCall 取消本作业是正常收尾，不是故障。
                        if (it !is kotlinx.coroutines.CancellationException) ClientDiag.appError("telecom.addIncoming", it, callId = callId)
                        stopCall(callId)
                    }
                }
            }
            ACTION_ANSWER -> scope.launch {
                if (!validateAction(callId, suppliedToken)) return@launch stopCall(callId)
                val answered = runCatching { telecom.answer(callId) }
                    .onFailure { ClientDiag.appError("telecom.answer", it, callId = callId) }
                    .getOrDefault(false)
                if (answered) {
                    updateNotification(callId, token, false)
                } else {
                    endOwnedAndStop(callId)
                }
            }
            ACTION_DECLINE -> scope.launch {
                if (validateAction(callId, suppliedToken)) rejectRingingAndStop(callId)
                else stopCall(callId)
            }
            ACTION_END -> scope.launch {
                if (validateAction(callId, suppliedToken)) telecom.disconnect(callId, notifyServer = true)
                else stopCall(callId)
            }
            ACTION_CONNECT -> {
                connectInFlight += callId
                scope.launch {
                    try {
                        val transport = runCatching {
                            CallMediaTransport.valueOf(intent.getStringExtra(EXTRA_TRANSPORT).orEmpty())
                        }.getOrDefault(CallMediaTransport.UDP)
                        applyMediaOutcome(
                            callId,
                            token,
                            ClientCallRuntime.connect(this@OngoingCallService, callId, transport),
                        )
                    } finally {
                        connectInFlight -= callId
                    }
                }
            }
            ACTION_AUTO_END -> scope.launch { telecom.disconnect(callId, notifyServer = true) }
            ACTION_CANCEL_RINGING -> scope.launch { reconcileCancellation(callId) }
            ACTION_SPEAKER -> if (mediaCallId == callId) {
                ClientCallRuntime.speaker(intent.getBooleanExtra(EXTRA_SPEAKER, false))
            }
            ACTION_MUTE -> if (mediaCallId == callId) {
                ClientCallRuntime.mute(intent.getBooleanExtra(EXTRA_MUTED, false))
            }
            ACTION_STOP_MEDIA -> if (mediaCallId == callId || ClientCallRuntime.owns(callId)) stopCall(callId)
        }
        return START_REDELIVER_INTENT
    }

    /**
     * S79: every start is a startForegroundService, so a rejected one (e.g. a STOP_MEDIA whose call
     * the orphan sweep already stopped) must still call startForeground before stopping, or Android
     * 9+ crashes the process with SERVICE_FOREGROUND_CRASH.
     */
    private fun stopRejectedStart(callId: String, startId: Int) {
        startForeground(
            notificationId(callId),
            NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("VoDog")
                .setSilent(true)
                .build(),
        )
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
    }

    private fun validStart(
        action: String,
        callId: String,
        suppliedToken: String?,
        identity: ServiceSessionIdentity,
    ): Boolean {
        val installed = callIdentities[callId]
        if (installed != null && installed.generation != identity.generation) return false
        val exactTokenRecord = when (action) {
            ACTION_RING, ACTION_ANSWER, ACTION_DECLINE, ACTION_END, ACTION_CONNECT -> {
                val token = suppliedToken?.validUuid() ?: return false
                val journalMatch = runCatching {
                    IncomingCallStore(this).action(
                        callId,
                        token,
                        identity.username,
                        identity.generation,
                    ) != null
                }.getOrDefault(false)
                val residentMatch = actionTokens[callId] == token &&
                    installed?.generation == identity.generation && ActiveCallServices.contains(callId)
                journalMatch || residentMatch
            }
            else -> false
        }
        return serviceActionPermitted(
            action,
            exactTokenRecord,
            ActiveCallServices.contains(callId),
            ClientCallRuntime.owns(callId),
        )
    }

    private fun stopCallsFromReplacedSession() {
        val current = currentServiceIdentity(this)
        val currentSnapshot = ClientSessionProcess.coordinator(this).snapshot()
        callIdentities.entries
            .filter { (_, identity) -> !serviceIdentityMatches(identity, current) }
            .map(Map.Entry<String, ServiceSessionIdentity>::key)
            .forEach(::stopCall)
        callIdentities.entries
            .filter { (_, identity) -> serviceIdentityMatches(identity, current) }
            .forEach { (callId, _) -> callSnapshots[callId] = currentSnapshot }
    }

    private suspend fun claim(callId: String): Boolean {
        if (!claimInFlight.add(callId)) return false
        return try {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ||
                !canShowCallNotification(this)
            ) return false
            val sessions = ClientSessionProcess.coordinator(this)
            val expected = callSnapshots[callId] ?: return false
            expected.session ?: return false
            withContext(Dispatchers.IO) {
                val api = ClientApi(sessions)
                // Failures here throw into the `call.claim` diag below instead of hanging up silently.
                val detail = api.call(callId, expected)
                sessions.requireCurrent(expected)
                if (detail.optBoolean("claimedByCurrentSession")) return@withContext true.also {
                    ClientCallLiveness.publish(callId, ClientCallLivenessPhase.CLAIMED)
                }
                if (detail.optString("state") != "incoming_ringing") return@withContext false
                api.claimCall(callId, expected)
                runCatching { sessions.requireCurrent(expected) }.isSuccess.also { claimed ->
                    if (claimed) ClientCallLiveness.publish(callId, ClientCallLivenessPhase.CLAIMED)
                }
            }
        } catch (error: Exception) {
            ClientDiag.log(
                "call.claim",
                mapOf("ok" to false, "code" to (error as? ApiError)?.status, "error" to error.diagReason()),
                callId = callId,
                level = "warn",
            )
            false
        } finally { claimInFlight -= callId }
    }

    /** true = ringing, false = definitively not (stop), null = Control unreachable (ring anyway). */
    private suspend fun verifyIncoming(callId: String): Boolean? {
        val startedAt = System.nanoTime()
        fun failed(reason: String, error: String? = null): Boolean? {
            ClientDiag.log(
                "incoming.verify",
                mapOf("ms" to diagElapsedMs(startedAt), "ringing" to false, "reason" to reason, "error" to error),
                callId = callId,
                level = "warn",
            )
            return if (reason == "network") null else false
        }
        val sessions = ClientSessionProcess.coordinator(this)
        val expected = callSnapshots[callId] ?: return failed("session")
        expected.session ?: return failed("session")
        val detail = withContext(Dispatchers.IO) {
            runCatching { ClientApi(sessions).call(callId, expected) }
        }.getOrElse { return failed(incomingVerifyFailureReason(it), it.diagReason()) }
        if (runCatching { sessions.requireCurrent(expected) }.isFailure) return failed("session")
        val ringing = detail.optString("state") == "incoming_ringing"
        if (ringing) {
            showRingingDisplay(callId, detail)
            ClientCallLiveness.publish(callId, ClientCallLivenessPhase.RINGING)
        }
        ClientDiag.log(
            "incoming.verify",
            mapOf("ms" to diagElapsedMs(startedAt), "ringing" to ringing, "reason" to if (ringing) null else "not_ringing"),
            callId = callId,
            level = if (ringing) "info" else "warn",
        )
        return ringing
    }

    /**
     * 按通话 DTO 刷新响铃通知（号码 / 联系人 / S72 内部卡标签）。核验失败（4G 连不上）时推送载荷没有
     * `internal`，所以 [reconcileRingingLoop] 每轮拿到 DTO 也调一次，内部来电迟早显示成「Demo SIM B（内部） 来电」。
     */
    private fun showRingingDisplay(callId: String, detail: JSONObject) {
        val remote = detail.optString("remoteNumber").ifBlank { "号码未知" }
        val sim = detail.optJSONObject("sim")
        val simLabel = calledSimLabel(detail) ?: "SIM"
        val gateway = sim?.optString("gatewayId")?.takeIf(String::isNotBlank)?.let(detail.gatewayKind()::shortLabel)
        // The DTO's own contactName wins over the push hint; either way the title reads
        // "号码 · 姓名 来电" so the lock screen matches the in-app heading (§A/§F).
        val contactName = detail.optString("contactName").takeIf { it.isNotBlank() && it != "null" }
            ?: callPushNames[callId]
        val display = IncomingCallDisplay(
            incomingCallTitle(remote, contactName, detail.optBoolean("internal") || callId in internalCalls, detail.optString("peerSimLabel").takeIf { it.isNotBlank() && it != "null" } ?: callPeerLabels[callId])
                ?: "${numberWithContactName(remote, contactName)} 来电",
            listOfNotNull(simLabel, gateway).joinToString(" · "),
        )
        // 没变就不重发：响铃通知没有 onlyAlertOnce，每 5 s 重发会重复提醒。
        if (callDisplays.put(callId, display) != display) updateNotification(callId, actionTokens[callId], true)
    }

    private suspend fun reconcileRingingUntilSettled(callId: String) {
        ReconcilingCalls.add(callId)
        try {
            reconcileRingingLoop(callId)
        } finally {
            ReconcilingCalls.remove(callId)
        }
    }

    private suspend fun reconcileRingingLoop(callId: String) {
        var ringingChecks = 0
        var ongoing = false
        while (ActiveCallServices.contains(callId)) {
            delay(if (ongoing) ONGOING_RECONCILE_INTERVAL_MS else RINGING_RECONCILE_INTERVAL_MS)
            if (!ActiveCallServices.contains(callId)) return
            val identity = callIdentities[callId] ?: return stopCall(callId)
            val expected = callSnapshots[callId] ?: return stopCall(callId)
            if (!serviceIdentityMatches(identity, currentServiceIdentity(this))) return stopCall(callId)
            val detail = withContext(Dispatchers.IO) {
                runCatching {
                    ClientApi(ClientSessionProcess.coordinator(this@OngoingCallService)).call(callId, expected)
                }
                    .getOrNull()
            }
            if (detail == null) {
                if (!ongoing && ++ringingChecks >= RINGING_RECONCILE_ATTEMPTS) {
                    telecom.disconnect(callId, notifyServer = false, cause = DisconnectCause.MISSED)
                    stopCall(callId)
                    return
                }
                continue
            }
            val state = detail.optString("state")
            if (state == "incoming_ringing") {
                showRingingDisplay(callId, detail)
                if (++ringingChecks >= RINGING_RECONCILE_ATTEMPTS) {
                    telecom.disconnect(callId, notifyServer = false, cause = DisconnectCause.MISSED)
                    stopCall(callId)
                    return
                }
                continue
            }
            if (cancelledCallDisposition(detail.optBoolean("claimedByCurrentSession"), state) ==
                CancelledCallDisposition.KEEP_ONGOING
            ) {
                ongoing = true
                updateNotification(callId, actionTokens[callId], false)
                continue
            }
            telecom.disconnect(callId, notifyServer = false, cause = ringingEndedDisconnectCause(detail))
            return stopCall(callId)
        }
    }

    private suspend fun connectAfterClaim(callId: String) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            // A denied microphone is a media failure like any other: the call is held for the
            // grace window with a retry choice instead of being hung up here.
            ClientCallRuntime.permissionDenied(this, callId, CallMediaTransport.UDP)
            mediaCallId = callId
            return updateNotification(callId, actionTokens[callId], false)
        }
        applyMediaOutcome(
            callId,
            actionTokens[callId],
            ClientCallRuntime.connect(this, callId, CallMediaTransport.UDP),
        )
    }

    /**
     * A terminally FAILED media handshake keeps the call and claims media ownership, so the retry
     * button, `ACTION_STOP_MEDIA` and the grace auto-end all still address this call; only a
     * rejected attempt (the call is no longer ours to connect) ends it here.
     */
    private suspend fun applyMediaOutcome(
        callId: String,
        token: String?,
        outcome: CallMediaConnectOutcome,
    ) {
        when (outcome) {
            CallMediaConnectOutcome.CONNECTED -> {
                mediaCallId = callId
                ClientCallLiveness.publish(callId, ClientCallLivenessPhase.MEDIA_ACTIVE)
                updateNotification(callId, token, false)
            }
            CallMediaConnectOutcome.FAILED -> {
                mediaCallId = callId
                updateNotification(callId, token, false)
            }
            CallMediaConnectOutcome.REJECTED -> endOwnedAndStop(callId)
        }
    }

    private suspend fun rejectRingingAndStop(callId: String) {
        val identity = callIdentities[callId] ?: return stopCall(callId)
        val expected = callSnapshots[callId] ?: return stopCall(callId)
        val current = currentServiceIdentity(this)
        if (!serviceIdentityMatches(identity, current)) return stopCall(callId)
        withContext(Dispatchers.IO) {
            val api = ClientApi(ClientSessionProcess.coordinator(this@OngoingCallService))
            val detail = runCatching { api.call(callId, expected) }.getOrNull()
            if (detail?.optString("state") == "incoming_ringing" &&
                serviceIdentityMatches(identity, currentServiceIdentity(this@OngoingCallService))
            ) runCatching { api.endCall(callId, onlyIfRinging = true, requiredSession = expected) }
        }
        telecom.disconnect(callId, notifyServer = false, cause = DisconnectCause.REJECTED)
        stopCall(callId)
    }

    private suspend fun endOwnedAndStop(callId: String) {
        val identity = callIdentities[callId] ?: return stopCall(callId)
        val expected = callSnapshots[callId] ?: return stopCall(callId)
        if (!endInFlight.add(callId)) return
        try {
            val current = currentServiceIdentity(this)
            if (serviceIdentityMatches(identity, current)) {
                withContext(Dispatchers.IO) {
                    if (serviceIdentityMatches(identity, currentServiceIdentity(this@OngoingCallService))) {
                        runCatching {
                            ClientApi(ClientSessionProcess.coordinator(this@OngoingCallService))
                                .endCall(callId, onlyIfCurrentSessionOwner = true, requiredSession = expected)
                        }
                    }
                }
            }
        } finally {
            stopCall(callId)
        }
    }

    private suspend fun reconcileCancellation(callId: String) {
        val sessions = ClientSessionProcess.coordinator(this)
        val expected = callSnapshots[callId] ?: return stopCall(callId)
        val detail = withContext(Dispatchers.IO) {
            runCatching { ClientApi(sessions).call(callId, expected) }.getOrNull()
        }
        if (runCatching { sessions.requireCurrent(expected) }.isFailure) return stopCall(callId)
        val disposition = detail?.let {
            cancelledCallDisposition(it.optBoolean("claimedByCurrentSession"), it.optString("state"))
        } ?: CancelledCallDisposition.END_LOCAL
        if (disposition == CancelledCallDisposition.KEEP_ONGOING) {
            updateNotification(callId, actionTokens[callId], false)
        } else {
            telecom.disconnect(callId, notifyServer = false, cause = ringingEndedDisconnectCause(detail))
            stopCall(callId)
        }
    }

    private fun validateAction(callId: String, token: String?): Boolean {
        if (token == null || actionTokens[callId] != token) return false
        val session = ClientSessionProcess.coordinator(this).snapshot().session ?: return false
        val generation = ClientSessionProcess.generation(this) ?: return false
        return runCatching {
            IncomingCallStore(this).action(callId, token, session.username, generation) != null
        }
            .getOrDefault(false) || mediaCallId == callId
    }

    private fun notification(callId: String, token: String, ringing: Boolean): Notification {
        val content = PendingIntent.getActivity(
            this,
            callId.hashCode(),
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            immutable(),
        )
        val display = callDisplays[callId]
        val person = androidx.core.app.Person.Builder()
            .setName(display?.title ?: "VoDog 来电")
            .setImportant(true)
            .build()
        val quiet = ringing && callId in quietCalls
        val builder = NotificationCompat.Builder(this, if (quiet) QUIET_CHANNEL else CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(if (ringing) display?.title ?: "VoDog 来电" else display?.title ?: "VoDog 通话")
            .setContentText(if (ringing) display?.subtitle ?: "正在核验来电" else "${display?.subtitle.orEmpty()} · 通话正在进行".trimStart(' ', '·'))
            .setContentIntent(content)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(this, CHANNEL)
                    .setSmallIcon(R.drawable.ic_launcher_foreground)
                    .setContentTitle("VoDog 来电")
                    .setContentText("解锁后查看来电号码")
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .build(),
            )
            .setOngoing(!ringing)
        val canFullScreen = Build.VERSION.SDK_INT < 34 ||
            getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
        if (ringing && !quiet && canFullScreen) builder.setFullScreenIntent(content, true)
        builder.setStyle(
            if (ringing) NotificationCompat.CallStyle.forIncomingCall(
                person,
                actionIntent(ACTION_DECLINE, callId, token),
                actionIntent(ACTION_ANSWER, callId, token),
            ) else NotificationCompat.CallStyle.forOngoingCall(
                person,
                actionIntent(ACTION_END, callId, token),
            ),
        )
        return builder.build()
    }

    private fun actionIntent(action: String, callId: String, token: String): PendingIntent =
        PendingIntent.getBroadcast(
            this,
            (action + callId).hashCode(),
            Intent(this, CallActionReceiver::class.java)
                .setAction(action)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_ACTION_TOKEN, token),
            immutable(),
        )

    @SuppressLint("MissingPermission")
    private fun updateNotification(callId: String, token: String?, ringing: Boolean) {
        token ?: return
        if (canShowCallNotification(this)) {
            runCatching {
                NotificationManagerCompat.from(this).notify(
                    notificationId(callId),
                    notification(callId, token, ringing),
                )
            }
        }
    }

    /**
     * S72 D3（同 iOS `reportOwnerBusy`）：尽力而为、静默，最多 5 次、间隔 2 s；Control 回了任何 HTTP 答复
     * （含旧 Control 的 404）都算答复，只有没到达 Control 的失败才重试。
     */
    private fun reportOwnerBusy(callId: String) = scope.launch {
        for (attempt in 0 until OWNER_BUSY_ATTEMPTS) {
            if (attempt > 0) delay(OWNER_BUSY_RETRY_MS)
            if (!ActiveCallServices.contains(callId)) return@launch
            val expected = callSnapshots[callId] ?: return@launch
            val result = withContext(Dispatchers.IO) {
                runCatching { ClientApi(ClientSessionProcess.coordinator(this@OngoingCallService)).ownerBusy(callId, expected) }
            }
            val error = result.exceptionOrNull()
            if (error is SessionChangedException) return@launch
            if (error == null || error is ApiError) {
                ClientDiag.log(
                    "call.owner_busy",
                    mapOf("reported" to true, "aiScheduled" to result.getOrNull()?.opt("aiScheduled"), "attempts" to attempt + 1),
                    callId = callId,
                )
                return@launch
            }
        }
        ClientDiag.log("call.owner_busy", mapOf("reported" to false, "attempts" to OWNER_BUSY_ATTEMPTS), callId = callId, level = "warn")
    }

    private fun stopCall(callId: String) {
        runCatching { IncomingCallStore(this).remove(callId) }
        telecomJobs.remove(callId)?.cancel()
        authorityJobs.remove(callId)?.cancel()
        ReconcilingCalls.remove(callId)
        actionTokens -= callId
        callIdentities -= callId
        callSnapshots -= callId
        callDisplays -= callId
        callPushNames -= callId
        callPeerLabels -= callId
        internalCalls -= callId
        quietCalls -= callId
        ActiveCallServices.remove(callId)
        ClientCallLiveness.publish(callId, ClientCallLivenessPhase.ENDED)
        NotificationManagerCompat.from(this).cancel(notificationId(callId))
        if (mediaCallId == callId || ClientCallRuntime.owns(callId)) {
            ClientCallRuntime.stop()
            mediaCallId = null
        }
        stopOrphanedCalls()
        if (actionTokens.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    /**
     * S79: ends every [orphanedServiceCalls] entry. Runs on each runtime state change and from
     * [stopCall]; the orphan's [mediaCallId] is cleared first so its [stopCall] cannot stop the
     * runtime that now belongs to another call, and [sweeping] keeps the nested stopCall from
     * re-entering.
     */
    private fun stopOrphanedCalls() {
        if (sweeping) return
        sweeping = true
        try {
            val polled = (telecomJobs.entries + authorityJobs.entries).filter { it.value.isActive }.map { it.key }.toSet()
            orphanedServiceCalls(actionTokens.keys.toSet(), polled, connectInFlight.toSet(), ClientCallRuntime.state.value)
                .forEach { orphan ->
                    ClientDiag.log("service.orphan_stopped", callId = orphan, level = "warn")
                    if (mediaCallId == orphan) mediaCallId = null
                    stopCall(orphan)
                }
        } finally {
            sweeping = false
        }
    }

    /**
     * The call foreground service outlives the plain [OutboundCallReleaseService] in the background,
     * so it releases pending dials too when the task is swiped away (S20 D5). The registry is
     * process-global and cleared on release, so both services firing is a no-op, not a double end.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        OutboundCallReleaseService.releasePendingOutboundCalls(this, OccupancyReleaseTrigger.TASK_REMOVED)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        // 通话前台服务停止是进程最可能被回收的时刻，先把攒下的诊断发出去。
        ClientDiag.flush()
        telecomJobs.values.forEach(Job::cancel)
        authorityJobs.values.forEach(Job::cancel)
        sessionListener.close()
        ActiveCallServices.removeAll(actionTokens.keys)
        actionTokens.keys.forEach(ReconcilingCalls::remove)
        ClientCallRuntime.stop()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_RING = "org.vodog.RING"
        const val ACTION_ANSWER = "org.vodog.ANSWER"
        const val ACTION_DECLINE = "org.vodog.DECLINE"
        const val ACTION_END = "org.vodog.END"
        const val ACTION_CONNECT = "org.vodog.CONNECT_MEDIA"
        const val ACTION_STOP_MEDIA = "org.vodog.STOP_MEDIA"
        const val ACTION_AUTO_END = "org.vodog.AUTO_END"
        const val ACTION_SPEAKER = "org.vodog.SPEAKER"
        const val ACTION_MUTE = "org.vodog.MUTE"
        const val ACTION_CANCEL_RINGING = "org.vodog.CANCEL_RINGING"
        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_ACTION_TOKEN = "action_token"
        const val EXTRA_TRANSPORT = "transport"
        const val EXTRA_SPEAKER = "speaker"
        const val EXTRA_MUTED = "muted"
        const val EXTRA_CONTACT_NAME = "contact_name"
        const val EXTRA_REMOTE_NUMBER = "remote_number"
        const val EXTRA_PUSH_AT = "push_at"
        const val EXTRA_INTERNAL = "internal"
        const val EXTRA_PEER_SIM_LABEL = "peer_sim_label"
        const val EXTRA_OWNER_BUSY = "owner_busy"
        const val CHANNEL = "vodog_calls"
        const val QUIET_CHANNEL = "vodog_calls_quiet"
        private const val OWNER_BUSY_ATTEMPTS = 5
        private const val OWNER_BUSY_RETRY_MS = 2_000L
        private const val RINGING_RECONCILE_INTERVAL_MS = 5_000L
        private const val ONGOING_RECONCILE_INTERVAL_MS = 15_000L
        private const val RINGING_RECONCILE_ATTEMPTS = 24
        val NON_TERMINAL = setOf("incoming_ringing", "outgoing_pending", "connecting", "active", "ending", "unknown")

        fun ring(
            context: Context,
            callId: String,
            token: String,
            contactName: String? = null,
            remoteNumber: String? = null,
            pushAtMillis: Long = 0L,
            internal: Boolean = false,
            peerSimLabel: String? = null,
            ownerBusy: Boolean = false,
        ) = start(
            context,
            ACTION_RING,
            callId,
            token,
            Intent().apply {
                contactName?.let { putExtra(EXTRA_CONTACT_NAME, it) }
                remoteNumber?.let { putExtra(EXTRA_REMOTE_NUMBER, it) }
                if (pushAtMillis > 0) putExtra(EXTRA_PUSH_AT, pushAtMillis)
                if (internal) putExtra(EXTRA_INTERNAL, true)
                peerSimLabel?.let { putExtra(EXTRA_PEER_SIM_LABEL, it) }
                if (ownerBusy) putExtra(EXTRA_OWNER_BUSY, true)
            }.takeIf { it.extras != null },
        )

        fun cancelRinging(context: Context, callId: String) {
            NotificationManagerCompat.from(context).cancel(notificationId(callId))
            if (ActiveCallServices.contains(callId)) start(context, ACTION_CANCEL_RINGING, callId, null)
            else runCatching { IncomingCallStore(context).remove(callId) }
        }

        fun connect(context: Context, callId: String, transport: CallMediaTransport) {
            val identity = currentServiceIdentity(context) ?: return ClientDiag.log(
                "media.connect_skipped", mapOf("reason" to "no_identity"), callId = callId, level = "warn",
            )
            val record = runCatching {
                IncomingCallStore(context).authorize(callId, identity.username, identity.generation)
            }.getOrElse { error ->
                return ClientDiag.log(
                    "media.connect_skipped", mapOf("reason" to error.diagReason()), callId = callId, level = "warn",
                )
            }
            start(
                context,
                ACTION_CONNECT,
                callId,
                record.actionToken,
                Intent().putExtra(EXTRA_TRANSPORT, transport.name),
            )
        }

        fun stopMedia(context: Context, callId: String) =
            startOwnedMediaAction(context, ACTION_STOP_MEDIA, callId)

        /**
         * Ends a call the process still owns the media for, from the media grace timer and without
         * a ViewModel. It routes through the same `telecom.disconnect(notifyServer = true)` the
         * notification's "end" action uses, which reaches `endOwnedAndStop` and therefore the
         * guarded `endCall(onlyIfCurrentSessionOwner = true, requiredSession = …)` POST.
         */
        fun autoEnd(context: Context, callId: String) =
            startOwnedMediaAction(context, ACTION_AUTO_END, callId)

        /**
         * Mints (or reuses) the journal action token the way [connect] does, because a media failure
         * raised in the foreground — a denied microphone, say — never passed through this service,
         * so there is no resident token to build the notification from.
         */
        private fun startOwnedMediaAction(context: Context, action: String, callId: String) {
            if (!ClientCallRuntime.owns(callId)) return
            val identity = currentServiceIdentity(context) ?: return
            val record = runCatching {
                IncomingCallStore(context).authorize(callId, identity.username, identity.generation)
            }.getOrNull() ?: return
            start(context, action, callId, record.actionToken)
        }

        fun speaker(context: Context, callId: String, enabled: Boolean) {
            if (ClientCallRuntime.owns(callId)) start(
                context,
                ACTION_SPEAKER,
                callId,
                null,
                Intent().putExtra(EXTRA_SPEAKER, enabled),
            )
        }

        fun mute(context: Context, callId: String, muted: Boolean) {
            if (ClientCallRuntime.owns(callId)) start(
                context,
                ACTION_MUTE,
                callId,
                null,
                Intent().putExtra(EXTRA_MUTED, muted),
            )
        }

        fun stopAll(context: Context) {
            ClientCallRuntime.stop()
            runCatching { IncomingCallStore(context).clear() }
            NotificationManagerCompat.from(context).cancelAll()
            context.stopService(Intent(context, OngoingCallService::class.java))
        }

        private fun start(
            context: Context,
            action: String,
            callId: String,
            token: String?,
            extras: Intent? = null,
        ) {
            val intent = Intent(context, OngoingCallService::class.java)
                .setAction(action)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_ACTION_TOKEN, token)
            extras?.extras?.let(intent::putExtras)
            ContextCompat.startForegroundService(context, intent)
        }

        private fun notificationId(callId: String) = 4300 + (callId.hashCode() and 0x0fff)
    }
}

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val callId = intent.getStringExtra(OngoingCallService.EXTRA_CALL_ID)?.validUuid() ?: return
        val token = intent.getStringExtra(OngoingCallService.EXTRA_ACTION_TOKEN)?.validUuid() ?: return
        val action = intent.action?.takeIf {
            it in setOf(
                OngoingCallService.ACTION_ANSWER,
                OngoingCallService.ACTION_DECLINE,
                OngoingCallService.ACTION_END,
            )
        } ?: return
        ContextCompat.startForegroundService(
            context,
            Intent(context, OngoingCallService::class.java)
                .setAction(action)
                .putExtra(OngoingCallService.EXTRA_CALL_ID, callId)
                .putExtra(OngoingCallService.EXTRA_ACTION_TOKEN, token),
        )
    }
}

internal fun canShowCallNotification(context: Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED)

private fun createCallChannel(context: Context) {
    val channel = NotificationChannel(
        OngoingCallService.CHANNEL,
        "来电和通话",
        NotificationManager.IMPORTANCE_HIGH,
    ).apply {
        enableVibration(true)
        setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build(),
        )
    }
    // S72 D3: 系统通话中来的来电走这个频道——只在通知栏出现，不响、不震、不全屏。频道重要性建后不可改，所以单独一个。
    val quiet = NotificationChannel(OngoingCallService.QUIET_CHANNEL, "通话中的来电", NotificationManager.IMPORTANCE_LOW)
    context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(channel, quiet))
}

/**
 * S72 D3: 手机是否已在系统通话（蜂窝或任何 VoIP，含本 App 自己的通话——与 iOS 一致）。有 READ_PHONE_STATE
 * 用 `TelecomManager.isInCall`，没有就看音频模式。
 * ponytail: isInCall 也把本 App 另一通「仍在响」的来电算作忙；两通来电同时响极少，需要时再按 mediaCallId 细分。
 */
internal fun deviceInCall(context: Context): Boolean {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
        runCatching { context.getSystemService(TelecomManager::class.java)?.isInCall }.getOrNull()?.let { return it }
    }
    return audioModeInCall(context.getSystemService(AudioManager::class.java)?.mode ?: AudioManager.MODE_NORMAL)
}

internal fun audioModeInCall(mode: Int): Boolean = mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION

/**
 * S72 A4: 响铃被别端接走（Control 已 connecting/active，或已结束但有人接过）→ 系统通话记录记「已在其他设备接听」；
 * 对方挂断 / 超时 / 查不到详情仍是 CANCELED。本会话自己接的通话不走这里的「别处」。
 */
internal fun ringingEndedDisconnectCause(detail: JSONObject?): Int {
    detail ?: return DisconnectCause.CANCELED
    if (detail.optBoolean("claimedByCurrentSession")) return DisconnectCause.CANCELED
    val answered = detail.optString("state") in setOf("connecting", "active", "ending") ||
        detail.optString("answeredAt").let { it.isNotBlank() && it != "null" } ||
        detail.optString("answeredByPlatform").let { it.isNotBlank() && it != "null" }
    return if (answered) DisconnectCause.ANSWERED_ELSEWHERE else DisconnectCause.CANCELED
}

/**
 * S72b: Core-Telecom 的 `CallControlScope.disconnect` 只收 LOCAL / REMOTE / MISSED / REJECTED，
 * 其余代码（ANSWERED_ELSEWHERE=11、CANCELED=4）直接抛 IllegalArgumentException，整条响铃作业崩。
 * 别处接听 → REMOTE 带「已在其他设备接听」标签；对方取消 → MISSED；其他一律 LOCAL。
 */
internal fun transactionalDisconnectCode(cause: Int): Pair<Int, String?> = when (cause) {
    DisconnectCause.LOCAL, DisconnectCause.REMOTE, DisconnectCause.MISSED, DisconnectCause.REJECTED -> cause to null
    DisconnectCause.ANSWERED_ELSEWHERE -> DisconnectCause.REMOTE to "已在其他设备接听"
    DisconnectCause.CANCELED -> DisconnectCause.MISSED to null
    else -> DisconnectCause.LOCAL to null
}

private fun immutable() = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
private fun String.validUuid(): String? = runCatching { UUID.fromString(this).toString() }.getOrNull()
