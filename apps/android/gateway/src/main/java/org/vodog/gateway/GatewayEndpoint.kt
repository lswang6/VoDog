package org.vodog.gateway

/**
 * S71: which Control base URL this process talks to. On a cellular default network the gateway goes
 * through the relay-node relay (domestic, reachable on 4G); on Wi-Fi / ethernet it goes direct to control-node.
 * [alternateUrl] lets one failed request try the other side once.
 */
object GatewayEndpoint {
    @Volatile var relay: Boolean = false
        private set

    fun baseUrl(): String = if (relay) BuildConfig.RELAY_API_BASE_URL else BuildConfig.API_BASE_URL
    fun alternate(): String = if (relay) BuildConfig.API_BASE_URL else BuildConfig.RELAY_API_BASE_URL

    /** Called from the default-network callback; logs `api.relay` only when the mode flips. */
    fun onDefaultNetwork(network: String) {
        val next = network == "cellular"
        if (next == relay) return
        relay = next
        runCatching { GatewayDiag.log("api.relay", mapOf("on" to next, "network" to network)) }
    }

    /** The same request against the other Control base URL, or null for a URL that is not ours. */
    fun alternateUrl(url: String): String? = when {
        url.startsWith(BuildConfig.API_BASE_URL) -> BuildConfig.RELAY_API_BASE_URL + url.removePrefix(BuildConfig.API_BASE_URL)
        url.startsWith(BuildConfig.RELAY_API_BASE_URL) -> BuildConfig.API_BASE_URL + url.removePrefix(BuildConfig.RELAY_API_BASE_URL)
        else -> null
    }

    internal fun setRelayForTest(value: Boolean) { relay = value }
}
