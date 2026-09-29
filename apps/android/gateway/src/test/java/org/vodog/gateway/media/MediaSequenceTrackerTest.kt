package org.vodog.gateway.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaSequenceTrackerTest {
    private val opus20ms = byteArrayOf(0xf8.toByte())

    @Test fun dropsOldAndDuplicateAndCountsGapsPerDirection() {
        val tracker = MediaSequenceTracker()
        assertTrue(tracker.observe(packet(MediaDirection.CELLULAR_DOWNLINK, 10)).accepted)
        assertEquals(2, tracker.observe(packet(MediaDirection.CELLULAR_DOWNLINK, 13)).missingBefore)
        assertFalse(tracker.observe(packet(MediaDirection.CELLULAR_DOWNLINK, 13)).accepted)
        assertFalse(tracker.observe(packet(MediaDirection.CELLULAR_DOWNLINK, 12)).accepted)
        assertTrue(tracker.observe(packet(MediaDirection.USER_UPLINK, 2)).accepted)
    }

    @Test fun acceptsUint32Wrap() {
        val tracker = MediaSequenceTracker()
        assertTrue(tracker.observe(packet(MediaDirection.USER_UPLINK, 0xffff_ffffL)).accepted)
        assertTrue(tracker.observe(packet(MediaDirection.USER_UPLINK, 0)).accepted)
    }

    @Test fun backpressureAllowsAtMostThreeCurrentPackets() {
        assertFalse(mediaBackpressureExceeded(bufferedBytes = 232, currentPacketBytes = 116))
        assertTrue(mediaBackpressureExceeded(bufferedBytes = 233, currentPacketBytes = 116))
        // A 20 B silence packet behind two buffered 100 B speech packets is not backpressure.
        assertFalse(mediaBackpressureExceeded(bufferedBytes = 200, currentPacketBytes = 20))
    }

    private fun packet(direction: MediaDirection, sequence: Long) =
        MediaPacket(direction, 20, sequence, sequence, opus20ms)
}
