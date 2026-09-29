package org.vodog.gateway

import android.content.Context
import android.telecom.TelecomManager
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

data class GatewayTelecomSyncResult(
    val simsSynced: Int,
    val incomingReported: Int,
    val busyState: String,
    val simsSyncSkipped: Boolean = false,
    val confirmedActiveCallIds: Set<String> = emptySet(),
)

/** Flushes durable observations only. It never invokes the Telecom mutation controller. */
class GatewayTelecomSync(
    private val context: Context,
    private val runtime: GatewayRuntimeStore,
    private val api: GatewayApi,
) {
    private val journal = DeviceCallJournal(context)
    private val bindings = GatewaySimBindingStore(context)
    private val snapshots = TelecomSnapshotOutbox(context)
    private val executions = CallExecutionJournal(context)
    private val simSyncState = GatewaySimSyncStateStore(context)
    private val purgeResults = GatewayCallLogPurgeResultStore(context)

    fun runOnce(): GatewayTelecomSyncResult {
        check(runtime.enabled) { "gateway disabled" }
        check(runtime.deviceEpoch > 0) { "device epoch unavailable" }
        val status = DeviceStatusReader(context)
        check(status.hasPhonePermission() && status.hasPrivilegedTelephonyPermissions()) {
            "verified SIM permission unavailable"
        }
        val localSims = status.activeSims()
        check(localSims.all { it.iccidFingerprint != null }) { "SIM identity remains unverified" }
        // The SIM set changes at most a few times in a device's life. Re-POSTing it every 2 s was
        // pure request amplification; the stored bindings remain the local routing authority.
        val fingerprint = simSyncFingerprint(localSims)
        val nowElapsedMs = android.os.SystemClock.elapsedRealtime()
        val syncSims = shouldSyncSimFingerprints(
            fingerprint,
            simSyncState.fingerprint,
            simSyncState.syncedAtElapsedMs,
            nowElapsedMs,
            bindings.covers(localSims),
        )
        val syncedCount = if (syncSims) {
            val synced = api.syncSims(localSims)
            bindings.replace(localSims, synced)
            simSyncState.recordSynced(fingerprint, nowElapsedMs)
            synced.size
        } else {
            bindings.bindings().size
        }

        // S38 §1: a call the screening app killed before the InCallService was bound exists only in
        // the CallLog. This never throws, so a missing permission cannot fail the device-state sync.
        flushBlockedCallLogInterceptions(context, bindings, runtime.deviceEpoch)

        var incomingReported = 0
        val blocklist = GatewayNumberBlocklistStore(context)
        journal.pendingIncoming().forEach { record ->
            val binding = bindings.byPhoneAccount(record.phoneAccountHandle) ?: return@forEach
            val listed = blocklist.isCallListed(binding.simId, record.remoteNumber, binding.countryIso)
            if (!incomingIsReportable(record, listed)) {
                if (shouldRejectIncomingRinging(runtime.enabled, record.state, listed) ||
                    (runtime.enabled && listed)) {
                    // S21 §B. The live path is unchanged — no terminal report, no snapshot entry —
                    // but the block itself is recorded once. This covers the crash-recovery case
                    // where the call was observed before the process died.
                    enqueueBlockedCallInterception(
                        context, record.deviceCallId, binding.simId, runtime.deviceEpoch,
                        record.remoteNumber, record.observedAt,
                    )
                    journal.suppressIncomingReport(record.deviceCallId)
                }
                return@forEach
            }
            val payload = record.incomingPayload?.let(::JSONObject) ?: JSONObject()
                .put("eventId", record.incomingEventId)
                .put("generation", runtime.deviceEpoch)
                .put("deviceCallId", record.deviceCallId)
                .put("simId", binding.simId)
                .put("observedAt", record.observedAt)
                .also { body -> record.remoteNumber?.let { body.put("remoteNumber", it) } }
                .let { journal.persistIncomingPayload(record.deviceCallId, it)?.incomingPayload?.let(::JSONObject) ?: it }
            val response = api.reportIncoming(payload)
            check(response.accepted) { "incoming observation not accepted" }
            journal.markIncomingReported(record.deviceCallId, response.callId)
            logTelephonyBound(record.deviceCallId, response.callId)
            if (shouldSilenceNativeRinger(response.disposition, record.state)) silenceNativeRinger(context, record.deviceCallId, response.callId)
            incomingReported++
        }

        reportUnboundOutgoingCalls()

        val telecom = context.getSystemService(TelecomManager::class.java)
        val systemBusy = try {
            telecom.isInCall
        } catch (_: SecurityException) {
            error("phone permission revoked before telecom snapshot")
        }
        if (!systemBusy) {
            // No Telecom call exists at all, so any older journal record without a registry entry is provably gone.
            // This is the durable absence evidence a lost binding or a killed InCallService never produced.
            journal.markProvablyAbsentRecordsEnded(GatewayTelecomCallRegistry.deviceCallIds())
        }
        val (snapshot, snapshotResponse) = submitSnapshot(systemBusy)
        val confirmedByAcceptedSnapshot = snapshot.getJSONArray("confirmedAbsentCallIds")
        val confirmedIds = buildSet {
            for (index in 0 until confirmedByAcceptedSnapshot.length()) {
                add(confirmedByAcceptedSnapshot.getString(index))
            }
        }
        commitAcceptedTelecomSnapshot(
            markExecutionEvidence = {
                executions.markTerminalConfirmed(
                    confirmedIds,
                    snapshot.getLong("generation"),
                    snapshot.getString("snapshotId"),
                    Instant.now().toString(),
                )
            },
            pruneDeviceCalls = {
                journal.pruneAfterAcceptedSnapshot(snapshotResponse.releasedCallIds.toSet())
            },
            removeSnapshotOutbox = { snapshots.markAccepted(snapshot.getString("snapshotId")) },
        )
        flushCallLogPurges(snapshotResponse.callLogPurges)
        return GatewayTelecomSyncResult(syncedCount, incomingReported, snapshotResponse.busyState, !syncSims,
            activeCallIdsInAcceptedSnapshot(snapshot) - snapshotResponse.releasedCallIds.toSet())
    }

    /**
     * S39 §网关: deletes the system dialler's own CallLog rows for calls deleted elsewhere.
     *
     * Everything here is best effort by design — a failed ack leaves the outcome remembered and the
     * queue unacked, so the next snapshot re-sends it and the remembered answer is replayed. Nothing
     * in this path may fail the heartbeat that ends live calls.
     */
    private fun flushCallLogPurges(purges: List<CallLogPurge>) {
        if (purges.isEmpty()) return
        runCatching {
            val acks = purgeCallLogs(context, purges, purgeResults)
            if (acks.isEmpty()) return@runCatching
            api.ackCallLogPurges(acks)
            acks.forEach { purgeResults.forget(it.purgeId) }
            GatewayDiag.log("calllog.purged", mapOf(
                "acked" to acks.size, "deleted" to acks.count { it.status == "deleted" },
            ))
        }.onFailure { error ->
            GatewayDiag.log(
                "calllog.purge_ack",
                mapOf("queued" to purges.size, "reason" to (error.message ?: error.javaClass.simpleName).take(120)),
                level = "warn",
            )
        }
    }

    /**
     * S38 §2: reports calls the user dialled on the Pixel itself, once each.
     *
     * Deliberately not `check`-ed like the incoming loop: a refusal here must never abort `runOnce`,
     * because the Telecom snapshot below is what ends live calls and confirms absence. A payload the
     * control service refuses outright is settled locally so it cannot be retried every 2 s forever.
     */
    private fun reportUnboundOutgoingCalls() {
        journal.pendingUnboundOutgoing().forEach { record ->
            val binding = bindings.byPhoneAccount(record.phoneAccountHandle) ?: return@forEach
            val telecomState = outgoingObservedTelecomState(record.state) ?: return@forEach
            // Frozen before the first send: Control replays a repeated eventId only on an identical
            // request fingerprint, and both observedAt and telecomState move every heartbeat.
            val payload = record.outgoingPayload?.let(::JSONObject) ?: JSONObject()
                .put("eventId", outgoingObservedEventId(record.deviceCallId))
                .put("generation", runtime.deviceEpoch)
                .put("deviceCallId", record.deviceCallId)
                .put("simId", binding.simId)
                .put("observedAt", record.observedAt)
                .put("telecomState", telecomState)
                .also { body -> record.remoteNumber?.let { body.put("remoteNumber", it) } }
                .let { journal.persistOutgoingPayload(record.deviceCallId, it)?.outgoingPayload?.let(::JSONObject) ?: it }
            val outcome = runCatching { api.reportOutgoingObserved(payload) }
            val response = outcome.getOrNull()
            if (response?.accepted == true) {
                journal.markOutgoingReported(record.deviceCallId, response.callId)
                logTelephonyBound(record.deviceCallId, response.callId)
                return@forEach
            }
            val status = (outcome.exceptionOrNull() as? GatewayApiHttpError)?.status
            if (status != null && !outgoingObservedRetryable(status)) {
                journal.markOutgoingReported(record.deviceCallId, null)
            }
            GatewayDiag.log(
                "outgoing.observed",
                mapOf("state" to payload.optString("telecomState"), "status" to status, "settled" to (status != null)),
                level = "warn",
            )
        }
    }

    /**
     * Sends the pending snapshot, rebuilding it when the server rejects the payload itself (409). The frozen payload
     * is retried first so an observation created before a crash is never lost; a rejected one is regenerated from the
     * journal instead of being resent forever, which used to stall command handling and every ACK flush.
     */
    private fun submitSnapshot(systemBusy: Boolean): Pair<JSONObject, TelecomSnapshotResult> {
        var snapshot = snapshots.pendingOrCreate { snapshotPayload(systemBusy) }
        var rebuilds = 0
        while (true) {
            try {
                val response = api.reportTelecomSnapshot(snapshot)
                check(response.accepted) { "telecom snapshot not accepted" }
                return snapshot to response
            } catch (error: GatewayApiHttpError) {
                if (!shouldRebuildTelecomSnapshot(error.status, error.code, rebuilds)) throw error
                rebuilds++
                snapshot = snapshots.replace { snapshotPayload(systemBusy) }
            }
        }
    }

    private fun snapshotPayload(systemBusy: Boolean): JSONObject {
        // One immutable journal read prevents the same call appearing both live and confirmed absent.
        val journalRecords = journal.recordsForSnapshot()
        val calls = JSONArray()
        journalRecords.filter { it.state.wireValue != null }.forEach { record ->
            val state = record.state.wireValue ?: return@forEach
            if (record.direction == DeviceCallDirection.UNKNOWN) return@forEach
            val binding = bindings.byPhoneAccount(record.phoneAccountHandle)
            val callJson = JSONObject()
                .put("deviceCallId", record.deviceCallId)
                .put("simId", binding?.simId ?: JSONObject.NULL)
                .put("direction", record.direction.wireValue)
                .put("state", state)
            record.serverCallId?.let { callJson.put("callId", it) }
            calls.put(callJson)
        }
        return JSONObject()
            .put("snapshotId", UUID.randomUUID().toString())
            .put("generation", runtime.deviceEpoch)
            .put("snapshotSequence", runtime.nextTelecomSnapshotSequence())
            .put("reportedSequence", runtime.reportedSequence)
            .put("localBusy", systemBusy || calls.length() > 0)
            .put("calls", calls)
            // Only a durable InCallService end observation confirms absence. A missing live call does not.
            .put("confirmedAbsentCallIds", JSONArray(confirmedAbsentCallIds(journalRecords)))
            .put("observedAt", Instant.now().toString())
    }
}

