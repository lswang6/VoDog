package org.vodog.gateway

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class GatewayReplayMigrationPolicyTest {
    private val eligible = ReplayMigrationResponse(true, emptyList(), null)

    @Test fun preflightedIntentCrashThenLocalBusyNeverAllowsCommit() {
        val changed = ReplayMigrationLocalProof(false, 0, 0, 0, 0)
        assertFalse(replayMigrationCommitAllowed(changed, matchesPreparedIntent = false, eligible))
        val calls = mutableListOf<String>()
        val result = resolvePreparedReplayMigration(
            lookup = { calls += "preflight_lookup"; eligible },
            refreshProof = { calls += "local_refresh"; changed to false },
            recheck = { calls += "preflight_recheck"; eligible },
            commit = { calls += "commit"; error("commit must not run") },
        )
        assertNull(result)
        assertTrue(calls == listOf("preflight_lookup", "local_refresh"))
    }

    @Test fun commitRequiresExactClearProofAndEligibleEmptyPreflight() {
        val clear = ReplayMigrationLocalProof(true, 0, 0, 0, 0)
        assertTrue(replayMigrationCommitAllowed(clear, matchesPreparedIntent = true, eligible))
        assertFalse(replayMigrationCommitAllowed(clear, true,
            ReplayMigrationResponse(false, listOf(ReplayMigrationBlocker("pending_sms", 1)), null)))
    }

    @Test fun restoredOldEpochAfterCompletionStopsBeforeAnyLocalOrNetworkWork() {
        val calls = mutableListOf<String>()
        val stopped = ReplayMigrationResponse(false,
            listOf(ReplayMigrationBlocker("migration_already_completed", 1)), null)
        assertNull(resolvePreparedReplayMigration(
            lookup = { calls += "preflight_lookup"; stopped },
            refreshProof = { calls += "local_refresh"; error("must remain isolated") },
            recheck = { calls += "preflight_recheck"; error("must remain isolated") },
            commit = { calls += "commit"; error("must remain isolated") },
        ))
        assertTrue(calls == listOf("preflight_lookup"))
    }

    @Test fun unknownOrDisabledLookupOutcomeCannotTouchOldEpoch() {
        listOf("migration_disabled", "epoch_changed", "intent_capacity_reached", "future_blocker").forEach { code ->
            val calls = mutableListOf<String>()
            assertNull(resolvePreparedReplayMigration(
                lookup = {
                    calls += "preflight_lookup"
                    ReplayMigrationResponse(false, listOf(ReplayMigrationBlocker(code, 1)), null)
                },
                refreshProof = { calls += "local_refresh"; error("old epoch must remain isolated") },
                recheck = { calls += "preflight_recheck"; error("old epoch must remain isolated") },
                commit = { calls += "commit"; error("old epoch must remain isolated") },
            ))
            assertTrue(calls == listOf("preflight_lookup"))
        }
        assertTrue(replayMigrationLookupMayRefresh(ReplayMigrationResponse(
            false, listOf(ReplayMigrationBlocker("server_calls", 1)), null,
        )))
    }

    @Test fun locallyPersistedReceiptCannotSwitchRestoredOldRuntimeAfterServerCompletion() {
        val receipt = ReplayMigrationReceipt(
            "00000000-0000-0000-0000-000000000001",
            "00000000-0000-0000-0000-000000000002",
            2,
            3,
            41,
            1,
            "a".repeat(43),
        )
        val calls = mutableListOf<String>()
        val valid = replayMigrationReceiptStillUnconfirmed(receipt) {
            calls += "preflight_lookup"
            ReplayMigrationResponse(
                false,
                listOf(ReplayMigrationBlocker("migration_already_completed", 1)),
                null,
            )
        }
        if (valid) calls += "runtime_switch"
        assertFalse(valid)
        assertTrue(calls == listOf("preflight_lookup"))
    }

    @Test fun locallyPersistedReceiptRequiresExactServerReceiptBeforeRuntimeSwitch() {
        val receipt = ReplayMigrationReceipt(
            "00000000-0000-0000-0000-000000000001",
            "00000000-0000-0000-0000-000000000002",
            2,
            3,
            41,
            1,
            "a".repeat(43),
        )
        assertTrue(replayMigrationReceiptStillUnconfirmed(receipt) {
            ReplayMigrationResponse(true, emptyList(), receipt)
        })
        assertFalse(replayMigrationReceiptStillUnconfirmed(receipt) {
            ReplayMigrationResponse(true, emptyList(), receipt.copy(proofDigest = "b".repeat(43)))
        })
    }
}
