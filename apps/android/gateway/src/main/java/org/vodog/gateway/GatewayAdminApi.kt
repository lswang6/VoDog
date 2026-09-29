package org.vodog.gateway

import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

data class GatewayAdminUser(val id: String, val username: String, val role: String)
data class GatewayAdminGateway(val id: String, val name: String)
data class GatewayAdminSimSettings(
    val mode: String,
    val timeoutSeconds: Int,
    val version: Int,
    val appliedVersion: Int?,
    val availableModes: Set<String>,
    val aiUnavailableReason: String?,
)
data class GatewayAdminSim(
    val id: String,
    val gatewayId: String,
    val slotIndex: Int?,
    val ownerUserId: String?,
    val label: String,
    val version: Int,
    val assignmentPending: Boolean,
    val present: Boolean,
    val settings: GatewayAdminSimSettings?,
    val countryIso: String? = null,
    val embedded: Boolean? = null,
)

data class GatewayAdminSnapshot(
    val users: List<GatewayAdminUser>,
    val gateways: List<GatewayAdminGateway>,
    val sims: List<GatewayAdminSim>,
)

data class GatewayAdminAssignment(val simId: String, val ownerUserId: String?, val version: Int)

internal object GatewayAdminRoutes {
    const val LOGIN = "/auth/login"
    const val USERS = "/admin/users"
    const val GATEWAYS = "/admin/gateways"
    const val SIMS = "/admin/sims"
    fun owner(simId: String) = "/admin/sims/${GatewayApiRoutes.encodePathSegment(simId)}/owner"
    fun reports(gatewayId: String) =
        "/admin/gateways/${GatewayApiRoutes.encodePathSegment(gatewayId)}/reports/calls"
}

class GatewayAdminHttpException(
    val status: Int,
    val code: String,
    override val message: String,
) : Exception(message)

class GatewayAdminRequestCancelledException : Exception("管理员请求已取消")

class GatewayAdminRequestToken internal constructor(internal val generation: Long)

class GatewayAdminSession {
    @Volatile var token: String? = null
        private set
    @Volatile var username: String? = null
        private set

    fun open(token: String, username: String) {
        this.token = token
        this.username = username
    }

    fun clear() {
        token = null
        username = null
    }
}

internal object GatewayAdminNetworkGate {
    fun requireEnabled(enabled: Boolean) {
        check(enabled) { "总控已关闭，管理员请求已取消" }
    }
}

sealed interface GatewayResolution {
    data class Ready(val gatewayId: String, val sims: List<GatewayAdminSim>) : GatewayResolution
    data class Blocked(val reason: String) : GatewayResolution
}

internal object GatewayAdminRoutingPolicy {
    fun resolve(localSimIds: Set<String>, adminSims: List<GatewayAdminSim>): GatewayResolution {
        if (localSimIds.isEmpty()) return GatewayResolution.Blocked("等待本机 SIM 完成同步")
        val matches = adminSims.filter { it.id in localSimIds }
        if (matches.map { it.id }.toSet() != localSimIds) {
            return GatewayResolution.Blocked("本机 SIM 资料尚未完整同步，请刷新后重试")
        }
        val gatewayIds = matches.map { it.gatewayId }.toSet()
        if (gatewayIds.size != 1) {
            return GatewayResolution.Blocked("本机 SIM 归属到多个网关，已停止账号操作")
        }
        return GatewayResolution.Ready(gatewayIds.single(), matches.sortedBy { it.slotIndex ?: Int.MAX_VALUE })
    }

    fun refreshAfterFailure(error: GatewayAdminHttpException): Boolean = error.status == 409
}

