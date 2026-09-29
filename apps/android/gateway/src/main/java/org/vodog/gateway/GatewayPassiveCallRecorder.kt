package org.vodog.gateway

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import org.vodog.gateway.media.MediaCaptureRequest
import org.vodog.gateway.media.parseCaptureBinding
import java.util.concurrent.atomic.AtomicBoolean

/**
 * S38 §4 被动录音 — the recording leg of a call the user dialled on the Pixel itself.
 *
 * Such a call has no remote VoDog party, so [isExactNonTerminalCall] deliberately skips it
 * and no WebRTC media session is ever built: nothing else would record it. This captures VOICE_DOWNLINK
 * (the far end, the same source [BcpTelephonyAudioEndpoint] already proves on this Pixel) into
 * `remote_original` and, when the HAL grants it, VOICE_UPLINK (the user's own voice) into
 * `caller_original`, straight into the ordinary recording directory so [GatewayRecordingArchiveOwner]
 * uploads it with no changes at all. VOICE_CALL was tried first and produced all-zero audio on the
 * Pixel 7 Pro (S38 acceptance, two calls); an unavailable uplink source falls back to silence so the
 * two-track shape the manifest and the three clients understand is always kept.
 *
 * It is strictly observational: it never touches Telecom, never acquires or releases the legacy audio
 * handoff, and every failure is one diag row. The cellular call must never be disturbed by it, and
 * Control refusing the capture binding (503 feature off / 409 not active) is the kill switch.
 */
internal object GatewayPassiveCallRecorder {
    private class Session(val deviceCallId: String, val running: AtomicBoolean, val thread: Thread)

    private var session: Session? = null
    private val starting = AtomicBoolean(false)
    private val attemptedAtMs = mutableMapOf<String, Long>()

    /** True while a passive capture thread is running; the archive loop must stay busy meanwhile. */
    @Synchronized fun active(): Boolean = session?.thread?.isAlive == true

    /** Heartbeat entry point. Never throws into the heartbeat cycle. */
    fun reconcile(context: Context, api: GatewayApi, confirmedActiveCallIds: Set<String>) {
        runCatching { reconcileNow(context, api, confirmedActiveCallIds) }.onFailure { failed("reconcile", it) }
    }

    /**
     * Terminal Telecom callback entry point. It only flips a flag: closing WAV files, hashing them
     * and writing the manifest all happen on the capture thread, never on the InCallService thread.
     */
    fun requestStop(deviceCallId: String) = synchronized(this) {
        session?.takeIf { it.deviceCallId == deviceCallId }?.running?.set(false)
        Unit
    }

    private fun reconcileNow(context: Context, api: GatewayApi, confirmedActiveCallIds: Set<String>) {
        val target = passiveTarget(context)
        val startable = synchronized(this) {
            val live = session?.takeIf { it.thread.isAlive }
            session = live
            when {
                live != null -> {
                    // The journal is the safety net for a terminal callback that never arrived.
                    if (target?.deviceCallId != live.deviceCallId) live.running.set(false)
                    null
                }
                target == null -> null
                // Telecom may advance the local journal after this heartbeat sent DIALING.
                // Do not burn the 10s retry budget before Control has accepted ACTIVE.
                target.serverCallId !in confirmedActiveCallIds -> null
                !mayAttempt(target.deviceCallId) -> null
                else -> target
            }
        } ?: return
        start(context, api, startable)
    }

    /** Every precondition of S38 §4, read fresh: any of them dropping also stops a running capture. */
    private fun passiveTarget(context: Context): DeviceCallRecord? {
        if (!GatewayRecordingArchiveApproval.APPROVED) return null
        if (!GatewayRuntimeStore(context).enabled) return null
        if (GatewayActiveAudioSession.current() != null) return null
        if (DeviceProtectedAudioHandoffJournal(context).read().phase != AudioHandoffPhase.ACQUIRED) return null
        return DeviceCallJournal(context).recordsForSnapshot().singleOrNull {
            it.deviceOriginated && it.state == DeviceCallState.ACTIVE &&
                it.serverCallId != null && it.creationTimeMillis != null
        }
    }

