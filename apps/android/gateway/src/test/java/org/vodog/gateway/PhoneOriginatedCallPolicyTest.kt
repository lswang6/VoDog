package org.vodog.gateway

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** S38: 手机自动拦截回填、通过手机拨打的一次性上报，以及被动录音的通话选择。 */
class PhoneOriginatedCallPolicyTest {
    private val now = Instant.parse("2026-09-18T10:00:00Z")

    private fun outgoing(
        deviceCallId: String,
        state: DeviceCallState,
        account: String? = "account-a",
    ) = DeviceCallRecord(
        deviceCallId = deviceCallId,
        phoneAccountHandle = account,
        creationTimeMillis = 1_700_000_000_000L,
        direction = DeviceCallDirection.OUTGOING,
        state = state,
        observedAt = now.toString(),
        remoteNumber = "10010",
        incomingEventId = null,
        incomingPayload = null,
        incomingReported = false,
        serverCallId = null,
    )

    @Test fun onlyUnboundUnreportedOutgoingCallsWithAWireStateAreObserved() {
        val dialing = outgoing("device-a", DeviceCallState.DIALING)
        assertEquals(listOf(dialing), pendingUnboundOutgoing(listOf(dialing), now))
        // A VoDog dial owns its own record: it already has a server call id.
        assertEquals(emptyList<DeviceCallRecord>(), pendingUnboundOutgoing(
            listOf(dialing.copy(serverCallId = "11111111-1111-4111-8111-111111111111")), now,
        ))
        // Reported once is reported forever, whatever Control answered.
        assertEquals(emptyList<DeviceCallRecord>(), pendingUnboundOutgoing(
            listOf(dialing.copy(outgoingReported = true)), now,
        ))
        // UNKNOWN has no wire state at all; the next heartbeat sees a real one.
        assertEquals(emptyList<DeviceCallRecord>(), pendingUnboundOutgoing(
            listOf(dialing.copy(state = DeviceCallState.UNKNOWN)), now,
        ))
        // Incoming calls belong to the incoming route.
        assertEquals(emptyList<DeviceCallRecord>(), pendingUnboundOutgoing(
            listOf(dialing.copy(direction = DeviceCallDirection.INCOMING)), now,
        ))
    }

    @Test fun aLiveDialReservationOnTheSameAccountBlocksTheClaim() {
        val dialing = outgoing("device-a", DeviceCallState.DIALING)
        val reservation = outgoing("device-b", DeviceCallState.UNKNOWN).copy(
            creationTimeMillis = null,
            serverCallId = "11111111-1111-4111-8111-111111111111",
            outgoingReservationExpiresAt = now.plusSeconds(60).toString(),
        )
        // The reservation is still waiting for onCallAdded to bind exactly this Telecom call.
        assertEquals(emptyList<DeviceCallRecord>(), pendingUnboundOutgoing(listOf(dialing, reservation), now))
        // An expired one cannot adopt anything any more, so the call really was dialled on the phone.
        assertEquals(listOf(dialing), pendingUnboundOutgoing(
            listOf(dialing, reservation.copy(outgoingReservationExpiresAt = now.minusSeconds(1).toString())), now,
        ))
        // A reservation on the other SIM never speaks for this one.
        assertEquals(listOf(dialing), pendingUnboundOutgoing(
            listOf(dialing, reservation.copy(phoneAccountHandle = "account-b")), now,
        ))
        // An unparsable expiry is not evidence of a live reservation and must not throw.
        assertEquals(listOf(dialing), pendingUnboundOutgoing(
            listOf(dialing, reservation.copy(outgoingReservationExpiresAt = "not-a-time")), now,
        ))
    }

    @Test fun telecomStateMapsToTheThreeWireValuesTheRouteAccepts() {
        assertEquals("dialing", outgoingObservedTelecomState(DeviceCallState.DIALING))
        assertEquals("dialing", outgoingObservedTelecomState(DeviceCallState.RINGING))
        assertEquals("active", outgoingObservedTelecomState(DeviceCallState.ACTIVE))
        assertEquals("ended", outgoingObservedTelecomState(DeviceCallState.ENDED))
        assertNull(outgoingObservedTelecomState(DeviceCallState.UNKNOWN))
    }

    @Test fun outgoingEventIdIsDerivedSoACrashReusesItAndAFenceIsNeverRetried() {
        val derived = outgoingObservedEventId("device-a")
        assertEquals(derived, outgoingObservedEventId("device-a"))
        assertTrue(derived != outgoingObservedEventId("device-b"))
        assertTrue(derived != blockedCallInterceptionEventId("device-a"))
        // A fence or any other refusal settles locally; only transport-ish statuses come back.
        assertFalse(outgoingObservedRetryable(409))
        assertFalse(outgoingObservedRetryable(400))
        assertFalse(outgoingObservedRetryable(404))
        assertTrue(outgoingObservedRetryable(429))
        assertTrue(outgoingObservedRetryable(408))
        assertTrue(outgoingObservedRetryable(503))
    }

