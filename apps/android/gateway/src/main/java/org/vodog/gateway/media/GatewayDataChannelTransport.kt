package org.vodog.gateway.media

import android.content.Context
import android.os.SystemClock
import android.util.Log
import org.vodog.gateway.GatewayDiag
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import java.io.Closeable
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

enum class MediaSendResult { SENT, BACKPRESSURE, CLOSED }
enum class MediaDiagnosticStage {
    OPTIONS_REQUESTED, OPTIONS_RECEIVED, PEER_CREATED,
    CREATE_OFFER_STARTED, CREATE_OFFER_COMPLETE,
    SET_LOCAL_STARTED, SET_LOCAL_COMPLETE,
    ICE_GATHERING_NEW, ICE_GATHERING_GATHERING, ICE_GATHERING_COMPLETE,
    ICE_CANDIDATE_ERROR, ICE_RELAY_UNAVAILABLE,
    SIGNALING_OFFER_STARTED, SIGNALING_ANSWER_RECEIVED,
    SET_REMOTE_STARTED, SET_REMOTE_COMPLETE,
    DATA_CHANNEL_WAITING, DATA_CHANNEL_OPEN,
    NEGOTIATION_FAILED,
}

data class MediaTransportStats(
    val receivedPackets: Long,
    val droppedPackets: Long,
    val missingPackets: Long,
    val backpressureDrops: Long,
)

/**
 * Which ICE states tear a live session down. DISCONNECTED is deliberately absent: libwebrtc uses it
 * for a pair that has merely gone quiet, escalates a dead one to FAILED after its own write timeout,
 * and the pion bridge only closes the room on PeerConnectionState Failed (30 s). Treating it as fatal
 * killed a real iOS→Pixel call that would have recovered.
 */
internal fun isFatalIceState(state: PeerConnection.IceConnectionState): Boolean =
    state == PeerConnection.IceConnectionState.FAILED || state == PeerConnection.IceConnectionState.CLOSED

internal fun isFatalPeerState(state: PeerConnection.PeerConnectionState): Boolean =
    state == PeerConnection.PeerConnectionState.FAILED || state == PeerConnection.PeerConnectionState.CLOSED

// CLOSED also fires on every clean hangup (our own peerConnection.close()), so it stays info.
private fun iceDiagLevel(state: PeerConnection.IceConnectionState): String = when (state) {
    PeerConnection.IceConnectionState.FAILED -> "error"
    PeerConnection.IceConnectionState.CLOSED -> "info"
    else -> "info"
}

private fun peerDiagLevel(state: PeerConnection.PeerConnectionState): String = when (state) {
    PeerConnection.PeerConnectionState.FAILED -> "error"
    PeerConnection.PeerConnectionState.CLOSED -> "info"
    else -> "info"
}

interface GatewayDataChannelListener {
    fun onPacket(packet: MediaPacket)
    fun onDisconnected() = Unit
    /** S73: an established leg died; [reason] is dc_closed / ice_failed / pc_closed / ice_disconnected ... */
    fun onTransportLost(reason: String) = onDisconnected()
    fun onProtocolError(error: IllegalArgumentException) = Unit
    /** Finite stage/error-code telemetry only; never contains candidates, addresses or credentials. */
    fun onDiagnostic(stage: MediaDiagnosticStage, errorCode: Int? = null) = Unit
}

/**
 * S73: reports an established leg's loss exactly once. Nothing is reported before [establish] (a
 * negotiation that fails is the rejoin loop's business) or after [close] (our own peerConnection.close()
 * fires CLOSED, which must not start another rejoin).
 */
