package org.vodog

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Looper
import android.content.ContentValues
import android.net.Uri
import android.provider.MediaStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.awaitAll
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.TimeUnit

/** S94: [OWNER_JOINED] = remote_original + caller_uplink, the default when a Pixel archive has an uplink track. */
enum class RecordingPairMode { ORIGINALS, COMPENSATED, OWNER_JOINED }

internal fun recordingTrackRoleMatches(
    track: RecordingAudioTrack,
    source: RecordingSource,
    version: Int,
    artifact: RecordingArtifact,
): Boolean = when (track) {
    RecordingAudioTrack.CALLER_PLAYOUT ->
        source == RecordingSource.PIXEL && version == 3 && artifact.sourceRole == "derived_playout"
    RecordingAudioTrack.CALLER_UPLINK -> source == RecordingSource.PIXEL && artifact.sourceRole == "uplink_capture"
    else -> artifact.sourceRole == "original_capture"
}

sealed interface RecordingPlaybackState {
    data object Idle : RecordingPlaybackState
    data class Loading(val callId: String, val source: RecordingSource, val track: RecordingAudioTrack) : RecordingPlaybackState
    data class Playing(
        val callId: String,
        val source: RecordingSource,
        val track: RecordingAudioTrack,
        val positionMs: Long = 0,
        val durationMs: Long = 0,
    ) : RecordingPlaybackState
    data class Paused(
        val callId: String,
        val source: RecordingSource,
        val track: RecordingAudioTrack,
        val positionMs: Long = 0,
        val durationMs: Long = 0,
    ) : RecordingPlaybackState
    data class Failed(val callId: String, val source: RecordingSource, val track: RecordingAudioTrack, val message: String) : RecordingPlaybackState
    data class LoadingPair(val callId: String, val source: RecordingSource, val mode: RecordingPairMode) : RecordingPlaybackState
    data class PlayingPair(
        val callId: String,
        val source: RecordingSource,
        val mode: RecordingPairMode,
        val positionMs: Long = 0,
        val durationMs: Long = 0,
    ) : RecordingPlaybackState
    data class PausedPair(
        val callId: String,
        val source: RecordingSource,
        val mode: RecordingPairMode,
        val positionMs: Long = 0,
        val durationMs: Long = 0,
    ) : RecordingPlaybackState
    data class FailedPair(val callId: String, val source: RecordingSource, val mode: RecordingPairMode, val message: String) : RecordingPlaybackState
}

internal fun recordingPlaybackPositionMs(state: RecordingPlaybackState): Long = when (state) {
    is RecordingPlaybackState.Playing -> state.positionMs
    is RecordingPlaybackState.Paused -> state.positionMs
    is RecordingPlaybackState.PlayingPair -> state.positionMs
    is RecordingPlaybackState.PausedPair -> state.positionMs
    else -> 0
}

internal fun recordingPlaybackDurationMs(state: RecordingPlaybackState): Long = when (state) {
    is RecordingPlaybackState.Playing -> state.durationMs
    is RecordingPlaybackState.Paused -> state.durationMs
    is RecordingPlaybackState.PlayingPair -> state.durationMs
    is RecordingPlaybackState.PausedPair -> state.durationMs
    else -> 0
}

internal fun clampRecordingSeek(positionMs: Long, durationMs: Long): Long =
    positionMs.coerceIn(0L, durationMs.coerceAtLeast(0L))

internal data class RecordingDownloadMetadata(val contentType: String, val contentLength: Long, val etag: String)

internal fun interface RecordingTrackDownloader {
    fun download(
        callId: String,
        source: RecordingSource,
        version: Int,
        track: RecordingAudioTrack,
        expectedSession: SessionSnapshot,
        artifact: RecordingArtifact,
        target: File,
        cancellation: RecordingDownloadCancellation,
    ): RecordingDownloadMetadata
}

internal class RecordingDownloadCancellation {
    private val cancelled = AtomicBoolean(false)
    private val activeCall = AtomicReference<Call?>(null)

    fun attach(value: Call) {
        if (!activeCall.compareAndSet(null, value)) error("已有录音下载请求")
        if (cancelled.get()) {
            activeCall.compareAndSet(value, null)
            value.cancel()
            throw CancellationException("录音下载已取消")
        }
    }

    fun detach(value: Call) {
        activeCall.compareAndSet(value, null)
    }

    fun cancel() {
        cancelled.set(true)
        activeCall.getAndSet(null)?.cancel()
    }

    fun throwIfCancelled() {
        if (cancelled.get()) throw CancellationException("录音下载已取消")
    }
}

internal object RecordingFileVerifier {
    fun sha256(file: File, cancellation: RecordingDownloadCancellation? = null): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
                cancellation?.throwIfCancelled()
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun verify(file: File, artifact: RecordingArtifact, cancellation: RecordingDownloadCancellation? = null): Boolean =
        artifact.bytes > 0 && file.length() == artifact.bytes &&
            sha256(file, cancellation).equals(artifact.sha256, ignoreCase = true)
}

