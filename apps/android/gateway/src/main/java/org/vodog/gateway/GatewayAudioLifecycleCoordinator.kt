package org.vodog.gateway

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.telecom.TelecomManager
import android.util.Log
import androidx.core.content.ContextCompat
import org.vodog.gateway.media.GatewayDataChannelTransport
import org.vodog.gateway.media.GatewayMediaHttpException
import org.vodog.gateway.media.HttpGatewayMediaSignaling
import org.vodog.gateway.media.IceTransport
import org.vodog.gateway.media.MediaCaptureRequest
import org.vodog.gateway.media.MediaTransportMemory
import org.vodog.gateway.media.OpusPlayoutProfile
import org.vodog.gateway.media.parseCaptureBinding
import org.vodog.gateway.media.retryMediaNodePending
import java.io.Closeable
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class AudioLifecycleRecovery(val recoveredRecordings: Int, val handoffRestored: Boolean, val muteRestored: Boolean)

/** Process owner for the single exact cellular media session. */
internal object GatewayActiveAudioSession {
    data class Holder(
        val serverCallId: String,
        val deviceCallId: String,
        val creationTimeMillis: Long,
        val ingress: GatewayAudioPacketIngress,
        val session: GatewayAudioMediaSession,
        val failed: AtomicBoolean = AtomicBoolean(false),
        /** S56: false while an early-media leg waits for ACTIVE; [earlyStartedMs] is its setup start. */
        val armed: AtomicBoolean = AtomicBoolean(true),
        val earlyStartedMs: Long = 0L,
    ) {
        /** S73b: the session's fatal code, for `media.hangup_after_failure`. */
        @Volatile var failureCode: String? = null
    }
    private var holder: Holder? = null
    @Synchronized fun current(): Holder? = holder
    @Synchronized fun install(value: Holder) { check(holder == null); holder = value }
    @Synchronized fun requestEndpointIngressStop(deviceCallId: String, creationTimeMillis: Long): Boolean {
        val value = holder ?: return false
        if (!sameCallIdentity(value.deviceCallId, value.creationTimeMillis, deviceCallId, creationTimeMillis)) return false
        value.session.requestTerminalState("ended")
        value.ingress.detach()
        value.session.requestIngressStop()
        return true
    }
    @Synchronized fun requestAllIngressStop() {
        holder?.ingress?.detach()
        holder?.session?.requestIngressStop()
    }
    fun stop(terminalState: String): Boolean {
        val value = synchronized(this) { holder } ?: return true
        value.ingress.detach()
        val stopped = runCatching { value.session.stop(terminalState) }.getOrDefault(false)
        if (stopped) synchronized(this) { if (holder === value) holder = null }
        return stopped
    }
}

class GatewayAudioLifecycleCoordinator(private val context: Context) {
    private val runtime = GatewayRuntimeStore(context)
    private val recoveryComplete = AtomicBoolean(false)
    private val recoveryHealthy = AtomicBoolean(false)
    private val cleanup = object : GatewayAudioSessionCleanup {
        override fun stopAndRelease() = GatewayActiveAudioSession.stop("incomplete")
        override fun restorePreSessionMuteState() = restorePersistedMuteLease(context)
    }
    private val handoff = LegacyAudioOwnerHandoff(
        DeviceProtectedAudioHandoffJournal(context), AndroidLegacyComponentBackend(context), cleanup, ::noActiveCall,
    )

    suspend fun recoverStartup(): AudioLifecycleRecovery = LIFECYCLE_MUTEX.withLock {
        val recordingRecovery = runCatching { GatewayRecordingStore(context).recoverIncomplete().size }
        val recordings = recordingRecovery.getOrDefault(0)
        val handoffRecord = runCatching { DeviceProtectedAudioHandoffJournal(context).read() }.getOrNull()
        val restored = if (handoffRecord?.phase == AudioHandoffPhase.IDLE) true else {
            runCatching { handoff.recoverAfterProcessStart() is AudioHandoffResult.Restored }.getOrDefault(false)
        }
        val mute = if (handoffRecord?.phase == AudioHandoffPhase.IDLE) {
            runCatching { restorePersistedMuteLease(context) }.getOrDefault(false)
        } else restored
        recoveryHealthy.set(recordingRecovery.isSuccess && restored && mute)
        recoveryComplete.set(true)
        AudioLifecycleRecovery(recordings, restored, mute)
    }

