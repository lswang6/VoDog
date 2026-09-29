package org.vodog.gateway.media

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.sin

/** Manual probe. Mac Go probe + adb reverse tcp:16884 required. No phone/audio source. */
@RunWith(AndroidJUnit4::class)
class RemoteOpusRelayTest {
    @Test fun pixelOpusTraversesRealTurnAndControlNodeBothDirections(): Unit = runBlocking {
        val config = JSONObject(localRequest("GET", "/config"))
        val signaling = object : GatewayMediaSignaling {
            override suspend fun options(callId: String, transport: IceTransport): MediaOptions {
                val servers = config.getJSONArray("iceServers")
                return MediaOptions(List(servers.length()) { index ->
                    val server = servers.getJSONObject(index)
                    val urls = server.getJSONArray("urls")
                    MediaIceServer(List(urls.length()) { urls.getString(it) }, server.getString("username"), server.getString("credential"))
                }, config.getString("iceTransportPolicy"))
            }
            override suspend fun offer(callId: String, offer: MediaSessionDescription): MediaSessionDescription {
                Log.i("RemoteOpusRelay", "ICE gathering completed; localRelayCandidates=${offer.sdp.lineSequence().count { it.startsWith("a=candidate:") && " typ relay" in it }}")
                val answer = JSONObject(localRequest("POST", "/offer", JSONObject().put("type", offer.type).put("sdp", offer.sdp).toString()))
                Log.i("RemoteOpusRelay", "Remote answer received; relayCandidates=${answer.getString("sdp").lineSequence().count { it.startsWith("a=candidate:") && " typ relay" in it }}")
                return MediaSessionDescription(answer.getString("type"), answer.getString("sdp"))
            }
        }
        val received = LinkedBlockingQueue<MediaPacket>(250)
        try {
            GatewayDataChannelTransport.connect(
                ApplicationProvider.getApplicationContext<Context>(), config.getString("callId"), signaling,
                object : GatewayDataChannelListener {
                    override fun onPacket(packet: MediaPacket) { received.offer(packet) }
                    override fun onDiagnostic(stage: MediaDiagnosticStage, errorCode: Int?) { Log.i("RemoteOpusRelay", "stage=$stage code=$errorCode") }
                },
            ).use { session ->
                val frames = mutableListOf<EncodedOpusFrame>()
                val format = OpusMediaCodecEncoder(bitRate = 16_000, frameDurationMs = 20).use { encoder ->
                    repeat(100) { frame ->
                        val pcm = ByteArray(640)
                        repeat(320) { i ->
                            val sample = (sin(2 * PI * 440 * (frame * 320 + i) / 16_000) * 10_000).toInt()
                            pcm[i * 2] = sample.toByte(); pcm[i * 2 + 1] = (sample shr 8).toByte()
                        }
                        frames += encoder.encode(pcm, frame * 20_000L)
                    }
                    frames += encoder.finish(2_000_000L)
                    encoder.outputFormat()
                }
                var sent = 0
                frames.forEachIndexed { index, frame ->
                    val result = session.send(MediaPacket(MediaDirection.CELLULAR_DOWNLINK, MediaPacketCodec.opusDurationMs(frame.payload), index.toLong(), frame.presentationTimeUs.coerceAtLeast(0), frame.payload))
                    if (result == MediaSendResult.SENT) sent++
                    SystemClock.sleep(20)
                }
                val echoed = mutableListOf<MediaPacket>()
                val deadline = SystemClock.elapsedRealtime() + 8_000
                while (echoed.size < sent && SystemClock.elapsedRealtime() < deadline) {
                    received.poll(200, TimeUnit.MILLISECONDS)?.let(echoed::add)
                }
                assertTrue("real relay did not return enough Opus packets", echoed.size >= 30)
                assertTrue("wrong uplink direction", echoed.all { it.direction == MediaDirection.USER_UPLINK })
                var pcmBytes = 0
                OpusMediaCodecDecoder(format).use { decoder ->
                    echoed.forEach { packet -> pcmBytes += decoder.decode(EncodedOpusFrame(packet.opus, packet.timestampUs)).sumOf { it.pcm16le.size } }
                    pcmBytes += decoder.finish(echoed.last().timestampUs + 20_000).sumOf { it.pcm16le.size }
                }
                assertTrue("received Opus failed to decode", pcmBytes > 16_000)
                Log.i("RemoteOpusRelay", "synthetic=true sent=$sent received=${echoed.size} payloadBytes=${frames.sumOf { it.payload.size }} decodedPcmBytes=$pcmBytes stats=${session.stats()}")
            }
        } finally { runCatching { localRequest("POST", "/done") } }
    }

    // Only localhost test signaling: keep the production cleartext policy intact.
    private fun localRequest(method: String, path: String, body: String = ""): String {
        require(path in setOf("/config", "/offer", "/done"))
        return Socket("127.0.0.1", 16884).use { socket ->
            socket.soTimeout = 30_000
            val bytes = body.toByteArray(Charsets.UTF_8)
            val header = "$method $path HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
            socket.getOutputStream().apply { write(header.toByteArray()); write(bytes); flush() }
            val response = socket.getInputStream().bufferedReader().readText()
            require(response.length <= 150_000) { "probe response too large" }
            val status = response.substringBefore("\r\n").split(" ").getOrNull(1)?.toIntOrNull()
            check(status != null && status in 200..299) { "local probe HTTP $status" }
            response.substringAfter("\r\n\r\n")
        }
    }
}
