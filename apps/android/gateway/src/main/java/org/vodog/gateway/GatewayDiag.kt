package org.vodog.gateway

import android.content.Context
import android.content.SharedPreferences
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * S36 C3: structured diagnostics. Events land in an in-memory ring and are POSTed to `/diag/events`
 * with the device token every 60 s, once 50 have piled up, or when the gateway stops.
 *
 * A log call never blocks, never throws and never touches the network: one daemon thread owns every
 * flush, and a flush that fails drops its batch. Diagnostics must never cost a call.
 *
 * S36b D2: a failed flush no longer loses its batch — it spills to a file in the device-protected
 * filesDir (cap [SPOOL_LIMIT] events, oldest out first) which the next start uploads before anything
 * else, and an uncaught exception spills the whole ring on its way out. Whatever is dropped past the
 * cap is itself reported, as `diag.dropped`.
 */
object GatewayDiag {
    private const val RING_LIMIT = 500
    private const val FLUSH_AT = 50
    /** Control accepts at most 200 items per request, so a full ring is three requests. */
    private const val BATCH_LIMIT = 200
    private const val FLUSH_INTERVAL_SECONDS = 60L
    internal const val SPOOL_LIMIT = 2000
    internal const val SPOOL_NAME = "diag-spool.jsonl"
    private const val LIVENESS_PREFS = "gateway-diag-liveness"
    private const val KEY_LAST_ALIVE = "lastAlive"
    private const val KEY_LAST_DOZE = "lastAliveDoze"
    private const val KEY_CLEAN = "cleanShutdown"
    /** S69 共同约定: `<versionName>(<versionCode>)`, read by Control as `item.appVersion`. */
    internal val APP_VERSION = "${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE})"