internal object RecordingPlaybackAdmission {
    fun verifyCurrent(
        sessions: SessionCoordinator,
        expectedSession: SessionSnapshot,
        file: File,
        artifact: RecordingArtifact,
        cancellation: RecordingDownloadCancellation? = null,
    ): Boolean {
        sessions.resolveSameLogin(expectedSession)
        val valid = RecordingFileVerifier.verify(file, artifact, cancellation)
        sessions.resolveSameLogin(expectedSession)
        cancellation?.throwIfCancelled()
        return valid
    }
}

internal class HttpRecordingTrackDownloader(
    private val sessions: SessionCoordinator,
    private val refreshAfterUnauthorized: (SessionSnapshot) -> SessionSnapshot,
    private val http: OkHttpClient = recordingHttpClient,
    /** null = 按请求读 [ClientEndpoint.baseUrl]（S72b 蜂窝走中转）。 */
    baseUrl: String? = null,
) : RecordingTrackDownloader {
    private val fixedBaseUrl = baseUrl
    private fun base(): String = fixedBaseUrl ?: ClientEndpoint.baseUrl()

    override fun download(
        callId: String,
        source: RecordingSource,
        version: Int,
        track: RecordingAudioTrack,
        expectedSession: SessionSnapshot,
        artifact: RecordingArtifact,
        target: File,
        cancellation: RecordingDownloadCancellation,
    ): RecordingDownloadMetadata {
        return withRecordingBearerRetry(
            sessions = sessions,
            expectedSession = expectedSession,
            refreshAfterUnauthorized = refreshAfterUnauthorized,
        ) { current ->
            try {
                downloadOnce(callId, source, version, track, expectedSession, current, artifact, target, cancellation)
            } catch (error: RecordingUnauthorizedException) {
                target.delete()
                throw error
            }
        }
    }

    fun downloadAttachment(
        callId: String,
        source: RecordingSource,
        version: Int,
        track: RecordingAudioTrack,
        expectedSession: SessionSnapshot,
        artifact: RecordingArtifact,
        target: File,
        cancellation: RecordingDownloadCancellation,
    ): RecordingDownloadMetadata {
        return withRecordingBearerRetry(
            sessions = sessions,
            expectedSession = expectedSession,
            refreshAfterUnauthorized = refreshAfterUnauthorized,
        ) { current ->
            try {
                var waitMs = 500L
                repeat(3) { attempt ->
                    try {
                        return@withRecordingBearerRetry downloadAttachmentOnce(
                            callId, source, version, track, expectedSession, current, artifact, target, cancellation,
                        )
                    } catch (busy: RecordingVerificationBusyException) {
                        target.delete()
                        if (attempt == 2) throw busy
                        cancellation.throwIfCancelled()
                        Thread.sleep(waitMs)
                        waitMs = 1000L
                    }
                }
                error("录音核验繁忙，请稍后重试")
            } catch (error: RecordingUnauthorizedException) {
                target.delete()
                throw error
            }
        }
    }

    /**
     * S36 C4: the MP3 export is a server-side transcode, so its bytes/hash/媒体类型 have nothing to
     * do with the manifest artifact — the whole `validateFullRecordingResponse` + `verifyCurrent`
     * chain the originals use would always fail on it. This is the deliberately light path: bearer
     * refresh and cancellation as usual, `audio/mpeg` and the advertised length as the only checks.
     */
    fun downloadMp3(
        callId: String,
        source: RecordingSource,
        track: RecordingAudioTrack,
        expectedSession: SessionSnapshot,
        target: File,
        cancellation: RecordingDownloadCancellation,
    ): Unit = withRecordingBearerRetry(
        sessions = sessions,
        expectedSession = expectedSession,
        refreshAfterUnauthorized = refreshAfterUnauthorized,
    ) { current ->
        cancellation.throwIfCancelled()
        val session = checkNotNull(current.session) { "需要登录后保存录音" }
        val url = base().trimEnd('/') +
            ClientApiRoutes.recordingTrack(callId, track, source, attachment = true, format = "mp3")
        val request = Request.Builder().url(url)
            .header("Accept", "audio/mpeg")
            .header("Authorization", "Bearer ${session.token}")
            .get()
            .build()
        withResponse(request, cancellation) { response ->
            if (response.code == 401) {
                target.delete()
                throw RecordingUnauthorizedException()
            }
            // Control keeps the 501 stub when ffmpeg is missing on the server.
            if (response.code == 501) throw IllegalStateException("服务器尚未开启 MP3 导出")
            if (response.code != 200) throw responseFailure(response)
            val type = response.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase()
            require(type == "audio/mpeg") { "服务器返回的不是 MP3" }
            val advertised = response.header("Content-Length")?.toLongOrNull() ?: -1
            checkNotNull(response.body) { "录音响应没有内容" }.byteStream().use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        cancellation.throwIfCancelled()
                        sessions.resolveSameLogin(expectedSession)
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        output.write(buffer, 0, count)
                    }
                    require(total > 0) { "MP3 下载为空" }
                    require(advertised < 0 || total == advertised) { "MP3 下载不完整" }
                }
            }
            cancellation.throwIfCancelled()
        }
    }

    private fun downloadOnce(
        callId: String,
        source: RecordingSource,
        version: Int,
        track: RecordingAudioTrack,
        expectedSession: SessionSnapshot,
        requestSession: SessionSnapshot,
        artifact: RecordingArtifact,
        target: File,
        cancellation: RecordingDownloadCancellation,
    ): RecordingDownloadMetadata {
        cancellation.throwIfCancelled()
        val session = checkNotNull(requestSession.session) { "需要登录后播放录音" }
        require((source == RecordingSource.MEDIA_NODE && version == 1 && artifact.mediaType == "audio/ogg") ||
            (source == RecordingSource.PIXEL && version in setOf(2, 3) && artifact.mediaType == "audio/wav")) {
            "录音来源、版本与格式不一致"
        }
        require(recordingTrackRoleMatches(track, source, version, artifact)) { "录音声轨来源不一致" }
        val url = base().trimEnd('/') + ClientApiRoutes.recordingTrack(callId, track, source)
        preflight(url, session.token, expectedSession, artifact, cancellation)
        cancellation.throwIfCancelled()
        val latest = sessions.resolveSameLogin(expectedSession)
        val latestToken = checkNotNull(latest.session).token
        val request = Request.Builder().url(url)
            .header("Accept", artifact.mediaType)
            .header("Authorization", "Bearer $latestToken")
            .get()
            .build()
        return withResponse(request, cancellation) { response ->
            val status = response.code
            if (status == 401) throw RecordingUnauthorizedException()
            if (status != 200) throw responseFailure(response)
            val type = response.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase()
            val length = response.header("Content-Length")?.toLongOrNull() ?: -1
            val etag = response.header("ETag").orEmpty()
            validateFullRecordingResponse(type, length, etag, artifact)
            checkNotNull(response.body) { "录音响应没有内容" }.byteStream().use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        cancellation.throwIfCancelled()
                        sessions.resolveSameLogin(expectedSession)
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= artifact.bytes) { "录音内容超过清单大小" }
                        output.write(buffer, 0, count)
                    }
                    require(total == artifact.bytes) { "录音下载不完整" }
                }
            }
            sessions.resolveSameLogin(expectedSession)
            cancellation.throwIfCancelled()
            RecordingDownloadMetadata(type, length, etag)
        }
    }

    private fun downloadAttachmentOnce(
        callId: String,
        source: RecordingSource,
        version: Int,
        track: RecordingAudioTrack,
        expectedSession: SessionSnapshot,
        requestSession: SessionSnapshot,
        artifact: RecordingArtifact,
        target: File,
        cancellation: RecordingDownloadCancellation,
    ): RecordingDownloadMetadata {
        cancellation.throwIfCancelled()
        val session = checkNotNull(requestSession.session) { "需要登录后保存录音" }
        require((source == RecordingSource.MEDIA_NODE && version == 1 && artifact.mediaType == "audio/ogg") ||
            (source == RecordingSource.PIXEL && version in setOf(2, 3) && artifact.mediaType == "audio/wav")) {
            "录音来源、版本与格式不一致"
        }
        require(recordingTrackRoleMatches(track, source, version, artifact)) { "录音声轨来源不一致" }
        val url = base().trimEnd('/') + ClientApiRoutes.recordingTrack(callId, track, source, attachment = true)
        val latest = sessions.resolveSameLogin(expectedSession)
        val latestToken = checkNotNull(latest.session).token
        val request = Request.Builder().url(url)
            .header("Accept", artifact.mediaType)
            .header("Authorization", "Bearer ${latestToken.ifBlank { session.token }}")
            .get()
            .build()
        return withResponse(request, cancellation) { response ->
            val status = response.code
            if (status == 401) throw RecordingUnauthorizedException()
            if (status == 503 && recordingErrorCode(response) == "RECORDING_VERIFICATION_BUSY") {
                throw RecordingVerificationBusyException()
            }
            if (status != 200) throw responseFailure(response)
            val type = response.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase()
            val length = response.header("Content-Length")?.toLongOrNull() ?: -1
            val etag = response.header("ETag").orEmpty()
            validateFullRecordingResponse(type, length, etag, artifact)
            checkNotNull(response.body) { "录音响应没有内容" }.byteStream().use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        cancellation.throwIfCancelled()
                        sessions.resolveSameLogin(expectedSession)
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= artifact.bytes) { "录音内容超过清单大小" }
                        output.write(buffer, 0, count)
                    }
                    require(total == artifact.bytes) { "录音下载不完整" }
                }
            }
            sessions.resolveSameLogin(expectedSession)
            cancellation.throwIfCancelled()
            RecordingDownloadMetadata(type, length, etag)
        }
    }

    private fun preflight(
        url: String,
        bearer: String,
        expectedSession: SessionSnapshot,
        artifact: RecordingArtifact,
        cancellation: RecordingDownloadCancellation,
    ) {
        val request = Request.Builder().url(url)
            .header("Accept", artifact.mediaType)
            .header("Authorization", "Bearer $bearer")
            .header("Range", "bytes=0-0")
            .header("If-Range", quotedRecordingEtag(artifact))
            .get()
            .build()
        withResponse(request, cancellation) { response ->
            val status = response.code
            if (status == 401) throw RecordingUnauthorizedException()
            if (status !in setOf(200, 206)) throw responseFailure(response)
            validateRecordingPreflight(
                status = status,
                contentType = response.header("Content-Type").orEmpty(),
                contentLength = response.header("Content-Length")?.toLongOrNull() ?: -1,
                etag = response.header("ETag").orEmpty(),
                acceptRanges = response.header("Accept-Ranges").orEmpty(),
                contentRange = response.header("Content-Range"),
                artifact = artifact,
            )
            sessions.resolveSameLogin(expectedSession)
            cancellation.throwIfCancelled()
        }
    }

    private fun <T> withResponse(
        request: Request,
        cancellation: RecordingDownloadCancellation,
        block: (Response) -> T,
    ): T {
        cancellation.throwIfCancelled()
        val call = http.newCall(request)
        cancellation.attach(call)
        return try {
            call.execute().use(block)
        } catch (error: IOException) {
            cancellation.throwIfCancelled()
            throw IllegalStateException("录音暂时无法下载", error)
        } finally {
            cancellation.detach(call)
        }
    }

    private fun responseFailure(response: Response): IllegalStateException {
        val message = response.body?.byteStream()?.use { input -> String(input.readAtMost(4096), Charsets.UTF_8) }.orEmpty()
        val apiMessage = runCatching { JSONObject(message).getJSONObject("error").optString("message") }.getOrNull()
        return IllegalStateException(apiMessage?.takeIf(String::isNotBlank) ?: "录音暂时无法下载")
    }

    private fun recordingErrorCode(response: Response): String? {
        val message = runCatching { response.peekBody(4096).string() }.getOrNull().orEmpty()
        return runCatching { JSONObject(message).getJSONObject("error").optString("code") }.getOrNull()
            ?.takeIf(String::isNotBlank)
    }
}

