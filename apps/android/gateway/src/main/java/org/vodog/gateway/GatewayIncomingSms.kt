package org.vodog.gateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.util.UUID

data class SmsConcatHeader(val reference: Int, val index: Int, val count: Int)
data class IncomingSmsSegment(val header: SmsConcatHeader?, val body: String, val sourceDigest: String)
data class IncomingSmsRecord(
    val eventId: String,
    val generation: Long,
    val simIdAtReceipt: String?,
    val assignmentVersionAtReceipt: Int?,
    val subscriptionId: Int,
    val phoneAccountHandle: String?,
    val iccidFingerprint: String,
    val remoteNumber: String,
    val body: String,
    val receivedAt: String,
    val reported: Boolean,
    val reportedAt: String? = null,
    val tombstone: Boolean = false,
)

class GatewaySmsReceivedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!SmsExecutionApproval.APPROVED) return
        if (!GatewayRuntimeStore(context).enabled) return
        val pendingResult = goAsync()
        EXECUTOR.execute {
            try {
                GatewayReplayMigrationBarrier.withLock {
                    // A pending migration receipt cannot change the runtime epoch here: it first
                    // needs an authenticated Control preflight lookup. Journal any newly delivered
                    // SMS in the current epoch so the migration remains blocked for explicit audit.
                    process(context.applicationContext, intent)
                }
            } catch (_: Exception) {
                SmsReceiverHealthStore(context).recordFailure("sms_receive_processing_failed")
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun process(context: Context, intent: Intent) {
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isEmpty()) return
        val subscriptionId = intent.getIntExtra(
            SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX, SubscriptionManager.INVALID_SUBSCRIPTION_ID,
        )
        val sim = DeviceStatusReader(context).activeSims().singleOrNull {
            it.subscriptionId == subscriptionId && it.iccidFingerprint != null
        } ?: return
        val remote = messages.firstNotNullOfOrNull { it.originatingAddress?.takeIf(String::isNotBlank) } ?: return
        val pdus = (intent.extras?.get("pdus") as? Array<*>)?.mapNotNull { it as? ByteArray }.orEmpty()
        val format = intent.getStringExtra("format")
        val segments = messages.mapIndexed { index, message ->
            IncomingSmsSegment(
                pdus.getOrNull(index)?.let { parseGsmConcatHeader(it, format) },
                message.messageBody.orEmpty(),
                incomingDigest(
                    pdus.getOrNull(index)?.let(::listOf).orEmpty(), remote,
                    listOf(message.timestampMillis to message.messageBody.orEmpty()),
                ),
            )
        }
        val bindingAtReceipt = GatewaySimBindingStore(context).bySubscriptionId(subscriptionId)
            ?.takeIf { it.iccidFingerprint == sim.iccidFingerprint &&
                it.phoneAccountHandle == sim.protectedPhoneAccountHandle }
        val listed = bindingAtReceipt != null && GatewayNumberBlocklistStore(context).isSmsListed(
            bindingAtReceipt.simId, remote, bindingAtReceipt.countryIso,
        )
        val broadcastDigest = incomingDigest(
            pdus, remote, messages.map { it.timestampMillis to it.messageBody.orEmpty() },
        )
        if (shouldDropIncomingSms(GatewayRuntimeStore(context).enabled, listed)) {
            // S21 §B "拦截即记录": the message still never enters the incoming journal's main table,
            // but the owner gets one durable interception report carrying the body. The whole
            // broadcast is one interception, and its digest makes the event ID deterministic, so a
            // re-delivered broadcast is idempotent on the control side.
            enqueueBlockedSmsInterception(
                context,
                generation = GatewayRuntimeStore(context).deviceEpoch,
                simId = bindingAtReceipt?.simId,
                assignmentVersion = bindingAtReceipt?.assignmentVersion,
                iccidFingerprint = requireNotNull(sim.iccidFingerprint),
                sourceDigest = broadcastDigest,
                remoteNumber = remote.take(MAX_REMOTE_NUMBER_LENGTH),
                body = blockedSmsBody(segments),
                receivedAt = Instant.ofEpochMilli(messages.minOf { it.timestampMillis }).toString(),
            )
            if (GatewayRuntimeStore(context).enabled) ContextCompat.startForegroundService(
                context,
                Intent(context, GatewayForegroundService::class.java)
                    .setAction(GatewayForegroundService.ACTION_SMS_CHANGED),
            )
            return
        }
        if (segments.any { it.body.isNotEmpty() }) {
            IncomingSmsJournal(context).ingest(
                generation = GatewayRuntimeStore(context).deviceEpoch,
                simIdAtReceipt = bindingAtReceipt?.simId,
                assignmentVersionAtReceipt = bindingAtReceipt?.assignmentVersion,
                subscriptionId = subscriptionId,
                phoneAccountHandle = sim.protectedPhoneAccountHandle,
                iccidFingerprint = requireNotNull(sim.iccidFingerprint),
                remoteNumber = remote.take(MAX_REMOTE_NUMBER_LENGTH),
                receivedAt = Instant.ofEpochMilli(messages.minOf { it.timestampMillis }).toString(),
                segments = segments,
                sourceDigest = broadcastDigest,
            )
            if (GatewayRuntimeStore(context).enabled) ContextCompat.startForegroundService(
                context,
                Intent(context, GatewayForegroundService::class.java)
                    .setAction(GatewayForegroundService.ACTION_SMS_CHANGED),
            )
        }
    }

    private companion object {
        const val MAX_REMOTE_NUMBER_LENGTH = 64
        val EXECUTOR = java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "gateway-sms-receiver").apply { isDaemon = true }
        }
    }
}

