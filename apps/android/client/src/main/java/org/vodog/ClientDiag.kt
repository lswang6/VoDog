package org.vodog

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.time.Instant
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 一次安装内基本不变的那一层。纯数据：Android 侧每个字段单独 `runCatching`，读不到就是 null，
 * [ClientDiag.log] 会把 null 键整条丢掉——少一个字段远好过少一条事件。
 */
internal data class DiagContextReading(
    val deviceModel: String? = null,
    val deviceManufacturer: String? = null,
    val osVersion: String? = null,
    val sdkInt: Int? = null,
    val appVersion: String? = null,
    val appBuild: Int? = null,
    val locale: String? = null,
    val timeZone: String? = null,
    val pushRegistered: Boolean? = null,
    val micPermission: Boolean? = null,
    val notificationPermission: Boolean? = null,
    val notificationsEnabled: Boolean? = null,
    val installId: String? = null,
) {
    fun fields(): Map<String, Any?> = mapOf(
        "platform" to "android",
        "deviceModel" to deviceModel,
        "deviceManufacturer" to deviceManufacturer,
        "osVersion" to osVersion,
        "sdkInt" to sdkInt,
        "appVersion" to appVersion,
        "appBuild" to appBuild,
        "locale" to locale,
        "timeZone" to timeZone,
        "pushRegistered" to pushRegistered,
        "micPermission" to micPermission,
        "notificationPermission" to notificationPermission,
        "notificationsEnabled" to notificationsEnabled,
        "installId" to installId,
    )
}

/** 每次快照都会变的那一层：电量、温控、网络、内存、当前通话。同样是「读不到就省略」。 */
internal data class DiagSnapshotReading(
    val batteryLevel: Int? = null,
    val batteryCharging: Boolean? = null,
    val thermal: Int? = null,
    val powerSave: Boolean? = null,
    val transport: String? = null,
    val validated: Boolean? = null,
    val metered: Boolean? = null,
    val downKbps: Int? = null,
    val upKbps: Int? = null,
    val radio: String? = null,
    val carrier: String? = null,
    val appState: String? = null,
    val inCall: Boolean? = null,
    val callId: String? = null,
    val mediaState: String? = null,
    val memAvailMB: Long? = null,
    val memTotalMB: Long? = null,
    val lowMemory: Boolean? = null,
    val uptimeS: Long? = null,
    val seqDropped: Long? = null,
) {
    /** `callId` 不进 fields：它走 [ClientDiag.log] 的顶层参数，才能落到服务端的 `call_id` 列。 */
    fun fields(): Map<String, Any?> = mapOf(
        "batteryLevel" to batteryLevel,
        "batteryCharging" to batteryCharging,
        "thermal" to thermal,
        "powerSave" to powerSave,
        "transport" to transport,
        "validated" to validated,
        "metered" to metered,
        "downKbps" to downKbps,
        "upKbps" to upKbps,
        "radio" to radio,
        "carrier" to carrier,
        "appState" to appState,
        "inCall" to inCall,
        "mediaState" to mediaState,
        "memAvailMB" to memAvailMB,
        "memTotalMB" to memTotalMB,
        "lowMemory" to lowMemory,
        "uptimeS" to uptimeS,
        "seqDropped" to seqDropped,
    )
}

/**
 * S36 C3 客户端诊断，S36b D1 加深。一条通话出问题时，AI 要能把「当时这台机器什么状态 → 点了拨号 →
 * 服务器回了什么 → ICE 走到哪 → 音频路由是哪个设备」串成一条时间线，所以这里只做一件事：把带毫秒
 * 的结构化事件攒起来，批量 POST 到 `/diag/events`（头 `X-Diag-Source: android`、`X-Diag-Install`）。
 *
 * 契约：内存环 ≤500 条；满 50 条、每 60 秒、退到后台、通话前台服务停止时各刷一次。S36b 起**不再**
 * 静默丢弃：重试一次仍失败就把这批落到 `filesDir/diag-ring.jsonl`（上限 2000 行，越界才算
 * `diag.dropped`），下次登录先把文件传完再传内存里的。未登录（含退出登录）时 [uploader] 为 null，
 * [log] 直接返回，一条都不记。
 */
