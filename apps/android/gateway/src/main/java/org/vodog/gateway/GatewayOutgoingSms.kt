package org.vodog.gateway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

internal const val OUTGOING_SMS_BACKFILL_DAYS = 2L
internal const val OUTGOING_SMS_SCAN_LIMIT = 200
private const val OUTGOING_SMS_FULL_RETENTION_SECONDS = 7L * 24 * 60 * 60
private const val OUTGOING_SMS_TOMBSTONE_RETENTION_SECONDS = 30L * 24 * 60 * 60

internal data class OutgoingSmsProviderRow(
    val providerRowId: Long,
    val providerDateMillis: Long,
    val subscriptionId: Int,
    val remoteNumber: String,
    val body: String,
    val sentAtMillis: Long,
    val creator: String?,
    val type: Int,
)

internal data class OutgoingSmsObservedRecord(
    val eventId: String,
    val providerRowId: Long,
    val providerDateMillis: Long,
    val generation: Long,
    val simId: String,
    val assignmentVersion: Int,
    val subscriptionId: Int,
    val phoneAccountHandle: String?,
    val iccidFingerprint: String,
    val remoteNumber: String,
    val body: String,
    val sentAt: String,
    val reported: Boolean = false,
    val reportedAt: String? = null,
    val tombstone: Boolean = false,
)

internal fun outgoingSmsObservedEventId(
    providerRowId: Long,
    generation: Long,
    simId: String,
    iccidFingerprint: String,
    providerDateMillis: Long,
): String = UUID.nameUUIDFromBytes(
    "vodog:sms-outgoing-observed:$generation:$simId:$iccidFingerprint:$providerRowId:$providerDateMillis"
        .toByteArray(Charsets.UTF_8),
).toString()

internal fun outgoingSmsBackfillStartMillis(nowMillis: Long): Long =
    nowMillis - Duration.ofDays(OUTGOING_SMS_BACKFILL_DAYS).toMillis()

internal fun outgoingSmsProviderSentAtMillis(providerDateMillis: Long, providerDateSentMillis: Long): Long =
    providerDateSentMillis.takeIf { it > 0L } ?: providerDateMillis

internal fun outgoingSmsObservedRecord(
    row: OutgoingSmsProviderRow,
    generation: Long,
    binding: ServerSimBinding,
    sim: SimSnapshot,
    gatewayPackageName: String,
): OutgoingSmsObservedRecord? {
    if (row.type != Telephony.Sms.MESSAGE_TYPE_SENT || row.providerRowId <= 0L || generation <= 0L) return null
    // Unknown origin (null creator) is not reported: it could be this gateway's own SmsManager send.
    if (row.creator == null || row.creator == gatewayPackageName) return null
    if (row.subscriptionId != binding.subscriptionId || row.subscriptionId != sim.subscriptionId) return null
    if (binding.simId.isBlank() || binding.assignmentVersion <= 0 || !binding.routable) return null
    if (sim.iccidFingerprint == null || sim.iccidFingerprint != binding.iccidFingerprint) return null
    if (sim.protectedPhoneAccountHandle != binding.phoneAccountHandle) return null
    val remote = row.remoteNumber.trim()
    val body = row.body
    if (remote.length !in 1..64 || body.length !in 1..5000 || row.sentAtMillis <= 0L) return null
    val sentAt = runCatching { Instant.ofEpochMilli(row.sentAtMillis).toString() }.getOrNull() ?: return null
    val providerDateMillis = row.providerDateMillis.takeIf { it > 0L } ?: row.sentAtMillis
    return OutgoingSmsObservedRecord(
        eventId = outgoingSmsObservedEventId(
            row.providerRowId, generation, binding.simId, binding.iccidFingerprint, providerDateMillis,
        ),
        providerRowId = row.providerRowId,
        providerDateMillis = providerDateMillis,
        generation = generation,
        simId = binding.simId,
        assignmentVersion = binding.assignmentVersion,
        subscriptionId = binding.subscriptionId,
        phoneAccountHandle = binding.phoneAccountHandle,
        iccidFingerprint = binding.iccidFingerprint,
        remoteNumber = remote,
        body = body,
        sentAt = sentAt,
    )
}

internal fun eligibleOutgoingSmsBinding(
    record: OutgoingSmsObservedRecord,
    current: ServerSimBinding?,
    deviceEpoch: Long,
): Boolean {
    if (record.generation != deviceEpoch) return false
    if (current == null) return true
    return record.simId == current.simId && record.subscriptionId == current.subscriptionId &&
        record.iccidFingerprint == current.iccidFingerprint && record.phoneAccountHandle == current.phoneAccountHandle
}

internal fun compactOutgoingSmsObservedRecords(
    records: List<OutgoingSmsObservedRecord>,
    now: Instant,
): List<OutgoingSmsObservedRecord> = records.mapNotNull { record ->
    val reportedAt = record.reportedAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        ?: return@mapNotNull record
    val ageSeconds = Duration.between(reportedAt, now).seconds
    if (record.tombstone && ageSeconds >= OUTGOING_SMS_TOMBSTONE_RETENTION_SECONDS) return@mapNotNull null
    if (!record.tombstone && record.reported && ageSeconds >= OUTGOING_SMS_FULL_RETENTION_SECONDS) {
        record.copy(
            phoneAccountHandle = null,
            iccidFingerprint = "",
            remoteNumber = "",
            body = "",
            tombstone = true,
        )
    } else record
}

