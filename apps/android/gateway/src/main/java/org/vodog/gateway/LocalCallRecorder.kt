package org.vodog.gateway

import android.content.Context
import org.vodog.gateway.media.MediaCaptureBinding
import java.io.Closeable
import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

enum class OriginalAudioTrack(val fileStem: String) {
    /** The cellular peer captured from VOICE_DOWNLINK. */
    REMOTE_ORIGINAL("remote_original"),
    /** The remote VoDog user, recorded after decode and before telephony injection. */
    CALLER_ORIGINAL("caller_original"),
}

enum class DerivedAudioTrack(val fileStem: String) {
    /** Decoded caller playout, including any explicitly labelled FEC/PLC synthesis. */
    CALLER_PLAYOUT("caller_playout"),
}

data class TrackRecordingResult(
    val fileName: String,
    val bytes: Long,
    val sha256: String,
    val pcmBytes: Long,
    val gapCount: Long,
    val droppedFrames: Long,
    val captureComplete: Boolean,
)

data class DerivedTrackRecordingResult(
    val fileName: String,
    val bytes: Long,
    val sha256: String,
    val pcmBytes: Long,
    val gapCount: Long,
    val recoveryFrames: Long,
    val playoutComplete: Boolean,
)

data class LocalRecordingManifest(
    val callId: String,
    val terminalState: String,
    val startedAt: String,
    val endedAt: String,
    val tracks: Map<OriginalAudioTrack, TrackRecordingResult>,
    val derivedTracks: Map<DerivedAudioTrack, DerivedTrackRecordingResult> = emptyMap(),
    val sessionStats: Map<String, Long> = emptyMap(),
    val timelineBytes: Long = 0,
    val timelineSha256: String = "",
    val captureBinding: MediaCaptureBinding? = null,
)

object GatewayRecordingArchiveApproval { const val APPROVED = BuildConfig.RECORDING_ARCHIVE_ENABLED }

class GatewayRecordingStore(context: Context) {
    private val root = File(context.createDeviceProtectedStorageContext().filesDir, "call-recordings")
        .also { check(it.mkdirs() || it.isDirectory) }
    fun recorder(callId: String, captureBinding: MediaCaptureBinding? = null) =
        LocalCallRecorder(root, callId, captureBinding)
    internal fun rootDirectory(): File = root
    fun recoverIncomplete() = LocalCallRecorder.recoverIncomplete(root)
}

