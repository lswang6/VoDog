package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.Collections
import java.util.concurrent.CountDownLatch

class SmsCommandMachineTest {
    private val spec = SmsCommandSpec(
        commandId = "11111111-1111-4111-8111-111111111111",
        smsId = "22222222-2222-4222-8222-222222222222",
        generation = 3,
        sequence = 7,
        expiresAt = "2026-09-09T01:10:00Z",
        simId = "33333333-3333-4333-8333-333333333333",
        remoteNumber = "+12025550101",
        body = "part one|part two|part three",
    )
    private val now = { Instant.parse("2026-09-09T01:00:00Z") }

    @Test fun destinationAcceptsE164AndDomesticServiceNumbers() {
        fun parse(number: String) = runCatching {
            SmsCommandSpec.from(GatewayCommand(
                commandId = spec.commandId, generation = 3, sequence = 7, smsId = spec.smsId, kind = "send_sms",
                payloadJson = org.json.JSONObject().put("remoteNumber", number).put("simId", spec.simId)
                    .put("body", "1").toString(),
                expiresAt = spec.expiresAt,
            ))
        }
        listOf("10655010760600015435", "1001298", "10010", "+12025550101").forEach {
            assertEquals(it, parse(it).getOrThrow().remoteNumber)
        }
        listOf("abc", "+0123", "", "1".repeat(21)).forEach { assertTrue(it, parse(it).isFailure) }
    }

    @Test fun multipartIsSubmittedOnceAndDuplicateOnlyReplaysAck() {
        val repository = MemoryRepository()
        val executor = FakeExecutor()
        val machine = SmsCommandMachine(repository, executor, now)
        assertTrue(machine.execute(spec) is SmsExecutionDecision.Acked)
        assertTrue(machine.execute(spec) is SmsExecutionDecision.Acked)
        assertEquals(1, executor.submissions)
        assertEquals(listOf("part one", "part two", "part three"), executor.lastParts)
        assertEquals(SmsExecutionPhase.SUBMITTED, repository.find(spec.commandId)?.phase)
    }

    @Test fun processDeathAfterEffectMarkerNeverResends() {
        val repository = MemoryRepository()
        val executor = FakeExecutor(crash = true)
        val machine = SmsCommandMachine(repository, executor, now)
        runCatching { machine.execute(spec) }
        assertEquals(SmsExecutionPhase.EFFECT_STARTED, repository.find(spec.commandId)?.phase)
        val retry = machine.execute(spec)
        assertTrue(retry is SmsExecutionDecision.Rejected)
        assertEquals("execution_unknown", (retry as SmsExecutionDecision.Rejected).reason)
        assertEquals(1, executor.submissions)
        assertEquals(SmsExecutionPhase.UNKNOWN, repository.find(spec.commandId)?.phase)
    }

    @Test fun changedPayloadForSameCommandNeverExecutes() {
        val repository = MemoryRepository()
        val executor = FakeExecutor()
        val machine = SmsCommandMachine(repository, executor, now)
        machine.execute(spec)
        val result = machine.execute(spec.copy(body = "changed"))
        assertEquals("command_payload_collision", (result as SmsExecutionDecision.Rejected).reason)
        assertEquals(1, executor.submissions)
    }

    @Test fun expiredPreparedCommandAndDivideFailureNeverCrossEffectBoundary() {
        val expiredRepository = MemoryRepository()
        val expiredExecutor = FakeExecutor()
        val expired = SmsCommandMachine(
            expiredRepository, expiredExecutor, now = { Instant.parse("2026-09-09T02:00:00Z") },
        ).execute(spec)
        assertEquals("command_expired", (expired as SmsExecutionDecision.Rejected).reason)
        assertEquals(0, expiredExecutor.submissions)
        assertEquals(SmsExecutionPhase.FAILED, expiredRepository.find(spec.commandId)?.phase)

        val divideRepository = MemoryRepository()
        val divide = SmsCommandMachine(divideRepository, object : SmsExecutor {
            override fun divide(body: String): List<String> = error("codec unavailable")
            override fun submit(spec: SmsCommandSpec, correlationId: String, parts: List<String>) = Unit
        }, now).execute(spec)
        assertEquals("sms_divide_failed", (divide as SmsExecutionDecision.Rejected).reason)
        assertEquals(SmsExecutionPhase.FAILED, divideRepository.find(spec.commandId)?.phase)
    }

