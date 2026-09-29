package org.vodog.gateway.media

import java.nio.ByteBuffer
import java.nio.ByteOrder

enum class MediaDirection(val wireValue: Int) {
    CELLULAR_DOWNLINK(0),
    USER_UPLINK(1);

    companion object {
        fun fromWire(value: Int) = entries.firstOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("unsupported direction")
    }
}

data class MediaPacket(
    val direction: MediaDirection,
    val durationMs: Int,
    val sequence: Long,
    val timestampUs: Long,
    val opus: ByteArray,
) {
    override fun equals(other: Any?): Boolean = other is MediaPacket &&
        direction == other.direction && durationMs == other.durationMs &&
        sequence == other.sequence && timestampUs == other.timestampUs && opus.contentEquals(other.opus)

    override fun hashCode(): Int = 31 * (31 * sequence.hashCode() + timestampUs.hashCode()) + opus.contentHashCode()
}

object MediaPacketCodec {
    const val VERSION = 1
    const val HEADER_SIZE = 16
    const val MAX_OPUS_BYTES = 1024
    private val validDurations = setOf(10, 20, 40, 60)

    fun encode(packet: MediaPacket): ByteArray {
        require(packet.durationMs in validDurations) { "unsupported duration" }
        require(packet.sequence in 0..0xffff_ffffL) { "sequence outside uint32" }
        require(packet.timestampUs >= 0) { "timestamp must be monotonic and nonnegative" }
        require(packet.opus.size in 1..MAX_OPUS_BYTES) { "invalid Opus payload size" }
        require(opusDurationMs(packet.opus) == packet.durationMs) { "Opus duration mismatch" }
        return ByteBuffer.allocate(HEADER_SIZE + packet.opus.size).order(ByteOrder.BIG_ENDIAN).apply {
            put(VERSION.toByte())
            put(packet.direction.wireValue.toByte())
            putShort(packet.durationMs.toShort())
            putInt(packet.sequence.toInt())
            putLong(packet.timestampUs)
            put(packet.opus)
        }.array()
    }

    fun decode(bytes: ByteArray): MediaPacket {
        require(bytes.size in (HEADER_SIZE + 1)..(HEADER_SIZE + MAX_OPUS_BYTES)) { "invalid media packet" }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        require(buffer.get().toInt() and 0xff == VERSION) { "unsupported packet version" }
        val direction = MediaDirection.fromWire(buffer.get().toInt() and 0xff)
        val duration = buffer.short.toInt() and 0xffff
        require(duration in validDurations) { "unsupported duration" }
        val sequence = buffer.int.toLong() and 0xffff_ffffL
        val timestampUs = buffer.long
        require(timestampUs >= 0) { "invalid monotonic timestamp" }
        val opus = ByteArray(buffer.remaining()).also(buffer::get)
        require(opusDurationMs(opus) == duration) { "Opus duration mismatch" }
        return MediaPacket(direction, duration, sequence, timestampUs, opus)
    }

    /** Mirrors services/media/packet.go and RFC 6716 section 3.1. */
    fun opusDurationMs(opus: ByteArray): Int {
        require(opus.isNotEmpty()) { "empty Opus" }
        val toc = opus[0].toInt() and 0xff
        var samples = if (toc and 0x80 != 0) {
            120 shl ((toc shr 3) and 3)
        } else if (toc and 0x60 == 0x60) {
            if (toc and 8 != 0) 960 else 480
        } else {
            (480 shl ((toc shr 3) and 3)).let { if (it == 3840) 2880 else it }
        }
        val count = when (toc and 3) {
            1, 2 -> 2
            3 -> {
                require(opus.size >= 2) { "truncated Opus" }
                opus[1].toInt() and 0x3f
            }
            else -> 1
        }
        samples *= count
        require(samples == 480 || samples == 960 || samples == 1920 || samples == 2880) {
            "unsupported Opus packet duration"
        }
        return samples / 48
    }
}
