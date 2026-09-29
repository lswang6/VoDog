package org.vodog.gateway

import android.content.Context
import android.content.SharedPreferences
import android.database.ContentObserver
import android.net.Uri
import android.provider.BlockedNumberContract
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * S55 (was S41 §决策4, add-only): the Pixel system blocked-number provider is one more end of the
 * account blocklist. `WRITE_BLOCKED_NUMBERS` is signature level and the gateway is not the default
 * dialer, so the one on-device path is a root shell.
 *
 * Three-way merge against a persisted baseline B (the `mirrored` set): phone P, Control C.
 * `phoneSync=off` (and `dry_run`, which only logs the full plan) keeps B as "keys this gateway wrote":
 * Control adds are inserted, Control removes delete only what the gateway itself wrote, a hand-deleted
 * key is forgotten and re-inserted. `on` makes B the last agreed set and reports phone changes to
 * Control. It never touches the gateway's own `isCallListed` / `isSmsListed` checks.
 * S66: targets are the numbers on both the call and the SMS list (see [systemBlocklistTargets]).
 */
internal const val SYSTEM_BLOCKLIST_URI = "content://com.android.blockednumber/blocked"

/** Every number that reaches a shell line is matched against this first - it is the trust boundary. */
private val MIRRORABLE_NUMBER = Regex("^\\+?[0-9]{3,20}$")
private val QUERY_ROW = Regex("Row: \\d+ original_number=([^,\\n]*)(?:, e164_number=([^,\\n]*))?")
private const val SYSTEM_BLOCKLIST_QUERY =
    "content query --uri $SYSTEM_BLOCKLIST_URI --projection original_number:e164_number\nexit\n"

internal enum class PhoneSyncMode(val wire: String) {
    OFF("off"), DRY_RUN("dry_run"), ON("on");
    companion object {
        /** Absent or unknown is `off`: the gateway never reports phone changes unless told to. */
        fun parse(value: String?) = entries.firstOrNull { it.wire == value } ?: OFF
    }
}

/** The one key space for Control numbers and provider rows alike: S55's CN equivalence, same as Control. */
internal fun systemBlocklistKey(raw: String): String? =
    blocklistCanonicalKey(raw)?.takeIf(MIRRORABLE_NUMBER::matches)

/**
 * S66: the system provider blocks calls and SMS alike, so it mirrors only numbers on both lists: per
 * SIM, the call-list numbers that also match that SIM's SMS list (same key, or the gateway's own SMS
 * matcher with the SIM's country); union over SIMs. key -> one Control spelling, '+' preferred.
 */
internal fun systemBlocklistTargets(
    items: List<NumberBlocklistItem>,
    key: (String) -> String?,
    countryIso: (String) -> String? = { null },
): Map<String, String> {
    val targets = LinkedHashMap<String, String>()
    val both = items.flatMap { item ->
        val iso = countryIso(item.simId)
        val smsKeys = item.smsNumbers.mapNotNullTo(HashSet()) { key(it.trim()) }
        item.numbers.filter { number ->
            key(number.trim())?.let(smsKeys::contains) == true ||
                numberBlocklistMatches(number, item.smsNumbers, iso)
        }
    }
    for (raw in both) {
        val number = raw.trim()
        val k = key(number) ?: continue
        val spelling = number.takeIf(MIRRORABLE_NUMBER::matches)
            ?: dialNumberMatchKey(number)?.takeIf(MIRRORABLE_NUMBER::matches)
            ?: continue
        val known = targets[k]
        if (known == null || (!known.startsWith("+") && spelling.startsWith("+"))) targets[k] = spelling
    }
    return targets
}

internal data class BlockedNumberRow(val original: String, val e164: String?)

/** Key -> provider rows, read back from the `Row: N original_number=..., e164_number=...` dump. */
internal fun systemBlocklistRows(output: String, key: (String) -> String?): Map<String, List<BlockedNumberRow>> =
    QUERY_ROW.findAll(output).mapNotNull { match ->
        val original = match.groupValues[1].trim()
        val e164 = match.groupValues[2].trim().takeUnless { it.isEmpty() || it == "NULL" }
        val k = key(original) ?: e164?.let(key) ?: return@mapNotNull null
        k to BlockedNumberRow(original, e164)
    }.groupBy({ it.first }, { it.second })

internal fun systemBlocklistPresentKeys(output: String, key: (String) -> String?): Set<String> =
    systemBlocklistRows(output, key).keys

