package org.vodog.gateway

import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration

internal const val CONCURRENT_CAPTURE_PERMISSION =
    "android.permission.BYPASS_CONCURRENT_RECORD_AUDIO_RESTRICTION"

/** Observes only this recorder. No source, routing, mute, BCR, or audio-policy mutations. */
internal class PassiveCaptureDiagnostics(
    private val record: AudioRecord?,
    private val track: String,
    private val callId: String,
    // S94: the bridged-session uplink capture reports as `media.uplink_capture.*`.
    private val diagPrefix: String = "passive_recording",
) : AutoCloseable {
    val stats = PassiveCaptureStats() // Owned by the capture thread, never by the callback.
    private val sessionId = record?.audioSessionId
    private var closed = false
    private var registered = false
    private var configurationSeen = false
    private val health = PassiveCaptureHealth()
    private var recordingStarted = false
    private var configurationErrors = 0L
    private val callback = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
            runCatching {
                observe(configs.firstOrNull { it.clientAudioSessionId == sessionId }, "callback")
            }.onFailure { diagnosticFailure("callback") }
        }
    }

    fun attach() {
        val sourceRecord = record ?: return
        runCatching {
            sourceRecord.registerAudioRecordingCallback(GatewayDiag.executor(), callback)
            registered = true
        }.onFailure { diagnosticFailure("register") }
    }

    @Synchronized
    fun started() { recordingStarted = true }

    @Synchronized
    fun isSilenced(): Boolean = health.silenced == true

    @Synchronized
    fun isIncomplete(): Boolean = health.incomplete

    @Synchronized
    fun observedRead() { health.read() }

    /** Poll as well: a blocked diag uploader must not hide silencing from the final summary. */
    fun poll() {
        val sourceRecord = record ?: return
        runCatching { observe(sourceRecord.activeRecordingConfiguration, "poll") }
            .onFailure { diagnosticFailure("poll") }
    }

    @Synchronized
    private fun observe(config: AudioRecordingConfiguration?, via: String) {
        if (closed) return
        // Null means unavailable/unknown, never proof that Android unsilenced this source.
        val silenced = config?.isClientSilenced
        val changed = !configurationSeen || health.silenced != silenced
        health.observe(silenced)
        if (!changed) return
        configurationSeen = true
        GatewayDiag.log("$diagPrefix.config", mapOf(
            "track" to track, "sessionId" to sessionId, "via" to via,
            "configurationKnown" to (config != null), "silenced" to silenced,
            "source" to config?.clientAudioSource,
            "clientSampleRate" to config?.clientFormat?.sampleRate,
            "deviceSampleRate" to config?.format?.sampleRate,
        ), callId = callId, level = if (silenced == true) "warn" else "info")
    }

    @Synchronized
    private fun diagnosticFailure(phase: String) {
        if (closed) return
        configurationErrors++
        if (phase == "poll" || phase == "callback") health.observe(null)
        if (configurationErrors == 1L) GatewayDiag.log("$diagPrefix.diagnostic_failed",
            mapOf("track" to track, "phase" to phase, "sessionId" to sessionId),
            callId = callId, level = "warn")
    }

    @Synchronized
    fun report(final: Boolean, terminalState: String) {
        runCatching {
            GatewayDiag.log("$diagPrefix.stats", stats.fields() + mapOf(
                "track" to track, "sessionId" to sessionId, "final" to final,
                "terminalState" to terminalState, "available" to (record != null),
                "recordingStarted" to recordingStarted,
                "configurationKnown" to (health.silenced != null), "silenced" to health.silenced,
                "everSilenced" to health.everSilenced, "unknownConfigReads" to health.unknownReads,
                "configurationErrors" to configurationErrors,
            ), callId = callId, level = if (health.incomplete) "warn" else "info")
        }
    }

    override fun close() {
        synchronized(this) { closed = true }
        if (registered) runCatching { record?.unregisterAudioRecordingCallback(callback) }
    }
}