/** Thread-confined crash-recoverable PCM WAV writer. Caller numbers are never used in paths/logs. */
class LocalCallRecorder(
    root: File,
    val callId: String,
    val captureBinding: MediaCaptureBinding? = null,
    private val wallClock: () -> Instant = Instant::now,
) : Closeable {
    private val directory: File
    private val timeline: RandomAccessFile
    private val tracks: Map<OriginalAudioTrack, WavTrack>
    private var callerPlayout: WavTrack? = null
    private val startedAt = wallClock().toString()
    private var closed = false

    init {
        require(UUID.fromString(callId).toString() == callId.lowercase()) { "callId must be canonical UUID" }
        directory = File(root, callId).also { dir ->
            val created = dir.mkdirs()
            if (created) syncDirectory(root)
            val reusableCapture = dir.isDirectory && captureBinding != null &&
                dir.listFiles().orEmpty().all { it.name == CAPTURE_FILE }
            check(!java.nio.file.Files.isSymbolicLink(dir.toPath()) && (created || reusableCapture)) {
                "recording directory already contains data"
            }
        }
        captureBinding?.let { persistCaptureBinding(directory, callId, it) }
        val opened = linkedMapOf<OriginalAudioTrack, WavTrack>()
        var openedTimeline: RandomAccessFile? = null
        try {
            OriginalAudioTrack.entries.forEach { opened[it] = WavTrack(File(directory, "${it.fileStem}.wav.part")) }
            openedTimeline = RandomAccessFile(File(directory, "timeline.jsonl.part"), "rw").apply {
                seek(length()); writeUtf8("{\"event\":\"start\",\"timestampUs\":0}\n")
            }
        } catch (error: Exception) {
            opened.values.forEach { runCatching { it.abort() } }
            runCatching { openedTimeline?.close() }
            throw error
        }
        tracks = opened
        timeline = requireNotNull(openedTimeline)
    }

    fun append(track: OriginalAudioTrack, pcm16le: ByteArray, timestampUs: Long, sourceTimestampUs: Long? = null) {
        check(!closed); require(timestampUs >= 0 && pcm16le.isNotEmpty() && pcm16le.size % 2 == 0)
        val writer = requireNotNull(tracks[track])
        recordTimelineGap(writer, track.fileStem, timestampUs)
        val offset = writer.append(pcm16le)
        timeline.writeUtf8("{\"event\":\"frame\",\"track\":\"${track.fileStem}\",\"timestampUs\":$timestampUs,\"sourceTimestampUs\":${sourceTimestampUs ?: "null"},\"fileOffset\":$offset,\"sampleCount\":${pcm16le.size / 2}}\n")
        writer.nextTimestampUs = timestampUs + pcm16le.size * 1_000_000L / BYTES_PER_SECOND
    }

    fun appendPlayout(
        pcm16le: ByteArray,
        timelineUs: Long,
        sourceTimestampUs: Long?,
        recoveryKind: String?,
    ) {
        check(!closed); require(timelineUs >= 0 && pcm16le.isNotEmpty() && pcm16le.size % 2 == 0)
        require(recoveryKind == null || recoveryKind in RECOVERY_KINDS)
        val track = DerivedAudioTrack.CALLER_PLAYOUT
        val writer = callerPlayout ?: WavTrack(File(directory, "${track.fileStem}.wav.part"))
            .also { callerPlayout = it }
        recordTimelineGap(writer, track.fileStem, timelineUs)
        val offset = writer.append(pcm16le)
        if (recoveryKind != null) writer.recoveryFrames++
        val recoveryJson = recoveryKind?.let { ",\"recoveryKind\":\"$it\"" } ?: ""
        timeline.writeUtf8("{\"event\":\"playout_frame\",\"track\":\"${track.fileStem}\",\"timestampUs\":$timelineUs,\"sourceTimestampUs\":${sourceTimestampUs ?: "null"},\"fileOffset\":$offset,\"sampleCount\":${pcm16le.size / 2}$recoveryJson}\n")
        writer.nextTimestampUs = timelineUs + pcm16le.size * 1_000_000L / BYTES_PER_SECOND
    }

    private fun recordTimelineGap(writer: WavTrack, track: String, timestampUs: Long) {
        val expected = writer.nextTimestampUs
        if (expected != null && timestampUs > expected + FRAME_TOLERANCE_US) {
            writer.gapCount++
            timeline.writeUtf8("{\"event\":\"gap\",\"track\":\"$track\",\"timestampUs\":$expected,\"durationUs\":${timestampUs - expected}}\n")
        }
    }

    fun markDropped(track: OriginalAudioTrack, timestampUs: Long, frames: Long = 1) {
        check(!closed); require(frames > 0)
        val writer = requireNotNull(tracks[track]); writer.droppedFrames += frames; writer.gapCount++
        timeline.writeUtf8("{\"event\":\"gap\",\"track\":\"${track.fileStem}\",\"timestampUs\":$timestampUs,\"reason\":\"local_queue_drop\",\"frames\":$frames}\n")
    }

    fun markCaptureGap(
        track: OriginalAudioTrack,
        timestampUs: Long,
        reason: String = MEDIA_BUFFER_DISCARD,
    ) {
        check(!closed); require(timestampUs >= 0 && reason == MEDIA_BUFFER_DISCARD)
        requireNotNull(tracks[track]).gapCount++
        timeline.writeUtf8("{\"event\":\"gap\",\"track\":\"${track.fileStem}\",\"timestampUs\":$timestampUs,\"reason\":\"$MEDIA_BUFFER_DISCARD\"}\n")
    }

    /** S49: lost source samples represented by a known interval of padded or silenced PCM. */
    fun markCaptureGapDuration(track: OriginalAudioTrack, timestampUs: Long, durationUs: Long) {
        check(!closed); require(timestampUs >= 0 && durationUs > 0)
        requireNotNull(tracks[track]).gapCount++
        // Existing v2/v3 duration-gap shape; no new archive-validator reason enum is required.
        timeline.writeUtf8("{\"event\":\"gap\",\"track\":\"${track.fileStem}\",\"timestampUs\":$timestampUs,\"durationUs\":$durationUs}\n")
    }

    /** A platform callback can prove loss without identifying an exact PCM interval. */
    fun markCaptureIncomplete(track: OriginalAudioTrack) {
        check(!closed)
        requireNotNull(tracks[track]).captureInvalidated = true
    }

    fun finish(terminalState: String, sessionStats: Map<String, Long> = emptyMap()): LocalRecordingManifest {
        check(!closed); closed = true
        val endedAt = wallClock().toString()
        val failures = mutableListOf<Throwable>()
        val timelineFile = File(directory, "timeline.jsonl")
        runCatching {
            try {
                timeline.writeUtf8("{\"event\":\"stop\",\"state\":\"${finiteState(terminalState)}\"}\n")
                timeline.fd.sync()
            } finally {
                timeline.close()
            }
            atomicRename(File(directory, "timeline.jsonl.part"), timelineFile)
        }.onFailure(failures::add)
        val results = linkedMapOf<OriginalAudioTrack, TrackRecordingResult>()
        tracks.forEach { (track, writer) -> runCatching { writer.finishOriginal(track) }
            .onSuccess { results[track] = it }.onFailure(failures::add) }
        val derivedResults = linkedMapOf<DerivedAudioTrack, DerivedTrackRecordingResult>()
        callerPlayout?.let { writer -> runCatching { writer.finishDerived(DerivedAudioTrack.CALLER_PLAYOUT) }
            .onSuccess { derivedResults[DerivedAudioTrack.CALLER_PLAYOUT] = it }.onFailure(failures::add) }
        if (failures.isNotEmpty()) throw IllegalStateException("recording finalization failed", failures.first())
        // A transport/codec/endpoint fatal event means the capture ended without an authoritative
        // continuous-media guarantee, even if Telecom reports a normal call end moments later.
        if ((sessionStats["mediaFatalEvents"] ?: 0L) > 0L) {
            results.replaceAll { _, result -> result.copy(captureComplete = false) }
        }
        val manifest = LocalRecordingManifest(callId, finiteState(terminalState), startedAt, endedAt,
            results, derivedResults, sessionStats, timelineFile.length(), sha256(timelineFile), captureBinding)
        writeManifest(directory, manifest)
        return manifest
    }

    override fun close() {
        if (closed) return
        runCatching { finish("incomplete") }
    }

    private class WavTrack(private val part: File) {
        private val file = RandomAccessFile(part, "rw")
        var pcmBytes = 0L
        var gapCount = 0L
        var droppedFrames = 0L
        var recoveryFrames = 0L
        var captureInvalidated = false
        var nextTimestampUs: Long? = null
        init {
            try {
                if (file.length() == 0L) file.write(ByteArray(WAV_HEADER_BYTES)) else file.seek(file.length())
            } catch (error: Exception) {
                runCatching { file.close() }
                throw error
            }
        }
        fun append(pcm: ByteArray): Long {
            val offset = WAV_HEADER_BYTES + pcmBytes
            file.write(pcm); pcmBytes += pcm.size
            return offset
        }
        fun abort() = file.close()
        private fun finish(fileStem: String): File {
            try {
                writeWavHeader(file, pcmBytes); file.fd.sync()
            } finally {
                file.close()
            }
            val destination = File(part.parentFile, "$fileStem.wav")
            atomicRename(part, destination)
            return destination
        }
        fun finishOriginal(track: OriginalAudioTrack): TrackRecordingResult {
            val destination = finish(track.fileStem)
            return TrackRecordingResult(destination.name, destination.length(), sha256(destination), pcmBytes,
                gapCount, droppedFrames, pcmBytes > 0L && gapCount == 0L && droppedFrames == 0L && !captureInvalidated)
        }
        fun finishDerived(track: DerivedAudioTrack): DerivedTrackRecordingResult {
            val destination = finish(track.fileStem)
            return DerivedTrackRecordingResult(destination.name, destination.length(), sha256(destination), pcmBytes,
                gapCount, recoveryFrames, pcmBytes > 0L && gapCount == 0L)
        }
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val CHANNELS = 1
        const val BITS_PER_SAMPLE = 16
        const val WAV_HEADER_BYTES = 44
        private const val BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8
        private const val FRAME_TOLERANCE_US = 2_000L
        private const val MEDIA_BUFFER_DISCARD = "media_buffer_discard"
        private val RECOVERY_KINDS = setOf("fec_attempt", "plc", "mixed_recovery")

        fun recoverIncomplete(root: File): List<LocalRecordingManifest> = root.listFiles().orEmpty().mapNotNull { dir ->
            if (java.nio.file.Files.isSymbolicLink(dir.toPath())) return@mapNotNull null
            val callId = runCatching { UUID.fromString(dir.name) }.getOrNull()?.toString() ?: return@mapNotNull null
            if (File(dir, "manifest.json").exists()) return@mapNotNull null
            val started = Instant.ofEpochMilli(dir.lastModified()).toString()
            val results = OriginalAudioTrack.entries.associateWith { track ->
                val part = File(dir, "${track.fileStem}.wav.part")
                val wav = File(dir, "${track.fileStem}.wav")
                if (part.exists()) {
                    RandomAccessFile(part, "rw").use { file ->
                        val pcm = (file.length() - WAV_HEADER_BYTES).coerceAtLeast(0)
                        writeWavHeader(file, pcm); file.fd.sync()
                    }
                    atomicRename(part, wav)
                }
                TrackRecordingResult(wav.name, if (wav.exists()) wav.length() else 0,
                    if (wav.exists()) sha256(wav) else sha256(ByteArray(0)),
                    (if (wav.exists()) wav.length() - WAV_HEADER_BYTES else 0).coerceAtLeast(0), 1, 0, false)
            }
            val derivedResults = DerivedAudioTrack.entries.mapNotNull { track ->
                val part = File(dir, "${track.fileStem}.wav.part")
                val wav = File(dir, "${track.fileStem}.wav")
                if (part.exists()) {
                    RandomAccessFile(part, "rw").use { file ->
                        val pcm = (file.length() - WAV_HEADER_BYTES).coerceAtLeast(0)
                        writeWavHeader(file, pcm); file.fd.sync()
                    }
                    atomicRename(part, wav)
                }
                if (!wav.exists()) null else track to DerivedTrackRecordingResult(
                    wav.name, wav.length(), sha256(wav),
                    (wav.length() - WAV_HEADER_BYTES).coerceAtLeast(0), 1, 0, false,
                )
            }.toMap()
            val timeline = File(dir, "timeline.jsonl")
            File(dir, "timeline.jsonl.part").takeIf(File::exists)?.let { atomicRename(it, timeline) }
            if (!timeline.exists()) RandomAccessFile(timeline, "rw").use {
                it.writeUtf8("{\"event\":\"recovered_incomplete\"}\n"); it.fd.sync()
            }
            val binding = readCaptureBinding(File(dir, CAPTURE_FILE), callId)
            LocalRecordingManifest(callId, "recovered_incomplete", started, Instant.now().toString(), results,
                derivedTracks = derivedResults, timelineBytes = timeline.length(),
                timelineSha256 = sha256(timeline), captureBinding = binding)
                .also { writeManifest(dir, it) }
        }

        private const val CAPTURE_FILE = "capture.json"
    }
}

