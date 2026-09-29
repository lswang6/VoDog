package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import kotlinx.coroutines.runBlocking

class CallCommandMachineTest {
    private val now = Instant.parse("2026-09-09T01:00:00Z")

    @Test fun effectMarkerCrashBecomesUnknownAndNeverRepeatsSideEffect() {
        val repo = MemoryCallRepo()
        val spec = dial()
        repo.prepare(spec)
        repo.markEffectStarted(spec.commandId, dialTarget(), now.toString())
        var effects = 0
        val machine = CallCommandMachine(repo, { CallValidation.Allowed(dialTarget()) }, { _, _ ->
            effects++; CallEffectResult.Submitted("device", ActualTelecomState.DIALING)
        }, { now })

        assertTrue(runBlocking { machine.execute(spec) } is CallExecutionDecision.Unknown)
        assertTrue(runBlocking { machine.execute(spec) } is CallExecutionDecision.Unknown)
        assertEquals(0, effects)
    }

    @Test fun submittedDialReplayReusesResultWithoutPlacingSecondCall() {
        val repo = MemoryCallRepo(); var effects = 0
        val machine = CallCommandMachine(repo, { CallValidation.Allowed(dialTarget()) }, { _, _ ->
            effects++; CallEffectResult.Submitted("device-1", ActualTelecomState.DIALING)
        }, { now })
        val first = runBlocking { machine.execute(dial()) }
        val second = runBlocking { machine.execute(dial()) }
        assertEquals(first, second); assertEquals(1, effects)
        assertEquals(ActualTelecomState.DIALING, (first as CallExecutionDecision.Submitted).telecomState)
    }

    @Test fun routeChangeAfterDurableMarkerRejectsWithoutSideEffect() {
        val repo = MemoryCallRepo(); var checks = 0; var effects = 0
        val changed = dialTarget().copy(assignmentVersion = 8)
        val machine = CallCommandMachine(repo, {
            checks++; CallValidation.Allowed(if (checks < 3) dialTarget() else changed)
        }, { _, _ -> effects++; CallEffectResult.Submitted("device", ActualTelecomState.DIALING) }, { now })
        assertEquals(CallExecutionDecision.Rejected("execution_route_changed"), runBlocking { machine.execute(dial()) })
        assertEquals(0, effects)
    }

    @Test fun answerRequiresExactServerCallAndRingingState() {
        val spec = existing(CallCommandKind.ANSWER)
        val active = FrozenCallTarget.Existing("device-a", spec.serverCallId, ActualTelecomState.ACTIVE)
        val machine = CallCommandMachine(MemoryCallRepo(), { CallValidation.Allowed(active) },
            { _, _ -> error("must not answer") }, { now })
        assertEquals(CallExecutionDecision.Rejected("call_not_ringing"), runBlocking { machine.execute(spec) })
    }

    @Test fun expiredCommandAndPayloadCollisionNeverInvokeTelecom() {
        val repo = MemoryCallRepo(); var effects = 0
        val machine = CallCommandMachine(repo, { CallValidation.Allowed(dialTarget()) },
            { _, _ -> effects++; CallEffectResult.Submitted("device", ActualTelecomState.DIALING) }, { now })
        val expired = dial().copy(expiresAt = "2026-09-09T00:59:59Z")
        assertEquals(CallExecutionDecision.Rejected("command_expired"), runBlocking { machine.execute(expired) })
        assertEquals(CallExecutionDecision.Rejected("command_payload_collision"), runBlocking { machine.execute(dial()) })
        assertEquals(0, effects)
    }

    @Test fun deliveredExceptionIsUnknownAndNeverRetried() {
        val repo = MemoryCallRepo(); var effects = 0
        val machine = CallCommandMachine(repo, { CallValidation.Allowed(dialTarget()) }, { _, _ ->
            effects++; throw IllegalStateException("binder outcome unavailable")
        }, { now })
        assertTrue(runBlocking { machine.execute(dial()) } is CallExecutionDecision.Unknown)
        assertTrue(runBlocking { machine.execute(dial()) } is CallExecutionDecision.Unknown)
        assertEquals(1, effects)
    }

