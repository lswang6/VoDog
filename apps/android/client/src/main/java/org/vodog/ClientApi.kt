package org.vodog

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class ApiError(
    val status: Int,
    val code: String,
    override val message: String,
    val details: JSONObject? = null,
) : Exception(message)

/**
 * S36 C3: 每一条被抛出去的 API 失败都进诊断时间线（路径 + 状态码 + 服务端错误码）。
 * S36b D1: 断网时同一条路径会每秒失败一次，所以同类错误 60 秒内只留「第一条 + 一条带 `repeat` 的汇总」。
 */
internal fun ApiError.logToDiag(path: String) = ClientDiag.logApiError(path, status, code)

data class PasskeyChallenge(val challengeId: String, val requestJson: String)
data class TurnstileConfig(val enabled: Boolean, val siteKey: String?)

object ClientApiRoutes {
    const val AUTH_CONFIG = "/auth/config"
    const val LOGIN = "/auth/login"
    const val ME = "/auth/me"
    const val REFRESH = "/auth/refresh"
    const val LOGOUT = "/auth/logout"
    const val SIMS = "/sims"
    const val CALLS = "/calls"
    const val SMS = "/sms"
    const val REPORT_CALLS = "/reports/calls"
    const val OUTBOUND_CALL = "/calls/outbound"
    const val OUTBOUND_SMS = "/sms/outbound"
    const val PASSKEYS = "/passkeys"
    const val PASSKEY_REGISTER_OPTIONS = "/passkeys/register/options"
    const val PASSKEY_REGISTER_VERIFY = "/passkeys/register/verify"
    const val PASSKEY_AUTH_OPTIONS = "/passkeys/authenticate/options"
    const val PASSKEY_AUTH_VERIFY = "/passkeys/authenticate/verify"
    const val MEDIA_PROBE_OPTIONS = "/media/probes/options"
    const val MEDIA_PROBE_RESULTS = "/media/probes/results"
    const val MEDIA_QUALITY_PROBE_OPTIONS = "/media/quality-probes/options"
    const val MEDIA_QUALITY_PROBE_RESULTS = "/media/quality-probes/results"
    // S21 §A/§B/§D. Every one of these is new in S21; a control service that predates the round
    // answers 404 and the caller degrades instead of failing the tab.
    const val CONTACTS = "/contacts"
    const val CONTACTS_IMPORT = "/contacts/import"
    const val BLOCKLIST = "/blocklist"
    const val GATEWAYS_POWER = "/gateways/power"
    // S24 决策 3. Plural on the read, singular on the write — a Control that predates S24 answers 404
    // and the 设置 section hides itself.
    const val AI_VOICE_PROVIDERS = "/ai/voice-providers"
    const val AI_VOICE_PROVIDER = "/ai/voice-provider"
    /** S36 C3: 结构化诊断事件，来源靠 `X-Diag-Source` 头，不在体里。 */
    const val DIAG_EVENTS = "/diag/events"
    // S30 §1. 删除没有幂等键：`DELETE /calls/:id` 天然幂等（重复一次是 404），两条短信删除是按 id /
    // 按线程键的集合操作，重放也只会把已经删掉的那几条报成 `skipped`。
    const val SMS_DELETE = "/sms/delete"
    const val SMS_THREADS_DELETE = "/sms/threads/delete"
    // S67 未读角标. A Control that predates S67 answers 404 and the badges keep their last value.
    const val BADGES = "/badges"
    const val SMS_READ = "/sms/read"
    const val SMS_READ_BATCH = 500
    fun callSeen(callId: String) = "/calls/${encodePathSegment(callId)}/seen"
    fun pushRegistration(installationId: String) =
        "/push/registrations/${encodePathSegment(installationId)}"
    /** Passkey ids are base64url, which [encodePathSegment] passes through unchanged. */
    fun passkey(id: String) = "/passkeys/${encodePathSegment(id)}"
    fun sim(simId: String) = "/sims/${encodePathSegment(simId)}"
    fun simSettings(simId: String) = "/sims/${encodePathSegment(simId)}/settings"
    fun call(callId: String) = "/calls/${encodePathSegment(callId)}"
    fun claimCall(callId: String) = "/calls/${encodePathSegment(callId)}/claim"
    fun endCall(callId: String) = "/calls/${encodePathSegment(callId)}/end"
    /** S72 D3: 手机在系统通话中，同 iOS 上报 owner 忙线。 */
    fun ownerBusy(callId: String) = "/calls/${encodePathSegment(callId)}/owner-busy"
    /** S36 C2: 通话中拨号盘，一次一位。 */
    fun dtmf(callId: String) = "/calls/${encodePathSegment(callId)}/dtmf"
    fun mediaOptions(callId: String) = "/calls/${encodePathSegment(callId)}/media/options"
    fun mediaOffer(callId: String) = "/calls/${encodePathSegment(callId)}/media/offer"
    fun transcript(callId: String) = "/calls/${encodePathSegment(callId)}/transcript"
    fun recordings(callId: String, source: RecordingSource) =
        "/calls/${encodePathSegment(callId)}/recordings?source=${query(source.wireValue)}"
    fun recordingTrack(
        callId: String,
        track: RecordingAudioTrack,
        source: RecordingSource,
        attachment: Boolean = false,
        /** S36 C4: only `mp3` (server-side transcode) — playback keeps the原始 format, so it passes null. */
        format: String? = null,
    ): String {
        require(track != RecordingAudioTrack.CALLER_PLAYOUT || source == RecordingSource.PIXEL) {
            "derived playback is only available from Pixel archives"
        }
        require(format == null || format == "mp3") { "只支持 mp3 转码导出" }
        // S36 C4: `conversation` 是服务器混出来的虚拟轨，除 MP3 导出以外没有别的形态。
        require(track != RecordingAudioTrack.CONVERSATION || format == "mp3") { "对话混音只有 MP3" }
        val path = "/calls/${encodePathSegment(callId)}/recordings/${encodePathSegment(track.wireValue)}?source=${query(source.wireValue)}"
        return path + (if (attachment) "&disposition=attachment" else "") + (format?.let { "&format=$it" } ?: "")
    }
    fun recordingTrack(callId: String, track: OriginalTranscriptTrack, source: RecordingSource) =
        recordingTrack(callId, track.recordingAudioTrack(), source)
    /**
     * S22 决策 10: an explicit calendar-day window plus an optional server-side search. The service
     * still accepts the old `period=7d|1m|6m|1y` form and may answer with a `period` in the window
     * (which [ReportWindow] still decodes), but this build only ever sends `from`/`to`, so the preset
     * chips and the custom range go down exactly one path.
     */
    fun reports(range: ReportDateRange, timeZone: String, search: String = "", limit: Int = REPORTS_PAGE_LIMIT): String {
        val base = "$REPORT_CALLS?timeZone=${query(timeZone)}&from=${query(range.fromWire)}" +
            "&to=${query(range.toWire)}&limit=${limit.coerceIn(1, REPORTS_PAGE_LIMIT)}"
        return search.trim().takeIf(String::isNotEmpty)?.let { "$base&query=${query(it)}" } ?: base
    }