private val recordingHttpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
}

internal fun quotedRecordingEtag(artifact: RecordingArtifact) = "\"${artifact.sha256}\""

internal fun validateRecordingPreflight(
    status: Int,
    contentType: String,
    contentLength: Long,
    etag: String,
    acceptRanges: String,
    contentRange: String?,
    artifact: RecordingArtifact,
) {
    require(contentType.substringBefore(';').trim().lowercase() == artifact.mediaType) { "录音格式与清单不一致" }
    require(etag == quotedRecordingEtag(artifact)) { "录音版本与清单不一致" }
    require(acceptRanges.equals("bytes", ignoreCase = true)) { "录音不支持安全分段读取" }
    when (status) {
        206 -> require(contentLength == 1L && contentRange == "bytes 0-0/${artifact.bytes}") { "录音分段响应无效" }
        200 -> require(contentLength == artifact.bytes) { "录音大小与清单不一致" }
        else -> throw IllegalArgumentException("录音预检响应无效")
    }
}

internal fun validateFullRecordingResponse(
    contentType: String,
    contentLength: Long,
    etag: String,
    artifact: RecordingArtifact,
) {
    require(contentType == artifact.mediaType) { "录音格式与清单不一致" }
    require(contentLength == artifact.bytes) { "录音大小与清单不一致" }
    require(etag == quotedRecordingEtag(artifact)) { "录音版本与清单不一致" }
}