internal class OutgoingSmsObservationJournal(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun enqueue(record: OutgoingSmsObservedRecord) = synchronized(LOCK) {
        val rows = mergeOutgoingSmsObservation(compactOutgoingSmsObservedRecords(records(), Instant.now()), record)
        check(rows.count { !it.tombstone } <= MAX_FULL_RECORDS && rows.size <= MAX_TOTAL_RECORDS) {
            "outgoing SMS observation journal capacity exhausted"
        }
        write(rows)
    }

    fun pending(): List<OutgoingSmsObservedRecord> = synchronized(LOCK) {
        val stored = records()
        val compacted = compactOutgoingSmsObservedRecords(stored, Instant.now())
        if (compacted != stored) write(compacted)
        pendingOutgoingSmsObservations(compacted)
    }

    fun markReported(eventId: String) = synchronized(LOCK) {
        val now = Instant.now()
        write(markOutgoingSmsObservationReported(compactOutgoingSmsObservedRecords(records(), now), eventId, now))
    }

    /** Provider keys (rowId, subscriptionId, date) already journaled; one read per scan. */
    fun observedKeys(): MutableSet<Triple<Long, Int, Long>> = synchronized(LOCK) {
        records().mapTo(HashSet()) { Triple(it.providerRowId, it.subscriptionId, it.providerDateMillis) }
    }

    private fun records(): List<OutgoingSmsObservedRecord> = try {
        decodeOutgoingSmsObservedRecords(prefs.getString(KEY_RECORDS, "[]") ?: "[]")
    } catch (_: Exception) {
        throw IllegalStateException("outgoing SMS observation journal is unreadable")
    }

    private fun write(records: List<OutgoingSmsObservedRecord>) {
        check(prefs.edit().putString(KEY_RECORDS, encodeOutgoingSmsObservedRecords(records)).commit()) {
            "outgoing SMS observation journal commit failed"
        }
    }

    private companion object {
        const val NAME = "gateway_outgoing_sms_observations"
        const val KEY_RECORDS = "records"
        const val MAX_FULL_RECORDS = 512
        const val MAX_TOTAL_RECORDS = 2_048
        val LOCK = Any()
    }
}

/** First observation wins: a re-observed provider row never replaces the frozen record (or its sentAt). */
internal fun mergeOutgoingSmsObservation(
    rows: List<OutgoingSmsObservedRecord>,
    record: OutgoingSmsObservedRecord,
): List<OutgoingSmsObservedRecord> =
    if (rows.any { it.eventId == record.eventId || sameProviderSource(it, record) }) rows else rows + record

internal fun pendingOutgoingSmsObservations(rows: List<OutgoingSmsObservedRecord>): List<OutgoingSmsObservedRecord> =
    rows.filter { !it.reported && !it.tombstone }

internal fun markOutgoingSmsObservationReported(
    rows: List<OutgoingSmsObservedRecord>,
    eventId: String,
    now: Instant,
): List<OutgoingSmsObservedRecord> =
    rows.map { if (it.eventId == eventId) it.copy(reported = true, reportedAt = now.toString()) else it }

private fun sameProviderSource(a: OutgoingSmsObservedRecord, b: OutgoingSmsObservedRecord): Boolean =
    a.providerRowId == b.providerRowId && a.subscriptionId == b.subscriptionId &&
        a.providerDateMillis == b.providerDateMillis

internal fun encodeOutgoingSmsObservedRecords(records: List<OutgoingSmsObservedRecord>): String =
    JSONArray().also { out ->
        records.forEach { record ->
            out.put(JSONObject()
                .put("eventId", record.eventId)
                .put("providerRowId", record.providerRowId)
                .put("providerDateMillis", record.providerDateMillis)
                .put("generation", record.generation)
                .put("simId", record.simId)
                .put("assignmentVersion", record.assignmentVersion)
                .put("subscriptionId", record.subscriptionId)
                .put("phoneAccountHandle", record.phoneAccountHandle ?: JSONObject.NULL)
                .put("iccidFingerprint", record.iccidFingerprint)
                .put("remoteNumber", record.remoteNumber)
                .put("body", record.body)
                .put("sentAt", record.sentAt)
                .put("reported", record.reported)
                .put("reportedAt", record.reportedAt ?: JSONObject.NULL)
                .put("tombstone", record.tombstone))
        }
    }.toString()

