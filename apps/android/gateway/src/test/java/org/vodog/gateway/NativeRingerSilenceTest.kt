package org.vodog.gateway

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeRingerSilenceTest {
    @Test fun ownedRingingCallsAreSilenced() {
        listOf("offer_to_owner", "rejected_busy", "dropped_blocked").forEach {
            assertTrue(it, shouldSilenceNativeRinger(it, DeviceCallState.RINGING))
        }
    }

    @Test fun localOnlyKeepsNativeRinging() {
        assertFalse(shouldSilenceNativeRinger("local_only", DeviceCallState.RINGING))
    }

    @Test fun nonRingingCallsAreLeftAlone() {
        listOf(DeviceCallState.ACTIVE, DeviceCallState.DIALING, DeviceCallState.ENDED, DeviceCallState.UNKNOWN).forEach {
            assertFalse(it.name, shouldSilenceNativeRinger("offer_to_owner", it))
        }
    }
}
