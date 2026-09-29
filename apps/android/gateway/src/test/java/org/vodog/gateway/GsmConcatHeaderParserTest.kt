package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Test

class GsmConcatHeaderParserTest {
    @Test fun parsesEightBitConcatReferenceAndOneBasedPartIndex() {
        val pdu = basePdu(byteArrayOf(0x00, 0x03, 0x7a, 0x03, 0x02))
        assertEquals(SmsConcatHeader(0x7a, 1, 3), parseGsmConcatHeader(pdu, "3gpp"))
    }

    @Test fun parsesSixteenBitConcatReference() {
        val pdu = basePdu(byteArrayOf(0x08, 0x04, 0x12, 0x34, 0x02, 0x01))
        assertEquals(SmsConcatHeader(0x1234, 0, 2), parseGsmConcatHeader(pdu, "3gpp"))
    }

    @Test fun unknownFormatOrMessageWithoutUdhIsNotClaimedAsMultipart() {
        assertNull(parseGsmConcatHeader(basePdu(byteArrayOf(0x00, 0x03, 1, 2, 1)), "3gpp2"))
        val noUdh = basePdu(byteArrayOf(0x00, 0x03, 1, 2, 1)).also { it[1] = 0x00 }
        assertNull(parseGsmConcatHeader(noUdh, "3gpp"))
    }

    @Test fun retryUsesSameBatchButLaterReuseOfReferenceCannotJoinOldResidualParts() {
        val arguments = arrayOf<Any?>(4L, "sim", 7, "fingerprint", "+12025550101", 0x7a, 2)
        fun key(at: String) = incomingMultipartBatchKey(
            arguments[0] as Long, arguments[1] as String, arguments[2] as Int,
            arguments[3] as String, arguments[4] as String, arguments[5] as Int,
            arguments[6] as Int, at,
        )
        assertEquals(key("2026-09-09T01:00:00Z"), key("2026-09-09T01:00:00Z"))
        assertNotEquals(key("2026-09-09T01:00:00Z"), key("2026-09-09T03:00:00Z"))
    }

    @Test fun completedMultipartIdentityIncludesEveryPartDigestAndBody() {
        val original = listOf(SmsStoredPart("hello ", "pdu-a"), SmsStoredPart("world", "pdu-b"))
        assertEquals(incomingMultipartContentIdentity(original), incomingMultipartContentIdentity(original))
        assertNotEquals(
            incomingMultipartContentIdentity(original),
            incomingMultipartContentIdentity(listOf(SmsStoredPart("hello ", "pdu-a"), SmsStoredPart("again", "pdu-c"))),
        )
    }

    @Test fun onlyOneCompleteProtectedBroadcastCanBecomeMultipartReceipt() {
        val first = IncomingSmsSegment(SmsConcatHeader(9, 0, 2), "hello ", "pdu-1")
        val second = IncomingSmsSegment(SmsConcatHeader(9, 1, 2), "world", "pdu-2")
        assertEquals(
            listOf(SmsStoredPart("hello ", "pdu-1"), SmsStoredPart("world", "pdu-2")),
            completeMultipartBatch(listOf(second, first)),
        )
        assertNull(completeMultipartBatch(listOf(first)))
        assertNull(completeMultipartBatch(listOf(
            first, IncomingSmsSegment(SmsConcatHeader(10, 1, 2), "other", "pdu-3"),
        )))
        assertNull(completeMultipartBatch(listOf(
            first, IncomingSmsSegment(SmsConcatHeader(9, 0, 2), "duplicate", "pdu-4"),
        )))
    }

    private fun basePdu(header: ByteArray): ByteArray {
        val pdu = ByteArray(16 + header.size)
        pdu[0] = 0 // no SMSC address
        pdu[1] = 0x40 // SMS-DELIVER with UDHI
        pdu[2] = 2 // originating address digits
        pdu[3] = 0x91.toByte()
        pdu[4] = 0x21
        // PID + DCS + seven-byte timestamp remain zero.
        pdu[14] = (header.size + 1).toByte()
        pdu[15] = header.size.toByte()
        header.copyInto(pdu, 16)
        return pdu
    }
}
