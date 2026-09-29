package org.vodog.gateway

import java.time.Instant
import java.util.TimeZone
import org.json.JSONObject

object GatewayApiRoutes {
    const val HEARTBEAT = "/gateway/heartbeat"
    /** S20 D4: the hanging request the control service answers early when commands are waiting. */
    const val COMMAND_DOORBELL = "/gateway/commands/doorbell"
    /** S21 §D: the only request an OFF gateway keeps alive, and only while the user allows it. */
    const val STANDBY = "/gateway/standby"
    fun ack(commandId: String) = "/gateway/commands/${encodePathSegment(commandId)}/ack"
    fun mediaOptions(callId: String) = "/gateway/calls/${encodePathSegment(callId)}/media/options"
    fun mediaOffer(callId: String) = "/gateway/calls/${encodePathSegment(callId)}/media/offer"
    /** S38 §4: the capture binding for a phone-dialled call, which has no media/options exchange. */
    fun captureBinding(callId: String) = "/gateway/calls/${encodePathSegment(callId)}/capture-binding"
    fun recordingArchives(callId: String) = "/gateway/calls/${encodePathSegment(callId)}/recording-archives"
    fun recordingArchive(uploadId: String) = "/gateway/recording-archives/${encodePathSegment(uploadId)}"
    fun recordingArchiveObject(uploadId: String, objectName: String) =
        "${recordingArchive(uploadId)}/objects/${encodePathSegment(objectName)}"
    fun finalizeRecordingArchive(uploadId: String) = "${recordingArchive(uploadId)}/finalize"
    const val MEDIA_PROBE_OPTIONS = "/gateway/media/probes/options"
    const val MEDIA_PROBE_RESULTS = "/gateway/media/probes/results"
    const val SIM_SYNC = "/gateway/sims/sync"
    const val INCOMING_CALL = "/gateway/calls/incoming"
    /** S38 §2: the call the user dialled on the Pixel itself, reported once per device call. */
    const val OUTGOING_OBSERVED = "/gateway/calls/outgoing-observed"
    const val TELECOM_SNAPSHOT = "/gateway/telecom/snapshot"
    /** S39 §网关: the answer to the purge queue the snapshot response carries. */
    const val CALL_LOG_PURGE_ACK = "/gateway/call-log-purges/ack"
    fun smsEvents(smsId: String) = "/gateway/sms/${encodePathSegment(smsId)}/events"
    const val INCOMING_SMS = "/gateway/sms/incoming"
    const val OUTGOING_SMS_OBSERVED = "/gateway/sms/outgoing-observed"
    /** S36 C3: the one route with an array body. Auth is the device token, so no source header. */
    const val DIAG_EVENTS = "/diag/events"
    /** S55: phone-side blocklist changes; idempotent by `eventId`. */
    const val BLOCKLIST_PHONE_CHANGES = "/gateway/blocklist/phone-changes"
    const val REPLAY_MIGRATION_PREFLIGHT = "/gateway/replay-migration/preflight"
    const val REPLAY_MIGRATION_COMMIT = "/gateway/replay-migration/commit"
    const val REPLAY_MIGRATION_COMPLETE = "/gateway/replay-migration/complete"

    /**
     * S71: POST routes Control already deduplicates (by eventId / commandId) or that only report
     * current state, so a second copy after a lost response is harmless and may go to the other
     * endpoint. Everything else (media grants, pairing, migrations, SMS events) is sent once.
     */
    private val IDEMPOTENT_POSTS = setOf(HEARTBEAT, SIM_SYNC, TELECOM_SNAPSHOT, INCOMING_CALL, OUTGOING_OBSERVED,
        INCOMING_SMS, OUTGOING_SMS_OBSERVED, BLOCKLIST_PHONE_CHANGES, CALL_LOG_PURGE_ACK)

    internal fun isIdempotent(path: String): Boolean =
        path in IDEMPOTENT_POSTS || (path.startsWith("/gateway/commands/") && path.endsWith("/ack"))

