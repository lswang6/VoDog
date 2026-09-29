package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** S20 D6: the server's occupancy DTO decides "busy", names the occupant, and gates the release. */
class CallOccupancyTest {
    private fun sim(gateway: String? = "gateway-a") = ClientSim(
        id = "sim-a",
        gatewayId = gateway,
        label = "SIM",
        phoneLabel = null,
        slotIndex = 0,
        countryIso = "CN",
        embedded = false,
        present = true,
        assignmentPending = false,
        online = true,
        telephonyReady = true,
        smsReady = true,
        mediaReady = true,
    )

    private fun occupancy(
        holdsLock: Boolean = true,
        lockedSince: String? = "2026-09-11T02:03:00Z",
        platform: String? = "ios",
        device: String? = null,
        isCurrentSession: Boolean = false,
        canRelease: Boolean = true,
    ): JSONObject = JSONObject()
        .put("holdsLock", holdsLock)
        .put("lockedSince", lockedSince ?: JSONObject.NULL)
        .put("occupantPlatform", platform ?: JSONObject.NULL)
        .put("occupantDevice", device ?: JSONObject.NULL)
        .put("isCurrentSession", isCurrentSession)
        .put("canRelease", canRelease)

    private fun call(
        id: String = "call-a",
        state: String = "active",
        occupancy: JSONObject? = null,
    ): JSONObject = JSONObject().put("id", id).put("gatewayId", "gateway-a").put("state", state)
        .put("startedAt", "2026-09-11T01:00:00Z")
        .put("gatewayTimeZone", "Asia/Shanghai")
        .also { if (occupancy != null) it.put("occupancy", occupancy) }

    @Test fun occupancyFieldsAreOptionalAndParsedWhenPresent() {
        assertNull(call().toCallOccupancy())
        assertNull(call().put("occupancy", JSONObject.NULL).toCallOccupancy())
        assertEquals(
            CallOccupancy(
                holdsLock = true,
                lockedSince = "2026-09-11T02:03:00Z",
                occupantPlatform = "ios",
                occupantDevice = null,
                isCurrentSession = false,
                canRelease = true,
            ),
            call(occupancy = occupancy()).toCallOccupancy(),
        )
        // An unknown platform string is dropped rather than shown raw.
        assertNull(call(occupancy = occupancy(platform = "desktop")).toCallOccupancy()?.occupantPlatform)
    }

    @Test fun lockOwnershipDecidesBusyAndLegacyResponsesKeepTheOldDerivation() {
        val holder = call(id = "held", occupancy = occupancy(holdsLock = true))
        assertEquals("held", gatewayBusyForSim(sim(), listOf(holder))?.getString("id"))
        // The field is present and says no lock: not busy, even though the state still reads active.
        assertNull(gatewayBusyForSim(sim(), listOf(call(id = "stale", occupancy = occupancy(holdsLock = false)))))
        // Mixed list: the lock holder wins over an occupancy-bearing neighbour.
        assertEquals(
            "held",
            gatewayBusyForSim(
                sim(),
                listOf(call(id = "stale", occupancy = occupancy(holdsLock = false)), holder),
            )?.getString("id"),
        )
        // No occupancy anywhere: unchanged S19 behaviour.
        assertEquals("call-a", gatewayBusyForSim(sim(), listOf(call()))?.getString("id"))
        assertNull(gatewayBusyForSim(sim(), listOf(call(state = "ended"))))
        assertNull(gatewayBusyForSim(sim(gateway = "gateway-b"), listOf(holder)))
    }

    @Test fun occupancyNoticeNamesTheOccupantAndTheLockTime() {
        assertEquals(
            "通话中 · 由 iPhone 端 接听 · 自 10:03",
            callOccupancyNotice(call(occupancy = occupancy())),
        )
        // A named device wins over the platform map.
        assertEquals(
            "通话中 · 由 Example User 的 iPhone 接听 · 自 10:03",
            callOccupancyNotice(call(occupancy = occupancy(device = "Example User 的 iPhone"))),
        )
        // Without lockedSince the call's own start time is used.
        assertEquals(
            "通话中 · 由 网页端 接听 · 自 09:00",
            callOccupancyNotice(call(occupancy = occupancy(lockedSince = null, platform = "web"))),
        )
        // Legacy payload: fall back to the existing owner mapping.
        assertEquals(
            "通话中 · 由 Android 端 接听 · 自 09:00",
            callOccupancyNotice(call().put("answeredByPlatform", "android")),
        )
        assertEquals("通话中 · 由 其他设备 接听 · 自 09:00", callOccupancyNotice(call()))
    }

    @Test fun releaseButtonOnlyShowsForAnotherSessionTheServerLetsUsEnd() {
        assertTrue(canReleaseOccupiedCall(call(occupancy = occupancy())))
        assertFalse(canReleaseOccupiedCall(call(occupancy = occupancy(isCurrentSession = true))))
        assertFalse(canReleaseOccupiedCall(call(occupancy = occupancy(canRelease = false))))
        assertFalse("no occupancy field means no release entry point", canReleaseOccupiedCall(call()))
    }

    @Test fun releasingARingingCallCarriesTheRingingGuardAndNothingElse() {
        // Parity with the web `ringingEndGuard`: a decline must fail with 409 CALL_NOT_RINGING if
        // another device answered between the tap and the request, rather than hang that call up.
        assertEquals(
            OccupancyEndGuard(onlyIfRinging = true, onlyIfCurrentSessionOwner = false),
            occupancyEndGuard("incoming_ringing"),
        )
        listOf("active", "connecting", "outgoing_pending", "ending", "unknown").forEach { state ->
            assertEquals(
                "release of a $state call must carry no guard",
                OccupancyEndGuard(onlyIfRinging = false, onlyIfCurrentSessionOwner = false),
                occupancyEndGuard(state),
            )
        }

        // …and the guard is what actually reaches the wire.
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            JSONObject().put("call", JSONObject().put("id", "call-a"))
        })
        fun release(state: String) {
            val guard = occupancyEndGuard(state)
            api.endCall(
                "call-a",
                onlyIfCurrentSessionOwner = guard.onlyIfCurrentSessionOwner,
                onlyIfRinging = guard.onlyIfRinging,
            )
        }

        release("incoming_ringing")
        assertEquals("/calls/call-a/end", requests[0].path)
        assertTrue(requests[0].body!!.getBoolean("onlyIfRinging"))
        assertFalse(requests[0].body!!.has("onlyIfCurrentSessionOwner"))

        release("active")
        assertFalse(requests[1].body!!.has("onlyIfRinging"))
        assertFalse(requests[1].body!!.has("onlyIfCurrentSessionOwner"))
    }

    @Test fun confirmationWordsARingingReleaseAsADecline() {
        val ringing = occupancyReleasePrompt("incoming_ringing")
        assertEquals("拒接", ringing.confirmLabel)
        assertEquals("将替本账号所有设备拒接这通来电。", ringing.message)
        listOf("active", "connecting", "outgoing_pending", "ending").forEach { state ->
            val prompt = occupancyReleasePrompt(state)
            assertEquals("将挂断本账号在另一台设备上的通话。", prompt.message)
            assertEquals("结束通话", prompt.confirmLabel)
            assertEquals("结束该通话", prompt.title)
        }
    }
}
