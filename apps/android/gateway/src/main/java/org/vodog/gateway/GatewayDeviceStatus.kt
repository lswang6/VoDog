package org.vodog.gateway

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.telephony.PhoneStateListener
import android.telephony.ServiceState
import android.telephony.SignalStrength
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * S36b D2: the Pixel's own state, as one `device.status` event.
 *
 * Every field is optional: a missing permission, a vendor quirk or a system service that is simply
 * not there omits the field and keeps the event. A reader that sees no `sims` key knows the gateway
 * had no phone permission at that moment — which is itself the answer to a class of incidents.
 */
internal data class SimStatusReading(
    val slot: Int,
    val carrier: String? = null,
    val simState: Int? = null,
    val radio: Int? = null,
    val signalLevel: Int? = null,
    val dbm: Int? = null,
    val roaming: Boolean? = null,
    val dataActivity: Int? = null,
)

internal data class DeviceStatusReading(
    val batteryLevel: Int? = null,
    val charging: Boolean? = null,
    val batteryTemperatureC: Double? = null,
    val batteryHealth: Int? = null,
    val thermal: Int? = null,
    val memoryFreeMB: Long? = null,
    val memoryLow: Boolean? = null,
    val uptimeS: Long? = null,
    val doze: Boolean? = null,
    val powerSave: Boolean? = null,
    val standby: String? = null,
    val connection: String? = null,
    val transport: String? = null,
    val validated: Boolean? = null,
    val metered: Boolean? = null,
    val downKbps: Int? = null,
    val upKbps: Int? = null,
    val wifiRssi: Int? = null,
    /** S53: the active network's forced HTTP proxy as `host:port` (a WAP APN sets one; TURN cannot use it). */
    val httpProxy: String? = null,
    /** S53: the cellular APN name; null on Wi-Fi or when the platform does not report it. */
    val apn: String? = null,
    val callState: Int? = null,
    val audioMode: Int? = null,
    /** Null means "not readable" (no phone permission); an empty list means "no SIM". */
    val sims: List<SimStatusReading>? = null,
)

/** Nested only when it has something to say, so an unreadable group is an absent key, not `{}`. */
private fun groupOf(vararg entries: Pair<String, Any?>): JSONObject? {
    val json = JSONObject()
    entries.forEach { (key, value) -> if (value != null) json.put(key, value) }
    return json.takeIf { it.length() > 0 }
}

/** `host:port`, or null when there is no proxy (ProxyInfo reports a blank host for a PAC-only one). */
internal fun httpProxyLabel(host: String?, port: Int): String? =
    host?.takeIf(String::isNotBlank)?.let { if (port > 0) "$it:$port" else it }

/** The `device.status` fields. `GatewayDiag.log` drops the null values, so omission is automatic. */
internal fun deviceStatusFields(reading: DeviceStatusReading): Map<String, Any?> = mapOf(
    "battery" to groupOf(
        "level" to reading.batteryLevel,
        "charging" to reading.charging,
        "temperatureC" to reading.batteryTemperatureC,
        "health" to reading.batteryHealth,
    ),
    "thermal" to reading.thermal,
    "memoryFreeMB" to reading.memoryFreeMB,
    "memoryLow" to reading.memoryLow,
    "uptimeS" to reading.uptimeS,
    "doze" to reading.doze,
    "powerSave" to reading.powerSave,
    "standby" to reading.standby,
    "connection" to reading.connection,
    "network" to groupOf(
        "transport" to reading.transport,
        "validated" to reading.validated,
        "metered" to reading.metered,
        "downKbps" to reading.downKbps,
        "upKbps" to reading.upKbps,
        "wifiRssi" to reading.wifiRssi,
        "httpProxy" to reading.httpProxy,
        "apn" to reading.apn,
    ),
    "sims" to reading.sims?.let { sims ->
        JSONArray().apply {
            sims.forEach { sim ->
                put(groupOf(
                    "slot" to sim.slot,
                    "carrier" to sim.carrier,
                    "simState" to sim.simState,
                    "radio" to sim.radio,
                    "signalLevel" to sim.signalLevel,
                    "dbm" to sim.dbm,
                    "roaming" to sim.roaming,
                    "dataActivity" to sim.dataActivity,
                ))
            }
        }
    },
    "callState" to reading.callState,
    "audioMode" to reading.audioMode,
)

/**
 * The level-type fields, as one comparable string: a change in any of them is worth an event of its
 * own, everything else (temperature, free memory, uptime, bandwidth estimates) waits for the tick.
 */