internal class LegLossReporter(private val listener: GatewayDataChannelListener) {
    private val established = AtomicBoolean(false)
    private val done = AtomicBoolean(false)
    private val disconnectedSince = java.util.concurrent.atomic.AtomicLong(0L)
    fun establish() = established.set(true)
    fun close() = done.set(true)
    fun report(reason: String) {
        if (established.get() && done.compareAndSet(false, true)) runCatching { listener.onTransportLost(reason) }
    }
    /** ICE DISCONNECTED/CONNECTED edges; a disconnect still standing after the grace is a loss. */
    fun iceState(state: PeerConnection.IceConnectionState, nowMs: Long, schedule: (Long, () -> Unit) -> Unit) {
        when (state) {
            PeerConnection.IceConnectionState.DISCONNECTED -> if (established.get() && disconnectedSince.compareAndSet(0L, nowMs)) {
                schedule(MEDIA_ICE_DISCONNECTED_GRACE_MS) { if (disconnectedSince.get() == nowMs) report("ice_disconnected") }
            }
            PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> disconnectedSince.set(0L)
            else -> Unit
        }
    }
}

private val legLossTimer by lazy {
    java.util.concurrent.Executors.newSingleThreadScheduledExecutor { Thread(it, "VoDog.leg-loss").apply { isDaemon = true } }
}

/**
 * A WebRTC DataChannel-only session. It never creates AudioSource, AudioTrack,
 * VideoSource or VideoTrack. Its muted audio device module is never given an audio track,
 * and this transport never starts the manifest-declared RECORD_AUDIO path.
 */
