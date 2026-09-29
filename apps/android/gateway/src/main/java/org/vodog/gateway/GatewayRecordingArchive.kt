package org.vodog.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import org.vodog.gateway.media.MediaCaptureBinding
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.DeflaterOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

internal const val ARCHIVE_CHUNK_BYTES = 1024 * 1024
private val ARCHIVE_OBJECT_NAMES = listOf(
    "remote_original.wav.gz",
    "caller_original.wav.gz",
    "timeline.jsonl.gz",
)
private const val DERIVED_PLAYOUT_OBJECT_NAME = "caller_playout.wav.gz"

internal data class ArchiveObject(
    val name: String,
    val compressedBytes: Long,
    val compressedSha256: String,
    val originalBytes: Long,
    val originalSha256: String,
    val committedOffset: Long = 0,
    val state: String = "uploading",
)

internal data class ArchiveUploadState(
    val uploadId: String?,
    val callId: String,
    val manifestSha256: String,
    val objects: List<ArchiveObject>,
    val attempt: Int = 0,
    val nextAttemptAt: String? = null,
    val state: String = "uploading",
    val failureCode: String? = null,
)

internal data class CallDeletionProof(
    val callId: String,
    val gatewayGeneration: Long,
    val previouslyVerified: Boolean,
    val previouslyComplete: Boolean,
)

/** A stable RFC1952 single-member stream: fixed header, raw deflate, CRC32 and ISIZE. */
internal object DeterministicGzip {
    fun compress(source: File, destination: File, shouldContinue: () -> Boolean = { true }): ArchiveObject {
        require(source.isFile && !source.isSymbolicLink())
        val part = File(destination.parentFile, destination.name + ".part")
        if (part.exists()) check(part.delete())
        val crc = CRC32()
        var inputBytes = 0L
        FileOutputStream(part).use { raw ->
            raw.write(byteArrayOf(0x1f, 0x8b.toByte(), 8, 0, 0, 0, 0, 0, 0, 0xff.toByte()))
            val deflater = Deflater(6, true)
            try {
                val compressed = DeflaterOutputStream(raw, deflater, 64 * 1024, true)
                FileInputStream(source).use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (!shouldContinue()) throw ArchivePausedException()
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        crc.update(buffer, 0, count)
                        inputBytes += count
                        compressed.write(buffer, 0, count)
                    }
                }
                compressed.finish()
            } finally {
                deflater.end()
            }
            writeLe32(raw, crc.value)
            writeLe32(raw, inputBytes and 0xffff_ffffL)
            raw.fd.sync()
        }
        if (destination.exists()) {
            check(destination.length() == part.length() &&
                archiveSha256(destination, shouldContinue) == archiveSha256(part, shouldContinue)) {
                "existing deterministic gzip differs"
            }
            check(part.delete())
        } else {
            check(part.renameTo(destination)) { "gzip publish failed" }
            syncParent(destination)
        }
        return ArchiveObject(
            destination.name,
            destination.length(),
            archiveSha256(destination, shouldContinue),
            source.length(),
            archiveSha256(source, shouldContinue),
        )
    }

    private fun writeLe32(output: FileOutputStream, value: Long) {
        repeat(4) { output.write(((value ushr (it * 8)) and 0xff).toInt()) }
    }
}

internal class RecordingArchiveJournal(private val root: File) {
    init { check(root.isDirectory && !root.isSymbolicLink()) { "recording archive root is unsafe" } }
    fun read(callId: String): ArchiveUploadState? {
        val file = journalFile(callId)
        if (!file.isFile || file.isSymbolicLink()) return null
        return parseState(JSONObject(file.readText(Charsets.UTF_8)), callId)
    }

    fun write(state: ArchiveUploadState) {
        val dir = safeCallDirectory(state.callId)
        val part = File(dir, "archive-upload.json.part")
        RandomAccessFile(part, "rw").use {
            it.setLength(0)
            it.write(stateJson(state).toString().toByteArray(Charsets.UTF_8))
            it.fd.sync()
        }
        val target = File(dir, "archive-upload.json")
        atomicReplace(part, target)
        syncParent(target)
    }

    fun preparationDue(callId: String, now: Instant): Boolean {
        val file = File(safeCallDirectory(callId), "archive-preparation.json")
        if (!file.isFile) return true
        val value = JSONObject(file.readText(Charsets.UTF_8))
        return !Instant.parse(value.getString("nextAttemptAt")).isAfter(now)
    }

    fun recordPreparationFailure(callId: String, now: Instant, code: String) {
        val dir = safeCallDirectory(callId)
        val file = File(dir, "archive-preparation.json")
        val previous = runCatching { JSONObject(file.readText(Charsets.UTF_8)).strictLong("attempt", 0, 12).toInt() }
            .getOrDefault(0)
        val attempt = (previous + 1).coerceAtMost(12)
        val delaySeconds = (1L shl minOf(attempt, 10)).coerceAtMost(3600)
        atomicWrite(file, JSONObject().put("attempt", attempt).put("nextAttemptAt", now.plusSeconds(delaySeconds).toString())
            .put("failureCode", code.take(80)).toString().toByteArray(Charsets.UTF_8))
    }

    fun clearPreparationFailure(callId: String) {
        val file = File(safeCallDirectory(callId), "archive-preparation.json")
        if (file.exists() && !file.delete()) error("preparation failure marker delete failed")
        syncParent(file)
    }

    fun reactivateAuthentication() {
        candidates().forEach { callId ->
            val state = runCatching { read(callId) }.getOrNull() ?: return@forEach
            if (state.state == "auth_required") write(state.copy(state = "uploading", nextAttemptAt = null))
        }
    }

    fun candidates(): List<String> {
        recoverInterruptedCleanup()
        return root.listFiles().orEmpty().filter { directory ->
            if (!directory.isDirectory || directory.isSymbolicLink() ||
                !runCatching { UUID.fromString(directory.name).toString() == directory.name }.getOrDefault(false)) return@filter false
            val cleanupPending = runCatching { read(directory.name)?.state == "cleanup_pending" }.getOrDefault(false)
            cleanupPending || (File(directory, "manifest.json").isRegularNoFollow() &&
                File(directory, "capture.json").isRegularNoFollow())
        }.map(File::getName).sorted()
    }

