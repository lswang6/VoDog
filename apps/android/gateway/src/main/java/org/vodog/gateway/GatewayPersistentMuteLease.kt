package org.vodog.gateway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.telecom.TelecomManager
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicInteger

enum class MuteLeasePhase { IDLE, REQUESTING_MUTE, MUTED, RESTORING, RESTORE_BLOCKED }
data class MuteLeaseRecord(
    val phase: MuteLeasePhase,
    val leaseId: String?,
    val deviceCallId: String?,
    val creationTimeMillis: Long?,
    val originalMuted: Boolean?,
)

internal fun muteStateAfterAudioCallback(record: MuteLeaseRecord, muted: Boolean): MuteLeaseRecord = when {
    record.phase == MuteLeasePhase.REQUESTING_MUTE && muted -> record.copy(phase = MuteLeasePhase.MUTED)
    record.phase == MuteLeasePhase.RESTORING && muted == record.originalMuted -> MuteLeaseRecord(
        MuteLeasePhase.IDLE, null, null, null, null,
    )
    else -> record
}

/**
 * S94 本机接入: the owner unmuted the exact armed, ACTIVE call while the gateway lease held it MUTED.
 * REQUESTING_MUTE / RESTORING callbacks are the gateway's own setMuted and never qualify.
 */
internal fun isOwnerLocalJoin(
    before: MuteLeaseRecord,
    muted: Boolean,
    holderDeviceCallId: String,
    holderCreationTimeMillis: Long,
    holderArmed: Boolean,
    callActive: Boolean,
    // Answering a call-waiting call makes Telecom unmute; only a lone call can be an owner join.
    otherLiveCall: Boolean = false,
): Boolean = before.phase == MuteLeasePhase.MUTED && !muted && holderArmed && callActive && !otherLiveCall &&
    before.deviceCallId != null && before.creationTimeMillis != null &&
    sameCallIdentity(before.deviceCallId, before.creationTimeMillis, holderDeviceCallId, holderCreationTimeMillis)

internal fun sameMuteLease(first: MuteLeaseRecord, second: MuteLeaseRecord): Boolean =
    first.leaseId != null && first.leaseId == second.leaseId &&
        first.deviceCallId == second.deviceCallId && first.creationTimeMillis == second.creationTimeMillis

internal class PostedMutationFence {
    private val phase = AtomicInteger(PENDING)
    fun tryStart(): Boolean = phase.compareAndSet(PENDING, RUNNING)
    fun cancelBeforeStart(): Boolean = phase.compareAndSet(PENDING, CANCELLED)
    fun finish() { check(phase.compareAndSet(RUNNING, DONE)) }
    fun isDone(): Boolean = phase.get() == DONE
    private companion object {
        const val PENDING = 0
        const val RUNNING = 1
        const val CANCELLED = 2
        const val DONE = 3
    }
}

class MuteLeaseStore(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_mute_lease", Context.MODE_PRIVATE)
    fun read(): MuteLeaseRecord = synchronized(LOCK) {
        val raw = prefs.getString("record", null) ?: return@synchronized emptyMuteLease()
        try {
            val json = JSONObject(raw)
            MuteLeaseRecord(MuteLeasePhase.valueOf(json.getString("phase")), nullable(json, "leaseId"),
                nullable(json, "deviceCallId"), if (json.isNull("creationTimeMillis")) null else json.getLong("creationTimeMillis"),
                if (json.isNull("originalMuted")) null else json.getBoolean("originalMuted"))
        } catch (_: Exception) { throw IllegalStateException("mute lease journal is unreadable") }
    }
    fun write(record: MuteLeaseRecord) = synchronized(LOCK) {
        val json = JSONObject().put("phase", record.phase.name).put("leaseId", record.leaseId ?: JSONObject.NULL)
            .put("deviceCallId", record.deviceCallId ?: JSONObject.NULL)
            .put("creationTimeMillis", record.creationTimeMillis ?: JSONObject.NULL)
            .put("originalMuted", record.originalMuted ?: JSONObject.NULL)
        check(prefs.edit().putString("record", json.toString()).commit()) { "mute lease commit failed" }
    }
    fun clear() = write(emptyMuteLease())
    private fun nullable(json: JSONObject, key: String) = if (json.isNull(key)) null else json.getString(key)
    private companion object { val LOCK = Any() }
}

private fun emptyMuteLease() = MuteLeaseRecord(MuteLeasePhase.IDLE, null, null, null, null)

