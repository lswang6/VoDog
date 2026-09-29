package org.vodog

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioDeviceInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import java.io.Closeable
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * One relay-only WebRTC audio session for the process.
 *
 * Budgets are **sequential, not nested**: gathering is capped by
 * [CallMediaRelayGatheringPolicy.CAP_MS], the offer POST by [OFFER_TIMEOUT_MS] and the ICE connect
 * by [CallMediaIceWaitPolicy.CONNECT_TIMEOUT_MS]. The single 20 s budget this replaced could be
 * burned entirely by slow gathering, so the offer was never posted at all.
 */
class AndroidCallMediaSession(
    context: Context,
    private val api: ClientApi,
    publish: (CallMediaUiState) -> Unit,
    private val onTerminalFailure: (String, CallMediaTransport, Throwable) -> Unit = { _, _, _ -> },
) : Closeable {
    private val applicationContext = context.applicationContext
    @Volatile private var resources: MediaResources? = null
    // S36b D1: 每次音频状态变化顺手喂给诊断，`client.snapshot` 才知道快照当时是不是在通话里。
    private val stateMachine = CallMediaStateMachine(
        cleanup = ::cleanupResources,
        publish = { state ->
            ClientDiag.noteMedia(state.callId, state.phase.name)
            publish(state)
        },
    )
    private val probeGeneration = AndroidMediaProbeGeneration(applicationContext)
    private val legacyProbes = MediaProbeCoordinator(api, probeGeneration, HttpsMediaProbeRunner())
    @Volatile private var probeSessionIdentity: ServiceSessionIdentity? = null
    private val probes = RelayQualityProbeCoordinator(
        legacyProbes,
        api,
        probeGeneration,
        AndroidRelayProbeRunner(applicationContext),
        sessionRemainsCurrent = {
            probeSessionIdentity?.let { serviceIdentityMatches(it, currentServiceIdentity(applicationContext)) } == true
        },
    )
    private val sessionScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Assigned and cancelled from the WebRTC observer thread or the grace job itself. */
    @Volatile private var disconnectGraceJob: Job? = null

    /** S73 D8: legs rejoined since the last [connect]; reported in every `media.summary`. */
    private val rejoins = AtomicInteger(0)
    /** S73b: `relay` of the last media-options response; a rejoin stays TLS-only iff it was true. */
    @Volatile private var lastOptionsRelay = false

    private class Attempt(val token: Long, val error: Throwable?)

    /**
     * Runs the handshake, publishing exactly one terminal FAILED state. An automatic UDP attempt
     * that fails for a relay-path reason gets one TLS attempt before the UI ever sees FAILED, so
     * the controls do not flash between the two tries; an explicit TLS request stays TLS-only.
     */
    suspend fun connect(callId: String, requested: CallMediaTransport = CallMediaTransport.UDP): Unit =
        withContext(Dispatchers.IO) {
            // S73b：蜂窝也先走 UDP（国内 4G 到 relay-node 的 TLS 不稳）；中转 TURN 只在 TLS 请求且房间在中转节点时由
            // Control 返回（响应 relay:true），UDP 失败后的 TLS 回退自然拿到它。
            val transport = requested
            rejoins.set(0)
            lastOptionsRelay = false
            val first = runAttempt(callId, transport)
            val firstError = first.error ?: return@withContext
            // Only the attempt that is still current may escalate; a superseded one must not steal
            // the session back from whatever replaced it.
            if (transport == CallMediaTransport.UDP && stateMachine.isCurrent(first.token) &&
                CallMediaRetryPolicy.shouldRetryTls(firstError)
            ) {
                val second = runAttempt(callId, CallMediaTransport.TLS)
                val secondError = second.error ?: return@withContext
                finishSetup(second.token, callId, transport, CallMediaTransport.TLS, secondError)
                return@withContext
            }
            finishSetup(first.token, callId, transport, transport, firstError)
        }

    /**
     * The first connect failed. While offline (iOS prod 919e1740: network dropped mid-`checking`, back
     * 16 s later, call ended by grace) it waits for the network through the S73 rejoin loop, inline so
     * [connect] still returns CONNECTED or FAILED to its caller; attempt 1 uses UDP (S73h; TLS in relay mode).
     * Online failures take today's terminal path.
     */
    private suspend fun finishSetup(
        token: Long,
        callId: String,
        requested: CallMediaTransport,
        failed: CallMediaTransport,
        error: Throwable,
    ) {
        // Audio focus / bad options / bad answer are not network failures even when offline.
        val offline = stateMachine.isCurrent(token) &&
            (error !is CallMediaSessionException || CallMediaRetryPolicy.shouldRetryTls(error.kind)) &&
            defaultNetwork().let { (internet, validated) ->
            CallMediaRejoinPolicy.isOffline(error, internet, validated)
        }
        if (offline) rejoinLoop(token, callId, requested, CallMediaRejoinPolicy.SETUP_OFFLINE_REASON, monotonicMs())
        else reportTerminal(token, callId, failed, error)
    }

    private suspend fun runAttempt(callId: String, transport: CallMediaTransport): Attempt {
        val token = stateMachine.begin(callId, transport)
        return try {
            runHandshake(token, callId, transport)
            Attempt(token, null)
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            Attempt(token, error)
        }
    }

    /**
     * S73d: a [rejoin] skips the media-node probe. The room's node is already fixed server-side
     * (Control `authorizeUserMedia` → `selectMediaNode(call.media_node_id)`), and a probe right after the
     * network returns fails on the generation change, wasting the attempt (iOS: ~43 s recovery).
     */
    private suspend fun runHandshake(token: Long, callId: String, transport: CallMediaTransport, rejoin: Boolean = false) {
        probeSessionIdentity = currentServiceIdentity(applicationContext)
            ?: throw CallMediaStaleAttempt("登录状态已变化")
        val networkGeneration = if (rejoin) probeGeneration.current() else try {
            probes.ensureCurrent()
        } catch (error: Throwable) {
            if (error is CancellationException || error is ApiError) throw error
            throw CallMediaProbeException(error)
        }
        ensureCurrent(token)
        val optionsStartedAt = System.nanoTime()
        val options = try {
            api.mediaOptions(callId, transport, networkGeneration)
        } catch (invalid: IllegalArgumentException) {
            throw CallMediaSessionException(CallMediaFailureKind.INVALID_RELAY_OPTIONS, transport)
        }
        lastOptionsRelay = options.relay
        // S36 C3: 每一步的毫秒都记下来，问题通话的时间线才对得上服务端那一半。
        ClientDiag.log(
            "media.options",
            mapOf("ms" to diagElapsedMs(optionsStartedAt), "transport" to transport.name, "relay" to options.relay),
            callId = callId,
        )
        ensureCurrent(token)
        initialize(applicationContext)

        val gatheringComplete = AtomicBoolean(false)
        val relayCandidates = AtomicInteger(0)
        val firstRelayCandidateAt = AtomicLong(UNSET_TIME)
        val iceState = AtomicReference<PeerConnection.IceConnectionState?>(null)
        val offerStartedAt = AtomicLong(UNSET_TIME)
        val lastIceFailure = AtomicReference<CallIceFailureSummary>()
        val observedFailure = AtomicReference<Throwable>()
        // While the handshake loops observe ICE directly they are the only failure path; without
        // this guard an observer callback would start a second attempt beside the first.
        val handshakeInFlight = AtomicBoolean(true)

        fun raise(error: Throwable) {
            if (handshakeInFlight.get()) {
                observedFailure.compareAndSet(null, error)
                return
            }
            reportTerminal(token, callId, transport, error)
        }

        // S75: when ICE first went DISCONNECTED, so `media.rejoin.downMs` covers the grace too.
        val graceStartedAt = AtomicLong(UNSET_TIME)

        fun beginDisconnectGrace() {
            if (disconnectGraceJob?.isActive == true) return
            graceStartedAt.set(monotonicMs())
            disconnectGraceJob = sessionScope.launch {
                delay(CallMediaIceWaitPolicy.DISCONNECT_GRACE_MS)
                if (!stateMachine.isCurrent(token)) return@launch
                if (CallMediaIceWaitPolicy.isUsable(iceState.get())) return@launch
                startRejoin(token, callId, transport, "disconnected", graceStartedAt.get())
            }
        }

        val audioRouter = CallAudioRouter(applicationContext) {
            raise(
                CallMediaSessionException(
                    CallMediaFailureKind.AUDIO_SESSION_CONFIGURATION_FAILED,
                    transport,
                    "通话音频焦点已丢失",
                ),
            )
        }
        try {
            audioRouter.acquire()
            // S73: a rejoined leg keeps the call's speaker choice (acquire() resets it to earpiece).
            if (stateMachine.current().speakerEnabled) audioRouter.setSpeaker(true)
        } catch (error: IllegalStateException) {
            throw CallMediaSessionException(
                CallMediaFailureKind.AUDIO_SESSION_CONFIGURATION_FAILED,
                transport,
                error.message ?: callMediaFailureMessage(
                    CallMediaFailureKind.AUDIO_SESSION_CONFIGURATION_FAILED,
                    transport,
                ),
            )
        }
        val audioDevice = JavaAudioDeviceModule.builder(applicationContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .setEnableVolumeLogger(false)
            .createAudioDeviceModule()
        var factory: PeerConnectionFactory? = null
        var peer: PeerConnection? = null
        var source: AudioSource? = null
        var track: AudioTrack? = null
        var ownershipTransferred = false
        try {
            factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(audioDevice)
                .createPeerConnectionFactory()
            val netPolicy = MediaCandidateNetworkPolicy.current(
                applicationContext.getSystemService(android.net.ConnectivityManager::class.java),
            )
            val config = PeerConnection.RTCConfiguration(
                listOf(
                    PeerConnection.IceServer.builder(options.iceServer.url)
                        .setUsername(options.iceServer.username)
                        .setPassword(options.iceServer.credential)
                        .setTlsCertPolicy(PeerConnection.TlsCertPolicy.TLS_CERT_POLICY_SECURE)
                        .apply { options.iceServer.hostname?.let { setHostname(it) } }
                        .createIceServer(),
                ),
            ).apply {
                iceTransportsType = PeerConnection.IceTransportsType.RELAY
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
                // The phone enumerates ~18 interfaces (Wi-Fi, 4 cellular, ~10 IMS ipsec/utun
                // tunnels) and allocates a TURN port on each; the tunnel allocations never
                // finish. Pruning duplicate TURN ports and dropping higher-cost networks removes
                // the useless allocations. S70 (iOS S45): LOW_COST only while Wi-Fi/Ethernet
                // carries the active network; on cellular it can drop the only working interface.
                pruneTurnPorts = true
                candidateNetworkPolicy = netPolicy.webrtc
                audioJitterBufferFastAccelerate = CallMediaReceivePolicy.FAST_ACCELERATE
                audioJitterBufferMaxPackets = CallMediaReceivePolicy.MAX_PACKETS
            }
            peer = factory.createPeerConnection(config, object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                    iceState.set(state)
                    ClientDiag.log(
                        "media.ice",
                        mapOf(
                            "state" to state.name,
                            "transport" to transport.name,
                            "ms" to offerStartedAt.get().takeIf { it != UNSET_TIME }?.let(::diagElapsedMs),
                        ),
                        callId = callId,
                    )
                    if (handshakeInFlight.get()) return
                    when (CallMediaIceWaitPolicy.progress(state)) {
                        CallMediaIceWaitPolicy.Progress.CONNECTED -> {
                            disconnectGraceJob?.cancel()
                            disconnectGraceJob = null
                            stateMachine.connected(token)
                        }
                        CallMediaIceWaitPolicy.Progress.FAILED -> startRejoin(token, callId, transport, "failed",
                            if (disconnectGraceJob?.isActive == true) graceStartedAt.get() else monotonicMs())
                        CallMediaIceWaitPolicy.Progress.WAITING ->
                            if (state == PeerConnection.IceConnectionState.DISCONNECTED) beginDisconnectGrace()
                    }
                }
                override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit
                /** ICE connection state is the single post-connect signal; see [CallMediaIceWaitPolicy]. */
                override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = Unit
                override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                    if (state == PeerConnection.IceGatheringState.COMPLETE) gatheringComplete.set(true)
                }
                override fun onIceCandidate(candidate: IceCandidate) {
                    if (RELAY_CANDIDATE_MARKER !in candidate.sdp) return
                    relayCandidates.incrementAndGet()
                    firstRelayCandidateAt.compareAndSet(UNSET_TIME, monotonicMs())
                }
                override fun onIceCandidateError(event: org.webrtc.IceCandidateErrorEvent) {
                    lastIceFailure.set(summarizeCallIceFailure(event))
                }
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
                override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) = Unit
                override fun onAddStream(stream: MediaStream) = Unit
                override fun onRemoveStream(stream: MediaStream) = Unit
                override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
                override fun onRenegotiationNeeded() = Unit
                override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
                override fun onRemoveTrack(receiver: RtpReceiver) = Unit
                override fun onTrack(transceiver: org.webrtc.RtpTransceiver) = Unit
            }) ?: throw CallMediaSessionException(CallMediaFailureKind.PEER_CREATION_FAILED, transport)
            val constraints = MediaConstraints().apply {
                optional += MediaConstraints.KeyValuePair("googEchoCancellation", "true")
                optional += MediaConstraints.KeyValuePair("googAutoGainControl", "true")
                optional += MediaConstraints.KeyValuePair("googNoiseSuppression", "true")
            }
            source = factory.createAudioSource(constraints)
            track = factory.createAudioTrack("vodog-microphone", source)
            if (peer.addTrack(track, listOf("vodog-audio")) == null) {
                throw CallMediaSessionException(CallMediaFailureKind.PEER_CREATION_FAILED, transport, "无法添加麦克风音轨")
            }
            val installed = MediaResources(audioRouter, audioDevice, factory, peer, source, track, callId, transport, rejoins)
            val accepted = stateMachine.withCurrent(token) {
                resources = installed
                // S73: a rejoined leg keeps the call muted if it was.
                if (stateMachine.current().microphoneMuted) installed.setMuted(true)
            }
            ownershipTransferred = true
            factory = null
            peer = null
            source = null
            track = null
            if (!accepted) {
                installed.close()
                throw CallMediaStaleAttempt("音频连接已取消")
            }

            val offer = installed.peer.createOfferAwait()
            val opusOffer = SessionDescription(
                SessionDescription.Type.OFFER,
                opusOnlyVoiceSdp(offer.description),
            )
            installed.peer.setDescriptionAwait(opusOffer, local = true)

            awaitRelayCandidates(
                token = token,
                transport = transport,
                gatheringComplete = gatheringComplete,
                relayCandidates = relayCandidates,
                firstRelayCandidateAt = firstRelayCandidateAt,
                lastIceFailure = lastIceFailure,
                observedFailure = observedFailure,
            )
            // S52: same event and fields as iOS/Web; `ms` counts from the options request like Web's.
            ClientDiag.log(
                "media.relay_candidates",
                mapOf(
                    "count" to relayCandidates.get(), "ms" to diagElapsedMs(optionsStartedAt),
                    "transport" to transport.name, "netPolicy" to netPolicy.label,
                ),
                callId = callId,
            )
            // The peer's current local description carries every candidate gathered so far.
            val local = installed.peer.localDescription
                ?: throw CallMediaSessionException(CallMediaFailureKind.MISSING_LOCAL_DESCRIPTION, transport)
            // Last gate before the POST: never offer an SDP the server cannot relay.
            if (callRelayCandidateCount(local.description) == 0) {
                throw noRelayCandidate(transport, lastIceFailure.get())
            }

            // The POST runs on its own coroutine so the budget is real: HttpURLConnection socket I/O
            // does not answer Thread.interrupt, so awaiting it in place would stretch this step to
            // the transport's own 10 s + 15 s. The orphan finishes in the background instead.
            offerStartedAt.set(System.nanoTime())
            val offerCall = sessionScope.async(Dispatchers.IO) {
                runCatching { api.mediaOffer(callId, local.description) }
            }
            val answer = try {
                withTimeout(OFFER_TIMEOUT_MS) { offerCall.await() }
            } catch (timeout: TimeoutCancellationException) {
                offerCall.cancel()
                throw SocketTimeoutException("音频协商请求超时，请重试音频")
            }.getOrElse { error ->
                if (error is IllegalArgumentException) {
                    throw CallMediaSessionException(CallMediaFailureKind.INVALID_ANSWER, transport)
                }
                throw error
            }
            ClientDiag.log(
                "media.offer",
                mapOf("ms" to diagElapsedMs(offerStartedAt.get()), "transport" to transport.name),
                callId = callId,
            )
            ensureCurrent(token)
            installed.peer.setDescriptionAwait(
                SessionDescription(SessionDescription.Type.ANSWER, answer.sdp),
                local = false,
            )
            ClientDiag.log(
                "media.answer",
                mapOf("ms" to diagElapsedMs(offerStartedAt.get()), "transport" to transport.name),
                callId = callId,
            )

            awaitIceConnection(token, transport, iceState, observedFailure)
            stateMachine.connected(token)
            handshakeInFlight.set(false)
            // Hand over to the observer: a state change between the last poll and this flip would
            // otherwise be dropped.
            if (!CallMediaIceWaitPolicy.isUsable(iceState.get())) beginDisconnectGrace()
            installed.startPeriodicStats(sessionScope)
        } catch (error: Throwable) {
            if (!ownershipTransferred) {
                runCatching { track?.setEnabled(false) }
                runCatching { track?.dispose() }
                runCatching { source?.dispose() }
                runCatching { peer?.close() }
                runCatching { peer?.dispose() }
                runCatching { factory?.dispose() }
                runCatching { audioDevice.release() }
                runCatching { audioRouter.release() }
            }
            throw error
        }
    }

    /**
     * Polls [CallMediaRelayGatheringPolicy] instead of awaiting `IceGatheringState.COMPLETE`,
     * which on this device may never arrive.
     */
    private suspend fun awaitRelayCandidates(
        token: Long,
        transport: CallMediaTransport,
        gatheringComplete: AtomicBoolean,
        relayCandidates: AtomicInteger,
        firstRelayCandidateAt: AtomicLong,
        lastIceFailure: AtomicReference<CallIceFailureSummary>,
        observedFailure: AtomicReference<Throwable>,
    ) {
        val startMs = monotonicMs()
        while (true) {
            ensureCurrent(token)
            observedFailure.get()?.let { throw it }
            val nowMs = monotonicMs()
            val firstAt = firstRelayCandidateAt.get()
            val decision = CallMediaRelayGatheringPolicy.decide(
                gatheringComplete = gatheringComplete.get(),
                relayCandidateCount = relayCandidates.get(),
                elapsedMs = nowMs - startMs,
                sinceFirstRelayCandidateMs = if (firstAt == UNSET_TIME) null else nowMs - firstAt,
            )
            when (decision) {
                CallMediaRelayGatheringPolicy.Decision.PROCEED -> return
                CallMediaRelayGatheringPolicy.Decision.NO_RELAY_CANDIDATE ->
                    throw noRelayCandidate(transport, lastIceFailure.get())
                CallMediaRelayGatheringPolicy.Decision.WAIT ->
                    delay(CallMediaRelayGatheringPolicy.POLL_INTERVAL_MS)
            }
        }
    }

    private suspend fun awaitIceConnection(
        token: Long,
        transport: CallMediaTransport,
        iceState: AtomicReference<PeerConnection.IceConnectionState?>,
        observedFailure: AtomicReference<Throwable>,
    ) {
        repeat(CallMediaIceWaitPolicy.CONNECT_POLL_COUNT + 1) { round ->
            ensureCurrent(token)
            observedFailure.get()?.let { throw it }
            when (CallMediaIceWaitPolicy.progress(iceState.get())) {
                CallMediaIceWaitPolicy.Progress.CONNECTED -> return
                CallMediaIceWaitPolicy.Progress.FAILED ->
                    throw CallMediaSessionException(CallMediaFailureKind.ICE_CONNECTION_FAILED, transport)
                CallMediaIceWaitPolicy.Progress.WAITING ->
                    if (round < CallMediaIceWaitPolicy.CONNECT_POLL_COUNT) {
                        delay(CallMediaIceWaitPolicy.CONNECT_POLL_INTERVAL_MS)
                    }
            }
        }
        throw CallMediaSessionException(CallMediaFailureKind.ICE_CONNECT_TIMED_OUT, transport)
    }

    /** Keeps the TLS-certificate diagnostic when one was actually observed. */
    private fun noRelayCandidate(
        transport: CallMediaTransport,
        failure: CallIceFailureSummary?,
    ): CallMediaSessionException = CallMediaSessionException(
        CallMediaFailureKind.NO_RELAY_CANDIDATE,
        transport,
        if (transport == CallMediaTransport.TLS && failure?.kind == CallIceFailureKind.TLS_CERTIFICATE) {
            callRelayUnavailableMessage(transport, failure)
        } else {
            callMediaFailureMessage(CallMediaFailureKind.NO_RELAY_CANDIDATE, transport)
        },
    )

    /**
     * S73 D3: the established leg [token] dropped. Close it (off-lock through [cleanupResources]) and
     * rejoin the same bridge room with a fresh options+offer per [CallMediaRejoinPolicy]; the call,
     * its Telecom connection and mute/speaker stay as they are. Only when the budget runs out does
     * the pre-S73 terminal path (FAILED + 30 s grace) run.
     */
    private fun startRejoin(token: Long, callId: String, dropped: CallMediaTransport, reason: String, downSince: Long) {
        disconnectGraceJob?.cancel()
        disconnectGraceJob = null
        sessionScope.launch(Dispatchers.IO) { rejoinLoop(token, callId, dropped, reason, downSince) }
    }

    private suspend fun rejoinLoop(token: Long, callId: String, dropped: CallMediaTransport, reason: String, downSince: Long) {
        val startedAt = monotonicMs()
        var current = token
        var attempt = 0
        // S73h: the attempt that runs first after the network returns; 0 = the episode never went offline.
        var offlineAttempt = if (reason == CallMediaRejoinPolicy.SETUP_OFFLINE_REASON) 1 else 0
        while (true) {
            attempt += 1
            val transport = CallMediaRejoinPolicy.transport(attempt, dropped, lastOptionsRelay, offlineAttempt)
            current = stateMachine.rejoin(current, transport) ?: return
            // The dropped leg's audio router must be released before the new one acquires, or its
            // late release would reset the audio mode/route under the new leg. Blocking here holds
            // no lock, so the S70d close-vs-observer deadlock cannot recur.
            mediaCloser.submit {}.get()
            val attemptStartedAt = System.nanoTime()
            val remainingMs = CallMediaRejoinPolicy.WINDOW_MS - (monotonicMs() - startedAt)
            val error = try {
                withTimeout(remainingMs.coerceAtLeast(1)) { runHandshake(current, callId, transport, rejoin = true) }
                null
            } catch (timeout: TimeoutCancellationException) {
                CallMediaSessionException(CallMediaFailureKind.ICE_CONNECT_TIMED_OUT, transport)
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                error
            }
            if (error is CallMediaStaleAttempt || !stateMachine.isCurrent(current)) return
            val attemptMs = diagElapsedMs(attemptStartedAt)
            val offline = error != null && defaultNetwork().let { (internet, validated) ->
                CallMediaRejoinPolicy.isOffline(error, internet, validated)
            }
            ClientDiag.log(
                "media.rejoin",
                mapOf(
                    "attempt" to attempt, "reason" to reason, "transport" to transport.name,
                    // S75 共同约定: ms = this attempt, downMs = since ICE first dropped (grace included).
                    "ms" to attemptMs, "downMs" to monotonicMs() - downSince,
                    "ok" to (error == null), "error" to error?.diagReason(),
                    "probeSkipped" to true,
                ) + (if (offline) mapOf("offline" to true) else emptyMap()),
                callId = callId,
                level = if (error == null) "info" else "warn",
            )
            if (error == null) {
                rejoins.incrementAndGet()
                return
            }
            if (offline) {
                // S73c: spends no attempt; rerun as soon as a network is back, on UDP first (S73h).
                val windowLeft = CallMediaRejoinPolicy.WINDOW_MS - (monotonicMs() - startedAt)
                if (windowLeft <= 0 || !awaitNetwork(current, windowLeft)) {
                    reportTerminal(current, callId, transport, error)
                    return
                }
                attempt -= 1
                offlineAttempt = attempt + 1
                continue
            }
            val waitMs = CallMediaRejoinPolicy.nextDelayMs(attempt, error, attemptMs, monotonicMs() - startedAt)
            if (waitMs == null) {
                reportTerminal(current, callId, transport, error)
                return
            }
            delay(waitMs)
        }
    }

    /** (default network has INTERNET, and is VALIDATED). */
    private fun defaultNetwork(): Pair<Boolean, Boolean> = runCatching {
        val connectivity = applicationContext.getSystemService(android.net.ConnectivityManager::class.java)
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        (caps?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) to
            (caps?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true)
    }.getOrDefault(true to true)

    // ponytail: 500 ms ConnectivityManager poll (as the gateway), not a default-network callback.
    // The first poll always sleeps, so a DNS failure on a network that looks up cannot spin.
    private suspend fun awaitNetwork(token: Long, budgetMs: Long): Boolean = withTimeoutOrNull(budgetMs) {
        do delay(CallMediaRejoinPolicy.NETWORK_POLL_MS) while (!defaultNetwork().first && stateMachine.isCurrent(token))
        true
    } ?: false

    private fun ensureCurrent(token: Long) {
        if (!stateMachine.isCurrent(token)) throw CallMediaStaleAttempt("音频连接已取消")
    }

    private fun reportTerminal(
        token: Long,
        callId: String,
        transport: CallMediaTransport,
        error: Throwable,
    ) {
        val message = CallMediaFailureMessagePolicy.message(error, transport)
        if (!stateMachine.failed(token, message)) return
        ClientDiag.log(
            "media.failed",
            mapOf("transport" to transport.name, "error" to error.diagReason()),
            callId = callId,
            level = "error",
        )
        ClientDiag.uiErrorShown("media.failed", message, error.diagReason())
        disconnectGraceJob?.cancel()
        disconnectGraceJob = null
        onTerminalFailure(callId, transport, error)
    }

    fun setSpeaker(enabled: Boolean) {
        resources?.audioRouter?.setSpeaker(enabled)
        stateMachine.setSpeaker(enabled)
    }

    fun setMuted(muted: Boolean): Boolean {
        val active = resources ?: return false
        active.setMuted(muted)
        stateMachine.setMuted(muted)
        return true
    }

    fun reconcile(calls: List<org.json.JSONObject>) {
        stateMachine.reconcile(calls.associate { it.optString("id") to it.optString("state") })
    }

    fun stop() {
        disconnectGraceJob?.cancel()
        disconnectGraceJob = null
        stateMachine.stop()
    }

    fun invalidateProbe() = probes.invalidate()

    /**
     * Detach under the lock, close off it: [CallMediaStateMachine] calls this while holding its own
     * monitor (often on the main thread), and `PeerConnection.close()` waits for the signaling
     * thread, whose ICE callback needs that same monitor (`failed()`): 2026-09-26 ANR on hang-up.
     * ponytail: one serial closer thread; a new attempt may build its factory while the old one is
     * still closing (never observed to conflict), serialize on it if audio devices ever clash.
     */
    private fun cleanupResources() {
        val detached = synchronized(this) { resources.also { resources = null } } ?: return
        mediaCloser.execute { detached.close() }
    }

    override fun close() {
        stop()
        probeSessionIdentity = null
        probes.invalidate()
        probeGeneration.close()
        sessionScope.cancel()
    }

    companion object {
        /** The offer POST budget, enforced independently of the transport's own socket timeouts. */
        const val OFFER_TIMEOUT_MS = 8_000L
        /** S70: `media.stats` cadence, as iOS. */
        const val STATS_INTERVAL_MS = 30_000L
        private const val RELAY_CANDIDATE_MARKER = " typ relay"
        private const val UNSET_TIME = Long.MIN_VALUE
        private fun monotonicMs(): Long = System.nanoTime() / 1_000_000
        private val mediaCloser = java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "cc-media-close").apply { isDaemon = true }
        }

        @Synchronized
        private fun initialize(context: Context) {
            AndroidWebRtcRuntime.initialize(context)
        }
    }
}