    /** `GET /calls` with the S22 server-side search; an empty search keeps the plain list route. */
    fun calls(search: String = "", limit: Int = CALLS_PAGE_LIMIT): String {
        val trimmed = search.trim()
        if (trimmed.isEmpty()) return CALLS
        return "$CALLS?query=${query(trimmed)}&limit=${limit.coerceIn(1, CALLS_PAGE_LIMIT)}"
    }
    /**
     * S28 分页版 `GET /calls`. `page` 是分页的开关，所以这条路由永远带 `page`；`limit` 和游标
     * (`before`/`beforeId`) 一律不送——服务端把 `page` 与游标的组合判成 400。`simId` 也走服务端：
     * 先切页再按 SIM 过滤会同时报错行和错总数。
     */
    fun callsPage(
        query: String = "",
        simId: String = "",
        page: Int = 1,
        pageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
    ): String = buildString {
        append(CALLS)
        append("?page=").append(page.coerceAtLeast(1))
        append("&pageSize=").append(RecordsPagingPolicy.clampPageSize(pageSize))
        // S38b: 被拦截的来电默认被服务端藏起来，记录页要连它们一起显示。
        append("&includeBlocked=true")
        simId.trim().takeIf(String::isNotEmpty)?.let { append("&simId=").append(query(it)) }
        query.trim().takeIf(String::isNotEmpty)?.let { append("&query=").append(query(it)) }
    }

    /** S28 分页版 `GET /reports/calls`：窗口与搜索不变，`limit` 换成 `page`/`pageSize`。 */
    fun reportsPage(
        range: ReportDateRange,
        timeZone: String,
        query: String = "",
        simId: String = "",
        page: Int = 1,
        pageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
    ): String = buildString {
        append(REPORT_CALLS)
        append("?timeZone=").append(query(timeZone))
        append("&from=").append(query(range.fromWire))
        append("&to=").append(query(range.toWire))
        append("&page=").append(page.coerceAtLeast(1))
        append("&pageSize=").append(RecordsPagingPolicy.clampPageSize(pageSize))
        simId.trim().takeIf(String::isNotEmpty)?.let { append("&simId=").append(query(it)) }
        query.trim().takeIf(String::isNotEmpty)?.let { append("&query=").append(query(it)) }
    }

    /** S28 分页版拦截记录；这条列表没有游标，`page` 直接接管 `limit`。 */
    fun interceptionsPage(page: Int = 1, pageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE): String =
        "/blocklist/interceptions?page=${page.coerceAtLeast(1)}&pageSize=${RecordsPagingPolicy.clampPageSize(pageSize)}"

    fun aiTranscript(callId: String) = "/calls/${encodePathSegment(callId)}/ai-transcript"
    fun contact(contactId: String) = "/contacts/${encodePathSegment(contactId)}"
    fun contact(contactId: String, expectedVersion: Long) =
        "/contacts/${encodePathSegment(contactId)}?expectedVersion=$expectedVersion"
    fun contactPhones(contactId: String) = "/contacts/${encodePathSegment(contactId)}/phones"
    fun contacts(search: String = "", limit: Int = CONTACTS_PAGE_LIMIT, offset: Int = 0): String {
        val bounded = limit.coerceIn(1, CONTACTS_PAGE_LIMIT)
        val start = offset.coerceAtLeast(0)
        val base = "$CONTACTS?limit=$bounded&offset=$start"
        return search.trim().takeIf(String::isNotEmpty)?.let { "$base&query=${query(it)}" } ?: base
    }
    fun contactLookup(number: String) = "$CONTACTS/lookup?number=${query(number)}"
    fun blocklistEntry(entryId: String) = "/blocklist/${encodePathSegment(entryId)}"

    /** S66: two lists — `call` (incoming calls hung up) and `sms` (texts kept out of the inbox). */
    const val BLOCK_SCOPE_CALL = "call"
    const val BLOCK_SCOPE_SMS = "sms"

    fun blocklist(scope: String) = "$BLOCKLIST?scope=${requireBlockScope(scope)}"

    fun requireBlockScope(scope: String): String =
        scope.also { require(it == BLOCK_SCOPE_CALL || it == BLOCK_SCOPE_SMS) { "unknown blocklist scope: $it" } }
    fun interceptions(limit: Int = INTERCEPTIONS_LIMIT) =
        "/blocklist/interceptions?limit=${limit.coerceIn(1, INTERCEPTIONS_LIMIT)}"
    fun gatewayPower(gatewayId: String) = "/gateways/${encodePathSegment(gatewayId)}/power"

    /** The server caps `GET /contacts` at 200 per page (§A); paging is the client's job. */
    const val CONTACTS_PAGE_LIMIT = 200
    const val INTERCEPTIONS_LIMIT = 100

    /** `POST /sms/delete` 的服务端上限（S30 §1.2 的 1–500）；更长的选择由客户端切批。 */
    const val SMS_DELETE_BATCH = 500
    /** Server caps: `/calls` at 100, `/reports/calls` at 200 (S22 接口合同). */
    const val CALLS_PAGE_LIMIT = 100
    const val REPORTS_PAGE_LIMIT = 200

    internal fun encodePathSegment(value: String): String = buildString {
        value.toByteArray(Charsets.UTF_8).forEach { byte ->
            val n = byte.toInt() and 0xff
            val safe = n in 'a'.code..'z'.code || n in 'A'.code..'Z'.code ||
                n in '0'.code..'9'.code || n == '-'.code || n == '_'.code || n == '.'.code
            if (safe) append(n.toChar()) else append("%%%02X".format(n))
        }
    }