internal fun deviceStatusLevels(reading: DeviceStatusReading): String = listOf(
    reading.batteryLevel, reading.charging, reading.thermal, reading.doze, reading.powerSave,
    reading.standby, reading.connection, reading.transport, reading.validated, reading.metered,
    reading.httpProxy, reading.apn, reading.callState, reading.audioMode,
    reading.sims?.joinToString(",") {
        "${it.slot}/${it.simState}/${it.radio}/${it.signalLevel}/${it.roaming}"
    },
).joinToString("|")

/** S69: device.status is logged on a level change, else at most every [DEVICE_STATUS_FALLBACK_MS]. */
internal const val DEVICE_STATUS_FALLBACK_MS = 15 * 60 * 1000L

internal fun deviceStatusDue(
    levels: String,
    lastLevels: String?,
    nowMs: Long,
    lastLoggedAtMs: Long?,
    fallbackMs: Long = DEVICE_STATUS_FALLBACK_MS,
): Boolean = levels != lastLevels || lastLoggedAtMs == null || nowMs - lastLoggedAtMs !in 0 until fallbackMs

/** S36b D2: signal strength fires every few seconds; only a change is an event. */
internal class SignalLevelGate {
    private val last = HashMap<Int, String>()

    @Synchronized fun changed(slot: Int, value: String): Boolean = last.put(slot, value) != value
}

/**
 * Reads the device state and logs it. Held by [GatewayDeviceStatus] for the service's lifetime so the
 * change gate has something to compare against; every read runs on the diag thread.
 */
internal class GatewayDeviceStatusCollector(private val context: Context) {
    private var lastLevels: String? = null
    private var lastLoggedAtMs: Long? = null

    /**
     * `force` is the service start only. S69: the 60 s tick and pushed changes log when a level-type
     * field moved, or when [DEVICE_STATUS_FALLBACK_MS] passed without a row.
     */
    @Synchronized fun log(force: Boolean) {
        val reading = runCatching { read() }.getOrNull() ?: return
        val levels = deviceStatusLevels(reading)
        val nowMs = SystemClock.elapsedRealtime()
        if (!force && !deviceStatusDue(levels, lastLevels, nowMs, lastLoggedAtMs)) return
        lastLevels = levels
        lastLoggedAtMs = nowMs
        GatewayDiag.log("device.status", deviceStatusFields(reading))
    }