    fun directory(callId: String): File = safeCallDirectory(callId)

    private fun safeCallDirectory(callId: String): File {
        require(UUID.fromString(callId).toString() == callId)
        return File(root, callId).also { check(it.isDirectory && !it.isSymbolicLink()) }
    }
    private fun recoverInterruptedCleanup() {
        root.listFiles().orEmpty().filter { it.name.startsWith(CLEANUP_PREFIX) }.forEach { cleanup ->
            if (!cleanup.isDirectory || cleanup.isSymbolicLink()) return@forEach
            val callId = cleanup.name.removePrefix(CLEANUP_PREFIX)
            if (!runCatching { UUID.fromString(callId).toString() == callId }.getOrDefault(false)) return@forEach
            if (cleanup.listFiles().orEmpty().isEmpty()) {
                if (cleanup.delete()) syncParent(cleanup)
                return@forEach
            }
            val target = File(root, callId)
            if (!target.exists() && cleanup.renameTo(target)) syncParent(target)
        }
    }
    private fun journalFile(callId: String) = File(safeCallDirectory(callId), "archive-upload.json")
}

internal interface RecordingArchiveControl : Closeable {
    fun initialize(callId: String, manifest: JSONObject): ArchiveUploadState
    fun status(uploadId: String, callId: String, manifestSha256: String, gatewayGeneration: Long): ArchiveUploadState
    fun upload(uploadId: String, objectValue: ArchiveObject, source: File, offset: Long): Long
    fun finalize(uploadId: String, callId: String, manifestSha256: String, version: Int): String
    fun cancelInFlight() = Unit
}

internal class HttpRecordingArchiveControl(
    private val token: String,
    private val baseUrlOverride: String? = null,
) : RecordingArchiveControl {
    private val dispatcher = Dispatcher()
    private val pool = ConnectionPool(2, 30, TimeUnit.SECONDS)
    private val client = OkHttpClient.Builder().dispatcher(dispatcher).connectionPool(pool)
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS).build()
    private val calls = mutableSetOf<Call>()
    private val closed = AtomicBoolean(false)

    override fun initialize(callId: String, manifest: JSONObject): ArchiveUploadState =
        parseUpload(callId, canonicalFingerprint(manifest), json(
            "POST", GatewayApiRoutes.recordingArchives(callId), manifest.toString().toByteArray(),
            mapOf("Content-Type" to "application/json"),
            DeletedCallIdentity(callId, manifest.getJSONObject("captureBinding").strictLong("captureGeneration", 1, MAX_SAFE_INTEGER)),
        ))

    override fun status(uploadId: String, callId: String, manifestSha256: String, gatewayGeneration: Long): ArchiveUploadState =
        parseUpload(callId, manifestSha256, json(
            "GET", "${GatewayApiRoutes.recordingArchive(uploadId)}?callId=$callId&generation=$gatewayGeneration",
            deletedIdentity = DeletedCallIdentity(callId, gatewayGeneration),
        ))

    override fun upload(uploadId: String, objectValue: ArchiveObject, source: File, offset: Long): Long {
        require(offset in 0 until objectValue.compressedBytes)
        val count = minOf(ARCHIVE_CHUNK_BYTES.toLong(), objectValue.compressedBytes - offset).toInt()
        val bytes = ByteArray(count)
        RandomAccessFile(source, "r").use { file -> file.seek(offset); file.readFully(bytes) }
        val end = offset + count - 1
        val response = json(
            "PUT", GatewayApiRoutes.recordingArchiveObject(uploadId, objectValue.name), bytes,
            mapOf(
                "Content-Type" to "application/octet-stream",
                "Content-Range" to "bytes $offset-$end/${objectValue.compressedBytes}",
                "Digest" to "sha-256=${Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes))}",
            ),
        )
        return response.getJSONObject("object").let { value ->
            require(value.getString("name") == objectValue.name)
            require(value.strictLong("expectedBytes", 1, MAX_SAFE_INTEGER) == objectValue.compressedBytes)
            require(value.getString("state") in SERVER_OBJECT_STATES)
            value.strictLong("committedOffset", offset + count, objectValue.compressedBytes)
        }
    }

    override fun finalize(uploadId: String, callId: String, manifestSha256: String, version: Int): String = json(
        "POST", GatewayApiRoutes.finalizeRecordingArchive(uploadId), ByteArray(0),
    ).getJSONObject("archive").let { archive ->
        require(version in 2..3)
        require(archive.getString("id") == uploadId && archive.getString("callId") == callId)
        require(archive.getString("source") == "pixel" && archive.strictLong("version", 2, 3) == version.toLong())
        require(archive.getString("state") == "complete" && archive.getString("manifestSha256") == manifestSha256)
        requireSha256(archive.getString("manifestSha256"))
        Instant.parse(archive.getString("completedAt"))
        "complete"
    }

    private fun json(
        method: String,
        path: String,
        body: ByteArray? = null,
        headers: Map<String, String> = emptyMap(),
        deletedIdentity: DeletedCallIdentity? = null,
    ): JSONObject {
        val base = baseUrlOverride ?: GatewayEndpoint.baseUrl()
        return try {
            jsonAt(base, method, path, body, headers, deletedIdentity)
        } catch (failure: java.io.IOException) {
            // S71: GET status and range PUTs are idempotent; a network-layer failure tries the other
            // Control endpoint once. Initialize/finalize POSTs are left to the archive's own retry.
            if (baseUrlOverride != null || method !in setOf("GET", "PUT") || closed.get()) throw failure
            try {
                jsonAt(GatewayEndpoint.alternateUrl(base) ?: throw failure, method, path, body, headers, deletedIdentity)
            } catch (second: Exception) {
                second.addSuppressed(failure)
                throw second
            }
        }
    }

    private fun jsonAt(
        base: String,
        method: String,
        path: String,
        body: ByteArray?,
        headers: Map<String, String>,
        deletedIdentity: DeletedCallIdentity?,
    ): JSONObject {
        check(!closed.get())
        val builder = Request.Builder().url(base + path).header("Accept", "application/json")
            .header("Authorization", "Bearer $token")
        headers.forEach(builder::header)
        val requestBody = when {
            body != null -> body.toRequestBody(headers["Content-Type"]?.toMediaType())
            method in setOf("POST", "PUT") -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        val call = client.newCall(builder.method(method, requestBody).build())
        synchronized(calls) { check(!closed.get()); calls += call }
        try {
            call.execute().use { response ->
                val bytes = response.body?.byteStream()?.use { input ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (output.size() + count > 1024 * 1024) throw IllegalStateException("archive response too large")
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                } ?: ByteArray(0)
                val value = runCatching { JSONObject(bytes.toString(Charsets.UTF_8)) }.getOrNull()
                if (!response.isSuccessful) {
                    val code = value?.optJSONObject("error")?.optString("code").orEmpty().ifBlank { "HTTP_${response.code}" }
                    if (response.code == 410 && code == "CALL_DELETED" && deletedIdentity != null)
                        throw RecordingArchiveDeletedException(parseDeletionProof(requireNotNull(value), deletedIdentity))
                    throw RecordingArchiveHttpException(response.code, code)
                }
                return requireNotNull(value)
            }
        } finally { synchronized(calls) { calls -= call } }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        synchronized(calls) { calls.toList().also { calls.clear() } }.forEach(Call::cancel)
        dispatcher.cancelAll(); pool.evictAll(); dispatcher.executorService.shutdownNow()
    }

    override fun cancelInFlight() {
        synchronized(calls) { calls.toList() }.forEach(Call::cancel)
    }
}