internal object ClientDiag {
    private const val RING = 500
    private const val BATCH = 200
    private const val FLUSH_AT = 50
    private const val FLUSH_INTERVAL_MS = 60_000L
    private const val PERSIST_CAP = 2000
    private const val PERSIST_FILE = "diag-ring.jsonl"
    private const val WINDOW_NANOS = 60_000_000_000L
    private const val CAPACITY = BatteryManager.BATTERY_PROPERTY_CAPACITY
    private const val ALIVE_PREFS = "client-diag-alive"
    private const val KEY_LAST_ALIVE = "lastAlive"
    private const val KEY_CLEAN_SHUTDOWN = "cleanShutdown"

    private val ring = ArrayDeque<JSONObject>()
    private val seq = AtomicLong()
    private val dropped = AtomicLong()
    private val droppedReported = AtomicLong()
    private val uploading = AtomicBoolean()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val fileLock = Any()
    private val apiErrors = HashMap<String, CoalesceWindow>()
    /** S69：每条事件记录时写入的顶层版本号 `<versionName>(<versionCode>)`；落盘补传的旧事件保留旧值。 */
    internal val appVersion: String = "${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE})"
    /** S69 ui.error_shown 的 screen：Workspace 切换页签时写。 */
    @Volatile internal var screen: String = "login"
    @Volatile private var uploader: ((JSONArray) -> Boolean)? = null
    /** 落盘目录，[attach] 时设成 `filesDir`；只有单元测试会另外指一个临时目录。 */
    @Volatile internal var storeDir: File? = null
    @Volatile private var flushJob: Job? = null
    @Volatile private var lastTransport: String? = null
    @Volatile private var lastContext: String? = null
    @Volatile private var contextReader: (() -> DiagContextReading)? = null
    @Volatile private var snapshotReader: (() -> DiagSnapshotReading)? = null
    @Volatile private var lastSnapshotNanos = 0L
    @Volatile private var mediaCallId: String? = null
    @Volatile private var mediaState: String? = null
    @Volatile private var alivePrefs: SharedPreferences? = null
    private var attached = false
    private var startedActivities = 0

    /** 60 秒合并窗口：同键第一条即时发，窗口结清时一条带 `repeat` 的汇总。 */
    private class CoalesceWindow(val event: String, val fields: Map<String, Any?>, val startedNanos: Long) {
        var count = 1
    }

    /**
     * 装上（或摘掉）上传口。`null` = 未登录/未挂载：什么都不记，内存里攒下的也丢掉，在飞的那次上报
     * 尽力取消。只 `cancel` 不 `join`：上报走的是阻塞式 HTTP，在主线程上等它结束就是一次 ANR。
     * 落盘目录只增不清——退出登录不该让上一轮崩溃现场消失。
     */
    internal fun install(sink: ((JSONArray) -> Boolean)?) {
        uploader = sink
        if (sink == null) {
            flushJob?.cancel()
            synchronized(ring) { ring.clear() }
            synchronized(apiErrors) { apiErrors.clear() }
            lastContext = null
            lastSnapshotNanos = 0L
            dropped.set(0)
            droppedReported.set(0)
        }
    }

    /** [attach] 与单元测试共用的注入口：把「怎么读这台设备」和「怎么攒事件」分开。 */
    internal fun installReaders(context: () -> DiagContextReading, snapshot: () -> DiagSnapshotReading) {
        contextReader = context
        snapshotReader = snapshot
    }

    fun log(
        event: String,
        fields: Map<String, Any?> = emptyMap(),
        callId: String? = null,
        level: String = "info",
    ) {
        uploader ?: return
        val item = JSONObject().put("ts", Instant.now().toString()).put("level", level).put("event", event)
            .put("appVersion", appVersion)
        callId?.takeIf { it.isNotBlank() && it != "null" }?.let { item.put("callId", it) }
        // `seq` 给同一毫秒内的事件排序。null 值直接不写：Android 的 org.json 会存成 JSONObject.NULL，
        // 测试用的 org.json 却会丢键，两边行为不一致。
        val payload = JSONObject().put("seq", seq.incrementAndGet())
        fields.forEach { (key, value) -> if (value != null) payload.put(key, value) }
        item.put("fields", payload)
        val pending = synchronized(ring) {
            ring.addLast(item)
            while (ring.size > RING) {
                ring.removeFirst()
                dropped.incrementAndGet()
            }
            ring.size
        }
        if (pending >= FLUSH_AT) flush()
    }