class SmsReceiverHealthStore(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_sms_receiver_health", Context.MODE_PRIVATE)
    fun recordFailure(category: String) {
        prefs.edit().putString("category", category.take(80)).putString("at", Instant.now().toString()).apply()
    }
    fun summary(): String? = prefs.getString("category", null)?.let { category ->
        "$category · ${prefs.getString("at", "time unavailable")}"
    }
    fun clear() = prefs.edit().clear().apply()
}

class IncomingSmsJournal(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun ingest(
        generation: Long,
        simIdAtReceipt: String?,
        assignmentVersionAtReceipt: Int?,
        subscriptionId: Int,
        phoneAccountHandle: String?,
        iccidFingerprint: String,
        remoteNumber: String,
        receivedAt: String,
        segments: List<IncomingSmsSegment>,
        sourceDigest: String,
    ) = synchronized(LOCK) {
        // Android normally delivers every segment of one multipart SMS in the same protected
        // broadcast. Never combine incomplete broadcasts: reference values are short and reused.
        if (prefs.contains(KEY_ASSEMBLIES)) {
            check(prefs.edit().remove(KEY_ASSEMBLIES).commit()) { "legacy SMS assembly cleanup failed" }
        }
        val hasConcatHeader = segments.any { it.header != null }
        if (hasConcatHeader) {
            val ordered = completeMultipartBatch(segments) ?: return@synchronized
            val first = requireNotNull(segments.first().header)
            val batch = SmsAssembly(
                generation, simIdAtReceipt, assignmentVersionAtReceipt, subscriptionId,
                phoneAccountHandle, iccidFingerprint, remoteNumber, receivedAt, first.reference, first.count,
            )
            val key = incomingMultipartBatchKey(
                generation, simIdAtReceipt, assignmentVersionAtReceipt, iccidFingerprint,
                remoteNumber, first.reference, first.count, receivedAt,
            )
            addComplete(
                batch, ordered.joinToString("") { it.body },
                "concat:$key:${incomingMultipartContentIdentity(ordered)}",
            )
        } else if (segments.size == 1) {
            addComplete(
                SmsAssembly(
                    generation, simIdAtReceipt, assignmentVersionAtReceipt, subscriptionId,
                    phoneAccountHandle, iccidFingerprint, remoteNumber,
                    receivedAt, -1, 1,
                ),
                segments.single().body,
                "pdu:$generation:$iccidFingerprint:$sourceDigest",
            )
        }
    }

    fun pending(): List<IncomingSmsRecord> = synchronized(LOCK) {
        val stored = records()
        val compacted = compactIncomingSmsRecords(stored, Instant.now())
        if (compacted != stored) writeRecords(compacted)
        compacted.filter { !it.reported && !it.tombstone }
    }

    fun markReported(eventId: String) = synchronized(LOCK) {
        val now = Instant.now()
        writeRecords(compactIncomingSmsRecords(records(), now).map {
            if (it.eventId == eventId) it.copy(reported = true, reportedAt = now.toString()) else it
        })
    }

    fun clear() = synchronized(LOCK) { prefs.edit().clear().commit() }

    private fun addComplete(assembly: SmsAssembly, body: String, identity: String) {
        if (body.isEmpty()) return
        val eventId = UUID.nameUUIDFromBytes(identity.toByteArray()).toString()
        val records = compactIncomingSmsRecords(records(), Instant.now()).toMutableList()
        if (records.none { it.eventId == eventId }) records += IncomingSmsRecord(
            eventId, assembly.generation, assembly.simIdAtReceipt, assembly.assignmentVersionAtReceipt,
            assembly.subscriptionId, assembly.phoneAccountHandle,
            assembly.iccidFingerprint, assembly.remoteNumber, body, assembly.receivedAt, false, null, false,
        )
        check(records.count { !it.tombstone } <= MAX_FULL_RECORDS && records.size <= MAX_TOTAL_RECORDS) {
            "incoming SMS journal capacity exhausted"
        }
        writeRecords(records)
    }

    private fun records(): List<IncomingSmsRecord> = parse(KEY_RECORDS) { item ->
        IncomingSmsRecord(
            item.getString("eventId"), item.getLong("generation"), item.smsNullable("simIdAtReceipt"),
            if (item.isNull("assignmentVersionAtReceipt")) null else item.getInt("assignmentVersionAtReceipt"),
            item.getInt("subscriptionId"),
            item.smsNullable("phoneAccountHandle"), item.getString("iccidFingerprint"),
            item.getString("remoteNumber"), item.getString("body"), item.getString("receivedAt"),
            item.optBoolean("reported"), item.smsNullable("reportedAt"), item.optBoolean("tombstone"),
        )
    }

    private fun writeRecords(records: List<IncomingSmsRecord>) = commit(KEY_RECORDS, JSONArray().also { array ->
        records.forEach { record -> array.put(JSONObject()
            .put("eventId", record.eventId).put("generation", record.generation)
            .put("simIdAtReceipt", record.simIdAtReceipt ?: JSONObject.NULL)
            .put("assignmentVersionAtReceipt", record.assignmentVersionAtReceipt ?: JSONObject.NULL)
            .put("subscriptionId", record.subscriptionId)
            .put("phoneAccountHandle", record.phoneAccountHandle ?: JSONObject.NULL)
            .put("iccidFingerprint", record.iccidFingerprint).put("remoteNumber", record.remoteNumber)
            .put("body", record.body).put("receivedAt", record.receivedAt).put("reported", record.reported)
            .put("reportedAt", record.reportedAt ?: JSONObject.NULL).put("tombstone", record.tombstone)) }
    })

    private fun <T> parse(key: String, convert: (JSONObject) -> T): List<T> = try {
        val array = JSONArray(prefs.getString(key, "[]"))
        List(array.length()) { convert(array.getJSONObject(it)) }
    } catch (_: Exception) {
        throw IllegalStateException("incoming SMS journal is unreadable")
    }

    private fun commit(key: String, array: JSONArray) {
        check(prefs.edit().putString(key, array.toString()).commit()) { "incoming SMS journal commit failed" }
    }

    private data class SmsAssembly(
        val generation: Long,
        val simIdAtReceipt: String?,
        val assignmentVersionAtReceipt: Int?,
        val subscriptionId: Int,
        val phoneAccountHandle: String?,
        val iccidFingerprint: String,
        val remoteNumber: String,
        val receivedAt: String,
        val reference: Int,
        val count: Int,
    )

    companion object {
        private const val NAME = "gateway_incoming_sms_journal"
        private const val KEY_RECORDS = "records"
        private const val KEY_ASSEMBLIES = "assemblies"
        private const val MAX_FULL_RECORDS = 512
        private const val MAX_TOTAL_RECORDS = 2_048
        private val LOCK = Any()
    }
}

