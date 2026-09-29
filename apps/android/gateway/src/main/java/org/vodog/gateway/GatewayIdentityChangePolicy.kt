package org.vodog.gateway

import android.app.ActivityManager
import android.content.Context
import android.telecom.TelecomManager
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

internal enum class IdentityChangeBlock {
    CONTROL_ENABLED,
    SERVICE_RUNNING,
    AUDIO_SESSION_ACTIVE,
    AUDIO_HANDOFF_PENDING,
    MUTE_RESTORE_PENDING,
    TELECOM_BUSY,
    TELECOM_REGISTRY_BUSY,
    DEVICE_CALL_PENDING,
    CALL_EXECUTION_RECONCILIATION_REQUIRED,
    CALL_ACK_PENDING,
    COMMAND_RESULT_PENDING,
    SNAPSHOT_PENDING,
    SMS_EXECUTION_PENDING,
    INCOMING_SMS_PENDING,
    OUTGOING_SMS_PENDING,
    EVIDENCE_UNREADABLE,
}

internal data class IdentityChangeEvidence(
    val controlEnabled: Boolean = false,
    val serviceRunning: Boolean = false,
    val audioSessionActive: Boolean = false,
    val audioHandoffPending: Boolean = false,
    val muteRestorePending: Boolean = false,
    val telecomBusy: Boolean = false,
    val telecomRegistryBusy: Boolean = false,
    val deviceCallPending: Boolean = false,
    val callExecutionReconciliationRequired: Boolean = false,
    val callAckPending: Boolean = false,
    val commandResultPending: Boolean = false,
    val snapshotPending: Boolean = false,
    val smsExecutionPending: Boolean = false,
    val incomingSmsPending: Boolean = false,
    val outgoingSmsPending: Boolean = false,
    val evidenceUnreadable: Boolean = false,
)

internal object GatewayIdentityChangePolicy {
    fun blockedBy(value: IdentityChangeEvidence): IdentityChangeBlock? = when {
        value.controlEnabled -> IdentityChangeBlock.CONTROL_ENABLED
        value.serviceRunning -> IdentityChangeBlock.SERVICE_RUNNING
        value.audioSessionActive -> IdentityChangeBlock.AUDIO_SESSION_ACTIVE
        value.audioHandoffPending -> IdentityChangeBlock.AUDIO_HANDOFF_PENDING
        value.muteRestorePending -> IdentityChangeBlock.MUTE_RESTORE_PENDING
        value.telecomBusy -> IdentityChangeBlock.TELECOM_BUSY
        value.telecomRegistryBusy -> IdentityChangeBlock.TELECOM_REGISTRY_BUSY
        value.deviceCallPending -> IdentityChangeBlock.DEVICE_CALL_PENDING
        value.callExecutionReconciliationRequired -> IdentityChangeBlock.CALL_EXECUTION_RECONCILIATION_REQUIRED
        value.callAckPending -> IdentityChangeBlock.CALL_ACK_PENDING
        value.commandResultPending -> IdentityChangeBlock.COMMAND_RESULT_PENDING
        value.snapshotPending -> IdentityChangeBlock.SNAPSHOT_PENDING
        value.smsExecutionPending -> IdentityChangeBlock.SMS_EXECUTION_PENDING
        value.incomingSmsPending -> IdentityChangeBlock.INCOMING_SMS_PENDING
        value.outgoingSmsPending -> IdentityChangeBlock.OUTGOING_SMS_PENDING
        value.evidenceUnreadable -> IdentityChangeBlock.EVIDENCE_UNREADABLE
        else -> null
    }

    fun message(block: IdentityChangeBlock): String = when (block) {
        IdentityChangeBlock.CONTROL_ENABLED -> "请先关闭远端总控"
        IdentityChangeBlock.SERVICE_RUNNING -> "后台服务仍在退出，请稍后重试"
        IdentityChangeBlock.AUDIO_SESSION_ACTIVE -> "通话音频仍在释放，请稍后重试"
        IdentityChangeBlock.AUDIO_HANDOFF_PENDING -> "电话音频接管尚未恢复，暂不能更换设备身份"
        IdentityChangeBlock.MUTE_RESTORE_PENDING -> "通话静音状态尚未恢复，暂不能更换设备身份"
        IdentityChangeBlock.TELECOM_BUSY, IdentityChangeBlock.TELECOM_REGISTRY_BUSY ->
            "Pixel 当前仍有电话活动，请结束电话后重试"
        IdentityChangeBlock.DEVICE_CALL_PENDING -> "仍有电话状态等待同步，暂不能更换设备身份"
        IdentityChangeBlock.CALL_EXECUTION_RECONCILIATION_REQUIRED ->
            "历史电话执行记录尚未完成对账，暂不能更换设备身份"
        IdentityChangeBlock.CALL_ACK_PENDING -> "仍有电话执行结果等待确认，暂不能更换设备身份"
        IdentityChangeBlock.COMMAND_RESULT_PENDING -> "仍有控制结果等待确认，暂不能更换设备身份"
        IdentityChangeBlock.SNAPSHOT_PENDING -> "仍有电话快照等待确认，暂不能更换设备身份"
        IdentityChangeBlock.SMS_EXECUTION_PENDING -> "仍有短信发送或回执等待确认，暂不能更换设备身份"
        IdentityChangeBlock.INCOMING_SMS_PENDING -> "仍有收到的短信等待确认，暂不能更换设备身份"
        IdentityChangeBlock.OUTGOING_SMS_PENDING -> "仍有本机发送短信等待同步，暂不能更换设备身份"
        IdentityChangeBlock.EVIDENCE_UNREADABLE -> "本机执行记录无法安全核验，暂不能更换设备身份"
    }
}