internal data class DeletedCallIdentity(val callId: String, val gatewayGeneration: Long)
internal class RecordingArchiveDeletedException(val proof: CallDeletionProof) : Exception("CALL_DELETED")
internal class RecordingArchiveHttpException(val status: Int, val code: String) : Exception(code)
internal class ArchivePausedException : Exception("archive work paused")
internal class RecordingArchiveCapacityException : Exception("recording archive disk reserve is low")

/** One foreground ON generation owns one cancellable, single-concurrency archive loop. */
internal class GatewayRecordingArchiveOwner(
    private val context: Context,
    token: String,
    private val control: RecordingArchiveControl = HttpRecordingArchiveControl(token),
    private val now: () -> Instant = Instant::now,
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val wakeups = Channel<Unit>(Channel.CONFLATED)
    private val closed = AtomicBoolean(false)
    private val idleAllowed = AtomicBoolean(false)
    private val journal = RecordingArchiveJournal(GatewayRecordingStore(context).rootDirectory())
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = networkChanged()
        override fun onLost(network: Network) = networkChanged()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = networkChanged()
    }
    private val networkRegistered: Boolean
    init {
        networkRegistered = runCatching { connectivity.registerDefaultNetworkCallback(networkCallback) }.isSuccess
    }
    private val job: Job = scope.launch {
        journal.reactivateAuthentication()
        loop()
    }

    fun signalIdle() {
        idleAllowed.set(true)
        if (!closed.get()) wakeups.trySend(Unit)
    }
    fun signalBusy() {
        idleAllowed.set(false)
        if (!closed.get()) control.cancelInFlight()
    }
    private fun networkChanged() {
        if (closed.get()) return
        control.cancelInFlight()
        wakeups.trySend(Unit)
    }

    private suspend fun loop() {
        while (scope.isActive) {
            wakeups.receive()
            if (closed.get() || !idleAllowed.get() || !GatewayRuntimeStore(context).enabled || GatewayActiveAudioSession.current() != null) continue
            for (callId in journal.candidates()) {
                if (closed.get() || !GatewayRuntimeStore(context).enabled || GatewayActiveAudioSession.current() != null) break
                val preparationDue = preparationDueOrBackoff(journal, callId, now())
                if (!preparationDue) continue
                runCatching {
                    processRecordingArchive(journal, control, callId, now) {
                        !closed.get() && idleAllowed.get() && GatewayRuntimeStore(context).enabled &&
                            GatewayActiveAudioSession.current() == null
                    }
                }.onFailure { error ->
                    if (error is CancellationException) throw error
                    if (error is ArchivePausedException) return@onFailure
                    val previous = runCatching { journal.read(callId) }.getOrNull()
                    if (previous == null) {
                        journal.recordPreparationFailure(
                            callId,
                            now(),
                            if (error is RecordingArchiveCapacityException) "local_disk_reserve_low" else "archive_prepare_failed",
                        )
                        return@onFailure
                    }
                    val attempt = (previous.attempt + 1).coerceAtMost(12)
                    val delaySeconds = (1L shl minOf(attempt, 10)).coerceAtMost(3600)
                    val failure = (error as? RecordingArchiveHttpException)
                    journal.write(previous.copy(
                        attempt = attempt,
                        nextAttemptAt = now().plusSeconds(delaySeconds).toString(),
                        state = when (failure?.status) {
                            401 -> "auth_required"
                            422 -> "blocked"
                            else -> previous.state
                        },
                        failureCode = failure?.code ?: "archive_io_failed",
                    ))
                }
            }
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        if (networkRegistered) runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        control.close(); job.cancel(); scope.coroutineContext[Job]?.cancel(); wakeups.close()
    }
}

internal fun preparationDueOrBackoff(
    journal: RecordingArchiveJournal,
    callId: String,
    now: Instant,
): Boolean = runCatching { journal.preparationDue(callId, now) }.getOrElse {
    journal.recordPreparationFailure(callId, now, "preparation_journal_invalid")
    false
}