    /** One capture-binding request per call per 10 s: a refusing control service is not retried hard. */
    private fun mayAttempt(deviceCallId: String): Boolean {
        val now = SystemClock.elapsedRealtime()
        val last = attemptedAtMs[deviceCallId]
        if (last != null && now - last < ATTEMPT_INTERVAL_MS && now >= last) return false
        if (attemptedAtMs.size > MAX_TRACKED_ATTEMPTS) attemptedAtMs.clear()
        attemptedAtMs[deviceCallId] = now
        return true
    }

    /**
     * The capture-binding POST and the WAV/AudioRecord setup all run on the capture thread, never on
     * the heartbeat: that loop also carries `hangup`, and S38 §3 busy rejection must not queue behind
     * a 15 s HTTP timeout while the user is on a phone call.
     */
    private fun start(context: Context, api: GatewayApi, record: DeviceCallRecord) {
        val serverCallId = record.serverCallId ?: return
        val creationTimeMillis = record.creationTimeMillis ?: return
        if (!starting.compareAndSet(false, true)) return
        val running = AtomicBoolean(true)
        val thread = Thread({
            try {
                captureSession(context, api, record.deviceCallId, serverCallId, creationTimeMillis, running)
            } finally {
                synchronized(this) { if (session?.running === running) session = null }
            }
        }, "gateway-passive-recorder").apply { isDaemon = true }
        // Installed before the thread starts so a terminal Telecom callback arriving right now is
        // never lost, and so the archive loop already counts the call as busy during the binding.
        synchronized(this) { session = Session(record.deviceCallId, running, thread) }
        starting.set(false)
        thread.start()
    }

    private fun captureSession(
        context: Context,
        api: GatewayApi,
        deviceCallId: String,
        serverCallId: String,
        creationTimeMillis: Long,
        running: AtomicBoolean,
    ) {
        val opened = try {
            val binding = parseCaptureBinding(
                api.requestCaptureBinding(serverCallId, deviceCallId, creationTimeMillis),
                serverCallId,
                MediaCaptureRequest(deviceCallId, creationTimeMillis),
            )
            // The call may have ended while Control was answering; opening a recorder now would
            // publish an empty archive directory.
            if (!running.get()) return
            check(GatewayInCallAudioBridge.refreshRecordingForeground()) { "microphone foreground unavailable" }
            if (!running.get()) return
            val capture = buildPassiveCapture(MediaRecorder.AudioSource.VOICE_DOWNLINK)
            // The uplink is best effort: the far end is what the user cannot remember.
            val uplink = runCatching { buildPassiveCapture(MediaRecorder.AudioSource.VOICE_UPLINK) }
                .onFailure { failed("uplink", it, serverCallId) }.getOrNull()
            try {
                Triple(capture, uplink, GatewayRecordingStore(context).recorder(serverCallId, binding))
            } catch (error: Exception) {
                runCatching { capture.release() }
                runCatching { uplink?.release() }
                throw error
            }
        } catch (error: Exception) {
            failed("start", error, serverCallId)
            return
        }
        captureLoop(context, opened.first, opened.second, opened.third, running)
    }