    fun preflightReady(): Boolean = audioPreflightAllowed(
        runtime.enabled,
        GatewayCallExecutionApproval.READY,
        GatewayAudioMediaSessionApproval.APPROVED,
        recoveryComplete.get() && recoveryHealthy.get(),
        AndroidLegacyComponentBackend(context).canChangeComponents(),
        DeviceStatusReader(context).hasPrivilegedTelephonyPermissions(),
    )

    /** Stable capability input: an active call is allowed after the idle handoff was acquired. */
    fun handoffPrepared(): Boolean = runCatching {
        preflightReady() && DeviceProtectedAudioHandoffJournal(context).read().phase == AudioHandoffPhase.ACQUIRED
    }.getOrDefault(false)

    internal fun hasExactActiveCall(): Boolean = exactActiveCall() != null

    /** Only an exact server-bound Telecom call may preserve an already-advertised capability while
     * reachability refreshes. Unrelated local calls never qualify. */
    internal fun hasExactNonTerminalCall(): Boolean = exactNonTerminalCall() != null

    /**
     * Any non-terminal local call, exact or not. Decision 2 (S18): while a call exists, media
     * readiness is never withdrawn, because the Telecom snapshot - not a reachability refresh - is
     * the authority that ends calls.
     */
    internal fun hasAnyNonTerminalCall(): Boolean = runCatching {
        DeviceCallJournal(context).recordsForSnapshot().any {
            it.state != DeviceCallState.ENDED && it.state != DeviceCallState.UNKNOWN
        } || GatewayTelecomCallRegistry.deviceCallIds().any { id ->
            GatewayTelecomCallRegistry.snapshot(id)?.state
                ?.let { it != ActualTelecomState.DISCONNECTED && it != ActualTelecomState.UNKNOWN } == true
        }
    }.getOrDefault(false)

    suspend fun prepareIdleHandoff(): Boolean {
        // Media setup deliberately holds this mutex across negotiation. Heartbeat must never wait
        // behind it before retrieving a hangup command; a later idle pass can acquire ownership.
        if (!LIFECYCLE_MUTEX.tryLock()) return handoffPrepared()
        return try {
            if (!preflightReady() || !noActiveCall()) return false
            when (DeviceProtectedAudioHandoffJournal(context).read().phase) {
            AudioHandoffPhase.ACQUIRED -> true
            AudioHandoffPhase.IDLE -> handoff.acquire() is AudioHandoffResult.Acquired
            else -> false
            }
        } finally {
            LIFECYCLE_MUTEX.unlock()
        }
    }

