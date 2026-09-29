package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCallJournalPolicyTest {
    @Test fun uniqueLiveCallIsRecoveredButAmbiguousOrEndedCallIsNot() {
        val active = record("device-a", DeviceCallState.ACTIVE)
        assertEquals(
            active,
            recoverableDeviceCall(listOf(active), "account-a", 100L, DeviceCallDirection.INCOMING, emptySet()),
        )
        assertNull(recoverableDeviceCall(
            listOf(active, record("device-b", DeviceCallState.RINGING)),
            "account-a", 100L,
            DeviceCallDirection.INCOMING,
            emptySet(),
        ))
        assertNull(recoverableDeviceCall(
            listOf(record("device-a", DeviceCallState.ENDED)),
            "account-a", 100L,
            DeviceCallDirection.INCOMING,
            emptySet(),
        ))
    }

    @Test fun creationTimeMustMatchAndAlreadyBoundIdsAreNeverRecovered() {
        val active = record("device-a", DeviceCallState.ACTIVE)
        assertNull(recoverableDeviceCall(
            listOf(active), "account-a", 101L, DeviceCallDirection.INCOMING, emptySet(),
        ))
        assertNull(recoverableDeviceCall(
            listOf(active), "account-a", 100L, DeviceCallDirection.INCOMING, setOf("device-a"),
        ))
        assertNull(recoverableDeviceCall(
            listOf(active), "account-a", null, DeviceCallDirection.INCOMING, emptySet(),
        ))
    }

    @Test fun onlyJournalConfirmedEndedServerCallsAreReportedAbsent() {
        val ended = record("device-a", DeviceCallState.ENDED, "11111111-1111-4111-8111-111111111111")
        val active = record("device-b", DeviceCallState.ACTIVE, "22222222-2222-4222-8222-222222222222")
        assertEquals(listOf(ended.serverCallId), confirmedAbsentCallIds(listOf(ended, active)))
    }

    @Test fun pendingOutgoingReservationNeedsExactRouteNumberAndLiveWindow() {
        val reserved = record("device-a", DeviceCallState.UNKNOWN,
            "11111111-1111-4111-8111-111111111111").copy(
            direction = DeviceCallDirection.OUTGOING,
            creationTimeMillis = null,
            outgoingReservationExpiresAt = "2026-09-09T00:00:30Z",
        )
        val now = java.time.Instant.parse("2026-09-09T00:00:00Z")
        assertEquals(reserved, recoverableOutgoingReservation(
            listOf(reserved), "account-a", DeviceCallDirection.OUTGOING, "+12025550101", emptySet(), now,
        ))
        assertNull(recoverableOutgoingReservation(
            listOf(reserved), "account-a", DeviceCallDirection.OUTGOING, "+12025550102", emptySet(), now,
        ))
        assertNull(recoverableOutgoingReservation(
            listOf(reserved), "account-a", DeviceCallDirection.OUTGOING, "+12025550101", emptySet(),
            java.time.Instant.parse("2026-09-09T00:00:31Z"),
        ))
    }

    @Test fun reservationBindingIgnoresNumberFormattingAndRejectsOlderCalls() {
        val reserved = record("device-a", DeviceCallState.UNKNOWN,
            "11111111-1111-4111-8111-111111111111").copy(
            direction = DeviceCallDirection.OUTGOING,
            creationTimeMillis = null,
            remoteNumber = "+8619900000101",
            observedAt = "2026-09-09T00:00:00Z",
            outgoingReservationExpiresAt = "2026-09-09T00:05:00Z",
        )
        val now = java.time.Instant.parse("2026-09-09T00:02:00Z")
        val reservedAtMillis = java.time.Instant.parse(reserved.observedAt).toEpochMilli()
        // Telecom may report the destination without '+', with spaces or with parentheses.
        for (reported in listOf("+8619900000101", "8619900000101", "+86 199 0000 0101", "(+86)19900000101")) {
            assertEquals(
                "reservation must bind for $reported",
                reserved,
                recoverableOutgoingReservation(
                    listOf(reserved), "account-a", DeviceCallDirection.OUTGOING, reported, emptySet(), now,
                    reservedAtMillis + 1_000L,
                ),
            )
        }
        assertNull(recoverableOutgoingReservation(
            listOf(reserved), "account-a", DeviceCallDirection.OUTGOING, "+8619900000101", emptySet(), now, 1L,
        ))
        assertNull(recoverableOutgoingReservation(
            listOf(reserved), "account-a", DeviceCallDirection.OUTGOING, "+8618666000000", emptySet(), now, null,
        ))
    }

    @Test fun onlyOldUnboundRecordsWithoutALiveTelecomCallBecomeAbsent() {
        val now = java.time.Instant.parse("2026-09-09T00:10:00Z")
        val oldActive = record("device-a", DeviceCallState.ACTIVE)
        val oldReservation = record("device-b", DeviceCallState.UNKNOWN, "22222222-2222-4222-8222-222222222222").copy(
            direction = DeviceCallDirection.OUTGOING, creationTimeMillis = null,
        )
        val fresh = record("device-c", DeviceCallState.DIALING).copy(observedAt = "2026-09-09T00:09:30Z")
        val live = record("device-d", DeviceCallState.ACTIVE)
        val alreadyEnded = record("device-e", DeviceCallState.ENDED)

        val stale = staleNonTerminalRecords(
            listOf(oldActive, oldReservation, fresh, live, alreadyEnded),
            liveDeviceCallIds = setOf("device-d"),
            now = now,
            graceMillis = 5 * 60_000L,
        )
        assertEquals(listOf("device-b"), stale.map { it.deviceCallId })
    }

    @Test fun activeCallOlderThanGraceWithNoInCallIsNotConfirmedAbsent() {
        val now = java.time.Instant.parse("2026-09-09T00:10:00Z")
        val oldActive = record("device-a", DeviceCallState.ACTIVE, "11111111-1111-4111-8111-111111111111")
        val oldRinging = record("device-r", DeviceCallState.RINGING, "22222222-2222-4222-8222-222222222222")
        val oldDialing = record("device-d", DeviceCallState.DIALING, "33333333-3333-4333-8333-333333333333")
        val stale = staleNonTerminalRecords(
            listOf(oldActive, oldRinging, oldDialing),
            liveDeviceCallIds = emptySet(),
            now = now,
            graceMillis = 5 * 60_000L,
        )
        assertEquals(emptyList<DeviceCallRecord>(), stale)
        assertEquals(emptyList<String>(), confirmedAbsentCallIds(listOf(oldActive, oldRinging, oldDialing)))
    }

    @Test fun unreadableObservationTimestampIsNeverTreatedAsAbsent() {
        val broken = record("device-a", DeviceCallState.ACTIVE).copy(observedAt = "not-a-timestamp")
        assertEquals(
            emptyList<DeviceCallRecord>(),
            staleNonTerminalRecords(
                listOf(broken), emptySet(), java.time.Instant.parse("2026-09-09T01:00:00Z"), 60_000L,
            ),
        )
    }

    @Test fun rejectedSnapshotIsRebuiltOnlyForFencedConflictsAndWithinBudget() {
        assertEquals(true, shouldRebuildTelecomSnapshot(409, "STALE_SNAPSHOT", 0))
        assertEquals(true, shouldRebuildTelecomSnapshot(409, "FENCE_REJECTED", 2))
        assertEquals(false, shouldRebuildTelecomSnapshot(409, "STALE_SNAPSHOT", 3))
        assertEquals(false, shouldRebuildTelecomSnapshot(400, "INVALID_REQUEST", 0))
        assertEquals(false, shouldRebuildTelecomSnapshot(401, "UNAUTHORIZED", 0))
        assertEquals(false, shouldRebuildTelecomSnapshot(503, null, 0))
    }

    @Test fun onlyDialableDigitsAreComparedAcrossFormats() {
        assertEquals("8619900000101", dialNumberMatchKey("+86 199-0000-0101"))
        assertEquals("2025550101", dialNumberMatchKey("(202) 555-0101"))
        assertNull(dialNumberMatchKey(null))
        assertNull(dialNumberMatchKey("  "))
        assertNull(dialNumberMatchKey("unknown"))
    }

    @Test fun endedCallIsPrunedOnlyAfterSnapshotThatActuallyConfirmedIt() {
        val ended = record("device-a", DeviceCallState.ENDED, "11111111-1111-4111-8111-111111111111")
            .copy(incomingReported = true)
        assertEquals(listOf(ended), pruneAfterSnapshot(listOf(ended), emptySet()))
        assertEquals(emptyList<DeviceCallRecord>(), pruneAfterSnapshot(listOf(ended), setOf(ended.serverCallId!!)))
    }

    @Test fun missingOrEmptyReleasedCallIdsPruneNothing() {
        val ended = record("device-a", DeviceCallState.ENDED, "11111111-1111-4111-8111-111111111111")
            .copy(incomingReported = true)
        val localOnly = record("device-b", DeviceCallState.ENDED).copy(incomingReported = true)
        // Read inside the retention window: an empty release list prunes nothing on its own.
        assertEquals(
            listOf(ended, localOnly),
            pruneAfterSnapshot(listOf(ended, localOnly), emptySet(), WITHIN_RETENTION),
        )
        assertEquals(
            emptyList<String>(),
            releasedCallIdsFromSnapshotResponse(org.json.JSONObject()),
        )
        assertEquals(
            emptyList<String>(),
            releasedCallIdsFromSnapshotResponse(org.json.JSONObject().put("releasedCallIds", org.json.JSONArray())),
        )
        assertEquals(
            listOf(ended.serverCallId),
            releasedCallIdsFromSnapshotResponse(
                org.json.JSONObject().put("releasedCallIds", org.json.JSONArray().put(ended.serverCallId)),
            ),
        )
    }

    @Test fun unreportedIncomingRemainsWhileReportedLocalOnlyIsNotPrunedWithoutRelease() {
        val unreported = record("device-a", DeviceCallState.ENDED)
        val reported = record("device-b", DeviceCallState.ENDED).copy(incomingReported = true)
        // Release pruning is keyed on serverCallId alone; the age rule below is a separate pass, so
        // this one reads at a fixed instant inside the retention window rather than at wall clock.
        assertEquals(
            listOf(unreported, reported),
            pruneAfterSnapshot(listOf(unreported, reported), emptySet(), WITHIN_RETENTION),
        )
        assertEquals(
            listOf(unreported, reported),
            pruneAfterSnapshot(
                listOf(unreported, reported),
                setOf("11111111-1111-4111-8111-111111111111"),
                WITHIN_RETENTION,
            ),
        )
    }

    @Test fun onlyTerminalLocallySettledIncomingRowsAgeOutOfTheJournal() {
        val callId = "11111111-1111-4111-8111-111111111111"
        // A blocked call: rejected, suppressed locally, so it never received a server call id.
        val blocked = record("device-a", DeviceCallState.ENDED).copy(incomingReported = true)
        // Live rows carry the same local-settlement shape while the call is still up.
        val ringing = record("device-b", DeviceCallState.RINGING).copy(incomingReported = true)
        val active = record("device-c", DeviceCallState.ACTIVE).copy(incomingReported = true)
        // A normally reported call is owned by the control service and only a release may prune it.
        val serverBacked = record("device-d", DeviceCallState.ENDED, callId).copy(incomingReported = true)
        val unreported = record("device-e", DeviceCallState.ENDED)
        val all = listOf(blocked, ringing, active, serverBacked, unreported)

        // Inside the retention window nothing ages out at all.
        assertEquals(all, pruneAfterSnapshot(all, emptySet(), WITHIN_RETENTION))
        assertFalse(suppressedIncomingIsPrunable(blocked, WITHIN_RETENTION))

        // After it, exactly the suppressed terminal row goes; the live and server-backed rows stay.
        assertEquals(
            listOf(ringing, active, serverBacked, unreported),
            pruneAfterSnapshot(all, emptySet(), AFTER_RETENTION),
        )
        assertTrue(suppressedIncomingIsPrunable(blocked, AFTER_RETENTION))
        assertFalse(suppressedIncomingIsPrunable(ringing, AFTER_RETENTION))
        assertFalse(suppressedIncomingIsPrunable(active, AFTER_RETENTION))
        assertFalse(suppressedIncomingIsPrunable(serverBacked, AFTER_RETENTION))
        assertFalse(suppressedIncomingIsPrunable(unreported, AFTER_RETENTION))
        // An outgoing reservation is never touched by the incoming rule.
        assertFalse(suppressedIncomingIsPrunable(
            record("device-f", DeviceCallState.ENDED).copy(
                direction = DeviceCallDirection.OUTGOING, incomingReported = true,
            ),
            AFTER_RETENTION,
        ))
        // The release path keeps working alongside it, unchanged.
        assertEquals(
            listOf(ringing, active, unreported),
            pruneAfterSnapshot(all, setOf(callId), AFTER_RETENTION),
        )
        assertEquals(10L * 60_000L, SUPPRESSED_INCOMING_RETENTION_MILLIS)
    }

    @Test fun listedRingingIsNotReportableButIsInterceptedExactlyOnce() {
        val ringing = record("device-a", DeviceCallState.RINGING)
        // S21 §B keeps the live path exactly as it was: a listed call never becomes a normal incoming
        // report, so it never enters the Telecom snapshot and never produces a terminal report.
        assertEquals(true, incomingIsReportable(ringing, listed = false))
        assertEquals(false, incomingIsReportable(ringing, listed = true))
        assertEquals(false, incomingIsReportable(ringing.copy(incomingReported = true), listed = false))
        // What is new is the separate one-shot interception report, keyed off the same deviceCallId
        // and marked blockedLocally, with its own idempotency independent of the journal.
        val eventId = blockedCallInterceptionEventId(ringing.deviceCallId)
        val payload = blockedCallInterceptionPayload(
            eventId, generation = 9L, deviceCallId = ringing.deviceCallId, simId = "sim-a",
            observedAt = ringing.observedAt, remoteNumber = ringing.remoteNumber,
        )
        assertEquals(true, payload.getBoolean("blockedLocally"))
        assertEquals(ringing.deviceCallId, payload.getString("deviceCallId"))
        assertEquals(eventId, blockedCallInterceptionEventId(ringing.deviceCallId))
        val once = upsertInterception(
            emptyList(),
            InterceptionReport(eventId, InterceptionKind.CALL, payload.toString(), ringing.observedAt),
        )
        assertEquals(
            once,
            upsertInterception(
                once,
                InterceptionReport(eventId, InterceptionKind.CALL, payload.toString(), ringing.observedAt),
            ),
        )
    }

    @Test fun endedOutgoingIsPrunedByExactAcceptedSnapshotWithoutIncomingFlag() {
        val callId = "11111111-1111-4111-8111-111111111111"
        val endedOutgoing = record("device-a", DeviceCallState.ENDED, callId).copy(
            direction = DeviceCallDirection.OUTGOING,
            incomingReported = false,
        )
        assertEquals(listOf(endedOutgoing), pruneAfterSnapshot(listOf(endedOutgoing), emptySet()))
        assertEquals(
            emptyList<DeviceCallRecord>(),
            pruneAfterSnapshot(listOf(endedOutgoing), setOf(callId)),
        )
    }

    @Test fun answerRouteSurvivesTheDurableJournalAndDefaultsToTheHumanWindow() {
        val human = record("device-a", DeviceCallState.ACTIVE, "11111111-1111-4111-8111-111111111111")
        val ai = human.copy(answeredByAi = true)
        assertFalse(human.answeredByAi)
        // The whole point of putting the flag here is that it outlives the process that answered.
        assertEquals(human, human.toJson().toRecord())
        assertEquals(ai, ai.toJson().toRecord())
        assertTrue(ai.toJson().toRecord().answeredByAi)
        // Rows written before S22 carry no such key and must read as a human answer.
        val legacy = ai.toJson()
        legacy.remove("answeredByAi")
        assertEquals(human, legacy.toRecord())
        assertFalse(legacy.toRecord().answeredByAi)
    }

    @Test fun remoteAnswerSurvivesTheJournalAndLegacyRowsKeepRemoteMedia() {
        val local = record("device-a", DeviceCallState.ACTIVE, "11111111-1111-4111-8111-111111111111")
        val remote = local.copy(remoteAnswered = true)
        assertFalse(local.remoteAnswered)
        assertEquals(local, local.toJson().toRecord())
        assertEquals(remote, remote.toJson().toRecord())
        // Rows written before S72b carry no such key: a live call across the upgrade keeps its media leg.
        val legacy = local.toJson()
        legacy.remove("remoteAnswered")
        assertTrue(legacy.toRecord().remoteAnswered)
    }

    private companion object {
        /** The instant every [record] observation carries, plus the two sides of the retention edge. */
        val OBSERVED_AT: java.time.Instant = java.time.Instant.parse("2026-09-09T00:00:00Z")
        val WITHIN_RETENTION: java.time.Instant =
            OBSERVED_AT.plusMillis(SUPPRESSED_INCOMING_RETENTION_MILLIS - 1)
        val AFTER_RETENTION: java.time.Instant =
            OBSERVED_AT.plusMillis(SUPPRESSED_INCOMING_RETENTION_MILLIS)
    }

    private fun record(id: String, state: DeviceCallState, serverCallId: String? = null) = DeviceCallRecord(
        deviceCallId = id,
        phoneAccountHandle = "account-a",
        creationTimeMillis = 100L,
        direction = DeviceCallDirection.INCOMING,
        state = state,
        observedAt = "2026-09-09T00:00:00Z",
        remoteNumber = "+12025550101",
        incomingEventId = "33333333-3333-4333-8333-333333333333",
        incomingPayload = null,
        incomingReported = false,
        serverCallId = serverCallId,
    )
}