    internal fun encodePathSegment(value: String): String = buildString {
        value.toByteArray(Charsets.UTF_8).forEach { byte ->
            val n = byte.toInt() and 0xff
            val safe = n in 'a'.code..'z'.code || n in 'A'.code..'Z'.code ||
                n in '0'.code..'9'.code || n == '-'.code || n == '_'.code || n == '.'.code
            if (safe) append(n.toChar()) else append("%%%02X".format(n))
        }
    }
}

data class GatewayCommand(
    val commandId: String,
    val generation: Long,
    val sequence: Long,
    val callId: String? = null,
    val smsId: String? = null,
    val kind: String = "unknown",
    val payloadJson: String = "{}",
    val expiresAt: String? = null,
    val reconciliationOnly: Boolean = false,
)
data class ReplayAckEvidence(val sequence: Long, val fingerprint: String)
data class HeartbeatResult(
    val gatewayId: String,
    val deviceEpoch: Long,
    val serverSequence: Long,
    val commands: List<GatewayCommand>,
    val replayHorizon: ReplayHorizonProof? = null,
    val replayHorizonControlQuarantined: Boolean = false,
    val replayHorizonEnrollment: ReplayHorizonEnrollment? = null,
    val numberBlocklist: NumberBlocklistSnapshot? = null,
    /** S20 D4 announcement. Absent, unreadable or 0 means the server keeps the doorbell closed. */
    val commandDoorbellMaxHoldMs: Int = 0,
    /**
     * S21 §D. The heartbeat only ever delivers `"off"` (an online gateway needs no standby beacon to
     * be switched on), and the control service clears the request as soon as it hands it over.
     */
    val desiredPower: String? = null,
    /** S56: Control's `EARLY_MEDIA_ENABLED`, sent on every heartbeat; absent reads as false. */
    val earlyMedia: Boolean = false,
)

/** One hanging doorbell round. `wake` means the control service has command work to collect now. */
data class DoorbellResult(val wake: Boolean, val heldMs: Long)

/** Absent object, absent field or a negative value all read as "closed". */
internal fun parseCommandDoorbellMaxHoldMs(response: JSONObject): Int =
    response.optJSONObject("commandDoorbell")?.optInt("maxHoldMs", 0)?.coerceAtLeast(0) ?: 0
data class SyncedSim(
    val id: String,
    val iccidFingerprint: String,
    val slotIndex: Int,
    val subscriptionId: Int?,
    val phoneAccountHandle: String?,
    val countryIso: String?,
    val embedded: Boolean?,
    val label: String,
    val assignmentVersion: Int,
    val assignmentPending: Boolean,
    val needsOwnerAssignment: Boolean,
    val routable: Boolean,
)
data class IncomingCallResult(val accepted: Boolean, val replayed: Boolean, val disposition: String, val callId: String?)
/** S38 §2. `callId` is null when Control accepted the observation but recorded nothing. */
data class OutgoingObservedResult(val accepted: Boolean, val replayed: Boolean, val callId: String?)
data class OutgoingSmsObservedResult(
    val accepted: Boolean,
    val replayed: Boolean,
    val disposition: String,
    val smsId: String?,
)
data class TelecomSnapshotResult(
    val accepted: Boolean,
    val replayed: Boolean,
    val busyState: String,
    val releasedCallIds: List<String> = emptyList(),
    /** S39 §决策1: absent on an old control service, which is why the field defaults to empty. */
    val callLogPurges: List<CallLogPurge> = emptyList(),
)

/**
 * S39 §网关: one deleted call whose row in the system dialler's CallLog must go too.
 *
 * Every field but the two ids is optional because the deleted call row itself may have carried
 * nothing: a queue entry without a number is answered `not_found` rather than guessed at.
 */
data class CallLogPurge(
    val purgeId: String,
    val callId: String,
    val deviceCallId: String? = null,
    val remoteNumber: String? = null,
    val direction: String? = null,
    val startedAt: Instant? = null,
    val endedAt: Instant? = null,
)

/** `status` is `deleted` or `not_found`; a denied purge is never acked, so it has no ack value. */
data class CallLogPurgeAck(val purgeId: String, val status: String, val deletedRows: Int)