/** Narrow same-process bridge. It exposes no arbitrary Telecom or component operation. */
internal object GatewayInCallAudioBridge {
    private val service = AtomicReference<WeakReference<GatewayInCallService>?>(null)
    fun attach(value: GatewayInCallService) { service.set(WeakReference(value)) }
    fun detach(value: GatewayInCallService) {
        if (service.get()?.get() === value) service.set(null)
    }
    /**
     * Main thread. S94: an owner join only sets the session atomic, clears the lease to IDLE (the
     * owner manages mute from now on) and posts the IO work; it never takes the session setupLock.
     */
    fun onAudioState(context: Context, muted: Boolean) {
        runCatching {
            val store = MuteLeaseStore(context)
            val before = store.read()
            val holder = GatewayActiveAudioSession.current()
            if (holder != null && isOwnerLocalJoin(before, muted, holder.deviceCallId, holder.creationTimeMillis,
                    holder.armed.get(), GatewayTelecomCallRegistry.snapshot(holder.deviceCallId)?.state == ActualTelecomState.ACTIVE)) {
                val otherLiveCall = hasUnrelatedLiveCall(GatewayTelecomCallRegistry.snapshots(), holder.deviceCallId)
                if (holder.answeredByAi && !otherLiveCall) {
                    holder.session.markOwnerLocal()
                    // The IO work goes first: a failing lease write must not strand the takeover.
                    GatewayOwnerLocalJoin.enter(context, holder)
                    runCatching { store.clear() }
                    return@runCatching
                }
                // S94 决策 4: a human-bridged call keeps injecting; only the observation is recorded. So does
                // an unmute while a second call is live (Telecom unmutes when call waiting is answered).
                GatewayDiag.log("call.owner_unmuted_local", mapOf("otherLiveCall" to otherLiveCall), callId = holder.serverCallId)
            }
            val after = muteStateAfterAudioCallback(before, muted)
            if (after != before) store.write(after)
        }
    }
    fun refreshRecordingForeground(): Boolean = onMain {
        service.get()?.get()?.refreshRecordingForeground() == true
    }
    fun requestMute(deviceCallId: String, creationTimeMillis: Long): Boolean = onMain {
        service.get()?.get()?.requestGatewayMute(deviceCallId, creationTimeMillis) == true
    }
    fun requestRestore(record: MuteLeaseRecord): Boolean = onMain {
        service.get()?.get()?.restoreGatewayMute(record) == true
    }
    private fun onMain(block: () -> Boolean): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val result = AtomicReference(false); val done = CountDownLatch(1); val fence = PostedMutationFence()
        val handler = Handler(Looper.getMainLooper())
        val runnable = Runnable {
            if (!fence.tryStart()) { done.countDown(); return@Runnable }
            try { result.set(runCatching(block).getOrDefault(false)) } finally {
                fence.finish(); done.countDown()
            }
        }
        val posted = handler.post(runnable)
        if (!posted) return false
        if (!done.await(1, TimeUnit.SECONDS)) {
            if (fence.cancelBeforeStart()) {
                handler.removeCallbacks(runnable)
                return false
            }
            // The runnable already started. Wait for that short Telecom operation so it cannot
            // mutate after this caller has treated the request as cancelled.
            done.await()
        }
        return fence.isDone() && result.get()
    }
}

class PersistentGatewayMuteLease(
    private val context: Context,
    private val deviceCallId: String,
    private val creationTimeMillis: Long,
) : GatewayMuteLease {
    private val store = MuteLeaseStore(context)
    override fun acquireAndMute(): Boolean {
        if (!GatewayInCallAudioBridge.requestMute(deviceCallId, creationTimeMillis)) return false
        return waitFor { it.phase == MuteLeasePhase.MUTED && it.deviceCallId == deviceCallId }
    }
    override fun restoreOriginalState(): Boolean = restorePersistedMuteLease(context, deviceCallId, creationTimeMillis)
    private fun waitFor(predicate: (MuteLeaseRecord) -> Boolean): Boolean {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
        do {
            if (predicate(store.read())) return true
            Thread.sleep(10)
        } while (System.nanoTime() < deadline)
        return false
    }
}

fun restorePersistedMuteLease(
    context: Context,
    expectedDeviceCallId: String? = null,
    expectedCreationTimeMillis: Long? = null,
): Boolean {
    require((expectedDeviceCallId == null) == (expectedCreationTimeMillis == null))
    val store = MuteLeaseStore(context); val record = store.read()
    if (record.phase == MuteLeasePhase.IDLE) return true
    if (expectedDeviceCallId != null &&
        (record.deviceCallId != expectedDeviceCallId || record.creationTimeMillis != expectedCreationTimeMillis)) return true
    if (GatewayInCallAudioBridge.requestRestore(record)) {
        // InCallService lifecycle methods run on main. Waiting there would prevent the audio-state
        // callback that commits restoration and can deadlock process recovery.
        if (Looper.myLooper() == Looper.getMainLooper()) return true
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
        while (System.nanoTime() < deadline) {
            if (store.read().phase == MuteLeasePhase.IDLE) return true
            Thread.sleep(10)
        }
    }
    val noCall = runCatching {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) !=
            PackageManager.PERMISSION_GRANTED) return@runCatching false
        !context.getSystemService(TelecomManager::class.java).isInCall
    }.getOrDefault(false)
    return if (noCall) { store.clear(); true } else {
        store.write(record.copy(phase = MuteLeasePhase.RESTORE_BLOCKED)); false
    }
}
