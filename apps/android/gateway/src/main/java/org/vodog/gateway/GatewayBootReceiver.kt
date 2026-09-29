package org.vodog.gateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** What a reboot should restart. Pure, so the decision is testable without a device. */
internal enum class GatewayBootStart { MAIN, STANDBY, NONE }

/**
 * The local master switch wins: an enabled gateway restarts the main foreground service through the
 * usual controller gate. Only a gateway the user left OFF falls back to the standby beacon, and only
 * when remote power-on is locally allowed.
 */
internal fun gatewayBootStartDecision(enabled: Boolean, allowRemotePower: Boolean): GatewayBootStart = when {
    enabled -> GatewayBootStart.MAIN
    allowRemotePower -> GatewayBootStart.STANDBY
    else -> GatewayBootStart.NONE
}

/**
 * S21 §D. Before this receiver existed a reboot left the gateway dead until someone opened the app —
 * the switch said ON and nothing was running. Starting a foreground service from `BOOT_COMPLETED` is
 * one of the documented exemptions from the Android 12+ background-start restriction.
 */
/** `adb install -r` / an update kills the process; MY_PACKAGE_REPLACED is the same FGS-start exemption as boot. */
internal val GATEWAY_RESTART_ACTIONS = setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)

class GatewayBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in GATEWAY_RESTART_ACTIONS) return
        val app = context.applicationContext
        val runtime = runCatching { GatewayRuntimeStore(app) }.getOrNull() ?: return
        when (gatewayBootStartDecision(runtime.enabled, runtime.allowRemotePower)) {
            GatewayBootStart.MAIN -> {
                val controller = GatewayController(app)
                val decision = runCatching { controller.enable() }
                    .getOrElse { EnableDecision.Blocked(it.message?.take(120) ?: "开机恢复失败") }
                if (decision != EnableDecision.Allowed) {
                    // Same semantics as reopening the app with an unmet requirement: the switch does
                    // not stay ON while nothing runs. The beacon still comes up when it is allowed,
                    // so the gateway remains remotely recoverable.
                    runtime.enabled = false
                    runtime.connection = ServerConnection.DISABLED
                    runtime.connectionDetail = "开机后权限或配对未满足，请检查后重新开启网关"
                    if (runtime.allowRemotePower) controller.startStandbyIfAllowed()
                }
            }
            GatewayBootStart.STANDBY -> GatewayController(app).startStandbyIfAllowed()
            GatewayBootStart.NONE -> Unit
        }
    }
}
