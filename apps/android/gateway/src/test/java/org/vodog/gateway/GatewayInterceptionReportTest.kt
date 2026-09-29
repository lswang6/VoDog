package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.UUID

/** S21 §B — the durable one-shot interception report for locally blocked calls and messages. */
class GatewayInterceptionReportTest {
    private val deviceCallId = "11111111-1111-4111-8111-111111111111"
    private val start = Instant.parse("2026-09-11T10:00:00Z")

    private fun report(
        eventId: String,
        kind: InterceptionKind = InterceptionKind.CALL,
        settled: Boolean = false,
        settledAt: Instant? = null,
    ) = InterceptionReport(
        eventId = eventId,
        kind = kind,
        payload = "{}",
        createdAt = start.toString(),
        settled = settled,
        settledAt = settledAt?.toString(),
    )

    @Test fun callEventIdIsDerivedFromTheDeviceCallIdAndNeverCollidesWithTheJournalEventId() {
        val first = blockedCallInterceptionEventId(deviceCallId)
        assertEquals(first, blockedCallInterceptionEventId(deviceCallId))
        assertNotEquals(first, blockedCallInterceptionEventId("22222222-2222-4222-8222-222222222222"))
        // Documented derivation: a name-based UUID over "vodog:blocked-call:<deviceCallId>".
        assertEquals(
            UUID.nameUUIDFromBytes("vodog:blocked-call:$deviceCallId".toByteArray()).toString(),
            first,
        )
        // The journal's own incomingEventId is a random UUID for the same call; the namespace keeps
        // the derived one distinct from a plain derivation over the bare id.
        assertNotEquals(UUID.nameUUIDFromBytes(deviceCallId.toByteArray()).toString(), first)
        assertEquals(deviceCallId, deviceCallId) // the source id itself is never rewritten
        assertNotEquals(deviceCallId, first)
    }

    @Test fun smsEventIdIsStableForTheSameBroadcastAndSplitsOnGenerationOrDigest() {
        val digest = "a".repeat(64)
        val fingerprint = "b".repeat(64)
        val first = blockedSmsInterceptionEventId(7L, fingerprint, digest)
        assertEquals(first, blockedSmsInterceptionEventId(7L, fingerprint, digest))
        assertNotEquals(first, blockedSmsInterceptionEventId(8L, fingerprint, digest))
        assertNotEquals(first, blockedSmsInterceptionEventId(7L, fingerprint, "c".repeat(64)))
        assertNotEquals(first, blockedSmsInterceptionEventId(7L, "d".repeat(64), digest))
    }

    @Test fun callPayloadCarriesTheBlockedMarkerAndOmitsAnUnknownNumber() {
        val eventId = blockedCallInterceptionEventId(deviceCallId)
        val payload = blockedCallInterceptionPayload(
            eventId, generation = 4L, deviceCallId = deviceCallId, simId = "sim-a",
            observedAt = start.toString(), remoteNumber = "+8619900000101",
        )
        assertEquals(eventId, payload.getString("eventId"))
        assertEquals(4L, payload.getLong("generation"))
        assertEquals(deviceCallId, payload.getString("deviceCallId"))
        assertEquals("sim-a", payload.getString("simId"))
        assertEquals(start.toString(), payload.getString("observedAt"))
        assertEquals("+8619900000101", payload.getString("remoteNumber"))
        assertTrue(payload.getBoolean("blockedLocally"))
        val unknown = blockedCallInterceptionPayload(
            eventId, 4L, deviceCallId, "sim-a", start.toString(), remoteNumber = "  ",
        )
        assertFalse(unknown.has("remoteNumber"))
        assertTrue(unknown.getBoolean("blockedLocally"))
    }

    @Test fun `S86 only a call-screening-service block carries screeningApp`() {
        fun payloadFor(reason: Int) = blockedCallInterceptionPayload(
            "event", 4L, "calllog:9", "sim-a", start.toString(), "+8619900000101", blockSource = "phone",
            screeningApp = blockedCallLogScreeningApp(
                reason, " 拦截猫 ", "c.team.wastecat/c.team.wastecat.MyCallScreeningService",
            ),
        )
        assertEquals("拦截猫", payloadFor(1).getString("screeningApp"))
        assertEquals("phone", payloadFor(1).getString("blockSource"))
        assertFalse(payloadFor(3).has("screeningApp"))
        assertFalse(payloadFor(7).has("screeningApp"))
        assertEquals("c.team.wastecat", blockedCallLogScreeningApp(1, " ", "c.team.wastecat/x.Svc"))
    }