    @Test fun `same batch early hangups remain prepared then submit one physical disconnect`() {
        val repo = MemoryCallRepo(); var registered = false; var effects = 0
        val first = existing(CallCommandKind.HANG_UP)
        val specs = listOf(
            first,
            first.copy(commandId = "44444444-4444-4444-8444-444444444444", sequence = 10),
            first.copy(commandId = "55555555-5555-4555-8555-555555555555", sequence = 11),
        )
        val target = FrozenCallTarget.Existing("device-a", first.serverCallId, ActualTelecomState.ACTIVE)
        val machine = CallCommandMachine(repo, {
            if (registered) CallValidation.Allowed(target)
            else CallValidation.Deferred("telecom_call_not_registered")
        }, { _, _ -> effects++; CallEffectResult.Submitted("device-a", ActualTelecomState.ACTIVE) }, { now })

        specs.forEach { spec ->
            assertEquals(
                CallExecutionDecision.Deferred("telecom_call_not_registered"),
                runBlocking { machine.execute(spec) },
            )
            assertEquals(CallExecutionPhase.PREPARED, repo.find(spec.commandId)?.phase)
        }
        assertEquals(0, effects)

        registered = true
        specs.forEach { assertTrue(runBlocking { machine.execute(it) } is CallExecutionDecision.Submitted) }
        assertEquals(1, effects)
    }

    @Test fun `telecom disappearance at final fence returns command to prepared`() {
        val repo = MemoryCallRepo(); var checks = 0; var effects = 0
        val spec = existing(CallCommandKind.HANG_UP)
        val target = FrozenCallTarget.Existing("device-a", spec.serverCallId, ActualTelecomState.ACTIVE)
        val machine = CallCommandMachine(repo, {
            checks++
            if (checks == 3) CallValidation.Deferred("telecom_call_not_registered")
            else CallValidation.Allowed(target)
        }, { _, _ -> effects++; CallEffectResult.Submitted("device-a", ActualTelecomState.ACTIVE) }, { now })

        assertEquals(
            CallExecutionDecision.Deferred("telecom_call_not_registered"),
            runBlocking { machine.execute(spec) },
        )
        assertEquals(CallExecutionPhase.PREPARED, repo.find(spec.commandId)?.phase)
        assertEquals(null, repo.find(spec.commandId)?.effectStartedAt)
        assertEquals(0, effects)
    }

    @Test fun `separate hangup commands for same call submit one physical disconnect`() {
        val repo = MemoryCallRepo(); var effects = 0; var state = ActualTelecomState.ACTIVE
        val first = existing(CallCommandKind.HANG_UP)
        val second = first.copy(
            commandId = "44444444-4444-4444-8444-444444444444",
            sequence = first.sequence + 1,
        )
        val machine = CallCommandMachine(repo, {
            CallValidation.Allowed(FrozenCallTarget.Existing("device-a", first.serverCallId, state))
        }, { _, _ ->
            effects++
            state = ActualTelecomState.DISCONNECTING
            CallEffectResult.Submitted("device-a", ActualTelecomState.ACTIVE)
        }, { now })

        assertTrue(runBlocking { machine.execute(first) } is CallExecutionDecision.Submitted)
        assertTrue(runBlocking { machine.execute(second) } is CallExecutionDecision.Submitted)
        assertEquals(1, effects)
        assertEquals(CallExecutionPhase.SUBMITTED, repo.find(second.commandId)?.phase)
    }

    @Test fun `unknown hangup result fences later commands from repeating disconnect`() {
        val repo = MemoryCallRepo(); var effects = 0
        val first = existing(CallCommandKind.HANG_UP)
        val second = first.copy(
            commandId = "44444444-4444-4444-8444-444444444444",
            sequence = first.sequence + 1,
        )
        val target = FrozenCallTarget.Existing("device-a", first.serverCallId, ActualTelecomState.ACTIVE)
        val machine = CallCommandMachine(repo, { CallValidation.Allowed(target) }, { _, _ ->
            effects++; CallEffectResult.Unknown("TELECOM_REQUEST_RESULT_UNKNOWN")
        }, { now })

        assertTrue(runBlocking { machine.execute(first) } is CallExecutionDecision.Unknown)
        assertTrue(runBlocking { machine.execute(second) } is CallExecutionDecision.Unknown)
        assertEquals(1, effects)
        assertEquals(CallExecutionPhase.UNKNOWN, repo.find(second.commandId)?.phase)
    }