internal class IdentityChangeBlockedException(block: IdentityChangeBlock) :
    IllegalStateException(GatewayIdentityChangePolicy.message(block))

/** Small synchronous gate so Activity state is never authoritative. The final check executes in
 * the same identity-change critical section immediately before the supplied mutation. */
internal class GatewayIdentityChangeGate(
    private val readEvidence: () -> IdentityChangeEvidence,
    private val pause: (Long) -> Unit = Thread::sleep,
    private val nowNanos: () -> Long = System::nanoTime,
) {
    fun awaitResidualCleanup(timeoutNanos: Long, pollMillis: Long) {
        val deadline = nowNanos() + timeoutNanos
        while (true) {
            val block = GatewayIdentityChangePolicy.blockedBy(readEvidence()) ?: return
            val cleanupStillRunning = block in CLEANUP_BLOCKS
            if (!cleanupStillRunning || nowNanos() >= deadline) throw IdentityChangeBlockedException(block)
            pause(pollMillis)
        }
    }

    fun <T> runAfterFreshCheck(action: () -> T): T {
        GatewayIdentityChangePolicy.blockedBy(readEvidence())?.let { throw IdentityChangeBlockedException(it) }
        return action()
    }

    private companion object {
        val CLEANUP_BLOCKS = setOf(
            IdentityChangeBlock.SERVICE_RUNNING,
            IdentityChangeBlock.AUDIO_SESSION_ACTIVE,
            IdentityChangeBlock.AUDIO_HANDOFF_PENDING,
            IdentityChangeBlock.MUTE_RESTORE_PENDING,
        )
    }
}

/** Reads every identity-sensitive store without mutating or compacting it. Any malformed evidence
 * blocks removal/pairing instead of treating corruption as an empty queue. */
internal class AndroidIdentityChangeEvidenceReader(private val context: Context) {
    fun read(): IdentityChangeEvidence = try {
        val runtime = GatewayRuntimeStore(context)
        val credentialPrefs = devicePrefs("gateway_credentials")
        val encryptedCredentialPresent = credentialPrefs.contains("ciphertext") || credentialPrefs.contains("iv")
        val credential = DeviceCredentialVault(context).read()
        check(!encryptedCredentialPresent || credential != null) { "credential evidence is unreadable" }
        // Match Foreground's queue namespace selection. During the legacy upgrade window the
        // runtime may not yet have gatewayId/fingerprint, while credential+epoch still derives the
        // exact legacy identity that owns the pending queues.
        val activeIdentity = runtime.activeCommandIdentity()
        val derivedIdentity = credential?.let(runtime::commandIdentity)
        check(credential == null || derivedIdentity != null) { "credential has no complete command identity" }
        val runtimePrefs = devicePrefs("gateway_runtime")
        val identityMetadataPresent = runtimePrefs.contains("gateway_id") ||
            runtimePrefs.contains("credential_fingerprint") || runtime.deviceEpoch > 0
        check(activeIdentity != null || derivedIdentity != null || !identityMetadataPresent) {
            "gateway identity evidence is incomplete"
        }
        // A crash between token and runtime metadata writes can leave two plausible namespaces.
        // Inspect both; choosing either one would make the other queue disappear from the guard.
        val identities = listOfNotNull(activeIdentity, derivedIdentity).distinct()
        IdentityChangeEvidence(
            controlEnabled = runtime.enabled,
            serviceRunning = gatewayServiceRunning(),
            audioSessionActive = GatewayActiveAudioSession.current() != null,
            audioHandoffPending = DeviceProtectedAudioHandoffJournal(context).read().phase != AudioHandoffPhase.IDLE,
            muteRestorePending = MuteLeaseStore(context).read().phase != MuteLeasePhase.IDLE,
            telecomBusy = context.getSystemService(TelecomManager::class.java).isInCall,
            telecomRegistryBusy = GatewayTelecomCallRegistry.snapshots().isNotEmpty(),
            deviceCallPending = DeviceCallJournal(context).recordsForSnapshot().isNotEmpty(),
            callExecutionReconciliationRequired = callExecutionEvidenceRequiresReconciliation(
                jsonArray("gateway_call_execution_journal", "records"),
            ),
            callAckPending = legacyCallAckPending() || identities.any(::identityCallAckPending),
            commandResultPending = legacyCommandResultPending() || identities.any(::identityCommandResultPending),
            snapshotPending = devicePrefs("gateway_telecom_snapshot_outbox").contains("pending"),
            smsExecutionPending = smsExecutionPending(),
            incomingSmsPending = incomingSmsPending(),
            outgoingSmsPending = outgoingSmsPending(),
        )
    } catch (_: SecurityException) {
        IdentityChangeEvidence(evidenceUnreadable = true)
    } catch (_: Exception) {
        IdentityChangeEvidence(evidenceUnreadable = true)
    }

