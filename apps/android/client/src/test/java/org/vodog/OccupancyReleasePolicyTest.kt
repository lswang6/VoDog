package org.vodog

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S20 D5 termination release: only an outbound call this session dialed and nobody answered, and
 * only when the task is removed. Backgrounding must never end a call that is still ringing the far
 * end.
 */
class OccupancyReleasePolicyTest {
    @After fun clearRegistry() = SelfManagedOutboundCalls.clear()

    private fun outboundResponse(id: String, state: String): JSONObject = JSONObject().put(
        "call",
        JSONObject().put("id", id).put("state", state).put("direction", "outgoing"),
    )

    @Test fun onlyTaskRemovalReleases() {
        assertTrue(OccupancyReleasePolicy.shouldRelease(OccupancyReleaseTrigger.TASK_REMOVED))
        assertFalse(OccupancyReleasePolicy.shouldRelease(OccupancyReleaseTrigger.APP_BACKGROUNDED))
    }

    @Test fun dialResponseRegistersOnlyAnUnsettledOutboundCall() {
        assertEquals(
            "call-1",
            OccupancyReleasePolicy.registrableOutboundId(outboundResponse("call-1", "outgoing_pending")),
        )
        assertEquals(
            "call-2",
            OccupancyReleasePolicy.registrableOutboundId(
                JSONObject().put("call", JSONObject().put("id", "call-2")),
            ),
        )
        // An idempotent replay of a finished call must not be armed for release.
        assertNull(OccupancyReleasePolicy.registrableOutboundId(outboundResponse("call-3", "ended")))
        assertNull(OccupancyReleasePolicy.registrableOutboundId(outboundResponse("call-4", "failed")))
        assertNull(OccupancyReleasePolicy.registrableOutboundId(outboundResponse("call-5", "active")))
        assertNull(OccupancyReleasePolicy.registrableOutboundId(JSONObject()))
        assertNull(
            OccupancyReleasePolicy.registrableOutboundId(JSONObject().put("call", JSONObject().put("id", ""))),
        )
    }

    @Test fun registrationEndsAtAnswerMediaOrTerminalState() {
        assertFalse(OccupancyReleasePolicy.shouldForget("outgoing_pending", mediaConnected = false))
        assertFalse(OccupancyReleasePolicy.shouldForget("connecting", mediaConnected = false))
        assertFalse(OccupancyReleasePolicy.shouldForget(null, mediaConnected = false))
        assertTrue(OccupancyReleasePolicy.shouldForget("active", mediaConnected = false))
        assertTrue(OccupancyReleasePolicy.shouldForget("ended", mediaConnected = false))
        assertTrue(OccupancyReleasePolicy.shouldForget("failed", mediaConnected = false))
        assertTrue(OccupancyReleasePolicy.shouldForget("outgoing_pending", mediaConnected = true))
    }

    @Test fun retentionKeepsPendingDialsAndDropsSettledOnes() {
        val calls = listOf(
            JSONObject().put("id", "dialing").put("state", "outgoing_pending"),
            JSONObject().put("id", "answered").put("state", "active"),
            JSONObject().put("id", "done").put("state", "ended"),
            JSONObject().put("id", "with-audio").put("state", "connecting"),
        )
        assertEquals(
            setOf("dialing", "not-listed-yet"),
            OccupancyReleasePolicy.retainedIds(
                setOf("dialing", "answered", "done", "with-audio", "not-listed-yet"),
                calls,
                connectedMediaCallId = "with-audio",
            ),
        )
    }

    @Test fun registryTracksDialsUntilTheyAreForgotten() {
        SelfManagedOutboundCalls.register("call-1")
        SelfManagedOutboundCalls.register("call-2")
        SelfManagedOutboundCalls.register("")
        assertEquals(setOf("call-1", "call-2"), SelfManagedOutboundCalls.snapshot())
        SelfManagedOutboundCalls.forget("call-1")
        assertEquals(setOf("call-2"), SelfManagedOutboundCalls.snapshot())
        SelfManagedOutboundCalls.register("call-3")
        SelfManagedOutboundCalls.retain(setOf("call-3"))
        assertEquals(setOf("call-3"), SelfManagedOutboundCalls.snapshot())
        SelfManagedOutboundCalls.clear()
        assertTrue(SelfManagedOutboundCalls.snapshot().isEmpty())
    }
}