internal fun decodeOutgoingSmsObservedRecords(raw: String): List<OutgoingSmsObservedRecord> {
    val array = JSONArray(raw)
    return List(array.length()) { index ->
        array.getJSONObject(index).let { item ->
            val sentAt = item.getString("sentAt")
            OutgoingSmsObservedRecord(
                eventId = item.getString("eventId"),
                providerRowId = item.getLong("providerRowId"),
                providerDateMillis = if (item.has("providerDateMillis")) item.getLong("providerDateMillis")
                else Instant.parse(sentAt).toEpochMilli(),
                generation = item.getLong("generation"),
                simId = item.getString("simId"),
                assignmentVersion = item.getInt("assignmentVersion"),
                subscriptionId = item.getInt("subscriptionId"),
                phoneAccountHandle = item.outgoingSmsNullable("phoneAccountHandle"),
                iccidFingerprint = item.getString("iccidFingerprint"),
                remoteNumber = item.getString("remoteNumber"),
                body = item.getString("body"),
                sentAt = sentAt,
                reported = item.optBoolean("reported"),
                reportedAt = item.outgoingSmsNullable("reportedAt"),
                tombstone = item.optBoolean("tombstone"),
            )
        }
    }
}

private fun JSONObject.outgoingSmsNullable(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

/**
 * Watches the platform SMS provider only while the gateway service is ON. Every discovered row is
 * journaled before the heartbeat is woken, so a process/network failure can only cause a safe replay.
 */
internal class GatewayOutgoingSmsObserver(
    private val context: Context,
    private val wake: () -> Unit,
) {
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "vodog-sms-sent-observer").apply { isDaemon = true }
    }
    private val scanRunning = AtomicBoolean(false)
    private val scanRequested = AtomicBoolean(false)
    private var registered = false
    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean, uri: Uri?) {
            scheduleScan()
        }
    }

    fun start() {
        if (registered) {
            scheduleScan()
            return
        }
        if (context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) return
        context.contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, observer)
        registered = true
        scheduleScan()
    }

    fun stop() {
        if (registered) runCatching { context.contentResolver.unregisterContentObserver(observer) }
        registered = false
        executor.shutdownNow()
    }

    private fun scheduleScan() {
        if (!GatewayRuntimeStore(context).enabled || executor.isShutdown) return
        scanRequested.set(true)
        if (!scanRunning.compareAndSet(false, true)) return
        executor.execute {
            var enqueued = false
            try {
                while (scanRequested.getAndSet(false) && GatewayRuntimeStore(context).enabled) {
                    runCatching { scanOnce() }
                        .onSuccess { if (it) enqueued = true }
                        .onFailure { SmsReceiverHealthStore(context).recordFailure("outgoing_sms_scan_failed") }
                }
            } finally {
                scanRunning.set(false)
                if (scanRequested.get() && GatewayRuntimeStore(context).enabled) scheduleScan()
                if (enqueued) wake()
            }
        }
    }

    /** Returns true when at least one new record was journaled. */
    private fun scanOnce(): Boolean {
        val runtime = GatewayRuntimeStore(context)
        val generation = runtime.deviceEpoch
        if (!runtime.enabled || generation <= 0L) return false
        if (context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) return false
        val active = DeviceStatusReader(context).activeSims()
        val bindings = GatewaySimBindingStore(context)
        val routes = active.mapNotNull { sim ->
            val binding = bindings.bySubscriptionId(sim.subscriptionId) ?: return@mapNotNull null
            if (binding.iccidFingerprint != sim.iccidFingerprint ||
                binding.phoneAccountHandle != sim.protectedPhoneAccountHandle || !binding.routable) return@mapNotNull null
            sim.subscriptionId to (binding to sim)
        }.toMap()
        if (routes.isEmpty()) return false

        val projection = arrayOf("_id", "address", "body", "date", "date_sent", "sub_id", "creator", "type")
        val selection = "date>=?"
        val selectionArgs = arrayOf(outgoingSmsBackfillStartMillis(System.currentTimeMillis()).toString())
        val journal = OutgoingSmsObservationJournal(context)
        val observed = journal.observedKeys()
        var enqueued = false
        context.contentResolver.query(
            Telephony.Sms.Sent.CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            "date DESC",
        )?.use { cursor ->
            var read = 0
            while (read < OUTGOING_SMS_SCAN_LIMIT && cursor.moveToNext()) {
                read++
                val providerDateMillis = cursor.getLong(3)
                val row = OutgoingSmsProviderRow(
                    providerRowId = cursor.getLong(0),
                    providerDateMillis = providerDateMillis,
                    remoteNumber = cursor.getString(1).orEmpty(),
                    body = cursor.getString(2).orEmpty(),
                    sentAtMillis = outgoingSmsProviderSentAtMillis(providerDateMillis, cursor.getLong(4)),
                    subscriptionId = cursor.getInt(5),
                    creator = cursor.getString(6),
                    type = cursor.getInt(7),
                )
                val route = routes[row.subscriptionId] ?: continue
                val record = outgoingSmsObservedRecord(
                    row = row,
                    generation = generation,
                    binding = route.first,
                    sim = route.second,
                    gatewayPackageName = context.packageName,
                ) ?: continue
                if (observed.add(Triple(record.providerRowId, record.subscriptionId, record.providerDateMillis))) {
                    journal.enqueue(record)
                    enqueued = true
                }
            }
        }
        return enqueued
    }
}
