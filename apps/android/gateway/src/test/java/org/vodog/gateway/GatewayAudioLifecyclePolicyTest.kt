package org.vodog.gateway

import org.vodog.gateway.media.IceTransport
import org.vodog.gateway.media.MediaCaptureRequest
import org.vodog.gateway.media.optionsCaptureBinding
import org.vodog.gateway.media.OpusPlayoutProfile
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.json.JSONObject
import org.junit.Test
import java.io.Closeable
import java.util.concurrent.TimeoutException

class GatewayAudioLifecyclePolicyTest {
    @Test fun disabledControlCannotAcquireHandoffOrStartMedia() {
        assertFalse(audioPreflightAllowed(
            runtimeEnabled = false,
            callExecutionApproved = true,
            mediaSessionApproved = true,
            recoveryHealthy = true,
            componentPermission = true,
            telephonyPermissions = true,
        ))
    }

    @Test fun everySafetyFenceMustPassBeforeAudioPreflight() {
        val ready = booleanArrayOf(true, true, true, true, true, true)
        assertTrue(allowed(ready))
        for (index in ready.indices) {
            val denied = ready.copyOf().also { it[index] = false }
            assertFalse("fence $index", allowed(denied))
        }
    }

    @Test fun muteCallbackOnlyCompletesTheMatchingRequestedTransition() {
        val requesting = MuteLeaseRecord(MuteLeasePhase.REQUESTING_MUTE, "lease", "call", 7, false)
        assertTrue(muteStateAfterAudioCallback(requesting, true).phase == MuteLeasePhase.MUTED)
        assertTrue(muteStateAfterAudioCallback(requesting, false) == requesting)
        val restoring = requesting.copy(phase = MuteLeasePhase.RESTORING)
        assertTrue(muteStateAfterAudioCallback(restoring, false).phase == MuteLeasePhase.IDLE)
        assertTrue(muteStateAfterAudioCallback(restoring, true) == restoring)
        assertTrue(sameMuteLease(requesting, restoring))
        assertFalse(sameMuteLease(requesting, restoring.copy(leaseId = "other")))
    }

    @Test fun timedOutPostedMutationCannotStartLater() {
        val fence = PostedMutationFence()
        assertTrue(fence.cancelBeforeStart())
        assertFalse(fence.tryStart())
        assertFalse(fence.isDone())
    }

    @Test fun exactCallIdentityPreventsAnUnrelatedTerminalCallFromStoppingPrimaryMedia() {
        assertTrue(sameCallIdentity("primary", 100, "primary", 100))
        assertFalse(sameCallIdentity("primary", 100, "waiting", 200))
        assertFalse(sameCallIdentity("primary", 100, "primary", 101))
        assertFalse(hasUnrelatedLiveCall(
            listOf(TelecomCallSnapshot("primary", ActualTelecomState.ACTIVE, null)), "primary",
        ))
        assertTrue(hasUnrelatedLiveCall(
            listOf(
                TelecomCallSnapshot("primary", ActualTelecomState.ACTIVE, null),
                TelecomCallSnapshot("waiting", ActualTelecomState.RINGING, null),
            ),
            "primary",
        ))
    }

    @Test fun stagedConstructionCleanupClosesEveryOwnedResourceInReverseOrder() {
        val events = mutableListOf<String>()
        val staged = StagedCloseables()
        staged.own(TestCloseable("transport", events))
        staged.own(TestCloseable("codec", events, throws = true))
        staged.own(TestCloseable("recorder", events))
        staged.close()
        assertTrue(events == listOf("recorder", "codec", "transport"))
    }

    @Test fun onlyExactServerBoundNonterminalCallCanPreserveMediaReadiness() {
        val exact = DeviceCallRecord(
            deviceCallId = "device", phoneAccountHandle = null, creationTimeMillis = 123,
            direction = DeviceCallDirection.OUTGOING, state = DeviceCallState.DIALING,
            observedAt = "2026-09-10T00:00:00Z", remoteNumber = null, incomingEventId = null,
            incomingPayload = null, incomingReported = false, serverCallId = "server",
        )
        assertTrue(isExactNonTerminalCall(exact, ActualTelecomState.CONNECTING))
        assertTrue(isExactNonTerminalCall(exact.copy(state = DeviceCallState.ACTIVE), ActualTelecomState.ACTIVE))
        assertFalse(isExactNonTerminalCall(exact.copy(serverCallId = null), ActualTelecomState.ACTIVE))
        assertFalse(isExactNonTerminalCall(exact.copy(state = DeviceCallState.ENDED), ActualTelecomState.ACTIVE))
        assertFalse(isExactNonTerminalCall(exact, ActualTelecomState.DISCONNECTED))
        assertFalse(isExactNonTerminalCall(exact, null))
    }

