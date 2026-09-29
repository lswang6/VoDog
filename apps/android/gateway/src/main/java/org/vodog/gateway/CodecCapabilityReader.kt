package org.vodog.gateway

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat

data class OpusCodecSnapshot(
    val encoderNames: List<String>,
    val decoderNames: List<String>,
    val supports16kMonoEncode: Boolean,
    val supports16kMonoDecode: Boolean,
)

object CodecCapabilityReader {
    fun probe(): OpusCodecSnapshot {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 16_000, 1).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, 20_000)
        }
        val codecs = MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos
            .filter { codec -> codec.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_AUDIO_OPUS, true) } }
        val encoders = codecs.filter(MediaCodecInfo::isEncoder)
        val decoders = codecs.filterNot(MediaCodecInfo::isEncoder)
        return OpusCodecSnapshot(
            encoderNames = encoders.map { it.name },
            decoderNames = decoders.map { it.name },
            supports16kMonoEncode = encoders.any { supports(it, format) },
            supports16kMonoDecode = decoders.any { supports(it, format) },
        )
    }

    private fun supports(codec: MediaCodecInfo, format: MediaFormat): Boolean = runCatching {
        codec.getCapabilitiesForType(MediaFormat.MIMETYPE_AUDIO_OPUS).isFormatSupported(format)
    }.getOrDefault(false)
}
