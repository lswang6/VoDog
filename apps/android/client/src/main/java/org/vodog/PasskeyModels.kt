package org.vodog

import org.json.JSONObject

/**
 * One registered passkey as returned by `GET /api/v1/passkeys` (S18 contract, see
 * services/control/src/passkey-metadata.ts). Every metadata field is optional because
 * rows registered before S18 carry nulls.
 */
data class PasskeyItem(
    val id: String,
    val createdAt: String,
    val deviceType: String? = null,
    val backedUp: Boolean? = null,
    val transports: List<String>? = null,
    val label: String? = null,
    val displayName: String? = null,
    val aaguid: String? = null,
    val clientPlatform: String? = null,
    val authenticatorAttachment: String? = null,
    val lastUsedAt: String? = null,
)

/**
 * Parses one `items[]` row. Only `id` is required; every metadata field degrades to null so a row
 * registered before the S18 migration still renders.
 */
internal fun parsePasskeyItem(json: JSONObject): PasskeyItem = PasskeyItem(
    id = json.getString("id").also { require(it.isNotBlank()) { "Passkey 标识无效" } },
    createdAt = json.optStringOrNull("createdAt").orEmpty(),
    deviceType = json.optStringOrNull("deviceType"),
    // The server coerces this to a boolean, but an older row can still answer null.
    backedUp = if (json.isNull("backedUp")) null else json.optBoolean("backedUp"),
    transports = json.optJSONArray("transports")?.let { array ->
        List(array.length()) { index -> array.optString(index) }.filter(String::isNotBlank)
    },
    label = json.optStringOrNull("label"),
    displayName = json.optStringOrNull("displayName"),
    aaguid = json.optStringOrNull("aaguid"),
    clientPlatform = json.optStringOrNull("clientPlatform"),
    authenticatorAttachment = json.optStringOrNull("authenticatorAttachment"),
    lastUsedAt = json.optStringOrNull("lastUsedAt"),
)

private fun JSONObject.optStringOrNull(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf(String::isNotBlank)