    internal suspend fun reconcile(
        deviceToken: String,
        setupOwner: GatewayMediaSetupOwner,
        probeReadiness: org.vodog.gateway.media.GatewayProbeReadinessProvider,
        api: GatewayApi,
    ): Unit = LIFECYCLE_MUTEX.withLock {
        if (!preflightReady()) return@withLock
        val current = GatewayActiveAudioSession.current()
        if (current?.failed?.get() == true) {
            val armed = current.armed.get()
            stopFailedLeg(armed)
            if (armed) hangUpAfterMediaFailure(current.deviceCallId, current.serverCallId, current.failureCode ?: "session_failed")
            return@withLock
        }
        val answered = exactActiveCall()
        // S56: the flag only gates new legs, so turning it off lets an in-flight early leg reach hangup.
        val active = answered ?: (if (current?.armed?.get() == false || runtime.earlyMedia) exactEarlyCall() else null)
        if (active == null) {
            if (current != null) stopAndRestoreNow("ended")
            return@withLock
        }
        if (current != null) {
            if (current.serverCallId != active.serverCallId || current.deviceCallId != active.deviceCallId ||
                current.creationTimeMillis != active.creationTimeMillis) stopFailedLeg(current.armed.get())
            else if (answered != null && current.armed.compareAndSet(false, true)) armEarlySession(current, api)
            return@withLock
        }
        val early = answered == null
        if (DeviceProtectedAudioHandoffJournal(context).read().phase != AudioHandoffPhase.ACQUIRED) return@withLock
        if (early && !GatewayEarlyMediaAttempt.claim(requireNotNull(active.serverCallId))) return@withLock
        val staged = StagedCloseables()
        var signaling: HttpGatewayMediaSignaling? = null
        var stage = "signaling"
        val setupStartedMs = android.os.SystemClock.elapsedRealtime()
        val playoutProfile = mediaPlayoutProfile(active.answeredByAi)
        // S24 decision 1: the probe generation is only a memory key here. A failure to read it must
        // never block setup - signaling re-reads it under its own fence a moment later - but a
        // cancelled scope still owns this coroutine's death and must not be swallowed.
        val networkGeneration = try {
            probeReadiness.ensureCurrent().networkGeneration
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
        val plannedTransport = mediaPlannedTransport(active.answeredByAi, MediaTransportMemory.INSTANCE.preferred(networkGeneration))
        Log.i(MEDIA_LOG_TAG, "setup_begin call=${active.serverCallId?.take(8)} answeredByAi=${active.answeredByAi}" +
            " playoutDelayMs=${playoutProfile.delayMs} transport=${plannedTransport.wireValue}")
        try {
            val ownedSignaling = HttpGatewayMediaSignaling(
                context,
                deviceToken,
                captureRequest = if (GatewayRecordingArchiveApproval.APPROVED && !early) MediaCaptureRequest(
                    active.deviceCallId,
                    requireNotNull(active.creationTimeMillis),
                ) else null,
                probeReadiness = probeReadiness,
            )
            signaling = ownedSignaling
            stage = "owner_register"
            if (!setupOwner.register(ownedSignaling)) {
                stopFailedLeg(!early)
                return@withLock
            }
            val ingress = GatewayAudioPacketIngress()
            stage = "data_channel_connect"
            val channel = GatewayDataChannelTransport.connect(
                context, requireNotNull(active.serverCallId), ownedSignaling, ingress, plannedTransport,
            ) { from, to, reason ->
                Log.w(MEDIA_LOG_TAG, "transport_fallback call=${active.serverCallId?.take(8)}" +
                    " from=${from.wireValue} to=${to.wireValue} reason=$reason")
                GatewayDiag.log("media.transport_fallback", mapOf("from" to from.wireValue, "to" to to.wireValue,
                    "reason" to reason.toString()), callId = active.serverCallId, level = "warn")
            }
            val transport = staged.own(DataChannelAudioSessionTransport(channel))
            // S25 决策 7: an AI leg's TLS-first outcome must not steer the next human call, which
            // keeps UDP-first for latency; only human legs teach the per-network memory.
            // S73b: a relay-TURN leg is TLS by force, not by choice; it must not steer the next room.
            if (!active.answeredByAi && !channel.relayTurn) MediaTransportMemory.INSTANCE.remember(networkGeneration, channel.negotiatedTransport)
            Log.i(MEDIA_LOG_TAG, "data_channel_connected call=${active.serverCallId?.take(8)}" +
                " ms=${android.os.SystemClock.elapsedRealtime() - setupStartedMs}" +
                " transport=${channel.negotiatedTransport.wireValue} attempt=${channel.negotiationAttempt}")
            if (!preflightReady() || !sameExactActiveCall(active, exactActiveCall() ?: (if (early) exactEarlyCall() else null))) {
                staged.close(); if (!early) handoff.release(); return@withLock
            }
            stage = "codec"
            val codec = staged.own(AndroidAudioSessionCodec())
            stage = "recorder"
            val recorder = if (early) null else staged.own(
                GatewayRecordingStore(context).recorder(
                    requireNotNull(active.serverCallId),
                    if (GatewayRecordingArchiveApproval.APPROVED) requireNotNull(ownedSignaling.captureBinding) else null,
                ),
            )
            val holderRef = arrayOfNulls<GatewayActiveAudioSession.Holder>(1)
            val prebufferTimeoutMs = mediaPrebufferTimeoutMs(active.answeredByAi)
            // S73: a lost leg re-runs options + offer on a fresh signaling instance (connect closes
            // it) into the same ingress. Never taught to MediaTransportMemory: it is not a first choice.
            val serverCallId = requireNotNull(active.serverCallId)
            val rejoiner = object : MediaLegRejoiner {
                override fun isOffline(error: Throwable): Boolean = defaultNetwork().let { (internet, validated) ->
                    org.vodog.gateway.media.isOfflineRejoinFailure(error, internet, validated)
                }
                // ponytail: 500 ms ConnectivityManager poll, not the service's default-network callback.
                // The first poll always sleeps, so a DNS failure on a network that looks up cannot spin.
                override suspend fun awaitNetwork(budgetMs: Long): Boolean = kotlinx.coroutines.withTimeoutOrNull(budgetMs) {
                    do kotlinx.coroutines.delay(500) while (!defaultNetwork().first)
                    true
                } ?: false
                override suspend fun connect(transport: IceTransport, budgetMs: Long): AudioSessionTransport {
                    val armed = holderRef[0]?.armed?.get() ?: !early
                    val rejoinSignaling = HttpGatewayMediaSignaling(
                        context, deviceToken,
                        captureRequest = if (GatewayRecordingArchiveApproval.APPROVED && armed) MediaCaptureRequest(
                            active.deviceCallId, requireNotNull(active.creationTimeMillis),
                        ) else null,
                        probeReadiness = probeReadiness,
                    )
                    return DataChannelAudioSessionTransport(GatewayDataChannelTransport.connect(
                        context, serverCallId, rejoinSignaling, ingress, transport, fallback = false, budgetMs = budgetMs,
                    ))
                }
            }
            val session = GatewayAudioMediaSession(
                BcpTelephonyAudioEndpoint(context, earlyMedia = early), codec, transport, recorder,
                PersistentGatewayMuteLease(context, active.deviceCallId, requireNotNull(active.creationTimeMillis)),
                onFatal = { code ->
                    holderRef[0]?.failureCode = code
                    holderRef[0]?.failed?.set(true)
                    wakeForReconcile()
                },
                prebufferTimeoutMs = prebufferTimeoutMs,
                playoutProfile = playoutProfile,
                diagCallId = active.serverCallId,
                carrierAudioCodec = { carrierAudioCodecName(GatewayTelecomCallRegistry.call(active.deviceCallId)) },
                rejoiner = rejoiner,
            )
            val holder = GatewayActiveAudioSession.Holder(
                requireNotNull(active.serverCallId), active.deviceCallId, requireNotNull(active.creationTimeMillis), ingress, session,
                armed = AtomicBoolean(!early), earlyStartedMs = setupStartedMs,
            )
            holderRef[0] = holder
            ingress.attach(session)
            // Install before start so a concurrent terminal Telecom callback can stop the exact
            // endpoint; start/ingress-stop are serialized by the session setup lock.
            stage = "owner_transfer"
            if (!setupOwner.transfer(ownedSignaling) { GatewayActiveAudioSession.install(holder) }) {
                staged.close(); stopFailedLeg(!early); return@withLock
            }
            staged.transfer()
            stage = "session_start"
            // Transfer makes the holder visible for terminal cleanup, but permission/OFF/call
            // identity must still be valid immediately before any endpoint or mute work starts.
            if (!preflightReady() || !sameExactActiveCall(active, exactActiveCall() ?: (if (early) exactEarlyCall() else null))) {
                Log.w(MEDIA_LOG_TAG, "setup_failed code=prestart_revoked")
                logSetupFailed("prestart_revoked", active, setupStartedMs, null)
                stopFailedLeg(!early)
                return@withLock
            }
            val start = session.start()
            if (start.isFailure) {
                start.exceptionOrNull()?.let {
                    // The prebuffer window and the answer route are what distinguish "the AI never
                    // reached the room" from "this device could not take the audio over at all".
                    Log.w(
                        MEDIA_LOG_TAG,
                        "setup_failed code=${mediaSetupFailureCode(stage, it)} type=${it.javaClass.simpleName}" +
                            " prebufferMs=$prebufferTimeoutMs answeredByAi=${active.answeredByAi}" +
                            " ms=${android.os.SystemClock.elapsedRealtime() - setupStartedMs}" + mediaSetupFailureDetail(it),
                    )
                    logSetupFailed(mediaSetupFailureCode(stage, it), active, setupStartedMs, prebufferTimeoutMs)
                }
                stopFailedLeg(!early)
                if (!early) hangUpAfterMediaFailure(active.deviceCallId, active.serverCallId,
                    start.exceptionOrNull()?.let { mediaSetupFailureCode(stage, it) } ?: "session_start_failed")
            } else if (early) GatewayDiag.log("media.early_started", emptyMap(), callId = active.serverCallId)
        } catch (error: Exception) {
            Log.w(MEDIA_LOG_TAG, "setup_failed code=${mediaSetupFailureCode(stage, error)} type=${error.javaClass.simpleName}" +
                " ms=${android.os.SystemClock.elapsedRealtime() - setupStartedMs}" + mediaSetupFailureDetail(error))
            logSetupFailed(mediaSetupFailureCode(stage, error), active, setupStartedMs, null)
            // Signaling/codec/recorder construction failure must not strand legacy components off.
            staged.close()
            stopFailedLeg(!early)
            if (!early) hangUpAfterMediaFailure(active.deviceCallId, active.serverCallId, mediaSetupFailureCode(stage, error))
        } finally {
            signaling?.let { owned ->
                setupOwner.clear(owned)
                runCatching(owned::close)
            }
        }
    }

    /**
     * S56 Pixel 网关合同: the one-time ACTIVE arm of an early-media leg. Injection and the watchdog come
     * first; the recorder waits for Control's capture binding, and failing that only loses the archive.
     */
    private suspend fun armEarlySession(holder: GatewayActiveAudioSession.Holder, api: GatewayApi) {
        if (!holder.session.arm()) return
        GatewayDiag.log("media.early_armed", mapOf(
            "earlyMs" to android.os.SystemClock.elapsedRealtime() - holder.earlyStartedMs,
        ), callId = holder.serverCallId)
        try {
            val binding = if (!GatewayRecordingArchiveApproval.APPROVED) null else {
                val capture = MediaCaptureRequest(holder.deviceCallId, holder.creationTimeMillis)
                val json = withContext(Dispatchers.IO) {
                    retryMediaNodePending {
                        try {
                            api.requestCaptureBinding(holder.serverCallId, holder.deviceCallId, holder.creationTimeMillis)
                        } catch (error: GatewayApiHttpError) {
                            // Control's snapshot may lag the ACTIVE transition; reuse the media-setup retry.
                            if (error.status == 409 && error.code != null) {
                                throw GatewayMediaHttpException(error.status, error.code, error.message.orEmpty())
                            }
                            throw error
                        }
                    }
                }
                parseCaptureBinding(json, holder.serverCallId, capture)
            }
            holder.session.attachRecorder { GatewayRecordingStore(context).recorder(holder.serverCallId, binding) }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            GatewayDiag.log("media.early_capture_failed", mapOf(
                "reason" to (error.message ?: error.javaClass.simpleName).take(120),
            ), callId = holder.serverCallId, level = "warn")
        }
    }

    /** S37: this path only had Log.w, which a release build never surfaces. Prod needs a diag row. */
    private fun logSetupFailed(
        code: String,
        active: DeviceCallRecord,
        setupStartedMs: Long,
        prebufferTimeoutMs: Long?,
    ) = GatewayDiag.log(
        "media.session_failed",
        mapOf(
            "code" to code,
            "ms" to android.os.SystemClock.elapsedRealtime() - setupStartedMs,
            "answeredByAi" to active.answeredByAi,
        ) + (prebufferTimeoutMs?.let { mapOf("prebufferMs" to it) } ?: emptyMap()),
        callId = active.serverCallId,
        level = "error",
    )

    internal suspend fun stopAndRestore(terminalState: String): Boolean = LIFECYCLE_MUTEX.withLock {
        stopAndRestoreNow(terminalState)
    }

    /**
     * S56: an early (pre-ACTIVE) leg that fails keeps the handoff. Releasing it mid-call would stop the
     * ACTIVE reconcile at the `phase != ACQUIRED` fence, since the idle handoff only re-acquires with no call.
     */
    private fun stopFailedLeg(armed: Boolean): Boolean =
        if (armed) stopAndRestoreNow("failed") else GatewayActiveAudioSession.stop("failed")

    private fun stopAndRestoreNow(terminalState: String): Boolean {
        val stopped = GatewayActiveAudioSession.stop(terminalState)
        if (!stopped) return false
        val restored = handoff.release() is AudioHandoffResult.Restored
        return restored
    }

    /**
     * S73b: a remote-media call whose leg is gone for good would otherwise stay up on the SIM with
     * nobody on the far end. Runs after [stopFailedLeg], so a Telecom DISCONNECTED cannot upgrade the
     * archive's `failed` terminal to `ended`. Same controller path as Control's HANG_UP; its policy
     * refuses an already ended / disconnecting call, so a racing Control hangup is harmless.
     */
    private suspend fun hangUpAfterMediaFailure(deviceCallId: String, serverCallId: String?, reason: String) {
        val record = runCatching { DeviceCallJournal(context).recordsForSnapshot() }.getOrNull()
            ?.firstOrNull { it.deviceCallId == deviceCallId }
        if (!shouldHangUpAfterMediaFailure(record, armed = true, GatewayTelecomCallRegistry.snapshot(deviceCallId)?.state)) return
        val result = runCatching { AndroidGatewayTelecomController(context).hangUp(deviceCallId) }
            .getOrElse { if (it is kotlinx.coroutines.CancellationException) throw it; TelecomActionResult.Unknown(it.javaClass.simpleName) }
        if (result is TelecomActionResult.Executed) {
            GatewayDiag.localEnd(deviceCallId, serverCallId, "media_terminal_failure", mapOf("reason" to reason))
        }
        GatewayDiag.log("media.hangup_after_failure", mapOf("reason" to reason, "result" to when (result) {
            TelecomActionResult.Executed -> "executed"
            is TelecomActionResult.Rejected -> "rejected:${result.reason}"
            is TelecomActionResult.Unknown -> "unknown:${result.reason}"
        }), callId = serverCallId, level = "warn")
    }

    /** (default network with INTERNET, validated). */
    private fun defaultNetwork(): Pair<Boolean, Boolean> = runCatching {
        val manager = context.getSystemService(android.net.ConnectivityManager::class.java)
        val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return@runCatching false to false
        caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) to
            caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }.getOrDefault(false to false)