data class SmsStoredPart(val body: String, val sourceDigest: String)

/** Returns an ordered, complete same-broadcast multipart batch; uncertainty stays local. */
internal fun completeMultipartBatch(segments: List<IncomingSmsSegment>): List<SmsStoredPart>? {
    if (segments.isEmpty() || segments.any { it.header == null }) return null
    val headers = segments.map { requireNotNull(it.header) }
    val identity = headers.map { it.reference to it.count }.distinct().singleOrNull() ?: return null
    val count = identity.second
    if (count <= 1 || segments.size != count) return null
    val indexed = segments.zip(headers).associateBy { it.second.index }
    if (indexed.size != count || (0 until count).any { it !in indexed }) return null
    return (0 until count).map { index ->
        indexed.getValue(index).first.let { SmsStoredPart(it.body, it.sourceDigest) }
    }
}

/**
 * The body of a blocked message. A complete same-broadcast multipart batch is joined in part order;
 * anything else is joined in delivery order, which is all a blocked message needs — it is evidence
 * for the owner, not a receipt that has to match the journal's assembly rules.
 */
internal fun blockedSmsBody(segments: List<IncomingSmsSegment>): String =
    completeMultipartBatch(segments)?.joinToString("") { it.body }
        ?: segments.joinToString("") { it.body }