    @Test fun `reconciliation without a record persists expired rejection without validation or effect`() {
        val repo = MemoryCallRepo(); var validations = 0; var effects = 0
        val spec = dial().copy(reconciliationOnly = true)
        val machine = CallCommandMachine(repo, { validations++; CallValidation.Allowed(dialTarget()) }, { _, _ ->
            effects++; CallEffectResult.Submitted("device", ActualTelecomState.DIALING)
        }, { Instant.parse("2026-01-01T00:00:00Z") })

        assertEquals(
            CallExecutionDecision.Rejected("command_expired"),
            runBlocking { machine.execute(spec) },
        )
        assertEquals(CallExecutionPhase.REJECTED, repo.find(spec.commandId)?.phase)
        assertEquals(0, validations)
        assertEquals(0, effects)
    }

    @Test fun `expired reconciliation safely rejects a legacy invalid dial number`() {
        val repo = MemoryCallRepo(); var validations = 0; var effects = 0
        val spec = dial().copy(remoteNumber = "*100#", reconciliationOnly = true)
        val machine = CallCommandMachine(repo, { validations++; CallValidation.Allowed(dialTarget()) }, { _, _ ->
            effects++; CallEffectResult.Submitted("device", ActualTelecomState.DIALING)
        }, { Instant.parse("2026-01-01T00:00:00Z") })

        assertEquals(
            CallExecutionDecision.Rejected("command_expired"),
            runBlocking { machine.execute(spec) },
        )
        assertEquals(CallExecutionPhase.REJECTED, repo.find(spec.commandId)?.phase)
        assertEquals(0, validations)
        assertEquals(0, effects)
    }

    @Test fun `live invalid dial number is durably rejected without validation or effect`() {
        val repo = MemoryCallRepo(); var validations = 0; var effects = 0
        val spec = dial().copy(remoteNumber = "tel:10000")
        val machine = CallCommandMachine(repo, { validations++; CallValidation.Allowed(dialTarget()) }, { _, _ ->
            effects++; CallEffectResult.Submitted("device", ActualTelecomState.DIALING)
        }, { now })

        assertEquals(
            CallExecutionDecision.Rejected("remote_number_invalid"),
            runBlocking { machine.execute(spec) },
        )
        assertEquals(CallExecutionPhase.REJECTED, repo.find(spec.commandId)?.phase)
        assertEquals(0, validations)
        assertEquals(0, effects)
    }

    @Test fun `service short code reaches the call effect`() {
        val repo = MemoryCallRepo(); var effects = 0
        val spec = dial().copy(remoteNumber = "10000")
        val machine = CallCommandMachine(repo, { CallValidation.Allowed(dialTarget()) }, { _, _ ->
            effects++
            CallEffectResult.Submitted("device", ActualTelecomState.DIALING)
        }, { now })

        assertTrue(runBlocking { machine.execute(spec) } is CallExecutionDecision.Submitted)
        assertEquals(1, effects)
    }

    @Test fun `reconciliation converts interrupted effect to unknown and replays terminal decisions`() {
        val repo = MemoryCallRepo(); var effects = 0
        val spec = dial().copy(reconciliationOnly = true)
        repo.prepare(spec)
        repo.markEffectStarted(spec.commandId, dialTarget(), now.toString())
        val machine = CallCommandMachine(repo, { error("must not validate") }, { _, _ ->
            effects++; error("must not execute")
        }, { now })

        val first = runBlocking { machine.execute(spec) }
        val second = runBlocking { machine.execute(spec) }
        assertTrue(first is CallExecutionDecision.Unknown)
        assertEquals(first, second)
        assertEquals(0, effects)
    }

    @Test fun `reconciliation metadata does not change immutable command fingerprint`() {
        assertEquals(dial().fingerprint, dial().copy(reconciliationOnly = true).fingerprint)
    }

    @Test fun `reconciliation fence still requires enabled current epoch`() {
        assertTrue(callCommandFenceAllows(true, 3, 3))
        assertEquals(false, callCommandFenceAllows(false, 3, 3))
        assertEquals(false, callCommandFenceAllows(true, 4, 3))
        assertEquals(false, callCommandFenceAllows(true, 0, 0))
    }

