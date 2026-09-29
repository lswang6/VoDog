package org.vodog.gateway

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

enum class AudioHandoffPhase { IDLE, ACQUIRING, ACQUIRED, RESTORING, RESTORE_FAILED }

data class SavedComponentState(val key: String, val enabledState: Int)
data class AudioHandoffRecord(
    val phase: AudioHandoffPhase,
    val originals: List<SavedComponentState>,
    val failureCode: String? = null,
)

sealed interface AudioHandoffResult {
    data object Acquired : AudioHandoffResult
    data object Restored : AudioHandoffResult
    data class Failed(val code: String) : AudioHandoffResult
}

interface AudioHandoffJournal {
    fun read(): AudioHandoffRecord
    fun write(record: AudioHandoffRecord)
}

interface LegacyComponentBackend {
    fun canChangeComponents(): Boolean
    /** Null means the optional component is not installed; DEFAULT is a real saved state. */
    fun currentState(key: String): Int?
    fun setState(key: String, state: Int)
}

/**
 * Cleanup is owned by the gateway audio session, not by this component switcher. An implementation
 * must remember the user's pre-session mute state and restore that exact state after stopping audio.
 */
interface GatewayAudioSessionCleanup {
    fun stopAndRelease(): Boolean
    fun restorePreSessionMuteState(): Boolean
}

/**
 * Reversible ownership handoff for the two audited legacy InCallServices only. It never accepts a
 * package/component from remote input and never invokes shell or su.
 */
class LegacyAudioOwnerHandoff(
    private val journal: AudioHandoffJournal,
    private val components: LegacyComponentBackend,
    private val cleanup: GatewayAudioSessionCleanup,
    private val noActiveSystemCall: () -> Boolean,
) {
    fun acquire(): AudioHandoffResult = synchronized(LOCK) {
        if (!components.canChangeComponents()) return@synchronized fail("component_permission_missing")
        // Disabling a bound InCallService with DONT_KILL_APP does not prove the live service stopped.
        if (!noActiveSystemCall()) return@synchronized fail("active_call_blocks_handoff")
        val prior = journal.read()
        if (prior.phase != AudioHandoffPhase.IDLE) {
            val recovered = restore(prior)
            if (recovered !is AudioHandoffResult.Restored) return@synchronized recovered
        }
        val originals = LEGACY_KEYS.mapNotNull { key ->
            components.currentState(key)?.let { SavedComponentState(key, it) }
        }
        val acquiring = AudioHandoffRecord(AudioHandoffPhase.ACQUIRING, originals)
        journal.write(acquiring)
        try {
            originals.forEach { (key, _) ->
                components.setState(key, PackageManager.COMPONENT_ENABLED_STATE_DISABLED)
                check(components.currentState(key) == PackageManager.COMPONENT_ENABLED_STATE_DISABLED) {
                    "component_disable_not_observed"
                }
            }
            // Recheck after mutation closes the window where a call began during the handoff.
            if (!noActiveSystemCall()) error("active_call_during_handoff")
            journal.write(AudioHandoffRecord(AudioHandoffPhase.ACQUIRED, originals))
            AudioHandoffResult.Acquired
        } catch (error: Exception) {
            restore(acquiring, finiteCode(error, "component_disable_failed"))
        }
    }

    fun release(): AudioHandoffResult = synchronized(LOCK) { restore(journal.read()) }

    /** ACQUIRED is never trusted after process restart because the prior audio-session identity died. */
    fun recoverAfterProcessStart(): AudioHandoffResult = synchronized(LOCK) {
        val record = journal.read()
        if (record.phase == AudioHandoffPhase.IDLE) AudioHandoffResult.Restored else restore(record)
    }

    private fun restore(record: AudioHandoffRecord, initialFailure: String? = null): AudioHandoffResult {
        if (record.phase == AudioHandoffPhase.IDLE) return AudioHandoffResult.Restored
        val failures = mutableListOf<String>()
        runCatching { journal.write(record.copy(phase = AudioHandoffPhase.RESTORING, failureCode = initialFailure)) }
            .onFailure { failures += "journal_write_failed" }
        val audioStopped = runCatching { cleanup.stopAndRelease() }
            .getOrElse { failures += "audio_stop_exception"; false }
        if (!audioStopped && "audio_stop_exception" !in failures) failures += "audio_stop_failed"
        val muteRestored = runCatching { cleanup.restorePreSessionMuteState() }
            .getOrElse { failures += "mute_restore_exception"; false }
        if (!muteRestored && "mute_restore_exception" !in failures) failures += "mute_restore_failed"
        // Only restore components this record actually acquired, including legacy BCR records.
        // An absent optional BCP produces an empty snapshot, not a fabricated DEFAULT state.
        record.originals.distinctBy(SavedComponentState::key).asReversed().forEach { original ->
            val key = original.key
            try {
                components.setState(key, original.enabledState)
                if (components.currentState(key) != original.enabledState) failures += "component_restore_not_observed"
            } catch (_: Exception) {
                failures += "component_restore_failed"
            }
        }
        return if (failures.isEmpty()) {
            val committed = runCatching { journal.write(AudioHandoffRecord(AudioHandoffPhase.IDLE, emptyList())) }.isSuccess
            if (!committed) AudioHandoffResult.Failed("journal_write_failed")
            else if (initialFailure == null) AudioHandoffResult.Restored else AudioHandoffResult.Failed(initialFailure)
        } else {
            var code = (failures + listOfNotNull(initialFailure)).distinct().sorted().joinToString("+")
            if (runCatching { journal.write(record.copy(phase = AudioHandoffPhase.RESTORE_FAILED, failureCode = code)) }.isFailure) {
                code = (code.split("+") + "journal_write_failed").distinct().sorted().joinToString("+")
            }
            AudioHandoffResult.Failed(code)
        }
    }

    private fun fail(code: String): AudioHandoffResult.Failed = AudioHandoffResult.Failed(code)
    private fun finiteCode(error: Exception, fallback: String): String = when (error.message) {
        "active_call_during_handoff" -> "active_call_during_handoff"
        "component_disable_not_observed" -> "component_disable_not_observed"
        else -> fallback
    }

    companion object {
        const val BCP = "bcp"
        const val BCR = "bcr"
        // S41 §决策1: BCR records in parallel with the gateway, so only BCP - which injects audio into
        // the call - is still taken over. BCR keeps its component mapping for restoring old records.
        val LEGACY_KEYS = listOf(BCP)
        private val LOCK = Any()
    }
}