private fun writeWavHeader(file: RandomAccessFile, pcmBytes: Long) {
    require(pcmBytes <= 0xffff_ffffL - 36)
    file.seek(0)
    file.writeBytes("RIFF"); file.writeLe32(pcmBytes + 36); file.writeBytes("WAVEfmt ")
    file.writeLe32(16); file.writeLe16(1); file.writeLe16(LocalCallRecorder.CHANNELS)
    file.writeLe32(LocalCallRecorder.SAMPLE_RATE.toLong())
    val byteRate = LocalCallRecorder.SAMPLE_RATE * LocalCallRecorder.CHANNELS * LocalCallRecorder.BITS_PER_SAMPLE / 8
    file.writeLe32(byteRate.toLong()); file.writeLe16(LocalCallRecorder.CHANNELS * LocalCallRecorder.BITS_PER_SAMPLE / 8)
    file.writeLe16(LocalCallRecorder.BITS_PER_SAMPLE); file.writeBytes("data"); file.writeLe32(pcmBytes)
}
private fun RandomAccessFile.writeLe16(value: Int) { write(value and 0xff); write((value ushr 8) and 0xff) }
private fun RandomAccessFile.writeLe32(value: Long) { repeat(4) { write((value ushr (it * 8)).toInt() and 0xff) } }
private fun RandomAccessFile.writeUtf8(value: String) = write(value.toByteArray(Charsets.UTF_8))
private fun atomicRename(source: File, destination: File) {
    check(source.renameTo(destination)) { "recording rename failed" }
    syncDirectory(requireNotNull(destination.parentFile))
}
private fun sha256(file: File) = file.inputStream().use { input ->
    val digest = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(8192)
    while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
    digest.digest().joinToString("") { "%02x".format(it) }
}
private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
private fun finiteState(value: String) = value.takeIf { it in setOf("completed", "ended", "failed", "incomplete", "recovered_incomplete") } ?: "failed"
private fun writeManifest(directory: File, manifest: LocalRecordingManifest) {
    val part = File(directory, "manifest.json.part")
    val tracks = manifest.tracks.entries.joinToString(",") { (key, value) ->
        "\"${key.fileStem}\":{\"file\":\"${value.fileName}\",\"bytes\":${value.bytes},\"sha256\":\"${value.sha256}\",\"pcmBytes\":${value.pcmBytes},\"gapCount\":${value.gapCount},\"droppedFrames\":${value.droppedFrames},\"captureComplete\":${value.captureComplete}}"
    }
    val derivedTracks = manifest.derivedTracks.entries.joinToString(",") { (key, value) ->
        "\"${key.fileStem}\":{\"file\":\"${value.fileName}\",\"bytes\":${value.bytes},\"sha256\":\"${value.sha256}\",\"pcmBytes\":${value.pcmBytes},\"gapCount\":${value.gapCount},\"recoveryFrames\":${value.recoveryFrames},\"playoutComplete\":${value.playoutComplete}}"
    }
    val stats = manifest.sessionStats.entries.sortedBy { it.key }
        .joinToString(",") { (key, value) -> "\"$key\":$value" }
    val binding = manifest.captureBinding
    val captureJson = binding?.let { ",\"captureBinding\":${captureJson(it, includeCallId = false)}" }.orEmpty()
    val derivedJson = if (manifest.derivedTracks.isEmpty()) "" else ",\"derivedTracks\":{$derivedTracks}"
    val version = when {
        manifest.derivedTracks.isNotEmpty() -> 3
        binding != null -> 2
        else -> 1
    }
    val json = "{\"version\":$version,\"callId\":\"${manifest.callId}\"$captureJson,\"terminalState\":\"${manifest.terminalState}\",\"startedAt\":\"${manifest.startedAt}\",\"endedAt\":\"${manifest.endedAt}\",\"tracks\":{$tracks}$derivedJson,\"timeline\":{\"file\":\"timeline.jsonl\",\"bytes\":${manifest.timelineBytes},\"sha256\":\"${manifest.timelineSha256}\"},\"sessionStats\":{$stats}}"
    RandomAccessFile(part, "rw").use { it.setLength(0); it.writeUtf8(json); it.fd.sync() }
    atomicRename(part, File(directory, "manifest.json"))
    syncDirectory(directory)
}

