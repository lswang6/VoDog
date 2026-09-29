package org.vodog.gateway.media

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SyntheticOpusRoundTripTest {
    @Test fun syntheticPcmRoundTripsThroughPacketProtocol() {
        val result = SyntheticOpusRoundTrip.run()
        Log.i(TAG, "packets=${result.packetCount} payloadBytes=${result.payloadBytes} encodedMs=${result.encodedDurationMs} decodedBytes=${result.decodedPcmBytes} decodedMs=${result.decodedDurationMs} peak=${result.decodedPeak} nativeRates=${result.decoderNativeSampleRates}")
        assertTrue("expected encoded packets", result.packetCount > 0)
        assertTrue("payload must be present", result.payloadBytes > 0)
        assertTrue("encoded duration near source", result.encodedDurationMs in 900..1_100)
        assertTrue("decoded duration near source", result.decodedDurationMs in 850..1_100)
        assertTrue("decoded synthetic tone must not be silent", result.decodedPeak > 1_000)
        assertTrue("decoder native output rate must be observed", result.decoderNativeSampleRates.isNotEmpty())
    }

    companion object { private const val TAG = "SyntheticOpusRoundTrip" }
}
