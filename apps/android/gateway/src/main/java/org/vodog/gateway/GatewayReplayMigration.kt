package org.vodog.gateway

import android.content.Context
import android.telecom.TelecomManager
import org.json.JSONObject

data class ReplayMigrationLocalProof(
    val idle: Boolean,
    val pendingAcks: Int,
    val pendingEvents: Int,
    val pendingCommands: Int,
    val unknownExecutions: Int,
) {
    val clear get() = idle && pendingAcks == 0 && pendingEvents == 0 &&
        pendingCommands == 0 && unknownExecutions == 0

    fun toJson() = JSONObject().put("idle", idle).put("pendingAcks", pendingAcks)
        .put("pendingEvents", pendingEvents).put("pendingCommands", pendingCommands)
        .put("unknownExecutions", unknownExecutions)
}

internal fun replayMigrationCommitAllowed(
    proof: ReplayMigrationLocalProof,
    matchesPreparedIntent: Boolean,
    preflight: ReplayMigrationResponse,
): Boolean = proof.clear && matchesPreparedIntent && preflight.eligible &&
    preflight.blockers.isEmpty() && preflight.receipt == null

private val KNOWN_UNCOMMITTED_MIGRATION_BLOCKERS = setOf(
    "local_not_idle",
    "local_pending_acks",
    "local_pending_events",
    "local_pending_commands",
    "local_unknown_executions",
    "server_calls",
    "server_sms",
    "server_commands",
    "server_locks",
    "server_cleanup",
    "fresh_idle_snapshot_required",
)

internal fun replayMigrationLookupMayRefresh(response: ReplayMigrationResponse): Boolean =
    response.receipt == null && (
        (response.eligible && response.blockers.isEmpty()) ||
            (response.blockers.isNotEmpty() && response.blockers.all {
                it.code in KNOWN_UNCOMMITTED_MIGRATION_BLOCKERS
            })
        )

internal fun resolvePreparedReplayMigration(
    lookup: () -> ReplayMigrationResponse,
    refreshProof: () -> Pair<ReplayMigrationLocalProof, Boolean>,
    recheck: () -> ReplayMigrationResponse,
    commit: () -> ReplayMigrationResponse?,
): ReplayMigrationReceipt? {
    val lookupResponse = lookup()
    lookupResponse.receipt?.let { return it }
    if (!replayMigrationLookupMayRefresh(lookupResponse)) return null
    val (firstProof, firstMatches) = refreshProof()
    if (!firstProof.clear || !firstMatches) return null
    val preflight = recheck()
    preflight.receipt?.let { return it }
    if (!replayMigrationLookupMayRefresh(preflight)) return null
    val (finalProof, finalMatches) = refreshProof()
    if (!replayMigrationCommitAllowed(finalProof, finalMatches, preflight)) return null
    return commit()?.let { requireNotNull(it.receipt) { "replay migration receipt missing" } }
}

/**
 * A receipt stored while the runtime is still on the old generation is not sufficient authority
 * to switch epochs. A restored device-protected database can contain that receipt after Control
 * has already completed and used the new epoch. Control's non-mutating preflight lookup is the
 * authoritative committed-but-unconfirmed check.
 *
 * Transport failures deliberately escape this function. The caller must keep the migration
 * barrier closed and retry only this lookup; it must not perform old-epoch network work.
 */
internal fun replayMigrationReceiptStillUnconfirmed(
    expected: ReplayMigrationReceipt,
    lookup: () -> ReplayMigrationResponse,
): Boolean {
    val response = lookup()
    return response.blockers.isEmpty() && response.receipt == expected
}

object GatewayReplayMigrationBarrier {
    private val lock = Any()
    fun <T> withLock(block: () -> T): T = synchronized(lock, block)
}

/**
 * Hands out the one live [GatewayReplayHorizonStore] per identity. The owner (the foreground
 * service) closes them; a borrower must never close one, because the same helper is reused by the
 * heartbeat cycle and a second open would leak an SQLiteConnection per 2 s poll.
 */
internal fun interface GatewayReplayStoreProvider {
    fun borrow(identity: GatewayCommandIdentity): GatewayReplayHorizonStore
}