    /** 捕获到的意外异常统一走这里；面向用户的中文长句不进日志，只留类名 + 截断后的 message。 */
    fun appError(where: String, error: Throwable, code: String? = null, callId: String? = null) = log(
        "app.error",
        mapOf(
            "where" to where,
            "type" to error.javaClass.simpleName,
            "message" to error.message?.take(200)?.takeIf { it.isNotBlank() },
            "code" to code,
        ),
        callId = callId,
        level = "error",
    )

    /**
     * S36b D1：同一个 `path + 状态码 + 错误码` 在 60 秒内刷屏时只留两条——第一条即时（时间线上要看到
     * 它什么时候开始），窗口关闭时一条带 `repeat` 的汇总（总次数）。窗口在下一次同类错误越过 60 秒
     * 时滚动，或者在任何一次 [flushNow] 时结清。S69：字段名 `serverCode`，号码留在 path 里（决定 6）。
     */
    internal fun logApiError(path: String, status: Int, code: String) =
        coalesce("api\u0000$path\u0000$status\u0000$code", "api.error", mapOf("path" to path, "code" to status, "serverCode" to code))

    /** S69：网络层失败（没拿到 HTTP 状态）记 `code:0 + errorType`，同样 60 秒合并；取消与非 IO 异常不记。 */
    internal fun logNetworkError(path: String, error: Throwable, ms: Long) {
        val type = networkErrorType(error) ?: return
        coalesce("api\u0000$path\u00000\u0000$type", "api.error", mapOf("path" to path, "code" to 0, "errorType" to type, "ms" to ms))
    }

    /** S69 ui.error_shown：用户看得见的错误提示；同 (screen, message) 60 秒合并。 */
    internal fun uiErrorShown(site: String, message: String, code: String? = null) {
        if (message.isBlank()) return
        val where = screen
        coalesce(
            "ui\u0000$where\u0000$message",
            "ui.error_shown",
            mapOf("screen" to where, "site" to site, "message" to message.take(300), "code" to code),
        )
    }

    private fun coalesce(key: String, event: String, fields: Map<String, Any?>) {
        uploader ?: return
        val now = System.nanoTime()
        var summary: CoalesceWindow? = null
        var fresh = false
        synchronized(apiErrors) {
            val window = apiErrors[key]
            if (window == null || now - window.startedNanos >= WINDOW_NANOS) {
                summary = window?.takeIf { it.count > 1 }
                apiErrors[key] = CoalesceWindow(event, fields, now)
                fresh = true
            } else {
                window.count++
            }
        }
        summary?.let(::logCoalescedSummary)
        if (fresh) log(event, fields, level = "warn")
    }

    private fun logCoalescedSummary(window: CoalesceWindow) =
        log(window.event, window.fields + ("repeat" to window.count), level = "warn")

    /** 异步刷。UI 线程、通话线程都能调，永远不会在调用方阻塞出一次网络 I/O。 */
    fun flush() {
        uploader ?: return
        flushJob = scope.launch { flushNow() }
    }

    internal fun flushNow() {
        markAlive()
        // 进来就把上传口抓在手里：登出后换上的新口子永远收不到上一轮攒的事件。
        val sink = uploader ?: return
        drainApiErrors()
        emitDropped()
        val batch = synchronized(ring) {
            if (ring.isEmpty()) return
            ArrayList(ring).also { ring.clear() }
        }
        val failed = ArrayList<JSONObject>()
        batch.chunked(BATCH).forEach { chunk ->
            val payload = JSONArray().apply { chunk.forEach(::put) }
            val ok = runCatching { sink(payload) }.getOrDefault(false) ||
                runCatching { sink(payload) }.getOrDefault(false)
            if (!ok) failed += chunk
        }
        if (failed.isNotEmpty()) persist(failed)
    }