    @Suppress("DEPRECATION")
    internal fun read(): DeviceStatusReading {
        val battery = runCatching {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull()
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val rawLevel = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val power = runCatching { context.getSystemService(PowerManager::class.java) }.getOrNull()
        val connectivity = runCatching { context.getSystemService(ConnectivityManager::class.java) }.getOrNull()
        val activeNetwork = runCatching { connectivity?.activeNetwork }.getOrNull()
        val capabilities = runCatching { connectivity?.getNetworkCapabilities(activeNetwork) }.getOrNull()
        val proxy = runCatching { connectivity?.getLinkProperties(activeNetwork)?.httpProxy }.getOrNull()
        val memory = runCatching {
            ActivityManager.MemoryInfo().also {
                context.getSystemService(ActivityManager::class.java).getMemoryInfo(it)
            }
        }.getOrNull()
        val telephony = runCatching { context.getSystemService(TelephonyManager::class.java) }.getOrNull()
        val runtime = runCatching { GatewayRuntimeStore(context) }.getOrNull()
        return DeviceStatusReading(
            batteryLevel = if (scale > 0 && rawLevel >= 0) rawLevel * 100 / scale else null,
            charging = status.takeIf { it >= 0 }?.let {
                it == BatteryManager.BATTERY_STATUS_CHARGING || it == BatteryManager.BATTERY_STATUS_FULL
            },
            batteryTemperatureC = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
                ?.takeIf { it != Int.MIN_VALUE }?.let { it / 10.0 },
            batteryHealth = battery?.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)?.takeIf { it >= 0 },
            thermal = runCatching { power?.currentThermalStatus }.getOrNull(),
            memoryFreeMB = memory?.availMem?.div(1024L * 1024L),
            memoryLow = memory?.lowMemory,
            uptimeS = SystemClock.elapsedRealtime() / 1000L,
            doze = runCatching { power?.isDeviceIdleMode }.getOrNull(),
            powerSave = runCatching { power?.isPowerSaveMode }.getOrNull(),
            // The app's own power state, not the system's: ON, the standby beacon, or nothing at all.
            standby = runtime?.let {
                when {
                    it.enabled -> "on"
                    it.allowRemotePower -> "beacon"
                    else -> "off"
                }
            },
            connection = runtime?.connection?.name,
            transport = capabilities?.let(::transportLabel),
            validated = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            metered = capabilities?.let { !it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) },
            downKbps = capabilities?.linkDownstreamBandwidthKbps?.takeIf { it > 0 },
            upKbps = capabilities?.linkUpstreamBandwidthKbps?.takeIf { it > 0 },
            wifiRssi = capabilities?.takeIf { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) }
                ?.let { runCatching { it.signalStrength }.getOrNull() }?.takeIf { it != Int.MIN_VALUE },
            httpProxy = proxy?.let { httpProxyLabel(it.host, it.port) },
            // NetworkInfo.extraInfo is deprecated but is the only permission-free APN name source.
            apn = capabilities?.takeIf { it.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) }
                ?.let { runCatching { connectivity?.getNetworkInfo(activeNetwork)?.extraInfo }.getOrNull() }
                ?.takeIf(String::isNotBlank)?.take(40),
            callState = runCatching { telephony?.callState }.getOrNull(),
            audioMode = runCatching { context.getSystemService(AudioManager::class.java)?.mode }.getOrNull(),
            sims = simReadings(telephony),
        )
    }

    /** Null without the phone permission: the reader must be able to tell "no SIM" from "not allowed". */
    private fun simReadings(telephony: TelephonyManager?): List<SimStatusReading>? {
        if (telephony == null || !DeviceStatusReader(context).hasPhonePermission()) return null
        return runCatching {
            DeviceStatusReader(context).activeSims().map { sim ->
                val forSim = runCatching { telephony.createForSubscriptionId(sim.subscriptionId) }.getOrNull()
                val strength = runCatching { forSim?.signalStrength }.getOrNull()
                SimStatusReading(
                    slot = sim.slotIndex,
                    carrier = sim.carrierName.takeIf(String::isNotBlank),
                    simState = runCatching { telephony.getSimState(sim.slotIndex) }.getOrNull(),
                    radio = runCatching { forSim?.dataNetworkType }.getOrNull(),
                    signalLevel = runCatching { strength?.level }.getOrNull(),
                    dbm = runCatching { strength?.cellSignalStrengths?.firstOrNull()?.dbm }.getOrNull(),
                    roaming = runCatching { forSim?.isNetworkRoaming }.getOrNull(),
                    dataActivity = runCatching { forSim?.dataActivity }.getOrNull(),
                )
            }
        }.getOrNull()
    }

    private fun transportLabel(capabilities: NetworkCapabilities): String = when {
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wired"
        else -> "other"
    }
}

/**
 * S36b D2: one collector, one 60 s tick (shared with the diag flush, so no second timer and no
 * second thread), plus pushed updates from the platform — battery/doze/power-save broadcasts, the
 * thermal listener and the per-subscription telephony callbacks. The heartbeat loop is never touched.
 *
 * ponytail: the telephony listeners are bound to the SIMs present at start; a SIM swap is picked up
 * by the next service start (the gateway restarts on identity changes anyway).
 */
internal object GatewayDeviceStatus {
    private var collector: GatewayDeviceStatusCollector? = null
    private var receiver: BroadcastReceiver? = null
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null
    private val telephonyListeners = mutableListOf<Pair<TelephonyManager, Any>>()
    private val signalGate = SignalLevelGate()
    private val serviceStateGate = SignalLevelGate()

    @Synchronized fun start(context: Context) {
        if (collector != null) return
        val owned = GatewayDeviceStatusCollector(context)
        collector = owned
        GatewayDiag.beforeFlush = { owned.log(force = false) }
        GatewayDiag.post { owned.log(force = true) }
        startBroadcasts(context, owned)
        startThermal(context, owned)
        startTelephony(context)
    }

    @Synchronized fun stop(context: Context) {
        GatewayDiag.beforeFlush = null
        collector = null
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
        val power = runCatching { context.getSystemService(PowerManager::class.java) }.getOrNull()
        thermalListener?.let { listener -> runCatching { power?.removeThermalStatusListener(listener) } }
        thermalListener = null
        telephonyListeners.forEach { (manager, listener) -> stopTelephonyListener(manager, listener) }
        telephonyListeners.clear()
    }