private fun persistCaptureBinding(directory: File, callId: String, binding: MediaCaptureBinding) {
    require(binding.callId == callId && binding.telecomCreationTimeMillis > 0 &&
        binding.captureGeneration > 0 && binding.mediaEpoch > 0)
    val json = captureJson(binding, includeCallId = true)
    val final = File(directory, "capture.json")
    if (final.exists()) {
        check(final.readText(Charsets.UTF_8) == json) { "capture binding conflict" }
        return
    }
    val part = File(directory, "capture.json.part")
    RandomAccessFile(part, "rw").use { it.setLength(0); it.writeUtf8(json); it.fd.sync() }
    atomicRename(part, final)
    syncDirectory(directory)
}

private fun readCaptureBinding(file: File, callId: String): MediaCaptureBinding? {
    if (!file.exists()) return null
    check(!java.nio.file.Files.isSymbolicLink(file.toPath()))
    val value = org.json.JSONObject(file.readText(Charsets.UTF_8))
    return MediaCaptureBinding(
        value.getString("id"), value.getString("callId"), value.getString("deviceCallId"),
        value.getLong("telecomCreationTimeMillis"), value.getLong("captureGeneration"),
        value.getString("mediaNodeId"), value.getLong("mediaEpoch"), value.getString("createdAt"),
    ).also {
        check(UUID.fromString(it.id).toString() == it.id && UUID.fromString(it.callId).toString() == it.callId)
        check(it.callId == callId && it.telecomCreationTimeMillis > 0 && it.captureGeneration > 0 && it.mediaEpoch > 0)
        Instant.parse(it.createdAt)
        check(captureJson(it, includeCallId = true) == file.readText(Charsets.UTF_8))
    }
}

private fun captureJson(binding: MediaCaptureBinding, includeCallId: Boolean): String = org.json.JSONObject()
    .put("id", binding.id)
    .also { if (includeCallId) it.put("callId", binding.callId) }
    .put("deviceCallId", binding.deviceCallId)
    .put("telecomCreationTimeMillis", binding.telecomCreationTimeMillis)
    .put("captureGeneration", binding.captureGeneration)
    .put("mediaNodeId", binding.mediaNodeId)
    .put("mediaEpoch", binding.mediaEpoch)
    .put("createdAt", binding.createdAt)
    .toString()

private fun syncDirectory(directory: File) {
    FileChannel.open(directory.toPath(), StandardOpenOption.READ).use { it.force(true) }
}