    private val ring = ArrayDeque<JSONObject>()
    private val seq = AtomicLong(0L)
    /** Events lost to the ring cap or the spool cap, reported by the next flush and then zeroed. */
    private val dropped = AtomicLong(0L)
    private val flushQueued = AtomicBoolean(false)
    private val crashHandlerInstalled = AtomicBoolean(false)
    private val spoolLock = Any()
    private val worker = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "gateway-diag").apply { isDaemon = true }
    }
    @Volatile private var api: GatewayApi? = null
    @Volatile private var owned: GatewayHttpTransport? = null
    @Volatile private var ticking = false
    @Volatile private var spool: File? = null
    @Volatile private var installId: String? = null
    /** S52: liveness marker (lastAlive per flush, cleanShutdown on onDestroy) that exposes silent process kills. */
    @Volatile private var liveness: SharedPreferences? = null
    @Volatile private var power: PowerManager? = null
    private val livenessChecked = AtomicBoolean(false)
    /** S36b D2: device status rides the flush timer — one 60 s tick, one thread, no second clock. */
    @Volatile internal var beforeFlush: (() -> Unit)? = null

    /** The gateway's own attach: spool file, install id and the crash handler come from the service. */
    fun attach(context: Context, token: String) {
        val store = runCatching { GatewayRuntimeStore(context) }.getOrNull()
        attach(
            token,
            OwnedGatewayHttpTransport(),
            runCatching {
                File(context.createDeviceProtectedStorageContext().filesDir, SPOOL_NAME)
            }.getOrNull(),
            store?.installId,
        )
        installCrashHandler()
        runCatching { checkLastExit(context) }
    }

    /**
     * S52: first attach of this process. A previous run that neither stopped cleanly nor went quiet
     * more than a day ago was killed (LMK, OOM, force-stop, crash) - report it once, then re-arm.
     */
    private fun checkLastExit(context: Context) {
        val prefs = context.createDeviceProtectedStorageContext()
            .getSharedPreferences(LIVENESS_PREFS, Context.MODE_PRIVATE)
        power = context.getSystemService(PowerManager::class.java)
        liveness = prefs
        if (livenessChecked.compareAndSet(false, true)) {
            val lastAlive = prefs.getLong(KEY_LAST_ALIVE, 0L).takeIf { it > 0L }
            killedAgoSeconds(prefs.getBoolean(KEY_CLEAN, true), lastAlive, System.currentTimeMillis())?.let { agoS ->
                log("app.killed", mapOf(
                    "lastAliveAgoS" to agoS,
                    "doze" to if (prefs.contains(KEY_LAST_DOZE)) prefs.getBoolean(KEY_LAST_DOZE, false) else null,
                ), level = "warn")
            }
            prefs.edit().remove(KEY_LAST_ALIVE).remove(KEY_LAST_DOZE).apply()
        }
        // Every attach re-arms: a service restarted inside the same process must not inherit "clean".
        prefs.edit().putBoolean(KEY_CLEAN, false).apply()
    }

    /** S52: the service's onDestroy - the only path that counts as a clean exit. */
    fun markCleanShutdown() {
        runCatching { liveness?.edit()?.putBoolean(KEY_CLEAN, true)?.commit() }
    }

    private fun recordAlive() {
        val prefs = liveness ?: return
        runCatching {
            val doze = power?.isDeviceIdleMode
            prefs.edit().putLong(KEY_LAST_ALIVE, System.currentTimeMillis())
                .also { edit -> if (doze != null) edit.putBoolean(KEY_LAST_DOZE, doze) }
                .apply()
        }
    }

    /**
     * Own transport on purpose: the service closes its own on the way out, and the stop batch is the
     * one that matters most. `shouldContinue` is likewise unconditional - a disabled gateway still
     * gets to say why it stopped.
     */
    @Synchronized fun attach(
        token: String,
        transport: GatewayHttpTransport = OwnedGatewayHttpTransport(),
        spoolFile: File? = null,
        install: String? = null,
    ) {
        owned?.let { previous -> worker.execute { runCatching { previous.close() } } }
        owned = transport
        spool = spoolFile
        installId = install
        api = GatewayApi(token, { true }, transport)
        if (!ticking) {
            ticking = true
            worker.scheduleWithFixedDelay(
                {
                    runCatching { beforeFlush?.invoke() }
                    runCatching { flushNow() }
                },
                FLUSH_INTERVAL_SECONDS, FLUSH_INTERVAL_SECONDS, TimeUnit.SECONDS,
            )
        }
        // S36b D2: whatever the last session could not send goes out first, and only that - the ring
        // belongs to the flush timer.
        val client = api ?: return
        runCatching { worker.execute { runCatching { uploadSpool(client) } } }
    }

    /**
     * Last flush of this ON generation, then the transport goes. The flush can take tens of seconds
     * on a dead link, so the clear only applies if nothing re-attached meanwhile - a re-enable during
     * that window would otherwise silence diagnostics for the whole next generation.
     */
    @Synchronized fun detach() {
        val transport = owned ?: return
        val client = api
        owned = null
        runCatching {
            worker.execute {
                runCatching { flushNow() }
                synchronized(this) { if (api === client) api = null }
                runCatching { transport.close() }
            }
        }
    }

    fun log(
        event: String,
        fields: Map<String, Any?> = emptyMap(),
        callId: String? = null,
        level: String = "info",
    ) {
        val item = item(event, fields, callId, level) ?: return
        val pending = synchronized(ring) {
            ring.addLast(item)
            while (ring.size > RING_LIMIT) { ring.removeFirst(); dropped.incrementAndGet() }
            ring.size
        }
        if (pending >= FLUSH_AT) flushSoon()
    }

    private val localEnds = LinkedHashSet<String>()

    /**
     * S75 `call.local_end`: this gateway itself ended (disconnect / reject) the cellular call. One row per
     * [deviceCallId]; a second path racing on the same call (Control hangup after a media failure) is dropped.
     */
    fun localEnd(deviceCallId: String, callId: String?, trigger: String, fields: Map<String, Any?> = emptyMap()) {
        val first = synchronized(localEnds) {
            localEnds.add(deviceCallId).also { while (localEnds.size > 64) localEnds.remove(localEnds.first()) }
        }
        if (first) log("call.local_end", mapOf("trigger" to trigger, "deviceCallId" to deviceCallId) + fields, callId)
    }

    private fun item(event: String, fields: Map<String, Any?>, callId: String?, level: String): JSONObject? =
        runCatching {
            JSONObject().put("ts", Instant.now().toString()).put("level", level).put("event", event)
                // S69: stamped at record time, so a spooled row keeps the version that wrote it.
                .put("appVersion", APP_VERSION)
                .also { row -> callId?.takeIf(String::isNotBlank)?.let { row.put("callId", it) } }
                .put("fields", JSONObject().put("seq", seq.incrementAndGet())
                    .also { extra -> fields.forEach { (key, value) -> if (value != null) extra.put(key, value) } })
        }.getOrNull()

    /** S36b D2: anything that must not run on a caller's thread (a broadcast, a telephony callback). */
    internal fun post(task: () -> Unit) {
        runCatching { worker.execute { runCatching { task() } } }
    }

    /** The diag thread, handed to the platform listeners that take an executor. */
    internal fun executor(): Executor = worker

    /** One queued flush at a time: a 500-event burst must not queue 450 no-op tasks. */
    private fun flushSoon() {
        if (!flushQueued.compareAndSet(false, true)) return
        runCatching {
            worker.execute {
                flushQueued.set(false)
                runCatching { flushNow() }
            }
        }.onFailure { flushQueued.set(false) }
    }

    internal fun flushNow() {
        recordAlive()
        val client = api ?: return
        uploadSpool(client)
        val batch = synchronized(ring) { ring.filter(::uploadable).also { ring.clear() } }
        // What the ring and the spool caps ate rides out with the batch, never through the ring:
        // a report that evicts another event would be its own cause.
        val lost = dropped.getAndSet(0L)
        val items = if (lost > 0L) {
            batch + listOfNotNull(item("diag.dropped", mapOf("count" to lost), null, "warn"))
        } else batch
        if (items.isEmpty()) return
        items.chunked(BATCH_LIMIT).forEach { chunk -> if (!send(client, chunk)) spill(chunk) }
    }

    /** `debug` rows (the per-cycle heartbeat.rtt, ~42% of diag_events) stay in the local ring and are never sent. */
    private fun uploadable(row: JSONObject) = row.optString("level") != "debug"

    /** Two attempts, then the caller decides what to do with the batch. */
    private fun send(client: GatewayApi, chunk: List<JSONObject>): Boolean {
        val body = JSONArray().apply { chunk.forEach(::put) }
        return runCatching { client.diagEvents(body, installId) }
            .recoverCatching { client.diagEvents(body, installId) }
            .isSuccess
    }

    /** What a failed flush or a crash left on disk, oldest first, before this session says anything. */
    private fun uploadSpool(client: GatewayApi) {
        val file = spool ?: return
        val lines = synchronized(spoolLock) {
            if (!file.exists()) return
            runCatching { file.readLines() }.getOrNull().also { runCatching { file.delete() } }
        } ?: return
        val events = lines.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }.filter(::uploadable)
        var sent = 0
        for (chunk in events.chunked(BATCH_LIMIT)) {
            // The file is already gone, so a failure must put back everything still unsent, not just
            // this chunk - otherwise a link that stays down eats the spool one batch at a time.
            if (!send(client, chunk)) { spill(events.drop(sent)); return }
            sent += chunk.size
        }
    }

    /** Append to the spool; past the cap the oldest go, and the loss is reported by the next flush. */
    private fun spill(events: List<JSONObject>) {
        val file = spool ?: return
        if (events.isEmpty()) return
        runCatching {
            synchronized(spoolLock) {
                val kept = (if (file.exists()) file.readLines() else emptyList()) + events.map { it.toString() }
                if (kept.size > SPOOL_LIMIT) dropped.addAndGet((kept.size - SPOOL_LIMIT).toLong())
                file.writeText(kept.takeLast(SPOOL_LIMIT).joinToString("\n", postfix = "\n"))
            }
        }
    }

    /**
     * S36b D2: the last thing a dying process does is write its ring to disk. Chained, never
     * replacing: whatever handler Android installed still gets to kill the process.
     */
    private fun installCrashHandler() {
        if (!crashHandlerInstalled.compareAndSet(false, true)) return
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        runCatching {
            Thread.setDefaultUncaughtExceptionHandler { thread, error ->
                runCatching {
                    // Never through `log`: a dying process must write to disk, not queue a flush.
                    val crash = item(
                        "app.crash",
                        mapOf(
                            "thread" to thread.name,
                            "type" to error.javaClass.name,
                            "message" to error.message?.take(200),
                            "at" to error.stackTrace.firstOrNull()?.toString()?.take(200),
                        ),
                        null, "error",
                    )
                    spill(synchronized(ring) { ring.filter(::uploadable).also { ring.clear() } } + listOfNotNull(crash))
                }
                previous?.uncaughtException(thread, error)
            }
        }.onFailure { crashHandlerInstalled.set(false) }
    }
}

/** S52: seconds since the last flush of a run that did not stop cleanly, or null (clean, unknown, or over a day old). */
internal const val KILLED_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000L

internal fun killedAgoSeconds(cleanShutdown: Boolean, lastAliveMs: Long?, nowMs: Long): Long? {
    if (cleanShutdown || lastAliveMs == null) return null
    val agoMs = nowMs - lastAliveMs
    return if (agoMs in 0 until KILLED_REPORT_WINDOW_MS) agoMs / 1000 else null
}
