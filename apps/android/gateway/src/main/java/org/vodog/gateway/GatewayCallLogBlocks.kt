package org.vodog.gateway

import android.content.Context
import android.net.Uri
import android.provider.CallLog
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

/**
 * S38 §1 手机自动拦截.
 *
 * A third-party [android.telecom.CallScreeningService] (拦截猫) rejects the call before the gateway's
 * own InCallService is ever bound, so no [DeviceCallRecord] exists and the S21 interception path
 * never fires. The BLOCKED CallLog row is the only evidence the block happened at all, so it is
 * backfilled into the same interception outbox, marked `blockSource:"phone"`.
 *
 * The gateway's own blocklist rejects are logged by Telecom as REJECTED (type 5), not BLOCKED, so
 * this pass can never duplicate them; the deterministic `calllog:<_id>` device call id keeps Control
 * idempotent even if the watermark is lost.
 */
class GatewayCallLogWatermarkStore(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_call_log_watermark", Context.MODE_PRIVATE)

    var blockedId: Long
        get() = prefs.getLong(KEY_BLOCKED_ID, 0L)
        set(value) {
            prefs.edit().putLong(KEY_BLOCKED_ID, value.coerceAtLeast(0L)).apply()
        }

    fun clear() = prefs.edit().clear().apply()

    private companion object { const val KEY_BLOCKED_ID = "blocked_id" }
}

/** One BLOCKED CallLog row, read into an app-private value; the number is never logged. */
data class BlockedCallLogRow(
    val id: Long,
    val subscriptionId: Int?,
    val remoteNumber: String?,
    val dateMillis: Long,
    val screeningApp: String? = null,
)

/** S86: only a call-screening-service block names its app (name, else the component's package). */
internal fun blockedCallLogScreeningApp(reason: Int, appName: String?, component: String?): String? =
    if (reason != CallLog.Calls.BLOCK_REASON_CALL_SCREENING_SERVICE) null
    else (appName?.trim()?.takeIf(String::isNotEmpty)
        ?: component?.substringBefore('/')?.trim()?.takeIf(String::isNotEmpty))?.take(64)

/** Only the first pass is bounded by age: after it, the watermark alone decides what is new. */
internal const val CALL_LOG_BACKFILL_DAYS = 7L
internal const val CALL_LOG_PAGE_SIZE = 50

/**
 * CallLogProvider runs a strict-grammar query builder for callers without READ_VOICEMAIL, which
 * rejects any `ORDER BY ... LIMIT n`. The provider's own `limit` query parameter is the paging API.
 */
internal fun callLogPageUri(pageSize: Int): Uri = CallLog.Calls.CONTENT_URI.buildUpon()
    .appendQueryParameter(CallLog.Calls.LIMIT_PARAM_KEY, pageSize.toString())
    .build()

internal fun blockedCallLogDeviceCallId(id: Long): String = "$CALL_LOG_DEVICE_CALL_PREFIX$id"

internal fun blockedCallLogObservedAt(dateMillis: Long): String =
    Instant.ofEpochMilli(dateMillis.coerceAtLeast(0L)).toString()

/** The exact provider query. Pure so the watermark and first-run rules are testable off-device. */
internal fun blockedCallLogSelection(watermark: Long, now: Instant): Pair<String, Array<String>> =
    if (watermark > 0L) {
        "${CallLog.Calls.TYPE}=? AND ${CallLog.Calls._ID}>?" to
            arrayOf(CallLog.Calls.BLOCKED_TYPE.toString(), watermark.toString())
    } else {
        "${CallLog.Calls.TYPE}=? AND ${CallLog.Calls._ID}>? AND ${CallLog.Calls.DATE}>=?" to arrayOf(
            CallLog.Calls.BLOCKED_TYPE.toString(),
            "0",
            now.minusSeconds(CALL_LOG_BACKFILL_DAYS * 86_400L).toEpochMilli().toString(),
        )
    }

/**
 * Enqueues every new BLOCKED row as an interception and advances the watermark.
 *
 * Never throws: a revoked READ_CALL_LOG, a provider that refuses the query or a malformed row must
 * not fail the device-state sync. A row whose SIM has no local binding still advances the watermark —
 * it cannot become reportable later, and retrying it forever would stall every newer row behind it.
 */
internal fun flushBlockedCallLogInterceptions(
    context: Context,
    bindings: GatewaySimBindingStore,
    generation: Long,
    now: Instant = Instant.now(),
): Int = runCatching {
    val store = GatewayCallLogWatermarkStore(context)
    var enqueued = 0
    readBlockedCallLogRows(context, store.blockedId, now).forEach { row ->
        // Verified on the Pixel: `subscription_id` holds the SubscriptionManager sub id (e.g. 15).
        val simId = row.subscriptionId?.let { bindings.bySubscriptionId(it) }?.simId
        if (simId != null && enqueueBlockedCallInterception(
                context, blockedCallLogDeviceCallId(row.id), simId, generation,
                row.remoteNumber, blockedCallLogObservedAt(row.dateMillis), blockSource = "phone",
                screeningApp = row.screeningApp,
            )
        ) {
            enqueued++
        }
        GatewayDiag.log("calllog.blocked", mapOf(
            "id" to row.id, "subscriptionId" to row.subscriptionId, "bound" to (simId != null),
        ))
        store.blockedId = row.id
    }
    enqueued
}.getOrDefault(0)

/** One diag row per process for a provider that cannot be read; this runs every ~2 s. */
private val callLogReadFailureLogged = AtomicBoolean(false)

private fun readBlockedCallLogRows(context: Context, watermark: Long, now: Instant): List<BlockedCallLogRow> = try {
    val (selection, args) = blockedCallLogSelection(watermark, now)
    context.contentResolver.query(
        callLogPageUri(CALL_LOG_PAGE_SIZE),
        arrayOf(
            CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.PHONE_ACCOUNT_ID,
            CallLog.Calls.BLOCK_REASON, CallLog.Calls.CALL_SCREENING_APP_NAME,
            CallLog.Calls.CALL_SCREENING_COMPONENT_NAME,
        ),
        selection,
        args,
        "${CallLog.Calls._ID} ASC",
    )?.use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                add(BlockedCallLogRow(
                    id = cursor.getLong(0),
                    // PHONE_ACCOUNT_ID is the `subscription_id` text column; on Pixel it holds the sub id.
                    subscriptionId = cursor.getString(3)?.trim()?.toIntOrNull(),
                    remoteNumber = cursor.getString(1)?.takeIf(String::isNotBlank),
                    dateMillis = cursor.getLong(2),
                    screeningApp = blockedCallLogScreeningApp(
                        cursor.getInt(4), cursor.getString(5), cursor.getString(6),
                    ),
                ))
            }
        }
    }.orEmpty()
} catch (error: Exception) {
    // A revoked READ_CALL_LOG, a provider that refuses the query grammar, or a dead provider: all
    // three make §1 impossible, none of them may fail the sync, and none is worth a row every 2 s.
    if (callLogReadFailureLogged.compareAndSet(false, true)) {
        GatewayDiag.log(
            "calllog.blocked",
            mapOf("reason" to (error.message ?: error.javaClass.simpleName).take(120)),
            level = "warn",
        )
    }
    emptyList()
}