/** A read the provider actually answered; a denied or killed `su` must never look like an empty table. */
internal fun systemBlocklistQueryAnswered(exit: Int?, output: String): Boolean =
    exit == 0 && (output.contains("Row: ") || output.contains("No result found"))

internal fun systemBlocklistInsertScript(numbers: Collection<String>): String = buildString {
    numbers.forEach { number ->
        require(MIRRORABLE_NUMBER.matches(number)) { "unmirrorable number" }
        append("content insert --uri ").append(SYSTEM_BLOCKLIST_URI)
            .append(" --bind original_number:s:").append(number).append('\n')
    }
    // `content` swallows provider errors and still exits 0, so the table itself is the receipt.
    append(SYSTEM_BLOCKLIST_QUERY)
}

/** Exact match on both stored fields; a row whose original spelling is not shell-safe is never deleted. */
internal fun systemBlocklistDeleteScript(rows: Collection<BlockedNumberRow>): String = buildString {
    rows.forEach { row ->
        require(MIRRORABLE_NUMBER.matches(row.original)) { "unmirrorable number" }
        append("content delete --uri ").append(SYSTEM_BLOCKLIST_URI)
            .append(" --where \"original_number='").append(row.original).append('\'')
        row.e164?.takeIf(MIRRORABLE_NUMBER::matches)?.let { append(" AND e164_number='").append(it).append('\'') }
        append("\"\n")
    }
    append(SYSTEM_BLOCKLIST_QUERY)
}

internal data class SystemBlocklistSyncPlan(
    /** Keys to write to / delete from the provider this run. */
    val insert: Set<String>,
    val remove: Set<String>,
    /** Phone changes to report to Control (only ever non-empty in `on`). */
    val report: Pair<Set<String>, Set<String>>,
    /** Baseline keys dropped before merging (hand-deleted in off/dry_run, the bootstrap cut in on). */
    val healed: Set<String>,
    /** The full three-way plan, whatever the mode - what `dry_run` logs. */
    val phoneAdds: Set<String>,
    val phoneRemoves: Set<String>,
    val controlAdds: Set<String>,
    val controlRemoves: Set<String>,
    /** C as the merge saw it: targets plus reports Control has not reflected yet. */
    val control: Set<String>,
)

/**
 * `bootstrap` (first run after any mode other than `on`) cuts B to B ∩ P, so a key that vanished from
 * the phone while nothing was reported is not taken for a phone unblock. With one set baseline a
 * key is either in B (both sides can only remove it) or not (both can only add it), so an
 * opposite-direction conflict inside one run cannot occur; across runs Control wins - see
 * [GatewaySystemBlocklistMirror.flushReports].
 */
internal fun systemBlocklistSyncPlan(
    mode: PhoneSyncMode,
    targets: Set<String>,
    baseline: Set<String>,
    present: Set<String>,
    bootstrap: Boolean,
    pendingAdds: Set<String> = emptySet(),
    pendingRemoves: Set<String> = emptySet(),
): SystemBlocklistSyncPlan {
    val control = targets + pendingAdds - pendingRemoves
    val b = if (bootstrap) baseline intersect present else baseline
    val phoneAdds = present - b - control
    val phoneRemoves = (b - present) intersect control
    val controlAdds = control - b - present
    val controlRemoves = (b intersect present) - control
    return if (mode == PhoneSyncMode.ON) {
        SystemBlocklistSyncPlan(controlAdds, controlRemoves, phoneAdds to phoneRemoves, baseline - b,
            phoneAdds, phoneRemoves, controlAdds, controlRemoves, control)
    } else {
        val owned = baseline intersect present
        SystemBlocklistSyncPlan(targets - present, owned - targets, emptySet<String>() to emptySet(),
            baseline - present, phoneAdds, phoneRemoves, controlAdds, controlRemoves, targets)
    }
}

/** Baseline after the run's provider writes. `on`: the agreed set, keeping failed deletes so they retry. */
internal fun systemBlocklistNextBaseline(
    mode: PhoneSyncMode,
    plan: SystemBlocklistSyncPlan,
    baseline: Set<String>,
    present: Set<String>,
    inserted: Set<String>,
    removed: Set<String>,
): Set<String> = if (mode == PhoneSyncMode.ON) {
    val agreed = plan.control + plan.report.first - plan.report.second
    ((present + inserted - removed) intersect agreed) + (plan.remove - removed)
} else {
    (baseline intersect present) + inserted - removed
}