internal class GatewayReplayMigrationCoordinator(
    private val context: Context,
    private val runtime: GatewayRuntimeStore,
    private val api: GatewayApi,
    private val token: String,
    private val stores: GatewayReplayStoreProvider,
) {
    fun hasBarrier(identity: GatewayCommandIdentity): Boolean = stores.borrow(identity).let { store ->
        store.pendingMigrationIntent() != null || store.persistedMigrationReceipt() != null ||
            store.receiptAwaitingCompletionAtCurrentGeneration() != null
    }

    /** Returns the current identity only after the barrier is fully resolved. */
    fun resume(identity: GatewayCommandIdentity): GatewayCommandIdentity? {
        val store = stores.borrow(identity)
        store.receiptAwaitingCompletionAtCurrentGeneration()?.let { receipt ->
            flushLocalObligations(identity, store)
            if (!freshIdleSnapshot()) return null
            val currentProof = localProof(identity, idle = localPhysicalIdle())
            if (!currentProof.clear) return null
            check(api.replayMigrationComplete(receipt)) { "replay migration completion rejected" }
            store.markMigrationApplied(receipt.intentId)
            return identity
        }
        val receipt = store.persistedMigrationReceipt()
        if (receipt != null) return applyReceipt(store, identity, receipt)
        val intent = store.pendingMigrationIntent() ?: return identity
        return GatewayReplayMigrationBarrier.withLock {
            val committedReceipt = resolvePreparedReplayMigration(
                lookup = { api.replayMigrationPreflight(intent) },
                refreshProof = {
                    flushLocalObligations(identity, store)
                    val proof = localProof(identity, idle = freshIdleSnapshot())
                    proof to sameProof(intent, proof)
                },
                recheck = { api.replayMigrationPreflight(intent) },
                commit = {
                    val finalLocal = localProof(identity, idle = localPhysicalIdle())
                    if (!finalLocal.clear || !sameProof(intent, finalLocal)) null
                    else api.replayMigrationCommit(intent)
                },
            ) ?: return@withLock null
            store.persistMigrationReceipt(intent, committedReceipt)
            applyReceipt(store, identity, committedReceipt)
        }
    }

    fun begin(identity: GatewayCommandIdentity, serverSequence: Long, idle: Boolean): Boolean {
        if (!GatewayReplayHorizonEnrollmentApproval.ENABLED) return false
        val proof = localProof(identity, idle)
        if (!proof.clear) return false
        val store = stores.borrow(identity)
        return if (store.state().ready) false
        else { store.prepareMigrationIntent(serverSequence, proof.toJson()); true }
    }

    private fun applyReceipt(
        store: GatewayReplayHorizonStore,
        identity: GatewayCommandIdentity,
        receipt: ReplayMigrationReceipt,
    ): GatewayCommandIdentity? {
        val intent = store.migrationIntent(receipt.intentId) ?: return null
        if (identity.generation == receipt.fromGeneration && !replayMigrationReceiptStillUnconfirmed(
                receipt,
                lookup = { api.replayMigrationPreflight(intent) },
            )) {
            store.quarantine("migration_receipt_no_longer_unconfirmed")
            return null
        }
        val next = GatewayReplayMigrationBarrier.withLock {
            val proof = localProof(identity, idle = localPhysicalIdle())
            if (!proof.clear || !sameProof(intent, proof)) return@withLock null
            runtime.applyReplayMigration(receipt.gatewayId, receipt.fromGeneration, receipt.toGeneration, token)
        } ?: return null
        if (!localProof(next, idle = localPhysicalIdle()).clear) return null
        check(api.replayMigrationComplete(receipt)) { "replay migration completion rejected" }
        store.markMigrationApplied(receipt.intentId)
        return next
    }

    private fun flushLocalObligations(identity: GatewayCommandIdentity, store: GatewayReplayHorizonStore) {
        api.flushReplayAcks(store)
        GatewaySmsCoordinator(context, runtime, api, identity, store).flushEvents()
        GatewayCallCoordinator(context, runtime, api, identity, replayStore = store).flushAcks()
    }

    private fun freshIdleSnapshot(): Boolean =
        GatewayTelecomSync(context, runtime, api).runOnce().busyState == "idle" &&
            !TelecomSnapshotOutbox(context).hasPending() && GatewayActiveAudioSession.current() == null

    private fun localPhysicalIdle(): Boolean {
        val telecomIdle = runCatching { !context.getSystemService(TelecomManager::class.java).isInCall }
            .getOrDefault(false)
        val journalIdle = DeviceCallJournal(context).recordsForSnapshot().none { it.state != DeviceCallState.ENDED }
        return telecomIdle && journalIdle && GatewayActiveAudioSession.current() == null &&
            !TelecomSnapshotOutbox(context).hasPending()
    }

    private fun localProof(identity: GatewayCommandIdentity, idle: Boolean): ReplayMigrationLocalProof {
        val smsJournal = SmsExecutionJournal(context)
        val store = stores.borrow(identity)
        return ReplayMigrationLocalProof(
            idle = idle,
            pendingAcks = store.pendingAcks().size + CallAckOutbox(context, identity).pending().size +
                smsJournal.migrationPendingAckCount(identity.generation),
            pendingEvents = smsJournal.pendingEvents().size + IncomingSmsJournal(context).pending().size +
                OutgoingSmsObservationJournal(context).pending().size +
                if (TelecomSnapshotOutbox(context).hasPending()) 1 else 0,
            pendingCommands = PendingCommandStore(context, identity).pending().size,
            unknownExecutions = CallExecutionJournal(context).migrationUnknownCount(identity.generation) +
                smsJournal.migrationUnknownCount(identity.generation),
        )
    }

    private fun sameProof(intent: ReplayMigrationIntent, proof: ReplayMigrationLocalProof): Boolean =
        canonicalJson(intent.payload.getJSONObject("localProof").toString()) ==
            canonicalJson(proof.toJson().toString())
}
