package org.vodog.gateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import java.time.Instant

class GatewaySmsStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AndroidSmsExecutor.ACTION_STATUS) return
        val commandId = intent.getStringExtra(AndroidSmsExecutor.EXTRA_COMMAND_ID) ?: return
        val correlationId = intent.getStringExtra(AndroidSmsExecutor.EXTRA_CORRELATION_ID) ?: return
        val status = intent.getStringExtra(AndroidSmsExecutor.EXTRA_STATUS) ?: return
        val partIndex = intent.getIntExtra(AndroidSmsExecutor.EXTRA_PART_INDEX, -1)
        val recorded = runCatching {
            SmsExecutionJournal(context).recordStatus(
                commandId, correlationId, partIndex, status, resultCode,
            )
        }
        if (recorded.isFailure) {
            SmsStatusReceiverHealthStore(context).record("status_journal_failed")
            return
        }
        runCatching { wake(context) }.onFailure {
            SmsStatusReceiverHealthStore(context).record("status_wake_failed")
        }
    }

    private fun wake(context: Context) {
        if (!GatewayRuntimeStore(context).enabled) return
        ContextCompat.startForegroundService(
            context,
            Intent(context, GatewayForegroundService::class.java)
                .setAction(GatewayForegroundService.ACTION_SMS_CHANGED),
        )
    }
}

/** Bounded non-content diagnostics for one-shot platform callback failures. */
class SmsStatusReceiverHealthStore(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_sms_status_health", Context.MODE_PRIVATE)

    fun record(category: String) = synchronized(LOCK) {
        val nextCount = (prefs.getInt(KEY_COUNT, 0) + 1).coerceAtMost(MAX_COUNT)
        prefs.edit().putString(KEY_CATEGORY, category.take(MAX_CATEGORY_LENGTH))
            .putString(KEY_AT, Instant.now().toString()).putInt(KEY_COUNT, nextCount).apply()
    }

    data class Snapshot(val category: String, val at: String, val count: Int)

    fun snapshot(): Snapshot? = prefs.getString(KEY_CATEGORY, null)?.let {
        Snapshot(it, prefs.getString(KEY_AT, "") ?: "", prefs.getInt(KEY_COUNT, 0))
    }

    private companion object {
        const val KEY_CATEGORY = "category"
        const val KEY_AT = "at"
        const val KEY_COUNT = "count"
        const val MAX_CATEGORY_LENGTH = 80
        const val MAX_COUNT = 10_000
        val LOCK = Any()
    }
}
