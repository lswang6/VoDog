package org.vodog.gateway

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Base64

data class ReplayHorizonProof(
    val phase: String, val gatewayId: String, val generation: Long, val fromInclusive: Long,
    val retireBeforeSequence: Long, val revision: Long, val proofDigest: String,
    val commandCount: Long, val kindCounts: Map<String, Long>,
    val protocolVersion: Int = 1, val finalizedProofs: List<ReplayFinalizedProof> = emptyList(),
)
data class ReplayFinalizedProof(
    val generation: Long, val sequence: Long, val commandId: String, val fingerprint: String,
    val kind: String, val serverStatus: String, val serverReason: String, val entryDigest: String,
)
data class ReplayHorizonEnrollment(
    val gatewayId: String, val generation: Long, val firstSequence: Long,
    val revision: Long, val enrollmentDigest: String,
)
data class ReplayHorizonState(
    val gatewayId: String, val generation: Long, val blockingFloor: Long,
    val preparedRevision: Long, val preparedDigest: String, val committedFloor: Long,
    val committedRevision: Long, val committedDigest: String, val ready: Boolean, val quarantined: Boolean,
    val localBlocked: Boolean = false, val rejectionReason: String? = null,
)
enum class ReplayApplyDisposition { APPLIED, LOCAL_BLOCKED, QUARANTINED, WITHDRAWN }
data class ReplayApplyResult(val disposition: ReplayApplyDisposition, val reason: String? = null)
data class PendingReplayAck(val commandId: String, val body: JSONObject)
data class ReplayMigrationIntent(val intentId: String, val payload: JSONObject)
data class ReplayMigrationReceipt(
    val intentId: String, val gatewayId: String, val fromGeneration: Long,
    val toGeneration: Long, val fromSequence: Long, val firstSequence: Long, val proofDigest: String,
)
data class ReplayMigrationBlocker(val code: String, val count: Long)
data class ReplayMigrationResponse(
    val eligible: Boolean, val blockers: List<ReplayMigrationBlocker>, val receipt: ReplayMigrationReceipt?,
)
enum class ReplayCommandGate { EXECUTE, RETIRED, BLOCKED, QUARANTINE }

internal fun validateReplayTransition(state: ReplayHorizonState, proof: ReplayHorizonProof): String? = when {
    state.quarantined -> "horizon_quarantined"
    state.localBlocked && proof.phase != "control_withdrawn" -> "horizon_local_blocked"
    proof.gatewayId != state.gatewayId || proof.generation != state.generation -> "horizon_identity_mismatch"
    proof.retireBeforeSequence <= 0 || proof.fromInclusive <= 0 || proof.revision <= 0 -> "horizon_invalid"
    !proof.proofDigest.matches(Regex("^[A-Za-z0-9_-]{43}$")) -> "horizon_invalid"
    proof.commandCount < 0 || proof.kindCounts.keys.any { it !in REPLAY_COMMAND_KINDS } ||
        proof.kindCounts.values.any { it < 0 } || proof.kindCounts.values.sum() != proof.commandCount -> "horizon_invalid"
    proof.phase == "proposed" && proof.fromInclusive != state.committedFloor -> "horizon_from_mismatch"
    proof.phase == "proposed" && proof.retireBeforeSequence < state.blockingFloor -> "horizon_floor_rollback"
    proof.phase == "proposed" && proof.revision < state.preparedRevision -> "horizon_revision_rollback"
    proof.phase == "proposed" && proof.revision == state.preparedRevision &&
        (proof.retireBeforeSequence != state.blockingFloor || proof.proofDigest != state.preparedDigest) -> "horizon_prepared_collision"
    proof.phase == "proposed" && state.preparedRevision > state.committedRevision &&
        (proof.revision != state.preparedRevision || proof.retireBeforeSequence != state.blockingFloor ||
            proof.proofDigest != state.preparedDigest) -> "horizon_uncommitted_proposal"
    proof.phase == "control_committed" && (proof.retireBeforeSequence != state.blockingFloor ||
        proof.revision != state.preparedRevision || proof.proofDigest != state.preparedDigest) -> "horizon_unprepared_commit"
    proof.phase == "control_withdrawn" && (!state.localBlocked || proof.revision != state.preparedRevision ||
        proof.proofDigest != state.preparedDigest || state.blockingFloor != state.committedFloor) -> "horizon_unrecognized_withdrawal"
    proof.phase !in setOf("proposed", "control_committed", "control_withdrawn") -> "horizon_phase_unknown"
    else -> null
}

internal fun replayGate(state: ReplayHorizonState, identity: GatewayCommandIdentity, command: GatewayCommand): ReplayCommandGate = when {
    state.quarantined || state.gatewayId != identity.gatewayId || state.generation != identity.generation ||
        command.generation != identity.generation -> ReplayCommandGate.QUARANTINE
    state.localBlocked -> ReplayCommandGate.BLOCKED
    command.sequence < state.blockingFloor -> ReplayCommandGate.RETIRED
    else -> ReplayCommandGate.EXECUTE
}

internal fun retainedLedgerSequences(rows: List<Pair<Long, Boolean>>, committedFloor: Long): List<Long> =
    rows.filter { (sequence, safe) -> sequence >= committedFloor || !safe }.map(Pair<Long, Boolean>::first)

internal fun replayAcceptedAckSafeToRetire(ackPayload: String?): Boolean = runCatching {
    ackPayload != null && JSONObject(ackPayload).optString("sideEffectDisposition") == "not_executed"
}.getOrDefault(false)

/** One device-protected transaction domain for the permanent replay fence and its conservative blocker ledger. */
class GatewayReplayHorizonStore(context: Context, private val identity: GatewayCommandIdentity) {
    private val helper = ReplayDb(context.createDeviceProtectedStorageContext())

    fun state(): ReplayHorizonState = transaction { db ->
        reconcileAcceptedAckSafety(db)
        readState(db)
    }

    fun advertisedState(): ReplayHorizonState? = state().takeIf { it.ready }