    /**
     * S52 进程被杀标记：每次 flush 与前后台切换写 `lastAlive`；`cleanShutdown` 只在既无前台 Activity
     * 又不在通话里时为 true（正常 onStop 之后），所以前台或通话中被杀，下次启动能看出来。
     */
    private fun markAlive() {
        val prefs = alivePrefs ?: return
        runCatching {
            prefs.edit()
                .putLong(KEY_LAST_ALIVE, System.currentTimeMillis())
                .putBoolean(KEY_CLEAN_SHUTDOWN, startedActivities == 0 && mediaCallId == null)
                .apply()
        }
    }

    private fun drainApiErrors() {
        val summaries = synchronized(apiErrors) {
            apiErrors.values.filter { it.count > 1 }.also { apiErrors.clear() }
        }
        summaries.forEach(::logCoalescedSummary)
    }

    /** 丢弃只在这里变成事件——直接在 [persist] 里记会和「落盘失败再落盘」互相喂。 */
    private fun emitDropped() {
        val total = dropped.get()
        val last = droppedReported.getAndSet(total)
        if (total > last) {
            log("diag.dropped", mapOf("count" to (total - last), "total" to total), level = "warn")
        }
    }

    /** 落盘：JSON lines 追加，上限 2000 行，越界的记进 [dropped]。 */
    private fun persist(items: List<JSONObject>) {
        val dir = storeDir ?: return
        if (items.isEmpty()) return
        val overflow = runCatching {
            synchronized(fileLock) {
                val file = File(dir, PERSIST_FILE)
                val existing = if (file.exists()) file.readLines().filter { it.isNotBlank() } else emptyList()
                val all = existing + items.map { it.toString() }
                file.writeText(all.takeLast(PERSIST_CAP).joinToString("\n", postfix = "\n"))
                all.size - PERSIST_CAP
            }
        }.getOrDefault(0)
        if (overflow > 0) dropped.addAndGet(overflow.toLong())
    }

    /** 下次启动（或下次登录）先把上一轮落盘的传完；全部成功才清文件，失败就原样留着。 */
    internal fun uploadPersisted() {
        val sink = uploader ?: return
        val dir = storeDir ?: return
        // 会话监听可能连着叫两次，别把同一批传两遍。
        if (!uploading.compareAndSet(false, true)) return
        try {
            val file = File(dir, PERSIST_FILE)
            val lines = synchronized(fileLock) {
                if (!file.exists()) return
                runCatching { file.readLines().filter { it.isNotBlank() } }.getOrDefault(emptyList())
            }
            // 被杀在半截的那一行不能永远卡住整个文件：解析不了就只丢它一行。
            val items = lines.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
            val ok = items.chunked(BATCH).all { chunk ->
                runCatching { sink(JSONArray().apply { chunk.forEach(::put) }) }.getOrDefault(false)
            }
            if (!ok) return
            synchronized(fileLock) {
                // 上传这段时间里新落盘的（又一次刷失败，或崩溃现场）不能被删掉。
                val remaining = runCatching { file.readLines().filter { it.isNotBlank() } }
                    .getOrDefault(emptyList()).drop(lines.size)
                if (remaining.isEmpty()) runCatching { file.delete() }
                else runCatching { file.writeText(remaining.joinToString("\n", postfix = "\n")) }
            }
        } finally {
            uploading.set(false)
        }
    }

    /** 当前音频会话的状态，供 `client.snapshot` 用。由 [AndroidCallMediaSession] 的 publish 顺手喂。 */
    fun noteMedia(callId: String?, phase: String) {
        mediaState = phase
        mediaCallId = callId?.takeIf { phase != CallMediaPhase.IDLE.name }
    }

    /** 值变了才发一条；权限是可以在「设置」里被改掉的，所以每次回到前台都比一次。 */
    internal fun refreshContext() {
        uploader ?: return
        val reading = runCatching { contextReader?.invoke() }.getOrNull() ?: return
        val fields = reading.fields()
        val signature = fields.toString()
        if (signature == lastContext) return
        lastContext = signature
        log("client.context", fields)
    }

