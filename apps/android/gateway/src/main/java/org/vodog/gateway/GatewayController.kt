package org.vodog.gateway

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean

class GatewayController(private val context: Context) {
    private val runtime = GatewayRuntimeStore(context)
    private val vault = DeviceCredentialVault(context)
    private val status = DeviceStatusReader(context)

    fun requirements() = EnableRequirements(
        paired = vault.hasCredential(),
        phonePermission = status.hasPhonePermission(),
        privilegedTelephony = status.hasPrivilegedTelephonyPermissions(),
        actionRuntimePermissions = status.hasActionRuntimePermissions(),
        notificationPermission = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
            context, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED,
    )

    fun enable(): EnableDecision {
        return synchronized(IDENTITY_STATE_LOCK) {
            if (IDENTITY_CHANGE_IN_PROGRESS.get()) {
                return@synchronized EnableDecision.Blocked("正在安全切换设备身份，请稍后重试")
            }
            val decision = GatewayEnablePolicy.evaluate(requirements())
            if (decision != EnableDecision.Allowed) return@synchronized decision
            // Only an off→on transition restarts the hysteresis evidence. Re-entering this from an
            // already-running gateway (activity reopen, service wake) must not erase a live success.
            if (!runtime.enabled) {
                runtime.enabled = true
                runtime.resetHeartbeatDiagnostics()
                runtime.connection = ServerConnection.CONNECTING
            }
            ContextCompat.startForegroundService(
                context,
                Intent(context, GatewayForegroundService::class.java).setAction(GatewayForegroundService.ACTION_START),
            )
            // S21 §D: ON owns the connection. A second standby owner next to the heartbeat would be
            // both duplicate traffic and a second raw-socket owner (S09).
            stopStandby()
            decision
        }
    }

    fun disable() {
        runtime.enabled = false
        runtime.connection = ServerConnection.DISABLED
        // Started before the main service is told to stop: while that service is still alive the app
        // is in a foreground-service state, which is what makes this start legal on Android 12+.
        startStandbyIfAllowed()
        context.startService(
            Intent(context, GatewayForegroundService::class.java).setAction(GatewayForegroundService.ACTION_STOP)
        )
    }

    /**
     * S21 §D. The user's local permission for the standby beacon. Turning it off closes the owner
     * immediately, which is what restores "OFF = zero outbound connections".
     */
    fun setAllowRemotePower(allowed: Boolean) {
        runtime.allowRemotePower = allowed
        if (allowed) startStandbyIfAllowed() else stopStandby()
    }

    /**
     * Never throws: a denied foreground-service start (Android 12+ background restriction) must not
     * take down the heartbeat coroutine or the boot receiver that asked for it.
     */
    fun startStandbyIfAllowed(): Boolean {
        if (!runtime.allowRemotePower || runtime.enabled) return false
        return runCatching {
            ContextCompat.startForegroundService(
                context,
                Intent(context, GatewayStandbyService::class.java).setAction(GatewayStandbyService.ACTION_START),
            )
            true
        }.getOrElse {
            runtime.connectionDetail = "待命服务未能启动：${(it.message ?: it.javaClass.simpleName).take(80)}"
            false
        }
    }

    fun stopStandby() {
        runCatching {
            context.startService(
                Intent(context, GatewayStandbyService::class.java).setAction(GatewayStandbyService.ACTION_STOP)
            )
        }
    }

    fun pairSafely(code: String, label: String): PairingResult = withIdentityChange {
        check(!vault.hasCredential()) { "请先安全移除现有设备凭据" }
        val gate = stopResidualServiceAndRequireSafeIdentityChange()
        gate.runAfterFreshCheck {
            // This read is adjacent to the remote mutation. A stale Activity snapshot must never
            // rotate/create the server identity before local safety is known.
            GatewayPairingApi().pair(code, label).also { result ->
                GatewaySimBindingStore(context).clear()
                GatewaySimSyncStateStore(context).clear()
                runtime.resetHeartbeatDiagnostics()
                vault.save(result.deviceToken)
                runtime.activatePairingIdentity(result.gatewayId, result.deviceEpoch, result.deviceToken)
                runtime.connection = ServerConnection.DISABLED
                // The beacon refuses to run without a credential; a fresh one may re-open it.
                startStandbyIfAllowed()
            }
        }
    }

    fun removeCredentialSafely() = withIdentityChange {
        val gate = stopResidualServiceAndRequireSafeIdentityChange()
        gate.runAfterFreshCheck {
            // Evidence stores are deliberately retained; changing identity never makes unresolved
            // history disappear.
            vault.clear()
            runtime.clearPairingIdentity()
            runtime.connection = ServerConnection.UNPAIRED
        }
    }

    private fun stopResidualServiceAndRequireSafeIdentityChange(): GatewayIdentityChangeGate {
        if (runtime.enabled) throw IdentityChangeBlockedException(IdentityChangeBlock.CONTROL_ENABLED)
        // The standby beacon authenticates with the credential that is about to change; it must not
        // keep a connection open across the rotation.
        stopStandby()
        val reader = AndroidIdentityChangeEvidenceReader(context)
        val initial = reader.read()
        GatewayIdentityChangePolicy.blockedBy(initial)?.takeIf {
            it == IdentityChangeBlock.CONTROL_ENABLED || it == IdentityChangeBlock.EVIDENCE_UNREADABLE
        }?.let { throw IdentityChangeBlockedException(it) }
        // OFF is a user-controlled prerequisite. Only drain an observed residual instance: starting
        // a new service merely to stop it would create another asynchronous lifecycle window.
        if (initial.serviceRunning) context.startService(
            Intent(context, GatewayForegroundService::class.java).setAction(GatewayForegroundService.ACTION_STOP)
        )
        return GatewayIdentityChangeGate(
            readEvidence = reader::read,
        ).also {
            it.awaitResidualCleanup(IDENTITY_STOP_TIMEOUT_NANOS, IDENTITY_STOP_POLL_MILLIS)
        }
    }

    private inline fun <T> withIdentityChange(block: () -> T): T {
        synchronized(IDENTITY_STATE_LOCK) {
            check(IDENTITY_CHANGE_IN_PROGRESS.compareAndSet(false, true)) { "设备身份正在切换，请稍后重试" }
        }
        return try {
            synchronized(IDENTITY_CHANGE_LOCK) { block() }
        } finally {
            IDENTITY_CHANGE_IN_PROGRESS.set(false)
        }
    }

    private companion object {
        val IDENTITY_CHANGE_LOCK = Any()
        val IDENTITY_STATE_LOCK = Any()
        val IDENTITY_CHANGE_IN_PROGRESS = AtomicBoolean(false)
        const val IDENTITY_STOP_POLL_MILLIS = 100L
        const val IDENTITY_STOP_TIMEOUT_NANOS = 10_000_000_000L
    }
}
