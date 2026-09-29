package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewaySystemBlocklistMirrorTest {
    private val key = ::systemBlocklistKey
    private val on = PhoneSyncMode.ON
    private val off = PhoneSyncMode.OFF

    /** A SIM whose call and SMS lists are the same (pre-S66 tests: the whole list mirrors). */
    private fun both(simId: String, numbers: List<String>) = NumberBlocklistItem(simId, numbers, numbers)

    private fun rows(vararg originals: String) =
        originals.mapIndexed { i, n -> "Row: $i original_number=$n, e164_number=NULL" }.joinToString("\n")

    // ---- S66 targets: call list ∩ SMS list ----

    @Test fun targetsAreCallNumbersAlsoOnTheSmsListPerSimIncludingSpellingVariants() {
        val iso = mapOf("sim-a" to "CN", "sim-b" to "CN")
        val targets = systemBlocklistTargets(
            listOf(
                NumberBlocklistItem("sim-a", listOf("+8619900000201", "+862195559", "+8613900139000"),
                    smsNumbers = listOf("19900000201")),
                // sim-b: a number on sim-b's call list only, and one on sim-a's call list only - neither mirrors.
                NumberBlocklistItem("sim-b", listOf("+8613700137000"), smsNumbers = listOf("+8613900139000")),
            ),
            key, iso::get,
        )
        assertEquals(mapOf("19900000201" to "+8619900000201"), targets)
        // No SMS list at all (the S66 day-one state): nothing mirrors.
        assertEquals(emptyMap<String, String>(), systemBlocklistTargets(
            listOf(NumberBlocklistItem("sim-a", listOf("+8619900000201"))), key, iso::get))
    }

    @Test fun onModeShrinkToEmptyTargetDeletesGatewayRowsWithoutReportingThem() {
        val keys = (0 until 429).map { "1380013" + "%04d".format(it) }.toSet()
        assertEquals(429, keys.size)
        val plan = systemBlocklistSyncPlan(on, emptySet(), keys, keys, bootstrap = false)
        assertEquals(keys, plan.remove)
        assertEquals(emptySet<String>(), plan.insert)
        assertEquals(emptySet<String>() to emptySet<String>(), plan.report)
        assertEquals(emptySet<String>(), plan.phoneAdds)
        assertEquals(emptySet<String>(), plan.phoneRemoves)
        assertEquals(keys, plan.controlRemoves)
        assertEquals(emptySet<String>(), systemBlocklistNextBaseline(on, plan, keys, keys, emptySet(), keys))
        // A delete that failed stays in the baseline and is retried, still not reported.
        val failed = keys.first()
        val next = systemBlocklistNextBaseline(on, plan, keys, keys, emptySet(), keys - failed)
        assertEquals(setOf(failed), next)
        val retry = systemBlocklistSyncPlan(on, emptySet(), next, setOf(failed), bootstrap = false)
        assertEquals(setOf(failed), retry.remove)
        assertEquals(emptySet<String>() to emptySet<String>(), retry.report)
    }

    // ---- key space ----

    @Test fun controlAndPhoneSpellingsShareOneKeySpace() {
        val targets = systemBlocklistTargets(
            listOf(both("sim-a", listOf("075595501", "10101196", "10105501"))), key,
        )
        val phone = systemBlocklistRows(rows("+8675595501", "+8610101196", "+8610105501", "+85295008"), key)
        val plan = systemBlocklistSyncPlan(on, targets.keys, targets.keys, phone.keys, bootstrap = false)
        assertEquals(setOf("95008"), plan.phoneAdds)
        assertEquals(emptySet<String>(), plan.phoneRemoves)
        assertEquals(emptySet<String>(), plan.controlAdds)
        assertEquals(emptySet<String>(), plan.controlRemoves)
        assertEquals(setOf("95008") to emptySet<String>(), plan.report)
        assertEquals("+85295008", phone.getValue("95008").single().original)
        // First run with no baseline at all: the three pairs are still not phone adds.
        val first = systemBlocklistSyncPlan(on, targets.keys, emptySet(), phone.keys, bootstrap = true)
        assertEquals(setOf("95008"), first.phoneAdds)
        assertEquals(emptySet<String>(), first.controlAdds)
    }

    @Test fun bothSpellingsOfOneNumberMirrorOnceAndPreferThePlusForm() {
        val targets = systemBlocklistTargets(
            listOf(
                both("sim-a", listOf("19900000201", "+8619900000201")),
                both("sim-b", listOf("+8619900000201", " 199 0000 0201 ")),
            ),
            key,
        )
        assertEquals(mapOf("19900000201" to "+8619900000201"), targets)
    }

    /** S55 equivalence rules, pinned to the cases agreed with the user; same answers as Control. */
    @Test fun numberEquivalenceMatchesControl() {
        fun same(a: String, b: String) = assertEquals("$a vs $b", key(a), key(b))
        fun differ(a: String, b: String) = assertTrue("$a vs $b", key(a) != key(b))
        same("+8675595501", "075595501"); same("075595501", "95501"); same("+8675595501", "95501")
        same("+8610101196", "10101196")
        same("+85295008", "95008")
        same("19900000201", "+8619900000201"); same("8619900000201", "19900000201")
        same("+8675500000101", "075500000101")
        differ("075500000101", "83765432")
        differ("+85290000003", "90000003")
        // The local incoming check agrees on a CN SIM and stays strict elsewhere.
        assertTrue(numberBlocklistMatches("+8675595501", listOf("95501"), "CN"))
        assertTrue(numberBlocklistMatches("95008", listOf("+85295008"), "CN"))
        assertFalse(numberBlocklistMatches("83765432", listOf("075500000101"), "CN"))
        assertFalse(numberBlocklistMatches("90000003", listOf("+85290000003"), "CN"))
        assertFalse(numberBlocklistMatches("+86112", listOf("112"), "CN"))
    }

    @Test fun emergencyAndUnmirrorableNumbersAreSkipped() {
        val targets = systemBlocklistTargets(
            listOf(both("sim-a", listOf("112", "911", "+86112", "12", "10010", "not a number"))),
            key,
        )
        assertEquals(setOf("10010"), targets.keys)
        assertNull(key("+911"))
        assertNull(key("+86112"))
        // A phone row for an emergency number is invisible to the merge: never reported, never deleted.
        val phone = systemBlocklistRows(rows("112", "911"), key)
        assertEquals(emptySet<String>(), phone.keys)
        assertTrue(systemBlocklistInsertScript(targets.values).contains("original_number:s:10010\n"))
        assertThrows(IllegalArgumentException::class.java) { systemBlocklistInsertScript(listOf("+86138;rm -rf /")) }
        assertThrows(IllegalArgumentException::class.java) { systemBlocklistInsertScript(listOf("138 0013")) }
    }

    // ---- scripts and read-back ----

    @Test fun insertScriptReadsTheTableBack() {
        val script = systemBlocklistInsertScript(listOf("+8619900000201", "10010"))
        assertEquals(2, script.lines().count { it.startsWith("content insert ") })
        assertTrue(script.endsWith(
            "content query --uri content://com.android.blockednumber/blocked --projection original_number:e164_number\nexit\n"))
        val present = systemBlocklistPresentKeys(
            "Row: 0 original_number=+8619900000201, e164_number=+8619900000201\n" +
                "Error while accessing provider:com.android.blockednumber",
            key,
        )
        assertEquals(setOf("19900000201"), present)
        assertEquals(emptySet<String>(), systemBlocklistPresentKeys("No result found.", key))
    }

    @Test fun deleteScriptMatchesBothFieldsExactly() {
        val script = systemBlocklistDeleteScript(listOf(
            BlockedNumberRow("+8619900000201", "+8619900000201"),
            BlockedNumberRow("10010", null),
        ))
        assertEquals(
            "content delete --uri content://com.android.blockednumber/blocked --where \"original_number='+8619900000201' AND e164_number='+8619900000201'\"\n" +
                "content delete --uri content://com.android.blockednumber/blocked --where \"original_number='10010'\"\n" +
                "content query --uri content://com.android.blockednumber/blocked --projection original_number:e164_number\nexit\n",
            script,
        )
        assertThrows(IllegalArgumentException::class.java) {
            systemBlocklistDeleteScript(listOf(BlockedNumberRow("1' OR '1'='1", null)))
        }
        // An unsafe e164 value is dropped from the where clause, never interpolated.
        assertFalse(systemBlocklistDeleteScript(listOf(BlockedNumberRow("10010", "x' OR 1"))).contains("OR"))
        val parsed = systemBlocklistRows(
            "Row: 0 original_number=19900000201, e164_number=+8619900000201\n" +
                "Row: 1 original_number=+8619900000201, e164_number=+8619900000201\n",
            key,
        )
        assertEquals(listOf("19900000201", "+8619900000201"), parsed.getValue("19900000201").map { it.original })
    }

    @Test fun aSilentOrKilledSuIsNotAnEmptyTable() {
        assertFalse(systemBlocklistQueryAnswered(1, ""))
        assertFalse(systemBlocklistQueryAnswered(null, "Row: 0 original_number=10010"))
        assertTrue(systemBlocklistQueryAnswered(0, "No result found.\n"))
        assertTrue(systemBlocklistQueryAnswered(0, "Row: 0 original_number=10010\n"))
    }

    // ---- merge, mode on ----

    @Test fun phoneAddIsReportedAndKeptInTheBaseline() {
        val plan = systemBlocklistSyncPlan(on, setOf("10010"), setOf("10010"), setOf("10010", "95555"), false)
        assertEquals(setOf("95555") to emptySet<String>(), plan.report)
        assertEquals(emptySet<String>(), plan.insert + plan.remove)
        assertEquals(setOf("10010", "95555"),
            systemBlocklistNextBaseline(on, plan, setOf("10010"), setOf("10010", "95555"), emptySet(), emptySet()))
    }

    @Test fun phoneRemoveIsReportedAndNeverReinserted() {
        // 10000: blocked everywhere, then deleted by hand on the phone.
        val plan = systemBlocklistSyncPlan(on, setOf("10000", "10010"), setOf("10000", "10010"), setOf("10010"), false)
        assertEquals(emptySet<String>() to setOf("10000"), plan.report)
        assertEquals(emptySet<String>(), plan.insert)
        assertEquals(setOf("10010"),
            systemBlocklistNextBaseline(on, plan, setOf("10000", "10010"), setOf("10010"), emptySet(), emptySet()))
        // While Control has not reflected the report yet, the pending overlay keeps it from coming back.
        val stale = systemBlocklistSyncPlan(on, setOf("10000", "10010"), setOf("10010"), setOf("10010"), false,
            pendingRemoves = setOf("10000"))
        assertEquals(emptySet<String>(), stale.insert)
        assertEquals(emptySet<String>() to emptySet<String>(), stale.report)
    }

    @Test fun controlAddIsInsertedAndControlRemoveDeleted() {
        val plan = systemBlocklistSyncPlan(on, setOf("10010", "10086"), setOf("10010", "10000"),
            setOf("10010", "10000"), false)
        assertEquals(setOf("10086"), plan.insert)
        assertEquals(setOf("10000"), plan.remove)
        assertEquals(emptySet<String>() to emptySet<String>(), plan.report)
        assertEquals(setOf("10010", "10086"), systemBlocklistNextBaseline(on, plan, setOf("10010", "10000"),
            setOf("10010", "10000"), inserted = setOf("10086"), removed = setOf("10000")))
        // A delete that did not land stays in B, so the next run retries it instead of reporting a phone add.
        assertEquals(setOf("10010", "10000"), systemBlocklistNextBaseline(on, plan, setOf("10010", "10000"),
            setOf("10010", "10000"), inserted = emptySet(), removed = emptySet()))
    }

    @Test fun sameDirectionChangesAreAlreadyConsistent() {
        // Both sides added 10086; both sides removed 10000.
        val plan = systemBlocklistSyncPlan(on, setOf("10086"), setOf("10000"), setOf("10086"), false)
        assertEquals(emptySet<String>(), plan.insert + plan.remove + plan.phoneAdds + plan.phoneRemoves)
        assertEquals(setOf("10086"),
            systemBlocklistNextBaseline(on, plan, setOf("10000"), setOf("10086"), emptySet(), emptySet()))
    }

    @Test fun oppositeDirectionAcrossRunsLetsControlWin() {
        // The phone added 95555 and reported it; Control refused, so the report dropped 95555 from B.
        // Control still lacks it: the phone row is a (re-)reportable phone add, never a Control delete.
        val plan = systemBlocklistSyncPlan(on, emptySet(), emptySet(), setOf("95555"), false)
        assertEquals(emptySet<String>(), plan.remove)
        // The phone removed 10000 but Control, newer, re-blocked it after the ack: its snapshot wins.
        val reblocked = systemBlocklistSyncPlan(on, setOf("10000"), emptySet(), emptySet(), false)
        assertEquals(setOf("10000"), reblocked.insert)
    }

    @Test fun firstRunBootstrapCutsTheBaselineToThePhone() {
        // S41 mirrored 10000, then it was deleted by hand while sync was off: not a phone unblock.
        val plan = systemBlocklistSyncPlan(on, setOf("10000"), setOf("10000", "10010"), setOf("10010"), bootstrap = true)
        assertEquals(emptySet<String>() to emptySet<String>(), plan.report)
        assertEquals(setOf("10000"), plan.healed)
        assertEquals(setOf("10000"), plan.insert)
        assertEquals(setOf("10010"), plan.remove)
    }

    // ---- merge, modes off / dry_run ----

    @Test fun offUnblockedKeyIsRemovedButAManualEntryIsNever() {
        val plan = systemBlocklistSyncPlan(off, setOf("19900000201"), setOf("19900000201", "10010"),
            setOf("19900000201", "10010", "95555"), bootstrap = true)
        assertEquals(setOf("10010"), plan.remove)
        assertEquals(emptySet<String>(), plan.insert)
        assertEquals(emptySet<String>() to emptySet<String>(), plan.report)
        assertEquals(setOf("10010"),
            systemBlocklistSyncPlan(off, emptySet(), setOf("10010"), setOf("10010", "95555"), true).remove)
    }

    @Test fun offHandDeletedKeyIsHealedAndReinsertedWhileStillBlocked() {
        val plan = systemBlocklistSyncPlan(off, setOf("10000"), setOf("10000", "10086"), emptySet(), bootstrap = true)
        assertEquals(setOf("10000", "10086"), plan.healed)
        assertEquals(setOf("10000"), plan.insert)
        assertEquals(emptySet<String>(), plan.remove)
        assertEquals(setOf("10000"),
            systemBlocklistNextBaseline(off, plan, setOf("10000", "10086"), emptySet(), setOf("10000"), emptySet()))
    }

    @Test fun offManualRowCoveringATargetIsNeitherDuplicatedNorAdopted() {
        val plan = systemBlocklistSyncPlan(off, setOf("95555"), emptySet(), setOf("95555"), true)
        assertEquals(emptySet<String>(), plan.insert)
        assertEquals(emptySet<String>(),
            systemBlocklistNextBaseline(off, plan, emptySet(), setOf("95555"), emptySet(), emptySet()))
    }

    @Test fun dryRunActsLikeOffButCarriesTheFullPlan() {
        val targets = setOf("10010", "10086")
        val baseline = setOf("10010", "10000")
        val present = setOf("10010", "10000", "95555")
        val dry = systemBlocklistSyncPlan(PhoneSyncMode.DRY_RUN, targets, baseline, present, true)
        val offPlan = systemBlocklistSyncPlan(off, targets, baseline, present, true)
        assertEquals(offPlan, dry)
        assertEquals(emptySet<String>() to emptySet<String>(), dry.report)
        assertEquals(setOf("95555"), dry.phoneAdds)
        assertEquals(setOf("10086"), dry.controlAdds)
        assertEquals(setOf("10000"), dry.controlRemoves)
        assertEquals(listOf("0000", "0010", "0086"), systemBlocklistSample(listOf("10086", "10010", "+8610000")))
    }

    @Test fun modeParsingDefaultsToOff() {
        assertEquals(PhoneSyncMode.OFF, PhoneSyncMode.parse(null))
        assertEquals(PhoneSyncMode.OFF, PhoneSyncMode.parse("bogus"))
        assertEquals(PhoneSyncMode.DRY_RUN, PhoneSyncMode.parse("dry_run"))
        assertEquals(PhoneSyncMode.ON, PhoneSyncMode.parse("on"))
    }

    @Test fun phoneChangesPayloadCarriesTheContractFields() {
        val payload = systemBlocklistPhoneChangesPayload("e1", listOf("+85295008"), listOf("075595501"), "2026-09-24T00:00:00Z")
        assertEquals("e1", payload.getString("eventId"))
        assertEquals("+85295008", payload.getJSONArray("adds").getString(0))
        assertEquals("075595501", payload.getJSONArray("removes").getString(0))
        assertEquals("2026-09-24T00:00:00Z", payload.getString("observedAt"))
    }
}