internal fun releasedCallIdsFromSnapshotResponse(response: JSONObject): List<String> {
    val array = response.optJSONArray("releasedCallIds") ?: return emptyList()
    return buildList {
        for (index in 0 until array.length()) {
            array.optString(index).takeIf { it.isNotBlank() }?.let(::add)
        }
    }
}

/**
 * Tolerant by contract: a missing array is an old control service, and one malformed entry must not
 * cost the other queued purges. A row without both ids cannot be acked, so it is dropped outright.
 */
internal fun callLogPurgesFromSnapshotResponse(response: JSONObject): List<CallLogPurge> {
    val array = response.optJSONArray("callLogPurges") ?: return emptyList()
    return buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val purgeId = item.stringOrNull("purgeId") ?: continue
            val callId = item.stringOrNull("callId") ?: continue
            add(CallLogPurge(
                purgeId = purgeId,
                callId = callId,
                deviceCallId = item.stringOrNull("deviceCallId"),
                remoteNumber = item.stringOrNull("remoteNumber"),
                direction = item.stringOrNull("direction"),
                startedAt = item.instantOrNull("startedAt"),
                endedAt = item.instantOrNull("endedAt"),
            ))
        }
    }
}

/** `optString` answers `"null"` on Android and `""` on the JVM for a JSON null; neither is a value. */
private fun JSONObject.stringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

private fun JSONObject.instantOrNull(key: String): Instant? =
    stringOrNull(key)?.let { runCatching { Instant.parse(it) }.getOrNull() }

internal fun parseTelecomSnapshotResult(response: JSONObject) = TelecomSnapshotResult(
    accepted = response.getBoolean("accepted"),
    replayed = response.optBoolean("replayed"),
    busyState = response.getString("busyState"),
    releasedCallIds = releasedCallIdsFromSnapshotResponse(response),
    callLogPurges = callLogPurgesFromSnapshotResponse(response),
)

/** IANA Area/City only. Offsets and Asia/Beijing must not take the heartbeat offline. */
internal fun gatewayTimeZoneId(zone: TimeZone = TimeZone.getDefault()): String? = gatewayTimeZoneId(zone.id)

internal fun gatewayTimeZoneId(id: String?): String? {
    val value = id?.trim().orEmpty()
    if (value.length !in 3..100 || '/' !in value || '+' in value || value.equals("Asia/Beijing", ignoreCase = true)) return null
    return value
}