    private fun exactActiveCall(): DeviceCallRecord? {
        val records = DeviceCallJournal(context).recordsForSnapshot().filter {
            // S38 §3: a call the user dialled on the Pixel has no remote VoDog party, so it
            // never gets a WebRTC session; GatewayPassiveCallRecorder owns its audio instead.
            it.state == DeviceCallState.ACTIVE && it.serverCallId != null && it.creationTimeMillis != null &&
                needsRemoteMedia(it) &&
                GatewayTelecomCallRegistry.snapshot(it.deviceCallId)?.state == ActualTelecomState.ACTIVE
        }
        return records.singleOrNull()
    }

    private fun exactEarlyCall(): DeviceCallRecord? = DeviceCallJournal(context).recordsForSnapshot().filter {
        isEarlyMediaCall(it, GatewayTelecomCallRegistry.snapshot(it.deviceCallId)?.state)
    }.singleOrNull()

    private fun exactNonTerminalCall(): DeviceCallRecord? {
        return DeviceCallJournal(context).recordsForSnapshot().filter { record ->
            isExactNonTerminalCall(record, GatewayTelecomCallRegistry.snapshot(record.deviceCallId)?.state)
        }.singleOrNull()
    }

    private fun noActiveCall(): Boolean = runCatching {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) !=
            PackageManager.PERMISSION_GRANTED) return@runCatching false
        !context.getSystemService(TelecomManager::class.java).isInCall
    }.getOrDefault(false)

    private fun wakeForReconcile() {
        if (!runtime.enabled) return
        ContextCompat.startForegroundService(context, Intent(context, GatewayForegroundService::class.java)
            .setAction(GatewayForegroundService.ACTION_TELECOM_CHANGED))
    }

    companion object {
        internal val LIFECYCLE_MUTEX = Mutex()
        private const val MEDIA_LOG_TAG = "VoDogMedia"
    }
}