    fun applyEnrollment(enrollment: ReplayHorizonEnrollment) = transaction { db ->
        val state = readState(db)
        val valid = enrollment.gatewayId == identity.gatewayId && enrollment.generation == identity.generation &&
            enrollment.firstSequence == 1L && enrollment.revision > 0 &&
            enrollment.enrollmentDigest.matches(Regex("^[A-Za-z0-9_-]{43}$"))
        if (!valid) { quarantine(db, "enrollment_invalid"); return@transaction }
        val prior = db.rawQuery(
            "SELECT enrollment_revision,enrollment_digest FROM gateway_replay_horizon WHERE gateway_id=? AND generation=?",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { it.moveToFirst(); it.getLong(0) to it.getString(1) }
        if (prior.first > 0 && prior != enrollment.revision to enrollment.enrollmentDigest) {
            quarantine(db, "enrollment_collision")
            return@transaction
        }
        if (!state.quarantined) db.execSQL(
            "UPDATE gateway_replay_horizon SET enrollment_revision=?,enrollment_digest=? WHERE gateway_id=? AND generation=?",
            arrayOf<Any>(enrollment.revision, enrollment.enrollmentDigest, identity.gatewayId, identity.generation),
        )
    }

    fun prepareCommand(command: GatewayCommand): ReplayCommandGate = transaction { db ->
        val state = readState(db)
        val gate = replayGate(state, identity, command)
        if (gate == ReplayCommandGate.QUARANTINE) {
            quarantine(db, "command_fence_mismatch")
            return@transaction gate
        }
        if(gate==ReplayCommandGate.RETIRED||gate==ReplayCommandGate.BLOCKED)return@transaction gate
        val fingerprint = commandReplayFingerprint(identity.gatewayId, command)
        val existing = db.rawQuery(
            "SELECT command_id,fingerprint,kind FROM gateway_command_ledger WHERE gateway_id=? AND generation=? AND sequence=?",
            arrayOf(identity.gatewayId, identity.generation.toString(), command.sequence.toString()),
        ).use { cursor -> if (cursor.moveToFirst()) Triple(cursor.getString(0), cursor.getString(1), cursor.getString(2)) else null }
        if (existing != null && (existing.first != command.commandId || existing.second != fingerprint || existing.third != command.kind)) {
            quarantine(db, "command_sequence_collision")
            return@transaction ReplayCommandGate.QUARANTINE
        }
        if (existing == null) db.insertOrThrow("gateway_command_ledger", null, ContentValues().apply {
            put("command_id", command.commandId); put("gateway_id", identity.gatewayId); put("generation", identity.generation)
            put("sequence", command.sequence); put("kind", command.kind); put("fingerprint", fingerprint)
            put("safe_to_retire", 0); put("local_obligations", 1)
        })
        ReplayCommandGate.EXECUTE
    }

    fun markRetirementSafety(commandId: String, safeToRetire: Boolean, localObligations: Boolean) = transaction { db ->
        val changed = db.update("gateway_command_ledger", ContentValues().apply {
            put("safe_to_retire", if (safeToRetire) 1 else 0)
            put("local_obligations", if (localObligations) 1 else 0)
        }, "command_id=? AND gateway_id=? AND generation=?", arrayOf(commandId, identity.gatewayId, identity.generation.toString()))
        check(changed == 1) { "replay ledger command absent" }
    }

    /** Must commit before the platform call/SMS/settings effect is invoked. */
    fun markEffectStarted(commandId: String) = transaction { db ->
        val changed = db.update("gateway_command_ledger", ContentValues().apply {
            put("execution_phase", "effect_started")
            put("safe_to_retire", 0)
            put("local_obligations", 1)
        }, "command_id=? AND gateway_id=? AND generation=? AND execution_phase='prepared'",
            arrayOf(commandId, identity.gatewayId, identity.generation.toString()))
        check(changed == 1) { "replay ledger effect marker absent or repeated" }
    }

    /** ACK bytes and their blocker live in the same transaction as the authoritative command row. */
    fun stageAck(commandId: String, body: JSONObject): JSONObject = transaction { db ->
        val row = db.rawQuery(
            "SELECT l.execution_phase,l.ack_payload,o.payload FROM gateway_command_ledger l LEFT JOIN gateway_command_outbox o ON o.command_id=l.command_id WHERE l.command_id=? AND l.gateway_id=? AND l.generation=?",
            arrayOf(commandId, identity.gatewayId, identity.generation.toString()),
        ).use { cursor ->
            check(cursor.moveToFirst()) { "replay ledger ACK command absent" }
            LocalAckRow(cursor.getString(0),if(cursor.isNull(1))null else cursor.getString(1),
                if(cursor.isNull(2))null else cursor.getString(2))
        }
        val candidate=JSONObject(body.toString())
        fun requireSamePayload(encoded:String):JSONObject{
            val persisted=JSONObject(encoded)
            if(persisted.has("sideEffectDisposition")){
                if(candidate.has("sideEffectDisposition"))check(candidate.getString("sideEffectDisposition")==persisted.getString("sideEffectDisposition")){"replay ACK collision"}
                else candidate.put("sideEffectDisposition",persisted.getString("sideEffectDisposition"))
            }
            check(canonicalJson(encoded)==canonicalJson(candidate.toString())){"replay ACK collision"}
            return persisted
        }
        row.ackPayload?.let{encoded->
            val persisted=requireSamePayload(encoded)
            row.outboxPayload?.let{check(canonicalJson(it)==canonicalJson(encoded)){"replay ACK ledger/outbox collision"}}
                ?:run{
                    db.insertOrThrow("gateway_command_outbox",null,ContentValues().apply{
                        put("command_id",commandId);put("gateway_id",identity.gatewayId)
                        put("generation",identity.generation);put("payload",encoded)
                    })
                    val changed=db.update("gateway_command_ledger",ContentValues().apply{put("local_obligations",1)},
                        "command_id=? AND gateway_id=? AND generation=?",arrayOf(commandId,identity.gatewayId,identity.generation.toString()))
                    check(changed==1){"replay ledger ACK restage absent"}
                }
            return@transaction persisted
        }
        row.outboxPayload?.let{legacy->
            val persisted=requireSamePayload(legacy)
            val changed=db.update("gateway_command_ledger",ContentValues().apply{put("ack_payload",legacy)},
                "command_id=? AND gateway_id=? AND generation=? AND ack_payload IS NULL",
                arrayOf(commandId,identity.gatewayId,identity.generation.toString()))
            check(changed==1){"replay legacy ACK payload unavailable"}
            return@transaction persisted
        }
        candidate.remove("sideEffectDisposition")
        val disposition = when (row.phase) {
            "prepared" -> "not_executed"
            "effect_started" -> if(candidate.optString("status")=="acked")"effect_committed" else if(
                candidate.optJSONObject("result")?.optString("phase")=="unknown" ||
                candidate.optJSONObject("result")?.optString("reason") in setOf("execution_unknown","side_effect_unknown")
            )"unknown" else "effect_started"
            // A v1 ledger may have confirmed result_durable without retaining its first payload.
            // Restage the reconstructed legacy body without inventing a v2 disposition.
            else -> null
        }
        disposition?.let{candidate.put("sideEffectDisposition",it)}
        val encoded = canonicalJson(candidate.toString())
        db.insertOrThrow("gateway_command_outbox", null, ContentValues().apply {
            put("command_id", commandId); put("gateway_id", identity.gatewayId)
            put("generation", identity.generation); put("payload", encoded)
        })
        val changed = db.update("gateway_command_ledger", ContentValues().apply {
            put("execution_phase", "result_durable"); put("local_obligations", 1);put("ack_payload",encoded)
        }, "command_id=? AND gateway_id=? AND generation=?",
            arrayOf(commandId, identity.gatewayId, identity.generation.toString()))
        check(changed == 1) { "replay ledger ACK command absent" }
        JSONObject(encoded)
    }

    fun pendingAcks(): List<PendingReplayAck> = transaction { db ->
        db.rawQuery(
            "SELECT command_id,payload FROM gateway_command_outbox WHERE gateway_id=? AND generation=? ORDER BY created_at,command_id",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { cursor -> buildList {
            while (cursor.moveToNext()) add(PendingReplayAck(cursor.getString(0), JSONObject(cursor.getString(1))))
        } }
    }

    fun prepareMigrationIntent(serverSequence: Long, localProof: JSONObject): ReplayMigrationIntent = transaction { db ->
        require(serverSequence >= 0)
        val state = readState(db)
        check(!state.ready && !state.quarantined) { "replay migration unavailable" }
        val hasPendingAck = db.rawQuery(
            "SELECT EXISTS(SELECT 1 FROM gateway_command_outbox WHERE gateway_id=? AND generation=?)",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { it.moveToFirst(); it.getInt(0) == 1 }
        check(!hasPendingAck) { "replay migration ACK blocker" }
        db.rawQuery(
            "SELECT intent_id,payload FROM gateway_replay_migrations WHERE gateway_id=? AND from_generation=? AND state IN ('prepared','receipt') ORDER BY created_at DESC LIMIT 1",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { cursor ->
            if (cursor.moveToFirst()) return@transaction ReplayMigrationIntent(cursor.getString(0), JSONObject(cursor.getString(1)))
        }
        val intentId = java.util.UUID.randomUUID().toString()
        val payload = JSONObject().put("intentId", intentId).put("generation", identity.generation)
            .put("serverSequence", serverSequence).put("localProof", localProof)
        db.insertOrThrow("gateway_replay_migrations", null, ContentValues().apply {
            put("intent_id", intentId); put("gateway_id", identity.gatewayId); put("from_generation", identity.generation)
            put("from_sequence", serverSequence); put("credential_fingerprint", identity.credentialFingerprint)
            put("request_digest", sha256Base64Url(canonicalJson(payload.toString()))); put("payload", payload.toString())
        })
        ReplayMigrationIntent(intentId, payload)
    }

    fun pendingMigrationIntent(): ReplayMigrationIntent? = transaction { db ->
        db.rawQuery(
            "SELECT intent_id,payload FROM gateway_replay_migrations WHERE gateway_id=? AND from_generation=? AND state='prepared' ORDER BY created_at DESC LIMIT 1",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { cursor -> if (cursor.moveToFirst()) ReplayMigrationIntent(cursor.getString(0), JSONObject(cursor.getString(1))) else null }
    }

    fun migrationIntent(intentId: String): ReplayMigrationIntent? = transaction { db ->
        db.rawQuery("SELECT payload FROM gateway_replay_migrations WHERE intent_id=? AND gateway_id=?",
            arrayOf(intentId, identity.gatewayId)).use { cursor ->
            if (cursor.moveToFirst()) ReplayMigrationIntent(intentId, JSONObject(cursor.getString(0))) else null
        }
    }

    fun persistMigrationReceipt(intent: ReplayMigrationIntent, receipt: ReplayMigrationReceipt) {
        val conflict: String? = transaction { db ->
        val row = db.rawQuery(
            "SELECT from_sequence,request_digest,payload,state FROM gateway_replay_migrations WHERE intent_id=? AND gateway_id=? AND from_generation=?",
            arrayOf(intent.intentId, identity.gatewayId, identity.generation.toString()),
        ).use { cursor ->
            check(cursor.moveToFirst()) { "replay migration intent absent" }
            listOf(cursor.getLong(0), cursor.getString(1), cursor.getString(2), cursor.getString(3))
        }
        val requestDigest = sha256Base64Url(canonicalJson(intent.payload.toString()))
        check(row[1] == requestDigest && canonicalJson(row[2] as String) == canonicalJson(intent.payload.toString())) {
            "replay migration intent collision"
        }
        check(receipt.intentId == intent.intentId && receipt.gatewayId == identity.gatewayId &&
            receipt.fromGeneration == identity.generation && receipt.toGeneration == identity.generation + 1 &&
            receipt.fromSequence == row[0] && receipt.firstSequence == 1L &&
            receipt.proofDigest.matches(Regex("^[A-Za-z0-9_-]{43}$"))) { "replay migration receipt mismatch" }
        val encodedReceipt = JSONObject().put("intentId", receipt.intentId).put("gatewayId", receipt.gatewayId)
            .put("fromGeneration", receipt.fromGeneration).put("toGeneration", receipt.toGeneration)
            .put("fromSequence", receipt.fromSequence).put("firstSequence", receipt.firstSequence)
            .put("proofDigest", receipt.proofDigest).toString()
        if (row[3] == "receipt") {
            val existing = db.rawQuery("SELECT receipt FROM gateway_replay_migrations WHERE intent_id=?", arrayOf(intent.intentId))
                .use { it.moveToFirst(); it.getString(0) }
            check(canonicalJson(existing) == canonicalJson(encodedReceipt)) { "replay migration receipt collision" }
            return@transaction null
        }
        db.insertWithOnConflict("gateway_replay_horizon", null, ContentValues().apply {
            put("gateway_id", identity.gatewayId); put("generation", receipt.toGeneration)
            put("credential_fingerprint", identity.credentialFingerprint); put("enrollment_revision", 1)
            put("enrollment_digest", receipt.proofDigest); put("ready", 1)
        }, SQLiteDatabase.CONFLICT_IGNORE)
        val target = db.rawQuery(
            "SELECT credential_fingerprint,enrollment_revision,enrollment_digest,state FROM gateway_replay_horizon WHERE gateway_id=? AND generation=?",
            arrayOf(identity.gatewayId, receipt.toGeneration.toString()),
        ).use { cursor ->
            check(cursor.moveToFirst())
            listOf(cursor.getString(0), cursor.getLong(1), cursor.getString(2), cursor.getString(3))
        }
        if (target[0] != identity.credentialFingerprint || target[1] != 1L || target[2] != receipt.proofDigest || target[3] == "quarantined") {
            db.execSQL("UPDATE gateway_replay_horizon SET state='quarantined',quarantine_reason='migration_target_collision' WHERE gateway_id=? AND generation=?",
                arrayOf<Any>(identity.gatewayId, receipt.toGeneration))
            quarantine(db, "migration_target_collision")
            return@transaction "replay migration target collision"
        }
        db.execSQL("UPDATE gateway_replay_migrations SET state='receipt',to_generation=?,receipt=? WHERE intent_id=?",
            arrayOf<Any>(receipt.toGeneration, encodedReceipt, intent.intentId))
        null
        }
        conflict?.let { error(it) }
    }

    fun persistedMigrationReceipt(): ReplayMigrationReceipt? = transaction { db ->
        db.rawQuery(
            "SELECT receipt FROM gateway_replay_migrations WHERE gateway_id=? AND from_generation=? AND state='receipt' ORDER BY created_at DESC LIMIT 1",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { cursor -> if (!cursor.moveToFirst()) null else JSONObject(cursor.getString(0)).let {
            ReplayMigrationReceipt(it.getString("intentId"), it.getString("gatewayId"),
                it.getLong("fromGeneration"), it.getLong("toGeneration"), it.getLong("fromSequence"),
                it.getLong("firstSequence"), it.getString("proofDigest"))
        } }
    }

    fun receiptAwaitingCompletionAtCurrentGeneration(): ReplayMigrationReceipt? = transaction { db ->
        db.rawQuery(
            "SELECT receipt FROM gateway_replay_migrations WHERE gateway_id=? AND to_generation=? AND credential_fingerprint=? AND state='receipt' ORDER BY created_at DESC LIMIT 1",
            arrayOf(identity.gatewayId, identity.generation.toString(), identity.credentialFingerprint),
        ).use { cursor -> if (!cursor.moveToFirst()) null else JSONObject(cursor.getString(0)).let {
            ReplayMigrationReceipt(it.getString("intentId"), it.getString("gatewayId"),
                it.getLong("fromGeneration"), it.getLong("toGeneration"), it.getLong("fromSequence"),
                it.getLong("firstSequence"), it.getString("proofDigest"))
        } }
    }

    fun markMigrationApplied(intentId: String) = transaction { db ->
        val changed = db.update("gateway_replay_migrations", ContentValues().apply { put("state", "applied") },
            "intent_id=? AND gateway_id=? AND state='receipt'",
            arrayOf(intentId, identity.gatewayId))
        check(changed == 1) { "replay migration receipt not applicable" }
    }

    fun confirmAck(commandId: String) = transaction { db ->
        val acceptedSafe = db.rawQuery(
            "SELECT ack_payload FROM gateway_command_ledger WHERE command_id=? AND gateway_id=? AND generation=?",
            arrayOf(commandId, identity.gatewayId, identity.generation.toString()),
        ).use { cursor ->
            check(cursor.moveToFirst()) { "replay ledger ACK confirmation absent" }
            replayAcceptedAckSafeToRetire(if (cursor.isNull(0)) null else cursor.getString(0))
        }
        val removed = db.delete("gateway_command_outbox", "command_id=? AND gateway_id=? AND generation=?",
            arrayOf(commandId, identity.gatewayId, identity.generation.toString()))
        check(removed == 1) { "replay ACK outbox entry absent" }
        val changed = db.update("gateway_command_ledger", ContentValues().apply {
            put("ack_accepted", 1); put("local_obligations", 0)
            if (acceptedSafe) put("safe_to_retire", 1)
        }, "command_id=? AND gateway_id=? AND generation=?",
            arrayOf(commandId, identity.gatewayId, identity.generation.toString()))
        check(changed == 1) { "replay ledger ACK confirmation absent" }
    }

    fun refreshEvidence(commandId: String, ackAccepted: Boolean, safeToRetire: Boolean, localObligations: Boolean) =
        transaction { db ->
            val changed = db.update("gateway_command_ledger", ContentValues().apply {
                if (ackAccepted) put("ack_accepted", 1)
                put("safe_to_retire", if (safeToRetire) 1 else 0)
                put("local_obligations", if (localObligations) 1 else 0)
            }, "command_id=? AND gateway_id=? AND generation=?",
                arrayOf(commandId, identity.gatewayId, identity.generation.toString()))
            check(changed == 1) { "replay ledger command absent" }
        }

    fun evidenceRows(): List<Pair<String, String>> = transaction { db ->
        db.rawQuery(
            "SELECT command_id,kind FROM gateway_command_ledger WHERE gateway_id=? AND generation=? AND safe_to_retire=0",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(0) to cursor.getString(1)) }
        }
    }

    fun maybeMarkReady(serverSequence: Long) = transaction { db ->
        val state=readState(db); if(state.ready||state.quarantined||serverSequence<0)return@transaction
        val enrolled = db.rawQuery(
            "SELECT enrollment_revision>0 FROM gateway_replay_horizon WHERE gateway_id=? AND generation=?",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { it.moveToFirst(); it.getInt(0) == 1 }
        if (!enrolled) return@transaction
        val count=db.rawQuery("SELECT COUNT(*),COALESCE(MIN(sequence),0),COALESCE(MAX(sequence),0) FROM gateway_command_ledger WHERE gateway_id=? AND generation=?",
            arrayOf(identity.gatewayId,identity.generation.toString())).use{it.moveToFirst();Triple(it.getLong(0),it.getLong(1),it.getLong(2))}
        // A fresh generation is provable only when every allocated sequence from one is in this ledger.
        if((serverSequence==0L&&count.first==0L)||(count.first==serverSequence&&count.second==1L&&count.third==serverSequence)){
            db.execSQL("UPDATE gateway_replay_horizon SET ready=1 WHERE gateway_id=? AND generation=?",arrayOf<Any>(identity.gatewayId,identity.generation))
        }
    }

    fun apply(proof: ReplayHorizonProof): ReplayApplyResult = transaction { db ->
        reconcileAcceptedAckSafety(db)
        val state=readState(db)
        validateReplayTransition(state,proof)?.let{reason->
            if(reason=="horizon_local_blocked")return@transaction ReplayApplyResult(ReplayApplyDisposition.LOCAL_BLOCKED,reason)
            quarantine(db,reason);return@transaction ReplayApplyResult(ReplayApplyDisposition.QUARANTINED,reason)
        }
        validateWireProof(proof)?.let { reason ->
            quarantine(db,reason);return@transaction ReplayApplyResult(ReplayApplyDisposition.QUARANTINED,reason)
        }
        if(proof.phase=="proposed"&&state.blockingFloor==proof.retireBeforeSequence&&
            state.preparedRevision==proof.revision&&state.preparedDigest==proof.proofDigest)
            return@transaction ReplayApplyResult(ReplayApplyDisposition.APPLIED)
        if(proof.phase=="control_withdrawn"){
            db.execSQL("UPDATE gateway_replay_horizon SET blocking_floor=committed_floor,prepared_revision=committed_revision,prepared_digest=committed_digest,state='ready',quarantine_reason=NULL WHERE gateway_id=? AND generation=?",
                arrayOf<Any>(identity.gatewayId,identity.generation))
            return@transaction ReplayApplyResult(ReplayApplyDisposition.WITHDRAWN)
        }
        if(proof.phase=="proposed"){
            when(val range=validateAndAttestRange(db,proof,markFinalized = false)){
                null -> Unit
                "horizon_local_blocker" -> {
                    db.execSQL("UPDATE gateway_replay_horizon SET state='local_blocked',quarantine_reason=?,prepared_revision=?,prepared_digest=? WHERE gateway_id=? AND generation=?",
                        arrayOf<Any>(range,proof.revision,proof.proofDigest,identity.gatewayId,identity.generation))
                    return@transaction ReplayApplyResult(ReplayApplyDisposition.LOCAL_BLOCKED,range)
                }
                else -> { quarantine(db,range);return@transaction ReplayApplyResult(ReplayApplyDisposition.QUARANTINED,range) }
            }
            // Re-read every predicate immediately before changing a PREPARED row into an attestation.
            // This transaction shares the same SQLite writer lock as markEffectStarted().
            validateAndAttestRange(db,proof,markFinalized = true)?.let { reason ->
                if(reason=="horizon_local_blocker"){
                    db.execSQL("UPDATE gateway_replay_horizon SET state='local_blocked',quarantine_reason=?,prepared_revision=?,prepared_digest=? WHERE gateway_id=? AND generation=?",
                        arrayOf<Any>(reason,proof.revision,proof.proofDigest,identity.gatewayId,identity.generation))
                    return@transaction ReplayApplyResult(ReplayApplyDisposition.LOCAL_BLOCKED,reason)
                }
                quarantine(db,reason);return@transaction ReplayApplyResult(ReplayApplyDisposition.QUARANTINED,reason)
            }
            db.execSQL("UPDATE gateway_replay_horizon SET blocking_floor=?,prepared_revision=?,prepared_digest=? WHERE gateway_id=? AND generation=?",
                arrayOf<Any>(proof.retireBeforeSequence,proof.revision,proof.proofDigest,identity.gatewayId,identity.generation))
        }else{
            // committed floor is durable before any physical deletion in this same transaction.
            db.execSQL("UPDATE gateway_replay_horizon SET committed_floor=?,committed_revision=?,committed_digest=? WHERE gateway_id=? AND generation=?",
                arrayOf<Any>(proof.retireBeforeSequence,proof.revision,proof.proofDigest,identity.gatewayId,identity.generation))
            db.delete("gateway_command_ledger","gateway_id=? AND generation=? AND sequence<? AND safe_to_retire=1 AND local_obligations=0 AND (ack_accepted=1 OR execution_phase='server_finalized_not_executed') AND NOT EXISTS (SELECT 1 FROM gateway_command_outbox o WHERE o.command_id=gateway_command_ledger.command_id)",
                arrayOf(identity.gatewayId,identity.generation.toString(),proof.retireBeforeSequence.toString()))
        }
        ReplayApplyResult(ReplayApplyDisposition.APPLIED)
    }

    internal fun ledgerSize(): Long = transaction { db ->
        db.rawQuery("SELECT COUNT(*) FROM gateway_command_ledger WHERE gateway_id=? AND generation=?",
            arrayOf(identity.gatewayId, identity.generation.toString())).use { it.moveToFirst(); it.getLong(0) }
    }

    internal fun close() = helper.close()

    fun quarantine(reason:String)=transaction{db->quarantine(db,reason)}

    private fun validateWireProof(proof: ReplayHorizonProof):String?{
        if(proof.protocolVersion==1)return if(proof.finalizedProofs.isEmpty())null else "horizon_invalid_finalized_proof"
        if(proof.protocolVersion!=2)return "horizon_protocol_unknown"
        if(proof.finalizedProofs.map{it.sequence}.distinct().size!=proof.finalizedProofs.size)return "horizon_duplicate_finalized_proof"
        for(entry in proof.finalizedProofs){
            if(entry.generation!=proof.generation||entry.sequence !in proof.fromInclusive until proof.retireBeforeSequence||
                entry.commandId.isBlank()||entry.fingerprint.length!=43||entry.kind !in REPLAY_COMMAND_KINDS||entry.serverStatus!="rejected"||
                !((entry.serverReason=="media_capability_withdrawn"&&entry.kind in setOf("dial","answer"))||
                    (entry.serverReason=="settings_superseded"&&entry.kind=="apply_sim_settings"))||
                replayFinalizedEntryDigest(entry)!=entry.entryDigest)return "horizon_invalid_finalized_proof"
        }
        return if(replayProposalWireDigest(proof)==proof.proofDigest)null else "horizon_proof_digest_mismatch"
    }

    private fun validateAndAttestRange(db:SQLiteDatabase, proof: ReplayHorizonProof, markFinalized:Boolean):String?{
        val from = proof.fromInclusive
        val to = proof.retireBeforeSequence
        if(to<from)return "horizon_local_blocker"
        val rows = db.rawQuery(
            "SELECT sequence,command_id,fingerprint,kind,execution_phase,safe_to_retire,ack_accepted,local_obligations FROM gateway_command_ledger WHERE gateway_id=? AND generation=? AND sequence>=? AND sequence<? ORDER BY sequence",
            arrayOf(identity.gatewayId, identity.generation.toString(), from.toString(), to.toString()),
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(LocalReplayRow(cursor.getLong(0),cursor.getString(1),cursor.getString(2),cursor.getString(3),
                    cursor.getString(4),cursor.getInt(5),cursor.getInt(6),cursor.getInt(7)))
            }
        }
        val expected=to-from
        if (proof.commandCount != expected) return "horizon_range_count_mismatch"
        val bySequence=rows.associateBy{it.sequence};val finalized=proof.finalizedProofs.associateBy{it.sequence}
        for(sequence in from until to){
            val row=bySequence[sequence];val exact=finalized[sequence]
            if(exact!=null){
                if(row==null)continue
                if(row.commandId!=exact.commandId||row.fingerprint!=exact.fingerprint||row.kind!=exact.kind)return "horizon_finalized_identity_mismatch"
                if(row.phase!="prepared"||row.safe!=0||row.ackAccepted!=0||row.localObligations!=1)return "horizon_local_blocker"
            }else if(row==null||row.safe!=1||row.ackAccepted!=1||row.localObligations!=0)return "horizon_local_blocker"
        }
        val pendingOutbox = db.rawQuery(
            "SELECT EXISTS(SELECT 1 FROM gateway_command_outbox o JOIN gateway_command_ledger l ON l.command_id=o.command_id WHERE l.gateway_id=? AND l.generation=? AND l.sequence>=? AND l.sequence<?)",
            arrayOf(identity.gatewayId, identity.generation.toString(), from.toString(), to.toString()),
        ).use { it.moveToFirst(); it.getInt(0) == 1 }
        if (pendingOutbox) return "horizon_local_blocker"
        val localKinds=(rows.map{it.sequence to it.kind}+proof.finalizedProofs.filter{it.sequence !in bySequence}.map{it.sequence to it.kind}).toMap()
        val localKindCounts=localKinds.values.groupingBy{it}.eachCount().mapValues{it.value.toLong()}
        if(REPLAY_COMMAND_KINDS.associateWith{localKindCounts[it]?:0L}!=REPLAY_COMMAND_KINDS.associateWith{proof.kindCounts[it]?:0L})return "horizon_kind_count_mismatch"
        if(markFinalized)proof.finalizedProofs.forEach{entry->
            if(bySequence[entry.sequence]!=null){
                val changed=db.update("gateway_command_ledger",ContentValues().apply{
                    put("execution_phase","server_finalized_not_executed");put("safe_to_retire",1);put("local_obligations",0)
                },"gateway_id=? AND generation=? AND sequence=? AND command_id=? AND fingerprint=? AND kind=? AND execution_phase='prepared' AND safe_to_retire=0 AND ack_accepted=0 AND local_obligations=1 AND NOT EXISTS (SELECT 1 FROM gateway_command_outbox WHERE command_id=?)",
                    arrayOf(identity.gatewayId,identity.generation.toString(),entry.sequence.toString(),entry.commandId,entry.fingerprint,entry.kind,entry.commandId))
                if(changed!=1)return "horizon_local_blocker"
            }
        }
        return null
    }
    private fun reconcileAcceptedAckSafety(db: SQLiteDatabase) {
        val recoverable = db.rawQuery(
            "SELECT command_id,ack_payload FROM gateway_command_ledger " +
                "WHERE gateway_id=? AND generation=? AND ack_accepted=1 AND local_obligations=0 " +
                "AND safe_to_retire=0 AND ack_payload IS NOT NULL " +
                "AND NOT EXISTS (SELECT 1 FROM gateway_command_outbox o WHERE o.command_id=gateway_command_ledger.command_id)",
            arrayOf(identity.gatewayId, identity.generation.toString()),
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    if (replayAcceptedAckSafeToRetire(cursor.getString(1))) add(cursor.getString(0))
                }
            }
        }
        recoverable.forEach { commandId ->
            db.update(
                "gateway_command_ledger", ContentValues().apply { put("safe_to_retire", 1) },
                "command_id=? AND gateway_id=? AND generation=? AND ack_accepted=1 AND local_obligations=0 AND safe_to_retire=0 " +
                    "AND NOT EXISTS (SELECT 1 FROM gateway_command_outbox WHERE command_id=?)",
                arrayOf(commandId, identity.gatewayId, identity.generation.toString(), commandId),
            )
        }
    }

    private fun readState(db:SQLiteDatabase):ReplayHorizonState{
        val highest = db.rawQuery("SELECT MAX(generation) FROM gateway_replay_horizon WHERE gateway_id=?", arrayOf(identity.gatewayId))
            .use { cursor -> cursor.moveToFirst(); if (cursor.isNull(0)) null else cursor.getLong(0) }
        val staleGeneration = highest != null && identity.generation < highest
        db.insertWithOnConflict("gateway_replay_horizon",null,ContentValues().apply{
            put("gateway_id",identity.gatewayId);put("generation",identity.generation);put("credential_fingerprint",identity.credentialFingerprint)
            if (staleGeneration) { put("state", "quarantined"); put("quarantine_reason", "stale_generation_restore") }
        },SQLiteDatabase.CONFLICT_IGNORE)
        if (staleGeneration) quarantine(db, "stale_generation_restore")
        return db.rawQuery("SELECT credential_fingerprint,blocking_floor,prepared_revision,prepared_digest,committed_floor,committed_revision,committed_digest,ready,state,quarantine_reason FROM gateway_replay_horizon WHERE gateway_id=? AND generation=?",
            arrayOf(identity.gatewayId,identity.generation.toString())).use{c->
            check(c.moveToFirst()) { "replay identity unreadable" }
            val credentialMismatch = c.getString(0) != identity.credentialFingerprint
            if (credentialMismatch) quarantine(db, "credential_restore_mismatch")
            val localState=c.getString(8);val reason=if(c.isNull(9))null else c.getString(9)
            ReplayHorizonState(identity.gatewayId,identity.generation,c.getLong(1),c.getLong(2),c.getString(3),c.getLong(4),c.getLong(5),c.getString(6),c.getInt(7)==1,
                credentialMismatch || localState=="quarantined",localState=="local_blocked",reason)
        }
    }
    private fun quarantine(db:SQLiteDatabase,reason:String){db.execSQL("UPDATE gateway_replay_horizon SET state='quarantined',quarantine_reason=? WHERE gateway_id=? AND generation=?",arrayOf<Any>(reason.take(80),identity.gatewayId,identity.generation))}
    private fun <T> transaction(block:(SQLiteDatabase)->T):T{
        val db=helper.writableDatabase;db.beginTransactionNonExclusive();return try{block(db).also{db.setTransactionSuccessful()}}finally{db.endTransaction()}
    }
}

private data class LocalAckRow(val phase:String,val ackPayload:String?,val outboxPayload:String?)
private data class LocalReplayRow(val sequence:Long,val commandId:String,val fingerprint:String,val kind:String,val phase:String,
    val safe:Int,val ackAccepted:Int,val localObligations:Int)

private class ReplayDb(context:Context):SQLiteOpenHelper(context,"gateway_replay_horizon.db",null,1){
    // WAL must be requested through the helper. Calling enableWriteAheadLogging() inside onConfigure
    // switches journal modes while the helper still believes WAL is off, which produced the
    // "database is locked [PRAGMA journal_mode=TRUNCATE]" storms in logcat.
    init { setWriteAheadLoggingEnabled(true) }
    override fun onConfigure(db:SQLiteDatabase){db.setForeignKeyConstraintsEnabled(true)}
    override fun onCreate(db:SQLiteDatabase){
        db.execSQL("CREATE TABLE gateway_replay_horizon(gateway_id TEXT NOT NULL,generation INTEGER NOT NULL,credential_fingerprint TEXT NOT NULL,enrollment_revision INTEGER NOT NULL DEFAULT 0,enrollment_digest TEXT NOT NULL DEFAULT '',blocking_floor INTEGER NOT NULL DEFAULT 1,prepared_revision INTEGER NOT NULL DEFAULT 0,prepared_digest TEXT NOT NULL DEFAULT '',committed_floor INTEGER NOT NULL DEFAULT 1,committed_revision INTEGER NOT NULL DEFAULT 0,committed_digest TEXT NOT NULL DEFAULT '',ready INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'ready',quarantine_reason TEXT,PRIMARY KEY(gateway_id,generation))")
        db.execSQL("CREATE TABLE gateway_command_ledger(command_id TEXT PRIMARY KEY,gateway_id TEXT NOT NULL,generation INTEGER NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,execution_phase TEXT NOT NULL DEFAULT 'prepared',ack_accepted INTEGER NOT NULL DEFAULT 0,safe_to_retire INTEGER NOT NULL DEFAULT 0,local_obligations INTEGER NOT NULL DEFAULT 1,ack_payload TEXT,UNIQUE(gateway_id,generation,sequence),FOREIGN KEY(gateway_id,generation) REFERENCES gateway_replay_horizon(gateway_id,generation))")
        db.execSQL("CREATE TABLE gateway_command_outbox(command_id TEXT PRIMARY KEY,gateway_id TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,last_failure_code TEXT,created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),FOREIGN KEY(command_id) REFERENCES gateway_command_ledger(command_id))")
        db.execSQL("CREATE TABLE gateway_replay_migrations(intent_id TEXT PRIMARY KEY,gateway_id TEXT NOT NULL,from_generation INTEGER NOT NULL,from_sequence INTEGER NOT NULL,to_generation INTEGER,credential_fingerprint TEXT NOT NULL,request_digest TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'prepared',receipt TEXT,created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))")
    }
    override fun onOpen(db:SQLiteDatabase){
        super.onOpen(db)
        val hasAckPayload=db.rawQuery("PRAGMA table_info(gateway_command_ledger)",null).use{cursor->
            var found=false
            while(cursor.moveToNext())if(cursor.getString(cursor.getColumnIndexOrThrow("name"))=="ack_payload")found=true
            found
        }
        if(!hasAckPayload){
            db.beginTransaction()
            try{
                val stillMissing=db.rawQuery("PRAGMA table_info(gateway_command_ledger)",null).use{cursor->
                    var missing=true
                    while(cursor.moveToNext())if(cursor.getString(cursor.getColumnIndexOrThrow("name"))=="ack_payload")missing=false
                    missing
                }
                if(stillMissing){
                    db.execSQL("ALTER TABLE gateway_command_ledger ADD COLUMN ack_payload TEXT")
                    db.execSQL("UPDATE gateway_command_ledger SET ack_payload=(SELECT payload FROM gateway_command_outbox WHERE gateway_command_outbox.command_id=gateway_command_ledger.command_id) WHERE ack_payload IS NULL AND EXISTS(SELECT 1 FROM gateway_command_outbox WHERE gateway_command_outbox.command_id=gateway_command_ledger.command_id)")
                }
                db.setTransactionSuccessful()
            }finally{db.endTransaction()}
        }
    }
    override fun onUpgrade(db:SQLiteDatabase,oldVersion:Int,newVersion:Int)=error("unsupported replay DB upgrade")
}

internal fun canonicalJson(raw: String): String {
    return canonicalReplayJsonValue(JSONObject(raw))
}

/** Android's JSONObject.quote escapes '/', unlike JSON.stringify and the JVM org.json artifact. */
private fun quoteReplayJsonString(value: String): String = buildString(value.length + 2) {
    append('"')
    var index = 0
    while (index < value.length) {
        val char = value[index]
        when (char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            in '\u0000'..'\u001f' -> append("\\u").append(char.code.toString(16).padStart(4, '0'))
            in '\ud800'..'\udbff' -> {
                val low = value.getOrNull(index + 1)
                if (low != null && low in '\udc00'..'\udfff') {
                    append(char).append(low)
                    index += 1
                } else append("\\u").append(char.code.toString(16).padStart(4, '0'))
            }
            in '\udc00'..'\udfff' -> append("\\u").append(char.code.toString(16).padStart(4, '0'))
            else -> append(char)
        }
        index += 1
    }
    append('"')
}

/** All current command numeric fields are schema-validated JavaScript safe integers. */
private fun replayJsonNumber(value: Number): String {
    val integer = try {
        when (value) {
            is java.math.BigInteger -> value
            is java.math.BigDecimal -> value.toBigIntegerExact()
            is Byte, is Short, is Int, is Long -> java.math.BigInteger.valueOf(value.toLong())
            is Float, is Double -> {
                val double = value.toDouble()
                require(double.isFinite()) { "non-finite replay JSON number" }
                java.math.BigDecimal.valueOf(double).toBigIntegerExact()
            }
            else -> java.math.BigDecimal(value.toString()).toBigIntegerExact()
        }
    } catch (error: ArithmeticException) {
        throw IllegalArgumentException("replay JSON number is outside the safe-integer schema", error)
    }
    require(integer.abs() <= MAX_REPLAY_SAFE_INTEGER) {
        "replay JSON number is outside the safe-integer schema"
    }
    return integer.toString()
}

private val MAX_REPLAY_SAFE_INTEGER = java.math.BigInteger("9007199254740991")

private fun replayArrayIndex(key: String): Long? {
    if (key == "0") return 0
    if (key.isEmpty() || key[0] == '0' || key.any { it !in '0'..'9' }) return null
    return key.toLongOrNull()?.takeIf { it <= 4_294_967_294L && it.toString() == key }
}

/** Object.fromEntries(sorted) is finally serialized by JS property enumeration rules. */
private fun replayJsonObjectKeys(keys: Collection<String>): List<String> = keys.sortedWith { left, right ->
    val leftIndex = replayArrayIndex(left)
    val rightIndex = replayArrayIndex(right)
    when {
        leftIndex != null && rightIndex != null -> leftIndex.compareTo(rightIndex)
        leftIndex != null -> -1
        rightIndex != null -> 1
        else -> left.compareTo(right)
    }
}

private fun canonicalReplayJsonValue(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> replayJsonObjectKeys(value.keys().asSequence().toList()).joinToString(
        separator = ",", prefix = "{", postfix = "}",
    ) { key -> quoteReplayJsonString(key) + ":" + canonicalReplayJsonValue(value.get(key)) }
    is org.json.JSONArray -> (0 until value.length()).joinToString(
        separator = ",", prefix = "[", postfix = "]",
    ) { canonicalReplayJsonValue(value.get(it)) }
    is Iterable<*> -> value.joinToString(separator = ",", prefix = "[", postfix = "]") {
        canonicalReplayJsonValue(it)
    }
    is Array<*> -> value.joinToString(separator = ",", prefix = "[", postfix = "]") {
        canonicalReplayJsonValue(it)
    }
    is Map<*, *> -> replayJsonObjectKeys(value.keys.map { it as String }).joinToString(
        separator = ",", prefix = "{", postfix = "}",
    ) { key -> quoteReplayJsonString(key) + ":" + canonicalReplayJsonValue(value[key]) }
    is String -> quoteReplayJsonString(value)
    is Number -> replayJsonNumber(value)
    is Boolean -> value.toString()
    else -> error("unsupported replay JSON value ${value::class.java.name}")
}

private fun sha256Base64Url(value: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(
    MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)),
)

internal fun commandReplayFingerprint(gatewayId: String, command:GatewayCommand):String{
    val stable = mapOf<String, Any?>(
        "id" to command.commandId,
        "gatewayId" to gatewayId,
        "generation" to command.generation,
        "sequence" to command.sequence,
        "kind" to command.kind,
        "payload" to JSONObject(command.payloadJson),
    )
    return Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(canonicalReplayJsonValue(stable).toByteArray(Charsets.UTF_8)),
    )
}

