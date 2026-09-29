/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Lifecycle shape informed by Basic Call Player's PlayerInCallService.
 * VoDog starts no audio from this service; it owns the visible microphone foreground lifetime.
 */
package org.vodog.gateway

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import android.telecom.Call
import android.telecom.InCallService
import android.telecom.CallAudioState
import android.telecom.VideoProfile
import android.content.Intent
import androidx.core.content.ContextCompat

class GatewayInCallService : InCallService() {
    private val callbacks = mutableMapOf<Call, Call.Callback>()
    private var recordingForeground = false

    override fun onCreate() {
        super.onCreate()
        GatewayInCallAudioBridge.attach(this)
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        val journal = DeviceCallJournal(this)
        val deviceCallId = journal.observeAdded(
            call.details.accountHandle?.stableString()?.let(IccidFingerprint()::derivePhoneAccount),
            call.details.creationTimeMillis.takeIf { it > 0 },
            call.deviceDirection(),
            call.deviceState(),
            call.remoteNumber(),
            GatewayTelecomCallRegistry.deviceCallIds(),
        )
        val callback = object : Call.Callback() {
            override fun onStateChanged(call: Call, state: Int) {
                GatewayTelecomCallRegistry.stateChanged(call)
                // S36 C3: the disconnect cause is read nowhere else, and it is the one field that says why.
                val cause = call.details.disconnectCause?.takeIf { state == Call.STATE_DISCONNECTED }
                // Rows without the server call id cannot be joined to the call; incoming calls get it later (telephony.bound).
                val serverCallId = runCatching { journal.find(deviceCallId)?.serverCallId }.getOrNull()
                GatewayDiag.log("telephony.state", mapOf("deviceCallId" to deviceCallId, "state" to call.deviceState().name, "causeCode" to cause?.code, "causeLabel" to cause?.label?.toString(), "causeReason" to cause?.reason), callId = serverCallId)
                if (call.deviceState() == DeviceCallState.ENDED) {
                    // S38 §4: the passive capture has no session holder to stop it; this is its end.
                    GatewayPassiveCallRecorder.requestStop(deviceCallId)
                    val stopped = GatewayActiveAudioSession.requestEndpointIngressStop(
                        deviceCallId, call.details.creationTimeMillis,
                    )
                    restoreMuteLeaseLogged(deviceCallId, call.details.creationTimeMillis)
                    if (stopped) GatewayAudioLifecycleCleanup.schedule(this@GatewayInCallService, "ended")
                }
                DeviceCallJournal(this@GatewayInCallService).updateObservation(
                    deviceCallId,
                    call.details.accountHandle?.stableString()?.let(IccidFingerprint()::derivePhoneAccount),
                    call.details.creationTimeMillis.takeIf { it > 0 },
                    call.deviceDirection(),
                    call.deviceState(),
                    call.remoteNumber(),
                )
                wakeGatewayIfEnabled()
            }
        }
        callbacks[call] = callback
        GatewayTelecomCallRegistry.add(call, deviceCallId)
        call.registerCallback(callback)
        val runtime = GatewayRuntimeStore(this)
        val binding = GatewaySimBindingStore(this).byPhoneAccount(
            call.details.accountHandle?.stableString()?.let(IccidFingerprint()::derivePhoneAccount),
        )
        val listed = binding != null && GatewayNumberBlocklistStore(this).isCallListed(
            binding.simId, call.remoteNumber(), binding.countryIso,
        )
        if (shouldRejectIncomingRinging(runtime.enabled, call.deviceState(), listed)) {
            // S21 §B "拦截即记录". The durable one-shot interception report is persisted before the
            // reject and never throws, so the reject always happens.
            enqueueBlockedCallInterception(
                this, deviceCallId, binding?.simId, runtime.deviceEpoch, call.remoteNumber(),
            )
            journal.suppressIncomingReport(deviceCallId)
            rejectDeclined(call, deviceCallId, "blocked")
        }
        wakeGatewayIfEnabled()
        // Reject of listed RINGING is the only InCallService Telecom mutation.
    }

