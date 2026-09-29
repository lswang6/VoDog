package org.vodog.gateway

import androidx.test.core.app.ApplicationProvider
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class GatewayReplayHorizonStorageTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val identity = GatewayCommandIdentity("gateway-storage-test", 2, "a".repeat(64))
    private lateinit var store: GatewayReplayHorizonStore

    @Before fun setUp() {
        context.createDeviceProtectedStorageContext().deleteDatabase("gateway_replay_horizon.db")
        store = GatewayReplayHorizonStore(context, identity)
        store.applyEnrollment(ReplayHorizonEnrollment(identity.gatewayId, identity.generation, 1, 1, "e".repeat(43)))
        store.maybeMarkReady(0)
    }

    @After fun tearDown() { store.close() }

    @Test fun stagedAckSurvivesStoreRestartUntilAccepted() {
        val command = command(1, "dial")
        store.prepareCommand(command)
        store.markEffectStarted(command.commandId)
        val body = JSONObject().put("generation", 2).put("status", "acked")
        val staged=store.stageAck(command.commandId, body)
        assertEquals("effect_committed",staged.getString("sideEffectDisposition"))
        store.close()

        store = GatewayReplayHorizonStore(context, identity)
        val pending=store.pendingAcks().single()
        assertEquals(command.commandId,pending.commandId)
        assertEquals(canonicalJson(staged.toString()),canonicalJson(pending.body.toString()))
        store.confirmAck(command.commandId)
        assertTrue(store.pendingAcks().isEmpty())
    }

    @Test fun committedFloorNeverDeletesUnsafeRow() {
        (1L..2L).forEach { sequence -> store.prepareCommand(command(sequence, "dial")) }
        accept(command(1, "dial"), true)
        accept(command(2, "dial"), false)
        val proof = proof(1, 3, 1, mapOf("dial" to 2))
        assertEquals(ReplayApplyDisposition.LOCAL_BLOCKED, store.apply(proof).disposition)
        assertEquals(2, store.ledgerSize())
        assertEquals(1, store.state().committedFloor)
    }

    @Test fun v2FinalizedProofRetiresAnAbsentHoleAndExactPreparedSentinelAcrossRestart() {
        val safe = command(1, "dial")
        val prepared = command(3, "dial")
        store.prepareCommand(safe); accept(safe, true)
        store.prepareCommand(prepared) // Real PREPARED shape: local_obligations=1, no effect and no outbox.
        val proof = v2Proof(1, 4, 1, mapOf("dial" to 3), listOf(
            finalized(2, command(2,"dial")), finalized(3, prepared),
        ))
        assertEquals(ReplayApplyDisposition.APPLIED, store.apply(proof).disposition)
        assertEquals(4, store.state().blockingFloor)
        store.close(); store=GatewayReplayHorizonStore(context,identity)
        assertEquals(4, store.state().blockingFloor)
        assertEquals(ReplayApplyDisposition.APPLIED,store.apply(proof).disposition)
        assertEquals(4,store.state().blockingFloor)
        assertEquals(ReplayApplyDisposition.APPLIED,store.apply(proof.copy(phase="control_committed")).disposition)
        assertEquals(0,store.ledgerSize())
    }

    @Test fun effectMarkerAndOutboxNeverMasqueradeAsFinalizedNotExecutedAndWithdrawalRecoversHeartbeatState() {
        val command=command(1,"dial");store.prepareCommand(command);store.markEffectStarted(command.commandId)
        val proof=v2Proof(1,2,1,mapOf("dial" to 1),listOf(finalized(1,command)))
        assertEquals(ReplayApplyDisposition.LOCAL_BLOCKED,store.apply(proof).disposition)
        assertEquals(1,store.state().blockingFloor)
        val next=command(2,"dial")
        assertEquals(ReplayCommandGate.BLOCKED,store.prepareCommand(next))
        assertTrue(store.state().localBlocked)
        assertTrue(!store.state().quarantined)
        store.close();store=GatewayReplayHorizonStore(context,identity)
        assertTrue(store.state().localBlocked)
        assertEquals(ReplayApplyDisposition.WITHDRAWN,store.apply(proof.copy(phase="control_withdrawn")).disposition)
        assertTrue(!store.state().localBlocked)
        assertEquals(1,store.state().blockingFloor)
        assertEquals(ReplayCommandGate.EXECUTE,store.prepareCommand(next))
    }

    @Test fun forgedFinalizedIdentityQuarantinesWithoutAdvancingFloor() {
        val command=command(1,"dial");store.prepareCommand(command)
        val valid=finalized(1,command)
        val forged=valid.copy(fingerprint="f".repeat(43)).let{it.copy(entryDigest=replayFinalizedEntryDigest(it))}
        val proof=v2Proof(1,2,1,mapOf("dial" to 1),listOf(forged))
        assertEquals(ReplayApplyDisposition.QUARANTINED,store.apply(proof).disposition)
        assertEquals(1,store.state().blockingFloor)
        assertTrue(store.state().quarantined)
    }

    @Test fun ackDispositionIsDerivedBeforeResultDurabilityAndCannotRegressOnRetry() {
        val before=command(1,"dial");store.prepareCommand(before)
        val rejected=JSONObject().put("generation",2).put("status","rejected").put("result",JSONObject().put("phase","not_executed"))
        assertEquals("not_executed",store.stageAck(before.commandId,rejected).getString("sideEffectDisposition"))
        assertEquals("not_executed",store.stageAck(before.commandId,JSONObject().put("generation",2).put("status","rejected").put("result",JSONObject().put("phase","not_executed"))).getString("sideEffectDisposition"))
        store.confirmAck(before.commandId)
        assertEquals("not_executed",store.stageAck(before.commandId,rejected).getString("sideEffectDisposition"))
        store.confirmAck(before.commandId)

        val after=command(2,"dial");store.prepareCommand(after);store.markEffectStarted(after.commandId)
        val postMarker=JSONObject().put("generation",2).put("status","rejected").put("result",JSONObject().put("phase","not_executed"))
        assertEquals("effect_started",store.stageAck(after.commandId,postMarker).getString("sideEffectDisposition"))

        val success=command(3,"dial");store.prepareCommand(success);store.markEffectStarted(success.commandId)
        val acked=JSONObject().put("generation",2).put("status","acked").put("result",JSONObject().put("phase","submitted"))
        assertEquals("effect_committed",store.stageAck(success.commandId,acked).getString("sideEffectDisposition"))
        store.confirmAck(success.commandId)
        assertEquals("effect_committed",store.stageAck(success.commandId,acked).getString("sideEffectDisposition"))
        assertThrows(IllegalStateException::class.java){store.stageAck(success.commandId,
            JSONObject().put("generation",2).put("status","acked").put("result",JSONObject().put("phase","different")))}
        store.confirmAck(success.commandId)

        val idempotent=command(4,"apply_sim_settings");store.prepareCommand(idempotent)
        val noOpAck=JSONObject().put("generation",2).put("status","acked").put("result",JSONObject().put("appliedVersion",1))
        assertEquals("not_executed",store.stageAck(idempotent.commandId,noOpAck).getString("sideEffectDisposition"))
    }

    @Test fun acceptedNotExecutedAckRetiresWithoutBusinessJournalAndRepairsPriorConfirmedRows() {
        val malformedSms = command(1, "send_sms")
        store.prepareCommand(malformedSms)
        val rejected = JSONObject().put("generation", 2).put("status", "rejected")
            .put("result", JSONObject().put("phase", "not_executed").put("reason", "invalid_sms_command"))
        assertEquals("not_executed", store.stageAck(malformedSms.commandId, rejected).getString("sideEffectDisposition"))
        store.confirmAck(malformedSms.commandId)
        val firstProof = proof(1, 2, 1, mapOf("send_sms" to 1))
        assertEquals(ReplayApplyDisposition.APPLIED, store.apply(firstProof).disposition)
        assertEquals(ReplayApplyDisposition.APPLIED, store.apply(firstProof.copy(phase = "control_committed")).disposition)

        val historical = command(2, "send_sms")
        store.prepareCommand(historical)
        store.stageAck(historical.commandId, rejected.put("generation", 2))
        store.confirmAck(historical.commandId)
        store.close()
        val protected = context.createDeviceProtectedStorageContext()
        SQLiteDatabase.openDatabase(protected.getDatabasePath("gateway_replay_horizon.db").absolutePath, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            db.execSQL("UPDATE gateway_command_ledger SET safe_to_retire=0 WHERE command_id=?", arrayOf(historical.commandId))
        }
        store = GatewayReplayHorizonStore(context, identity)
        store.state()
        assertEquals(ReplayApplyDisposition.APPLIED, store.apply(proof(2, 3, 2, mapOf("send_sms" to 1))).disposition)
    }

    @Test fun v1OutboxMigrationRetainsLegacyPayloadAcrossConfirmationAndRetry() {
        val command=command(1,"dial")
        val confirmed=command(2,"dial")
        val legacy=JSONObject().put("generation",2).put("status","acked")
            .put("result",JSONObject().put("phase","submitted"))
        store.close()
        val protected=context.createDeviceProtectedStorageContext()
        protected.deleteDatabase("gateway_replay_horizon.db")
        SQLiteDatabase.openOrCreateDatabase(protected.getDatabasePath("gateway_replay_horizon.db"),null).use{db->
            db.execSQL("CREATE TABLE gateway_replay_horizon(gateway_id TEXT NOT NULL,generation INTEGER NOT NULL,credential_fingerprint TEXT NOT NULL,enrollment_revision INTEGER NOT NULL DEFAULT 0,enrollment_digest TEXT NOT NULL DEFAULT '',blocking_floor INTEGER NOT NULL DEFAULT 1,prepared_revision INTEGER NOT NULL DEFAULT 0,prepared_digest TEXT NOT NULL DEFAULT '',committed_floor INTEGER NOT NULL DEFAULT 1,committed_revision INTEGER NOT NULL DEFAULT 0,committed_digest TEXT NOT NULL DEFAULT '',ready INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'ready',quarantine_reason TEXT,PRIMARY KEY(gateway_id,generation))")
            db.execSQL("CREATE TABLE gateway_command_ledger(command_id TEXT PRIMARY KEY,gateway_id TEXT NOT NULL,generation INTEGER NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,execution_phase TEXT NOT NULL DEFAULT 'prepared',ack_accepted INTEGER NOT NULL DEFAULT 0,safe_to_retire INTEGER NOT NULL DEFAULT 0,local_obligations INTEGER NOT NULL DEFAULT 1,UNIQUE(gateway_id,generation,sequence))")
            db.execSQL("CREATE TABLE gateway_command_outbox(command_id TEXT PRIMARY KEY,gateway_id TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,last_failure_code TEXT,created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))")
            db.execSQL("INSERT INTO gateway_replay_horizon(gateway_id,generation,credential_fingerprint,ready) VALUES(?,?,?,1)",arrayOf<Any?>(identity.gatewayId,identity.generation,identity.credentialFingerprint))
            db.execSQL("INSERT INTO gateway_command_ledger(command_id,gateway_id,generation,sequence,kind,fingerprint,execution_phase) VALUES(?,?,?,?,?,?,'result_durable')",arrayOf<Any?>(command.commandId,identity.gatewayId,identity.generation,command.sequence,command.kind,commandReplayFingerprint(identity.gatewayId,command)))
            db.execSQL("INSERT INTO gateway_command_ledger(command_id,gateway_id,generation,sequence,kind,fingerprint,execution_phase,ack_accepted,local_obligations) VALUES(?,?,?,?,?,?,'result_durable',1,0)",arrayOf<Any?>(confirmed.commandId,identity.gatewayId,identity.generation,confirmed.sequence,confirmed.kind,commandReplayFingerprint(identity.gatewayId,confirmed)))
            db.execSQL("INSERT INTO gateway_command_outbox(command_id,gateway_id,generation,payload) VALUES(?,?,?,?)",arrayOf<Any?>(command.commandId,identity.gatewayId,identity.generation,legacy.toString()))
            db.version=1
        }
        store=GatewayReplayHorizonStore(context,identity)
        assertTrue(!store.pendingAcks().single().body.has("sideEffectDisposition"))
        store.close()
        SQLiteDatabase.openDatabase(protected.getDatabasePath("gateway_replay_horizon.db").absolutePath,null,SQLiteDatabase.OPEN_READONLY).use{db->
            assertEquals(1,db.version)
            assertTrue(db.rawQuery("PRAGMA table_info(gateway_command_ledger)",null).use{cursor->
                var found=false
                while(cursor.moveToNext())if(cursor.getString(cursor.getColumnIndexOrThrow("name"))=="ack_payload")found=true
                found
            })
        }
        store=GatewayReplayHorizonStore(context,identity)
        store.confirmAck(command.commandId)
        val retried=store.stageAck(command.commandId,legacy)
        assertTrue(!retried.has("sideEffectDisposition"))
        assertTrue(!store.pendingAcks().single().body.has("sideEffectDisposition"))
        store.confirmAck(command.commandId)
        val reconstructed=store.stageAck(confirmed.commandId,legacy)
        assertTrue(!reconstructed.has("sideEffectDisposition"))
    }

    @Test fun tenThousandMixedCommandsStayBoundedUnderPeriodicCommittedFloors() {
        var committed = 1L
        var revision = 1L
        for (sequence in 1L..10_000L) {
            val kind = KINDS[((sequence - 1) % KINDS.size).toInt()]
            val command = command(sequence, kind)
            store.prepareCommand(command)
            accept(command, true)
            if (sequence % 100L == 0L) {
                val next = sequence + 1
                val counts = KINDS.associateWith { 20L }
                val proposal = proof(committed, next, revision, counts)
                store.apply(proposal)
                store.apply(proposal.copy(phase = "control_committed"))
                committed = next
                revision += 1
            }
        }
        assertEquals(10_001, store.state().committedFloor)
        assertEquals(0, store.ledgerSize())
    }

    @Test fun restoredOlderGenerationIsQuarantined() {
        val newer = GatewayReplayHorizonStore(context,
            GatewayCommandIdentity(identity.gatewayId, 3, identity.credentialFingerprint))
        newer.state()
        newer.close()
        assertTrue(store.state().quarantined)
    }

    @Test fun androidCodecMatchesControlSlashAndUnicodeFingerprint() {
        val payload = """{"nested":{"z":true,"a":null},"smsId":"00000000-0000-0000-0000-000000000002","body":"测试 / newline\n","simId":"00000000-0000-0000-0000-000000000003"}"""
        val command = GatewayCommand(
            "00000000-0000-0000-0000-000000000001", 2, 3,
            kind = "send_sms", payloadJson = payload,
        )
        assertEquals(
            "c7kTEi-26T9H54aJkU9-0Tl1qbFisGaFNcUnstqWepA",
            commandReplayFingerprint("00000000-0000-0000-0000-000000000004", command),
        )
        assertTrue(canonicalJson("""{"path":"a/b"}""").contains("a/b"))
        assertEquals(
            "{\"0\":0,\"2\":2,\"10\":10,\"4294967294\":4,\"01\":1,\"4294967295\":5}",
            canonicalJson("""{"10":10,"2":2,"4294967295":5,"01":1,"4294967294":4,"0":0}"""),
        )
        val entry = ReplayFinalizedProof(
            3, 24, "00000000-0000-4000-8000-000000000024", "f".repeat(43),
            "dial", "rejected", "media_capability_withdrawn", "",
        ).let { it.copy(entryDigest = replayFinalizedEntryDigest(it)) }
        assertEquals("rDsiw6EYQqHbh0f8UAC8f5dASEpCjmsVeSFnUcOdiFc", entry.entryDigest)
        val proposal = ReplayHorizonProof(
            "proposed", "00000000-0000-4000-8000-000000000001", 3, 24, 25, 5, "", 1,
            mapOf("dial" to 1), 2, listOf(entry),
        )
        assertEquals("eeDRjNNYJ8DMQeUs9R6lZVsmpTrd9V1jFZQQ3jivdPo", replayProposalWireDigest(proposal))
    }

    @Test fun migrationIntentAndReceiptSurviveEveryLocalRestartBoundary() {
        store.close()
        context.createDeviceProtectedStorageContext().deleteDatabase("gateway_replay_horizon.db")
        store = GatewayReplayHorizonStore(context, identity)
        val proof = JSONObject().put("idle", true).put("pendingAcks", 0).put("pendingEvents", 0)
            .put("pendingCommands", 0).put("unknownExecutions", 0)
        val intent = store.prepareMigrationIntent(41, proof)
        store.close()

        store = GatewayReplayHorizonStore(context, identity)
        assertEquals(intent.intentId, store.pendingMigrationIntent()?.intentId)
        val receipt = ReplayMigrationReceipt(intent.intentId, identity.gatewayId, 2, 3, 41, 1, "r".repeat(43))
        store.persistMigrationReceipt(intent, receipt)
        store.close()

        store = GatewayReplayHorizonStore(context, identity)
        assertEquals(receipt, store.persistedMigrationReceipt())
        store.close()
        val next = GatewayCommandIdentity(identity.gatewayId, 3, identity.credentialFingerprint)
        store = GatewayReplayHorizonStore(context, next)
        assertEquals(receipt, store.receiptAwaitingCompletionAtCurrentGeneration())
        assertTrue(store.state().ready)
        store.markMigrationApplied(intent.intentId)
        assertEquals(null, store.receiptAwaitingCompletionAtCurrentGeneration())
    }

    private fun command(sequence: Long, kind: String) = GatewayCommand(
        commandId = "00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}",
        generation = identity.generation,
        sequence = sequence,
        kind = kind,
        payloadJson = "{}",
    )

    private fun accept(command: GatewayCommand, safe: Boolean) {
        val body = JSONObject().put("generation", command.generation).put("status", "acked")
        store.stageAck(command.commandId, body)
        store.confirmAck(command.commandId)
        store.markRetirementSafety(command.commandId, safe, false)
    }

    private fun proof(from: Long, to: Long, revision: Long, counts: Map<String, Long>) =
        ReplayHorizonProof("proposed", identity.gatewayId, identity.generation, from, to, revision,
            "a".repeat(43), to - from, counts)

    private fun finalized(sequence:Long,command:GatewayCommand):ReplayFinalizedProof{
        val raw=ReplayFinalizedProof(identity.generation,sequence,command.commandId,
            commandReplayFingerprint(identity.gatewayId,command),command.kind,"rejected","media_capability_withdrawn","")
        return raw.copy(entryDigest=replayFinalizedEntryDigest(raw))
    }

    private fun v2Proof(from:Long,to:Long,revision:Long,counts:Map<String,Long>,finalized:List<ReplayFinalizedProof>):ReplayHorizonProof{
        val raw=ReplayHorizonProof("proposed",identity.gatewayId,identity.generation,from,to,revision,"a".repeat(43),to-from,counts,2,finalized)
        return raw.copy(proofDigest=replayProposalWireDigest(raw))
    }

    private companion object {
        val KINDS = listOf("dial", "answer", "hangup", "send_sms", "apply_sim_settings", "dtmf")
    }
}