    @Test fun earlyMediaSelectsOnlyAServerBoundHumanOutgoingCallBeforeActive() {
        val dialing = DeviceCallRecord(
            deviceCallId = "device", phoneAccountHandle = null, creationTimeMillis = 123,
            direction = DeviceCallDirection.OUTGOING, state = DeviceCallState.DIALING,
            observedAt = "2026-09-24T00:00:00Z", remoteNumber = null, incomingEventId = null,
            incomingPayload = null, incomingReported = false, serverCallId = "server",
        )
        assertTrue(isEarlyMediaCall(dialing, ActualTelecomState.DIALING))
        assertTrue(isEarlyMediaCall(dialing, ActualTelecomState.CONNECTING))
        assertTrue(isEarlyMediaCall(dialing.copy(state = DeviceCallState.RINGING), ActualTelecomState.DIALING))
        // One side already ACTIVE: the same early leg survives until both agree, then exactActiveCall owns it.
        assertTrue(isEarlyMediaCall(dialing, ActualTelecomState.ACTIVE))
        assertTrue(isEarlyMediaCall(dialing.copy(state = DeviceCallState.ACTIVE), ActualTelecomState.DIALING))
        assertFalse(isEarlyMediaCall(dialing.copy(state = DeviceCallState.ACTIVE), ActualTelecomState.ACTIVE))
        assertFalse(isEarlyMediaCall(dialing.copy(direction = DeviceCallDirection.INCOMING), ActualTelecomState.DIALING))
        assertFalse(isEarlyMediaCall(dialing.copy(answeredByAi = true), ActualTelecomState.DIALING))
        assertFalse(isEarlyMediaCall(dialing.copy(deviceOriginated = true), ActualTelecomState.DIALING))
        assertFalse(isEarlyMediaCall(dialing.copy(serverCallId = null), ActualTelecomState.DIALING))
        assertFalse(isEarlyMediaCall(dialing.copy(creationTimeMillis = null), ActualTelecomState.DIALING))
        assertFalse(isEarlyMediaCall(dialing, ActualTelecomState.DISCONNECTED))
        assertFalse(isEarlyMediaCall(dialing, ActualTelecomState.HOLDING))
        assertFalse(isEarlyMediaCall(dialing, null))
    }

    @Test fun eachCallGetsOneEarlyMediaAttempt() {
        assertTrue(GatewayEarlyMediaAttempt.claim("s56-call-a"))
        assertFalse(GatewayEarlyMediaAttempt.claim("s56-call-a")) // A failed early leg does not retry while ringing.
        assertTrue(GatewayEarlyMediaAttempt.claim("s56-call-b"))
    }

    @Test fun zeroPcmWatchdogArmsAtActiveOnlyWhenEarlyCaptureNeverHeardAudio() {
        assertTrue(zeroPcmWatchdogAtArm(heardAudio = true) == null)
        val fresh = requireNotNull(zeroPcmWatchdogAtArm(heardAudio = false))
        assertTrue(fresh.onRead(allZero = true, durationMs = 2_999).action == ZeroPcmAction.NONE)
        assertTrue(fresh.onRead(allZero = true, durationMs = 1).action == ZeroPcmAction.RESTART)
    }

    @Test fun earlyMediaKeepsTheMicrophoneForegroundForAnOutgoingDialOnlyWhenTheFlagIsOn() {
        val states = listOf(android.telecom.Call.STATE_ACTIVE, android.telecom.Call.STATE_HOLDING)
        states.forEach { assertTrue(recordingForegroundNeeded(it, outgoing = false, earlyMedia = false)) }
        val dialing = listOf(android.telecom.Call.STATE_DIALING, android.telecom.Call.STATE_CONNECTING)
        dialing.forEach {
            assertTrue(recordingForegroundNeeded(it, outgoing = true, earlyMedia = true))
            assertFalse(recordingForegroundNeeded(it, outgoing = true, earlyMedia = false))
            assertFalse(recordingForegroundNeeded(it, outgoing = false, earlyMedia = true))
        }
        assertFalse(recordingForegroundNeeded(android.telecom.Call.STATE_RINGING, outgoing = false, earlyMedia = true))
    }

