package org.vodog

/**
 * S72b（照搬网关 S71 `GatewayEndpoint`）：默认网络是蜂窝时 Control 走 relay-node 国内中转，Wi-Fi / 有线直连 control-node。
 * [alternateUrl] 让一次网络层失败的幂等请求去另一边再试一次。
 */
object ClientEndpoint {
    @Volatile var relay: Boolean = false
        private set

    fun baseUrl(): String = if (relay) BuildConfig.RELAY_API_BASE_URL else BuildConfig.API_BASE_URL

    /** 默认网络回调里调；只在模式翻转时记 `api.relay`。 */
    fun onDefaultNetwork(transport: String) {
        val next = transport == "cellular"
        if (next == relay) return
        relay = next
        runCatching { ClientDiag.log("api.relay", mapOf("on" to next, "network" to transport)) }
    }

    /** 同一请求换到另一个 Control 基址；不是我们的 URL（或两基址相同，S33）时为 null。 */
    fun alternateUrl(url: String): String? = alternateUrl(url, BuildConfig.API_BASE_URL, BuildConfig.RELAY_API_BASE_URL)

    internal fun alternateUrl(url: String, direct: String, relayBase: String): String? = when {
        direct == relayBase -> null
        url.startsWith(direct) -> relayBase + url.removePrefix(direct)
        url.startsWith(relayBase) -> direct + url.removePrefix(relayBase)
        else -> null
    }

    internal fun setRelayForTest(value: Boolean) { relay = value }
}

/** 只有 GET / DELETE 或带 Idempotency-Key 的请求可以换端点重发。 */
internal fun ClientRequest.retriesOnAlternate(): Boolean =
    method == "GET" || method == "DELETE" || idempotencyKey != null