    private fun captureLoop(
        context: Context,
        capture: AudioRecord,
        uplinkCapture: AudioRecord?,
        recorder: LocalCallRecorder,
        running: AtomicBoolean,
    ) {
        val buffer = ByteArray(PASSIVE_FRAME_BYTES)
        val uplinkBuffer = ByteArray(PASSIVE_FRAME_BYTES)
        var uplink = uplinkCapture
        var terminalState = "ended"
        var frames = 0L
        val downDiag = PassiveCaptureDiagnostics(capture, "remote_original", recorder.callId)
        val upDiag = PassiveCaptureDiagnostics(uplinkCapture, "caller_original", recorder.callId)
        var nextConfigMs = 0L
        var nextStatsMs = SystemClock.elapsedRealtime() + STATS_INTERVAL_MS
        // The blocking read paces the loop at exactly one 20 ms frame per period, so the frame's own
        // PCM length is the clock: wall-clock stamps jittered past the recorder's 2 ms gap tolerance
        // on every other frame and marked a clean capture "incomplete" (S38 acceptance, gapCount 671).
        val baseUs = SystemClock.elapsedRealtimeNanos() / 1_000
        var elapsedUs = 0L
        try {
            // Permission allowlists are loaded by the system, not by APK installation alone.
            val bypassGranted = context.checkSelfPermission(CONCURRENT_CAPTURE_PERMISSION) ==
                PackageManager.PERMISSION_GRANTED
            GatewayDiag.log("passive_recording.permission", mapOf(
                "concurrentCaptureBypassGranted" to bypassGranted,
                "sdk" to android.os.Build.VERSION.SDK_INT,
            ), callId = recorder.callId, level = if (bypassGranted) "info" else "warn")
            downDiag.attach()
            upDiag.attach()
            capture.startRecording()
            check(capture.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "passive capture did not start" }
            downDiag.started()
            uplink?.let { record ->
                val started = runCatching { record.startRecording(); record.recordingState == AudioRecord.RECORDSTATE_RECORDING }
                    .getOrDefault(false)
                if (!started) {
                    failed("uplink", IllegalStateException("VOICE_UPLINK did not start"), recorder.callId)
                    upDiag.close()
                    runCatching { record.release() }
                    uplink = null
                } else upDiag.started()
            }
            // S49: now means startRecording succeeded, not merely AudioRecord construction.
            GatewayDiag.log("passive_recording.started", mapOf(
                "uplink" to (uplink != null), "downlinkSessionId" to capture.audioSessionId,
                "uplinkSessionId" to uplink?.audioSessionId,
                "concurrentCaptureBypassGranted" to bypassGranted,
            ), callId = recorder.callId)
            while (running.get()) {
                // A gateway switched off while the cellular call continues must not keep recording,
                // and this thread outlives the heartbeat that would otherwise notice.
                if (frames % FRAMES_PER_ENABLED_CHECK == 0L && !GatewayRuntimeStore(context).enabled) break
                val nowMs = SystemClock.elapsedRealtime()
                if (nowMs >= nextConfigMs) {
                    downDiag.poll()
                    if (uplink != null) upDiag.poll()
                    nextConfigMs = nowMs + CONFIG_INTERVAL_MS
                }
                if (nowMs >= nextStatsMs) {
                    downDiag.report(final = false, terminalState = "recording")
                    upDiag.report(final = false, terminalState = "recording")
                    nextStatsMs = nowMs + STATS_INTERVAL_MS
                }
                val read = capture.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                downDiag.stats.recordRead(buffer, read, buffer.size)
                if (read > 0) downDiag.observedRead()
                if (read < 0) {
                    terminalState = "incomplete"
                    recorder.markCaptureIncomplete(OriginalAudioTrack.REMOTE_ORIGINAL)
                    break
                }
                if (read == 0) continue
                val pcm = buffer.copyOf(read - read % 2)
                if (pcm.isEmpty()) continue
                val timestampUs = baseUs + elapsedUs
                elapsedUs += pcm.size * 1_000_000L / (PASSIVE_SAMPLE_RATE * 2L)
                recorder.append(OriginalAudioTrack.REMOTE_ORIGINAL, pcm, timestampUs)
                if (downDiag.isSilenced()) recorder.markCaptureGapDuration(
                    OriginalAudioTrack.REMOTE_ORIGINAL, timestampUs, pcmDurationUs(pcm.size),
                )
                // Same period, same length: the downlink read paced this frame, so the uplink stream
                // already holds it. Anything short is padded with silence to keep the tracks aligned.
                val caller = ByteArray(pcm.size)
                var copied = 0
                uplink?.let { record ->
                    val got = record.read(uplinkBuffer, 0, pcm.size, AudioRecord.READ_NON_BLOCKING)
                    upDiag.stats.recordRead(uplinkBuffer, got, pcm.size)
                    if (got > 0) upDiag.observedRead()
                    if (got > 0) {
                        copied = minOf(got, pcm.size) - (minOf(got, pcm.size) % 2)
                        System.arraycopy(uplinkBuffer, 0, caller, 0, copied)
                    }
                }
                upDiag.stats.recordPadding(pcm.size - copied)
                recorder.append(OriginalAudioTrack.CALLER_ORIGINAL, caller, timestampUs)
                // Genuine quiet PCM is valid. Only platform-confirmed silencing or missing bytes
                // invalidate capture; use the existing duration-gap contract for the affected span.
                val lostBytes = if (upDiag.isSilenced()) pcm.size else pcm.size - copied
                if (lostBytes > 0) recorder.markCaptureGapDuration(
                    OriginalAudioTrack.CALLER_ORIGINAL,
                    timestampUs + pcmDurationUs(pcm.size - lostBytes), pcmDurationUs(lostBytes),
                )
                frames++
            }
        } catch (error: Exception) {
            terminalState = "incomplete"
            failed("capture", error, recorder.callId)
        } finally {
            downDiag.poll()
            if (uplink != null) upDiag.poll()
            downDiag.close()
            upDiag.close()
            downDiag.report(final = true, terminalState = terminalState)
            upDiag.report(final = true, terminalState = terminalState)
            runCatching { capture.stop() }
            runCatching { capture.release() }
            runCatching { uplink?.stop() }
            runCatching { uplink?.release() }
            runCatching {
                // A callback may arrive between PCM reads. Preserve confirmed loss without
                // inventing its duration, even if a later config poll returns null.
                if (downDiag.isIncomplete()) recorder.markCaptureIncomplete(OriginalAudioTrack.REMOTE_ORIGINAL)
                if (upDiag.isIncomplete()) recorder.markCaptureIncomplete(OriginalAudioTrack.CALLER_ORIGINAL)
                recorder.finish(terminalState)
            }
                .onFailure { failed("finish", it, recorder.callId) }
        }
    }

