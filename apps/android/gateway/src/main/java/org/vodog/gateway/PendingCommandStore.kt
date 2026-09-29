package org.vodog.gateway

import android.content.Context
import org.json.JSONObject

/** Persists the deterministic rejection before attempting its ACK, so ACK loss is retry-safe. */
class PendingCommandStore(context: Context, private val identity: GatewayCommandIdentity) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(gatewayIdentityPreferenceName("gateway_command_results", identity), Context.MODE_PRIVATE)

    fun rememberRejected(command: GatewayCommand) {
        check(command.generation == identity.generation) { "command identity mismatch" }
        val current = JSONObject(prefs.getString(KEY_PENDING, "{}") ?: "{}")
        current.put(command.commandId, JSONObject()
            .put("generation", command.generation)
            .put("sequence", command.sequence)
            .put("callId", command.callId ?: JSONObject.NULL)
            .put("smsId", command.smsId ?: JSONObject.NULL)
            .put("kind", command.kind)
            .put("payload", command.payloadJson)
            .put("expiresAt", command.expiresAt ?: JSONObject.NULL)
            .put("reconciliationOnly", command.reconciliationOnly))
        check(prefs.edit().putString(KEY_PENDING, current.toString()).commit()) {
            "pending command commit failed"
        }
    }

    fun pending(): List<GatewayCommand> {
        // Treat corrupt or unreadable pending work as an execution fence. Returning an empty list
        // could allow a migration or replay floor to discard an obligation that still exists.
        val current = JSONObject(prefs.getString(KEY_PENDING, "{}") ?: "{}")
        return buildList {
            current.keys().forEach { id ->
                val item = current.getJSONObject(id)
                add(GatewayCommand(
                    id,
                    item.getLong("generation"),
                    item.getLong("sequence"),
                    item.optString("callId").takeIf { !item.isNull("callId") && it.isNotBlank() },
                    item.optString("smsId").takeIf { !item.isNull("smsId") && it.isNotBlank() },
                    item.optString("kind", "unknown"),
                    item.optString("payload", "{}"),
                    item.optString("expiresAt").takeIf { !item.isNull("expiresAt") && it.isNotBlank() },
                    item.optBoolean("reconciliationOnly", false),
                ))
            }
        }.sortedBy { it.sequence }
    }

    fun markAcked(command: GatewayCommand) {
        val current = JSONObject(prefs.getString(KEY_PENDING, "{}") ?: "{}")
        current.remove(command.commandId)
        check(prefs.edit().putString(KEY_PENDING, current.toString()).commit()) {
            "pending command removal failed"
        }
    }

    companion object { private const val KEY_PENDING = "pending_rejections" }
}