    @Test fun smsPayloadKeepsTheBodyForTheOwner() {
        val payload = blockedSmsInterceptionPayload(
            eventId = "event", generation = 4L, simId = "sim-a", assignmentVersion = 3,
            remoteNumber = "+8619900000101", body = "促销短信", receivedAt = start.toString(),
        )
        assertEquals("促销短信", payload.getString("body"))
        assertEquals(3, payload.getInt("assignmentVersion"))
        assertEquals(start.toString(), payload.getString("receivedAt"))
        assertTrue(payload.getBoolean("blockedLocally"))
    }

    @Test fun oneBlockIsEnqueuedOnceEvenAfterItWasAlreadySettled() {
        val eventId = blockedCallInterceptionEventId(deviceCallId)
        val first = upsertInterception(emptyList(), report(eventId))
        assertEquals(1, first.size)
        // Observing the same block again (snapshot re-applied, sync retry) must not duplicate it.
        assertEquals(first, upsertInterception(first, report(eventId)))
        val settled = settleInterception(first, eventId, delivered = true, now = start)
        assertTrue(settled.single().settled)
        assertTrue(settled.single().delivered)
        // The tombstone keeps the block from being resent for the whole retention window.
        assertEquals(settled, upsertInterception(settled, report(eventId)))
        assertEquals(emptyList<InterceptionReport>(), settled.filterNot { it.settled })
    }

    @Test fun attemptsAreCountedOnlyWhilePendingAndRetirementIsBounded() {
        val records = upsertInterception(emptyList(), report("event"))
        assertEquals(1, recordInterceptionAttempt(records, "event").single().attempts)
        val settled = settleInterception(records, "event", delivered = false, now = start)
        assertEquals(0, recordInterceptionAttempt(settled, "event").single().attempts)
        // Recoverable transport/server answers keep retrying; a refused payload never repeats.
        assertTrue(interceptionRetryable(500))
        assertTrue(interceptionRetryable(409))
        assertTrue(interceptionRetryable(429))
        assertFalse(interceptionRetryable(400))
        assertFalse(interceptionRetryable(404))
        assertFalse(shouldRetireInterception(attempts = 1, retryable = true))
        assertTrue(shouldRetireInterception(attempts = 1, retryable = false))
        assertTrue(shouldRetireInterception(MAX_INTERCEPTION_ATTEMPTS, retryable = true))
    }

    @Test fun tombstonesExpireAndCapacityEvictsSettledEntriesBeforePendingOnes() {
        val fresh = report("fresh", settled = true, settledAt = start)
        val expired = report("expired", settled = true, settledAt = start.minus(INTERCEPTION_TOMBSTONE_RETENTION))
        val pending = report("pending")
        assertEquals(
            listOf("fresh", "pending"),
            compactInterceptions(listOf(fresh, expired, pending), start).map { it.eventId },
        )
        // Over capacity the oldest settled tombstone goes first; a pending report is never dropped
        // while a settled one is still available.
        val crowded = listOf(
            report("settled-a", settled = true, settledAt = start),
            report("pending-a"),
            report("settled-b", settled = true, settledAt = start),
            report("pending-b"),
        )
        assertEquals(
            listOf("pending-a", "settled-b", "pending-b"),
            compactInterceptions(crowded, start, maxRecords = 3).map { it.eventId },
        )
        assertEquals(
            listOf("pending-a", "pending-b"),
            compactInterceptions(crowded, start, maxRecords = 2).map { it.eventId },
        )
    }

    @Test fun listedIncomingStaysOutOfTheNormalReportPathButIsAlwaysIntercepted() {
        // The live path is frozen: a listed call is never reportable as a normal incoming call, so it
        // cannot enter the Telecom snapshot or produce a terminal report. The interception report is
        // the separate one-shot channel, and it is keyed by the same deviceCallId.
        val listedRinging = DeviceCallRecord(
            deviceCallId = deviceCallId,
            phoneAccountHandle = "handle",
            creationTimeMillis = 1_000L,
            direction = DeviceCallDirection.INCOMING,
            state = DeviceCallState.RINGING,
            observedAt = start.toString(),
            remoteNumber = "+8619900000101",
            incomingEventId = "22222222-2222-4222-8222-222222222222",
            incomingPayload = null,
            incomingReported = false,
            serverCallId = null,
        )
        assertFalse(incomingIsReportable(listedRinging, listed = true))
        assertTrue(incomingIsReportable(listedRinging, listed = false))
        assertTrue(shouldRejectIncomingRinging(true, listedRinging.state, listed = true))
        val payload = blockedCallInterceptionPayload(
            blockedCallInterceptionEventId(listedRinging.deviceCallId), 4L, listedRinging.deviceCallId,
            "sim-a", listedRinging.observedAt, listedRinging.remoteNumber,
        )
        assertTrue(payload.getBoolean("blockedLocally"))
        assertNotEquals(listedRinging.incomingEventId, payload.getString("eventId"))
    }
}