    override fun onCallRemoved(call: Call) {
        val deviceCallId = GatewayTelecomCallRegistry.id(call)
        deviceCallId?.let(GatewayPassiveCallRecorder::requestStop)
        val stopped = deviceCallId != null && GatewayActiveAudioSession.requestEndpointIngressStop(
            deviceCallId, call.details.creationTimeMillis,
        )
        if (deviceCallId != null) restoreMuteLeaseLogged(deviceCallId, call.details.creationTimeMillis)
        if (stopped) GatewayAudioLifecycleCleanup.schedule(this, "ended")
        callbacks.remove(call)?.let(call::unregisterCallback)
        GatewayTelecomCallRegistry.remove(call)
        if (deviceCallId != null) DeviceCallJournal(this).markEnded(deviceCallId)
        wakeGatewayIfEnabled()
        super.onCallRemoved(call)
    }

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        recordingForeground = false
        val stopped = GatewayActiveAudioSession.current()?.let {
            GatewayActiveAudioSession.requestEndpointIngressStop(it.deviceCallId, it.creationTimeMillis)
        } == true
        restoreMuteLeaseLogged(null, null)
        if (stopped) GatewayAudioLifecycleCleanup.schedule(this, "incomplete")
        GatewayInCallAudioBridge.detach(this)
        callbacks.forEach { (call, callback) -> runCatching { call.unregisterCallback(callback) } }
        callbacks.clear()
        GatewayTelecomCallRegistry.clear()
        // Losing this service used to leave live journal records behind forever, so the server could never learn the
        // call was gone. When Telecom reports no call at all, every older unbound record is provably absent.
        runCatching { reconcileProvablyAbsentCalls() }
        super.onDestroy()
    }

    private fun reconcileProvablyAbsentCalls() {
        val telecom = getSystemService(android.telecom.TelecomManager::class.java) ?: return
        // Telecom is the authority here: isInCall == false means no call exists at all, so the registry we just
        // cleared cannot hold anything live and every older record is provably absent.
        if (telecom.isInCall) return
        DeviceCallJournal(this).markProvablyAbsentRecordsEnded(emptySet())
    }

    override fun onCallAudioStateChanged(audioState: CallAudioState) {
        super.onCallAudioStateChanged(audioState)
        GatewayInCallAudioBridge.onAudioState(this, audioState.isMuted)
        // Carrier video ringback flips the call to a video state and Telecom auto-routes to speaker; the gateway never wants speaker.
        val videoStates = calls.map { it.details.videoState }
        if (shouldRevertVideoSpeaker(audioState.route, videoStates)) {
            GatewayDiag.log("audio_route.video_speaker_reverted", mapOf("videoStates" to videoStates))
            @Suppress("DEPRECATION")
            setAudioRoute(CallAudioState.ROUTE_WIRED_OR_EARPIECE)
        }
    }

    internal fun requestGatewayMute(deviceCallId: String, creationTimeMillis: Long): Boolean {
        val call = GatewayTelecomCallRegistry.call(deviceCallId) ?: return false
        if (call.deviceState() != DeviceCallState.ACTIVE || call.details.creationTimeMillis != creationTimeMillis) return false
        if (hasUnrelatedLiveCall(GatewayTelecomCallRegistry.snapshots(), deviceCallId)) return false
        val original = callAudioState?.isMuted ?: return false
        val store = MuteLeaseStore(this)
        val existing = store.read()
        if (existing.phase != MuteLeasePhase.IDLE) {
            return existing.deviceCallId == deviceCallId && existing.creationTimeMillis == creationTimeMillis &&
                existing.phase == MuteLeasePhase.MUTED
        }
        val record = MuteLeaseRecord(MuteLeasePhase.REQUESTING_MUTE, java.util.UUID.randomUUID().toString(),
            deviceCallId, creationTimeMillis, original)
        store.write(record)
        if (original) store.write(record.copy(phase = MuteLeasePhase.MUTED)) else setMuted(true)
        return true
    }

    internal fun restoreGatewayMute(record: MuteLeaseRecord): Boolean {
        val deviceCallId = record.deviceCallId ?: return false
        val call = GatewayTelecomCallRegistry.call(deviceCallId) ?: return false
        if (call.details.creationTimeMillis != record.creationTimeMillis) return false
        val original = record.originalMuted ?: return false
        val store = MuteLeaseStore(this)
        val current = store.read()
        if (!sameMuteLease(current, record)) return false
        if (hasUnrelatedLiveCall(GatewayTelecomCallRegistry.snapshots(), deviceCallId)) return false
        val restoring = current.copy(phase = MuteLeasePhase.RESTORING)
        store.write(restoring)
        if (!sameMuteLease(store.read(), restoring)) return false
        if (callAudioState?.isMuted == original) store.clear() else setMuted(original)
        return true
    }

    /** Telecom-bound InCallService is eligible for microphone FGS, unlike the control heartbeat. */
    internal fun refreshRecordingForeground(): Boolean {
        val runtime = GatewayRuntimeStore(this)
        val needed = runtime.enabled && callbacks.keys.any {
            recordingForegroundNeeded(it.state, it.deviceDirection() == DeviceCallDirection.OUTGOING, runtime.earlyMedia)
        }
        if (!needed) {
            if (recordingForeground) stopForeground(STOP_FOREGROUND_REMOVE)
            recordingForeground = false
            return false
        }
        if (recordingForeground) return true
        return runCatching {
            val channel = "gateway_call_recording"
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(channel, "通话录音", NotificationManager.IMPORTANCE_LOW),
            )
            val notification = NotificationCompat.Builder(this, channel)
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setContentTitle("VoDog 通话录音")
                .setContentText("正在记录当前通话")
                .setOngoing(true)
                .setContentIntent(PendingIntent.getActivity(this, 0,
                    Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
                .build()
            if (Build.VERSION.SDK_INT >= 30) startForeground(
                703, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            ) else startForeground(703, notification)
            recordingForeground = true
            GatewayDiag.log("passive_recording.foreground", mapOf("microphone" to true))
            true
        }.getOrElse { error ->
            GatewayDiag.log("passive_recording.foreground_failed",
                mapOf("errorType" to error.javaClass.simpleName), level = "warn")
            false
        }
    }

    /** false = the lease stayed RESTORE_BLOCKED (a call is still live); either way it must not throw here. */
    private fun restoreMuteLeaseLogged(deviceCallId: String?, creationTimeMillis: Long?) {
        val result = runCatching { restorePersistedMuteLease(this, deviceCallId, creationTimeMillis) }
        if (result.getOrNull() == true) return
        GatewayDiag.log("mute_lease.restore_failed", mapOf("deviceCallId" to deviceCallId,
            "errorType" to result.exceptionOrNull()?.javaClass?.simpleName), level = "warn")
    }

    private fun wakeGatewayIfEnabled() {
        refreshRecordingForeground()
        if (!GatewayRuntimeStore(this).enabled) return
        ContextCompat.startForegroundService(
            this,
            Intent(this, GatewayForegroundService::class.java)
                .setAction(GatewayForegroundService.ACTION_TELECOM_CHANGED),
        )
    }
}

/** S56: an early-media leg captures VOICE_DOWNLINK while an outgoing call is still dialing. */
internal fun recordingForegroundNeeded(state: Int, outgoing: Boolean, earlyMedia: Boolean): Boolean =
    state == Call.STATE_ACTIVE || state == Call.STATE_HOLDING ||
        (earlyMedia && outgoing && (state == Call.STATE_DIALING || state == Call.STATE_CONNECTING))

internal fun hasUnrelatedLiveCall(calls: List<TelecomCallSnapshot>, deviceCallId: String) = calls.any {
    it.localId != deviceCallId && it.state !in setOf(
        ActualTelecomState.DISCONNECTING, ActualTelecomState.DISCONNECTED,
    )
}

/** S85: only speaker during a video state is reverted, so a human pressing speaker on an audio-only call still works. */
internal fun shouldRevertVideoSpeaker(route: Int, videoStates: List<Int>): Boolean =
    route == CallAudioState.ROUTE_SPEAKER &&
        videoStates.any { (it and (VideoProfile.STATE_TX_ENABLED or VideoProfile.STATE_RX_ENABLED)) != 0 }
