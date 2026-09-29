package org.vodog.gateway

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant

/**
 * S21 §D — the standby beacon.
 *
 * Runs only while `allowRemotePower && !runtime.enabled`. It is a **separate network owner** in the
 * S09 sense: its own [OwnedGatewayHttpTransport], its own socket factory, closed by this service and
 * by nobody else. The main gateway owner is never alive at the same time as a running beacon loop,
 * and turning the local switch off closes this owner entirely, which is what restores the
 * "OFF = zero outbound connections" rule from S02-S04 L27.
 *
 * The beacon carries no phone, SMS, media or SIM data: one `holdMs`, one boolean, and at most the
 * result of the previous power request.
 */
class GatewayStandbyService : Service() {
    private var scope = newScope()
    private var loopJob: Job? = null
    private var transport: GatewayHttpTransport? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // ACTION_STOP is always delivered with a plain startService(), so this instance carries no
        // foreground obligation and must not flash a "待命中" notification at the very moment the
        // user turned standby off.
        if (intent?.action == ACTION_STOP) {
            stopSafely()
            return START_NOT_STICKY
        }
        // Every other path arrives through startForegroundService(), whose obligation has to be
        // satisfied even by an instance that immediately stops again.
        runCatching { startForeground(NOTIFICATION_ID, notification()) }
        val runtime = GatewayRuntimeStore(this)
        val credential = DeviceCredentialVault(this).read()
        // A null intent is a sticky restart; the conditions are re-evaluated exactly the same way.
        // No credential means the beacon has nothing to authenticate with and must not run.
        if (!GatewayStandbyPolicy.plan(runtime.allowRemotePower, runtime.enabled, StandbyState()).run ||
            credential.isNullOrBlank()
        ) {
            stopSafely()
            return START_NOT_STICKY
        }
        if (loopJob?.isActive != true) {
            if (!scope.isActive) scope = newScope()
            // The loop about to be replaced holds the transport; it must not survive it.
            loopJob?.cancel()
            transport?.close()
            val owned = OwnedGatewayHttpTransport(
                readTimeoutSeconds = GatewayStandbyPolicy.READ_TIMEOUT_SECONDS,
            )
            transport = owned
            val ownedScope = scope
            loopJob = ownedScope.launch { standbyLoop(credential, owned, ownedScope, runtime) }
        }
        return START_STICKY
    }

    /**
     * One hanging request at a time. Cancellation cannot interrupt the blocking OkHttp call, so the
     * loop exits at the end of the current hold; [stopSafely] closes the transport, which cancels the
     * call and the socket immediately.
     */
    private suspend fun standbyLoop(
        token: String,
        transport: GatewayHttpTransport,
        ownedScope: CoroutineScope,
        runtime: GatewayRuntimeStore,
    ) {
        val api = GatewayApi(
            token = token,
            // Once enable() succeeds inside this loop the owner is finished: any further request must
            // refuse rather than keep a second connection alive next to the heartbeat.
            shouldContinue = { runtime.allowRemotePower && !runtime.enabled && ownedScope.isActive },
            transport = transport,
        )
        var state = StandbyState()
        try {
            while (ownedScope.isActive) {
                val plan = GatewayStandbyPolicy.plan(runtime.allowRemotePower, runtime.enabled, state)
                if (!plan.run) break
                if (plan.backoffMs > 0L) {
                    runtime.publishStandby(StandbyDisplayState.BACKOFF, plan.backoffMs)
                    delay(plan.backoffMs)
                    if (!ownedScope.isActive || !runtime.allowRemotePower || runtime.enabled) break
                }
                runtime.publishStandby(StandbyDisplayState.HOLDING)
                val carried = runtime.pendingPowerResult
                val result = try {
                    api.standby(
                        plan.holdMs,
                        remotePowerAllowed = true,
                        lastPowerResult = carried?.let { runCatching { JSONObject(it) }.getOrNull() },
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (!runtime.allowRemotePower || runtime.enabled || !ownedScope.isActive) break
                    state = GatewayStandbyPolicy.onFailure(state)
                    continue
                }
                // Accepted: the carried result reached the control service and may be forgotten.
                carried?.let { runtime.clearPowerResult(it) }
                state = GatewayStandbyPolicy.onSuccess()
                if (result.desiredPower != "on") continue
                val at = Instant.now().toString()
                val decision = runCatching { GatewayController(this).enable() }
                    .getOrElse { EnableDecision.Blocked(it.message?.take(120) ?: "网关开启失败") }
                // S36 C3: the only remote power transition this beacon can see. The events sit in the
                // ring until the foreground service attaches a transport on the next ON.
                GatewayDiag.log("power.standby", mapOf("desiredPower" to "on", "allowed" to (decision == EnableDecision.Allowed), "reason" to if (decision == EnableDecision.Allowed) null else remotePowerBlockedReason(decision)))
                if (decision == EnableDecision.Allowed) {
                    // The heartbeat carries this result from here on; enable() also stops this owner.
                    runtime.recordPowerResult(powerResultJson("on", ok = true, reason = null, at = at).toString())
                    break
                }
                // A gate failure (unpaired, missing permission) is reported so the remote user learns
                // why the gateway stayed off. The control service clears the request when it hands it
                // over, so this cannot become a hot loop.
                runtime.recordPowerResult(
                    powerResultJson("on", ok = false, reason = remotePowerBlockedReason(decision), at = at).toString(),
                )
            }
        } catch (_: CancellationException) {
            // The owner is shutting the loop down; the stop path clears the display.
        } finally {
            runCatching { runtime.publishStandby(StandbyDisplayState.DISABLED) }
        }
        // Reaching here means the conditions no longer hold. Never tear the service down from inside
        // its own coroutine scope: the stop runs on the main thread like every other lifecycle call.
        Handler(Looper.getMainLooper()).post { runCatching { stopSafely() } }
    }

    private fun stopSafely() {
        runCatching { GatewayRuntimeStore(this).publishStandby(StandbyDisplayState.DISABLED) }
        loopJob?.cancel()
        loopJob = null
        transport?.close()
        transport = null
        scope.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        runCatching { GatewayRuntimeStore(this).publishStandby(StandbyDisplayState.DISABLED) }
        loopJob?.cancel()
        loopJob = null
        transport?.close()
        transport = null
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "网关待命", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun notification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_phone_call)
        .setContentTitle("VoDog 网关待命")
        .setContentText(STANDBY_NOTIFICATION)
        .setOngoing(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                1,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        )
        .build()

    private fun newScope() = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        const val ACTION_START = "org.vodog.gateway.STANDBY_START"
        const val ACTION_STOP = "org.vodog.gateway.STANDBY_STOP"
        private const val CHANNEL_ID = "gateway_standby"
        private const val NOTIFICATION_ID = 702
        private const val STANDBY_NOTIFICATION = "网关待命中，可远程开启"
    }
}
