package org.vodog.gateway.media

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MediaPacketCodecTest {
    @Test fun matchesGoPacketVectorByteForByte() {
        val packet = MediaPacket(MediaDirection.CELLULAR_DOWNLINK, 20, 40, 800_000, byteArrayOf(0xf8.toByte(), 0xff.toByte(), 0xfe.toByte()))
        val expected = hex("010000140000002800000000000c3500f8fffe")
        assertArrayEquals(expected, MediaPacketCodec.encode(packet))
        assertEquals(packet, MediaPacketCodec.decode(expected))
    }

    @Test fun rejectsDurationMismatch() {
        val bytes = hex("0100000a0000002800000000000c3500f8fffe")
        assertThrows(IllegalArgumentException::class.java) { MediaPacketCodec.decode(bytes) }
    }

    @Test fun readsSupportedTocDurations() {
        assertEquals(20, MediaPacketCodec.opusDurationMs(byteArrayOf(0xf8.toByte())))
        assertEquals(40, MediaPacketCodec.opusDurationMs(byteArrayOf(0xf9.toByte())))
    }

    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