/** S56: one early-media attempt per call; a failed early leg waits for ACTIVE instead of retrying every reconcile. */
internal object GatewayEarlyMediaAttempt {
    private var last: String? = null
    @Synchronized fun claim(serverCallId: String): Boolean {
        if (last == serverCallId) return false
        last = serverCallId
        return true
    }
}

/** Cleanup scope is process-owned and is never cancelled with the foreground heartbeat scope. */
internal object GatewayAudioLifecycleCleanup {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val scheduled = AtomicBoolean(false)

    fun schedule(context: Context, terminalState: String) {
        GatewayActiveAudioSession.requestAllIngressStop()
        if (!scheduled.compareAndSet(false, true)) return
        val appContext = context.applicationContext
        scope.launch {
            try { GatewayAudioLifecycleCoordinator(appContext).stopAndRestore(terminalState) }
            finally { scheduled.set(false) }
        }
    }
}

internal fun sameCallIdentity(
    firstDeviceCallId: String,
    firstCreationTimeMillis: Long,
    secondDeviceCallId: String,
    secondCreationTimeMillis: Long,
) = firstDeviceCallId == secondDeviceCallId && firstCreationTimeMillis == secondCreationTimeMillis

private fun sameExactActiveCall(first: DeviceCallRecord, second: DeviceCallRecord?): Boolean = second != null &&
    first.serverCallId == second.serverCallId && first.deviceCallId == second.deviceCallId &&
    first.creationTimeMillis == second.creationTimeMillis

