package org.vodog.gateway

import java.util.concurrent.atomic.AtomicBoolean

/** Accumulates arbitrary PCM reads and emits only complete, independently owned frames. */
internal class PcmFrameAccumulator(private val frameBytes: Int) {
    private val pending = ByteArray(frameBytes)
    private var pendingBytes = 0

    init { require(frameBytes > 0) }

    fun append(source: ByteArray, offset: Int = 0, length: Int = source.size - offset, emit: (ByteArray) -> Unit) {
        require(offset >= 0 && length >= 0 && offset + length <= source.size)
        var sourceOffset = offset
        var remaining = length
        while (remaining > 0) {
            val copied = minOf(frameBytes - pendingBytes, remaining)
            source.copyInto(pending, pendingBytes, sourceOffset, sourceOffset + copied)
            pendingBytes += copied
            sourceOffset += copied
            remaining -= copied
            if (pendingBytes == frameBytes) {
                emit(pending.copyOf())
                pendingBytes = 0
            }
        }
    }

    fun discardPartial() { pendingBytes = 0 }
    internal fun pendingByteCount(): Int = pendingBytes
}

/** Writes one PCM frame completely; cancellation leaves the unsent suffix discarded by the caller. */
internal fun writePcmFrameFully(
    frame: ByteArray,
    shouldContinue: () -> Boolean,
    write: (offset: Int, length: Int) -> Int,
    onZeroProgress: () -> Unit,
): Boolean {
    var offset = 0
    while (offset < frame.size && shouldContinue()) {
        val count = write(offset, frame.size - offset)
        check(count >= 0) { "PCM write failed: $count" }
        check(count <= frame.size - offset) { "PCM writer exceeded requested length" }
        if (count == 0) onZeroProgress() else offset += count
    }
    return offset == frame.size
}

internal fun joinUnlessCurrent(thread: Thread?, timeoutMs: Long, current: Thread = Thread.currentThread()): Boolean {
    if (thread == null || thread === current) return true
    return try {
        thread.join(timeoutMs)
        !thread.isAlive
    } catch (_: InterruptedException) {
        current.interrupt()
        false
    }
}

/** Bounds a run-scoped fault callback to one signal even when both I/O workers fail together. */
internal class OnceSignal {
    private val signalled = AtomicBoolean(false)
    fun reset() = signalled.set(false)
    fun run(block: () -> Unit): Boolean {
        if (!signalled.compareAndSet(false, true)) return false
        block()
        return true
    }
}
