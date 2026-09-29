package org.vodog

import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class S46CallPresentationPolicyTest {
    @Test fun simPickerSortsOnlineFirstStablyOnlyWhileHandsetIsOnline() {
        val sims = listOf(false, true, true, false).mapIndexed { index, online ->
            JSONObject().put("id", "sim-$index").put("online", online).toClientSim()
        }
        val original = sims.toList()
        val sorted = simPickerDisplayOrder(sims, networkAvailable = true)
        assertEquals(listOf("sim-1", "sim-2", "sim-0", "sim-3"), sorted.map { it.id })
        assertEquals(original, simPickerDisplayOrder(sims, networkAvailable = false))
        assertEquals(original, sims)
        sorted.forEach { sim -> assertSame(original.single { it.id == sim.id }, sim) }
    }

    @Test fun simPickerShowsCustomNameWithoutRepeatingPhoneAsTitle() {
        val sim = JSONObject().put("id", "sim-1").put("label", " 工作卡 ")
            .put("phoneLabel", "+886 900 000 001").put("slotIndex", 0).toClientSim()
        assertEquals("工作卡", simPickerTitle(sim))
        assertEquals("+886 900 000 001", sim.phoneLabel)
        // The shared model still supplies the phone-based call and accessibility labels.
        assertEquals("+886 900 000 001", sim.displayLabel)
    }

    @Test fun simPickerFallsBackToSlotForMissingBlankOrPhoneOnlyNames() {
        val phone = "+886 900 000 001"
        for (label in listOf(null, "", "   ", phone, " $phone ")) {
            val json = JSONObject().put("id", "sim-2").put("phoneLabel", phone).put("slotIndex", 1)
            if (label != null) json.put("label", label)
            val sim = json.toClientSim()
            assertEquals("SIM 2", simPickerTitle(sim))
            assertEquals(phone, sim.phoneLabel)
            assertEquals("SIM", simPickerTitle(sim.copy(slotIndex = null)))
        }
    }

    @Test fun simPickerAnswerModeBadgeFollowsSettingsMode() {
        fun badge(settings: JSONObject?) =
            simAnswerModeBadge(JSONObject().put("id", "sim-1").apply { settings?.let { put("settings", it) } }.toClientSim().answerMode)
        assertEquals("人工", badge(JSONObject().put("mode", "normal")))
        assertEquals("AI", badge(JSONObject().put("mode", "ai")))
        assertEquals("AI", badge(JSONObject().put("mode", "timeout_ai")))
        assertNull(badge(null))
        assertNull(badge(JSONObject().put("mode", "unknown")))
    }

    @Test fun offlineContactCardRetainsAnAlreadyLoadedLookup() {
        val target = ContactCardTarget("0900000001")
        val loaded = RemoteResource.Loaded<ClientContact?>(null)
        val state = ClientUiState(networkAvailable = false, contactCard = ContactCardUiState(target, contact = loaded))
        assertSame(loaded, contactCardForOpen(state, target).contact)
        assertSame(RemoteResource.NotLoaded, contactCardForOpen(state, ContactCardTarget("0900000002")).contact)
    }

    @Test fun anUncachedOfflineContactIsUnknownRatherThanAnEmptySuccessfulLookup() {
        val target = ContactCardTarget("0900000001")
        val offline = contactCardForOpen(ClientUiState(networkAvailable = false), target)
        assertSame(RemoteResource.NotLoaded, offline.contact)
        assertFalse(contactCardActions(offline).canCreateContact)
        assertFalse(contactCardActions(offline).canAttachToContact)
        assertSame(RemoteResource.Loading, contactCardForOpen(ClientUiState(networkAvailable = true), target).contact)
    }

    @Test fun minimizeSurvivesTicksAndRestoreDoesNotRearmAutomaticPresentation() {
        val first = CallPresentation().reconcile("call-1", emptySet())
        assertTrue(first.expanded)
        val minimized = first.minimize()
        assertEquals(minimized, minimized.reconcile("call-1", emptySet()))
        assertTrue(minimized.restore().expanded)
        assertEquals(minimized, minimized.restore().minimize())
    }

    @Test fun refreshGapAndMediaFailureDoNotEndAnOwnedCall() {
        val call = JSONObject().put("id", "call-1").put("state", "active").put("claimedByCurrentSession", true)
        val shown = CallPresentation().reconcile(primaryOwnedCall(listOf(call), null)?.optString("id"), emptySet())
        assertEquals(shown, shown.reconcile(null, emptySet()))
        assertEquals("call-1", primaryOwnedCall(listOf(call), "unrelated-media-id")?.optString("id"))
    }

    @Test fun confirmedEndClearsPresentationAndANewIdentityOpensOnce() {
        val minimized = CallPresentation().reconcile("call-1", emptySet()).minimize()
        val ended = minimized.reconcile(null, setOf("call-1"))
        assertNull(ended.callId)
        assertFalse(ended.expanded)
        val next = ended.reconcile("call-2", setOf("call-1"))
        assertEquals("call-2", next.callId)
        assertTrue(next.expanded)
        assertFalse(next.minimize().reconcile("call-2", emptySet()).expanded)
        assertFalse(next.reconcile("call-1", emptySet()).expanded)
    }

    @Test fun durationUsesAnsweredTimeAndNeverInventsRingTime() {
        val answered = "2026-09-20T00:00:00Z"
        val now = Instant.parse(answered).toEpochMilli() + 3_661_000
        assertEquals("1:01:01", ongoingCallDuration(answered, "active", now))
        assertEquals("1:01:01", ongoingCallDuration(answered, "ending", now))
        assertEquals("01:01", ongoingCallDuration(answered, "active", now - 3_600_000))
        assertNull(ongoingCallDuration(null, "active", now))
        assertNull(ongoingCallDuration("null", "active", now))
        assertNull(ongoingCallDuration(answered, "incoming_ringing", now))
        assertNull(ongoingCallDuration(answered, "ended", now))
        val ended = "2026-09-20T00:01:01.999Z"
        assertEquals("01:01", ongoingCallDuration(answered, "ended", now, ended))
        assertEquals("01:01", ongoingCallDuration(answered, "ending", now + 60_000, ended))
        assertEquals("00:00", ongoingCallDuration(answered, "active", now - 7_000_000))
        assertNull(ongoingCallDuration(answered, "active", now, "invalid"))
    }

    @Test fun stoppingFreezesBothPresentationsAndFailureResumesFromAnsweredAt() {
        val answered = "2026-09-20T00:00:00Z"
        val start = Instant.parse(answered).toEpochMilli()
        val frozen = start + 61_000
        for (state in listOf("active", "ending")) {
            assertEquals("01:01", ongoingCallDuration(answered, state, start + 90_000, frozenAtMillis = frozen))
            assertEquals("01:01", ongoingCallDuration(answered, state, start + 120_000, frozenAtMillis = frozen))
        }
        // An unsuccessful end clears only the UI freeze; elapsed talk time includes the wait.
        assertEquals("02:00", ongoingCallDuration(answered, "active", start + 120_000))
        assertEquals("01:02", ongoingCallDuration(answered, "ended", start + 120_000,
            endedAt = "2026-09-20T00:01:02Z", frozenAtMillis = frozen))
        assertNull(ongoingCallDuration(null, "ending", start + 120_000, frozenAtMillis = frozen))
    }

    @Test fun blocklistSearchIsPartialAndIgnoresPhoneFormatting() {
        assertTrue(blockedNumberMatches("+886 (900) 000-001", "900000"))
        assertTrue(blockedNumberMatches("+886900000001", " 900 000-001 "))
        assertTrue(blockedNumberMatches("0900000001", ""))
        assertFalse(blockedNumberMatches("0900000001", "0900000002"))
        assertFalse(blockedNumberMatches("0900000001", "name"))
    }

    @Test fun remoteTonesNeedBothActiveEligibilityAndHandsetNetwork() {
        assertTrue(callDtmfEnabled("active", networkAvailable = true, ending = false))
        assertFalse(callDtmfEnabled("active", networkAvailable = false, ending = false))
        assertFalse(callDtmfEnabled("connecting", networkAvailable = true, ending = false))
        assertFalse(callDtmfEnabled("active", networkAvailable = true, ending = true))
    }

    @Test fun handsetOfflineOverridesCachedGatewayOnlineWithoutClearingSnapshots() {
        assertEquals("设备未联网", simConnectionLabel(networkAvailable = false, gatewayOnline = true))
        assertEquals("号码设备离线", simConnectionLabel(networkAvailable = true, gatewayOnline = false))
        assertEquals("设备未联网 · 可查看已加载的记录", offlineBannerText(CallMediaUiState()))
        val live = CallMediaUiState(callId = "call", phase = CallMediaPhase.CONNECTED)
        assertEquals("网络已断开，恢复后通话将自动重连", offlineBannerText(live))
        assertEquals("网络已断开，恢复后通话将自动重连", offlineBannerText(live.copy(phase = CallMediaPhase.CONNECTING, rejoining = true)))
        assertEquals("设备未联网 · 可查看已加载的记录", offlineBannerText(live.copy(phase = CallMediaPhase.FAILED)))
        val snapshot = RemoteList.Loaded(listOf(JSONObject().put("id", "cached-call")))
        val session = Session("token", "refresh", "user")
        val state = ClientUiState(session = session, calls = snapshot, callQuery = "cached query", networkAvailable = false)
        val renewed = stateAfterSessionChange(state, session.copy(token = "renewed"), sameLoginGeneration = true)
        assertSame(snapshot, renewed.calls)
        assertEquals("cached query", renewed.callQuery)
        assertFalse(renewed.networkAvailable)
        assertFalse(stateAfterSessionChange(state, null, sameLoginGeneration = false).networkAvailable)
    }
}