/**
 * S38 §3: a call dialled on the Pixel has no remote party. S72b: neither has an incoming call answered
 * on the Pixel itself (no Control ANSWER executed) - its audio stays on the phone, so no WebRTC leg,
 * no handoff release on a failed leg and no withdrawn readiness for the rest of the call.
 */
internal fun needsRemoteMedia(record: DeviceCallRecord): Boolean = !record.deviceOriginated &&
    (record.direction != DeviceCallDirection.INCOMING || record.remoteAnswered)

/** S73b: only a live, armed remote-media call is hung up when its media leg fails for good. */
internal fun shouldHangUpAfterMediaFailure(record: DeviceCallRecord?, armed: Boolean, actual: ActualTelecomState?): Boolean =
    armed && record != null && needsRemoteMedia(record) && record.state != DeviceCallState.ENDED &&
        actual in setOf(ActualTelecomState.DIALING, ActualTelecomState.CONNECTING, ActualTelecomState.ACTIVE, ActualTelecomState.HOLDING)

internal fun isExactNonTerminalCall(record: DeviceCallRecord, actual: ActualTelecomState?): Boolean =
    record.serverCallId != null && record.creationTimeMillis != null && !record.deviceOriginated &&
        record.state in setOf(DeviceCallState.RINGING, DeviceCallState.DIALING, DeviceCallState.ACTIVE) &&
        actual in setOf(
            ActualTelecomState.RINGING, ActualTelecomState.DIALING, ActualTelecomState.CONNECTING,
            ActualTelecomState.ACTIVE, ActualTelecomState.HOLDING,
        )