internal fun processRecordingArchive(
    journal: RecordingArchiveJournal,
    control: RecordingArchiveControl,
    callId: String,
    now: () -> Instant = Instant::now,
    cleanup: (RecordingArchiveJournal, String, () -> Boolean) -> Unit = ::cleanupArchivedRecording,
    shouldContinue: () -> Boolean = { true },
) {
    var state = journal.read(callId) ?: prepareRecordingArchive(journal, callId, shouldContinue).also {
        journal.clearPreparationFailure(callId)
    }
    if (state.state == "cleanup_pending") {
        cleanup(journal, callId, shouldContinue)
        return
    }
    if (state.state == "archived") {
        journal.write(state.copy(state = "cleanup_pending", nextAttemptAt = null, failureCode = null))
        cleanup(journal, callId, shouldContinue)
        return
    }
    // S39 §决策3: `deleted_retained` is deliberately absent — a journal still holding the old
    // state is re-offered to the server, answered 410 again, and cleaned up on this pass.
    if (state.state in setOf("blocked", "auth_required")) return
    val manifestFile = File(journal.directory(callId),
        if (state.objects.any { it.name == DERIVED_PLAYOUT_OBJECT_NAME }) "manifest.v3.upload.json" else "manifest.v2.upload.json")
    require(manifestFile.isRegularNoFollow())
    val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))
    val gatewayGeneration = manifest.getJSONObject("captureBinding")
        .strictLong("captureGeneration", 1, MAX_SAFE_INTEGER)
    val canonicalFingerprint = canonicalFingerprint(manifest)
    if (canonicalFingerprint != state.manifestSha256) {
        require(state.state == "uploading" && state.uploadId == null && state.objects.all { it.committedOffset == 0L }) {
            "stored upload manifest changed"
        }
        require(state.manifestSha256 == legacySlashEscapedCanonicalFingerprint(manifest)) {
            "stored upload manifest changed"
        }
        requireJournalMatchesImmutableManifest(state.objects, manifest)
        validateFrozenArchiveObjects(journal.directory(callId), state.objects, shouldContinue)
        state = state.copy(manifestSha256 = canonicalFingerprint, attempt = 0, nextAttemptAt = null, failureCode = null)
        journal.write(state)
    }
    state.nextAttemptAt?.let { if (Instant.parse(it).isAfter(now())) return }
    requireArchiveOwner(shouldContinue)
    validateFrozenArchiveObjects(journal.directory(callId), state.objects, shouldContinue)
    val server = try {
        if (state.uploadId == null) control.initialize(callId, manifest) else
            control.status(requireNotNull(state.uploadId), callId, state.manifestSha256, gatewayGeneration)
    } catch (deleted: RecordingArchiveDeletedException) {
        require(deleted.proof.callId == callId && deleted.proof.gatewayGeneration == gatewayGeneration)
        // S39 §决策3 revises the S31 B rule: a verified 410 is the user's own deletion, so the local
        // copy goes whether or not the archive ever reached the server. A plain 404 still deletes
        // nothing — only this proven-identity, proven-generation path does.
        GatewayDiag.log("recording.deleted_cleanup", mapOf(
            "previouslyVerified" to deleted.proof.previouslyVerified,
            "previouslyComplete" to deleted.proof.previouslyComplete,
            "from" to state.state,
        ), callId = callId)
        journal.write(state.copy(state = "cleanup_pending", nextAttemptAt = null, failureCode = null))
        cleanup(journal, callId, shouldContinue)
        return
    }
    state = mergeServerState(state, server)
    journal.write(state.copy(attempt = 0, nextAttemptAt = null, failureCode = null))
    if (state.state == "complete") {
        require(state.objects.all { it.state == "verified" })
        journal.write(state.copy(state = "cleanup_pending", nextAttemptAt = null, failureCode = null))
        cleanup(journal, callId, shouldContinue)
        return
    }
    if (state.state == "rejected") {
        journal.write(state.copy(state = "blocked", failureCode = "archive_rejected"))
        return
    }
    val uploadId = requireNotNull(state.uploadId)
    for (remote in state.objects) {
        var offset = remote.committedOffset
        val source = File(journal.directory(callId), remote.name)
        while (offset < remote.compressedBytes) {
            requireArchiveOwner(shouldContinue)
            offset = control.upload(uploadId, remote, source, offset)
            state = state.copy(objects = state.objects.map {
                if (it.name == remote.name) it.copy(
                    committedOffset = offset,
                    state = if (offset == it.compressedBytes) "uploaded" else "uploading",
                ) else it
            })
            journal.write(state)
        }
    }
    requireArchiveOwner(shouldContinue)
    control.finalize(uploadId, callId, state.manifestSha256, manifest.strictLong("version", 2, 3).toInt())
    journal.write(state.copy(state = "cleanup_pending", nextAttemptAt = null, failureCode = null))
    cleanup(journal, callId, shouldContinue)
}

private fun prepareRecordingArchive(
    journal: RecordingArchiveJournal,
    callId: String,
    shouldContinue: () -> Boolean,
): ArchiveUploadState {
    val directory = journal.directory(callId)
    val local = parseLocalManifest(directory, callId)
    val sourceNames = buildList {
        addAll(listOf(
        "remote_original.wav" to "remote_original.wav.gz",
        "caller_original.wav" to "caller_original.wav.gz",
        "timeline.jsonl" to "timeline.jsonl.gz",
        ))
        if (local.version == 3) add("caller_playout.wav" to DERIVED_PLAYOUT_OBJECT_NAME)
    }
    val sources = sourceNames.map { File(directory, it.first) }
    require(sources.all { it.isFile && !it.isSymbolicLink() })
    require(sources[0].length() in 44..MAX_WAV_BYTES && sources[1].length() in 44..MAX_WAV_BYTES)
    require(sources[2].length() in 1..MAX_TIMELINE_BYTES)
    if (local.version == 3) require(sources[3].length() in 44..MAX_WAV_BYTES)
    requireArchiveDiskCapacity(directory, sources.map(File::length), BuildConfig.RECORDING_ARCHIVE_MIN_FREE_BYTES)
    val compressed = sourceNames.map { (source, target) ->
        DeterministicGzip.compress(File(directory, source), File(directory, target), shouldContinue)
    }
    val uploadManifest = uploadManifest(local, compressed)
    publishImmutableManifest(File(directory, "manifest.v${local.version}.upload.json"), uploadManifest)
    return ArchiveUploadState(null, callId, canonicalFingerprint(uploadManifest), compressed).also(journal::write)
}