class AndroidLegacyComponentBackend(private val context: Context) : LegacyComponentBackend {
    private val packageManager = context.packageManager

    override fun canChangeComponents(): Boolean = ContextCompat.checkSelfPermission(
        context, Manifest.permission.CHANGE_COMPONENT_ENABLED_STATE,
    ) == PackageManager.PERMISSION_GRANTED

    override fun currentState(key: String): Int? {
        val target = component(key)
        try {
            // Include disabled services: their exact enabled state still needs restoring.
            packageManager.getServiceInfo(target, PackageManager.MATCH_DISABLED_COMPONENTS or
                PackageManager.MATCH_DIRECT_BOOT_AWARE or PackageManager.MATCH_DIRECT_BOOT_UNAWARE)
        } catch (_: PackageManager.NameNotFoundException) {
            return null
        }
        return packageManager.getComponentEnabledSetting(target)
    }

    override fun setState(key: String, state: Int) {
        require(state in VALID_STATES) { "invalid saved component state" }
        packageManager.setComponentEnabledSetting(component(key), state, PackageManager.DONT_KILL_APP)
    }

    private fun component(key: String): ComponentName = when (key) {
        LegacyAudioOwnerHandoff.BCP -> ComponentName(
            "com.chiller3.bcp", "com.chiller3.bcp.PlayerInCallService",
        )
        LegacyAudioOwnerHandoff.BCR -> ComponentName(
            "com.chiller3.bcr", "com.chiller3.bcr.RecorderInCallService",
        )
        else -> error("unsupported legacy component")
    }

    private companion object {
        val VALID_STATES = setOf(
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT,
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED,
        )
    }
}

class DeviceProtectedAudioHandoffJournal(context: Context) : AudioHandoffJournal {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_audio_owner_handoff", Context.MODE_PRIVATE)

    override fun read(): AudioHandoffRecord = synchronized(LOCK) {
        val raw = prefs.getString("record", null) ?: return@synchronized AudioHandoffRecord(
            AudioHandoffPhase.IDLE, emptyList(),
        )
        try {
            val json = JSONObject(raw)
            val states = json.getJSONArray("originals")
            AudioHandoffRecord(
                AudioHandoffPhase.valueOf(json.getString("phase")),
                List(states.length()) { index -> states.getJSONObject(index).let {
                    SavedComponentState(it.getString("key"), it.getInt("enabledState"))
                } },
                if (json.isNull("failureCode")) null else json.getString("failureCode"),
            )
        } catch (_: Exception) {
            throw IllegalStateException("audio handoff journal is unreadable")
        }
    }

    override fun write(record: AudioHandoffRecord) = synchronized(LOCK) {
        val states = JSONArray(); record.originals.forEach {
            states.put(JSONObject().put("key", it.key).put("enabledState", it.enabledState))
        }
        val json = JSONObject().put("phase", record.phase.name).put("originals", states)
            .put("failureCode", record.failureCode ?: JSONObject.NULL)
        check(prefs.edit().putString("record", json.toString()).commit()) { "audio handoff journal commit failed" }
    }

    private companion object { val LOCK = Any() }
}