    /** 每次定时刷之前来一张；`force` 只给「退到后台」和刚挂载那一次用。 */
    internal fun snapshot(force: Boolean) {
        uploader ?: return
        val now = System.nanoTime()
        synchronized(this) {
            if (!force && lastSnapshotNanos != 0L && now - lastSnapshotNanos < WINDOW_NANOS) return
            lastSnapshotNanos = now
        }
        val reading = runCatching { snapshotReader?.invoke() }.getOrNull() ?: return
        log("client.snapshot", reading.fields(), callId = reading.callId)
    }

    /**
     * 幂等挂载。三个入口都会调（Activity、通话前台服务、推送服务），因为推送唤醒的那条路根本没有
     * Activity。前后台判定用 `registerActivityLifecycleCallbacks` 数已 started 的 Activity，不引入
     * lifecycle-process 依赖。
     */
    fun attach(context: Context) {
        val app = context.applicationContext as? Application ?: return
        synchronized(this) {
            if (attached) return
            attached = true
        }
        storeDir = app.filesDir
        runCatching {
            val prefs = app.getSharedPreferences(ALIVE_PREFS, Context.MODE_PRIVATE)
            killedLastAliveAgoS(
                prefs.getLong(KEY_LAST_ALIVE, 0L),
                prefs.getBoolean(KEY_CLEAN_SHUTDOWN, true),
                System.currentTimeMillis(),
            )?.let { log("app.killed", mapOf("lastAliveAgoS" to it), level = "warn") }
            prefs.edit().remove(KEY_LAST_ALIVE).remove(KEY_CLEAN_SHUTDOWN).apply()
            alivePrefs = prefs
        }
        val pushStore = runCatching { AndroidPushStore(app) }.getOrNull()
        val installId = pushStore?.let { runCatching { it.installationId }.getOrNull() }
        val sessions = ClientSessionProcess.coordinator(app)
        installReaders({ readContext(app, pushStore, sessions, installId) }, { readSnapshot(app) })
        installCrashHandler()
        val post: (JSONArray) -> Boolean = { payload ->
            runCatching { ClientApi(sessions).postDiagEvents(payload, installId) }.isSuccess
        }
        fun syncSink() {
            val live = sessions.snapshot().session != null
            install(post.takeIf { live })
            // 先把上一轮（可能含崩溃现场）的文件传完，再发这一轮的 context/snapshot。
            // force=false：会话监听会被每次续期叫醒，快照的 1/60s 上限不能被它冲垮；登录后的第一张
            // 照样会发，因为 [install] 的 null 分支把计时器清了。
            if (live) scope.launch { uploadPersisted(); refreshContext(); snapshot(force = false) }
        }
        syncSink()
        ClientSessionProcess.listen { syncSink() }
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) {
                if (startedActivities++ == 0) {
                    log("app.foreground")
                    refreshContext()
                    markAlive()
                }
            }
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) {
                startedActivities = (startedActivities - 1).coerceAtLeast(0)
                // 旋转屏幕是「停一个、起一个」，不是真的退到后台。
                if (startedActivities == 0 && !activity.isChangingConfigurations) {
                    log("app.background")
                    markAlive()
                    snapshot(force = true)
                    flush()
                }
            }
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        runCatching {
            val connectivity = app.getSystemService(ConnectivityManager::class.java)
            // S72b: 冷启动（FCM 拉起）的第一条请求早于回调，先同步定一次端点。
            ClientEndpoint.onDefaultNetwork(transportName(connectivity.getNetworkCapabilities(connectivity.activeNetwork)))
            connectivity
                .registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                    override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) =
                        logTransport(caps)

                    override fun onLost(network: Network) = logTransport(null)
                })
        }
        runCatching {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) = log(
                    "battery.low",
                    mapOf("low" to (intent.action == Intent.ACTION_BATTERY_LOW)),
                    level = "warn",
                )
            }
            val filter = IntentFilter(Intent.ACTION_BATTERY_LOW).apply { addAction(Intent.ACTION_BATTERY_OKAY) }
            ContextCompat.registerReceiver(app, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        }
        runCatching {
            app.getSystemService(PowerManager::class.java)
                .addThermalStatusListener(app.mainExecutor) { status ->
                    log("thermal.state", mapOf("thermal" to status), level = if (status >= 3) "warn" else "info")
                }
        }
        scope.launch {
            while (isActive) {
                delay(FLUSH_INTERVAL_MS)
                // D1 的「前台每 60 秒一张」：后台空转的进程不该每分钟发一张快照 + 一次 POST。
                // 通话中例外——那正是最需要看设备状态的时候。
                if (startedActivities > 0 || mediaCallId != null) snapshot(force = false)
                flushNow()
            }
        }
    }

    /**
     * 崩溃现场同步落盘：串上原来的 handler（Android 自己那个负责真的杀进程），我们只在它之前把环里
     * 的事件和这次的栈写进文件，下次启动第一件事就是把它传上去。
     */
    private fun installCrashHandler() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                val stack = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString().take(3000)
                val crash = JSONObject()
                    .put("ts", Instant.now().toString())
                    .put("level", "error")
                    .put("event", "app.crash")
                    .put("appVersion", appVersion)
                    .put(
                        "fields",
                        JSONObject()
                            .put("seq", seq.incrementAndGet())
                            .put("thread", thread.name)
                            .put("type", error.javaClass.name)
                            .put("message", (error.message ?: "").take(200))
                            .put("stack", stack),
                    )
                val pending = synchronized(ring) { ArrayList(ring).also { ring.clear() } }
                persist(pending + crash)
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** `onCapabilitiesChanged` 一秒能来好几次，只有真的换了网才记一条。 */
    private fun logTransport(caps: NetworkCapabilities?) {
        val transport = transportName(caps)
        ClientEndpoint.onDefaultNetwork(transport)
        val validated = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
        val signature = "$transport:$validated"
        if (signature == lastTransport) return
        lastTransport = signature
        log("network.transport", mapOf("transport" to transport, "validated" to validated))
    }

    private fun transportName(caps: NetworkCapabilities?) = when {
        caps == null -> "none"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
    }

    private inline fun <T> reading(block: () -> T): T? = runCatching(block).getOrNull()

    private fun granted(app: Application, permission: String) =
        ContextCompat.checkSelfPermission(app, permission) == PackageManager.PERMISSION_GRANTED

    private fun readContext(
        app: Application,
        store: AndroidPushStore?,
        sessions: SessionCoordinator,
        installId: String?,
    ) = DiagContextReading(
        deviceModel = reading { Build.MODEL },
        deviceManufacturer = reading { Build.MANUFACTURER },
        osVersion = reading { Build.VERSION.RELEASE },
        sdkInt = reading { Build.VERSION.SDK_INT },
        appVersion = reading { BuildConfig.VERSION_NAME },
        appBuild = reading { BuildConfig.VERSION_CODE },
        locale = reading { Locale.getDefault().toLanguageTag() },
        timeZone = reading { TimeZone.getDefault().id },
        // 「注册成功」是和当前会话绑定过，不是「手上有个 token」——后者在换号登录后依然为真。
        pushRegistered = reading {
            val session = sessions.snapshot().session
            val token = store?.token()
            session != null && token != null && store.bindingMatches(session, token, BadgePrefsStore(app).read())
        },
        micPermission = reading { granted(app, Manifest.permission.RECORD_AUDIO) },
        notificationPermission = reading { granted(app, Manifest.permission.POST_NOTIFICATIONS) },
        notificationsEnabled = reading {
            app.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
        },
        installId = installId,
    )

    private fun readSnapshot(app: Application): DiagSnapshotReading {
        val battery = reading { app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val raw = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val power = reading { app.getSystemService(PowerManager::class.java) }
        val caps = reading {
            val manager = app.getSystemService(ConnectivityManager::class.java)
            manager.getNetworkCapabilities(manager.activeNetwork)
        }
        val telephony = reading { app.getSystemService(TelephonyManager::class.java) }
        val memory = reading {
            ActivityManager.MemoryInfo().also { app.getSystemService(ActivityManager::class.java).getMemoryInfo(it) }
        }
        return DiagSnapshotReading(
            batteryLevel = if (raw >= 0 && scale > 0) raw * 100 / scale else {
                reading { app.getSystemService(BatteryManager::class.java).getIntProperty(CAPACITY) }
                    ?.takeIf { it in 0..100 }
            },
            batteryCharging = if (status < 0) null else {
                status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            },
            thermal = reading { power?.currentThermalStatus },
            powerSave = reading { power?.isPowerSaveMode },
            transport = caps?.let { transportName(it) },
            validated = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            metered = caps?.let { !it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) },
            downKbps = caps?.linkDownstreamBandwidthKbps,
            upKbps = caps?.linkUpstreamBandwidthKbps,
            // S72 D3 起 manifest 声明了 READ_PHONE_STATE（为 owner-busy 的 isInCall），用户在设置里允许后这一列才有值；
            // 仍然绝不为了诊断去申请权限。
            radio = reading {
                if (granted(app, Manifest.permission.READ_PHONE_STATE)) {
                    telephony?.dataNetworkType?.let(::radioName)
                } else {
                    null
                }
            },
            carrier = reading { telephony?.networkOperatorName?.takeIf { it.isNotBlank() } },
            appState = if (startedActivities > 0) "fg" else "bg",
            inCall = mediaCallId != null,
            callId = mediaCallId,
            mediaState = mediaState,
            memAvailMB = memory?.let { it.availMem / (1024L * 1024L) },
            memTotalMB = memory?.let { it.totalMem / (1024L * 1024L) },
            lowMemory = memory?.lowMemory,
            uptimeS = reading { SystemClock.elapsedRealtime() / 1000L },
            seqDropped = dropped.get(),
        )
    }

    private fun radioName(type: Int) = when (type) {
        TelephonyManager.NETWORK_TYPE_NR -> "NR"
        TelephonyManager.NETWORK_TYPE_LTE -> "LTE"
        TelephonyManager.NETWORK_TYPE_UMTS,
        TelephonyManager.NETWORK_TYPE_HSPA,
        TelephonyManager.NETWORK_TYPE_HSPAP,
        -> "3G"
        TelephonyManager.NETWORK_TYPE_GPRS, TelephonyManager.NETWORK_TYPE_EDGE -> "2G"
        TelephonyManager.NETWORK_TYPE_UNKNOWN -> null
        else -> "type$type"
    }
}

