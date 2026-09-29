package org.vodog

import android.media.ToneGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DialToneTest {
    @Test fun `dialpad digits map to their DTMF tone constants`() {
        assertEquals(ToneGenerator.TONE_DTMF_1, dtmfToneType("1"))
        assertEquals(ToneGenerator.TONE_DTMF_5, dtmfToneType("5"))
        assertEquals(ToneGenerator.TONE_DTMF_9, dtmfToneType("9"))
        assertEquals(ToneGenerator.TONE_DTMF_0, dtmfToneType("0"))
        assertEquals(ToneGenerator.TONE_DTMF_S, dtmfToneType("*"))
        assertEquals(ToneGenerator.TONE_DTMF_P, dtmfToneType("#"))
    }

    @Test fun `keys without a DTMF tone stay silent`() {
        assertNull(dtmfToneType("+"))
        assertNull(dtmfToneType(""))
        assertNull(dtmfToneType("12"))
    }
}