internal fun requireArchiveDiskCapacity(directory: File, sourceBytes: List<Long>, minimumFreeBytes: Long) {
    require(sourceBytes.size in 3..4 && sourceBytes.all { it > 0 } && minimumFreeBytes >= 0)
    val worstCase = sourceBytes.fold(0L) { total, bytes ->
        Math.addExact(total, Math.addExact(bytes, Math.addExact((bytes / 16_384L + 1L) * 8L, 128L)))
    }
    if (directory.usableSpace < Math.addExact(minimumFreeBytes, worstCase))
        throw RecordingArchiveCapacityException()
}

private data class ParsedLocalManifest(
    val version: Int,
    val callId: String,
    val binding: MediaCaptureBinding,
    val terminalState: String,
    val startedAt: String,
    val endedAt: String,
    val tracks: JSONObject,
    val derivedTracks: JSONObject?,
    val timeline: JSONObject,
    val stats: JSONObject,
)

private fun parseLocalManifest(directory: File, callId: String): ParsedLocalManifest {
    val manifestFile = File(directory, "manifest.json").also { require(it.isRegularNoFollow()) }
    val captureFile = File(directory, "capture.json").also { require(it.isRegularNoFollow()) }
    val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))
    val version = manifest.strictLong("version", 2, 3).toInt()
    require(manifest.getString("callId") == callId)
    val state = manifest.getString("terminalState")
    require(state in setOf("ended", "failed", "incomplete", "recovered_incomplete"))
    val capture = JSONObject(captureFile.readText(Charsets.UTF_8))
    val embedded = manifest.getJSONObject("captureBinding")
    require(capture.toString() == JSONObject(capture.toString()).toString())
    val binding = MediaCaptureBinding(
        capture.getString("id"), capture.getString("callId"), capture.getString("deviceCallId"),
        capture.strictLong("telecomCreationTimeMillis", 1, MAX_SAFE_INTEGER),
        capture.strictLong("captureGeneration", 1, MAX_SAFE_INTEGER),
        capture.getString("mediaNodeId"), capture.strictLong("mediaEpoch", 1, MAX_SAFE_INTEGER), capture.getString("createdAt"),
    )
    requireCanonicalUuid(binding.id); requireCanonicalUuid(binding.callId)
    require(binding.callId == callId && binding.deviceCallId.isNotBlank() && binding.mediaNodeId.isNotBlank())
    Instant.parse(binding.createdAt)
    listOf("id", "deviceCallId", "mediaNodeId", "createdAt").forEach {
        require(embedded.getString(it) == capture.getString(it))
    }
    listOf("telecomCreationTimeMillis", "captureGeneration", "mediaEpoch").forEach {
        require(embedded.strictLong(it, 1, MAX_SAFE_INTEGER) == capture.strictLong(it, 1, MAX_SAFE_INTEGER))
    }
    val derived = manifest.optJSONObject("derivedTracks")
    require(manifest.getJSONObject("tracks").length() == 2)
    require((version == 2 && derived == null) ||
        (version == 3 && derived != null && derived.length() == 1 && derived.has("caller_playout")))
    return ParsedLocalManifest(version, callId, binding, state, manifest.getString("startedAt"), manifest.getString("endedAt"),
        manifest.getJSONObject("tracks"), derived, manifest.getJSONObject("timeline"), manifest.optJSONObject("sessionStats") ?: JSONObject())
}

private fun uploadManifest(local: ParsedLocalManifest, objects: List<ArchiveObject>): JSONObject {
    val byName = objects.associateBy(ArchiveObject::name)
    val tracks = JSONArray()
    listOf("remote_original", "caller_original").forEach { track ->
        val localTrack = local.tracks.getJSONObject(track)
        val compressed = requireNotNull(byName["$track.wav.gz"])
        require(localTrack.getString("file") == "$track.wav" &&
            localTrack.strictLong("bytes", 1, MAX_SAFE_INTEGER) == compressed.originalBytes &&
            localTrack.getString("sha256") == compressed.originalSha256)
        tracks.put(JSONObject().put("track", track).put("objectName", compressed.name).put("mediaType", "audio/wav")
            .put("pcm", JSONObject().put("sampleRate", 16000).put("channels", 1).put("bitsPerSample", 16).put("encoding", "pcm_s16le"))
            .put("compressedBytes", compressed.compressedBytes).put("compressedSha256", compressed.compressedSha256)
            .put("originalBytes", compressed.originalBytes).put("originalSha256", compressed.originalSha256)
            .put("pcmBytes", localTrack.strictLong("pcmBytes", 0, MAX_SAFE_INTEGER))
            .put("gapCount", localTrack.strictLong("gapCount", 0, MAX_SAFE_INTEGER))
            .put("droppedFrames", localTrack.strictLong("droppedFrames", 0, MAX_SAFE_INTEGER))
            .put("captureComplete", localTrack.strictBoolean("captureComplete")))
    }
    val derivedTracks = JSONArray()
    if (local.version == 3) {
        val localTrack = requireNotNull(local.derivedTracks).getJSONObject("caller_playout")
        val compressed = requireNotNull(byName[DERIVED_PLAYOUT_OBJECT_NAME])
        require(localTrack.getString("file") == "caller_playout.wav" &&
            localTrack.strictLong("bytes", 1, MAX_SAFE_INTEGER) == compressed.originalBytes &&
            localTrack.getString("sha256") == compressed.originalSha256)
        derivedTracks.put(JSONObject().put("track", "caller_playout").put("sourceRole", "derived_playout")
            .put("objectName", compressed.name).put("mediaType", "audio/wav")
            .put("pcm", JSONObject().put("sampleRate", 16000).put("channels", 1).put("bitsPerSample", 16).put("encoding", "pcm_s16le"))
            .put("compressedBytes", compressed.compressedBytes).put("compressedSha256", compressed.compressedSha256)
            .put("originalBytes", compressed.originalBytes).put("originalSha256", compressed.originalSha256)
            .put("pcmBytes", localTrack.strictLong("pcmBytes", 0, MAX_SAFE_INTEGER))
            .put("gapCount", localTrack.strictLong("gapCount", 0, MAX_SAFE_INTEGER))
            .put("recoveryFrames", localTrack.strictLong("recoveryFrames", 0, MAX_SAFE_INTEGER))
            .put("playoutComplete", localTrack.strictBoolean("playoutComplete")))
    }
    val timeline = requireNotNull(byName["timeline.jsonl.gz"])
    require(local.timeline.getString("file") == "timeline.jsonl" &&
        local.timeline.strictLong("bytes", 1, MAX_SAFE_INTEGER) == timeline.originalBytes &&
        local.timeline.getString("sha256") == timeline.originalSha256)
    val binding = local.binding
    return JSONObject().put("version", local.version).put("captureBinding", JSONObject()
        .put("id", binding.id).put("deviceCallId", binding.deviceCallId)
        .put("telecomCreationTimeMillis", binding.telecomCreationTimeMillis).put("captureGeneration", binding.captureGeneration))
        .put("startedAt", ISO_MILLIS.format(Instant.parse(local.startedAt)))
        .put("endedAt", ISO_MILLIS.format(Instant.parse(local.endedAt))).put("terminalState", local.terminalState)
        .put("tracks", tracks).also { if (local.version == 3) it.put("derivedTracks", derivedTracks) }
        .put("timeline", JSONObject().put("objectName", timeline.name)
            .put("mediaType", "application/x-ndjson").put("compressedBytes", timeline.compressedBytes)
            .put("compressedSha256", timeline.compressedSha256).put("originalBytes", timeline.originalBytes)
            .put("originalSha256", timeline.originalSha256)).put("sessionStats", JSONObject().also { result ->
                listOf("networkSendDrops", "remotePacketDrops", "injectionDrops", "transportMissingPackets").forEach { key ->
                    if (local.stats.has(key)) result.put(key, local.stats.strictLong(key, 0, MAX_SAFE_INTEGER))
                }
            })
}

