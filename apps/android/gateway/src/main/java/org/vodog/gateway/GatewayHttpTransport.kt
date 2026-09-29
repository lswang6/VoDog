package org.vodog.gateway

import okhttp3.Call
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.EventListener
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import java.io.Closeable
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

data class GatewayHttpRequest(
    val url: String,
    val method: String,
    val authorization: String? = null,
    val jsonBody: ByteArray? = null,
    val timeoutMs: Long = 15_000,
    val responseLimitBytes: Int = 1024 * 1024,
    /** S36b D2: extra request headers (only `X-Diag-Install` so far). */
    val headers: Map<String, String> = emptyMap(),
    /**
     * S71: safe to send twice. GET and any request carrying an `Idempotency-Key` header are; callers
     * mark the POST routes Control deduplicates themselves (eventId, commandId, state reports).
     */
    val idempotent: Boolean = method == "GET" || headers.keys.any { it.equals("Idempotency-Key", ignoreCase = true) },
    /** S71: false opts a request out of the alternate-endpoint retry (the S21 standby long-poll). */
    val alternateRetry: Boolean = true,
)

data class GatewayHttpResponse(val status: Int, val body: String)

fun interface GatewayHttpTransport : Closeable {
    fun execute(request: GatewayHttpRequest): GatewayHttpResponse
    fun cancelAndEvict() = Unit
    override fun close() = cancelAndEvict()
}