class GatewayAdminApi(
    private val baseUrlOverride: String? = null,
    private val controlEnabled: () -> Boolean,
    private val transportFactory: () -> GatewayHttpTransport = { OwnedGatewayHttpTransport() },
) : Closeable {
    private val lifecycleLock = Any()
    private var cancellationGeneration = 0L
    private var transport = transportFactory()
    private var closed = false

    fun cancelAll() {
        val previous = synchronized(lifecycleLock) {
            cancellationGeneration++
            transport.also { if (!closed) transport = transportFactory() }
        }
        previous.close()
    }

    override fun close() {
        val previous = synchronized(lifecycleLock) {
            if (closed) return
            closed = true
            cancellationGeneration++
            transport
        }
        previous.close()
    }

    fun beginRequest(): GatewayAdminRequestToken = synchronized(lifecycleLock) {
        check(!closed) { "gateway admin network owner closed" }
        GatewayAdminNetworkGate.requireEnabled(controlEnabled())
        GatewayAdminRequestToken(cancellationGeneration)
    }

    fun login(requestToken: GatewayAdminRequestToken, username: String, password: String): Pair<String, String> {
        val response = request(
            requestToken = requestToken,
            method = "POST",
            path = GatewayAdminRoutes.LOGIN,
            body = JSONObject()
                .put("username", username)
                .put("password", password)
                .put("platform", "android")
                .put("deviceName", "Gateway admin console"),
        )
        val user = response.getJSONObject("user")
        if (user.getString("role") != "admin") {
            throw GatewayAdminHttpException(403, "ADMIN_REQUIRED", "此账号没有管理员权限")
        }
        return response.getString("token") to user.getString("username")
    }

    fun load(requestToken: GatewayAdminRequestToken, token: String): GatewayAdminSnapshot = GatewayAdminSnapshot(
        users = request(requestToken, "GET", GatewayAdminRoutes.USERS, token).getJSONArray("items").objects().map { item ->
            GatewayAdminUser(item.getString("id"), item.getString("username"), item.getString("role"))
        },
        gateways = request(requestToken, "GET", GatewayAdminRoutes.GATEWAYS, token).getJSONArray("items").objects().map { item ->
            GatewayAdminGateway(item.getString("id"), item.getString("name"))
        },
        sims = request(requestToken, "GET", GatewayAdminRoutes.SIMS, token).getJSONArray("items").objects().map { item ->
            GatewayAdminSim(
                id = item.getString("id"),
                gatewayId = item.getString("gatewayId"),
                slotIndex = if (item.isNull("slotIndex")) null else item.getInt("slotIndex"),
                ownerUserId = item.optNullableString("ownerUserId"),
                label = item.optString("label").ifBlank {
                    if (item.isNull("slotIndex")) "未启用 SIM" else "SIM ${item.getInt("slotIndex") + 1}"
                },
                version = item.getInt("version"),
                assignmentPending = item.optBoolean("assignmentPending"),
                present = item.optBoolean("present"),
                settings = item.optJSONObject("settings")?.let(::parseAdminSimSettings),
                countryIso = item.optNullableString("countryIso"),
                embedded = if (item.isNull("embedded")) null else item.getBoolean("embedded"),
            )
        },
    )

    fun reports(
        requestToken: GatewayAdminRequestToken,
        token: String,
        gatewayId: String,
        period: GatewayAdminReportPeriod,
        timeZone: String,
        cursor: String? = null,
        limit: Int = 25,
    ): GatewayAdminReportPage {
        require(limit in 1..100) { "invalid report limit" }
        val query = buildList {
            add("period=${encodeQuery(period.value)}")
            add("timeZone=${encodeQuery(timeZone)}")
            add("answeredBy=ai")
            add("limit=$limit")
            cursor?.let { add("cursor=${encodeQuery(it)}") }
        }.joinToString("&")
        val page = parseGatewayAdminReportPage(request(
            requestToken, "GET", "${GatewayAdminRoutes.reports(gatewayId)}?$query", token
        ))
        require(page.window.period == period.value && page.window.timeZone == timeZone) {
            "report window does not match request"
        }
        return page
    }

    fun assignOwner(
        requestToken: GatewayAdminRequestToken,
        token: String,
        sim: GatewayAdminSim,
        ownerUserId: String?,
    ): GatewayAdminAssignment {
        val response = request(
            requestToken = requestToken,
            method = "PUT",
            path = GatewayAdminRoutes.owner(sim.id),
            token = token,
            body = JSONObject().put("ownerUserId", ownerUserId ?: JSONObject.NULL).put("expectedVersion", sim.version),
        ).getJSONObject("sim")
        return GatewayAdminAssignment(
            response.getString("id"), response.optNullableString("ownerUserId"), response.getInt("version")
        )
    }

    private fun request(
        requestToken: GatewayAdminRequestToken,
        method: String,
        path: String,
        token: String? = null,
        body: JSONObject? = null,
    ): JSONObject {
        val ownedTransport = synchronized(lifecycleLock) {
            requireCurrentLocked(requestToken)
            transport
        }
        val response = try {
            ownedTransport.execute(GatewayHttpRequest(
                url = (baseUrlOverride ?: GatewayEndpoint.baseUrl()) + path,
                method = method,
                authorization = token?.let { "Bearer $it" },
                jsonBody = body?.toString()?.toByteArray(),
                responseLimitBytes = MAX_RESPONSE_BYTES,
            ))
        } catch (error: Throwable) {
            val stale = synchronized(lifecycleLock) {
                !controlEnabled() || requestToken.generation != cancellationGeneration
            }
            if (stale) throw GatewayAdminRequestCancelledException()
            if (error is IOException && error.message == "gateway response too large") {
                throw GatewayAdminHttpException(502, "RESPONSE_TOO_LARGE", "服务器响应超过安全上限")
            }
            throw error
        }
        synchronized(lifecycleLock) { requireCurrentLocked(requestToken) }
        if (response.status !in 200..299) {
                val error = runCatching { JSONObject(response.body).getJSONObject("error") }.getOrNull()
                throw GatewayAdminHttpException(
                    response.status,
                    error?.optString("code").orEmpty(),
                    error?.optString("message").orEmpty().ifBlank { "账号操作暂时失败" },
                )
        }
        return if (response.body.isBlank()) JSONObject() else JSONObject(response.body)
    }

    private fun requireCurrentLocked(requestToken: GatewayAdminRequestToken) {
        if (closed || !controlEnabled() || requestToken.generation != cancellationGeneration) {
            throw GatewayAdminRequestCancelledException()
        }
    }

    internal companion object {
        const val MAX_RESPONSE_BYTES = 1024 * 1024
        fun forUrlConnectionTest(
            baseUrl: String,
            controlEnabled: () -> Boolean,
            connectionFactory: (URL) -> HttpURLConnection,
        ) = GatewayAdminApi(baseUrl, controlEnabled) { UrlConnectionGatewayHttpTransport(connectionFactory) }
    }
}

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map(::getJSONObject)

private fun JSONObject.optNullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf(String::isNotBlank)

private fun parseAdminSimSettings(value: JSONObject): GatewayAdminSimSettings {
    val modes = value.optJSONArray("availableModes")
    return GatewayAdminSimSettings(
        mode = value.getString("mode"),
        timeoutSeconds = value.getInt("timeoutSeconds"),
        version = value.getInt("version"),
        appliedVersion = if (!value.has("appliedVersion") || value.isNull("appliedVersion")) null else value.getInt("appliedVersion"),
        availableModes = if (modes == null) emptySet() else (0 until modes.length()).map(modes::getString).toSet(),
        aiUnavailableReason = value.optNullableString("aiUnavailableReason"),
    )
}

private fun encodeQuery(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())
