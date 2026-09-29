/*
 * Adapted from BCP CaptureThread.kt and InjectPcmThread.kt.
 * Original project: Basic Call Player by chenxiaolong.
 * Upstream: https://github.com/chenxiaolong/BCP
 * Modifications for VoDog: 2026-09-09.
 * SPDX-License-Identifier: GPL-3.0-only
 */
package org.vodog.gateway

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Privileged same-process telephony PCM endpoint. It never answers, dials, mutes, or starts itself.
 * A future authoritative call-state owner may start it only after ACTIVE and must always close it.
 */
class BcpTelephonyAudioEndpoint(
    context: Context,
    // S56: an early-media leg starts capture only; [arm] adds the uplink AudioTrack and the watchdog at ACTIVE.
    private val earlyMedia: Boolean = false,
) : TelephonyAudioEndpoint {
    private val context = context.applicationContext
    private val lifecycleLock = Any()
    private val running = AtomicBoolean(false)
    private val failureSignal = OnceSignal()
    private val capture = AtomicReference<AudioRecord?>()
    private val playback = AtomicReference<AudioTrack?>()
    private val captureThread = AtomicReference<Thread?>()
    private val playbackThread = AtomicReference<Thread?>()
    /** S36 C3: zero-length downlink reads since the last stop, reported as the capture-side overrun. */
    private val captureStalls = java.util.concurrent.atomic.AtomicLong()
    @Volatile private var failureCallback: (TelephonyAudioEndpoint.Failure) -> Unit = {}
    @Volatile private var watchdog: ZeroPcmWatchdog? = null
    @Volatile private var uplinkSupplier: (() -> ByteArray?)? = null
    @Volatile private var heardAudio = false
    @Volatile private var actualCaptureRate: Int? = null

    override fun captureSampleRate(): Int? = actualCaptureRate

    override val capability: TelephonyAudioEndpoint.Capability
        get() {
            val missing = REQUIRED_PERMISSIONS.filter {
                ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
            }
            if (missing.isNotEmpty()) {
                return TelephonyAudioEndpoint.Capability.Unavailable("缺少特权/录音权限：${missing.joinToString()}")
            }
            val telephony = context.getSystemService(AudioManager::class.java)
                .getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type == AudioDeviceInfo.TYPE_TELEPHONY }
            return if (telephony) TelephonyAudioEndpoint.Capability.Ready
            else TelephonyAudioEndpoint.Capability.Unavailable("系统未提供 TYPE_TELEPHONY 输出设备")
        }

    // Both Android audio objects are synchronously initialized and started before success is returned.
    @SuppressLint("MissingPermission")
    override fun start(
        onDownlinkPcm: (ByteArray, Long) -> Unit,
        nextUplinkPcm: () -> ByteArray?,
        onFailure: (TelephonyAudioEndpoint.Failure) -> Unit,
    ): Result<Unit> {
        var cleanupRequired = false
        val result = runCatching {
            synchronized(lifecycleLock) {
                check(
                    !running.get() && capture.get() == null && playback.get() == null &&
                        captureThread.get() == null && playbackThread.get() == null,
                ) {
                    "telephony endpoint already running"
                }
                failureCallback = onFailure
                failureSignal.reset()
                cleanupRequired = true
                check(capability == TelephonyAudioEndpoint.Capability.Ready) {
                    "telephony audio capability unavailable"
                }

                val record = buildCapture()
                capture.set(record)
                val track = if (earlyMedia) null else try {
                    buildPlayback()
                } catch (error: Exception) {
                    releaseCapture(record)
                    throw error
                }
                playback.set(track)
                try {
                    record.startRecording()
                    check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                        "VOICE_DOWNLINK did not enter RECORDSTATE_RECORDING"
                    }
                    track?.play()
                    check(track == null || track.playState == AudioTrack.PLAYSTATE_PLAYING) {
                        "telephony AudioTrack did not enter PLAYSTATE_PLAYING"
                    }
                } catch (error: Exception) {
                    track?.let(::releasePlayback)
                    releaseCapture(record)
                    throw error
                }

                running.set(true)
                heardAudio = false
                watchdog = if (earlyMedia) null else ZeroPcmWatchdog()
                uplinkSupplier = nextUplinkPcm
                val captureWorker = Thread(
                    { captureLoop(record, onDownlinkPcm) }, "VoDog.telephony.capture",
                )
                val playbackWorker = track?.let {
                    Thread({ playbackLoop(it, nextUplinkPcm) }, "VoDog.telephony.playback")
                }
                captureThread.set(captureWorker)
                playbackThread.set(playbackWorker)
                try {
                    captureWorker.start()
                    if (playbackWorker != null) playbackWorker.start()
                } catch (error: Exception) {
                    running.set(false)
                    unblockIo()
                    captureWorker.interrupt()
                    playbackWorker?.interrupt()
                    throw error
                }
            }
        }
        GatewayDiag.log("audio.endpoint", mapOf("phase" to "start", "ok" to result.isSuccess, "reason" to result.exceptionOrNull()?.message?.take(120)), level = if (result.isSuccess) "info" else "error")
        if (result.isFailure) {
            if (cleanupRequired) {
                reportFailure(
                    TelephonyAudioEndpoint.Failure.Stage.INITIALIZATION,
                    TelephonyAudioEndpoint.Failure.Code.INITIALIZATION_FAILED,
                )
                stopAndRelease()
            } else runCatching {
                onFailure(TelephonyAudioEndpoint.Failure(
                    TelephonyAudioEndpoint.Failure.Stage.INITIALIZATION,
                    TelephonyAudioEndpoint.Failure.Code.INITIALIZATION_FAILED,
                ))
            }
        }
        return result
    }

    @SuppressLint("MissingPermission")
    private fun buildCapture(): AudioRecord {
        val min = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        check(min > 0) { "AudioRecord buffer unavailable: $min" }
        val record = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_DOWNLINK)
            .setAudioFormat(audioFormat(AudioFormat.CHANNEL_IN_MONO))
            .setBufferSizeInBytes(maxOf(min * 2, FRAME_BYTES * 4))
            .build()
        return try {
            check(record.state == AudioRecord.STATE_INITIALIZED) { "VOICE_DOWNLINK AudioRecord unavailable" }
            actualCaptureRate = runCatching { record.format.sampleRate }.getOrNull() ?: record.sampleRate
            record
        } catch (error: Exception) {
            runCatching { record.release() }
            throw error
        }
    }

    private fun buildPlayback(): AudioTrack {
        val telephony = context.getSystemService(AudioManager::class.java)
            .getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_TELEPHONY }
            ?: error("TYPE_TELEPHONY disappeared during startup")
        val min = AudioTrack.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        check(min > 0) { "AudioTrack buffer unavailable: $min" }
        val track = AudioTrack.Builder()
            .setBufferSizeInBytes(maxOf(min, FRAME_BYTES * 2))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).build(),
            )
            .setAudioFormat(audioFormat(AudioFormat.CHANNEL_OUT_MONO))
            .build()
        return try {
            check(track.state == AudioTrack.STATE_INITIALIZED) { "telephony AudioTrack unavailable" }
            check(track.setPreferredDevice(telephony)) { "failed to route to TYPE_TELEPHONY" }
            track
        } catch (error: Exception) {
            runCatching { track.release() }
            throw error
        }
    }

    private fun captureLoop(initial: AudioRecord, onPcm: (ByteArray, Long) -> Unit) {
        urgentAudioPriority()
        var record = initial
        val readBuffer = ByteArray(FRAME_BYTES)
        val frames = PcmFrameAccumulator(FRAME_BYTES)
        try {
            while (running.get()) {
                val count = record.read(readBuffer, 0, readBuffer.size, AudioRecord.READ_BLOCKING)
                if (count < 0) throw EndpointLoopException(TelephonyAudioEndpoint.Failure.Code.IO_FAILED)
                if (count == 0) {
                    // S36 C3 "overruns": the downlink produced nothing this read, i.e. capture stalled.
                    captureStalls.incrementAndGet()
                    pauseAfterZeroProgress()
                    continue
                }
                // S41 §决策2: a downlink that is all-zero from its first sample never opened; the
                // recorder is rebuilt in place, the WebRTC session is left alone. Zeros after any
                // real audio are ordinary silence on this device and disarm the watchdog for good.
                val allZero = isAllZeroPcm(readBuffer, count)
                if (!allZero && !heardAudio) heardAudio = true
                val decision = watchdog?.onRead(allZero, pcmDurationMs(count))
                if (decision != null && (decision.action == ZeroPcmAction.RESTART || decision.action == ZeroPcmAction.REPORT)) {
                    GatewayDiag.log("audio.endpoint", mapOf(
                        "phase" to "zero_pcm", "zeroMs" to decision.zeroMs, "restarts" to decision.restarts,
                    ), level = "warn")
                }
                if (decision?.action == ZeroPcmAction.RESTART) record = restartCapture(record) ?: break
                frames.append(readBuffer, 0, count) { frame ->
                    try {
                        onPcm(frame, SystemClock.elapsedRealtimeNanos() / 1_000)
                    } catch (_: Exception) {
                        throw EndpointLoopException(TelephonyAudioEndpoint.Failure.Code.CALLBACK_FAILED)
                    }
                }
            }
        } catch (_: InterruptedException) {
            if (running.get()) failLoop(
                TelephonyAudioEndpoint.Failure.Stage.CAPTURE,
                TelephonyAudioEndpoint.Failure.Code.IO_FAILED,
            )
            Thread.currentThread().interrupt()
        } catch (error: EndpointLoopException) {
            failLoop(TelephonyAudioEndpoint.Failure.Stage.CAPTURE, error.code)
        } catch (_: Exception) {
            failLoop(TelephonyAudioEndpoint.Failure.Stage.CAPTURE, TelephonyAudioEndpoint.Failure.Code.IO_FAILED)
        } finally {
            frames.discardPartial()
            running.set(false)
            unblockIo()
            releaseCapture(record)
            captureThread.compareAndSet(Thread.currentThread(), null)
        }
    }

    /**
     * Replaces the capture object with an identical one. Returns null when teardown already started,
     * in which case the loop simply ends; a build or start failure takes the existing failure path.
     */
    @SuppressLint("MissingPermission")
    private fun restartCapture(previous: AudioRecord): AudioRecord? = synchronized(lifecycleLock) {
        if (!running.get()) return@synchronized null
        releaseCapture(previous)
        val fresh = try {
            buildCapture()
        } catch (_: Exception) {
            throw EndpointLoopException(TelephonyAudioEndpoint.Failure.Code.IO_FAILED)
        }
        capture.set(fresh)
        try {
            fresh.startRecording()
            check(fresh.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                "VOICE_DOWNLINK did not re-enter RECORDSTATE_RECORDING"
            }
        } catch (_: Exception) {
            releaseCapture(fresh)
            throw EndpointLoopException(TelephonyAudioEndpoint.Failure.Code.IO_FAILED)
        }
        fresh
    }

    private fun playbackLoop(track: AudioTrack, nextPcm: () -> ByteArray?) {
        urgentAudioPriority()
        try {
            // S70: fill the track buffer with silence first. WRITE_BLOCKING returns at once until the
            // buffer is full, so without this the first pulls would drain the jitter buffer in a burst;
            // after it every pull is paced by the telephony clock.
            val prefill = ByteArray(maxOf(0, track.bufferSizeInFrames - FRAME_BYTES / 2) * 2)
            if (prefill.isNotEmpty()) track.write(prefill, 0, prefill.size, AudioTrack.WRITE_NON_BLOCKING)
            while (running.get()) {
                val frame = try {
                    nextPcm() ?: SILENCE
                } catch (_: Exception) {
                    throw EndpointLoopException(TelephonyAudioEndpoint.Failure.Code.CALLBACK_FAILED)
                }
                if (frame.size != FRAME_BYTES) {
                    throw EndpointLoopException(TelephonyAudioEndpoint.Failure.Code.CALLBACK_FAILED)
                }
                writePcmFrameFully(
                    frame = frame,
                    shouldContinue = running::get,
                    write = { offset, length -> track.write(frame, offset, length, AudioTrack.WRITE_BLOCKING) },
                    onZeroProgress = ::pauseAfterZeroProgress,
                )
            }
        } catch (_: InterruptedException) {
            if (running.get()) failLoop(
                TelephonyAudioEndpoint.Failure.Stage.PLAYBACK,
                TelephonyAudioEndpoint.Failure.Code.IO_FAILED,
            )
            Thread.currentThread().interrupt()
        } catch (error: EndpointLoopException) {
            failLoop(TelephonyAudioEndpoint.Failure.Stage.PLAYBACK, error.code)
        } catch (_: Exception) {
            failLoop(TelephonyAudioEndpoint.Failure.Stage.PLAYBACK, TelephonyAudioEndpoint.Failure.Code.IO_FAILED)
        } finally {
            running.set(false)
            unblockIo()
            releasePlayback(track)
            playbackThread.compareAndSet(Thread.currentThread(), null)
        }
    }

    private fun failLoop(stage: TelephonyAudioEndpoint.Failure.Stage, code: TelephonyAudioEndpoint.Failure.Code) {
        running.set(false)
        reportFailure(stage, code)
        unblockIo()
    }

    private fun reportFailure(
        stage: TelephonyAudioEndpoint.Failure.Stage,
        code: TelephonyAudioEndpoint.Failure.Code,
    ) {
        failureSignal.run {
            runCatching { failureCallback(TelephonyAudioEndpoint.Failure(stage, code)) }
        }
    }

    /** S56 ACTIVE: a fresh 3000 ms watchdog unless early audio already proved capture, then the same uplink AudioTrack a normal start builds. */
    override fun arm() {
        val result = runCatching {
            synchronized(lifecycleLock) {
                if (!running.get() || playback.get() != null) return
                watchdog = zeroPcmWatchdogAtArm(heardAudio)
                val track = buildPlayback()
                playback.set(track)
                track.play()
                check(track.playState == AudioTrack.PLAYSTATE_PLAYING) { "telephony AudioTrack did not enter PLAYSTATE_PLAYING" }
                val supplier = checkNotNull(uplinkSupplier)
                val worker = Thread({ playbackLoop(track, supplier) }, "VoDog.telephony.playback")
                playbackThread.set(worker)
                worker.start()
            }
        }
        GatewayDiag.log("audio.endpoint", mapOf("phase" to "arm", "ok" to result.isSuccess, "reason" to result.exceptionOrNull()?.message?.take(120)), level = if (result.isSuccess) "info" else "error")
        if (result.isFailure) {
            playback.get()?.let(::releasePlayback)
            failLoop(TelephonyAudioEndpoint.Failure.Stage.PLAYBACK, TelephonyAudioEndpoint.Failure.Code.INITIALIZATION_FAILED)
        }
    }

    override fun stopAndRelease() {
        val captureWorker: Thread?
        val playbackWorker: Thread?
        synchronized(lifecycleLock) {
            running.set(false)
            captureWorker = captureThread.get()
            playbackWorker = playbackThread.get()
            unblockIo()
            captureWorker?.interrupt()
            playbackWorker?.interrupt()
        }
        val current = Thread.currentThread()
        val captureStopped = joinUnlessCurrent(captureWorker, JOIN_TIMEOUT_MS, current)
        val playbackStopped = joinUnlessCurrent(playbackWorker, JOIN_TIMEOUT_MS, current)
        // S36 C3: read before release, or the AudioTrack is gone and the count with it. A teardown
        // that had nothing running is not an endpoint stop and is not logged.
        val underruns = playback.get()?.let { runCatching { it.underrunCount }.getOrNull() }
        if (captureWorker != null || playbackWorker != null) GatewayDiag.log("audio.endpoint", mapOf("phase" to "stop", "underruns" to underruns, "overruns" to captureStalls.getAndSet(0L), "captureStopped" to captureStopped, "playbackStopped" to playbackStopped))
        capture.get()?.let(::releaseCapture)
        playback.get()?.let(::releasePlayback)
        if (captureStopped && captureWorker !== current) captureThread.compareAndSet(captureWorker, null)
        if (playbackStopped && playbackWorker !== current) playbackThread.compareAndSet(playbackWorker, null)
    }

    private fun unblockIo() {
        capture.get()?.let { runCatching { it.stop() } }
        playback.get()?.let { runCatching { it.pause() } }
    }

    private fun releaseCapture(record: AudioRecord) {
        if (capture.compareAndSet(record, null)) {
            runCatching { record.stop() }
            runCatching { record.release() }
        }
    }

    private fun releasePlayback(track: AudioTrack) {
        if (playback.compareAndSet(track, null)) {
            runCatching { track.stop() }
            runCatching { track.release() }
        }
    }

    /** S70: both telephony loops run at audio priority; the scheduler must not starve the clock. */
    private fun urgentAudioPriority() {
        runCatching { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO) }
    }

    @Throws(InterruptedException::class)
    private fun pauseAfterZeroProgress() = Thread.sleep(ZERO_IO_BACKOFF_MS)

    private fun audioFormat(channelMask: Int) = AudioFormat.Builder()
        .setSampleRate(SAMPLE_RATE)
        .setChannelMask(channelMask)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .build()

    private class EndpointLoopException(val code: TelephonyAudioEndpoint.Failure.Code) : RuntimeException()

    companion object {
        internal const val SAMPLE_RATE = 16_000
        private const val FRAME_BYTES = 640
        private const val JOIN_TIMEOUT_MS = 1_500L
        private const val ZERO_IO_BACKOFF_MS = 5L
        private val SILENCE = ByteArray(FRAME_BYTES)
        private val REQUIRED_PERMISSIONS = listOf(
            Manifest.permission.RECORD_AUDIO,
            "android.permission.CAPTURE_AUDIO_OUTPUT",
            "android.permission.MODIFY_PHONE_STATE",
        )
    }
}

