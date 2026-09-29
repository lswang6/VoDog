package org.vodog.gateway.media

data class SequenceDecision(val accepted: Boolean, val missingBefore: Long = 0)

/** Tracks each media direction separately and treats uint32 wrap as forward progress. */
class MediaSequenceTracker {
    private val last = arrayOfNulls<Long>(2)

    @Synchronized
    fun observe(packet: MediaPacket): SequenceDecision {
        val index = packet.direction.wireValue
        val previous = last[index]
        if (previous == null) {
            last[index] = packet.sequence
            return SequenceDecision(true)
        }
        val distance = (packet.sequence - previous) and UINT32_MASK
        if (distance == 0L || distance >= UINT32_HALF) return SequenceDecision(false)
        last[index] = packet.sequence
        return SequenceDecision(true, distance - 1)
    }

    private companion object {
        const val UINT32_MASK = 0xffff_ffffL
        const val UINT32_HALF = 0x8000_0000L
    }
}