/** A private pool/dispatcher whose lifetime is exactly one gateway owner. */
class OwnedGatewayHttpTransport internal constructor(
    private val pool: ConnectionPool = ConnectionPool(5, 5, TimeUnit.MINUTES),
    private val dispatcher: Dispatcher = Dispatcher(),
    private val socketFactory: OwnedGatewaySocketFactory = OwnedGatewaySocketFactory(),
    interceptor: Interceptor? = null,
    private val onCallRegistered: ((Call) -> Unit)? = null,
    private val onClosedConnectionReleased: ((Connection) -> Unit)? = null,
    protocols: List<Protocol>? = null,
    /**
     * Per-read socket timeout. The default covers every owner that only makes short requests and the
     * 8 s command doorbell; the S21 standby beacon holds for 20 s and raises it to 35 s. It is a
     * separate knob from [GatewayHttpRequest.timeoutMs], which is the whole-call deadline.
     */
    readTimeoutSeconds: Long = DEFAULT_READ_TIMEOUT_SECONDS,
) : GatewayHttpTransport {
    private val lock = Any()
    private val active = mutableSetOf<Call>()
    private var closed = false
    private val client = OkHttpClient.Builder()
        .connectionPool(pool)
        .dispatcher(dispatcher)
        .socketFactory(socketFactory)
        .eventListenerFactory {
            object : EventListener() {
                override fun connectionAcquired(call: Call, connection: Connection) {
                    if (isClosed()) {
                        call.cancel()
                        closeOwnedConnection(connection)
                    }
                }

                override fun connectionReleased(call: Call, connection: Connection) {
                    if (isClosed()) {
                        closeOwnedConnection(connection)
                        onClosedConnectionReleased?.invoke(connection)
                    }
                }
            }
        }
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(readTimeoutSeconds.coerceAtLeast(1L), TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .apply { interceptor?.let(::addInterceptor); protocols?.let(::protocols) }
        .build()

    override fun execute(request: GatewayHttpRequest): GatewayHttpResponse {
        require(request.responseLimitBytes > 0)
        try {
            return executeOnce(request, request.url)
        } catch (failure: IOException) {
            // S71: a network-layer failure (no HTTP status) tries the other Control endpoint once.
            val alternate = GatewayEndpoint.alternateUrl(request.url)
            if (failure is ResponseTooLargeException || isClosed() || alternate == null ||
                !request.idempotent || !request.alternateRetry) throw failure
            runCatching { GatewayDiag.log("api.alternate_retry", mapOf(
                "relay" to !GatewayEndpoint.relay, "errorType" to failure.javaClass.simpleName,
            ), level = "warn") }
            try {
                return executeOnce(request, alternate)
            } catch (second: Exception) {
                second.addSuppressed(failure)
                throw second
            }
        }
    }

    private fun executeOnce(request: GatewayHttpRequest, url: String): GatewayHttpResponse {
        val builder = Request.Builder().url(url)
            .header("Accept", "application/json")
        request.authorization?.let { builder.header("Authorization", it) }
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val body = when {
            request.jsonBody != null -> request.jsonBody.toRequestBody(JSON_MEDIA_TYPE)
            request.method in METHODS_REQUIRING_BODY -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        builder.method(request.method, body)
        val call = client.newCall(builder.build()).also {
            it.timeout().timeout(request.timeoutMs, TimeUnit.MILLISECONDS)
        }
        synchronized(lock) {
            check(!closed) { "gateway network owner closed" }
            active += call
        }
        try {
            onCallRegistered?.invoke(call)
            call.execute().use { response ->
                val source = response.body?.source()
                val bytes = source?.let { input ->
                    val buffer = Buffer()
                    while (true) {
                        val remaining = request.responseLimitBytes.toLong() + 1 - buffer.size
                        if (remaining <= 0) throw ResponseTooLargeException()
                        val count = input.read(buffer, minOf(8_192L, remaining))
                        if (count < 0) break
                    }
                    if (buffer.size > request.responseLimitBytes) throw ResponseTooLargeException()
                    buffer.readByteArray()
                } ?: ByteArray(0)
                return GatewayHttpResponse(response.code, bytes.toString(Charsets.UTF_8))
            }
        } finally {
            val ownerClosed = synchronized(lock) { active -= call; closed }
            // evictAll only closes idle connections. An HTTP/2 stream cancelled during
            // close() may release its connection after that first eviction. The response
            // is closed above, so evict again here instead of retaining it for five minutes.
            if (ownerClosed) runCatching(pool::evictAll)
        }
    }

    override fun cancelAndEvict() {
        val calls = synchronized(lock) {
            if (closed) return
            closed = true
            active.toList().also { active.clear() }
        }
        socketFactory.close()
        calls.forEach { runCatching(it::cancel) }
        runCatching(dispatcher::cancelAll)
        runCatching(pool::evictAll)
        runCatching { dispatcher.executorService.shutdownNow() }
    }

    internal fun isClosed(): Boolean = synchronized(lock) { closed }

    private fun closeOwnedConnection(connection: Connection) {
        // This transport never shares its pool, so closing a released/acquired connection cannot
        // interrupt another owner. Event callbacks cover the window after close()'s first eviction.
        runCatching { connection.socket().close() }
        runCatching(pool::evictAll)
    }

    private class ResponseTooLargeException : IOException("gateway response too large")

    private companion object {
        const val DEFAULT_READ_TIMEOUT_SECONDS = 20L
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val METHODS_REQUIRING_BODY = setOf("POST", "PUT", "PATCH")
    }
}

/** Test seam for existing deterministic HttpURLConnection fakes. Production never uses it. */
internal class UrlConnectionGatewayHttpTransport(
    private val factory: (URL) -> HttpURLConnection,
) : GatewayHttpTransport {
    private val owner = GatewayHttpConnectionOwner()

    override fun execute(request: GatewayHttpRequest): GatewayHttpResponse {
        val connection = factory(URL(request.url))
        check(owner.register(connection)) { "gateway network owner closed" }
        try {
            GatewayHttpConnectionPolicy.apply(connection)
            connection.instanceFollowRedirects = false
            connection.requestMethod = request.method
            connection.connectTimeout = minOf(10_000, request.timeoutMs.toInt())
            connection.readTimeout = request.timeoutMs.toInt()
            connection.setRequestProperty("Accept", "application/json")
            request.authorization?.let { connection.setRequestProperty("Authorization", it) }
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            request.jsonBody?.let {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { output -> output.write(it) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { input ->
                val result = ByteArrayOutputStream()
                val chunk = ByteArray(8 * 1024)
                while (true) {
                    val count = input.read(chunk)
                    if (count < 0) break
                    if (result.size() + count > request.responseLimitBytes) throw IOException("gateway response too large")
                    result.write(chunk, 0, count)
                }
                result.toByteArray()
            } ?: ByteArray(0)
            return GatewayHttpResponse(status, bytes.toString(Charsets.UTF_8))
        } finally {
            connection.disconnect()
            owner.unregister(connection)
        }
    }

    override fun cancelAndEvict() = owner.close()
}