/**
 * S56: a VoDog human outgoing call before ACTIVE. Either side may already read ACTIVE while the
 * other lags one callback, so a live early leg is not torn down across the DIALING→ACTIVE transition.
 */
internal fun isEarlyMediaCall(record: DeviceCallRecord, actual: ActualTelecomState?): Boolean =
    record.direction == DeviceCallDirection.OUTGOING && record.serverCallId != null &&
        record.creationTimeMillis != null && !record.deviceOriginated && !record.answeredByAi &&
        record.state in setOf(DeviceCallState.DIALING, DeviceCallState.RINGING, DeviceCallState.ACTIVE) &&
        actual in setOf(ActualTelecomState.DIALING, ActualTelecomState.CONNECTING, ActualTelecomState.ACTIVE) &&
        !(record.state == DeviceCallState.ACTIVE && actual == ActualTelecomState.ACTIVE)

/**
 * S22 decision 9: an AI-answered call waits longer for its first caller frame than a human one.
 *
 * The route is read from the durable [DeviceCallRecord] the ANSWER wrote, so a process restart
 * between the answer and the media reconcile still selects the right window.
 */
internal fun mediaPrebufferTimeoutMs(answeredByAi: Boolean): Long =
    if (answeredByAi) PREBUFFER_TIMEOUT_AI_MS else PREBUFFER_TIMEOUT_MS

/**
 * S23 decision 1: an AI-answered call plays out through a deeper, later-resyncing buffer than a
 * human one. Same durable [DeviceCallRecord] input as [mediaPrebufferTimeoutMs], so a process
 * restart between the answer and the media reconcile still selects the right shape.
 */