class GatewayDataChannelTransport private constructor(
    private val factoryOwner: DataOnlyPeerConnectionFactory,
    private val peerConnection: PeerConnection,
    private val dataChannel: DataChannel,
    private val listener: GatewayDataChannelListener,
    /** The ICE transport whose attempt actually opened this data channel. */
    val negotiatedTransport: IceTransport,
    /** 1 for the first planned transport, 2 after a fallback. */
    val negotiationAttempt: Int,
    /** S71: host of the TURN URL this attempt used, for `media.session_end.turnHost`. */
    val turnHost: String? = null,
    private val loss: LegLossReporter = LegLossReporter(listener),
    /** S73b: this leg runs on the relay TURN, so a rejoin stays TLS-only. */
    val relayTurn: Boolean = false,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val sequences = MediaSequenceTracker()
    private val received = java.util.concurrent.atomic.AtomicLong()
    private val dropped = java.util.concurrent.atomic.AtomicLong()
    private val missing = java.util.concurrent.atomic.AtomicLong()
    private val backpressureDrops = java.util.concurrent.atomic.AtomicLong()

    init {
        dataChannel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) = Unit

            override fun onStateChange() {
                if (dataChannel.state() == DataChannel.State.CLOSED) loss.report("dc_closed")
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                if (!buffer.binary || closed.get()) return
                val bytes = ByteArray(buffer.data.remaining()).also(buffer.data::get)
                val packet = try {
                    MediaPacketCodec.decode(bytes)
                } catch (error: IllegalArgumentException) {
                    dropped.incrementAndGet()
                    listener.onProtocolError(error)
                    return
                }
                // The recovery candidate owns deduplication and deadline-aware ordering in its
                // playout worker. A high-water sequence tracker would discard useful late FEC.
                if (org.vodog.gateway.BuildConfig.RECEIVE_RECOVERY_ENABLED) {
                    received.incrementAndGet()
                    listener.onPacket(packet)
                    return
                }
                val decision = sequences.observe(packet)
                if (!decision.accepted) {
                    dropped.incrementAndGet()
                    return
                }
                missing.addAndGet(decision.missingBefore)
                received.incrementAndGet()
                listener.onPacket(packet)
            }
        })
    }

    @Synchronized
    fun send(packet: MediaPacket): MediaSendResult {
        if (closed.get() || dataChannel.state() != DataChannel.State.OPEN) return MediaSendResult.CLOSED
        val encoded = MediaPacketCodec.encode(packet)
        if (mediaBackpressureExceeded(dataChannel.bufferedAmount(), encoded.size)) {
            backpressureDrops.incrementAndGet()
            return MediaSendResult.BACKPRESSURE
        }
        return if (dataChannel.send(DataChannel.Buffer(ByteBuffer.wrap(encoded), true))) {
            MediaSendResult.SENT
        } else {
            backpressureDrops.incrementAndGet()
            MediaSendResult.BACKPRESSURE
        }
    }

    fun stats() = MediaTransportStats(received.get(), dropped.get(), missing.get(), backpressureDrops.get())

    @Synchronized
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        loss.close()
        runCatching { dataChannel.unregisterObserver() }
        runCatching { dataChannel.close() }
        runCatching { dataChannel.dispose() }
        runCatching { peerConnection.close() }
        runCatching { peerConnection.dispose() }
        runCatching { factoryOwner.close() }
    }

    companion object {
        const val LABEL = "cellular-opus-v1"
        const val MAX_BUFFERED_PACKETS = 3L
        private val initialized = AtomicBoolean(false)

        /**
         * S24 decision 1: [transport] is only the *first* transport to try. When it does not reach a
         * relay candidate or an open data channel inside its bounded budget, the negotiation is torn
         * down and replayed once on the other transport before the failure is reported.
         */
        suspend fun connect(
            context: Context,
            callId: String,
            signaling: GatewayMediaSignaling,
            listener: GatewayDataChannelListener,
            transport: IceTransport = IceTransport.UDP,
            /** S73: a rejoin runs exactly one transport with the budget its window has left. */
            fallback: Boolean = true,
            budgetMs: Long = MEDIA_NEGOTIATION_TIMEOUT_MS,
            onTransportFallback: (from: IceTransport, to: IceTransport, reason: String) -> Unit = { _, _, _ -> },
        ): GatewayDataChannelTransport =
            connectInternal(context, callId, signaling, listener, transport, true, onTransportFallback, fallback, budgetMs)

        internal suspend fun connectForTest(
            context: Context,
            callId: String,
            signaling: GatewayMediaSignaling,
            listener: GatewayDataChannelListener,
        ): GatewayDataChannelTransport = connectInternal(
            context, callId, signaling, listener, IceTransport.UDP, false, { _, _, _ -> }, false, MEDIA_NEGOTIATION_TIMEOUT_MS,
        )

        private suspend fun connectInternal(
            context: Context,
            callId: String,
            signaling: GatewayMediaSignaling,
            listener: GatewayDataChannelListener,
            transport: IceTransport,
            enforceRelay: Boolean,
            onTransportFallback: (IceTransport, IceTransport, String) -> Unit,
            fallback: Boolean,
            budgetMs: Long,
        ): GatewayDataChannelTransport = withContext(Dispatchers.IO) {
            initialize(context.applicationContext)
            try {
                // Relay enforcement is also what tells a production call from the host-candidate
                // loopback fixture, which has no second transport to fall back to.
                withMediaTransportFallback(
                    mediaTransportPlan(transport, fallbackEnabled = enforceRelay && fallback, finalBudgetMs = budgetMs),
                    onTransportFallback,
                ) { attempt -> negotiate(context, callId, signaling, listener, attempt, enforceRelay) }
            } finally {
                // Both attempts share one signaling instance: closing it here would close the owned
                // HTTP transport that the fallback's second `options` request still needs.
                runCatching { signaling.close() }
            }
        }

        private suspend fun negotiate(
            context: Context,
            callId: String,
            signaling: GatewayMediaSignaling,
            listener: GatewayDataChannelListener,
            attempt: MediaTransportAttempt,
            enforceRelay: Boolean,
        ): GatewayDataChannelTransport {
            // Read by the fallback log after the budget expires; the coroutine that set it is gone.
            val stage = AtomicReference(MediaTransportStage.OPTIONS)
            // Outside withTimeout so `media.failed` can report the last TURN error (S53).
            val lastIceFailure = AtomicReference<IceFailureSummary>()
            val loss = LegLossReporter(listener)
            val callTag = callId.take(8)
            val transportTag = attempt.transport.wireValue
            var factoryOwner: DataOnlyPeerConnectionFactory? = null
            var peer: PeerConnection? = null
            var channel: DataChannel? = null
            try {
                return withTimeout(attempt.budgetMs) {
                    diagnostic(listener, MediaDiagnosticStage.OPTIONS_REQUESTED)
                    val options = signaling.options(callId, attempt.transport)
                    diagnostic(listener, MediaDiagnosticStage.OPTIONS_RECEIVED)
                    if (enforceRelay) require(options.iceTransportPolicy == "relay") { "relay ICE is required" }
                    stage.set(MediaTransportStage.GATHERING)
                    val owner = dataOnlyPeerConnectionFactory(context.applicationContext)
                    factoryOwner = owner
                    val gatheringComplete = CompletableDeferred<Unit>()
                    val relayCandidate = CompletableDeferred<Unit>()
                    // Monotonic stamps for the S25 D9 settle window; 0 means "has not happened yet".
                    val relayCandidateAtMs = java.util.concurrent.atomic.AtomicLong()
                    val gatheringCompleteAtMs = java.util.concurrent.atomic.AtomicLong()
                    // S36 C3: per attempt, so a fallback's ICE timing is measured from its own offer.
                    val offerAtMs = java.util.concurrent.atomic.AtomicLong()
                    val channelOpen = CompletableDeferred<Unit>()
                    val channelRef = AtomicReference<DataChannel>()
                    val config = PeerConnection.RTCConfiguration(options.iceServers.map { server ->
                        PeerConnection.IceServer.builder(server.urls)
                            .setUsername(server.username)
                            .setPassword(server.credential)
                            .setTlsCertPolicy(PeerConnection.TlsCertPolicy.TLS_CERT_POLICY_SECURE)
                            .apply { server.hostname?.let { setHostname(it) } }
                            .createIceServer()
                    }).apply {
                        iceTransportsType = if (enforceRelay) PeerConnection.IceTransportsType.RELAY else PeerConnection.IceTransportsType.ALL
                        sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                        continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
                        // S20 D7: one TURN allocation per network instead of one per local port. The
                        // relay quota is only 8 allocations, and a call already needs at least four.
                        // LOW_COST is deliberately NOT set: it would drop the cellular candidates
                        // whenever an unstable Wi-Fi is merely present, and this gateway cannot be
                        // rolled back remotely.
                        pruneTurnPorts = true
                    }
                    val connection = owner.factory.createPeerConnection(config, object : PeerConnection.Observer {
                        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
                        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                            Log.i(ICE_LOG_TAG, "ice_state call=$callTag transport=$transportTag state=$state")
                            val sinceOfferMs = offerAtMs.get().takeIf { it > 0L }?.let { SystemClock.elapsedRealtime() - it }
                            if (state == PeerConnection.IceConnectionState.CONNECTED || state == PeerConnection.IceConnectionState.COMPLETED) GatewayDiag.log("media.ice_connected", mapOf("transport" to transportTag, "state" to state.name, "sinceOfferMs" to sinceOfferMs), callId = callId)
                            // DISCONNECTED is transient and is logged, never fatal: the same relay pair
                            // recovers without an ICE restart once packets resume (S18 decision 6 gives
                            // iOS the same grace). A truly dead pair is escalated to FAILED by libwebrtc
                            // itself after its write timeout, and pion's own failed timeout is 30 s.
                            if (state == PeerConnection.IceConnectionState.DISCONNECTED || isFatalIceState(state)) {
                                GatewayDiag.log("media.ice_state", mapOf("transport" to transportTag, "state" to state.name, "sinceOfferMs" to sinceOfferMs), callId = callId, level = iceDiagLevel(state))
                            }
                            loss.iceState(state, SystemClock.elapsedRealtime()) { delayMs, task ->
                                legLossTimer.schedule(Runnable { task() }, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                            }
                            if (isFatalIceState(state)) loss.report("ice_${state.name.lowercase()}")
                        }
                        override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit
                        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                            Log.i(ICE_LOG_TAG, "pc_state call=$callTag transport=$transportTag state=$newState")
                            // Same rule as onIceConnectionChange: DISCONNECTED is transient, FAILED/CLOSED are not.
                            if (newState == PeerConnection.PeerConnectionState.DISCONNECTED || isFatalPeerState(newState)) {
                                GatewayDiag.log("media.pc_state", mapOf("transport" to transportTag, "state" to newState.name, "sinceOfferMs" to offerAtMs.get().takeIf { it > 0L }?.let { SystemClock.elapsedRealtime() - it }), callId = callId, level = peerDiagLevel(newState))
                            }
                            if (isFatalPeerState(newState)) loss.report("pc_${newState.name.lowercase()}")
                        }
                        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
                        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                            Log.i(ICE_LOG_TAG, "ice_gathering call=$callTag transport=$transportTag state=$state")
                            diagnostic(listener, when (state) {
                                PeerConnection.IceGatheringState.NEW -> MediaDiagnosticStage.ICE_GATHERING_NEW
                                PeerConnection.IceGatheringState.GATHERING -> MediaDiagnosticStage.ICE_GATHERING_GATHERING
                                PeerConnection.IceGatheringState.COMPLETE -> MediaDiagnosticStage.ICE_GATHERING_COMPLETE
                            })
                            if (state == PeerConnection.IceGatheringState.COMPLETE) {
                                gatheringCompleteAtMs.compareAndSet(0L, SystemClock.elapsedRealtime())
                                gatheringComplete.complete(Unit)
                            }
                        }
                        override fun onIceCandidate(candidate: IceCandidate) {
                            // The only early proof that this transport reached the TURN server at
                            // all. Gathering COMPLETE arrives many seconds later, after every
                            // allocation retry is exhausted, which is exactly the stall S24 removes.
                            // Type and protocol only: candidate SDP carries addresses, which never reach the log.
                            Log.i(ICE_LOG_TAG, "ice_candidate call=$callTag transport=$transportTag ${describeCandidate(candidate.sdp)} adapter=${candidate.adapterType}")
                            if (isRelayCandidate(candidate.sdp)) {
                                relayCandidateAtMs.compareAndSet(0L, SystemClock.elapsedRealtime())
                                relayCandidate.complete(Unit)
                            }
                        }
                        override fun onIceCandidateError(event: org.webrtc.IceCandidateErrorEvent) {
                            val summary = summarizeIceFailure(event)
                            lastIceFailure.set(summary)
                            // errorText is WebRTC's own fixed wording (no address, no credential); the URL is
                            // the TURN URI Control handed out, which is not secret either.
                            Log.w(ICE_LOG_TAG, "ice_candidate_error call=$callTag transport=$transportTag code=${event.errorCode} kind=${summary.kind} text=${event.errorText.take(120)} url=${event.url.take(80)}")
                            diagnostic(listener, MediaDiagnosticStage.ICE_CANDIDATE_ERROR, event.errorCode)
                        }
                        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
                        override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) {
                            Log.i(ICE_LOG_TAG, "ice_pair call=$callTag transport=$transportTag local=${describeCandidate(event.local.sdp)} remote=${describeCandidate(event.remote.sdp)} reason=${event.reason.take(40)}")
                        }
                        override fun onAddStream(stream: MediaStream) = Unit
                        override fun onRemoveStream(stream: MediaStream) = Unit
                        override fun onDataChannel(remote: DataChannel) = Unit
                        override fun onRenegotiationNeeded() = Unit
                        override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
                        override fun onRemoveTrack(receiver: RtpReceiver) = Unit
                        override fun onTrack(transceiver: org.webrtc.RtpTransceiver) = Unit
                    }) ?: error("failed to create peer connection")
                    peer = connection
                    diagnostic(listener, MediaDiagnosticStage.PEER_CREATED)
                    // The anchor of `offer_after`: everything measured against it is ICE work.
                    val peerCreatedAtMs = SystemClock.elapsedRealtime()
                    val init = DataChannel.Init().apply {
                        ordered = false
                        maxRetransmits = 0
                    }
                    val created = connection.createDataChannel(LABEL, init) ?: error("failed to create data channel")
                    channel = created
                    channelRef.set(created)
                    created.registerObserver(object : DataChannel.Observer {
                        override fun onBufferedAmountChange(previousAmount: Long) = Unit
                        override fun onStateChange() {
                            if (channelRef.get().state() == DataChannel.State.OPEN) {
                                diagnostic(listener, MediaDiagnosticStage.DATA_CHANNEL_OPEN)
                                channelOpen.complete(Unit)
                            }
                        }
                        override fun onMessage(buffer: DataChannel.Buffer) = Unit
                    })

                    diagnostic(listener, MediaDiagnosticStage.CREATE_OFFER_STARTED)
                    val offer = connection.createOfferAwait()
                    diagnostic(listener, MediaDiagnosticStage.CREATE_OFFER_COMPLETE)
                    diagnostic(listener, MediaDiagnosticStage.SET_LOCAL_STARTED)
                    connection.setLocalDescriptionAwait(offer)
                    diagnostic(listener, MediaDiagnosticStage.SET_LOCAL_COMPLETE)
                    if (enforceRelay) {
                        // S25 decision 9: wait for the first relay candidate, not for the end of
                        // gathering. Gathering only completes once the TURN allocation on every
                        // interface has failed or finished - on a Pixel holding Wi-Fi and 5G at once
                        // the cellular one needs 0.9-3.5 s just to fail - while the relay candidate
                        // that carries the call lands in 0.1-0.5 s. Gathering finishing first ends
                        // this wait too: it means no relay will ever arrive, and the count check
                        // below turns that into the same RelayIceUnavailableException as before.
                        // Only while a fallback is still available is the wait bounded: the last
                        // attempt must keep waiting for a slow relay rather than give up on the only
                        // transport it has left.
                        val reached = attempt.relayCandidateDeadlineMs?.let { deadline ->
                            withTimeoutOrNull(deadline) { awaitRelayOrGathering(relayCandidate, gatheringComplete) } != null
                        } ?: run { awaitRelayOrGathering(relayCandidate, gatheringComplete); true }
                        if (!reached) {
                            diagnostic(listener, MediaDiagnosticStage.ICE_RELAY_UNAVAILABLE, lastIceFailure.get()?.errorCode)
                            stage.set(MediaTransportStage.RELAY_CANDIDATE)
                            throw MediaTransportTimeoutException(attempt.transport, MediaTransportStage.RELAY_CANDIDATE)
                        }
                        // Then the settle window, or gathering completing inside it, whichever comes
                        // first. A relay-only offer needs exactly one relay candidate and no
                        // end-of-candidates line; the window only exists so a second interface's
                        // relay can still ride along in the same offer.
                        val readyAtMs = mediaOfferReadyAtMs(
                            relayCandidateAtMs.get().takeIf { it > 0L },
                            gatheringCompleteAtMs.get().takeIf { it > 0L },
                        )
                        val settleWaitMs = readyAtMs?.minus(SystemClock.elapsedRealtime()) ?: 0L
                        if (settleWaitMs > 0L) withTimeoutOrNull(settleWaitMs) { gatheringComplete.await() }
                    } else {
                        // The host-candidate loopback fixture never produces a relay candidate and
                        // needs its whole candidate set, so it keeps waiting for COMPLETE.
                        gatheringComplete.await()
                    }
                    val local = checkNotNull(connection.localDescription)
                    val relayCandidates = relayCandidateCount(local.description)
                    if (enforceRelay && relayCandidates == 0) {
                        val failure = lastIceFailure.get()
                        diagnostic(listener, MediaDiagnosticStage.ICE_RELAY_UNAVAILABLE, failure?.errorCode)
                        throw RelayIceUnavailableException(attempt.transport, failure)
                    }
                    stage.set(MediaTransportStage.OFFER)
                    // How long the caller waited on ICE before the offer left, and what the offer
                    // carried. Counts and a state word only: no candidate ever reaches the log.
                    Log.i(
                        ICE_LOG_TAG,
                        "offer_after call=$callTag transport=$transportTag" +
                            " ms=${SystemClock.elapsedRealtime() - peerCreatedAtMs} relay=$relayCandidates" +
                            " gathering=${if (gatheringCompleteAtMs.get() > 0L) "complete" else "partial"}",
                    )
                    diagnostic(listener, MediaDiagnosticStage.SIGNALING_OFFER_STARTED)
                    offerAtMs.set(SystemClock.elapsedRealtime())
                    GatewayDiag.log("media.offer", mapOf("transport" to transportTag, "ms" to offerAtMs.get() - peerCreatedAtMs, "relayCandidates" to relayCandidates, "gathering" to if (gatheringCompleteAtMs.get() > 0L) "complete" else "partial"), callId = callId)
                    val answer = signaling.offer(callId, MediaSessionDescription("offer", local.description))
                    diagnostic(listener, MediaDiagnosticStage.SIGNALING_ANSWER_RECEIVED)
                    diagnostic(listener, MediaDiagnosticStage.SET_REMOTE_STARTED)
                    connection.setRemoteDescriptionAwait(SessionDescription(SessionDescription.Type.ANSWER, answer.sdp))
                    diagnostic(listener, MediaDiagnosticStage.SET_REMOTE_COMPLETE)
                    stage.set(MediaTransportStage.DATA_CHANNEL)
                    diagnostic(listener, MediaDiagnosticStage.DATA_CHANNEL_WAITING)
                    channelOpen.await()
                    created.unregisterObserver()
                    GatewayDataChannelTransport(owner, connection, created, listener, attempt.transport, attempt.ordinal,
                        options.iceServers.firstOrNull()?.urls?.firstOrNull()?.let(::turnUrlHost), loss, relayTurn = options.relay)
                        .also { loss.establish() }
                }
            } catch (timeout: TimeoutCancellationException) {
                diagnostic(listener, MediaDiagnosticStage.NEGOTIATION_FAILED)
                GatewayDiag.log("media.failed", mapOf("transport" to transportTag, "stage" to stage.get().name, "reason" to "timeout") + iceFailureDiagFields(lastIceFailure.get()), callId = callId, level = "error")
                releaseNegotiation(channel, peer, factoryOwner)
                throw MediaTransportTimeoutException(attempt.transport, stage.get(), timeout)
            } catch (error: Throwable) {
                diagnostic(listener, MediaDiagnosticStage.NEGOTIATION_FAILED)
                GatewayDiag.log("media.failed", mapOf("transport" to transportTag, "stage" to stage.get().name, "reason" to (error.message ?: error.javaClass.simpleName).take(120)) + iceFailureDiagFields(lastIceFailure.get()), callId = callId, level = "error")
                releaseNegotiation(channel, peer, factoryOwner)
                throw error
            }
        }

        private fun releaseNegotiation(
            channel: DataChannel?,
            peer: PeerConnection?,
            factoryOwner: DataOnlyPeerConnectionFactory?,
        ) {
            runCatching { channel?.unregisterObserver() }
            runCatching { channel?.close() }
            runCatching { channel?.dispose() }
            runCatching { peer?.close() }
            runCatching { peer?.dispose() }
            runCatching { factoryOwner?.close() }
        }

        @Synchronized
        private fun initialize(context: Context) {
            if (!initialized.get()) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions(),
                )
                initialized.set(true)
            }
        }
    }
}