    @Test fun settledPhoneDialledRowsAgeOutButLiveAndServerBackedOnesStay() {
        val ended = outgoing("device-a", DeviceCallState.ENDED).copy(outgoingReported = true)
        val within = Instant.parse(ended.observedAt).plusMillis(SUPPRESSED_INCOMING_RETENTION_MILLIS - 1)
        val after = Instant.parse(ended.observedAt).plusMillis(SUPPRESSED_INCOMING_RETENTION_MILLIS)
        assertFalse(observedOutgoingIsPrunable(ended, within))
        assertTrue(observedOutgoingIsPrunable(ended, after))
        // Control recorded it, so only a snapshot release may prune it.
        assertFalse(observedOutgoingIsPrunable(
            ended.copy(serverCallId = "11111111-1111-4111-8111-111111111111"), after,
        ))
        // Still live, or not reported yet: not inert.
        assertFalse(observedOutgoingIsPrunable(ended.copy(state = DeviceCallState.ACTIVE), after))
        assertFalse(observedOutgoingIsPrunable(ended.copy(outgoingReported = false), after))
        assertEquals(emptyList<DeviceCallRecord>(), pruneAfterSnapshot(listOf(ended), emptySet(), after))
        assertEquals(listOf(ended), pruneAfterSnapshot(listOf(ended), emptySet(), within))
    }

    @Test fun theNewFlagsSurviveTheJournalAndOlderRowsDecodeAsNotPhoneDialled() {
        val phoneDialled = outgoing("device-a", DeviceCallState.ACTIVE).copy(
            deviceOriginated = true, outgoingReported = true,
            serverCallId = "11111111-1111-4111-8111-111111111111",
            // The frozen body is what a retry after a lost response must resend byte for byte.
            outgoingPayload = org.json.JSONObject()
                .put("eventId", outgoingObservedEventId("device-a"))
                .put("telecomState", "dialing").toString(),
        )
        assertEquals(phoneDialled, phoneDialled.toJson().toRecord())
        assertEquals("dialing", org.json.JSONObject(phoneDialled.toJson().toRecord().outgoingPayload!!)
            .getString("telecomState"))
        val legacy = phoneDialled.toJson().apply {
            remove("deviceOriginated"); remove("outgoingReported"); remove("outgoingPayload")
        }
        assertFalse(legacy.toRecord().deviceOriginated)
        assertFalse(legacy.toRecord().outgoingReported)
        assertNull(legacy.toRecord().outgoingPayload)
    }

    @Test fun aPhoneDialledCallIsNeverTheExactCallThatGetsAMediaSession() {
        val bound = outgoing("device-a", DeviceCallState.ACTIVE)
            .copy(serverCallId = "11111111-1111-4111-8111-111111111111")
        assertTrue(isExactNonTerminalCall(bound, ActualTelecomState.ACTIVE))
        assertFalse(isExactNonTerminalCall(bound.copy(deviceOriginated = true), ActualTelecomState.ACTIVE))
    }

    @Test fun blockSourceIsOnlyPresentWhenTheCallLogBackfillPutItThere() {
        val gateway = blockedCallInterceptionPayload(
            "event-a", 9L, "device-a", "sim-a", now.toString(), "19900000103",
        )
        assertFalse(gateway.has("blockSource"))
        assertTrue(gateway.getBoolean("blockedLocally"))
        val phone = blockedCallInterceptionPayload(
            "event-a", 9L, blockedCallLogDeviceCallId(488L), "sim-a",
            blockedCallLogObservedAt(1_758_090_240_000L), "19900000103", blockSource = "phone",
        )
        assertEquals("phone", phone.getString("blockSource"))
        assertTrue(phone.getBoolean("blockedLocally"))
        assertEquals("calllog:488", phone.getString("deviceCallId"))
        assertEquals("2025-09-17T06:24:00Z", phone.getString("observedAt"))
    }

    @Test fun theFirstCallLogPassIsAgeBoundedAndLaterOnesFollowTheWatermarkOnly() {
        val (firstSelection, firstArgs) = blockedCallLogSelection(0L, now)
        assertEquals("type=? AND _id>? AND date>=?", firstSelection)
        assertEquals(listOf("6", "0", now.minusSeconds(7 * 86_400L).toEpochMilli().toString()), firstArgs.toList())
        val (nextSelection, nextArgs) = blockedCallLogSelection(488L, now)
        assertEquals("type=? AND _id>?", nextSelection)
        assertEquals(listOf("6", "488"), nextArgs.toList())
    }

    @Test fun theOutgoingObservedRouteIsItsOwnPathAndCaptureBindingIsPerCall() {
        assertEquals("/gateway/calls/outgoing-observed", GatewayApiRoutes.OUTGOING_OBSERVED)
        assertEquals(
            "/gateway/calls/11111111-1111-4111-8111-111111111111/capture-binding",
            GatewayApiRoutes.captureBinding("11111111-1111-4111-8111-111111111111"),
        )
        assertEquals("/gateway/calls/a%2Fb/capture-binding", GatewayApiRoutes.captureBinding("a/b"))
    }
}