internal fun systemBlocklistPhoneChangesPayload(
    eventId: String,
    adds: Collection<String>,
    removes: Collection<String>,
    observedAt: String,
): JSONObject = JSONObject()
    .put("eventId", eventId)
    .put("adds", JSONArray(adds))
    .put("removes", JSONArray(removes))
    .put("observedAt", observedAt)

/** Last four digits only: the diag stream never carries a whole blocked number. */
internal fun systemBlocklistSample(keys: Collection<String>): List<String> =
    keys.sorted().take(10).map { it.filter(Char::isDigit).takeLast(4) }

internal object GatewaySystemBlocklistMirror {
    // Serial, never concurrent: a snapshot that lands mid-run is mirrored by the next turn, which
    // re-reads the store. A single daemon thread also makes the chunk loop free.
    private val worker = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "gateway-blocklist-mirror").apply { isDaemon = true }
    }
    private val started = AtomicBoolean(false)
    private var debounced: ScheduledFuture<*>? = null
    private var lastPlanLog: String? = null
    private val LOCK = Any()

    /** Service start: provider observer (2 s debounce) plus a 60 s fallback turn, both once per process. */
    fun start(context: Context) {
        val application = context.applicationContext
        schedule(application)
        if (!started.compareAndSet(false, true)) return
        runCatching {
            worker.scheduleWithFixedDelay({ runGuarded(application) }, FALLBACK_S, FALLBACK_S, TimeUnit.SECONDS)
        }
        // A missing observer only costs latency: the 60 s turn still runs.
        runCatching {
            application.contentResolver.registerContentObserver(
                BlockedNumberContract.BlockedNumbers.CONTENT_URI, true,
                object : ContentObserver(null) {
                    override fun onChange(selfChange: Boolean, uri: Uri?) = scheduleDebounced(application)
                },
            )
        }
    }

    fun schedule(context: Context) {
        val application = context.applicationContext
        runCatching { worker.execute { runGuarded(application) } }
    }

    private fun scheduleDebounced(context: Context) = synchronized(this) {
        debounced?.cancel(false)
        debounced = runCatching {
            worker.schedule({ runGuarded(context) }, DEBOUNCE_MS, TimeUnit.MILLISECONDS)
        }.getOrNull()
    }

    /** Heartbeat: persists `numberBlocklist.phoneSync`; true when it changed, so a turn should run. */
    fun updateMode(context: Context, wire: String?): Boolean {
        val mode = PhoneSyncMode.parse(wire)
        val prefs = prefs(context)
        if (prefs.getString(KEY_MODE, null) == mode.wire) return false
        prefs.edit().putString(KEY_MODE, mode.wire).commit()
        return true
    }

    private fun runGuarded(context: Context) {
        runCatching { mirror(context) }.onFailure {
            GatewayDiag.log("blocklist.mirror", mapOf(
                "inserted" to 0, "failed" to 0, "removed" to 0, "healed" to 0, "reported" to 0,
                "reason" to (it.message ?: it.javaClass.simpleName).take(120),
            ), level = "warn")
        }
    }

    private fun prefs(context: Context): SharedPreferences = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun mirror(context: Context) {
        // No owned SIM (Control sends no items) is no authority at all, never "everything was unblocked".
        // S66: a pre-S66 snapshot (unknown version, no SMS list) is no authority either; wait for Control.
        val snapshot = GatewayNumberBlocklistStore(context).snapshot()
            ?.takeIf { it.items.isNotEmpty() && it.version >= 0 } ?: return
        val key = ::systemBlocklistKey
        val prefs = prefs(context)
        val mode = PhoneSyncMode.parse(prefs.getString(KEY_MODE, null))
        val bindings = GatewaySimBindingStore(context)
        val targets = systemBlocklistTargets(snapshot.items, key) { bindings.bySimId(it)?.countryIso }
        val stored = prefs.getStringSet(KEY, emptySet()).orEmpty()
        val overlay = synchronized(LOCK) { pruneReports(prefs, snapshot.version) }
        if (mode == PhoneSyncMode.OFF && targets.isEmpty() && stored.isEmpty()) return

        val (readExit, readOutput) = runSuSession(SYSTEM_BLOCKLIST_QUERY)
        if (!systemBlocklistQueryAnswered(readExit, readOutput)) {
            GatewayDiag.log("blocklist.mirror", mapOf(
                "inserted" to 0, "failed" to 0, "removed" to 0, "healed" to 0, "reported" to 0,
                "reason" to "read_su_exit_$readExit",
            ), level = "warn")
            return
        }
        val rows = systemBlocklistRows(readOutput, key)
        val pendingAdds = overlay.flatMap { it.adds.keys }.toSet()
        val pendingRemoves = overlay.flatMap { it.removes.keys }.toSet()
        val plan = systemBlocklistSyncPlan(
            mode, targets.keys, stored, rows.keys,
            bootstrap = prefs.getString(KEY_LAST_MODE, null) != PhoneSyncMode.ON.wire,
            pendingAdds = pendingAdds, pendingRemoves = pendingRemoves,
        )
        if (mode == PhoneSyncMode.DRY_RUN) logPlan(plan)

        // A phone change is durable before anything else moves: B may only advance past a change
        // once the report that carries it to Control is in the outbox.
        var reported = 0
        val (reportAdds, reportRemoves) = plan.report
        if (reportAdds.isNotEmpty() || reportRemoves.isNotEmpty()) {
            val controlSpelling = overlay.fold(targets.toMutableMap()) { acc, r -> acc.apply { putAll(r.adds) } }
            val adds = reportAdds.associateWith { rows.getValue(it).first().original }
            val removes = reportRemoves.associateWith { controlSpelling[it] ?: it }
            synchronized(LOCK) { enqueueReports(prefs, adds, removes) }
            reported = adds.size + removes.size
        }

        val baseline = if (mode == PhoneSyncMode.ON) stored - plan.healed else stored
        val present = rows.keys
        val inserted = mutableSetOf<String>()
        val removed = mutableSetOf<String>()
        val save = {
            prefs.edit().putStringSet(KEY,
                systemBlocklistNextBaseline(mode, plan, baseline, present, inserted, removed)).commit()
        }
        var removeReason: String? = null
        // Deletes run first and by the exact rows the provider just reported for that key.
        for (chunk in plan.remove.chunked(CHUNK)) {
            val deletable = chunk.flatMap { rows[it].orEmpty() }.filter { MIRRORABLE_NUMBER.matches(it.original) }
            if (deletable.isEmpty()) continue
            val (exit, output) = try {
                runSuSession(systemBlocklistDeleteScript(deletable))
            } catch (error: Exception) {
                removeReason = (error.message ?: error.javaClass.simpleName).take(120)
                break
            }
            // Only a table that answered and no longer carries the key is proof of the delete.
            val gone = if (systemBlocklistQueryAnswered(exit, output)) {
                chunk.toSet() - systemBlocklistPresentKeys(output, key)
            } else emptySet()
            if (gone.isEmpty()) {
                removeReason = errorLine(output) ?: "su_exit_$exit"
                break
            }
            removed += gone
            save()
        }
        // A failed delete never holds back inserts: blocking new numbers is the mirror's first job.
        var reason: String? = null
        // ponytail: one `su` session per CHUNK numbers, not one for the whole list - each `content`
        // line is a cold app_process launch, so 400+ of them do not fit the 120 s ceiling.
        for (chunk in plan.insert.mapNotNull { k -> targets[k]?.let { k to it } }.chunked(CHUNK)) {
            val (exit, output) = try {
                runSuSession(systemBlocklistInsertScript(chunk.map { it.second }))
            } catch (error: Exception) {
                reason = (error.message ?: error.javaClass.simpleName).take(120)
                break
            }
            val landed = chunk.map { it.first }.toSet().intersect(systemBlocklistPresentKeys(output, key))
            if (landed.isEmpty()) {
                // A denied Magisk grant exits non-zero and prints nothing; a rejected insert prints.
                reason = errorLine(output) ?: "su_exit_$exit"
                break
            }
            inserted += landed
            save()
        }
        save()
        prefs.edit().putString(KEY_LAST_MODE, mode.wire).commit()

        val failed = plan.insert.size - inserted.size + plan.remove.size - removed.size
        if (plan.insert.isEmpty() && plan.remove.isEmpty() && plan.healed.isEmpty() && reported == 0) return
        GatewayDiag.log("blocklist.mirror", mapOf(
            "mode" to mode.wire, "inserted" to inserted.size, "failed" to failed,
            "removed" to removed.size, "healed" to plan.healed.size, "reported" to reported,
            "phoneAdds" to reportAdds.size, "phoneRemoves" to reportRemoves.size,
            "reason" to (reason ?: removeReason),
        ), level = if (failed > 0) "warn" else "info")
    }

    /** `dry_run`: the full plan, logged only when it differs from the last one so the 60 s turn is quiet. */
    private fun logPlan(plan: SystemBlocklistSyncPlan) {
        val fields = mapOf(
            "phoneAdds" to plan.phoneAdds.size, "phoneRemoves" to plan.phoneRemoves.size,
            "controlAdds" to plan.controlAdds.size, "controlRemoves" to plan.controlRemoves.size,
            "sample" to systemBlocklistSample(plan.phoneAdds + plan.phoneRemoves),
        )
        val signature = (plan.phoneAdds.sorted() + "|" + plan.phoneRemoves.sorted() + "|" +
            plan.controlAdds.sorted() + "|" + plan.controlRemoves.sorted()).joinToString(",")
        if (signature == lastPlanLog) return
        lastPlanLog = signature
        GatewayDiag.log("blocklist.sync_plan", fields)
    }

    private fun errorLine(output: String): String? =
        output.lineSequence().firstOrNull { it.contains("Error", ignoreCase = true) }?.trim()?.take(120)

    // ---- phone-change outbox: `reports` in the same prefs, key -> spelling per direction ----

    private class Report(
        val eventId: String,
        val payload: JSONObject,
        val adds: Map<String, String>,
        val removes: Map<String, String>,
        val attempts: Int,
        /** Store version when Control acknowledged a change; null while unacknowledged. */
        val ackedAt: Long?,
    ) {
        fun toJson(): JSONObject = JSONObject().put("eventId", eventId).put("payload", payload)
            .put("adds", JSONObject(adds)).put("removes", JSONObject(removes))
            .put("attempts", attempts).put("ackedAt", ackedAt ?: JSONObject.NULL)
    }

    private fun readReports(prefs: SharedPreferences): List<Report> = runCatching {
        val array = JSONArray(prefs.getString(KEY_REPORTS, "[]"))
        List(array.length()) { i ->
            val o = array.getJSONObject(i)
            fun map(name: String) = o.getJSONObject(name).let { m -> m.keys().asSequence().associateWith(m::getString) }
            Report(o.getString("eventId"), o.getJSONObject("payload"), map("adds"), map("removes"),
                o.optInt("attempts"), if (o.isNull("ackedAt")) null else o.getLong("ackedAt"))
        }
    }.getOrDefault(emptyList())

    private fun writeReports(prefs: SharedPreferences, reports: List<Report>) {
        check(prefs.edit().putString(KEY_REPORTS, JSONArray(reports.map(Report::toJson)).toString()).commit()) {
            "blocklist report commit failed"
        }
    }

    /** Drops acknowledged reports once a newer snapshot carries them; the rest overlay C. */
    private fun pruneReports(prefs: SharedPreferences, version: Long): List<Report> {
        val all = readReports(prefs)
        val live = all.filter { it.ackedAt == null || version <= it.ackedAt }
        if (live.size != all.size) writeReports(prefs, live)
        return live
    }

    private fun enqueueReports(prefs: SharedPreferences, adds: Map<String, String>, removes: Map<String, String>) {
        val observedAt = Instant.now().toString()
        val next = readReports(prefs).toMutableList()
        val addChunks = adds.entries.chunked(REPORT_LIMIT)
        val removeChunks = removes.entries.chunked(REPORT_LIMIT)
        for (i in 0 until maxOf(addChunks.size, removeChunks.size)) {
            val a = addChunks.getOrNull(i).orEmpty().associate { it.key to it.value }
            val r = removeChunks.getOrNull(i).orEmpty().associate { it.key to it.value }
            val eventId = UUID.randomUUID().toString()
            next += Report(eventId, systemBlocklistPhoneChangesPayload(eventId, a.values, r.values, observedAt),
                a, r, 0, null)
        }
        writeReports(prefs, next)
    }

    /**
     * Heartbeat cycle: sends unacknowledged reports. Never throws. `generation` is frozen into the
     * payload on the first attempt so a retry is byte-identical for Control's `eventId` replay.
     * A refused report (409 `PHONE_SYNC_DISABLED`, any other non-retryable 4xx, or the attempt budget)
     * lets Control win: its adds leave B, so no mode ever deletes a phone row Control never agreed to.
     */
    fun flushReports(context: Context, api: GatewayApi, generation: Long) {
        runCatching {
            if (generation <= 0) return
            val prefs = prefs(context)
            val pending = synchronized(LOCK) { readReports(prefs) }.filter { it.ackedAt == null }
            var settledAny = false
            for (report in pending) {
                val payload = JSONObject(report.payload.toString())
                if (!payload.has("generation")) payload.put("generation", generation)
                val outcome = runCatching { api.reportBlocklistPhoneChanges(payload) }
                val response = outcome.getOrNull()
                val error = outcome.exceptionOrNull() as? GatewayApiHttpError
                val retryable = error?.let {
                    it.code != "PHONE_SYNC_DISABLED" && interceptionRetryable(it.status)
                } ?: true
                synchronized(LOCK) {
                    val all = readReports(prefs)
                    val current = all.firstOrNull { it.eventId == report.eventId } ?: return@synchronized
                    val rest = all.filter { it !== current }
                    when {
                        response != null -> {
                            val changed = response.optInt("added") + response.optInt("removed") > 0
                            val version = GatewayNumberBlocklistStore(context).knownVersion() ?: 0
                            writeReports(prefs, if (changed) all.map {
                                if (it === current) Report(it.eventId, payload, it.adds, it.removes, it.attempts + 1, version) else it
                            } else rest)
                            GatewayDiag.log("blocklist.reported", mapOf(
                                "added" to response.optInt("added"), "removed" to response.optInt("removed"),
                                "rejected" to response.optInt("rejected"), "replayed" to response.optBoolean("replayed"),
                            ))
                            settledAny = true
                        }
                        shouldRetireInterception(current.attempts + 1, retryable) -> {
                            // Settled on the mirror thread: dropping the report and its adds from B must be
                            // one step no mirror turn can fall between, or that turn deletes a hand block.
                            runCatching { worker.execute { settleRefused(prefs, report.eventId) } }
                            GatewayDiag.log("blocklist.reported", mapOf(
                                "refused" to (error?.code ?: error?.status ?: "attempts"),
                                "adds" to current.adds.size, "removes" to current.removes.size,
                            ), level = "warn")
                            settledAny = true
                        }
                        else -> writeReports(prefs, all.map {
                            if (it === current) Report(it.eventId, payload, it.adds, it.removes, it.attempts + 1, null) else it
                        })
                    }
                }
                // One failure per cycle: the rest wait for the next heartbeat rather than hammer a refusing route.
                if (response == null) break
            }
            if (settledAny) schedule(context)
        }
    }

    private fun settleRefused(prefs: SharedPreferences, eventId: String) {
        val refused = synchronized(LOCK) {
            val all = readReports(prefs)
            val report = all.firstOrNull { it.eventId == eventId } ?: return
            writeReports(prefs, all - report)
            report
        }
        val baseline = prefs.getStringSet(KEY, emptySet()).orEmpty()
        prefs.edit().putStringSet(KEY, baseline - refused.adds.keys).commit()
    }

    /** Exit status (null when the timeout destroyed it) and the merged stdout/stderr of one session. */
    private fun runSuSession(script: String): Pair<Int?, String> {
        val process = ProcessBuilder("su").redirectErrorStream(true).start()
        val output = StringBuilder()
        // The reader runs apart from the wait so a full pipe cannot deadlock the timeout away.
        val reader = Thread({
            runCatching {
                process.inputStream.bufferedReader().forEachLine { synchronized(output) { output.appendLine(it) } }
            }
        }, "gateway-blocklist-su").apply { isDaemon = true; start() }
        runCatching { process.outputStream.bufferedWriter().use { it.write(script) } }
        val exited = process.waitFor(TIMEOUT_MS, TimeUnit.MILLISECONDS)
        if (!exited) process.destroy()
        reader.join(1_000)
        return (if (exited) process.exitValue() else null) to synchronized(output) { output.toString() }
    }

    private const val PREFS = "gateway_system_blocklist_mirror"
    private const val KEY = "mirrored"
    private const val KEY_MODE = "phone_sync_mode"
    private const val KEY_LAST_MODE = "last_run_mode"
    private const val KEY_REPORTS = "phone_change_reports"
    private const val CHUNK = 100
    private const val REPORT_LIMIT = 500
    private const val TIMEOUT_MS = 120_000L
    private const val DEBOUNCE_MS = 2_000L
    private const val FALLBACK_S = 60L
}