private class MediaResources(
    val audioRouter: CallAudioRouter,
    private val audioDevice: JavaAudioDeviceModule,
    private val factory: PeerConnectionFactory,
    val peer: PeerConnection,
    private val source: AudioSource,
    private val track: AudioTrack,
    private val callId: String,
    private val transport: CallMediaTransport,
    private val rejoins: AtomicInteger,
) : Closeable {
    /** Guards [closed] and [statsJob] so no getStats is issued on a disposed peer. */
    private val lock = Any()
    private var closed = false
    private var statsJob: Job? = null
    @Volatile private var muted = false
    /** Raw counters of this PC's previous `media.stats` row; one [MediaResources] per PC, so a rejoin resets it. */
    @Volatile private var window: Map<String, Double>? = null

    fun setMuted(muted: Boolean) {
        this.muted = muted
        track.setEnabled(!muted)
    }

    /**
     * S70 (iOS `startPeriodicStats`): `media.stats` every 30 s while this PC lives. getStats is async
     * (callback on the signaling thread), so the ticker never blocks audio or signaling; failures are dropped.
     */
    fun startPeriodicStats(scope: CoroutineScope) = synchronized(lock) {
        if (closed || statsJob != null) return@synchronized
        statsJob = scope.launch {
            while (true) {
                delay(AndroidCallMediaSession.STATS_INTERVAL_MS)
                synchronized(lock) {
                    if (closed) return@launch
                    runCatching { peer.getStats(::logStats) }
                }
            }
        }
    }

    private fun logStats(report: org.webrtc.RTCStatsReport) = runCatching {
        val stats = report.statsMap.values.map { it.type to it.members }
        val sample = rtpWindowSample(stats)
        val fields = mediaRxTx(stats).toMutableMap()
        fields["rx"] = fields.getValue("rx") + rtpWindow(window, sample)
        if (sample != null) window = sample
        ClientDiag.log(
            "media.stats",
            fields.mapValues { org.json.JSONObject(it.value) } + ("transport" to transport.name) + ("muted" to muted),
            callId = callId,
        )
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            statsJob?.cancel()
        }
        // S70: rx/tx for the attempt, requested before any disposal. peer.close() waits for a pending
        // stats request, so the callback lands before the peer goes away without a timer here.
        // Nested maps become JSONObject: org.json would otherwise stringify them.
        runCatching {
            peer.getStats { report ->
                val stats = report.statsMap.values.map { it.type to it.members }
                val fields = mediaRxTx(stats).mapValues { org.json.JSONObject(it.value) }
                ClientDiag.log("media.summary", fields + ("transport" to transport.name) + ("rejoins" to rejoins.get()), callId = callId)
            }
        }
        runCatching { track.setEnabled(false) }
        runCatching { track.dispose() }
        runCatching { source.dispose() }
        runCatching { peer.close() }
        runCatching { peer.dispose() }
        runCatching { factory.dispose() }
        runCatching { audioDevice.release() }
        runCatching { audioRouter.release() }
    }
}