internal class RecordingUnauthorizedException : Exception()
internal class RecordingVerificationBusyException : IllegalStateException("录音核验繁忙，请稍后重试")

internal fun <T> withRecordingBearerRetry(
    sessions: SessionCoordinator,
    expectedSession: SessionSnapshot,
    refreshAfterUnauthorized: (SessionSnapshot) -> SessionSnapshot,
    operation: (SessionSnapshot) -> T,
): T {
    val first = sessions.resolveSameLogin(expectedSession)
    return try {
        operation(first)
    } catch (_: RecordingUnauthorizedException) {
        val refreshed = refreshAfterUnauthorized(first)
        sessions.resolveSameLogin(expectedSession)
        operation(refreshed)
    }
}

class RecordingPlaybackController private constructor(context: Context) {
    private val app = context.applicationContext
    private val sessions = ClientSessionProcess.coordinator(app)
    private val httpDownloader = HttpRecordingTrackDownloader(
        sessions,
        ClientApi(sessions)::refreshLongLivedRequestAfterUnauthorized,
    )
    private val downloader: RecordingTrackDownloader = httpDownloader
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val operation = AtomicLong()
    private val _state = MutableStateFlow<RecordingPlaybackState>(RecordingPlaybackState.Idle)
    val state: StateFlow<RecordingPlaybackState> = _state.asStateFlow()
    private var job: Job? = null
    private var progressJob: Job? = null
    private var player: MediaPlayer? = null
    private var pairedPlayer: MediaPlayer? = null
    private var localFile: File? = null
    private var pairedLocalFile: File? = null
    private var downloadCancellation: RecordingDownloadCancellation? = null
    private var playbackIdentity: ServiceSessionIdentity? = null
    private var contractDurationMs: Long = 0