    @Test fun submittedReplayBypassesChangedRuntimeGuard() {
        val repository = MemoryRepository()
        val executor = FakeExecutor()
        SmsCommandMachine(repository, executor, now).execute(spec)
        var guardCalls = 0
        val replay = SmsCommandMachine(repository, FakeExecutor(), now) {
            guardCalls++
            "control_disabled"
        }.execute(spec)
        assertTrue(replay is SmsExecutionDecision.Acked)
        assertEquals(0, guardCalls)
        assertEquals(1, executor.submissions)
    }

    @Test fun guardIsRepeatedAfterDivisionBeforeEffectMarker() {
        val repository = MemoryRepository()
        val executor = FakeExecutor()
        var checks = 0
        val result = SmsCommandMachine(repository, executor, now) {
            checks++
            if (checks == 2) "sim_identity_changed" else null
        }.execute(spec)
        assertEquals("sim_identity_changed", (result as SmsExecutionDecision.Rejected).reason)
        assertEquals(2, checks)
        assertEquals(0, executor.submissions)
        assertEquals(SmsExecutionPhase.FAILED, repository.find(spec.commandId)?.phase)
    }

    @Test fun finalGuardAfterDurableMarkerCanStillPreventPlatformSubmission() {
        val repository = MemoryRepository()
        val executor = FakeExecutor()
        var checks = 0
        val result = SmsCommandMachine(repository, executor, now) {
            checks++
            if (checks == 3) "control_disabled" else null
        }.execute(spec)
        assertEquals("control_disabled", (result as SmsExecutionDecision.Rejected).reason)
        assertEquals(3, checks)
        assertEquals(0, executor.submissions)
        assertEquals(SmsExecutionPhase.FAILED, repository.find(spec.commandId)?.phase)
    }

    @Test fun concurrentDeliveryOfOneCommandCrossesPlatformBoundaryOnce() {
        val repository = MemoryRepository()
        val executor = FakeExecutor()
        val start = CountDownLatch(1)
        val decisions = Collections.synchronizedList(mutableListOf<SmsExecutionDecision>())
        val workers = List(12) {
            Thread {
                start.await()
                decisions += SmsCommandMachine(repository, executor, now).execute(spec)
            }.also(Thread::start)
        }
        start.countDown()
        workers.forEach { it.join(2_000) }
        assertEquals(12, decisions.size)
        assertTrue(decisions.all { it is SmsExecutionDecision.Acked })
        assertEquals(1, executor.submissions)
    }

    @Test fun submitAndFailureDiagCarryIdsButNeverTheNumberOrBody() {
        val posts = java.util.Collections.synchronizedList(mutableListOf<GatewayHttpRequest>())
        GatewayDiag.attach("token", GatewayHttpTransport { posts.add(it); GatewayHttpResponse(200, """{"accepted":1}""") })
        GatewayDiag.flushNow()
        posts.clear() // rows other tests left in the shared ring
        SmsCommandMachine(MemoryRepository(), FakeExecutor(), now).execute(spec)
        SmsCommandMachine(MemoryRepository(), FakeExecutor(), { Instant.parse("2026-09-10T00:00:00Z") }).execute(spec)
        GatewayDiag.flushNow()
        val rows = synchronized(posts) { posts.toList() }.flatMap { request ->
            org.json.JSONArray(String(requireNotNull(request.jsonBody))).let { a -> List(a.length(), a::getJSONObject) }
        }.filter { it.getString("event").startsWith("sms.") }
        assertEquals(listOf("sms.send", "sms.failed"), rows.map { it.getString("event") })
        assertEquals(3, rows[0].getJSONObject("fields").getInt("parts"))
        assertEquals("command_expired", rows[1].getJSONObject("fields").getString("result"))
        rows.forEach {
            assertEquals(spec.smsId, it.getJSONObject("fields").getString("smsId"))
            assertTrue(spec.remoteNumber !in it.toString() && "part one" !in it.toString())
        }
    }