    @Test fun optionsWithoutCaptureNeedNoBindingButRequestedCaptureStillDoes() {
        val noBinding = JSONObject().put("iceTransportPolicy", "relay")
        assertTrue(optionsCaptureBinding(noBinding, "call", null) == null)
        assertTrue(runCatching { optionsCaptureBinding(noBinding, "call", MediaCaptureRequest("device", 123)) }.isFailure)
    }

    @Test fun humanCallsWaitOutTheRemoteClientIceBudgetWhileAiCallsKeepTheShortWindow() {
        // S37 (2026-09-17): the remote client may spend 12 s gathering on UDP, an options
        // round-trip, then up to 12 s on the TLS fallback before its first packet - ~26 s measured.
        // The gateway leg often connects first, and it only gets one attempt per call (the recording
        // directory is single-shot), so its window must outlast that budget, not 3 s of it.
        assertTrue(mediaPrebufferTimeoutMs(answeredByAi = false) >= 30_000L)
        assertTrue(clampPrebufferTimeoutMs(mediaPrebufferTimeoutMs(answeredByAi = false)) >= 30_000L)
        assertTrue(mediaPrebufferTimeoutMs(answeredByAi = true) == PREBUFFER_TIMEOUT_AI_MS)
        assertTrue(mediaPrebufferTimeoutMs(answeredByAi = true) == 8_000L)
        assertTrue(mediaPrebufferTimeoutMs(answeredByAi = false) == PREBUFFER_TIMEOUT_MS)
        // The durable record the media reconcile reads is the only input to that choice.
        val record = DeviceCallRecord(
            deviceCallId = "device", phoneAccountHandle = null, creationTimeMillis = 123,
            direction = DeviceCallDirection.INCOMING, state = DeviceCallState.ACTIVE,
            observedAt = "2026-09-11T00:00:00Z", remoteNumber = null, incomingEventId = null,
            incomingPayload = null, incomingReported = true, serverCallId = "server",
        )
        assertFalse(record.answeredByAi)
        assertTrue(mediaPrebufferTimeoutMs(record.answeredByAi) == PREBUFFER_TIMEOUT_MS)
        assertTrue(mediaPrebufferTimeoutMs(record.copy(answeredByAi = true).answeredByAi) == 8_000L)
    }

    @Test fun incomingCallAnsweredOnThePixelNeverGetsARemoteMediaLeg() {
        val incoming = DeviceCallRecord(
            deviceCallId = "device", phoneAccountHandle = null, creationTimeMillis = 123,
            direction = DeviceCallDirection.INCOMING, state = DeviceCallState.ACTIVE,
            observedAt = "2026-09-26T00:00:00Z", remoteNumber = null, incomingEventId = null,
            incomingPayload = null, incomingReported = true, serverCallId = "server",
        )
        assertFalse(needsRemoteMedia(incoming))
        assertTrue(needsRemoteMedia(incoming.copy(remoteAnswered = true)))
        assertTrue(needsRemoteMedia(incoming.copy(remoteAnswered = true, answeredByAi = true)))
        val outgoing = incoming.copy(direction = DeviceCallDirection.OUTGOING)
        assertTrue(needsRemoteMedia(outgoing))
        assertFalse(needsRemoteMedia(outgoing.copy(deviceOriginated = true)))
        val legacy = incoming.toJson().apply { remove("remoteAnswered") }.toRecord()
        assertTrue(needsRemoteMedia(legacy))
    }

    @Test fun terminalMediaFailureHangsUpOnlyLiveArmedRemoteMediaCalls() {
        val incoming = DeviceCallRecord(
            deviceCallId = "device", phoneAccountHandle = null, creationTimeMillis = 123,
            direction = DeviceCallDirection.INCOMING, state = DeviceCallState.ACTIVE,
            observedAt = "2026-09-26T00:00:00Z", remoteNumber = null, incomingEventId = null,
            incomingPayload = null, incomingReported = true, serverCallId = "server", remoteAnswered = true,
        )
        val outgoing = incoming.copy(direction = DeviceCallDirection.OUTGOING, remoteAnswered = false)
        val live = ActualTelecomState.ACTIVE
        assertTrue(shouldHangUpAfterMediaFailure(incoming, armed = true, live))
        assertTrue(shouldHangUpAfterMediaFailure(outgoing, armed = true, live))
        assertTrue(shouldHangUpAfterMediaFailure(outgoing, armed = true, ActualTelecomState.HOLDING))
        // Answered on the Pixel / dialled on the Pixel: its audio never depended on the leg.
        assertFalse(shouldHangUpAfterMediaFailure(incoming.copy(remoteAnswered = false), armed = true, live))
        assertFalse(shouldHangUpAfterMediaFailure(outgoing.copy(deviceOriginated = true), armed = true, live))
        // S56 unarmed early leg waits for ACTIVE instead.
        assertFalse(shouldHangUpAfterMediaFailure(outgoing, armed = false, ActualTelecomState.DIALING))
        // Already ended, or a hangup (Control's or ours) already in progress.
        assertFalse(shouldHangUpAfterMediaFailure(outgoing.copy(state = DeviceCallState.ENDED), armed = true, live))
        assertFalse(shouldHangUpAfterMediaFailure(outgoing, armed = true, ActualTelecomState.DISCONNECTING))
        assertFalse(shouldHangUpAfterMediaFailure(outgoing, armed = true, ActualTelecomState.DISCONNECTED))
        assertFalse(shouldHangUpAfterMediaFailure(outgoing, armed = true, null))
        assertFalse(shouldHangUpAfterMediaFailure(null, armed = true, live))
    }