    init {
        ClientSessionProcess.listen {
            val expected = playbackIdentity
            if (expected != null && !serviceIdentityMatches(expected, currentServiceIdentity(app))) stop()
        }
    }

    fun play(callId: String, manifest: RecordingManifest, track: RecordingAudioTrack, artifact: RecordingArtifact) {
        stop()
        if (ClientCallRuntime.state.value.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)) {
            _state.value = RecordingPlaybackState.Failed(callId, manifest.source, track, "通话音频正在使用中")
            return
        }
        if (!manifest.callId.equals(callId, ignoreCase = true) || artifact.track != track || manifest.artifact(track) != artifact) {
            _state.value = RecordingPlaybackState.Failed(callId, manifest.source, track, "录音信息与通话不一致")
            return
        }
        val expected = sessions.snapshot()
        if (expected.session == null || artifact.bytes <= 0) {
            _state.value = RecordingPlaybackState.Failed(callId, manifest.source, track, "该轨道没有可播放内容")
            return
        }
        val identity = currentServiceIdentity(app)
        if (identity == null) {
            _state.value = RecordingPlaybackState.Failed(callId, manifest.source, track, "登录状态已变化")
            return
        }
        val id = operation.incrementAndGet()
        playbackIdentity = identity
        contractDurationMs = artifact.durationMs ?: 0
        val cancellation = RecordingDownloadCancellation().also { downloadCancellation = it }
        _state.value = RecordingPlaybackState.Loading(callId, manifest.source, track)
        job = scope.launch {
            var candidate: File? = null
            var candidatePlayer: MediaPlayer? = null
            try {
                val extension = if (artifact.mediaType == "audio/wav") ".wav" else ".ogg"
                val downloadedFile = File.createTempFile("caller-recording-${UUID.randomUUID()}-", extension, app.cacheDir)
                candidate = downloadedFile
                withContext(Dispatchers.IO) {
                    downloader.download(callId, manifest.source, manifest.version, track, expected, artifact, downloadedFile, cancellation)
                    check(RecordingPlaybackAdmission.verifyCurrent(sessions, expected, downloadedFile, artifact, cancellation)) {
                        "录音完整性校验失败"
                    }
                }
                if (!playbackOperationCurrent(id, operation.get())) throw CancellationException()
                val newPlayer = MediaPlayer().also { candidatePlayer = it }.apply {
                    setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).setUsage(AudioAttributes.USAGE_MEDIA).build())
                    setDataSource(downloadedFile.absolutePath)
                    setOnCompletionListener { completed ->
                        if (playbackOperationCurrent(id, operation.get()) && player === completed) stop()
                    }
                    setOnErrorListener { failedPlayer, _, _ ->
                        if (playbackOperationCurrent(id, operation.get()) && player === failedPlayer) {
                            fail(id, callId, manifest.source, track, "当前系统无法播放这段录音")
                        }
                        true
                    }
                    setOnPreparedListener { prepared ->
                        if (!playbackOperationCurrent(id, operation.get()) || player !== prepared) {
                            prepared.release()
                            downloadedFile.delete()
                            return@setOnPreparedListener
                        }
                        if (runCatching { sessions.resolveSameLogin(expected) }.isFailure ||
                            ClientCallRuntime.state.value.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)
                        ) return@setOnPreparedListener fail(id, callId, manifest.source, track, "通话状态已变化，录音播放已停止")
                        val playerDuration = runCatching { prepared.duration.toLong() }.getOrNull()?.takeIf { it > 0 } ?: 0
                        val duration = contractDurationMs.takeIf { it > 0 } ?: playerDuration
                        prepared.start()
                        _state.value = RecordingPlaybackState.Playing(callId, manifest.source, track, 0, duration)
                        startProgress()
                    }
                }
                if (!playbackOperationCurrent(id, operation.get())) {
                    newPlayer.release()
                    throw CancellationException()
                }
                localFile = downloadedFile
                player = newPlayer
                candidatePlayer = null
                newPlayer.prepareAsync()
            } catch (_: CancellationException) {
                candidatePlayer?.release()
                candidate?.delete()
            } catch (error: Exception) {
                candidatePlayer?.release()
                candidate?.delete()
                fail(id, callId, manifest.source, track, error.message ?: "录音播放失败")
            }
        }
    }

    fun playPair(callId: String, manifest: RecordingManifest, mode: RecordingPairMode) {
        stop()
        val artifacts = manifest.pairArtifacts(mode)
        if (artifacts.size != 2 || artifacts.any { it.bytes <= 0 }) {
            _state.value = RecordingPlaybackState.FailedPair(callId, manifest.source, mode, "双方声轨尚未齐全，请分别播放可用原声")
            return
        }
        if (ClientCallRuntime.state.value.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)) {
            _state.value = RecordingPlaybackState.FailedPair(callId, manifest.source, mode, "通话音频正在使用中")
            return
        }
        if (!manifest.callId.equals(callId, ignoreCase = true) || artifacts.any { manifest.artifact(it.track) != it }) {
            _state.value = RecordingPlaybackState.FailedPair(callId, manifest.source, mode, "录音信息与通话不一致")
            return
        }
        val expected = sessions.snapshot()
        val identity = currentServiceIdentity(app)
        if (expected.session == null || identity == null) {
            _state.value = RecordingPlaybackState.FailedPair(callId, manifest.source, mode, "登录状态已变化")
            return
        }
        val id = operation.incrementAndGet()
        playbackIdentity = identity
        contractDurationMs = manifest.pairDurationMs(mode) ?: 0
        val cancellation = RecordingDownloadCancellation().also { downloadCancellation = it }
        _state.value = RecordingPlaybackState.LoadingPair(callId, manifest.source, mode)
        job = scope.launch {
            val candidates = mutableListOf<File>()
            val candidatePlayers = mutableListOf<MediaPlayer>()
            try {
                withContext(Dispatchers.IO) {
                    artifacts.forEach { artifact ->
                        val extension = if (artifact.mediaType == "audio/wav") ".wav" else ".ogg"
                        val file = File.createTempFile("caller-recording-${UUID.randomUUID()}-", extension, app.cacheDir)
                        candidates += file
                        downloader.download(callId, manifest.source, manifest.version, artifact.track, expected, artifact, file, cancellation)
                        check(RecordingPlaybackAdmission.verifyCurrent(sessions, expected, file, artifact, cancellation)) {
                            "录音完整性校验失败"
                        }
                    }
                }
                if (!playbackOperationCurrent(id, operation.get())) throw CancellationException()
                val prepared = artifacts.mapIndexed { index, _ ->
                    val ready = CompletableDeferred<Unit>()
                    MediaPlayer().also(candidatePlayers::add).apply {
                        setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).setUsage(AudioAttributes.USAGE_MEDIA).build())
                        setDataSource(candidates[index].absolutePath)
                        setOnPreparedListener { ready.complete(Unit) }
                        setOnErrorListener { failedPlayer, _, _ ->
                            if (!ready.isCompleted) {
                                ready.completeExceptionally(IllegalStateException("当前系统无法播放双向录音"))
                            } else if (playbackOperationCurrent(id, operation.get()) &&
                                (player === failedPlayer || pairedPlayer === failedPlayer)
                            ) {
                                failPair(id, callId, manifest.source, mode, "当前系统无法播放双向录音")
                            }
                            true
                        }
                    }.let { it to ready }
                }
                player = prepared[0].first
                pairedPlayer = prepared[1].first
                localFile = candidates[0]
                pairedLocalFile = candidates[1]
                val completedPlayers = mutableSetOf<MediaPlayer>()
                prepared.forEach { (mediaPlayer, _) ->
                    mediaPlayer.setOnCompletionListener { completed ->
                        if (playbackOperationCurrent(id, operation.get()) &&
                            (player === completed || pairedPlayer === completed) && completedPlayers.add(completed) &&
                            completedPlayers.size == 2
                        ) stop()
                    }
                }
                prepared.forEach { (mediaPlayer, _) -> mediaPlayer.prepareAsync() }
                prepared.map { it.second }.awaitAll()
                if (!playbackOperationCurrent(id, operation.get()) ||
                    runCatching { sessions.resolveSameLogin(expected) }.isFailure ||
                    ClientCallRuntime.state.value.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)
                ) throw CancellationException()
                player?.start()
                pairedPlayer?.start()
                val playerDuration = listOf(player, pairedPlayer).mapNotNull { media ->
                    runCatching { media?.duration?.toLong() }.getOrNull()?.takeIf { it > 0 }
                }.maxOrNull() ?: 0
                val duration = contractDurationMs.takeIf { it > 0 } ?: playerDuration
                _state.value = RecordingPlaybackState.PlayingPair(callId, manifest.source, mode, 0, duration)
                startProgress()
                candidatePlayers.clear()
                candidates.clear()
            } catch (_: CancellationException) {
                candidatePlayers.forEach { runCatching(it::release) }
                candidates.forEach(File::delete)
                if (operation.get() == id) stop()
            } catch (error: Exception) {
                candidatePlayers.forEach { runCatching(it::release) }
                candidates.forEach(File::delete)
                failPair(id, callId, manifest.source, mode, error.message ?: "双向录音播放失败")
            }
        }
    }

    fun stop() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            scope.launch { stop() }
            return
        }
        operation.incrementAndGet()
        downloadCancellation?.cancel()
        downloadCancellation = null
        progressJob?.cancel()
        progressJob = null
        job?.cancel()
        job = null
        contractDurationMs = 0
        runCatching { player?.stop() }
        player?.release()
        player = null
        runCatching { pairedPlayer?.stop() }
        pairedPlayer?.release()
        pairedPlayer = null
        localFile?.delete()
        localFile = null
        pairedLocalFile?.delete()
        pairedLocalFile = null
        playbackIdentity = null
        _state.value = RecordingPlaybackState.Idle
    }

    fun pause() {
        progressJob?.cancel()
        progressJob = null
        when (val current = _state.value) {
            is RecordingPlaybackState.Playing -> {
                runCatching { player?.pause() }.onFailure { stop(); return }
                _state.value = RecordingPlaybackState.Paused(
                    current.callId, current.source, current.track,
                    currentPositionMs(), resolvedDurationMs(current.durationMs),
                )
            }
            is RecordingPlaybackState.PlayingPair -> {
                runCatching {
                    player?.pause()
                    pairedPlayer?.pause()
                }.onFailure { stop(); return }
                _state.value = RecordingPlaybackState.PausedPair(
                    current.callId, current.source, current.mode,
                    currentPositionMs(), resolvedDurationMs(current.durationMs),
                )
            }
            else -> Unit
        }
    }

    fun resume() {
        if (ClientCallRuntime.state.value.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED) ||
            playbackIdentity?.let { serviceIdentityMatches(it, currentServiceIdentity(app)) } != true
        ) {
            stop()
            return
        }
        when (val current = _state.value) {
            is RecordingPlaybackState.Paused -> runCatching {
                player?.start()
                _state.value = RecordingPlaybackState.Playing(
                    current.callId, current.source, current.track, current.positionMs, current.durationMs,
                )
                startProgress()
            }.onFailure { stop() }
            is RecordingPlaybackState.PausedPair -> runCatching {
                player?.start()
                pairedPlayer?.start()
                _state.value = RecordingPlaybackState.PlayingPair(
                    current.callId, current.source, current.mode, current.positionMs, current.durationMs,
                )
                startProgress()
            }.onFailure { stop() }
            else -> Unit
        }
    }

    fun seek(positionMs: Long) {
        when (val current = _state.value) {
            is RecordingPlaybackState.Playing, is RecordingPlaybackState.Paused,
            is RecordingPlaybackState.PlayingPair, is RecordingPlaybackState.PausedPair,
            -> {
                val duration = recordingPlaybackDurationMs(current)
                val target = clampRecordingSeek(positionMs, duration)
                runCatching { player?.seekTo(target.toInt()) }.onFailure { return }
                runCatching { pairedPlayer?.seekTo(target.toInt()) }
                _state.value = when (current) {
                    is RecordingPlaybackState.Playing -> current.copy(positionMs = target)
                    is RecordingPlaybackState.Paused -> current.copy(positionMs = target)
                    is RecordingPlaybackState.PlayingPair -> current.copy(positionMs = target)
                    is RecordingPlaybackState.PausedPair -> current.copy(positionMs = target)
                    else -> current
                }
            }
            else -> Unit
        }
    }

    /** [format] is `"mp3"` for the S36 C4 export; `null` keeps the original archived encoding. */
    suspend fun exportTracks(
        callId: String,
        manifest: RecordingManifest,
        tracks: List<RecordingAudioTrack>,
        format: String? = null,
    ): List<File> {
        if (!manifest.callId.equals(callId, ignoreCase = true)) error("录音信息与通话不一致")
        val expected = sessions.snapshot()
        checkNotNull(expected.session) { "需要登录后保存录音" }
        val cancellation = RecordingDownloadCancellation()
        return withContext(Dispatchers.IO) {
            tracks.map { track ->
                val mp3 = format == "mp3"
                val artifact = manifest.artifact(track)
                // S36 C4: conversation 是服务器混出来的虚拟轨，清单里没有；其余轨仍必须在清单里。
                if (artifact == null) require(mp3 && track == RecordingAudioTrack.CONVERSATION) { "该轨道没有可保存内容" }
                else require(artifact.bytes > 0) { "该轨道没有可保存内容" }
                val extension = when {
                    mp3 -> ".mp3"
                    artifact?.mediaType == "audio/wav" -> ".wav"
                    else -> ".ogg"
                }
                val file = File.createTempFile(
                    "caller-export-${UUID.randomUUID()}-", extension, recordingExportDir(app),
                )
                try {
                    if (mp3) httpDownloader.downloadMp3(
                        callId, manifest.source, track, expected, file, cancellation,
                    ) else {
                        val original = checkNotNull(artifact)
                        httpDownloader.downloadAttachment(
                            callId, manifest.source, manifest.version, track, expected, original, file, cancellation,
                        )
                        // 原始轨道才对得上清单的 sha256/字节数；转码产物对不上，见 downloadMp3。
                        check(RecordingPlaybackAdmission.verifyCurrent(sessions, expected, file, original, cancellation)) {
                            "录音完整性校验失败"
                        }
                    }
                    file
                } catch (error: Exception) {
                    file.delete()
                    throw error
                }
            }
        }
    }

    private fun startProgress() {
        progressJob?.cancel()
        progressJob = scope.launch {
            while (isActive) {
                when (val current = _state.value) {
                    is RecordingPlaybackState.Playing -> {
                        _state.value = current.copy(
                            positionMs = currentPositionMs(),
                            durationMs = resolvedDurationMs(current.durationMs),
                        )
                    }
                    is RecordingPlaybackState.PlayingPair -> {
                        _state.value = current.copy(
                            positionMs = currentPositionMs(),
                            durationMs = resolvedDurationMs(current.durationMs),
                        )
                    }
                    else -> return@launch
                }
                delay(200)
            }
        }
    }

    private fun currentPositionMs(): Long =
        runCatching { player?.currentPosition?.toLong() }.getOrNull()?.coerceAtLeast(0) ?: 0

    private fun resolvedDurationMs(known: Long): Long {
        if (known > 0) return known
        if (contractDurationMs > 0) return contractDurationMs
        val playerDuration = runCatching { player?.duration?.toLong() }.getOrNull()?.takeIf { it > 0 } ?: 0
        val pairedDuration = runCatching { pairedPlayer?.duration?.toLong() }.getOrNull()?.takeIf { it > 0 } ?: 0
        return maxOf(playerDuration, pairedDuration)
    }

    private fun fail(id: Long, callId: String, source: RecordingSource, track: RecordingAudioTrack, message: String) {
        if (operation.get() != id) return
        downloadCancellation?.cancel()
        downloadCancellation = null
        progressJob?.cancel()
        progressJob = null
        job = null
        runCatching { player?.release() }
        player = null
        localFile?.delete()
        localFile = null
        playbackIdentity = null
        _state.value = RecordingPlaybackState.Failed(callId, source, track, message)
    }

    private fun failPair(id: Long, callId: String, source: RecordingSource, mode: RecordingPairMode, message: String) {
        if (operation.get() != id) return
        downloadCancellation?.cancel()
        downloadCancellation = null
        progressJob?.cancel()
        progressJob = null
        job = null
        runCatching { player?.release() }
        runCatching { pairedPlayer?.release() }
        player = null
        pairedPlayer = null
        localFile?.delete()
        pairedLocalFile?.delete()
        localFile = null
        pairedLocalFile = null
        playbackIdentity = null
        _state.value = RecordingPlaybackState.FailedPair(callId, source, mode, message)
    }

    companion object {
        @Volatile private var instance: RecordingPlaybackController? = null
        fun get(context: Context): RecordingPlaybackController = instance ?: synchronized(this) {
            instance ?: RecordingPlaybackController(context).also { instance = it }
        }
    }
}