private fun mergeServerState(local: ArchiveUploadState, server: ArchiveUploadState): ArchiveUploadState {
    require(server.uploadId != null && (local.uploadId == null || local.uploadId == server.uploadId))
    require(server.callId == local.callId && server.manifestSha256 == local.manifestSha256)
    val watermarks = server.objects.associateBy(ArchiveObject::name)
    require(watermarks.keys == local.objects.map(ArchiveObject::name).toSet())
    val objects = local.objects.map { expected ->
        val actual = requireNotNull(watermarks[expected.name])
        require(actual.compressedBytes == expected.compressedBytes)
        require(actual.committedOffset in 0..expected.compressedBytes)
        expected.copy(committedOffset = actual.committedOffset, state = actual.state)
    }
    return local.copy(uploadId = server.uploadId, objects = objects, state = server.state)
}

internal fun parseUpload(callId: String, manifestSha256: String, json: JSONObject): ArchiveUploadState {
    val upload = json.getJSONObject("upload")
    val objects = upload.getJSONArray("objects")
    val parsed = List(objects.length()) { index -> objects.getJSONObject(index).let {
        val expected = it.strictLong("expectedBytes", 1, MAX_SAFE_INTEGER)
        val offset = it.strictLong("committedOffset", 0, expected)
        val state = it.getString("state").also { value -> require(value in SERVER_OBJECT_STATES) }
        ArchiveObject(it.getString("name"), expected, "", 0, "", offset, state)
    } }
    requireValidArchiveObjects(parsed)
    val id = upload.getString("id").also(::requireCanonicalUuid)
    val state = upload.getString("state").also { require(it in SERVER_ARCHIVE_STATES) }
    val fingerprint = upload.getString("manifestSha256").also(::requireSha256)
    require(fingerprint == manifestSha256)
    return ArchiveUploadState(id, callId, fingerprint, parsed, state = state)
}

internal fun parseDeletionProof(json: JSONObject, expected: DeletedCallIdentity): CallDeletionProof {
    requireExactKeys(json, setOf("error"))
    val error = json.getJSONObject("error")
    requireExactKeys(error, setOf("code", "message", "requestId", "details"))
    require(error.getString("code") == "CALL_DELETED")
    require(error.getString("message").isNotBlank() && error.getString("requestId").isNotBlank())
    val details = error.getJSONObject("details")
    requireExactKeys(details, setOf("deletion"))
    val deletion = details.getJSONObject("deletion")
    requireExactKeys(deletion, setOf("callId", "gatewayGeneration", "archive"))
    val callId = deletion.getString("callId").also(::requireCanonicalUuid)
    val generation = deletion.strictLong("gatewayGeneration", 1, MAX_SAFE_INTEGER)
    require(callId == expected.callId && generation == expected.gatewayGeneration)
    val archive = deletion.getJSONObject("archive")
    requireExactKeys(archive, setOf("previouslyVerified", "previouslyComplete"))
    return CallDeletionProof(
        callId,
        generation,
        archive.strictBoolean("previouslyVerified"),
        archive.strictBoolean("previouslyComplete"),
    )
}

private fun requireExactKeys(value: JSONObject, expected: Set<String>) {
    val actual = buildSet {
        val keys = value.keys()
        while (keys.hasNext()) add(keys.next())
    }
    require(actual == expected)
}

private fun stateJson(value: ArchiveUploadState) = JSONObject().put("uploadId", value.uploadId ?: JSONObject.NULL)
    .put("callId", value.callId).put("manifestSha256", value.manifestSha256).put("attempt", value.attempt)
    .put("nextAttemptAt", value.nextAttemptAt ?: JSONObject.NULL).put("state", value.state)
    .put("failureCode", value.failureCode ?: JSONObject.NULL).put("objects", JSONArray(value.objects.map { item -> JSONObject()
        .put("name", item.name).put("compressedBytes", item.compressedBytes).put("compressedSha256", item.compressedSha256)
        .put("originalBytes", item.originalBytes).put("originalSha256", item.originalSha256)
        .put("committedOffset", item.committedOffset).put("state", item.state) }))

