package org.vodog.gateway

import android.content.Context
import java.security.MessageDigest

data class GatewayCommandIdentity(
    val gatewayId: String,
    val generation: Long,
    val credentialFingerprint: String,
) {
    init {
        require(gatewayId.isNotBlank() && gatewayId.length <= 256)
        require(generation > 0)
        require(credentialFingerprint.matches(Regex("^[0-9a-f]{64}$")))
    }

    internal val storageSuffix: String
        get() = gatewayIdentitySha256("$gatewayId\u0000$generation\u0000$credentialFingerprint").take(32)
}

class GatewayRuntimeStore(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(NAME, Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) { prefs.edit().putBoolean(KEY_ENABLED, value).apply() }

    /**
     * S21 §D. The user's local permission for the standby beacon. Written with `commit()` because the
     * standby service reads it immediately after the switch flips, in a different component.
     */
    var allowRemotePower: Boolean
        get() = prefs.getBoolean(KEY_ALLOW_REMOTE_POWER, false)
        set(value) { prefs.edit().putBoolean(KEY_ALLOW_REMOTE_POWER, value).commit() }

    /** S56: the heartbeat's `earlyMedia` mode, persisted like S55 `phoneSync`; read at media selection. */
    var earlyMedia: Boolean
        get() = prefs.getBoolean(KEY_EARLY_MEDIA, false)
        set(value) { if (value != earlyMedia) prefs.edit().putBoolean(KEY_EARLY_MEDIA, value).commit() }

    /**
     * The outcome of the last remote power request, waiting for a request that can carry it. Whichever
     * channel is alive sends it — the standby beacon while OFF, the heartbeat while ON — and clears it
     * only after that request was accepted.
     */
    val pendingPowerResult: String?
        get() = prefs.getString(KEY_POWER_RESULT, null)?.takeIf(String::isNotBlank)

    @Synchronized fun recordPowerResult(json: String) {
        prefs.edit().putString(KEY_POWER_RESULT, json.take(MAX_POWER_RESULT_LENGTH)).commit()
    }

    /**
     * Compare-and-clear. A newer result written while the request was in flight (a second remote
     * request, or a power-off refused for a call that started meanwhile) must survive the clear.
     */
    @Synchronized fun clearPowerResult(expected: String) {
        if (pendingPowerResult == expected) prefs.edit().remove(KEY_POWER_RESULT).commit()
    }

    internal val standbyState: StandbyDisplayState
        get() = runCatching {
            StandbyDisplayState.valueOf(
                prefs.getString(KEY_STANDBY_STATE, null) ?: StandbyDisplayState.DISABLED.name,
            )
        }.getOrDefault(StandbyDisplayState.DISABLED)

    val standbyBackoffMs: Long
        get() = prefs.getLong(KEY_STANDBY_BACKOFF_MS, 0L).coerceAtLeast(0L)

    /** Diagnostics only, written on a real change so a steady hold never recomposes the screen. */
    internal fun publishStandby(state: StandbyDisplayState, backoffMs: Long = 0L) {
        val editor = prefs.edit()
        var changed = false
        if (standbyState != state) { editor.putString(KEY_STANDBY_STATE, state.name); changed = true }
        val bounded = backoffMs.coerceAtLeast(0L)
        if (standbyBackoffMs != bounded) { editor.putLong(KEY_STANDBY_BACKOFF_MS, bounded); changed = true }
        if (changed) editor.apply()
    }

    var connection: ServerConnection
        get() = runCatching {
            ServerConnection.valueOf(prefs.getString(KEY_CONNECTION, null) ?: ServerConnection.DISABLED.name)
        }.getOrDefault(ServerConnection.DISABLED)
        set(value) { prefs.edit().putString(KEY_CONNECTION, value.name).apply() }

    var connectionDetail: String
        get() = prefs.getString(KEY_CONNECTION_DETAIL, "") ?: ""
        set(value) { prefs.edit().putString(KEY_CONNECTION_DETAIL, value.take(180)).apply() }

    /**
     * S36b D2: a random id that survives restarts and re-pairings, sent as `X-Diag-Install` so one
     * Pixel's diagnostics can be followed across sessions. Written with `commit()` because the first
     * diag POST can leave before an `apply()` lands.
     */
    val installId: String
        get() = prefs.getString(KEY_INSTALL_ID, null)
            ?: java.util.UUID.randomUUID().toString()
                .also { prefs.edit().putString(KEY_INSTALL_ID, it).commit() }

    /** elapsedRealtime of the last accepted heartbeat; only valid within this boot. */
    val lastHeartbeatSuccessAtMs: Long?
        get() = prefs.getLong(KEY_HEARTBEAT_SUCCESS_AT, 0L).takeIf { it > 0L }

    /** Wall clock of the last accepted heartbeat, for display only. */
    val lastHeartbeatWallClockMs: Long?
        get() = prefs.getLong(KEY_HEARTBEAT_WALL_CLOCK, 0L).takeIf { it > 0L }

    val consecutiveHeartbeatFailures: Int
        get() = prefs.getInt(KEY_HEARTBEAT_FAILURES, 0)

    val lastHeartbeatError: String
        get() = prefs.getString(KEY_HEARTBEAT_ERROR, "") ?: ""

    fun recordHeartbeatSuccess(elapsedRealtimeMs: Long, wallClockMs: Long) {
        prefs.edit()
            .putLong(KEY_HEARTBEAT_SUCCESS_AT, elapsedRealtimeMs.coerceAtLeast(1L))
            .putLong(KEY_HEARTBEAT_WALL_CLOCK, wallClockMs.coerceAtLeast(1L))
            .putInt(KEY_HEARTBEAT_FAILURES, 0)
            .apply()
    }

    /** The last error is retained after recovery: diagnostics must still show why a retry happened. */
    fun recordHeartbeatFailure(consecutiveFailures: Int, error: String) {
        prefs.edit()
            .putInt(KEY_HEARTBEAT_FAILURES, consecutiveFailures.coerceAtLeast(0))
            .putString(KEY_HEARTBEAT_ERROR, error.take(180))
            .apply()
    }

    /** Only an off→on transition clears the evidence that decides "never connected since enable". */
    fun resetHeartbeatDiagnostics() {
        prefs.edit()
            .remove(KEY_HEARTBEAT_SUCCESS_AT)
            .remove(KEY_HEARTBEAT_WALL_CLOCK)
            .remove(KEY_HEARTBEAT_FAILURES)
            .remove(KEY_HEARTBEAT_ERROR)
            .remove(KEY_DOORBELL_STATE)
            .remove(KEY_DOORBELL_BACKOFF_MS)
            .remove(KEY_DOORBELL_LAST_WAKE)
            .apply()
    }

    /**
     * S20 D4 doorbell display state. This is diagnostics only: it is never read back as policy and it
     * never participates in the connection hysteresis.
     */
    internal val commandDoorbellState: CommandDoorbellDisplayState
        get() = runCatching {
            CommandDoorbellDisplayState.valueOf(
                prefs.getString(KEY_DOORBELL_STATE, null) ?: CommandDoorbellDisplayState.DISABLED.name,
            )
        }.getOrDefault(CommandDoorbellDisplayState.DISABLED)

    val commandDoorbellBackoffMs: Long
        get() = prefs.getLong(KEY_DOORBELL_BACKOFF_MS, 0L).coerceAtLeast(0L)

    /** Wall clock of the last `wake=true`, for display only. */
    val commandDoorbellLastWakeMs: Long?
        get() = prefs.getLong(KEY_DOORBELL_LAST_WAKE, 0L).takeIf { it > 0L }

    /** Writes only on a real change, so a steady hold cannot recompose the screen every round. */
    internal fun publishCommandDoorbell(
        state: CommandDoorbellDisplayState,
        backoffMs: Long = 0L,
        lastWakeWallClockMs: Long? = null,
    ) {
        val editor = prefs.edit()
        var changed = false
        if (commandDoorbellState != state) {
            editor.putString(KEY_DOORBELL_STATE, state.name); changed = true
        }
        val bounded = backoffMs.coerceAtLeast(0L)
        if (commandDoorbellBackoffMs != bounded) {
            editor.putLong(KEY_DOORBELL_BACKOFF_MS, bounded); changed = true
        }
        if (lastWakeWallClockMs != null && commandDoorbellLastWakeMs != lastWakeWallClockMs) {
            editor.putLong(KEY_DOORBELL_LAST_WAKE, lastWakeWallClockMs.coerceAtLeast(1L)); changed = true
        }
        if (changed) editor.apply()
    }

    var reportedSequence: Long
        get() = prefs.getLong(KEY_REPORTED_SEQUENCE, 0L)
        set(value) { prefs.edit().putLong(KEY_REPORTED_SEQUENCE, value).commit() }

    var deviceEpoch: Long
        get() = prefs.getLong(KEY_DEVICE_EPOCH, 0L)
        set(value) { prefs.edit().putLong(KEY_DEVICE_EPOCH, value).commit() }

    val gatewayId: String?
        get() = prefs.getString(KEY_GATEWAY_ID, null)?.takeIf(String::isNotBlank)

    @Synchronized fun activatePairingIdentity(gatewayId: String, deviceEpoch: Long, credential: String) {
        require(gatewayId.isNotBlank() && gatewayId.length <= 256)
        require(deviceEpoch > 0)
        require(credential.isNotBlank())
        check(prefs.edit()
            .putString(KEY_GATEWAY_ID, gatewayId)
            .putLong(KEY_DEVICE_EPOCH, deviceEpoch)
            .putString(KEY_CREDENTIAL_FINGERPRINT, gatewayIdentitySha256(credential))
            .putLong(KEY_REPORTED_SEQUENCE, 0L)
            .remove(KEY_TELECOM_SNAPSHOT_SEQUENCE)
            .commit()) { "gateway pairing identity commit failed" }
    }

    @Synchronized fun clearPairingIdentity() {
        check(prefs.edit()
            .remove(KEY_GATEWAY_ID)
            .remove(KEY_CREDENTIAL_FINGERPRINT)
            .putLong(KEY_DEVICE_EPOCH, 0L)
            .putLong(KEY_REPORTED_SEQUENCE, 0L)
            .remove(KEY_TELECOM_SNAPSHOT_SEQUENCE)
            .commit()) { "gateway pairing identity clear failed" }
    }

    fun commandIdentity(credential: String?): GatewayCommandIdentity? {
        val token = credential?.takeIf(String::isNotBlank) ?: return null
        val epoch = deviceEpoch.takeIf { it > 0 } ?: return null
        val fingerprint = gatewayIdentitySha256(token)
        return GatewayCommandIdentity(gatewayId ?: "legacy-credential-$fingerprint", epoch, fingerprint)
    }

    @Synchronized fun confirmServerIdentity(
        serverGatewayId: String,
        serverEpoch: Long,
        credential: String,
    ): GatewayCommandIdentity {
        require(serverGatewayId.isNotBlank() && serverGatewayId.length <= 256)
        check(serverEpoch > 0 && deviceEpoch == serverEpoch) { "gateway epoch mismatch" }
        gatewayId?.let { check(it == serverGatewayId) { "gateway identity mismatch" } }
        val fingerprint = gatewayIdentitySha256(credential)
        if (gatewayId == null || credentialFingerprint != fingerprint) {
            check(prefs.edit()
                .putString(KEY_GATEWAY_ID, serverGatewayId)
                .putString(KEY_CREDENTIAL_FINGERPRINT, fingerprint)
                .commit()) {
                "gateway identity migration failed"
            }
        }
        return GatewayCommandIdentity(serverGatewayId, serverEpoch, fingerprint)
    }

    /** Applies an audited replay migration receipt while preserving the credential and gateway binding. */
    @Synchronized fun applyReplayMigration(
        serverGatewayId: String,
        fromGeneration: Long,
        toGeneration: Long,
        credential: String,
    ): GatewayCommandIdentity {
        require(toGeneration == fromGeneration + 1)
        val fingerprint = gatewayIdentitySha256(credential)
        check(gatewayId == serverGatewayId && credentialFingerprint == fingerprint) {
            "replay migration identity mismatch"
        }
        val current = deviceEpoch
        check(current == fromGeneration || current == toGeneration) { "replay migration epoch mismatch" }
        if (current == fromGeneration) {
            check(prefs.edit().putLong(KEY_DEVICE_EPOCH, toGeneration)
                .putLong(KEY_REPORTED_SEQUENCE, 0L)
                .remove(KEY_TELECOM_SNAPSHOT_SEQUENCE)
                .commit()) { "replay migration runtime commit failed" }
        }
        return GatewayCommandIdentity(serverGatewayId, toGeneration, fingerprint)
    }

    fun activeCommandIdentity(): GatewayCommandIdentity? {
        val id = gatewayId ?: return null
        val epoch = deviceEpoch.takeIf { it > 0 } ?: return null
        val fingerprint = credentialFingerprint ?: return null
        return runCatching { GatewayCommandIdentity(id, epoch, fingerprint) }.getOrNull()
    }

    private val credentialFingerprint: String?
        get() = prefs.getString(KEY_CREDENTIAL_FINGERPRINT, null)?.takeIf(String::isNotBlank)

    @Synchronized fun nextTelecomSnapshotSequence(): Long {
        val next = prefs.getLong(KEY_TELECOM_SNAPSHOT_SEQUENCE, 0L) + 1L
        check(prefs.edit().putLong(KEY_TELECOM_SNAPSHOT_SEQUENCE, next).commit()) {
            "snapshot sequence commit failed"
        }
        return next
    }

    fun resetTelecomSnapshotSequence() {
        prefs.edit().remove(KEY_TELECOM_SNAPSHOT_SEQUENCE).commit()
    }

    fun register(listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener) =
        prefs.registerOnSharedPreferenceChangeListener(listener)

    fun unregister(listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener) =
        prefs.unregisterOnSharedPreferenceChangeListener(listener)

    companion object {
        private const val NAME = "gateway_runtime"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_CONNECTION = "connection"
        private const val KEY_CONNECTION_DETAIL = "connection_detail"
        private const val KEY_REPORTED_SEQUENCE = "reported_sequence"
        private const val KEY_DEVICE_EPOCH = "device_epoch"
        private const val KEY_GATEWAY_ID = "gateway_id"
        private const val KEY_CREDENTIAL_FINGERPRINT = "credential_fingerprint"
        private const val KEY_TELECOM_SNAPSHOT_SEQUENCE = "telecom_snapshot_sequence"
        private const val KEY_INSTALL_ID = "diag_install_id"
        const val KEY_HEARTBEAT_SUCCESS_AT = "last_heartbeat_success_at_ms"
        const val KEY_HEARTBEAT_WALL_CLOCK = "last_heartbeat_wall_clock_ms"
        const val KEY_HEARTBEAT_FAILURES = "consecutive_heartbeat_failures"
        const val KEY_HEARTBEAT_ERROR = "last_heartbeat_error"
        const val KEY_DOORBELL_STATE = "command_doorbell_state"
        const val KEY_DOORBELL_BACKOFF_MS = "command_doorbell_backoff_ms"
        const val KEY_DOORBELL_LAST_WAKE = "command_doorbell_last_wake_wall_clock_ms"
        const val KEY_ALLOW_REMOTE_POWER = "allow_remote_power"
        const val KEY_POWER_RESULT = "pending_power_result"
        const val KEY_STANDBY_STATE = "standby_state"
        const val KEY_STANDBY_BACKOFF_MS = "standby_backoff_ms"
        private const val KEY_EARLY_MEDIA = "early_media"
        private const val MAX_POWER_RESULT_LENGTH = 400

        /**
         * Keys the Activity renders; every other write must not recompose the screen.
         *
         * S20 added `reported_sequence` and the three doorbell keys. Both are cheap: the reported
         * sequence is committed only when a command actually executes, and the doorbell publishes
         * only on a real state change, so neither approaches the 2 s heartbeat cadence that made
         * the unfiltered listener expensive in the first place.
         *
         * S21 added the remote power switch and the standby beacon's display state. The switch only
         * changes when the user taps it, and the beacon publishes at most once per 20 s hold.
         */
        val DISPLAYED_KEYS = setOf(
            KEY_ENABLED, KEY_CONNECTION, KEY_CONNECTION_DETAIL, KEY_DEVICE_EPOCH, KEY_GATEWAY_ID,
            KEY_HEARTBEAT_SUCCESS_AT, KEY_HEARTBEAT_WALL_CLOCK, KEY_HEARTBEAT_FAILURES, KEY_HEARTBEAT_ERROR,
            KEY_REPORTED_SEQUENCE, KEY_DOORBELL_STATE, KEY_DOORBELL_BACKOFF_MS, KEY_DOORBELL_LAST_WAKE,
            KEY_ALLOW_REMOTE_POWER, KEY_POWER_RESULT, KEY_STANDBY_STATE, KEY_STANDBY_BACKOFF_MS,
        )
    }
}

internal fun gatewayIdentityPreferenceName(base: String, identity: GatewayCommandIdentity): String {
    require(base.matches(Regex("^[a-z0-9_]{1,80}$")))
    return "${base}_${identity.storageSuffix}"
}

private fun gatewayIdentitySha256(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