internal fun incomingMultipartBatchKey(
    generation: Long,
    simId: String?,
    assignmentVersion: Int?,
    iccidFingerprint: String,
    remoteNumber: String,
    reference: Int,
    count: Int,
    receivedAt: String,
): String = "$generation|$simId|$assignmentVersion|$iccidFingerprint|$remoteNumber|$reference|$count|$receivedAt"

internal fun incomingMultipartContentIdentity(parts: Collection<SmsStoredPart>): String = incomingSha256(
    parts.joinToString("|") { it.sourceDigest } + "\u0000" + parts.joinToString("") { it.body },
)

internal fun compactIncomingSmsRecords(records: List<IncomingSmsRecord>, now: Instant): List<IncomingSmsRecord> =
    records.mapNotNull { record ->
        val reportedAt = record.reportedAt?.let(Instant::parse) ?: return@mapNotNull record
        val ageSeconds = Duration.between(reportedAt, now).seconds
        if (record.tombstone && ageSeconds >= INCOMING_TOMBSTONE_RETENTION_SECONDS) return@mapNotNull null
        if (!record.tombstone && record.reported && ageSeconds >= INCOMING_FULL_RETENTION_SECONDS) {
            record.copy(
                phoneAccountHandle = null, iccidFingerprint = "", remoteNumber = "", body = "", tombstone = true,
            )
        } else record
    }

private const val INCOMING_FULL_RETENTION_SECONDS = 7L * 24 * 60 * 60
private const val INCOMING_TOMBSTONE_RETENTION_SECONDS = 30L * 24 * 60 * 60

/** Parses only the standard 3GPP 8/16-bit concatenation UDH; unknown formats stay local. */
internal fun parseGsmConcatHeader(pdu: ByteArray, format: String?): SmsConcatHeader? = runCatching {
    if (format != null && format != "3gpp") return null
    var position = 0
    val smscLength = pdu[position++].toInt() and 0xff
    position += smscLength
    val firstOctet = pdu[position++].toInt() and 0xff
    if (firstOctet and 0x40 == 0) return null
    val addressDigits = pdu[position++].toInt() and 0xff
    position++ // type-of-address
    position += (addressDigits + 1) / 2
    position += 1 + 1 + 7 // PID, DCS, timestamp
    position++ // TP-UDL
    val udhLength = pdu[position++].toInt() and 0xff
    val end = position + udhLength
    while (position + 1 < end) {
        val id = pdu[position++].toInt() and 0xff
        val length = pdu[position++].toInt() and 0xff
        if (position + length > end) return null
        if (id == 0x00 && length == 3) return SmsConcatHeader(
            pdu[position].toInt() and 0xff, (pdu[position + 2].toInt() and 0xff) - 1,
            pdu[position + 1].toInt() and 0xff,
        )
        if (id == 0x08 && length == 4) return SmsConcatHeader(
            ((pdu[position].toInt() and 0xff) shl 8) or (pdu[position + 1].toInt() and 0xff),
            (pdu[position + 3].toInt() and 0xff) - 1, pdu[position + 2].toInt() and 0xff,
        )
        position += length
    }
    null
}.getOrNull()

private fun JSONObject.smsNullable(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

private fun incomingDigest(
    pdus: List<ByteArray>,
    remote: String,
    messages: List<Pair<Long, String>>,
): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    if (pdus.isNotEmpty()) pdus.forEach(digest::update) else {
        digest.update(remote.toByteArray())
        messages.forEach { (timestamp, body) ->
            digest.update(timestamp.toString().toByteArray())
            digest.update(0)
            digest.update(body.toByteArray())
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

private fun incomingSha256(value: String): String = java.security.MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
