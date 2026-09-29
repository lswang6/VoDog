package org.vodog.gateway.media

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.io.Closeable
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.sin

@RunWith(AndroidJUnit4::class)
class WebRtcSyntheticOpusLoopbackTest {
    @Test fun syntheticOpusCrossesUnorderedUnreliableDataChannelAndDecodes() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val received = LinkedBlockingQueue<MediaPacket>()
        LocalEchoSignaling(context).use { signaling ->
            val session = GatewayDataChannelTransport.connectForTest(
                context = context,
                callId = "instrumentation-local-loopback",
                signaling = signaling,
                listener = object : GatewayDataChannelListener {
                    override fun onPacket(packet: MediaPacket) { received.offer(packet) }
                },
            )
            session.use {
                val frames = mutableListOf<EncodedOpusFrame>()
                val decoderFormat = OpusMediaCodecEncoder(frameDurationMs = FRAME_MS).use { encoder ->
                    repeat(FRAME_COUNT) { index ->
                        frames += encoder.encode(sineFrame(index), index * FRAME_MS * 1_000L)
                    }
                    frames += encoder.finish(FRAME_COUNT * FRAME_MS * 1_000L)
                    encoder.outputFormat()
                }
                frames.forEachIndexed { index, frame ->
                    val packet = MediaPacket(
                        MediaDirection.CELLULAR_DOWNLINK,
                        MediaPacketCodec.opusDurationMs(frame.payload),
                        index.toLong(),
                        frame.presentationTimeUs.coerceAtLeast(0),
                        frame.payload,
                    )
                    val deadline = SystemClock.elapsedRealtime() + 3_000
                    while (session.send(packet) == MediaSendResult.BACKPRESSURE) {
                        assertTrue("DataChannel backpressure did not clear", SystemClock.elapsedRealtime() < deadline)
                        SystemClock.sleep(5)
                    }
                }

                val echoed = List(frames.size) {
                    requireNotNull(received.poll(10, TimeUnit.SECONDS)) { "timed out waiting for echoed Opus" }
                }
                val chunks = mutableListOf<DecodedPcmChunk>()
                OpusMediaCodecDecoder(decoderFormat).use { decoder ->
                    echoed.forEach { packet ->
                        assertEquals(MediaDirection.USER_UPLINK, packet.direction)
                        chunks += decoder.decode(EncodedOpusFrame(packet.opus, packet.timestampUs))
                    }
                    chunks += decoder.finish(FRAME_COUNT * FRAME_MS * 1_000L)
                }
                val pcm = chunks.flatMap { it.pcm16le.asIterable() }.toByteArray()
                val decodedMs = pcm.size * 1_000 / (OpusMediaCodecEncoder.SAMPLE_RATE * 2)
                Log.i(TAG, "label=${GatewayDataChannelTransport.LABEL} packets=${echoed.size} payloadBytes=${echoed.sumOf { it.opus.size }} decodedMs=$decodedMs bufferedPackets=${GatewayDataChannelTransport.MAX_BUFFERED_PACKETS} stats=${session.stats()}")
                assertTrue("decoded duration near source", decodedMs in 850..1_100)
                assertEquals(echoed.size.toLong(), session.stats().receivedPackets)
                assertEquals(0, session.stats().droppedPackets)
                assertEquals(0, session.stats().backpressureDrops)
            }
        }
    }

    private fun sineFrame(frameIndex: Int): ByteArray {
        val samples = OpusMediaCodecEncoder.bytesForDuration(FRAME_MS) / 2
        return ByteArray(samples * 2).also { output ->
            repeat(samples) { index ->
                val absolute = frameIndex * samples + index
                val sample = (sin(2.0 * PI * 440.0 * absolute / OpusMediaCodecEncoder.SAMPLE_RATE) * 10_000).toInt()
                output[index * 2] = (sample and 0xff).toByte()
                output[index * 2 + 1] = ((sample shr 8) and 0xff).toByte()
            }
        }
    }

    companion object {
        private const val TAG = "WebRtcOpusLoopback"
        private const val FRAME_MS = 20
        private const val FRAME_COUNT = 50
    }
}

/** In-process test peer. It owns no audio source/track and echoes validated Opus packets. */
private class LocalEchoSignaling(private val context: Context) : GatewayMediaSignaling, Closeable {
    private var factory: DataOnlyPeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var channel: DataChannel? = null

    override suspend fun options(callId: String, transport: IceTransport) = MediaOptions(emptyList(), "test-all")