    private fun query(value: String) = URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

internal data class ClientRequest(
    val method: String,
    val path: String,
    val body: JSONObject?,
    val idempotencyKey: String?,
    val bearerToken: String?,
    /** S36 C3: `X-Diag-Source`。除诊断上报外没有别的请求用得上。 */
    val headers: Map<String, String> = emptyMap(),
    /** S36 C3: 诊断事件是 JSON 数组，不是 [body] 那种对象；两者互斥，[rawBody] 优先。 */
    val rawBody: String? = null,
)

internal fun interface ClientTransport {
    fun execute(request: ClientRequest): JSONObject

    suspend fun executeCancellable(request: ClientRequest): JSONObject =
        runInterruptible(Dispatchers.IO) { execute(request) }
}

/**
 * 哪些方法必须绕开 `java.net.HttpURLConnection`：
 * - `PATCH` —— `HttpURLConnection.setRequestMethod` 的白名单里根本没有它（S18）。
 * - `DELETE` —— Android 的实现即便在 `doOutput=false` 时也会给 DELETE 补上
 *   `Content-Type: application/x-www-form-urlencoded` / `Transfer-Encoding: chunked`，Fastify 因此
 *   对空体回 415 `FST_ERR_CTP_INVALID_MEDIA_TYPE`（S30 在 Pixel 上抓到，历史上每一条 DELETE 都是
 *   这个下场）。
 */
internal fun methodNeedsOkHttp(method: String): Boolean = method == "PATCH" || method == "DELETE"

/** OkHttp 只在这三个方法上强制要求 body；GET/DELETE 一律裸发。 */
private val METHODS_REQUIRING_BODY = setOf("POST", "PUT", "PATCH")

/**
 * 把一条 [ClientRequest] 翻译成 OkHttp 的请求。抽成纯函数就是为了能单测「DELETE 不带 body、不带
 * `Content-Type`」这一条 —— 用 `Request.Builder.delete()` 会被 OkHttp 塞一个空 body 回来，所以这里
 * 必须是 `method(method, null)`。头部与超时之外的一切都与 HttpURLConnection 那条路一字不差。
 */
internal fun okHttpClientRequest(baseUrl: String, request: ClientRequest): okhttp3.Request {
    val builder = okhttp3.Request.Builder()
        .url(baseUrl + request.path)
        .header("Accept", "application/json")
    request.bearerToken?.let { builder.header("Authorization", "Bearer $it") }
    request.idempotencyKey?.let { builder.header("Idempotency-Key", it) }
    request.headers.forEach { (name, value) -> builder.header(name, value) }
    val body = when {
        request.rawBody != null -> request.rawBody.toRequestBody(JSON_MEDIA_TYPE)
        request.body != null -> request.body.toString().toRequestBody(JSON_MEDIA_TYPE)
        request.method in METHODS_REQUIRING_BODY -> JSONObject().toString().toRequestBody(JSON_MEDIA_TYPE)
        else -> null
    }
    return builder.method(request.method, body).build()
}

internal class UrlConnectionClientTransport(
    private val connectionFactory: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val startWorker: (Thread) -> Unit = { it.start() },
    /** null = 按请求读 [ClientEndpoint.baseUrl]（蜂窝走中转）；测试传固定地址。 */
    private val baseUrl: String? = null,
) : ClientTransport {
    /**
     * `java.net.HttpURLConnection` validates the method against a hard-coded allow-list that has no
     * PATCH, so `PATCH /passkeys/{id}` goes out over OkHttp with the same headers, timeouts, body
     * and error parsing. It still returns through [ClientApi.request], so the 401 refresh/retry
     * wrapper covers it exactly like every other call.
     *
     * S30 生产事故：DELETE 也走这里。Android 的 `HttpURLConnection` 在 DELETE 上会自己补一个
     * `Content-Type: application/x-www-form-urlencoded`（或 `Transfer-Encoding: chunked`），哪怕
     * `request.body` 是 null；Control 的 Fastify 看到带 content-type 的空体就回 415
     * `FST_ERR_CTP_INVALID_MEDIA_TYPE`。也就是说这个客户端历史上**从来没有**成功发出过一条 DELETE
     * （联系人、黑名单、Passkey、推送注册全都中招，S30 的删除通话只是第一次被人看见）。OkHttp 的
     * `method("DELETE", null)` 一个 body 头都不写，正是服务端认的那种裸 DELETE。
     */
    private val okHttp: okhttp3.OkHttpClient by lazy {
        okhttp3.OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_MS.toLong(), java.util.concurrent.TimeUnit.MILLISECONDS)
            .readTimeout(READ_TIMEOUT_MS.toLong(), java.util.concurrent.TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }

    override fun execute(request: ClientRequest): JSONObject = withAlternate(request, { true }) { base ->
        if (methodNeedsOkHttp(request.method)) executeOverOkHttp(request, base) else execute(request, base, opened = { })
    }

    /**
     * S72b（同网关 S71）：网络层失败（IOException，不含 HTTP 状态码）时，幂等请求换另一个 Control 基址再试一次。
     * [stillWanted] 为 false（调用方已取消，连接是被我们自己断的）时不重试。
     */
    private inline fun withAlternate(request: ClientRequest, stillWanted: () -> Boolean, attempt: (String) -> JSONObject): JSONObject {
        val base = baseUrl ?: ClientEndpoint.baseUrl()
        try {
            return attempt(base)
        } catch (failure: java.io.IOException) {
            val alternate = ClientEndpoint.alternateUrl(base)
            if (alternate == null || !request.retriesOnAlternate() || !stillWanted()) throw failure
            runCatching {
                ClientDiag.log("api.alternate_retry", mapOf(
                    "relay" to (alternate == BuildConfig.RELAY_API_BASE_URL), "method" to request.method,
                    "errorType" to failure.javaClass.simpleName,
                ))
            }
            return attempt(alternate)
        }
    }

    private fun executeOverOkHttp(request: ClientRequest, base: String): JSONObject {
        okHttp.newCall(okHttpClientRequest(base, request)).execute().use { response ->
            val text = response.body?.byteStream()?.use { it.readBoundedText(MAX_API_RESPONSE_BYTES) }.orEmpty()
            if (response.code !in 200..299) {
                val error = runCatching { JSONObject(text).getJSONObject("error") }.getOrNull()
                throw ApiError(
                    response.code,
                    error?.optString("code").orEmpty().ifBlank { "HTTP_${response.code}" },
                    error?.optString("message").orEmpty().ifBlank { "请求暂时失败，请稍后重试" },
                    error?.optJSONObject("details"),
                )
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    override suspend fun executeCancellable(request: ClientRequest): JSONObject =
        // PATCH / DELETE 不能走 HttpURLConnection（见上），可取消的那条路也一样 —— 否则一条
        // `requestCancellable("DELETE", …)` 会绕过修复、重新撞上 415。
        if (methodNeedsOkHttp(request.method)) {
            val job = kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]
            runInterruptible(Dispatchers.IO) {
                withAlternate(request, { job?.isActive != false }) { base -> executeOverOkHttp(request, base) }
            }
        } else suspendCancellableCoroutine { continuation ->
            val active = AtomicReference<HttpURLConnection?>()
            val worker = Thread({
                try {
                    if (!continuation.isActive) return@Thread
                    val response = withAlternate(request, { continuation.isActive }) { base ->
                        execute(request, base, { connection ->
                            active.set(connection)
                            if (!continuation.isActive) {
                                connection.disconnect()
                                throw kotlinx.coroutines.CancellationException("HTTP request cancelled before start")
                            }
                        }, remainsActive = { continuation.isActive })
                    }
                    if (continuation.isActive) continuation.resume(response)
                } catch (error: Throwable) {
                    if (continuation.isActive) continuation.resumeWithException(error)
                } finally {
                    active.set(null)
                }
            }, "vodog-cancellable-http").apply { isDaemon = true }
            continuation.invokeOnCancellation {
                active.getAndSet(null)?.disconnect()
                worker.interrupt()
            }
            if (continuation.isActive) startWorker(worker)
        }

    private fun execute(
        request: ClientRequest,
        baseUrl: String,
        opened: (HttpURLConnection) -> Unit,
        remainsActive: () -> Boolean = { true },
    ): JSONObject {
        val connection = connectionFactory(URL(baseUrl + request.path))
        opened(connection)
        try {
            if (!remainsActive()) throw kotlinx.coroutines.CancellationException("HTTP request cancelled before I/O")
            connection.instanceFollowRedirects = false
            connection.requestMethod = request.method
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.setRequestProperty("Accept", "application/json")
            request.bearerToken?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            request.idempotencyKey?.let { connection.setRequestProperty("Idempotency-Key", it) }
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            val payload = request.rawBody ?: request.body?.toString()
            if (payload != null) {
                if (!remainsActive()) throw kotlinx.coroutines.CancellationException("HTTP request cancelled before body")
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(payload.toByteArray()) }
            }
            if (!remainsActive()) throw kotlinx.coroutines.CancellationException("HTTP request cancelled before connect")
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { it.readBoundedText(MAX_API_RESPONSE_BYTES) }.orEmpty()
            if (status !in 200..299) {
                val error = runCatching { JSONObject(text).getJSONObject("error") }.getOrNull()
                throw ApiError(
                    status,
                    error?.optString("code").orEmpty().ifBlank { "HTTP_$status" },
                    error?.optString("message").orEmpty().ifBlank { "请求暂时失败，请稍后重试" },
                    error?.optJSONObject("details"),
                )
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }
}

private fun java.io.InputStream.readBoundedText(limit: Int): String {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8 * 1024)
    while (output.size() <= limit) {
        val count = read(buffer, 0, minOf(buffer.size, limit + 1 - output.size()))
        if (count < 0) break
        output.write(buffer, 0, count)
    }
    require(output.size() <= limit) { "服务器返回内容过大" }
    return output.toString(Charsets.UTF_8.name())
}

private const val MAX_API_RESPONSE_BYTES = 1024 * 1024
private val JSON_MEDIA_TYPE = "application/json".toMediaType()
private const val CONNECT_TIMEOUT_MS = 10_000
private const val READ_TIMEOUT_MS = 15_000

class ClientApi internal constructor(
    private val sessions: SessionCoordinator? = null,
    private val transport: ClientTransport = UrlConnectionClientTransport(),
) : MediaProbeControl, RelayProbeControl {
    internal fun refreshLongLivedRequestAfterUnauthorized(requestSession: SessionSnapshot): SessionSnapshot {
        val coordinator = checkNotNull(sessions) { "需要登录后刷新会话" }
        val current = coordinator.resolveSameLogin(requestSession)
        if (current.session != requestSession.session) return current
        return coordinator.refresh(current) { old -> refreshSession(old) }
    }

    /** Public pre-login configuration; native clients only show the Turnstile widget when the server requires it. */
    fun authConfig(): TurnstileConfig {
        val turnstile = request("GET", ClientApiRoutes.AUTH_CONFIG).getJSONObject("turnstile")
        val siteKey = if (turnstile.isNull("siteKey")) null else turnstile.optString("siteKey").takeIf { it.isNotBlank() }
        return TurnstileConfig(turnstile.optBoolean("enabled"), siteKey)
    }

    fun login(username: String, password: String, turnstileToken: String? = null): Session {
        val response = request("POST", ClientApiRoutes.LOGIN, JSONObject()
            .put("username", username).put("password", password)
            .put("platform", "android").put("deviceName", android.os.Build.MODEL)
            .apply { turnstileToken?.let { put("turnstileToken", it) } })
        val user = response.getJSONObject("user")
        return Session(
            token = response.getString("token"),
            refreshToken = response.getString("refreshToken"),
            username = user.getString("username"),
            role = user.optString("role"),
        )
    }

    fun me(): JSONObject = request("GET", ClientApiRoutes.ME)
    internal fun meProfile(requiredSession: SessionSnapshot): ClientProfile {
        val user = request(
            "GET",
            ClientApiRoutes.ME,
            requiredSession = requiredSession,
            resolveRefreshedLogin = true,
        ).getJSONObject("user")
        val username = user.getString("username").also { require(it.isNotBlank()) }
        val role = user.getString("role").also { require(it in setOf("user", "admin")) }
        return ClientProfile(username, role)
    }
    fun logout(): JSONObject = request("POST", ClientApiRoutes.LOGOUT)
    internal fun revoke(session: Session): JSONObject = transport.execute(
        ClientRequest("POST", ClientApiRoutes.LOGOUT, null, null, session.token),
    )
    /**
     * S36 C3: 诊断上报故意绕开 [request] —— 体是 JSON 数组，且它失败时绝不能触发会话刷新，更不能
     * 走 `api.error` 那条日志（会自己喂自己）。失败直接抛，由 [ClientDiag] 重试一次后丢掉。
     */
    internal fun postDiagEvents(events: JSONArray, installId: String? = null): JSONObject = transport.execute(
        ClientRequest(
            "POST",
            ClientApiRoutes.DIAG_EVENTS,
            null,
            null,
            sessions?.snapshot()?.session?.token,
            // S36b D1：`X-Diag-Install` 让同一台机器跨会话、跨重装前后的事件能串起来。
            headers = mapOf("X-Diag-Source" to "android") +
                (installId?.take(64)?.let { mapOf("X-Diag-Install" to it) } ?: emptyMap()) +
                // S75: device clock at this send (retries included), for Control's clock_offset_ms.
                ("X-Diag-Sent-At" to System.currentTimeMillis().toString()),
            rawBody = events.toString(),
        ),
    )

    fun sims(): List<JSONObject> = collection(ClientApiRoutes.SIMS)
    fun calls(): List<JSONObject> = collection(ClientApiRoutes.CALLS)

    /**
     * S22 的不分页搜索。S28 之后「记录 → 全部通话」走 [callsPage]，这条留作不带 `page` 的老读法
     * （服务端的合同明确说不带 `page` 时整条路由不变），也是分页出问题时的回退路径。
     */
    fun searchCalls(search: String): List<JSONObject> = collection(ClientApiRoutes.calls(search))

    /**
     * S28 记录页分页。这三个读法只有「记录」页会用，拨号页仍旧走 [calls]，所以轮询列表和运行时对账
     * （[ClientViewModel] 的 `applyLoadedCalls`）完全不受分页影响。
     */
    fun callsPage(
        query: String = "",
        simId: String = "",
        page: Int = 1,
        pageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
    ): Page<JSONObject> = collectionPage(ClientApiRoutes.callsPage(query, simId, page, pageSize), pageSize)

    fun reportsPage(
        range: ReportDateRange,
        timeZone: String,
        query: String = "",
        simId: String = "",
        page: Int = 1,
        pageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
    ): CallReportPage = parseCallReport(
        request("GET", ClientApiRoutes.reportsPage(range, timeZone, query, simId, page, pageSize)),
        RecordsPagingPolicy.clampPageSize(pageSize),
    ).also { require(it.window.timeZone == timeZone) { "report window mismatch" } }

    fun interceptionsPage(
        page: Int = 1,
        pageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
    ): Page<JSONObject> = collectionPage(ClientApiRoutes.interceptionsPage(page, pageSize), pageSize)
    fun sms(): List<JSONObject> = collection(ClientApiRoutes.SMS)
    /**
     * S22 报告 Tab. Only the time zone is asserted: an explicit `from`/`to` window comes back without
     * a `period`, and the server is free to clamp the range it actually served.
     */
    fun reports(range: ReportDateRange, timeZone: String, search: String = ""): CallReportPage =
        parseCallReport(request("GET", ClientApiRoutes.reports(range, timeZone, search))).also {
            require(it.window.timeZone == timeZone) { "report window mismatch" }
        }
    fun call(callId: String, requiredSession: SessionSnapshot? = null): JSONObject =
        request("GET", ClientApiRoutes.call(callId), requiredSession = requiredSession, resolveRefreshedLogin = true).getJSONObject("call").also {
        require(it.getString("id").equals(callId, ignoreCase = true)) { "call detail identity mismatch" }
    }
    fun transcript(callId: String): CallTranscript? =
        parseCallTranscript(request("GET", ClientApiRoutes.transcript(callId))).also {
            require(it == null || it.callId.equals(callId, ignoreCase = true)) { "transcript identity mismatch" }
        }
    fun recording(callId: String, source: RecordingSource): RecordingManifest? =
        parseRecordingManifest(request("GET", ClientApiRoutes.recordings(callId, source)), callId, source)

    // ---- S30 §1 删除 -----------------------------------------------------------------------

    /**
     * 204 No Content on success — the body is empty, exactly like [deleteContact] and [unblock], so
     * nothing is read off the response. 404 是「不存在或不是本人的」，409 `CALL_IN_USE` 是「还在进行
     * 或还在处理」，两者都以 [ApiError] 抛出，由 UI 映射成中文。
     */
    fun deleteCall(callId: String) {
        request("DELETE", ClientApiRoutes.call(callId))
    }

    /**
     * `POST /sms/delete {ids}` → 200 `{deleted, skipped:[{id, reason}]}`。服务端一次最多收
     * [ClientApiRoutes.SMS_DELETE_BATCH] 个 id，所以「全选」一段很长的对话时这里切批发送，返回值
     * 是各批的合并结果，调用方看到的仍旧是一份 `{deleted, skipped}`。
     */
    fun deleteSms(ids: List<String>): JSONObject {
        val wanted = ids.map(String::trim).filter(String::isNotEmpty).distinct()
        require(wanted.isNotEmpty()) { "请先选择要删除的短信" }
        var deleted = 0
        val skipped = JSONArray()
        wanted.chunked(ClientApiRoutes.SMS_DELETE_BATCH).forEach { batch ->
            val response = request(
                "POST",
                ClientApiRoutes.SMS_DELETE,
                JSONObject().put("ids", JSONArray(batch)),
            )
            deleted += response.optInt("deleted")
            response.optJSONArray("skipped")?.let { array ->
                for (index in 0 until array.length()) skipped.put(array.get(index))
            }
        }
        return JSONObject().put("deleted", deleted).put("skipped", skipped)
    }

    /**
     * `POST /sms/threads/delete {simId, conversationAddress}` → 200 `{deleted, skipped}`。线程键由
     * 服务端两边归一化（S30 §1.3），所以客户端照发自己手上的写法即可（`13800000000` 与
     * `+8613800000000` 落在同一段对话）。
     */
    fun deleteSmsThread(simId: String, conversationAddress: String): JSONObject {
        require(simId.isNotBlank()) { "缺少 SIM" }
        require(conversationAddress.isNotBlank()) { "缺少对话号码" }
        return request(
            "POST",
            ClientApiRoutes.SMS_THREADS_DELETE,
            JSONObject().put("simId", simId).put("conversationAddress", conversationAddress),
        )
    }

    /** S67 `GET /badges`. */
    fun badges(): ClientBadges = parseBadges(request("GET", ClientApiRoutes.BADGES))

    /** S67 `POST /calls/:id/seen` → 204, idempotent. */
    fun markCallSeen(callId: String) {
        request("POST", ClientApiRoutes.callSeen(callId), JSONObject()) // an empty POST goes out as form-urlencoded → 415
    }

    /** S67 `POST /sms/read {ids}` (1–500 per request) → `{updated}`. */
    fun markSmsRead(ids: List<String>) {
        ids.distinct().chunked(ClientApiRoutes.SMS_READ_BATCH).forEach { batch ->
            request("POST", ClientApiRoutes.SMS_READ, JSONObject().put("ids", JSONArray(batch)))
        }
    }

    // ---- S21 §A 通讯录 --------------------------------------------------------------------

    fun contacts(search: String = "", limit: Int = ClientApiRoutes.CONTACTS_PAGE_LIMIT, offset: Int = 0):
        List<JSONObject> = collection(ClientApiRoutes.contacts(search, limit, offset))

    /** `{item: ContactDto|null}`; a blank/unknown number is a `null` item, not an error. */
    fun lookupContact(number: String): JSONObject? {
        val response = request("GET", ClientApiRoutes.contactLookup(number))
        return if (!response.has("item") || response.isNull("item")) null else response.optJSONObject("item")
    }

    fun contact(contactId: String): JSONObject =
        request("GET", ClientApiRoutes.contact(contactId)).getJSONObject("item")

    fun createContact(draft: ContactDraft, idempotencyKey: String? = null): JSONObject =
        request("POST", ClientApiRoutes.CONTACTS, draft.toJson(), idempotencyKey).getJSONObject("item")

    fun updateContact(contactId: String, draft: ContactDraft, expectedVersion: Long): JSONObject =
        request(
            "PUT",
            ClientApiRoutes.contact(contactId),
            draft.toJson().put("expectedVersion", expectedVersion),
        ).getJSONObject("item")

    /** 204 No Content on success (soft delete). */
    fun deleteContact(contactId: String, expectedVersion: Long) {
        request("DELETE", ClientApiRoutes.contact(contactId, expectedVersion))
    }

    /** "添加到现有联系人"; an already-present number answers 200 with the same contact. */
    fun addContactPhone(contactId: String, rawNumber: String, label: String? = null): JSONObject = request(
        "POST",
        ClientApiRoutes.contactPhones(contactId),
        JSONObject().put("rawNumber", rawNumber)
            .apply { label?.takeIf(String::isNotBlank)?.let { put("label", it) } },
    ).getJSONObject("item")

    /** One batch of at most [CONTACT_IMPORT_BATCH] entries; the caller loops over [contactImportBatches]. */
    fun importContacts(payload: JSONObject): ContactImportResult =
        parseContactImportResult(request("POST", ClientApiRoutes.CONTACTS_IMPORT, payload))

    // ---- S21 §B 黑名单与拦截记录 ----------------------------------------------------------

    fun blocklist(scope: String): List<JSONObject> = collection(ClientApiRoutes.blocklist(scope))

    /** S66: [scope] is always explicit — `call` from calls/reports/contacts, `sms` from 删除并屏蔽. */
    fun block(remoteNumber: String, sourceCallId: String?, scope: String): JSONObject = request(
        "POST",
        ClientApiRoutes.BLOCKLIST,
        JSONObject().put("remoteNumber", remoteNumber)
            .put("scope", ClientApiRoutes.requireBlockScope(scope))
            .apply { sourceCallId?.takeIf(String::isNotBlank)?.let { put("sourceCallId", it) } },
    ).getJSONObject("item")

    /** 204 No Content on success. */
    fun unblock(blockedEntryId: String) {
        request("DELETE", ClientApiRoutes.blocklistEntry(blockedEntryId))
    }

    fun interceptions(limit: Int = ClientApiRoutes.INTERCEPTIONS_LIMIT): List<JSONObject> =
        collection(ClientApiRoutes.interceptions(limit))

    // ---- S21 §D 远程开关 / §E AI 转写 ------------------------------------------------------

    fun gatewayPowers(): List<JSONObject> = collection(ClientApiRoutes.GATEWAYS_POWER)

    /** 202 `{item}`; 409 carries the code the UI maps in [gatewayPowerErrorMessage]. */
    fun setGatewayPower(gatewayId: String, desired: String): JSONObject {
        require(desired == "on" || desired == "off") { "desired 必须是 on 或 off" }
        return request(
            "POST",
            ClientApiRoutes.gatewayPower(gatewayId),
            JSONObject().put("desired", desired),
        ).getJSONObject("item")
    }

    fun aiTranscript(callId: String): List<JSONObject> = collection(ClientApiRoutes.aiTranscript(callId))

    // ---- S24 决策 3 AI 语音服务 ---------------------------------------------------------------

    fun voiceProviders(): ClientVoiceProviderList =
        request("GET", ClientApiRoutes.AI_VOICE_PROVIDERS).toClientVoiceProviderList()

    /** 成功返回与 GET 相同的结构；409 `PROVIDER_UNAVAILABLE` 由 UI 映射成中文。 */
    fun setVoiceProvider(provider: String, expectedVersion: Long): ClientVoiceProviderList {
        require(provider.isNotBlank()) { "provider 不能为空" }
        return request(
            "PUT",
            ClientApiRoutes.AI_VOICE_PROVIDER,
            JSONObject().put("provider", provider).put("expectedVersion", expectedVersion),
        ).toClientVoiceProviderList()
    }

    fun passkeys(): List<PasskeyItem> {
        val array = request("GET", ClientApiRoutes.PASSKEYS).getJSONArray("items")
        return List(array.length()) { index -> parsePasskeyItem(array.getJSONObject(index)) }
    }

    /** The accepted item is authoritative; a later list read only reconciles the surrounding rows. */
    fun renamePasskey(id: String, label: String): PasskeyItem = parsePasskeyItem(
        request("PATCH", ClientApiRoutes.passkey(id), JSONObject().put("label", label)).getJSONObject("item"),
    )

    /** 204 No Content on success. */
    fun deletePasskey(id: String) {
        request("DELETE", ClientApiRoutes.passkey(id))
    }

    fun passkeyRegistrationOptions(): PasskeyChallenge {
        val response = request("POST", ClientApiRoutes.PASSKEY_REGISTER_OPTIONS, JSONObject())
        return PasskeyChallenge(
            challengeId = response.getString("challengeId"),
            requestJson = response.getJSONObject("options").toString(),
        )
    }

    fun verifyPasskeyRegistration(challengeId: String, responseJson: String): Boolean =
        request(
            "POST",
            ClientApiRoutes.PASSKEY_REGISTER_VERIFY,
            JSONObject().put("challengeId", challengeId).put("response", JSONObject(responseJson)),
        ).getBoolean("verified")

    fun passkeyAuthenticationOptions(username: String, turnstileToken: String? = null): PasskeyChallenge {
        val response = request(
            "POST",
            ClientApiRoutes.PASSKEY_AUTH_OPTIONS,
            JSONObject().put("username", username.trim())
                .apply { turnstileToken?.let { put("turnstileToken", it) } },
        )
        return PasskeyChallenge(
            challengeId = response.getString("challengeId"),
            requestJson = response.getJSONObject("options").toString(),
        )
    }

    fun verifyPasskeyAuthentication(challengeId: String, responseJson: String): Session {
        val response = request(
            "POST",
            ClientApiRoutes.PASSKEY_AUTH_VERIFY,
            JSONObject()
                .put("challengeId", challengeId)
                .put("response", JSONObject(responseJson))
                .put("platform", "android"),
        )
        val user = response.getJSONObject("user")
        return Session(
            token = response.getString("token"),
            refreshToken = response.getString("refreshToken"),
            username = user.getString("username"),
            role = user.optString("role"),
        )
    }

    fun startCall(simId: String, remoteNumber: String, idempotencyKey: String): JSONObject = request(
        "POST", ClientApiRoutes.OUTBOUND_CALL,
        JSONObject().put("simId", simId).put("remoteNumber", remoteNumber),
        idempotencyKey,
    )

    fun claimCall(callId: String, requiredSession: SessionSnapshot? = null): JSONObject = request(
        "POST",
        ClientApiRoutes.claimCall(callId),
        JSONObject().put("platform", "android").put("deviceName", android.os.Build.MODEL),
        requiredSession = requiredSession,
        resolveRefreshedLogin = true,
    )

    /** Body is `{}`, never empty: an empty POST 415s on Control. */
    fun ownerBusy(callId: String, requiredSession: SessionSnapshot? = null): JSONObject = request(
        "POST", ClientApiRoutes.ownerBusy(callId), JSONObject(), requiredSession = requiredSession,
    )

    fun endCall(
        callId: String,
        onlyIfCurrentSessionOwner: Boolean = false,
        onlyIfRinging: Boolean = false,
        requiredSession: SessionSnapshot? = null,
    ): JSONObject = request(
        "POST",
        ClientApiRoutes.endCall(callId),
        JSONObject().apply {
            if (onlyIfCurrentSessionOwner) put("onlyIfCurrentSessionOwner", true)
            if (onlyIfRinging) put("onlyIfRinging", true)
        },
        requiredSession = requiredSession,
        resolveRefreshedLogin = true,
    )

    /** S36 C2: fire-and-forget in-call DTMF; the server turns it into one gateway command. */
    fun sendDtmf(callId: String, digits: String, requiredSession: SessionSnapshot? = null): JSONObject = request(
        "POST",
        ClientApiRoutes.dtmf(callId),
        JSONObject().put("digits", digits),
        requiredSession = requiredSession,
        resolveRefreshedLogin = true,
    )

    fun registerAndroidPush(installationId: String, fcmToken: String, badge: BadgePrefs? = null): JSONObject = request(
        "PUT", ClientApiRoutes.pushRegistration(installationId), JSONObject()
            .put("platform", "android")
            .put("packageName", "org.vodog")
            .put("deviceName", android.os.Build.MODEL?.takeIf(String::isNotBlank) ?: "Android")
            .put("fcmToken", fcmToken)
            .apply {
                // S67: master switch off = both false.
                if (badge != null) put("badge", JSONObject().put("calls", badge.pushCalls).put("sms", badge.pushSms))
            },
    )

    fun deletePushRegistration(installationId: String): JSONObject =
        request("DELETE", ClientApiRoutes.pushRegistration(installationId))

    internal fun deletePushRegistration(session: Session, installationId: String): JSONObject =
        transport.execute(
            ClientRequest(
                "DELETE",
                ClientApiRoutes.pushRegistration(installationId),
                null,
                null,
                session.token,
            ),
        )

    override fun probeOptions(networkGeneration: String): MediaProbeOptions = parseMediaProbeOptions(
        request(
            "POST",
            ClientApiRoutes.MEDIA_PROBE_OPTIONS,
            JSONObject().put("networkGeneration", networkGeneration),
        ),
    )

    override fun submitProbeResults(networkGeneration: String, samples: List<MediaProbeSample>): String =
        request(
            "POST",
            ClientApiRoutes.MEDIA_PROBE_RESULTS,
            JSONObject().put("networkGeneration", networkGeneration).put("samples", samplesJson(samples)),
        ).getString("expiresAt")

    override suspend fun relayProbeOptions(networkGeneration: String): RelayProbeOptions = parseRelayProbeOptions(
        requestCancellable(
            "POST",
            ClientApiRoutes.MEDIA_QUALITY_PROBE_OPTIONS,
            JSONObject().put("networkGeneration", networkGeneration),
        ),
    )

    override suspend fun submitRelayProbeResults(networkGeneration: String, samples: List<RelayProbeSample>): String =
        requestCancellable(
            "POST",
            ClientApiRoutes.MEDIA_QUALITY_PROBE_RESULTS,
            JSONObject().put("networkGeneration", networkGeneration).put("samples", relaySamplesJson(samples)),
        ).getString("expiresAt")

    fun mediaOptions(callId: String, transport: CallMediaTransport, networkGeneration: String): CallMediaOptions {
        val response = request(
            "POST",
            ClientApiRoutes.mediaOptions(callId),
            // S72b: 中转模式告诉 Control 返回 relay-node TURN（IP + hostname）；旧 Control 的 z.object 会丢弃未知键。
            JSONObject().put("transport", transport.wireValue).put("networkGeneration", networkGeneration)
                .put("relay", ClientEndpoint.relay),
        )
        return CallMediaOptions.parse(response, transport)
    }

    fun mediaOffer(callId: String, sdp: String): CallMediaDescription {
        val response = request(
            "POST",
            ClientApiRoutes.mediaOffer(callId),
            JSONObject().put("type", "offer").put("sdp", sdp),
        )
        return CallMediaDescription(
            type = response.getString("type"),
            sdp = response.getString("sdp"),
        ).also {
            require(it.type == "answer" && it.sdp.isNotBlank()) { "服务器返回的音频协商信息无效" }
        }
    }

    fun sendSms(simId: String, remoteNumber: String, body: String, idempotencyKey: String): JSONObject = request(
        "POST", ClientApiRoutes.OUTBOUND_SMS,
        JSONObject().put("simId", simId).put("remoteNumber", remoteNumber).put("body", body),
        idempotencyKey,
    )

    fun sendSmsBatch(simId: String, recipients: List<String>, body: String, idempotencyKey: String): JSONObject = request(
        "POST", "/sms/batch",
        JSONObject().put("simId", simId).put("recipients", JSONArray(recipients)).put("body", body),
        idempotencyKey,
    )

    fun setMode(simId: String, mode: String, timeoutSeconds: Int, expectedVersion: Long): JSONObject = request(
        "PUT", ClientApiRoutes.simSettings(simId),
        JSONObject().put("mode", mode).put("timeoutSeconds", timeoutSeconds).put("expectedVersion", expectedVersion),
    )

    fun setSimNotes(
        simId: String,
        expectedVersion: Long,
        label: String,
        phoneLabel: String?,
    ): JSONObject = request(
        "PUT",
        ClientApiRoutes.sim(simId),
        JSONObject()
            .put("expectedVersion", expectedVersion)
            .put("label", label)
            .put("phoneLabel", phoneLabel?.takeIf(String::isNotBlank) ?: JSONObject.NULL),
    )

    private fun collection(path: String): List<JSONObject> {
        val array = request("GET", path).getJSONArray("items")
        return buildList { for (index in 0 until array.length()) add(array.getJSONObject(index)) }
    }

    /** [collection] 的分页版：同样的 `{items}`，外面多一层 S28 信封（旧 Control 缺信封，见 [readPageEnvelope]）。 */
    private fun collectionPage(path: String, pageSize: Int): Page<JSONObject> {
        val response = request("GET", path)
        val array = response.getJSONArray("items")
        val items = buildList { for (index in 0 until array.length()) add(array.getJSONObject(index)) }
        return readPageEnvelope(response, items, RecordsPagingPolicy.clampPageSize(pageSize))
    }

    private fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        idempotencyKey: String? = null,
        requiredSession: SessionSnapshot? = null,
        resolveRefreshedLogin: Boolean = false,
    ): JSONObject {
        val coordinator = sessions
        val initial = if (requiredSession != null) checkNotNull(coordinator) {
            "required session needs a session coordinator"
        }.let { if (resolveRefreshedLogin) it.resolveSameLogin(requiredSession) else it.requireCurrent(requiredSession) }
        else coordinator?.snapshot()
        val started = System.nanoTime()
        return try { try {
            execute(method, path, body, idempotencyKey, initial?.session?.token)
        } catch (error: ApiError) {
            if (error.status != 401 || initial?.session == null || path == ClientApiRoutes.REFRESH) {
                error.logToDiag(path)
                throw error
            }
        val refreshed = checkNotNull(coordinator).refresh(initial) { old -> refreshSession(old) }
        try {
            coordinator.requireCurrent(refreshed)
            execute(method, path, body, idempotencyKey, refreshed.session?.token)
        } catch (retryError: ApiError) {
            if (retryError.status == 401) coordinator.invalidate(refreshed)
            retryError.logToDiag(path)
            throw retryError
        }
        }
        } catch (error: Throwable) {
            logNetworkFailure(path, error, started)
            throw error
        }
    }

    /** S69：网络层失败进诊断（ApiError 已在上面记过；取消与非 IO 异常由 [networkErrorType] 过滤）。 */
    private fun logNetworkFailure(path: String, error: Throwable, startedNanos: Long) {
        if (error is ApiError || path == ClientApiRoutes.DIAG_EVENTS) return
        ClientDiag.logNetworkError(path, error, (System.nanoTime() - startedNanos) / 1_000_000)
    }

    private suspend fun requestCancellable(
        method: String,
        path: String,
        body: JSONObject? = null,
        idempotencyKey: String? = null,
    ): JSONObject {
        val coordinator = sessions
        val initial = coordinator?.snapshot()
        val started = System.nanoTime()
        return try { try {
            executeCancellable(method, path, body, idempotencyKey, initial?.session?.token)
        } catch (error: ApiError) {
            if (error.status != 401 || initial?.session == null || path == ClientApiRoutes.REFRESH) throw error
            val refreshed = checkNotNull(coordinator).refreshCancellable(initial) { old -> refreshSessionCancellable(old) }
            coordinator.requireCurrent(refreshed)
            try {
                executeCancellable(method, path, body, idempotencyKey, refreshed.session?.token)
            } catch (retryError: ApiError) {
                if (retryError.status == 401) coordinator.invalidate(refreshed)
                throw retryError
            }
        }
        } catch (error: Throwable) {
            logNetworkFailure(path, error, started)
            throw error
        }
    }

    private fun refreshSession(old: Session): Session {
        val response = execute(
            "POST",
            ClientApiRoutes.REFRESH,
            JSONObject().put("refreshToken", old.refreshToken).put("platform", "android"),
            idempotencyKey = null,
            bearerToken = null,
        )
        return Session(response.getString("token"), response.getString("refreshToken"), old.username, old.role)
    }

    private suspend fun refreshSessionCancellable(old: Session): Session {
        val response = executeCancellable(
            "POST",
            ClientApiRoutes.REFRESH,
            JSONObject().put("refreshToken", old.refreshToken).put("platform", "android"),
            idempotencyKey = null,
            bearerToken = null,
        )
        return Session(response.getString("token"), response.getString("refreshToken"), old.username, old.role)
    }

    private fun execute(
        method: String,
        path: String,
        body: JSONObject?,
        idempotencyKey: String?,
        bearerToken: String?,
    ): JSONObject = transport.execute(ClientRequest(method, path, body, idempotencyKey, bearerToken))

    private suspend fun executeCancellable(
        method: String,
        path: String,
        body: JSONObject?,
        idempotencyKey: String?,
        bearerToken: String?,
    ): JSONObject = withContext(Dispatchers.IO) {
        transport.executeCancellable(ClientRequest(method, path, body, idempotencyKey, bearerToken))
    }
}

internal data class ClientProfile(val username: String, val role: String)