/** S70: Connection.EXTRA_AUDIO_CODEC of the live call as a name; "unknown" when absent. */
internal fun carrierAudioCodecName(call: android.telecom.Call?): String =
    carrierAudioCodecName(call?.details?.extras?.takeIf { it.containsKey(android.telecom.Connection.EXTRA_AUDIO_CODEC) }
        ?.getInt(android.telecom.Connection.EXTRA_AUDIO_CODEC))

internal fun carrierAudioCodecName(code: Int?): String = when (code) {
    null -> "unknown"
    0 -> "none"; 1 -> "amr"; 2 -> "amr_wb"; 3 -> "qcelp13k"; 4 -> "evrc"; 5 -> "evrc_b"; 6 -> "evrc_wb"
    7 -> "evrc_nw"; 8 -> "gsm_efr"; 9 -> "gsm_fr"; 10 -> "gsm_hr"; 11 -> "g711u"; 12 -> "g723"; 13 -> "g711a"
    14 -> "g722"; 15 -> "g711ab"; 16 -> "g729"; 17 -> "evs_nb"; 18 -> "evs_wb"; 19 -> "evs_swb"; 20 -> "evs_fb"
    else -> "code_$code"
}

internal fun mediaPlayoutProfile(answeredByAi: Boolean): OpusPlayoutProfile =
    OpusPlayoutProfile.forAnsweredByAi(answeredByAi)

/**
 * S25 决策 7: an AI-answered call starts on TURN TLS. Its media is one-way AI speech that the S23/S25
 * playout profile (200 ms delay, 64-frame queues) can hold for a few hundred milliseconds, while the
 * Pixel↔node UDP leg lost 8–15% on both the home broadband and 5G (PLC 10–18% on 2026-09-12); TCP
 * turns that loss into ≤224 ms of measured lag (Mac→control-node TLS probe, 1.8% residual). Human calls keep
 * their remembered transport: they are conversational and pay for every millisecond. UDP stays as
 * the AI leg's fallback through the same plan.
 */
internal fun mediaPlannedTransport(answeredByAi: Boolean, remembered: IceTransport): IceTransport =
    // S73b: API relay mode no longer forces TLS. A human room on relay-node gets relay-node's own TURN, where
    // UDP from 4G is the reliable path; only an options `relay: true` grant (control-node via the tunnel) is TLS-only.
    if (answeredByAi) IceTransport.TLS else remembered

/** S22: the HTTP status and Control error code are the only way to tell which side refused the media leg. */
internal fun mediaSetupFailureDetail(error: Throwable): String = when (error) {
    is org.vodog.gateway.media.GatewayMediaHttpException ->
        " http=${error.status} code=${error.code} message=${error.message.take(160).replace('\n', ' ')}"
    else -> error.message?.let { " message=${it.take(160).replace('\n', ' ')}" } ?: ""
}

internal fun mediaSetupFailureCode(stage: String, error: Throwable): String = when {
    stage == "session_start" && error is TimeoutException -> "prebuffer_timeout"
    stage == "session_start" && error.message == "valid caller audio prebuffer unavailable" -> "prebuffer_unavailable"
    stage == "session_start" && error.message == "audio media session not approved" -> "approval_revoked"
    stage == "session_start" && error.message == "failed to acquire mute lease" -> "mute_acquire_failed"
    stage == "session_start" && error.message?.contains("stopped") == true -> "session_cancelled"
    stage in setOf("signaling", "owner_register", "data_channel_connect", "codec", "recorder", "owner_transfer", "session_start") -> "${stage}_failed"
    else -> "media_setup_failed"
}

internal class StagedCloseables {
    private val owned = ArrayDeque<Closeable>()
    private var transferred = false
    fun <T : Closeable> own(value: T): T = value.also {
        check(!transferred) { "resource ownership already transferred" }
        owned.addFirst(it)
    }
    fun transfer() { check(!transferred); transferred = true; owned.clear() }
    fun close() {
        if (transferred) return
        while (owned.isNotEmpty()) runCatching { owned.removeFirst().close() }
    }
}

internal fun audioPreflightAllowed(
    runtimeEnabled: Boolean,
    callExecutionApproved: Boolean,
    mediaSessionApproved: Boolean,
    recoveryHealthy: Boolean,
    componentPermission: Boolean,
    telephonyPermissions: Boolean,
): Boolean = runtimeEnabled && callExecutionApproved && mediaSessionApproved && recoveryHealthy &&
    componentPermission && telephonyPermissions
