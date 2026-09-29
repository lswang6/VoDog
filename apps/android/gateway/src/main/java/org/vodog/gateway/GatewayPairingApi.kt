package org.vodog.gateway

import org.json.JSONObject

data class PairingResult(val deviceToken: String, val gatewayId: String, val deviceEpoch: Long)

class GatewayPairingApi(
    private val transport: GatewayHttpTransport = OwnedGatewayHttpTransport(),
) {
    fun pair(code: String, label: String): PairingResult {
        try {
            val response = transport.execute(GatewayHttpRequest(
                GatewayEndpoint.baseUrl() + "/gateway/pair",
                "POST",
                jsonBody = JSONObject().put("code", code).put("label", label).toString().toByteArray(),
            ))
            if (response.status !in 200..299) {
                val message = runCatching { JSONObject(response.body).getJSONObject("error").optString("message") }
                    .getOrNull().orEmpty()
                error(message.ifBlank { "配对失败（HTTP ${response.status}）" })
            }
            val json = JSONObject(response.body)
            val gateway = json.getJSONObject("gateway")
            return PairingResult(
                deviceToken = json.getString("deviceToken"),
                gatewayId = gateway.getString("id"),
                deviceEpoch = gateway.getLong("deviceEpoch"),
            )
        } finally {
            transport.close()
        }
    }
}