    @Test fun aiAnsweredCallsStartOnTlsWhileHumanCallsKeepTheRememberedTransport() {
        // S25 决策 7: the AI leg ignores the per-network memory in both directions.
        assertTrue(mediaPlannedTransport(answeredByAi = true, remembered = IceTransport.UDP) == IceTransport.TLS)
        assertTrue(mediaPlannedTransport(answeredByAi = true, remembered = IceTransport.TLS) == IceTransport.TLS)
        assertTrue(mediaPlannedTransport(answeredByAi = false, remembered = IceTransport.UDP) == IceTransport.UDP)
        assertTrue(mediaPlannedTransport(answeredByAi = false, remembered = IceTransport.TLS) == IceTransport.TLS)
    }

    @Test fun aiAnsweredCallsPlayOutThroughTheDeeperBufferThanHumanOnes() {
        // S23 decision 1. Same durable input as the prebuffer window above.
        assertTrue(mediaPlayoutProfile(answeredByAi = true) == OpusPlayoutProfile.AI)
        assertTrue(mediaPlayoutProfile(answeredByAi = true).delayUs == 200_000L)
        assertTrue(mediaPlayoutProfile(answeredByAi = true).maxPackets == 85) // S70c: T + 1 s forced threshold + 500 ms burst
        assertTrue(mediaPlayoutProfile(answeredByAi = true).forcedCatchUpUs == 1_000_000L)
        assertTrue(!mediaPlayoutProfile(answeredByAi = true).trimSetupBacklog)
        assertTrue(mediaPlayoutProfile(answeredByAi = true).maxSpanUs == 1_700_000L)
        assertTrue(mediaPlayoutProfile(answeredByAi = true).resyncUs == 400_000L)
        assertTrue(mediaPlayoutProfile(answeredByAi = false) == OpusPlayoutProfile.HUMAN)
        assertTrue(mediaPlayoutProfile(answeredByAi = false).delayUs == 60_000L)
        assertTrue(mediaPlayoutProfile(answeredByAi = false).maxPackets == 53)
        assertTrue(mediaPlayoutProfile(answeredByAi = false).maxSpanUs == 1_060_000L)
        assertTrue(mediaPlayoutProfile(answeredByAi = false).resyncUs == 200_000L)
    }

    @Test fun mediaSetupDiagnosticsExposeOnlyBoundedFailureCodes() {
        assertTrue(mediaSetupFailureCode("session_start", TimeoutException()) == "prebuffer_timeout")
        assertTrue(mediaSetupFailureCode("session_start", IllegalStateException("valid caller audio prebuffer unavailable")) == "prebuffer_unavailable")
        // S37: a hangup during the long prebuffer window is a cancellation, not a missing remote leg.
        assertTrue(mediaSetupFailureCode("session_start", IllegalStateException("audio media session stopped during prebuffer")) == "session_cancelled")
        assertTrue(mediaSetupFailureCode("data_channel_connect", IllegalStateException("secret detail")) == "data_channel_connect_failed")
        assertTrue(mediaSetupFailureCode("unexpected", IllegalStateException("secret detail")) == "media_setup_failed")
    }

    private fun allowed(values: BooleanArray) = audioPreflightAllowed(
        runtimeEnabled = values[0],
        callExecutionApproved = values[1],
        mediaSessionApproved = values[2],
        recoveryHealthy = values[3],
        componentPermission = values[4],
        telephonyPermissions = values[5],
    )
}


private class TestCloseable(
    private val name: String,
    private val events: MutableList<String>,
    private val throws: Boolean = false,
) : Closeable {
    override fun close() {
        events += name
        if (throws) error("close failed")
    }
}