    @Test fun `closed phone gate admits only reconciliation call work`() {
        val ordinary = GatewayCommand("id", 3, 9, kind = "hangup")
        assertEquals(false, isCallCommandExecutable(ordinary, callExecutionReady = false))
        assertTrue(isCallCommandExecutable(
            ordinary.copy(reconciliationOnly = true),
            callExecutionReady = false,
        ))
        assertTrue(isCallCommandExecutable(ordinary, callExecutionReady = true))
        assertEquals(false, isCallCommandExecutable(
            ordinary.copy(kind = "send_sms", reconciliationOnly = true),
            callExecutionReady = false,
        ))
    }

    @Test fun hangupWithBlankOrNullDeviceCallIdIsRejectedWithoutThrowing() {
        val callId = "22222222-2222-4222-8222-222222222222"
        val payloads = listOf(
            """{"callId":"$callId"}""",
            """{"callId":"$callId","deviceCallId":null}""",
            """{"callId":"$callId","deviceCallId":""}""",
        )
        payloads.forEach { payload ->
            val command = GatewayCommand(
                "11111111-1111-4111-8111-111111111111", 3, 9,
                callId = callId, kind = "hangup", payloadJson = payload,
                expiresAt = "2026-09-09T01:00:30Z",
            )
            val spec = CallCommandSpec.from(command)
            assertNull(spec.deviceCallId)
            val repo = MemoryCallRepo()
            var effects = 0
            val machine = CallCommandMachine(
                repo,
                {
                    if (it.deviceCallId.isNullOrBlank()) CallValidation.Rejected("call_not_found")
                    else CallValidation.Allowed(FrozenCallTarget.Existing("device-a", it.serverCallId, ActualTelecomState.ACTIVE))
                },
                { _, _ -> effects++; CallEffectResult.Submitted("device-a", ActualTelecomState.ACTIVE) },
                { now },
            )
            val decision = runBlocking { machine.execute(spec) }
            assertEquals(CallExecutionDecision.Rejected("call_not_found"), decision)
            assertEquals(0, effects)
            val ack = decision.toAck(spec)
            assertEquals("rejected", ack.status)
            assertEquals("not_executed", ack.result.phase)
            assertEquals("call_not_found", ack.result.reason)
        }
        assertNull(hangupSpecAllowingMissingDeviceCall(GatewayCommand(
            "11111111-1111-4111-8111-111111111111", 3, 9, kind = "hangup", payloadJson = "{}",
        )))
    }

    @Test fun deferredCallCommandDoesNotBreakHeartbeatWork() {
        assertEquals(false, shouldBreakHeartbeatForUnhandledCallCommand())
        val repo = MemoryCallRepo()
        val spec = existing(CallCommandKind.HANG_UP)
        val machine = CallCommandMachine(
            repo,
            { CallValidation.Deferred("telecom_call_not_registered") },
            { _, _ -> error("must not invoke telecom") },
            { now },
        )
        val decision = runBlocking { machine.execute(spec) }
        assertEquals(CallExecutionDecision.Deferred("telecom_call_not_registered"), decision)
        assertEquals(CallExecutionPhase.PREPARED, repo.find(spec.commandId)?.phase)
    }

    @Test fun `ACK evidence requires exact command fingerprint`() {
        val repo = MemoryCallRepo()
        val spec = dial()
        repo.prepare(spec)
        assertThrows(IllegalArgumentException::class.java) {
            repo.markAckDelivered(spec.commandId, spec.generation, "different", now.toString())
        }
        assertNull(repo.find(spec.commandId)?.ackDeliveredAt)
        repo.markAckDelivered(spec.commandId, spec.generation, spec.fingerprint, now.toString())
        assertEquals(now.toString(), repo.find(spec.commandId)?.ackDeliveredAt)
    }

