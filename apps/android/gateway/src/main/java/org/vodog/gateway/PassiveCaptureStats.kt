package org.vodog.gateway

import kotlin.math.abs
import kotlin.math.sqrt

/** Null is unknown. Once loss/uncertainty affected reads, a later good config cannot erase it. */
internal class PassiveCaptureHealth {
    var silenced: Boolean? = null
        private set
    var everSilenced = false
        private set
    var unknownReads = 0L
        private set
    val incomplete: Boolean get() = everSilenced || unknownReads > 0L

    fun observe(value: Boolean?) {
        silenced = value
        if (value == true) everSilenced = true
    }

    fun read() { if (silenced == null) unknownReads++ }
}

/** S49: actual source samples only; padded output must not look like successful capture. */
internal class PassiveCaptureStats {
    private var reads = 0L
    private var bytes = 0L
    private var zeroReads = 0L
    private var errorReads = 0L
    private var lastReadError = 0
    private var shortReads = 0L
    private var samples = 0L
    private var nonzeroSamples = 0L
    private var allZeroReads = 0L
    private var peak = 0
    private var squares = 0.0
    private var paddedBytes = 0L

    fun recordRead(buffer: ByteArray, returned: Int, requested: Int) {
        reads++
        if (returned < 0) {
            errorReads++
            lastReadError = returned
            return
        }
        if (returned == 0) {
            zeroReads++
            return
        }
        if (returned < requested) shortReads++
        val count = minOf(returned, requested, buffer.size)
        bytes += count
        val aligned = count - count % 2
        var nonzero = 0L
        for (offset in 0 until aligned step 2) {
            val sample = ((buffer[offset].toInt() and 0xff) or
                (buffer[offset + 1].toInt() shl 8)).toShort().toInt()
            if (sample != 0) nonzero++
            peak = maxOf(peak, abs(sample))
            squares += sample.toDouble() * sample
        }
        samples += aligned / 2
        nonzeroSamples += nonzero
        if (aligned > 0 && nonzero == 0L) allZeroReads++
    }

    fun recordPadding(bytes: Int) {
        paddedBytes += bytes.coerceAtLeast(0)
    }

    fun fields(): Map<String, Any> = mapOf(
        "reads" to reads, "readBytes" to bytes, "zeroReads" to zeroReads,
        "errorReads" to errorReads, "lastReadError" to lastReadError,
        "shortReads" to shortReads, "samples" to samples,
        "nonzeroSamples" to nonzeroSamples, "allZeroReads" to allZeroReads,
        "peak" to peak, "rms" to if (samples == 0L) 0.0 else sqrt(squares / samples),
        "paddedBytes" to paddedBytes,
    )
}