internal fun replayFinalizedEntryDigest(entry:ReplayFinalizedProof):String{
    val stable=mapOf<String,Any?>(
        "generation" to entry.generation,"sequence" to entry.sequence,"commandId" to entry.commandId,
        "fingerprint" to entry.fingerprint,"kind" to entry.kind,"serverStatus" to entry.serverStatus,
        "serverReason" to entry.serverReason,
    )
    return sha256Base64Url(canonicalReplayJsonValue(stable))
}

internal fun replayProposalWireDigest(proof:ReplayHorizonProof):String{
    val finalized=org.json.JSONArray()
    proof.finalizedProofs.forEach{entry->finalized.put(JSONObject()
        .put("generation",entry.generation).put("sequence",entry.sequence).put("commandId",entry.commandId)
        .put("fingerprint",entry.fingerprint).put("kind",entry.kind).put("serverStatus",entry.serverStatus)
        .put("serverReason",entry.serverReason).put("entryDigest",entry.entryDigest))}
    val kindCounts=JSONObject()
    proof.kindCounts.forEach{(kind,count)->kindCounts.put(kind,count)}
    val stable=JSONObject()
        .put("protocolVersion",2).put("gatewayId",proof.gatewayId).put("generation",proof.generation)
        .put("fromInclusive",proof.fromInclusive).put("retireBeforeSequence",proof.retireBeforeSequence)
        .put("revision",proof.revision).put("commandCount",proof.commandCount).put("kindCounts",kindCounts)
        .put("finalizedProofs",finalized)
    return sha256Base64Url(canonicalReplayJsonValue(stable))
}

// S36 C2: "dtmf" belongs here even though it never reaches the call journal. Control counts every
// kind in the covered window, so an unlisted kind makes the first horizon proof carrying it
// "horizon_invalid" and quarantines the gateway.
private val REPLAY_COMMAND_KINDS = setOf("dial", "answer", "hangup", "send_sms", "apply_sim_settings", "dtmf")

object GatewayReplayHorizonApproval {
    // Physical rollout remains separately gated by BuildConfig. The authoritative SQLite fence,
    // ACK outbox, monotonic terminal proofs, committed-floor GC, and audited epoch migration are
    // now implemented; a replay-enabled build may therefore advertise protocol v1.
    private const val FULL_LEDGER_MIGRATION_READY = true
    val ENABLED = BuildConfig.COMMAND_REPLAY_HORIZON_ENABLED && FULL_LEDGER_MIGRATION_READY
}

object GatewayReplayHorizonEnrollmentApproval {
    // Enrollment and epoch migration create the authority used by protocol v1, so they share its
    // implementation-readiness gate rather than trusting the build flag alone.
    val ENABLED = GatewayReplayHorizonApproval.ENABLED
}