    @Test fun `ai answer payload is parsed and never changes the immutable command fingerprint`() {
        val tagged = CallCommandSpec.from(answerCommand(""","answeredBy":"ai""""))
        val untagged = CallCommandSpec.from(answerCommand(""))
        assertTrue(tagged.answeredByAi)
        assertEquals(false, untagged.answeredByAi)
        assertEquals(untagged.deviceCallId, tagged.deviceCallId)
        assertEquals(untagged.serverCallId, tagged.serverCallId)
        // Decision 9 only widens a local timeout, so it must stay out of the fingerprint: an
        // in-flight command whose payload gains the key must not read as a payload collision.
        assertEquals(untagged.fingerprint, tagged.fingerprint)
        assertEquals(untagged.fingerprint, existing(CallCommandKind.ANSWER).fingerprint)
        // An explicit JSON null is "absent", and any other route is refused rather than guessed.
        assertEquals(false, CallCommandSpec.from(answerCommand(""","answeredBy":null""")).answeredByAi)
        assertThrows(IllegalArgumentException::class.java) {
            CallCommandSpec.from(answerCommand(""","answeredBy":"human""""))
        }
        // A dial/hangup that somehow carries the key must never stall the command loop.
        val hangup = CallCommandSpec.from(GatewayCommand(
            "11111111-1111-4111-8111-111111111111", 3, 9, kind = "hangup",
            payloadJson = """{"callId":"22222222-2222-4222-8222-222222222222","answeredBy":"nonsense"}""",
            expiresAt = "2026-09-09T01:00:30Z",
        ))
        assertEquals(false, hangup.answeredByAi)
    }

    @Test fun `an ai answer stays idempotent across a payload that lost the answer route`() {
        val repo = MemoryCallRepo()
        val target = FrozenCallTarget.Existing("device-a", "22222222-2222-4222-8222-222222222222",
            ActualTelecomState.RINGING)
        var effects = 0
        val routes = mutableListOf<Boolean>()
        val machine = CallCommandMachine(repo, { CallValidation.Allowed(target) }, { spec, _ ->
            effects++; routes += spec.answeredByAi
            CallEffectResult.Submitted("device-a", ActualTelecomState.RINGING)
        }, { now })
        val tagged = CallCommandSpec.from(answerCommand(""","answeredBy":"ai""""))
        val first = runBlocking { machine.execute(tagged) }
        // Same commandId, payload replayed without the key: journal evidence must still match.
        val replayed = runBlocking { machine.execute(CallCommandSpec.from(answerCommand(""))) }
        val again = runBlocking { machine.execute(tagged) }
        assertEquals(first, replayed)
        assertEquals(first, again)
        assertEquals(1, effects)
        assertEquals(listOf(true), routes)
        assertEquals(tagged.fingerprint, repo.find(tagged.commandId)?.commandFingerprint)
    }

    @Test fun `S73i hangup without deviceCallId disconnects the dialing call its dial reserved`() {
        val repo = MemoryCallRepo()
        val serverCallId = dial().serverCallId
        val records = listOf(
            outgoingRecord("old-leg", "44444444-4444-4444-8444-444444444444", DeviceCallState.ACTIVE),
            outgoingRecord("device-dialing", serverCallId, DeviceCallState.DIALING),
        )
        val disconnected = mutableSetOf<String>()
        val hungUp = mutableListOf<String>()
        // Mirrors GatewayCallCoordinator.validate/validateExisting for HANG_UP.
        val machine = CallCommandMachine(repo, { spec ->
            val id = resolveHangupDeviceCallId(spec, records)
            if (id == null) CallValidation.Rejected("call_not_found")
            else CallValidation.Allowed(FrozenCallTarget.Existing(id, spec.serverCallId,
                if (id in disconnected) ActualTelecomState.DISCONNECTED else ActualTelecomState.DIALING))
        }, { _, target ->
            val id = (target as FrozenCallTarget.Existing).deviceCallId
            hungUp += id; disconnected += id
            CallEffectResult.Submitted(id, target.state)
        }, { now })

        // Prod 01ab0407: seq 2688 was queued before Control had the dial ACK, so deviceCallId is null.
        val early = hangupCommand("55555555-5555-4555-8555-555555555555", 10, deviceCallId = null)
        val first = runBlocking { machine.execute(early) }
        assertEquals(CallExecutionDecision.Submitted("device-dialing", ActualTelecomState.DIALING, now.toString()), first)
        assertEquals(listOf("device-dialing"), hungUp)
        val ack = first.toAck(early)
        assertEquals("acked", ack.status)
        assertEquals("device-dialing", ack.result.deviceCallId)
        assertEquals(early.fingerprint, repo.find(early.commandId)?.commandFingerprint)

        // Seq 2689 carries the id: it reuses the first termination intent instead of a second disconnect.
        val late = hangupCommand("66666666-6666-4666-8666-666666666666", 11, deviceCallId = "device-dialing")
        assertEquals(first, runBlocking { machine.execute(late) })
        // Replay of the early hangup is idempotent.
        assertEquals(first, runBlocking { machine.execute(early) })
        assertEquals(listOf("device-dialing"), hungUp)
    }

    @Test fun `S73i hangup resolution prefers the live row and still reports unknown calls`() {
        val serverCallId = dial().serverCallId
        val spec = hangupCommand("55555555-5555-4555-8555-555555555555", 10, deviceCallId = null)
        assertEquals("live", resolveHangupDeviceCallId(spec, listOf(
            outgoingRecord("live", serverCallId, DeviceCallState.DIALING),
            outgoingRecord("ended", serverCallId, DeviceCallState.ENDED),
        )))
        assertEquals("ended", resolveHangupDeviceCallId(spec, listOf(outgoingRecord("ended", serverCallId, DeviceCallState.ENDED))))
        assertNull(resolveHangupDeviceCallId(spec, listOf(
            outgoingRecord("other", "44444444-4444-4444-8444-444444444444", DeviceCallState.DIALING),
        )))
        assertEquals("explicit", resolveHangupDeviceCallId(spec.copy(deviceCallId = "explicit"), emptyList()))
    }

    @Test fun `S73i hangup queued behind an unexecuted dial cancels the dial before any effect`() {
        val repo = MemoryCallRepo()
        val serverCallId = dial().serverCallId
        val cancelled = mutableSetOf<String>()
        var dials = 0
        var hangups = 0
        val validator = cancellingDialValidator(setOf(serverCallId), cancelled) { spec ->
            if (spec.kind == CallCommandKind.DIAL) CallValidation.Allowed(dialTarget())
            else CallValidation.Rejected("call_not_found") // the device journal has no row: the dial never reserved one
        }
        val machine = CallCommandMachine(repo, validator, { spec, _ ->
            if (spec.kind == CallCommandKind.DIAL) dials++ else hangups++
            CallEffectResult.Submitted("device", ActualTelecomState.DIALING)
        }, { now })

        val dial = dial()
        val dialDecision = runBlocking { machine.execute(dial) }
        assertEquals(CallExecutionDecision.Rejected("call_already_ended"), dialDecision)
        assertEquals(setOf(serverCallId), cancelled)
        val dialAck = dialDecision.toAck(dial)
        assertEquals("rejected", dialAck.status)
        assertEquals("not_executed", dialAck.result.phase)
        assertEquals("call_already_ended", dialAck.result.reason)
        assertEquals(dial.fingerprint, dialAck.commandFingerprint)
        assertNull(repo.find(dial.commandId)?.effectStartedAt)

        val hangup = hangupCommand("55555555-5555-4555-8555-555555555555", 10, deviceCallId = null)
        val hangupDecision = runBlocking { machine.execute(hangup) }
        assertEquals(CallExecutionDecision.Rejected("call_already_ended"), hangupDecision)
        assertEquals("not_executed", hangupDecision.toAck(hangup).result.phase)

        // A later cycle (fresh coordinator, no hangup in the batch) replays the dial from the journal: still not placed.
        val replay = CallCommandMachine(repo, cancellingDialValidator(emptySet(), mutableSetOf()) {
            CallValidation.Allowed(dialTarget())
        }, { _, _ -> dials++; CallEffectResult.Submitted("device", ActualTelecomState.DIALING) }, { now })
        assertEquals(dialDecision, runBlocking { replay.execute(dial) })
        assertEquals(0, dials); assertEquals(0, hangups)

        // Horizon: once Control accepts the ACK the rejected-before-effect dial is retirable.
        repo.markAckDelivered(dial.commandId, dial.generation, dial.fingerprint, now.toString())
        assertTrue(requireNotNull(repo.find(dial.commandId)).acknowledgedTerminal())
    }

    @Test fun `S73i a dial with no hangup in its batch is validated normally`() {
        val cancelled = mutableSetOf<String>()
        val validator = cancellingDialValidator(setOf("44444444-4444-4444-8444-444444444444"), cancelled) {
            CallValidation.Allowed(dialTarget())
        }
        assertEquals(CallValidation.Allowed(dialTarget()), validator(dial()))
        assertTrue(cancelled.isEmpty())
    }

    private fun hangupCommand(commandId: String, sequence: Long, deviceCallId: String?) = CallCommandSpec(
        commandId, "22222222-2222-4222-8222-222222222222",
        3, sequence, "2026-09-09T01:00:30Z", CallCommandKind.HANG_UP, deviceCallId = deviceCallId,
    )
    private fun outgoingRecord(deviceCallId: String, serverCallId: String, state: DeviceCallState) = DeviceCallRecord(
        deviceCallId, "protected-account", null, DeviceCallDirection.OUTGOING, state, now.toString(),
        "+12025550101", null, null, false, serverCallId,
    )

    private fun answerCommand(extraPayload: String) = GatewayCommand(
        "11111111-1111-4111-8111-111111111111", 3, 9,
        callId = "22222222-2222-4222-8222-222222222222", kind = "answer",
        payloadJson = """{"callId":"22222222-2222-4222-8222-222222222222","deviceCallId":"device-a"$extraPayload}""",
        expiresAt = "2026-09-09T01:00:30Z",
    )

    private fun dial() = CallCommandSpec(
        "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
        3, 9, "2026-09-09T01:00:30Z", CallCommandKind.DIAL,
        "33333333-3333-4333-8333-333333333333", "+12025550101",
    )
    private fun existing(kind: CallCommandKind) = CallCommandSpec(
        "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
        3, 9, "2026-09-09T01:00:30Z", kind, deviceCallId = "device-a",
    )
    private fun dialTarget() = FrozenCallTarget.Dial(
        "33333333-3333-4333-8333-333333333333", 7, 1, "protected-account", "fingerprint",
    )
}

private class MemoryCallRepo : CallCommandRepository {
    private val records = mutableMapOf<String, CallExecutionRecord>()
    override fun find(commandId: String) = records[commandId]
    override fun prepare(spec: CallCommandSpec) = records.getOrPut(spec.commandId) {
        CallExecutionRecord(spec, spec.fingerprint, CallExecutionPhase.PREPARED, null, null, null, null, null)
    }
    override fun markEffectStarted(commandId: String, target: FrozenCallTarget, at: String) = update(commandId) {
        it.copy(phase = CallExecutionPhase.EFFECT_STARTED, target = target, effectStartedAt = at)
    }
    override fun markSubmitted(commandId: String, result: CallEffectResult.Submitted) = update(commandId) {
        it.copy(phase = CallExecutionPhase.SUBMITTED, deviceCallId = result.deviceCallId, telecomState = result.telecomState)
    }
    override fun markRejected(commandId: String, reason: String) = update(commandId) {
        it.copy(phase = CallExecutionPhase.REJECTED, reason = reason)
    }
    override fun markUnknown(commandId: String, reason: String) = update(commandId) {
        it.copy(phase = CallExecutionPhase.UNKNOWN, reason = reason)
    }
    override fun markDeferred(commandId: String) = update(commandId) {
        it.copy(phase = CallExecutionPhase.PREPARED, target = null, effectStartedAt = null)
    }
    override fun markAckDelivered(
        commandId: String,
        generation: Long,
        commandFingerprint: String?,
        at: String,
    ): CallExecutionRecord? {
        val existing = records[commandId] ?: return null
        if (commandFingerprint == null) return null
        require(existing.spec.generation == generation && existing.commandFingerprint == commandFingerprint)
        return update(commandId) {
            it.copy(ackDeliveredAt = it.ackDeliveredAt ?: at)
        }
    }
    override fun findTerminationIntent(
        serverCallId: String,
        deviceCallId: String,
        excludingCommandId: String,
    ) = records.values.firstOrNull {
        it.spec.commandId != excludingCommandId && it.spec.kind == CallCommandKind.HANG_UP &&
            it.spec.serverCallId == serverCallId && it.hangupDeviceCallId() == deviceCallId &&
            it.phase in setOf(CallExecutionPhase.EFFECT_STARTED, CallExecutionPhase.SUBMITTED, CallExecutionPhase.UNKNOWN)
    }
    private fun update(id: String, transform: (CallExecutionRecord) -> CallExecutionRecord): CallExecutionRecord =
        transform(requireNotNull(records[id])).also { records[id] = it }
}