class GatewayApi(
    private val token: String,
    private val shouldContinue: () -> Boolean,
    private val transport: GatewayHttpTransport,
) {
    fun heartbeat(controlEnabled: Boolean, reportedSequence: Long, smsReady: Boolean = false,
                  phoneCapabilities: GatewayPhoneCapabilities = GatewayPhoneCapabilities(false, false),
                  replayState: ReplayHorizonState? = null, requestReplayEnrollment: Boolean = false,
                  remotePowerAllowed: Boolean = false, lastPowerResult: JSONObject? = null,
                  numberBlocklistVersion: Long? = null): HeartbeatResult {
        val body = JSONObject()
            .put("controlEnabled", controlEnabled)
            .put("reportedSequence", reportedSequence)
            .put(
                "capabilities",
                JSONObject()
                    .put("telephonyReady", phoneCapabilities.telephonyReady && controlEnabled && GatewayPhoneFeatureApproval.APPROVED)
                    .put("smsReady", smsReady)
                    .put("mediaReady", phoneCapabilities.mediaReady && controlEnabled && GatewayPhoneFeatureApproval.APPROVED)
                    .put("commandReconciliationReady", true),
            )
        if (replayState != null) {
            body.getJSONObject("capabilities")
                .put("commandReplayHorizonVersion", 1)
                .put("commandReplayFinalizedProofVersion", 1)
            body.put("replayHorizonState", JSONObject()
                .put("gatewayId", replayState.gatewayId).put("generation", replayState.generation)
                .put("blockingFloor", replayState.blockingFloor).put("preparedRevision", replayState.preparedRevision)
                .put("preparedDigest", replayState.preparedDigest).put("committedFloor", replayState.committedFloor)
                .put("committedRevision", replayState.committedRevision).put("committedDigest", replayState.committedDigest)
                .put("disposition", when { replayState.quarantined -> "quarantined"; replayState.localBlocked -> "local_blocked"; else -> "ready" })
                .also { replayState.rejectionReason?.let { reason -> it.put("rejectionReason", reason) } })
        }
        if (requestReplayEnrollment) {
            body.getJSONObject("capabilities").put("commandReplayHorizonEnrollmentVersion", 1)
        }
        // S21 §D. Both fields are optional on the control side, so a new gateway against an old
        // control service keeps working; the zod body was verified non-strict.
        body.put("remotePowerAllowed", remotePowerAllowed)
        lastPowerResult?.let { body.put("lastPowerResult", it) }
        // S41 §决策5: the stored version short-circuits the server's number lookup. Omitted before the
        // first snapshot exists, and an old control service simply ignores it and sends the full list.
        numberBlocklistVersion?.let { body.put("numberBlocklistVersion", it) }
        gatewayTimeZoneId()?.let { body.put("timeZone", it) }
        // S71: which Control endpoint carried this heartbeat; Control reads it for diagnostics only.
        body.put("relay", GatewayEndpoint.relay)
        val response = post(GatewayApiRoutes.HEARTBEAT, body)
        val gateway = response.getJSONObject("gateway")
        val commandsJson = response.optJSONArray("commands")
        val commands = buildList {
            if (commandsJson != null) {
                for (index in 0 until commandsJson.length()) {
                    val command = commandsJson.optJSONObject(index) ?: continue
                    val id = command.optString("id", command.optString("commandId"))
                    if (id.isNotBlank() && command.has("generation") && command.has("sequence")) {
                        add(GatewayCommand(
                            id,
                            command.getLong("generation"),
                            command.getLong("sequence"),
                            command.optString("callId").takeIf(String::isNotBlank),
                            command.optString("smsId").takeIf(String::isNotBlank)
                                ?: command.optJSONObject("payload")?.optString("smsId")?.takeIf(String::isNotBlank),
                            command.optString("kind", "unknown"),
                            command.optJSONObject("payload")?.toString() ?: "{}",
                            command.optString("expiresAt").takeIf(String::isNotBlank),
                            command.optBoolean("reconciliationOnly", false),
                        ))
                    }
                }
            }
        }
        val horizon=response.optJSONObject("replayHorizon")?.takeIf{it.optString("phase")!="quarantined"}?.let{
            val counts = it.getJSONObject("kindCounts")
            val finalized = it.optJSONArray("finalizedProofs")?.let { array -> buildList {
                for(index in 0 until array.length())array.getJSONObject(index).let { item -> add(ReplayFinalizedProof(
                    item.getLong("generation"),item.getLong("sequence"),item.getString("commandId"),item.getString("fingerprint"),
                    item.getString("kind"),item.getString("serverStatus"),item.getString("serverReason"),item.getString("entryDigest"),
                )) }
            } } ?: emptyList()
            ReplayHorizonProof(it.getString("phase"),it.getString("gatewayId"),it.getLong("generation"),
                it.getLong("fromInclusive"),it.getLong("retireBeforeSequence"),it.getLong("revision"),it.getString("proofDigest"),
                it.getLong("commandCount"), counts.keys().asSequence().associateWith(counts::getLong),it.optInt("protocolVersion",1),finalized)
        }
        val controlQuarantined=response.optJSONObject("replayHorizon")?.optString("phase")=="quarantined"
        val enrollment = response.optJSONObject("replayHorizonEnrollment")?.let {
            ReplayHorizonEnrollment(it.getString("gatewayId"), it.getLong("generation"),
                it.getLong("firstSequence"), it.getLong("revision"), it.getString("enrollmentDigest"))
        }
        return HeartbeatResult(
            gatewayId = gateway.getString("id").also { require(it.isNotBlank() && it.length <= 256) },
            deviceEpoch = gateway.optLong("deviceEpoch", gateway.optLong("serverGeneration", 0L)),
            serverSequence = gateway.optLong("serverSequence", 0L),
            commands = commands,
            replayHorizon = horizon,
            replayHorizonControlQuarantined = controlQuarantined,
            replayHorizonEnrollment = enrollment,
            numberBlocklist = parseNumberBlocklist(response),
            commandDoorbellMaxHoldMs = parseCommandDoorbellMaxHoldMs(response),
            desiredPower = parseDesiredPower(response, accepted = "off"),
            earlyMedia = response.optBoolean("earlyMedia", false),
        )
    }

    /**
     * S21 §D standby beacon. The server holds the request for at most `holdMs`, so the client timeout
     * is that window plus a fixed network margin; the standby owner's OkHttp read timeout (35 s)
     * covers the full 20 s hold. Authentication is the same device credential the heartbeat uses.
     */
    fun standby(holdMs: Int, remotePowerAllowed: Boolean, lastPowerResult: JSONObject?): StandbyResult {
        require(holdMs > 0) { "standby hold must be positive" }
        val response = post(
            GatewayApiRoutes.STANDBY,
            standbyRequestBody(holdMs, remotePowerAllowed, lastPowerResult),
            timeoutMs = holdMs.toLong() + GatewayStandbyPolicy.REQUEST_MARGIN_MS,
            // S71: a read timeout on the standby hold is normal, never a reason to switch endpoint.
            alternateRetry = false,
        )
        return parseStandbyResult(response)
    }

    /**
     * One doorbell round. The server holds the request for at most `holdMs`, so the client timeout is
     * that window plus a fixed network margin; the owned OkHttp read timeout (20 s) still covers the
     * announced 8 s ceiling. Authentication is the heartbeat's own device credential.
     */
    fun commandDoorbell(holdMs: Int): DoorbellResult {
        require(holdMs > 0) { "doorbell hold must be positive" }
        val response = post(
            GatewayApiRoutes.COMMAND_DOORBELL,
            JSONObject().put("holdMs", holdMs),
            timeoutMs = holdMs.toLong() + DOORBELL_TIMEOUT_MARGIN_MS,
            alternateRetry = false,
        )
        return DoorbellResult(
            wake = response.optBoolean("wake", false),
            heldMs = response.optLong("heldMs", 0L).coerceAtLeast(0L),
        )
    }

    fun rejectUnsupported(command: GatewayCommand, replayEvidence: ReplayAckEvidence? = null,
                          replayStore: GatewayReplayHorizonStore? = null) =
        ackCommand(command, "rejected", JSONObject().put("phase", "not_executed")
            .put("reason", "cellular_adapter_disabled"), replayEvidence, replayStore)

    fun syncSims(sims: List<SimSnapshot>): List<SyncedSim> {
        require(sims.all { it.iccidFingerprint?.length in 16..256 }) { "unverified SIM identity" }
        val items = org.json.JSONArray()
        sims.forEach { sim ->
            items.put(JSONObject()
                .put("slotIndex", sim.slotIndex)
                .put("subscriptionId", sim.subscriptionId)
                .put("phoneAccountHandle", sim.protectedPhoneAccountHandle ?: JSONObject.NULL)
                .put("iccidFingerprint", sim.iccidFingerprint)
                .put("countryIso", sim.countryIso ?: JSONObject.NULL)
                .put("embedded", sim.embedded ?: JSONObject.NULL)
                .also { item ->
                    sim.identityKind?.wire?.let { item.put("identityKind", it) }
                    sim.legacyIccidFingerprint?.takeIf { it.length in 16..256 && it != sim.iccidFingerprint }
                        ?.let { item.put("legacyIccidFingerprint", it) }
                    normalizedSimPhoneNumber(sim.phoneNumber)?.let { item.put("phoneNumber", it) }
                })
        }
        val response = post(GatewayApiRoutes.SIM_SYNC, JSONObject().put("items", items))
        val result = response.getJSONArray("items")
        return List(result.length()) { index ->
            val item = result.getJSONObject(index)
            SyncedSim(
                id = item.getString("id"),
                iccidFingerprint = item.getString("iccidFingerprint").also {
                    require(it.length in 16..256) { "invalid synced SIM identity" }
                },
                slotIndex = item.getInt("slotIndex"),
                subscriptionId = if (item.isNull("subscriptionId")) null else item.getInt("subscriptionId"),
                phoneAccountHandle = if (item.isNull("phoneAccountHandle")) null else item.getString("phoneAccountHandle"),
                countryIso = if (item.isNull("countryIso")) null else item.getString("countryIso"),
                embedded = if (item.isNull("embedded")) null else item.getBoolean("embedded"),
                label = item.optString("label", "SIM ${item.getInt("slotIndex") + 1}"),
                assignmentVersion = item.optInt("assignmentVersion", item.getInt("version")),
                assignmentPending = item.optBoolean("assignmentPending"),
                needsOwnerAssignment = item.optBoolean("needsOwnerAssignment"),
                routable = item.optBoolean("routable"),
            )
        }
    }

    fun reportIncoming(payload: JSONObject): IncomingCallResult {
        val response = post(GatewayApiRoutes.INCOMING_CALL, payload)
        return IncomingCallResult(
            accepted = response.getBoolean("accepted"),
            replayed = response.optBoolean("replayed"),
            disposition = response.getString("disposition"),
            callId = response.optJSONObject("call")?.optString("id")?.takeIf(String::isNotBlank),
        )
    }

    /**
     * S38 §2. Unlike the incoming route the call id is top level, and a `callId:null` answer is a
     * normal accepted outcome rather than an error: the feature switch or SIM ownership decided it.
     */
    fun reportOutgoingObserved(payload: JSONObject): OutgoingObservedResult {
        val response = post(GatewayApiRoutes.OUTGOING_OBSERVED, payload)
        return OutgoingObservedResult(
            accepted = response.getBoolean("accepted"),
            replayed = response.optBoolean("replayed"),
            callId = if (response.isNull("callId")) null else response.optString("callId").takeIf(String::isNotBlank),
        )
    }

    /** S38 §4. A 503 (feature off) or 409 (call not active here) is the passive recorder's kill switch. */
    fun requestCaptureBinding(callId: String, deviceCallId: String, telecomCreationTimeMillis: Long): JSONObject =
        post(GatewayApiRoutes.captureBinding(callId), JSONObject()
            .put("deviceCallId", deviceCallId)
            .put("telecomCreationTimeMillis", telecomCreationTimeMillis))
            .getJSONObject("captureBinding")

    fun reportTelecomSnapshot(payload: JSONObject): TelecomSnapshotResult {
        val response = post(GatewayApiRoutes.TELECOM_SNAPSHOT, payload)
        return parseTelecomSnapshotResult(response)
    }

    /**
     * S39 §网关. Control caps a request at 50 acks; the local memory can hold more than one
     * snapshot's worth, so the batch is chunked rather than trusted to fit.
     */
    fun ackCallLogPurges(acks: List<CallLogPurgeAck>) {
        acks.chunked(CALL_LOG_PURGE_ACK_LIMIT).forEach { batch ->
            val items = org.json.JSONArray()
            batch.forEach {
                items.put(JSONObject().put("purgeId", it.purgeId).put("status", it.status)
                    .put("deletedRows", it.deletedRows.coerceAtLeast(0)))
            }
            post(GatewayApiRoutes.CALL_LOG_PURGE_ACK, JSONObject().put("acks", items))
        }
    }

    fun ackCommand(command: GatewayCommand, status: String, result: JSONObject,
                   replayEvidence: ReplayAckEvidence? = null, replayStore: GatewayReplayHorizonStore? = null) {
        val body = JSONObject().put("generation", command.generation).put("status", status).put("result", result)
        replayEvidence?.let { body.put("replayEvidence", it.toJson()) }
        val outbound=replayStore?.stageAck(command.commandId, body)?:body
        postAck(command.commandId, command.kind, status, outbound, staged = replayStore != null, callId = command.callId)
        replayStore?.confirmAck(command.commandId)
    }

    fun ackCallCommand(commandId: String, generation: Long, status: String, result: JSONObject, telecomState: String?,
                       replayEvidence: ReplayAckEvidence? = null, replayStore: GatewayReplayHorizonStore? = null,
                       callId: String? = null) {
        val body = JSONObject().put("generation", generation).put("status", status).put("result", result)
        telecomState?.let { body.put("telecomState", it) }
        replayEvidence?.let { body.put("replayEvidence", it.toJson()) }
        val outbound=replayStore?.stageAck(commandId, body)?:body
        postAck(commandId, null, status, outbound, staged = replayStore != null, callId = callId)
        replayStore?.confirmAck(commandId)
    }

    fun flushReplayAcks(store: GatewayReplayHorizonStore) {
        var flushed = 0
        try {
            store.pendingAcks().forEach { pending ->
                postAck(pending.commandId, null, pending.body.optString("status").ifBlank { null }, pending.body, staged = true)
                store.confirmAck(pending.commandId)
                flushed++
            }
        } finally {
            // S69: runs every cycle, so only a flush that actually delivered something is a row.
            if (flushed > 0) GatewayDiag.log("replay.ack_flushed", mapOf("count" to flushed))
        }
    }

    /** S69: an ACK that did not land is `command.ack_failed`, then fails exactly as before. */
    private fun postAck(commandId: String, kind: String?, status: String?, body: JSONObject, staged: Boolean,
                        callId: String? = null) {
        try {
            post(GatewayApiRoutes.ack(commandId), body)
        } catch (error: Exception) {
            if (error !is kotlinx.coroutines.CancellationException) GatewayDiag.log("command.ack_failed", mapOf(
                "commandId" to commandId,
                "kind" to kind,
                "status" to status,
                "httpStatus" to (error as? GatewayApiHttpError)?.status,
                "errorType" to if (error is GatewayApiHttpError) null else error.javaClass.simpleName,
                "staged" to staged,
            ), callId = callId, level = "warn")
            throw error
        }
    }

    fun replayMigrationPreflight(intent: ReplayMigrationIntent): ReplayMigrationResponse =
        parseReplayMigrationResponse(post(GatewayApiRoutes.REPLAY_MIGRATION_PREFLIGHT, intent.payload))

    fun replayMigrationCommit(intent: ReplayMigrationIntent): ReplayMigrationResponse =
        parseReplayMigrationResponse(post(GatewayApiRoutes.REPLAY_MIGRATION_COMMIT, intent.payload))

    fun replayMigrationComplete(receipt: ReplayMigrationReceipt): Boolean = post(
        GatewayApiRoutes.REPLAY_MIGRATION_COMPLETE,
        JSONObject().put("intentId", receipt.intentId).put("generation", receipt.toGeneration)
            .put("proofDigest", receipt.proofDigest),
    ).getBoolean("completed")

    fun reportSmsEvent(smsId: String, payload: JSONObject) = post(GatewayApiRoutes.smsEvents(smsId), payload)

    fun reportIncomingSms(payload: JSONObject) = post(GatewayApiRoutes.INCOMING_SMS, payload)

    fun reportOutgoingSmsObserved(payload: JSONObject): OutgoingSmsObservedResult {
        val response = post(GatewayApiRoutes.OUTGOING_SMS_OBSERVED, payload)
        return OutgoingSmsObservedResult(
            accepted = response.getBoolean("accepted"),
            replayed = response.optBoolean("replayed"),
            disposition = response.getString("disposition"),
            smsId = if (response.isNull("smsId")) null else response.optString("smsId").takeIf(String::isNotBlank),
        )
    }

    /**
     * S21 §B interception reports. They share the normal incoming routes and carry
     * `blockedLocally:true`; the control service creates a terminal row idempotently by `eventId` and
     * answers nothing this side must parse, so **any 2xx settles the outbox entry**.
     */
    fun reportBlockedIncomingCall(payload: JSONObject): JSONObject =
        post(GatewayApiRoutes.INCOMING_CALL, payload)

    fun reportBlockedIncomingSms(payload: JSONObject): JSONObject =
        post(GatewayApiRoutes.INCOMING_SMS, payload)

    /** S55: `{accepted, replayed, added, removed, rejected}`; 409 `PHONE_SYNC_DISABLED` when not `on`. */
    fun reportBlocklistPhoneChanges(payload: JSONObject): JSONObject =
        post(GatewayApiRoutes.BLOCKLIST_PHONE_CHANGES, payload)

    /**
     * S36 C3: diagnostics upload. Control answers `{accepted}` and nothing here reads it.
     * S36b D2: `X-Diag-Install` follows one install across reinstall-free restarts and re-pairings.
     */
    fun diagEvents(events: org.json.JSONArray, installId: String? = null) {
        postBody(
            GatewayApiRoutes.DIAG_EVENTS, events.toString(),
            // S75: device clock at this send (a retry or a spool replay gets its own), for Control's clock_offset_ms.
            headers = installId?.takeIf(String::isNotBlank)?.let { mapOf("X-Diag-Install" to it) }.orEmpty() +
                ("X-Diag-Sent-At" to System.currentTimeMillis().toString()),
        )
    }

    private fun post(path: String, json: JSONObject, timeoutMs: Long = DEFAULT_TIMEOUT_MS,
                     alternateRetry: Boolean = true): JSONObject =
        postBody(path, json.toString(), timeoutMs, alternateRetry = alternateRetry)

    private fun postBody(
        path: String,
        body: String,
        timeoutMs: Long = DEFAULT_TIMEOUT_MS,
        headers: Map<String, String> = emptyMap(),
        alternateRetry: Boolean = true,
    ): JSONObject {
        check(shouldContinue()) { "gateway disabled" }
        val response = transport.execute(GatewayHttpRequest(
            url = GatewayEndpoint.baseUrl() + path,
            method = "POST",
            authorization = "Bearer $token",
            jsonBody = body.toByteArray(),
            timeoutMs = timeoutMs,
            headers = headers,
            idempotent = GatewayApiRoutes.isIdempotent(path),
            alternateRetry = alternateRetry,
        ))
        check(shouldContinue()) { "gateway disabled" }
        if (response.status !in 200..299) {
            val error = runCatching { JSONObject(response.body).getJSONObject("error") }.getOrNull()
            val message = error?.optString("message").orEmpty()
            throw GatewayApiHttpError(
                response.status,
                error?.optString("code")?.takeIf(String::isNotBlank),
                "HTTP ${response.status}${if (message.isBlank()) "" else ": $message"}",
            )
        }
        return if (response.body.isBlank()) JSONObject() else JSONObject(response.body)
    }

    private companion object {
        const val DEFAULT_TIMEOUT_MS = 15_000L
        /** Connect, TLS and the server's own early return all have to fit inside the extra margin. */
        const val DOORBELL_TIMEOUT_MARGIN_MS = 5_000L
        const val CALL_LOG_PURGE_ACK_LIMIT = 50
    }
}

/** A non-2xx control-plane response, typed so callers can retry only the recoverable rejections. */
internal class GatewayApiHttpError(
    val status: Int,
    val code: String?,
    message: String,
) : IllegalStateException(message)

private fun parseReplayMigrationResponse(value: JSONObject): ReplayMigrationResponse {
    val blockers = value.optJSONArray("blockers")?.let { array ->
        List(array.length()) { index -> array.getJSONObject(index).let {
            ReplayMigrationBlocker(it.getString("code"), it.getLong("count"))
        } }
    }.orEmpty()
    val receipt = value.optJSONObject("receipt")?.let {
        ReplayMigrationReceipt(it.getString("intentId"), it.getString("gatewayId"),
            it.getLong("fromGeneration"), it.getLong("toGeneration"), it.getLong("fromSequence"),
            it.getLong("firstSequence"), it.getString("proofDigest"))
    }
    return ReplayMigrationResponse(value.getBoolean("eligible"), blockers, receipt)
}

private fun ReplayAckEvidence.toJson() = JSONObject().put("sequence", sequence).put("fingerprint", fingerprint)