/**
 * S38 §2: derived, not stored, so a crash between observing and reporting reuses the same event id.
 * Namespaced exactly like the interception ids so it can never collide with a random journal id.
 */
internal fun outgoingObservedEventId(deviceCallId: String): String =
    UUID.nameUUIDFromBytes("vodog:outgoing-observed:$deviceCallId".toByteArray(Charsets.UTF_8)).toString()

/**
 * Unlike an interception, a fenced (409) outgoing observation is not worth another round: the epoch
 * it names is gone, and the record is settled locally instead of retried on every heartbeat.
 */
internal fun outgoingObservedRetryable(status: Int): Boolean =
    status !in 400..499 || status in setOf(408, 425, 429)

/** A 409 means the server refused this payload (stale sequence, epoch fence, reused identity); rebuild it. */
internal fun shouldRebuildTelecomSnapshot(status: Int, code: String?, rebuilds: Int): Boolean =
    status == 409 && rebuilds < MAX_SNAPSHOT_REBUILDS

private const val MAX_SNAPSHOT_REBUILDS = 3

internal fun commitAcceptedTelecomSnapshot(
    markExecutionEvidence: () -> Unit,
    pruneDeviceCalls: () -> Unit,
    removeSnapshotOutbox: () -> Unit,
) {
    markExecutionEvidence()
    pruneDeviceCalls()
    removeSnapshotOutbox()
}