internal fun audioFocusChangeName(change: Int): String = when (change) {
    AudioManager.AUDIOFOCUS_GAIN -> "gain"
    AudioManager.AUDIOFOCUS_LOSS -> "loss"
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "loss_transient"
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "loss_transient_can_duck"
    else -> change.toString()
}

private class CallAudioRouter(
    context: Context,
    private val onFocusLost: () -> Unit,
) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val previousMode = audio.mode
    @Suppress("DEPRECATION")
    private val previousSpeaker = if (android.os.Build.VERSION.SDK_INT < 31) audio.isSpeakerphoneOn else false
    private var acquired = false
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        val name = audioFocusChangeName(change)
        ClientDiag.log("audio.focus", mapOf("change" to name))
        // Transient losses (a notification, an assistant prompt) come back with AUDIOFOCUS_GAIN;
        // only a permanent loss ends the call.
        if (name == "loss") onFocusLost()
    }
    private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setOnAudioFocusChangeListener(focusListener)
        .build()

    fun acquire() {
        check(audio.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            "无法取得通话音频焦点"
        }
        acquired = true
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        setSpeaker(false)
        // S36 C3: 蓝牙/听筒/扬声器的每一次切换都进诊断，这是「对方听不见」那类投诉的第一现场。
        runCatching { audio.registerAudioDeviceCallback(deviceCallback, null) }
        logRoute("acquire")
    }

    fun setSpeaker(enabled: Boolean) {
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            if (enabled) {
                val speaker = audio.availableCommunicationDevices.firstOrNull {
                    it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                }
                if (speaker != null) audio.setCommunicationDevice(speaker)
            } else {
                audio.clearCommunicationDevice()
            }
        } else {
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = enabled
        }
        logRoute(if (enabled) "speaker_on" else "speaker_off")
    }

    private val deviceCallback = object : android.media.AudioDeviceCallback() {
        override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) = logDevices("added", devices)
        override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) = logDevices("removed", devices)
    }

    private fun logDevices(change: String, devices: Array<out AudioDeviceInfo>) = ClientDiag.log(
        "audio.route",
        mapOf(
            "change" to change,
            "devices" to devices.joinToString(",") { it.type.toString() },
            "mode" to audio.mode,
        ),
    )

    private fun logRoute(change: String) = ClientDiag.log(
        "audio.route",
        mapOf(
            "change" to change,
            "device" to if (android.os.Build.VERSION.SDK_INT >= 31) audio.communicationDevice?.type else null,
            "scoOn" to @Suppress("DEPRECATION") audio.isBluetoothScoOn,
            "mode" to audio.mode,
        ),
    )

    fun release() {
        runCatching { audio.unregisterAudioDeviceCallback(deviceCallback) }
        logRoute("release")
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            audio.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = previousSpeaker
        }
        audio.mode = previousMode
        if (acquired) audio.abandonAudioFocusRequest(focusRequest)
        acquired = false
    }
}

private suspend fun PeerConnection.createOfferAwait(): SessionDescription =
    kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
        val constraints = MediaConstraints().apply {
            mandatory += MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true")
        }
        createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                if (continuation.isActive) continuation.resume(description) { _, _, _ -> }
            }
            override fun onCreateFailure(message: String) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException(message)))
            }
            override fun onSetSuccess() = Unit
            override fun onSetFailure(message: String) = Unit
        }, constraints)
    }

private suspend fun PeerConnection.setDescriptionAwait(description: SessionDescription, local: Boolean): Unit =
    kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
        val observer = object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onCreateFailure(message: String) = Unit
            override fun onSetSuccess() {
                if (continuation.isActive) continuation.resume(Unit) { _, _, _ -> }
            }
            override fun onSetFailure(message: String) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException(message)))
            }
        }
        if (local) setLocalDescription(observer, description) else setRemoteDescription(observer, description)
    }