/**
 * Returns as soon as either the first relay candidate arrives or gathering ends. The second clause
 * is what keeps the deadline-free last attempt from waiting out its whole budget on a transport
 * that has already finished gathering without a single relay candidate.
 */
private suspend fun awaitRelayOrGathering(
    relayCandidate: CompletableDeferred<Unit>,
    gatheringComplete: CompletableDeferred<Unit>,
): Unit = select {
    relayCandidate.onAwait { }
    gatheringComplete.onAwait { }
}

private fun diagnostic(
    listener: GatewayDataChannelListener,
    stage: MediaDiagnosticStage,
    errorCode: Int? = null,
) {
    Log.i(ICE_LOG_TAG, "media_stage stage=$stage${errorCode?.let { " code=$it" } ?: ""}")
    runCatching { listener.onDiagnostic(stage, errorCode) }
}

internal const val SPEECH_PACKET_FLOOR_BYTES = 116

internal fun mediaBackpressureExceeded(bufferedBytes: Long, currentPacketBytes: Int): Boolean {
    require(bufferedBytes >= 0 && currentPacketBytes > 0)
    // S70f: size by a speech packet, not the current one: after speech the buffer still holds
    // ~100 B packets while silence packets are a few bytes, so "3 x current" dropped every silence
    // packet behind them (same bug as the bridge budget, S70d). ponytail: floor = 16 B header +
    // 100 B p99 Opus payload; in pure silence it admits more tiny packets (~20 ms each).
    val sizing = maxOf(currentPacketBytes, SPEECH_PACKET_FLOOR_BYTES)
    return bufferedBytes + currentPacketBytes > sizing.toLong() * GatewayDataChannelTransport.MAX_BUFFERED_PACKETS
}

