package org.vodog.gateway

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayNumberBlocklistTest {
    @Test fun sameVersionIsNoOpHigherReplacesLowerIgnoredEmptyClears() {
        assertEquals(NumberBlocklistApplyDecision.REPLACE, numberBlocklistApplyDecision(null, 0))
        assertEquals(NumberBlocklistApplyDecision.NO_OP, numberBlocklistApplyDecision(4, 4))
        assertEquals(NumberBlocklistApplyDecision.REPLACE, numberBlocklistApplyDecision(4, 5))
        assertEquals(NumberBlocklistApplyDecision.IGNORE, numberBlocklistApplyDecision(5, 4))
        val empty = parseNumberBlocklist(
            JSONObject().put("numberBlocklist", JSONObject().put("version", 6).put("items", JSONArray())),
        )
        assertEquals(6L, empty?.version)
        assertEquals(emptyList<NumberBlocklistItem>(), empty?.items)
    }

    @Test fun smsNumbersParseAndDefaultToEmpty() {
        val snapshot = parseNumberBlocklist(JSONObject().put("numberBlocklist", JSONObject().put("version", 7).put(
            "items", JSONArray()
                .put(JSONObject().put("simId", "sim-a").put("numbers", JSONArray().put("+862195559"))
                    .put("smsNumbers", JSONArray().put("19900000201").put(" ")))
                .put(JSONObject().put("simId", "sim-b").put("numbers", JSONArray().put("10010"))),
        )))
        assertEquals(NumberBlocklistItem("sim-a", listOf("+862195559"), listOf("19900000201")), snapshot?.items?.get(0))
        assertEquals(NumberBlocklistItem("sim-b", listOf("10010"), emptyList()), snapshot?.items?.get(1))
    }

    @Test fun storedSnapshotRoundTripsAndPreS66SnapshotKeepsCallsButNotItsVersion() {
        val snapshot = NumberBlocklistSnapshot(9, listOf(NumberBlocklistItem("sim-a", listOf("+862195559"), listOf("95559"))))
        assertEquals(snapshot, decodeStoredNumberBlocklist(encodeStoredNumberBlocklist(snapshot)))
        // Exactly what a pre-S66 gateway wrote: no format, no smsNumbers.
        val legacy = decodeStoredNumberBlocklist(
            JSONObject().put("version", 12).put("items", JSONArray().put(
                JSONObject().put("simId", "sim-a").put("numbers", JSONArray().put("+862195559")),
            )).toString(),
        )
        assertEquals(NUMBER_BLOCKLIST_VERSION_UNKNOWN, legacy?.version)
        assertEquals(listOf("+862195559"), legacy?.items?.single()?.numbers)
        assertEquals(emptyList<String>(), legacy?.items?.single()?.smsNumbers)
        // Control's next snapshot replaces it even at the very version the old gateway had stored.
        assertEquals(NumberBlocklistApplyDecision.REPLACE, numberBlocklistApplyDecision(legacy?.version, 12))
        assertEquals(NumberBlocklistApplyDecision.REPLACE, numberBlocklistApplyDecision(legacy?.version, 0))
    }

    @Test fun callAndSmsListsAreLookedUpSeparately() {
        // The 95559 incident: on the call list via `+862195559`, not on the SMS list.
        val item = NumberBlocklistItem("sim-a", listOf("+862195559"), listOf("+8619900000201"))
        assertTrue(numberBlocklistMatches("95559", item.numbers, "CN"))
        assertFalse(numberBlocklistMatches("95559", item.smsNumbers, "CN"))
        assertTrue(numberBlocklistMatches("19900000201", item.smsNumbers, "CN"))
        assertFalse(numberBlocklistMatches("19900000201", item.numbers, "CN"))
    }

    @Test fun digitKeyAndNationalE164MatchWhenCountryKnown() {
        assertTrue(numberBlocklistMatches("19900000101", listOf("+86 199 0000 0101"), "CN"))
        assertTrue(numberBlocklistMatches("+8619900000101", listOf("19900000101"), "cn"))
        assertTrue(numberBlocklistMatches("020 7946 0018", listOf("+442079460018"), "GB"))
        assertFalse(numberBlocklistMatches("19900000101", listOf("+8619900000101"), null))
        assertFalse(numberBlocklistMatches("19900000101", listOf("+8619900000101"), "invalid"))
    }

    @Test fun emergencyAndBlankUnknownFailOpen() {
        assertFalse(numberBlocklistMatches("112", listOf("112"), "CN"))
        assertFalse(numberBlocklistMatches("911", listOf("911"), "US"))
        assertFalse(numberBlocklistMatches("+86112", listOf("112"), "CN"))
        assertFalse(numberBlocklistMatches(null, listOf("+8619900000101"), "CN"))
        assertFalse(numberBlocklistMatches("  ", listOf("+8619900000101"), "CN"))
        assertFalse(numberBlocklistMatches("BANK", listOf("BANK"), "CN"))
        assertFalse(numberBlocklistMatches("unknown", listOf("unknown"), "US"))
        assertTrue(numberBlocklistMatchKeys("112", "CN").isEmpty())
        assertTrue(numberBlocklistMatchKeys("911", "US").isEmpty())
    }

    @Test fun enforcementRequiresEnabledAndRingingOnly() {
        assertTrue(shouldRejectIncomingRinging(true, DeviceCallState.RINGING, true))
        assertFalse(shouldRejectIncomingRinging(false, DeviceCallState.RINGING, true))
        assertFalse(shouldRejectIncomingRinging(true, DeviceCallState.ACTIVE, true))
        assertFalse(shouldRejectIncomingRinging(true, DeviceCallState.RINGING, false))
        assertFalse(shouldDropIncomingSms(false, true))
        assertTrue(shouldDropIncomingSms(true, true))
    }
}
