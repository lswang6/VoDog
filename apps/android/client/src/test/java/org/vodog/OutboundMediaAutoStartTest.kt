package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboundMediaAutoStartTest {
    private val id = "11111111-1111-4111-8111-111111111111"

    private fun call(
        state: String = "connecting",
        direction: String = "outgoing",
        claimed: Boolean = true,
        callId: String = id,
    ) = JSONObject().put("id", callId).put("state", state).put("direction", direction)
        .put("claimedByCurrentSession", claimed)

    @Test fun ownOutboundConnectingCallStartsMediaExactlyOnce() {
        val attempted = mutableSetOf<String>()
        val first = outboundMediaAutoStartId(listOf(call()), CallMediaUiState(), attempted)
        assertEquals(id, first)
        attempted += first!!
        // The next refresh lands before the service publishes its session: no second start.
        assertNull(outboundMediaAutoStartId(listOf(call()), CallMediaUiState(), attempted))
        assertNull(outboundMediaAutoStartId(listOf(call(state = "active")), CallMediaUiState(), attempted))
    }

    @Test fun activeOwnOutboundCallWithoutMediaAlsoStarts() {
        assertEquals(id, outboundMediaAutoStartId(listOf(call(state = "active")), CallMediaUiState(), emptySet()))
    }

    @Test fun incomingOtherSessionPendingAndEndingCallsDoNotStart() {
        val none = CallMediaUiState()
        assertNull(outboundMediaAutoStartId(listOf(call(direction = "incoming")), none, emptySet()))
        assertNull(outboundMediaAutoStartId(listOf(call(claimed = false)), none, emptySet()))
        assertNull(outboundMediaAutoStartId(listOf(call(state = "outgoing_pending")), none, emptySet()))
        assertNull(outboundMediaAutoStartId(listOf(call(state = "ending")), none, emptySet()))
    }

    @Test fun anExistingLocalMediaSessionBlocksWithoutConsumingTheAttempt() {
        val mine = CallMediaUiState(callId = id, phase = CallMediaPhase.CONNECTING)
        assertNull(outboundMediaAutoStartId(listOf(call()), mine, emptySet()))
        val other = CallMediaUiState(callId = "other", phase = CallMediaPhase.CONNECTED)
        assertNull(outboundMediaAutoStartId(listOf(call()), other, emptySet()))
        // Once the other call's media is gone, this call still gets its one start.
        assertEquals(id, outboundMediaAutoStartId(listOf(call()), CallMediaUiState(), emptySet()))
    }

    @Test fun retryIsVisibleOnlyForAFailedHandshake() {
        assertTrue(mediaRecoveryVisible(CallMediaUiState(callId = id, phase = CallMediaPhase.FAILED)))
        assertFalse(mediaRecoveryVisible(CallMediaUiState(callId = id, phase = CallMediaPhase.CONNECTING)))
        assertFalse(mediaRecoveryVisible(CallMediaUiState(callId = id, phase = CallMediaPhase.CONNECTED)))
        assertFalse(mediaRecoveryVisible(null))
    }

    @Test fun gatewayBusyClearsItselfButKeepsTheErrorStyle() {
        val busy = ClientUiState().withTransientError("网关正被另一通蜂窝通话占用")
        assertEquals("网关正被另一通蜂窝通话占用", busy.autoDismissInfo())
        assertEquals(WorkspaceMessageKind.ERROR, workspaceMessageKind(busy))
        // A later, unrelated error is not swept away by the stale transient marker.
        assertNull(busy.copy(message = "名称不能为空").autoDismissInfo())
    }
}