    override suspend fun offer(callId: String, offer: MediaSessionDescription): MediaSessionDescription {
        val factoryOwner = dataOnlyPeerConnectionFactory(context).also { factory = it }
        val localFactory = factoryOwner.factory
        val gathering = CountDownLatch(1)
        val config = PeerConnection.RTCConfiguration(emptyList()).apply {
            iceTransportsType = PeerConnection.IceTransportsType.ALL
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val localPeer = requireNotNull(localFactory.createPeerConnection(config, object : NoOpPeerObserver() {
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) gathering.countDown()
            }

            override fun onDataChannel(remote: DataChannel) {
                channel = remote
                remote.registerObserver(object : DataChannel.Observer {
                    override fun onBufferedAmountChange(previousAmount: Long) = Unit
                    override fun onStateChange() = Unit
                    override fun onMessage(buffer: DataChannel.Buffer) {
                        if (!buffer.binary) return
                        val bytes = ByteArray(buffer.data.remaining()).also(buffer.data::get)
                        val packet = MediaPacketCodec.decode(bytes)
                        val echo = packet.copy(direction = MediaDirection.USER_UPLINK)
                        remote.send(DataChannel.Buffer(ByteBuffer.wrap(MediaPacketCodec.encode(echo)), true))
                    }
                })
            }
        })).also { peer = it }
        localPeer.setRemoteDescriptionBlocking(SessionDescription(SessionDescription.Type.OFFER, offer.sdp))
        val answer = localPeer.createAnswerBlocking()
        localPeer.setLocalDescriptionBlocking(answer)
        assertTrue("test peer ICE gathering timed out", gathering.await(10, TimeUnit.SECONDS))
        return MediaSessionDescription("answer", requireNotNull(localPeer.localDescription).description)
    }

    override fun close() {
        runCatching { channel?.unregisterObserver() }
        runCatching { channel?.close() }
        runCatching { channel?.dispose() }
        runCatching { peer?.close() }
        runCatching { peer?.dispose() }
        runCatching { factory?.close() }
    }
}

private open class NoOpPeerObserver : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
    override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit
    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = Unit
    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
    override fun onIceCandidate(candidate: IceCandidate) = Unit
    override fun onIceCandidateError(event: org.webrtc.IceCandidateErrorEvent) = Unit
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
    override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) = Unit
    override fun onAddStream(stream: MediaStream) = Unit
    override fun onRemoveStream(stream: MediaStream) = Unit
    override fun onDataChannel(channel: DataChannel) = Unit
    override fun onRenegotiationNeeded() = Unit
    override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
    override fun onRemoveTrack(receiver: RtpReceiver) = Unit
    override fun onTrack(transceiver: org.webrtc.RtpTransceiver) = Unit
}

private fun PeerConnection.createAnswerBlocking(): SessionDescription {
    val latch = CountDownLatch(1)
    var value: SessionDescription? = null
    var failure: String? = null
    createAnswer(object : SimpleSdpObserver() {
        override fun onCreateSuccess(description: SessionDescription) { value = description; latch.countDown() }
        override fun onCreateFailure(message: String) { failure = message; latch.countDown() }
    }, MediaConstraints())
    check(latch.await(10, TimeUnit.SECONDS)) { "createAnswer timed out" }
    check(failure == null) { failure.orEmpty() }
    return requireNotNull(value)
}

private fun PeerConnection.setRemoteDescriptionBlocking(description: SessionDescription) =
    setDescriptionBlocking(description, false)

private fun PeerConnection.setLocalDescriptionBlocking(description: SessionDescription) =
    setDescriptionBlocking(description, true)

private fun PeerConnection.setDescriptionBlocking(description: SessionDescription, local: Boolean) {
    val latch = CountDownLatch(1)
    var failure: String? = null
    val observer = object : SimpleSdpObserver() {
        override fun onSetSuccess() { latch.countDown() }
        override fun onSetFailure(message: String) { failure = message; latch.countDown() }
    }
    if (local) setLocalDescription(observer, description) else setRemoteDescription(observer, description)
    check(latch.await(10, TimeUnit.SECONDS)) { "setDescription timed out" }
    check(failure == null) { failure.orEmpty() }
}

private open class SimpleSdpObserver : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription) = Unit
    override fun onCreateFailure(message: String) = Unit
    override fun onSetSuccess() = Unit
    override fun onSetFailure(message: String) = Unit
}