    private fun pcmDurationUs(bytes: Int): Long = bytes * 1_000_000L / (PASSIVE_SAMPLE_RATE * 2L)

    @SuppressLint("MissingPermission")
    private fun buildPassiveCapture(source: Int): AudioRecord {
        val min = AudioRecord.getMinBufferSize(
            PASSIVE_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        check(min > 0) { "AudioRecord buffer unavailable: $min" }
        val record = AudioRecord.Builder()
            .setAudioSource(source)
            .setAudioFormat(AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(PASSIVE_SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build())
            .setBufferSizeInBytes(maxOf(min * 2, PASSIVE_FRAME_BYTES * 4))
            .build()
        return try {
            check(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord source $source unavailable" }
            record
        } catch (error: Exception) {
            runCatching { record.release() }
            throw error
        }
    }

    private fun failed(phase: String, error: Throwable, callId: String? = null) {
        runCatching {
            GatewayDiag.log(
                "passive_recording.failed",
                mapOf("phase" to phase, "reason" to (error.message ?: error.javaClass.simpleName).take(120)),
                callId = callId,
                level = "warn",
            )
        }
    }

    private const val PASSIVE_SAMPLE_RATE = 16_000
    private const val PASSIVE_FRAME_BYTES = 640
    private const val CONFIG_INTERVAL_MS = 1_000L
    private const val STATS_INTERVAL_MS = 10_000L
    private const val ATTEMPT_INTERVAL_MS = 10_000L
    private const val FRAMES_PER_ENABLED_CHECK = 50L
    private const val MAX_TRACKED_ATTEMPTS = 32
}