    private fun startBroadcasts(context: Context, owned: GatewayDeviceStatusCollector) {
        // The battery broadcast also fires on temperature; the collector's gate decides what is news.
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED).apply {
            addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        }
        val registered = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                GatewayDiag.post { owned.log(force = false) }
            }
        }
        receiver = registered
        runCatching {
            // targetSdk 36 requires the export flag even though all three are protected broadcasts.
            ContextCompat.registerReceiver(context, registered, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        }.onFailure { receiver = null }
    }

    private fun startThermal(context: Context, owned: GatewayDeviceStatusCollector) {
        val power = runCatching { context.getSystemService(PowerManager::class.java) }.getOrNull() ?: return
        val listener = PowerManager.OnThermalStatusChangedListener { owned.log(force = false) }
        thermalListener = listener
        runCatching { power.addThermalStatusListener(GatewayDiag.executor(), listener) }
            .onFailure { thermalListener = null }
    }

    private fun startTelephony(context: Context) {
        val reader = DeviceStatusReader(context)
        if (!reader.hasPhonePermission()) return
        val base = runCatching { context.getSystemService(TelephonyManager::class.java) }.getOrNull() ?: return
        runCatching { reader.activeSims() }.getOrNull().orEmpty().forEach { sim ->
            val manager = runCatching { base.createForSubscriptionId(sim.subscriptionId) }.getOrNull() ?: return@forEach
            val listener = startTelephonyListener(manager, sim.slotIndex) ?: return@forEach
            telephonyListeners += manager to listener
        }
    }

    private fun startTelephonyListener(manager: TelephonyManager, slot: Int): Any? {
        if (Build.VERSION.SDK_INT >= 31) {
            val callback = SlotTelephonyCallback(slot)
            return runCatching {
                manager.registerTelephonyCallback(GatewayDiag.executor(), callback)
                callback
            }.getOrNull()
        }
        // API 29/30: PhoneStateListener must be constructed on a thread with a Looper.
        @Suppress("DEPRECATION")
        val legacy = runCatching {
            val handler = Handler(Looper.getMainLooper())
            val listener = object : PhoneStateListener() {
                override fun onSignalStrengthsChanged(signalStrength: SignalStrength) = onSignal(slot, signalStrength)
                override fun onServiceStateChanged(serviceState: ServiceState) = onServiceState(slot, serviceState)
            }
            handler.post {
                runCatching {
                    manager.listen(
                        listener,
                        PhoneStateListener.LISTEN_SIGNAL_STRENGTHS or PhoneStateListener.LISTEN_SERVICE_STATE,
                    )
                }
            }
            listener
        }.getOrNull()
        return legacy
    }

    @Suppress("DEPRECATION")
    private fun stopTelephonyListener(manager: TelephonyManager, listener: Any) {
        when (listener) {
            is TelephonyCallback -> runCatching { manager.unregisterTelephonyCallback(listener) }
            is PhoneStateListener -> runCatching {
                Handler(Looper.getMainLooper()).post {
                    runCatching { manager.listen(listener, PhoneStateListener.LISTEN_NONE) }
                }
            }
            else -> Unit
        }
    }

    private class SlotTelephonyCallback(private val slot: Int) :
        TelephonyCallback(), TelephonyCallback.SignalStrengthsListener, TelephonyCallback.ServiceStateListener {
        override fun onSignalStrengthsChanged(signalStrength: SignalStrength) = onSignal(slot, signalStrength)
        override fun onServiceStateChanged(serviceState: ServiceState) = onServiceState(slot, serviceState)
    }

    private fun onSignal(slot: Int, signalStrength: SignalStrength) {
        val level = runCatching { signalStrength.level }.getOrNull() ?: return
        if (!signalGate.changed(slot, level.toString())) return
        GatewayDiag.log("telephony.signal", mapOf(
            "slot" to slot,
            "level" to level,
            "dbm" to runCatching { signalStrength.cellSignalStrengths.firstOrNull()?.dbm }.getOrNull(),
        ))
    }

    @Suppress("DEPRECATION")
    private fun onServiceState(slot: Int, serviceState: ServiceState) {
        val state = runCatching { serviceState.state }.getOrNull() ?: return
        val roaming = runCatching { serviceState.roaming }.getOrNull()
        if (!serviceStateGate.changed(slot, "$state/$roaming")) return
        GatewayDiag.log(
            "telephony.service_state",
            mapOf("slot" to slot, "state" to state, "roaming" to roaming),
            level = if (state == ServiceState.STATE_IN_SERVICE) "info" else "warn",
        )
    }
}