/** Only the immutable payload Control just accepted is evidence of remote ACTIVE state. */
internal fun activeCallIdsInAcceptedSnapshot(snapshot: JSONObject): Set<String> = buildSet {
    val calls = snapshot.getJSONArray("calls")
    for (index in 0 until calls.length()) {
        val call = calls.getJSONObject(index)
        if (call.optString("state") == "active" && !call.isNull("callId")) {
            call.optString("callId").takeIf(String::isNotBlank)?.let(::add)
        }
    }
}

/** Joins earlier `telephony.state` rows (deviceCallId only) to the server call once Control names it. */
/**
 * S72 D2: a call Control offers to the owner (or hands to AI / busy handling) rings on the owner's
 * clients, not on this desk-bound Pixel. `local_only` (no owner / feature off) keeps native ringing;
 * locally blocklisted calls never reach the report and are rejected elsewhere.
 */
internal fun shouldSilenceNativeRinger(disposition: String, state: DeviceCallState): Boolean =
    state == DeviceCallState.RINGING && disposition != "local_only"

/** Telecom's silenceRinger stops both ringtone and vibration; needs MODIFY_PHONE_STATE (privapp whitelist). */
private fun silenceNativeRinger(context: Context, deviceCallId: String, serverCallId: String?) {
    val result = runCatching { context.getSystemService(TelecomManager::class.java).silenceRinger() }
    GatewayDiag.log(
        "telephony.ringer_silenced",
        mapOf("deviceCallId" to deviceCallId, "ok" to result.isSuccess, "error" to result.exceptionOrNull()?.javaClass?.simpleName),
        callId = serverCallId,
        level = if (result.isSuccess) "info" else "warn",
    )
}

internal fun logTelephonyBound(deviceCallId: String, serverCallId: String?) {
    if (serverCallId.isNullOrBlank()) return
    GatewayDiag.log("telephony.bound", mapOf("deviceCallId" to deviceCallId), callId = serverCallId)
}
