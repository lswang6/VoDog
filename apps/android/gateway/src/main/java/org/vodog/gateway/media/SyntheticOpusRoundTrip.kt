package org.vodog.gateway.media

import kotlin.math.PI
import kotlin.math.sin

data class SyntheticOpusResult(
    val packetCount: Int,
    val payloadBytes: Int,
    val encodedDurationMs: Int,
    val decodedPcmBytes: Int,
    val decodedDurationMs: Int,
    val decodedPeak: Int,
    val decoderNativeSampleRates: Set<Int>,
)

object SyntheticOpusRoundTrip {
    const val SOURCE_DURATION_MS = 1_000
    private const val FRAME_MS = 20

    fun run(): SyntheticOpusResult {
        val encoded = mutableListOf<EncodedOpusFrame>()
        val decoderFormat = OpusMediaCodecEncoder(frameDurationMs = FRAME_MS).use { encoder ->
            repeat(SOURCE_DURATION_MS / FRAME_MS) { frameIndex ->
                encoded += encoder.encode(sineFrame(frameIndex), frameIndex * FRAME_MS * 1_000L)
            }
            encoded += encoder.finish(SOURCE_DURATION_MS * 1_000L)
            encoder.outputFormat()
        }
        require(encoded.isNotEmpty()) { "encoder produced no Opus access units" }

        val packets = encoded.mapIndexed { index, frame ->
            val duration = MediaPacketCodec.opusDurationMs(frame.payload)
            MediaPacketCodec.decode(
                MediaPacketCodec.encode(
                    MediaPacket(
                        MediaDirection.CELLULAR_DOWNLINK,
                        duration,
                        index.toLong(),
                        frame.presentationTimeUs.coerceAtLeast(0),
                        frame.payload,
                    )
                )
            )
        }

        val decoded = mutableListOf<DecodedPcmChunk>()
        OpusMediaCodecDecoder(decoderFormat).use { decoder ->
            packets.forEach { decoded += decoder.decode(EncodedOpusFrame(it.opus, it.timestampUs)) }
            decoded += decoder.finish(SOURCE_DURATION_MS * 1_000L)
        }
        val pcm = decoded.flatMap { it.pcm16le.asIterable() }.toByteArray()
        return SyntheticOpusResult(
            packetCount = packets.size,
            payloadBytes = packets.sumOf { it.opus.size },
            encodedDurationMs = packets.sumOf { it.durationMs },
            decodedPcmBytes = pcm.size,
            decodedDurationMs = pcm.size * 1_000 / (OpusMediaCodecEncoder.SAMPLE_RATE * 2),
            decodedPeak = pcmPeak(pcm),
            decoderNativeSampleRates = decoded.map { it.codecOutputSampleRate }.toSet(),
        )
    }

    private fun sineFrame(frameIndex: Int): ByteArray {
        val samples = OpusMediaCodecEncoder.bytesForDuration(FRAME_MS) / 2
        return ByteArray(samples * 2).also { output ->
            repeat(samples) { index ->
                val absoluteSample = frameIndex * samples + index
                val sample = (sin(2.0 * PI * 440.0 * absoluteSample / OpusMediaCodecEncoder.SAMPLE_RATE) * 10_000)
                    .toInt().toShort().toInt()
                output[index * 2] = (sample and 0xff).toByte()
                output[index * 2 + 1] = ((sample shr 8) and 0xff).toByte()
            }
        }
    }

    private fun pcmPeak(pcm: ByteArray): Int {
        var peak = 0
        var index = 0
        while (index + 1 < pcm.size) {
            val sample = ((pcm[index].toInt() and 0xff) or (pcm[index + 1].toInt() shl 8)).toShort().toInt()
            val magnitude = if (sample == Short.MIN_VALUE.toInt()) 32768 else kotlin.math.abs(sample)
            if (magnitude > peak) peak = magnitude
            index += 2
        }
        return peak
    }
}