/** Avoids the SDK's default Java AudioRecord path; no audio source or media section is created. */
internal class DataOnlyPeerConnectionFactory(
    val factory: PeerConnectionFactory,
    private val audioDevice: JavaAudioDeviceModule,
) : Closeable {
    override fun close() {
        try {
            factory.dispose()
        } finally {
            audioDevice.release()
        }
    }
}

internal fun dataOnlyPeerConnectionFactory(context: Context): DataOnlyPeerConnectionFactory {
    val audioDevice = JavaAudioDeviceModule.builder(context)
        .setUseHardwareAcousticEchoCanceler(false)
        .setUseHardwareNoiseSuppressor(false)
        .setEnableVolumeLogger(false)
        .createAudioDeviceModule()
        .apply { setMicrophoneMute(true) }
    return try {
        val factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioDevice)
            .createPeerConnectionFactory()
        DataOnlyPeerConnectionFactory(factory, audioDevice)
    } catch (error: Throwable) {
        audioDevice.release()
        throw error
    }
}

private suspend fun PeerConnection.createOfferAwait(): SessionDescription =
    kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
        createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                if (continuation.isActive) continuation.resume(description) { _, _, _ -> }
            }
            override fun onCreateFailure(message: String) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException(message)))
            }
            override fun onSetSuccess() = Unit
            override fun onSetFailure(message: String) = Unit
        }, org.webrtc.MediaConstraints())
    }

private suspend fun PeerConnection.setLocalDescriptionAwait(description: SessionDescription) =
    setDescriptionAwait(description, true)

private suspend fun PeerConnection.setRemoteDescriptionAwait(description: SessionDescription) =
    setDescriptionAwait(description, false)

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

/** Same tag as the coordinator's media log so one logcat filter shows the whole setup. */
private const val ICE_LOG_TAG = "VoDogMedia"

private val CANDIDATE_TYPE = Regex("(?:^|\\s)typ\\s+(\\S+)")
private val CANDIDATE_PROTOCOL = Regex("^(?:candidate:)?\\S+\\s+\\d+\\s+(\\S+)")

/** `typ=relay proto=udp`: the two facts a connectivity post-mortem needs, without any address. */
internal fun describeCandidate(sdp: String): String {
    val type = CANDIDATE_TYPE.find(sdp)?.groupValues?.get(1)?.take(8) ?: "?"
    val protocol = CANDIDATE_PROTOCOL.find(sdp)?.groupValues?.get(1)?.lowercase()?.take(4) ?: "?"
    return "typ=$type proto=$protocol"
}