internal fun playbackOperationCurrent(expected: Long, current: Long): Boolean = expected == current

// ---- S39 §F 导出临时文件 ----------------------------------------------------------------------

/**
 * 导出的 MP3 落在 `cacheDir/exports/` 而不是 `cacheDir` 根目录：根目录还住着播放用的临时文件，混在
 * 一起就没法「按目录整体回收」。正常路径上 [RecordingSection] 存进「下载」之后当场删掉这一份；留下
 * 来的只有进程被杀 / 存盘半路失败的残骸，由下面这条 1 小时的过期规则收走。
 */
internal const val RECORDING_EXPORT_DIR_NAME = "exports"

internal val RECORDING_EXPORT_TTL_MS: Long = TimeUnit.HOURS.toMillis(1)

internal fun recordingExportDir(context: Context): File =
    File(context.cacheDir, RECORDING_EXPORT_DIR_NAME).apply { mkdirs() }

/**
 * 过期规则（纯函数，只读 [File.lastModified]）：`now - mtime > ttl` 就该走。读不到 mtime 的文件
 * （`lastModified()` 返回 0）一律算过期 —— 这是缓存目录，留着没有意义。mtime 在未来的文件不动。
 */
internal fun expiredRecordingExports(
    files: List<File>,
    nowMs: Long,
    ttlMs: Long = RECORDING_EXPORT_TTL_MS,
): List<File> = files.filter { nowMs - it.lastModified() > ttlMs }