    private fun gatewayServiceRunning(): Boolean {
        @Suppress("DEPRECATION")
        return context.getSystemService(ActivityManager::class.java).getRunningServices(Int.MAX_VALUE).any {
            it.service.packageName == context.packageName &&
                it.service.className == GatewayForegroundService::class.java.name
        }
    }

    private fun legacyCallAckPending() = jsonArrayHasItems("gateway_call_ack_outbox", "records")

    private fun identityCallAckPending(identity: GatewayCommandIdentity) = jsonArrayHasItems(
        gatewayIdentityPreferenceName("gateway_call_ack_outbox", identity), "records",
    )

    private fun legacyCommandResultPending() = jsonObjectHasItems("gateway_command_results", "pending_rejections")

    private fun identityCommandResultPending(identity: GatewayCommandIdentity) = jsonObjectHasItems(
        gatewayIdentityPreferenceName("gateway_command_results", identity), "pending_rejections",
    )

    private fun smsExecutionPending(): Boolean {
        return smsExecutionEvidencePending(jsonArray("gateway_sms_execution_journal", "records"))
    }

    private fun incomingSmsPending(): Boolean {
        return incomingSmsEvidencePending(jsonArray("gateway_incoming_sms_journal", "records"))
    }

    private fun outgoingSmsPending(): Boolean {
        return incomingSmsEvidencePending(jsonArray("gateway_outgoing_sms_observations", "records"))
    }

    private fun jsonArrayHasItems(name: String, key: String) = jsonArray(name, key).length() > 0

    private fun jsonArray(name: String, key: String): JSONArray {
        val raw = devicePrefs(name).getString(key, null) ?: return JSONArray()
        return JSONArray(raw)
    }

    private fun jsonObjectHasItems(name: String, key: String): Boolean {
        val raw = devicePrefs(name).getString(key, null) ?: return false
        return JSONObject(raw).length() > 0
    }

    private fun devicePrefs(name: String) = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(name, Context.MODE_PRIVATE)
}

internal fun smsExecutionEvidencePending(records: JSONArray): Boolean =
    (0 until records.length()).any { index ->
        val record = records.getJSONObject(index)
        if (record.strictBoolean("tombstone")) return@any false
        val phase = SmsExecutionPhase.valueOf(record.getString("phase"))
        val terminal = phase == SmsExecutionPhase.DELIVERED || phase == SmsExecutionPhase.FAILED
        val events = record.getJSONArray("events")
        val eventsDelivered = (0 until events.length()).all { events.getJSONObject(it).strictBoolean("delivered") }
        !terminal || !record.strictBoolean("ackDelivered") || !eventsDelivered
    }

internal fun incomingSmsEvidencePending(records: JSONArray): Boolean =
    (0 until records.length()).any { index ->
        val record = records.getJSONObject(index)
        !record.strictBoolean("tombstone") && !record.strictBoolean("reported")
    }

/** Legacy records without durable ACK/terminal proof are preserved and block identity changes.
 * They are not classified as an active Telecom call and must be reconciled by the separate legacy
 * migration path rather than inferred from today's idle state. */
internal fun callExecutionEvidenceRequiresReconciliation(records: JSONArray): Boolean =
    (0 until records.length()).any { index ->
        val record = records.getJSONObject(index)
        val phase = CallExecutionPhase.valueOf(record.getString("phase"))
        val retention = if (record.has("retentionState")) {
            CallRetentionState.valueOf(record.getString("retentionState"))
        } else CallRetentionState.FULL
        if (retention == CallRetentionState.TOMBSTONE) {
            return@any false
        }
        val ackAt = record.strictNullableString("ackDeliveredAt")?.also(Instant::parse)
        val terminalAt = record.strictNullableString("terminalConfirmedAt")?.also(Instant::parse)
        val terminalSnapshotId = record.strictNullableString("terminalSnapshotId")?.also(UUID::fromString)
        when (phase) {
            CallExecutionPhase.PREPARED, CallExecutionPhase.EFFECT_STARTED -> true
            CallExecutionPhase.REJECTED -> ackAt == null
            CallExecutionPhase.SUBMITTED, CallExecutionPhase.UNKNOWN ->
                ackAt == null || terminalAt == null ||
                    record.optString("terminalEvidenceKind") != "confirmed_absent_snapshot" ||
                    terminalSnapshotId == null
        }
    }

private fun JSONObject.strictBoolean(key: String): Boolean =
    (get(key) as? Boolean) ?: throw IllegalStateException("$key is not boolean")

private fun JSONObject.strictNullableString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return (get(key) as? String)?.takeIf(String::isNotBlank)
        ?: throw IllegalStateException("$key is not a non-empty string")
}