private fun parseState(json: JSONObject, expectedCallId: String): ArchiveUploadState {
    require(json.getString("callId") == expectedCallId)
    val array = json.getJSONArray("objects")
    val objects = List(array.length()) { index -> array.getJSONObject(index).let {
        val compressed = it.strictLong("compressedBytes", 1, MAX_SAFE_INTEGER)
        val original = it.strictLong("originalBytes", 1, MAX_SAFE_INTEGER)
        val compressedSha = it.getString("compressedSha256").also(::requireSha256)
        val originalSha = it.getString("originalSha256").also(::requireSha256)
        val offset = it.strictLong("committedOffset", 0, compressed)
        val state = it.getString("state").also { value -> require(value in SERVER_OBJECT_STATES) }
        ArchiveObject(it.getString("name"), compressed, compressedSha, original, originalSha, offset, state)
    } }
    requireValidArchiveObjects(objects)
    val uploadId = json.nullableString("uploadId")?.also(::requireCanonicalUuid)
    val fingerprint = json.getString("manifestSha256").also(::requireSha256)
    val attempt = json.strictLong("attempt", 0, 12).toInt()
    val state = json.getString("state").also { require(it in LOCAL_ARCHIVE_STATES) }
    val next = json.nullableString("nextAttemptAt")?.also { Instant.parse(it) }
    return ArchiveUploadState(uploadId, expectedCallId,
        fingerprint, objects, attempt,
        next, state,
        json.nullableString("failureCode"))
}

private fun atomicWrite(file: File, bytes: ByteArray) {
    val part = File(file.parentFile, file.name + ".part")
    RandomAccessFile(part, "rw").use { it.setLength(0); it.write(bytes); it.fd.sync() }
    atomicReplace(part, file); syncParent(file)
}

private fun publishImmutableManifest(file: File, manifest: JSONObject) {
    val fingerprint = canonicalFingerprint(manifest)
    if (file.exists()) {
        require(file.isRegularNoFollow())
        require(canonicalFingerprint(JSONObject(file.readText(Charsets.UTF_8))) == fingerprint) {
            "existing upload manifest differs"
        }
        return
    }
    atomicWrite(file, manifest.toString().toByteArray(Charsets.UTF_8))
}

private fun validateFrozenArchiveObjects(
    directory: File,
    objects: List<ArchiveObject>,
    shouldContinue: () -> Boolean,
) {
    val sourceNames = mapOf(
        "remote_original.wav.gz" to "remote_original.wav",
        "caller_original.wav.gz" to "caller_original.wav",
        "timeline.jsonl.gz" to "timeline.jsonl",
        DERIVED_PLAYOUT_OBJECT_NAME to "caller_playout.wav",
    )
    objects.forEach { expected ->
        requireArchiveOwner(shouldContinue)
        val compressed = File(directory, expected.name)
        val original = File(directory, requireNotNull(sourceNames[expected.name]))
        require(compressed.isRegularNoFollow() && compressed.length() == expected.compressedBytes)
        require(original.isRegularNoFollow() && original.length() == expected.originalBytes)
        require(archiveSha256(compressed, shouldContinue) == expected.compressedSha256) {
            "frozen compressed archive object changed"
        }
        require(archiveSha256(original, shouldContinue) == expected.originalSha256) {
            "frozen original archive object changed"
        }
    }
}

private fun requireJournalMatchesImmutableManifest(objects: List<ArchiveObject>, manifest: JSONObject) {
    fun pinned(value: JSONObject) = ArchiveObject(
        value.getString("objectName"),
        value.strictLong("compressedBytes", 1, MAX_SAFE_INTEGER),
        value.getString("compressedSha256").also(::requireSha256),
        value.strictLong("originalBytes", 1, MAX_SAFE_INTEGER),
        value.getString("originalSha256").also(::requireSha256),
    )
    val expected = buildList {
        val tracks = manifest.getJSONArray("tracks")
        repeat(tracks.length()) { add(pinned(tracks.getJSONObject(it))) }
        manifest.optJSONArray("derivedTracks")?.let { derived ->
            repeat(derived.length()) { add(pinned(derived.getJSONObject(it))) }
        }
        add(pinned(manifest.getJSONObject("timeline")))
    }
    requireValidArchiveObjects(expected)
    val actual = objects.associateBy(ArchiveObject::name)
    require(actual.keys == expected.map(ArchiveObject::name).toSet()) { "journal objects differ from immutable manifest" }
    expected.forEach { pinned ->
        val journal = requireNotNull(actual[pinned.name])
        require(journal.compressedBytes == pinned.compressedBytes && journal.compressedSha256 == pinned.compressedSha256 &&
            journal.originalBytes == pinned.originalBytes && journal.originalSha256 == pinned.originalSha256) {
            "journal objects differ from immutable manifest"
        }
    }
}

private fun requireArchiveOwner(shouldContinue: () -> Boolean) {
    if (!shouldContinue()) throw ArchivePausedException()
}

/** Deletes only the already-finalized flat call directory, leaving its durable markers until last. */
internal fun cleanupArchivedRecording(
    journal: RecordingArchiveJournal,
    callId: String,
    shouldContinue: () -> Boolean = { true },
) {
    requireArchiveOwner(shouldContinue)
    val directory = journal.directory(callId)
    val entries = directory.listFiles().orEmpty().toList()
    require(entries.none { it.isSymbolicLink() || it.name.endsWith(".part") }) {
        "recording directory has an active writer or unsafe path"
    }
    require(entries.all { it.isFile }) { "recording directory has an unexpected child" }
    val markers = setOf("manifest.json", "capture.json", "archive-upload.json")
    require(journal.read(callId)?.state == "cleanup_pending") { "recording cleanup is not durable" }
    val cleanupDirectory = File(requireNotNull(directory.parentFile), CLEANUP_PREFIX + callId)
    require(!cleanupDirectory.exists() && !cleanupDirectory.isSymbolicLink()) { "recording cleanup target exists" }
    check(directory.renameTo(cleanupDirectory)) { "recording cleanup handoff failed" }
    syncParent(cleanupDirectory)
    try {
      val movedEntries = cleanupDirectory.listFiles().orEmpty().toList()
      movedEntries.filterNot { it.name in markers }.forEach { file ->
          requireArchiveOwner(shouldContinue)
          check(file.delete()) { "recording cleanup failed" }
      }
      listOf("manifest.json", "capture.json").forEach { name ->
          requireArchiveOwner(shouldContinue)
          val marker = File(cleanupDirectory, name)
          if (marker.exists()) check(marker.isRegularNoFollow() && marker.delete()) { "recording cleanup failed" }
      }
      requireArchiveOwner(shouldContinue)
      check(File(cleanupDirectory, "archive-upload.json").delete()) { "recording cleanup failed" }
      check(cleanupDirectory.delete()) { "recording directory cleanup failed" }
      syncParent(cleanupDirectory)
    } catch (error: Throwable) {
      if (cleanupDirectory.exists() && !directory.exists() && cleanupDirectory.renameTo(directory)) syncParent(directory)
      throw error
    }
}

