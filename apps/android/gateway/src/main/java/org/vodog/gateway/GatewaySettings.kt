package org.vodog.gateway

import android.content.Context
import org.json.JSONObject
import java.time.Instant

data class AppliedSimSettings(
    val simId: String, val mode: String, val timeoutSeconds: Int,
    val version: Long, val assignmentVersion: Int, val generation: Long,
)

/** The exact answer modes this gateway can execute. Anything else is an unusable settings payload. */
internal val SUPPORTED_ANSWER_MODES = setOf("normal", "ai", "timeout_ai")

internal fun settingsTransitionError(previous: AppliedSimSettings?, next: AppliedSimSettings): String? {
    if (next.mode !in SUPPORTED_ANSWER_MODES) return "settings_invalid"
    if (next.timeoutSeconds !in 10..120 || next.version < 1) return "settings_invalid"
    if (previous != null && previous.generation == next.generation && previous.assignmentVersion == next.assignmentVersion) {
        if (previous.version > next.version) return "settings_version_stale"
        if (previous.version == next.version && previous != next) return "settings_version_collision"
    }
    return null
}

/**
 * Settings are independent of permission to dial or capture audio.
 *
 * S22 decision 8: `ai` and `timeout_ai` are accepted and stored like any other mode. The gateway
 * never executes the AI itself - Control answers on the AI's behalf and the stored mode only drives
 * local display - so an unexecutable mode here is simply an invalid payload (`settings_invalid`),
 * not a capability gap. Rejecting them used to strand `sim_settings.applied_version` behind
 * `version` forever, which Control turned into a per-heartbeat resend loop.
 */
class GatewaySettingsStore(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_sim_settings", Context.MODE_PRIVATE)

    fun read(simId: String): AppliedSimSettings? = prefs.getString(simId, null)?.let { raw ->
        val value = JSONObject(raw)
        AppliedSimSettings(simId, value.getString("mode"), value.getInt("timeoutSeconds"),
            value.getLong("version"), value.getInt("assignmentVersion"), value.getLong("generation"))
    }

    fun apply(value: AppliedSimSettings) = synchronized(LOCK) {
        val previous = read(value.simId)
        check(settingsTransitionError(previous, value) == null) { "settings_transition_rejected" }
        if (previous != null && previous.generation == value.generation && previous.assignmentVersion == value.assignmentVersion) {
            check(previous.version <= value.version) { "settings_version_stale" }
            if (previous.version == value.version) {
                check(previous == value) { "settings_version_collision" }
                return@synchronized
            }
        }
        val encoded = JSONObject().put("mode", value.mode).put("timeoutSeconds", value.timeoutSeconds)
            .put("version", value.version).put("assignmentVersion", value.assignmentVersion)
            .put("generation", value.generation)
        check(prefs.edit().putString(value.simId, encoded.toString()).commit()) { "settings_commit_failed" }
    }

    companion object { private val LOCK = Any() }
}

class GatewaySettingsCoordinator(
    context: Context, private val runtime: GatewayRuntimeStore, private val api: GatewayApi,
    private val identity: GatewayCommandIdentity? = null,
    private val replayStore: GatewayReplayHorizonStore? = null,
) {
    private val store = GatewaySettingsStore(context)
    private val bindings = GatewaySimBindingStore(context)

    fun handle(command: GatewayCommand) {
        val replayEvidence = identity?.let { ReplayAckEvidence(command.sequence, commandReplayFingerprint(it.gatewayId, command)) }
        val payload = JSONObject(command.payloadJson)
        val simId = payload.getString("simId")
        val value = AppliedSimSettings(simId, payload.getString("mode"), payload.getInt("timeoutSeconds"),
            payload.getLong("settingsVersion"), payload.getInt("assignmentVersion"), command.generation)
        val binding = bindings.bySimId(simId)
        val previous = store.read(simId)
        val reason = when {
            !runtime.enabled -> "control_disabled"
            command.generation != runtime.deviceEpoch -> "generation_mismatch"
            binding == null || !binding.routable || binding.assignmentVersion != value.assignmentVersion -> "assignment_mismatch"
            settingsTransitionError(previous, value) != null -> settingsTransitionError(previous, value)
            command.expiresAt == null || !Instant.parse(command.expiresAt).isAfter(Instant.now()) -> "command_expired"
            else -> null
        }
        if (reason != null) {
            api.ackCommand(command, "rejected", JSONObject().put("phase", "not_executed").put("reason", reason), replayEvidence, replayStore)
            return
        }
        if (previous != value) replayStore?.markEffectStarted(command.commandId)
        store.apply(value) // Durable before ACK. Retried version is an exact no-op.
        api.ackCommand(command, "acked", JSONObject().put("appliedVersion", value.version)
            .put("simId", value.simId).put("assignmentVersion", value.assignmentVersion), replayEvidence, replayStore)
    }
}