    @Test fun statusCallbacksMapToSentDeliveredAndFailedDiag() {
        val repository = MemoryRepository()
        repository.prepare(spec)
        repository.markEffectStarted(spec.commandId, 2, now().toString())
        val submitted = repository.markSubmitted(spec.commandId)
        val later = Instant.parse("2026-09-09T01:00:05Z")
        val ok = android.app.Activity.RESULT_OK
        val sent = mergeSmsPartStatus(submitted, 0, AndroidSmsExecutor.STATUS_SENT, true)
        val (sentEvent, sentFields) = requireNotNull(smsStatusDiag(submitted, sent, 0, AndroidSmsExecutor.STATUS_SENT, ok, later))
        assertEquals("sms.sent", sentEvent)
        assertEquals(5_000L, sentFields["ms"])
        assertEquals(null, sentFields["errorCode"])
        assertEquals("sms.delivered", smsStatusDiag(submitted, submitted, 1, AndroidSmsExecutor.STATUS_DELIVERED, ok, later)?.first)
        val failed = mergeSmsPartStatus(sent, 1, AndroidSmsExecutor.STATUS_SENT, false)
        val (failedEvent, failedFields) = requireNotNull(smsStatusDiag(sent, failed, 1, AndroidSmsExecutor.STATUS_SENT, 4, later))
        assertEquals("sms.failed", failedEvent)
        assertEquals(4, failedFields["errorCode"])
    }

    @Test fun deliveryBeforeSentIsMonotonicAndStillMergesLateSentStatistics() {
        val repository = MemoryRepository()
        val prepared = repository.prepare(spec)
        val submitted = repository.markEffectStarted(spec.commandId, 2, now().toString())
            .let { repository.markSubmitted(spec.commandId) }
        val oneDelivery = mergeSmsPartStatus(submitted, 0, AndroidSmsExecutor.STATUS_DELIVERED, true)
        val delivered = mergeSmsPartStatus(oneDelivery, 1, AndroidSmsExecutor.STATUS_DELIVERED, true)
        assertEquals(SmsExecutionPhase.DELIVERED, delivered.phase)
        assertTrue(delivered.events.any { it.state == "delivered" })

        val lateSent0 = mergeSmsPartStatus(delivered, 0, AndroidSmsExecutor.STATUS_SENT, true)
        val lateSent1 = mergeSmsPartStatus(lateSent0, 1, AndroidSmsExecutor.STATUS_SENT, true)
        assertEquals(SmsExecutionPhase.DELIVERED, lateSent1.phase)
        assertTrue(lateSent1.sentParts.all { it == SmsPartResult.SUCCEEDED })
        assertTrue(lateSent1.events.any { it.state == "sent" })
        val lateFailure = mergeSmsPartStatus(lateSent1, 0, AndroidSmsExecutor.STATUS_SENT, false)
        assertEquals(SmsExecutionPhase.DELIVERED, lateFailure.phase)
        assertEquals(lateSent1.sentParts, lateFailure.sentParts)
        assertEquals(prepared.correlationId, lateFailure.correlationId)
    }

    private class FakeExecutor(private val crash: Boolean = false) : SmsExecutor {
        var submissions = 0
        var lastParts = emptyList<String>()
        override fun divide(body: String) = body.split('|')
        override fun submit(spec: SmsCommandSpec, correlationId: String, parts: List<String>) {
            submissions++
            lastParts = parts
            if (crash) throw SimulatedProcessDeath()
        }
    }

    private class SimulatedProcessDeath : Error()

    private class MemoryRepository : SmsCommandRepository {
        private val records = mutableMapOf<String, SmsExecutionRecord>()
        override fun find(commandId: String) = records[commandId]
        override fun prepare(spec: SmsCommandSpec) = SmsExecutionRecord(
            spec, spec.fingerprint, "44444444-4444-4444-8444-444444444444", SmsExecutionPhase.PREPARED,
            null, 0, emptyList(), emptyList(), null, emptyList(), false, null, false,
        ).also { records[spec.commandId] = it }
        override fun markEffectStarted(commandId: String, partCount: Int, at: String) = change(commandId) {
            it.copy(
                phase = SmsExecutionPhase.EFFECT_STARTED, effectStartedAt = at, partCount = partCount,
                sentParts = List(partCount) { SmsPartResult.PENDING },
                deliveredParts = List(partCount) { SmsPartResult.PENDING },
            )
        }
        override fun markSubmitted(commandId: String) = change(commandId) { it.copy(phase = SmsExecutionPhase.SUBMITTED) }
        override fun markUnknown(commandId: String, reason: String) = change(commandId) {
            it.copy(phase = SmsExecutionPhase.UNKNOWN, failureReason = reason, terminalAt = "2026-09-09T01:00:00Z")
        }
        override fun markRejected(commandId: String, reason: String) = change(commandId) {
            it.copy(phase = SmsExecutionPhase.FAILED, failureReason = reason, terminalAt = "2026-09-09T01:00:00Z")
        }
        private fun change(id: String, block: (SmsExecutionRecord) -> SmsExecutionRecord) =
            block(requireNotNull(records[id])).also { records[id] = it }
    }
}