/** S52: 上次进程没走正常 onStop 就没了，且 lastAlive 在 24 h 内 → 距今秒数；否则 null（不记）。 */
internal fun killedLastAliveAgoS(lastAliveMs: Long, cleanShutdown: Boolean, nowMs: Long): Long? {
    if (cleanShutdown || lastAliveMs <= 0L) return null
    val ago = nowMs - lastAliveMs
    return if (ago in 0 until 24 * 3_600_000L) ago / 1000 else null
}

/** 统一的毫秒口径：所有 `ms` 字段都来自 [android.os.SystemClock] 之外的单调时钟差值。 */
internal fun diagElapsedMs(startNanos: Long): Long = (System.nanoTime() - startNanos) / 1_000_000

/**
 * S69：网络层异常 → errorType。协程取消（[kotlinx.coroutines.CancellationException] 是
 * `java.util.concurrent.CancellationException`）返回 null，不记；非 IO 异常（JSON 解析等）也返回 null。
 */
internal fun networkErrorType(error: Throwable): String? = when (error) {
    is java.util.concurrent.CancellationException -> null
    is java.net.SocketTimeoutException -> "timeout"
    is java.io.InterruptedIOException -> if (error.message == "timeout") "timeout" else null
    is java.net.UnknownHostException -> "dns"
    is javax.net.ssl.SSLException -> "tls"
    is java.net.ConnectException, is java.net.NoRouteToHostException -> "offline"
    is java.io.IOException -> "other"
    else -> null
}
