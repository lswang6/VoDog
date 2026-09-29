package org.vodog

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * S20 D5 — the Android half of the iOS `OccupancyReleasePolicy`, deliberately narrower: only an
 * outbound call this session dialed and that nobody has answered yet is released, and only when the
 * task is removed (swipe-away) or the process is torn down with it.
 *
 * Backgrounding must never release: switching apps for a moment while the Pixel is still ringing the
 * far end is normal use, and hanging up there would be a regression, not a fix.
 */
internal enum class OccupancyReleaseTrigger { APP_BACKGROUNDED, TASK_REMOVED }

internal object OccupancyReleasePolicy {
    /** Answered or finished: the gateway lock is no longer "ours to abandon". */
    internal val SETTLED_STATES = setOf("active", "ended", "failed")

    fun shouldRelease(trigger: OccupancyReleaseTrigger): Boolean =
        trigger == OccupancyReleaseTrigger.TASK_REMOVED

    /**
     * The id to register after `POST /calls/outbound` returns. The envelope is `{ call: { … } }`;
     * an idempotent replay of an already settled call is not registered.
     */
    fun registrableOutboundId(response: JSONObject): String? {
        val call = response.optJSONObject("call") ?: return null
        val id = call.optString("id").takeIf(String::isNotBlank) ?: return null
        val state = call.optString("state")
        if (state.isNotBlank() && state in SETTLED_STATES) return null
        return id
    }

    /** A registration ends at answer (`active`, or media connected here) or at any terminal state. */
    fun shouldForget(state: String?, mediaConnected: Boolean): Boolean =
        mediaConnected || (state != null && state in SETTLED_STATES)

    /**
     * Prunes the registry against a freshly loaded call list. Ids the list does not mention are kept:
     * a dial that was just submitted may not be listed yet, and forgetting it would lose the release.
     */
    fun retainedIds(
        registered: Set<String>,
        calls: List<JSONObject>,
        connectedMediaCallId: String?,
    ): Set<String> = registered.filterNot { id ->
        val state = calls.firstOrNull { it.optString("id") == id }?.optString("state")
        shouldForget(state?.takeIf(String::isNotBlank), mediaConnected = connectedMediaCallId == id)
    }.toSet()
}

/** Process-wide registry of unanswered outbound calls this session dialed. */
internal object SelfManagedOutboundCalls {
    private val ids = ConcurrentHashMap.newKeySet<String>()

    fun register(callId: String) { if (callId.isNotBlank()) ids += callId }
    fun forget(callId: String) { ids -= callId }
    fun snapshot(): Set<String> = ids.toSet()
    fun clear() = ids.clear()

    fun retain(retained: Set<String>) {
        ids.filterNot { it in retained }.forEach { ids -= it }
    }
}

/**
 * A plain (non-foreground) started service whose only job is to be alive when the user swipes the
 * task away, so [onTaskRemoved] can end an outbound call that never got answered. It is started when
 * the first such call is registered and stopped as soon as none are left, so it costs nothing while
 * idle.
 *
 * Known limitation: the platform stops a background started service some time after the app leaves
 * the foreground, so this covers "swipe the task away" and not "background for ten minutes, then
 * swipe". Escalating to a foreground service would add a second call notification, which S19's call
 * UI deliberately keeps single.
 */
class OutboundCallReleaseService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (SelfManagedOutboundCalls.snapshot().isEmpty()) stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        releasePendingOutboundCalls(this, OccupancyReleaseTrigger.TASK_REMOVED)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    companion object {
        /** Best-effort window for the end POST before the process is reclaimed. */
        private const val RELEASE_TIMEOUT_MS = 3_000L

        /** Guards the stop path so an idle app never issues a `stopService` it does not need. */
        @Volatile private var started = false

        fun track(context: Context, callId: String) {
            if (callId.isBlank()) return
            SelfManagedOutboundCalls.register(callId)
            runCatching {
                context.applicationContext.startService(
                    Intent(context.applicationContext, OutboundCallReleaseService::class.java),
                )
                started = true
            }
        }

        fun forget(context: Context, callId: String) {
            SelfManagedOutboundCalls.forget(callId)
            stopIfIdle(context)
        }

        fun retain(context: Context, retained: Set<String>) {
            SelfManagedOutboundCalls.retain(retained)
            stopIfIdle(context)
        }

        fun clear(context: Context) {
            SelfManagedOutboundCalls.clear()
            stopIfIdle(context)
        }

        private fun stopIfIdle(context: Context) {
            if (!started || SelfManagedOutboundCalls.snapshot().isNotEmpty()) return
            started = false
            runCatching {
                context.applicationContext.stopService(
                    Intent(context.applicationContext, OutboundCallReleaseService::class.java),
                )
            }
        }

        /**
         * Ends every registered call through the same guarded `POST /calls/{id}/end` the UI uses
         * (`onlyIfCurrentSessionOwner`), off the main thread but joined briefly so the request has a
         * real chance to leave the device before the process goes away.
         */
        internal fun releasePendingOutboundCalls(context: Context, trigger: OccupancyReleaseTrigger) {
            val ids = SelfManagedOutboundCalls.snapshot()
            SelfManagedOutboundCalls.clear()
            started = false
            if (ids.isEmpty() || !OccupancyReleasePolicy.shouldRelease(trigger)) return
            val sessions = ClientSessionProcess.coordinator(context)
            val expected = sessions.snapshot()
            expected.session ?: return
            val api = ClientApi(sessions)
            val worker = Thread {
                ids.forEach { callId ->
                    runCatching {
                        api.endCall(
                            callId,
                            onlyIfCurrentSessionOwner = true,
                            requiredSession = expected,
                        )
                    }
                }
            }
            worker.isDaemon = true
            worker.start()
            runCatching { worker.join(RELEASE_TIMEOUT_MS) }
        }
    }
}