/**
 * S56: S41 only guards a downlink dead from its first sample. A non-zero early-media sample already
 * proved this capture alive, so a callee silent for 3 s after answering must not restart it.
 */
internal fun zeroPcmWatchdogAtArm(heardAudio: Boolean): ZeroPcmWatchdog? = if (heardAudio) null else ZeroPcmWatchdog()

internal enum class ZeroPcmAction { NONE, RESTART, REPORT, QUIET }

internal data class ZeroPcmDecision(val action: ZeroPcmAction, val zeroMs: Long, val restarts: Int)

internal fun isAllZeroPcm(buffer: ByteArray, count: Int): Boolean {
    for (index in 0 until count) if (buffer[index] != 0.toByte()) return false
    return true
}

internal fun pcmDurationMs(byteCount: Int): Long =
    byteCount * 1_000L / (2 * BcpTelephonyAudioEndpoint.SAMPLE_RATE)

/**
 * S41 §决策2. Guards the one failure that was actually observed: a downlink that is all-zero from its
 * very first sample and never opens. Armed only until the first non-zero read of the endpoint's
 * lifetime; while armed, [thresholdMs] of digital silence rebuilds the recorder up to [maxRestarts]
 * times, then reports once more and stays quiet. A restart does not count as audio, so it stays armed.
 *
 * ponytail: measured on this Pixel (S41, two bridged 10010 calls) the cellular downlink reads
 * bit-exact zeros during ordinary silence - IVR pauses tripped the earlier "zeros anywhere" rule on
 * healthy calls. So the heuristic only covers "dead from the start" and is deliberately blind to a
 * downlink that dies mid-call; catching that needs an energy/held-silence measure, not exact zeros.
 */
internal class ZeroPcmWatchdog(
    private val thresholdMs: Long = 3_000L,
    private val maxRestarts: Int = 2,
) {
    private var zeroMs = 0L
    private var restarts = 0
    private var armed = true
    private var capReported = false

    fun onRead(allZero: Boolean, durationMs: Long): ZeroPcmDecision {
        if (!armed) return ZeroPcmDecision(ZeroPcmAction.NONE, 0L, restarts)
        if (!allZero) {
            armed = false
            return ZeroPcmDecision(ZeroPcmAction.NONE, 0L, restarts)
        }
        zeroMs += durationMs
        if (zeroMs < thresholdMs) return ZeroPcmDecision(ZeroPcmAction.NONE, zeroMs, restarts)
        val run = zeroMs
        zeroMs = 0L
        return when {
            restarts < maxRestarts -> ZeroPcmDecision(ZeroPcmAction.RESTART, run, ++restarts)
            !capReported -> { capReported = true; ZeroPcmDecision(ZeroPcmAction.REPORT, run, restarts) }
            else -> ZeroPcmDecision(ZeroPcmAction.QUIET, run, restarts)
        }
    }
}