private fun JSONObject.nullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else getString(key).takeIf(String::isNotBlank)

private fun JSONObject.strictLong(key: String, minimum: Long, maximum: Long): Long {
    val value = get(key)
    require(value is Number && INTEGER_TEXT.matches(value.toString())) { "$key must be an integer" }
    return requireNotNull(value.toString().toLongOrNull()).also { require(it in minimum..maximum) }
}

private fun JSONObject.strictBoolean(key: String): Boolean = get(key).also {
    require(it is Boolean) { "$key must be a boolean" }
} as Boolean

private fun requireCanonicalUuid(value: String) {
    require(UUID.fromString(value).toString() == value)
}

private fun requireSha256(value: String) {
    require(SHA256.matches(value))
}

private fun requireValidArchiveObjects(objects: List<ArchiveObject>) {
    val names = objects.map(ArchiveObject::name)
    val expectedV2 = ARCHIVE_OBJECT_NAMES.toSet()
    val expectedV3 = expectedV2 + DERIVED_PLAYOUT_OBJECT_NAME
    require(names.distinct().size == names.size && names.toSet() in setOf(expectedV2, expectedV3))
}

internal fun canonicalFingerprint(value: JSONObject): String =
    archiveSha256(canonicalJson(value).toByteArray(Charsets.UTF_8))

internal fun canonicalJson(value: Any?): String = canonicalJson(value, escapeSlash = false)

private fun canonicalJson(value: Any?, escapeSlash: Boolean): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(separator = ",", prefix = "{", postfix = "}") { key ->
        canonicalJsonString(key, escapeSlash) + ":" + canonicalJson(value.get(key), escapeSlash)
    }
    is JSONArray -> (0 until value.length()).joinToString(separator = ",", prefix = "[", postfix = "]") { canonicalJson(value.get(it), escapeSlash) }
    is String -> canonicalJsonString(value, escapeSlash)
    is Boolean -> value.toString()
    is Number -> canonicalSafeInteger(value)
    else -> error("unsupported JSON value")
}

internal fun legacySlashEscapedCanonicalFingerprint(value: JSONObject): String =
    archiveSha256(canonicalJson(value, escapeSlash = true).toByteArray(Charsets.UTF_8))

private fun canonicalSafeInteger(value: Number): String {
    val decimal = runCatching { java.math.BigDecimal(value.toString()) }.getOrElse {
        throw IllegalArgumentException("canonical archive numbers must be safe integers", it)
    }
    val integer = runCatching { decimal.toBigIntegerExact() }.getOrElse {
        throw IllegalArgumentException("canonical archive numbers must be safe integers", it)
    }
    require(integer.abs() <= java.math.BigInteger.valueOf(MAX_SAFE_INTEGER)) {
        "canonical archive numbers must be safe integers"
    }
    return integer.toString()
}

private fun canonicalJsonString(value: String, escapeSlash: Boolean): String = buildString(value.length + 2) {
    append('"')
    var index = 0
    while (index < value.length) {
        val character = value[index]
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '/' -> append(if (escapeSlash) "\\/" else "/")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> when {
                character.code < 0x20 -> append("\\u%04x".format(character.code))
                Character.isHighSurrogate(character) && index + 1 < value.length && Character.isLowSurrogate(value[index + 1]) -> {
                    append(character); append(value[++index])
                }
                Character.isSurrogate(character) -> append("\\u%04x".format(character.code))
                else -> append(character)
            }
        }
        index++
    }
    append('"')
}

private fun File.isSymbolicLink() = Files.isSymbolicLink(toPath())
private fun File.isRegularNoFollow() = isFile && !isSymbolicLink()
private fun syncParent(file: File) = java.nio.channels.FileChannel.open(
    requireNotNull(file.parentFile).toPath(),
    java.nio.file.StandardOpenOption.READ,
).use { it.force(true) }
internal fun archiveSha256(file: File, shouldContinue: () -> Boolean = { true }) = file.inputStream().use { input ->
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    while (true) {
        if (!shouldContinue()) throw ArchivePausedException()
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
    }
    digest.digest().joinToString("") { "%02x".format(it) }
}
internal fun archiveSha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun atomicReplace(source: File, destination: File) {
    Files.move(source.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
}

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val CLEANUP_PREFIX = ".archive-cleanup-"
private val SHA256 = Regex("^[0-9a-f]{64}$")
private val INTEGER_TEXT = Regex("^(0|-[1-9][0-9]*|[1-9][0-9]*)$")
private val SERVER_OBJECT_STATES = setOf("uploading", "uploaded", "verified")
private val SERVER_ARCHIVE_STATES = setOf("uploading", "verifying", "complete", "rejected")
private val LOCAL_ARCHIVE_STATES = SERVER_ARCHIVE_STATES +
    setOf("archived", "blocked", "auth_required", "cleanup_pending", "deleted_retained")
private const val MAX_WAV_BYTES = 512L * 1024 * 1024
private const val MAX_TIMELINE_BYTES = 32L * 1024 * 1024
private val ISO_MILLIS = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