internal fun pruneRecordingExports(context: Context, nowMs: Long = System.currentTimeMillis()) {
    val files = File(context.cacheDir, RECORDING_EXPORT_DIR_NAME).listFiles()?.toList().orEmpty()
    // ponytail: 同步 listFiles + delete，目录常空（导出成功当场就删了）；真攒起来了再挪到 IO 线程。
    expiredRecordingExports(files, nowMs).forEach { runCatching { it.delete() } }
}

internal fun persistRecordingDownload(
    context: Context,
    file: File,
    displayName: String,
    mimeType: String,
): Uri {
    val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, displayName)
        put(MediaStore.Downloads.MIME_TYPE, mimeType)
        put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val resolver = context.contentResolver
    val uri = checkNotNull(resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)) {
        "无法保存到下载目录"
    }
    try {
        resolver.openOutputStream(uri).use { output ->
            checkNotNull(output) { "无法写入下载目录" }
            file.inputStream().use { input -> input.copyTo(output) }
        }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return uri
    } catch (error: Exception) {
        resolver.delete(uri, null, null)
        throw error
    }
}

private fun InputStream.readAtMost(limit: Int): ByteArray {
    val output = ByteArrayOutputStream(limit)
    val buffer = ByteArray(minOf(1024, limit))
    while (output.size() < limit) {
        val count = read(buffer, 0, minOf(buffer.size, limit - output.size()))
        if (count < 0) break
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}
