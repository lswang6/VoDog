package org.vodog.gateway

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import org.vodog.gateway.media.GatewayMediaProbeOwner
import org.vodog.gateway.media.GatewayProbeReadiness
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong

internal const val PROBE_REFRESH_AHEAD_SECONDS = 20L

class GatewayForegroundService : Service() {
    private var scope = newScope()
    private var loopJob: Job? = null
    private var controlTransport: GatewayHttpTransport = OwnedGatewayHttpTransport()
    private var mediaSetupOwner = GatewayMediaSetupOwner()
    private var mediaProbeOwner: GatewayMediaProbeOwner? = null
    private var recordingArchiveOwner: GatewayRecordingArchiveOwner? = null
    private var outgoingSmsObserver: GatewayOutgoingSmsObserver? = null
    private val audioEndpoint: TelephonyAudioEndpoint = DisabledTelephonyAudioEndpoint()
    private lateinit var audioLifecycle: GatewayAudioLifecycleCoordinator
    private val wakeups = Channel<Unit>(Channel.CONFLATED)
    // S20 D4. The doorbell is a second, independent coroutine: it feeds `wakeups` and nothing else.
    // Its failures never reach GatewayConnectionTracker and never publish a connection state.
    private var doorbellJob: Job? = null
    @Volatile private var doorbellMaxHoldMs = 0
    /** A failing heartbeat announces nothing, so the doorbell must not keep ringing into it. */
    @Volatile private var lastHeartbeatFailed = false
    /** Bumped once per completed heartbeat cycle so a woken doorbell can wait for the drain. */
    private val heartbeatCycles = AtomicLong(0L)
    /** Identifies the current doorbell loop so a cancelled predecessor cannot overwrite its display. */
    private val doorbellGeneration = AtomicLong(0L)
    /** S36 C3: when the doorbell last rang, read once by the heartbeat it woke. Approximate: telecom
     *  and SMS intents feed the same channel, so a wake without a doorbell ring reports nothing. */
    private val doorbellWakeAtMs = AtomicLong(0L)
    private var networkCallback: android.net.ConnectivityManager.NetworkCallback? = null
    // Exactly one open replay database per identity. Re-opening it twice per heartbeat leaked an
    // SQLiteConnection every 2 s and produced "database is locked" storms in logcat.
    private val replayStores = linkedMapOf<GatewayCommandIdentity, GatewayReplayHorizonStore>()
    private var notificationText = CONNECTING_NOTIFICATION

    override fun onCreate() {
        super.onCreate()
        createChannel()
        audioLifecycle = GatewayAudioLifecycleCoordinator(this)
        startNetworkDiag()
        // Recovery may wait for an InCallService audio callback. Never run it on the main thread.
        scope.launch { audioLifecycle.recoverStartup() }
    }

    /** S36 C3: default-network transport, deduped - onCapabilitiesChanged also fires on signal strength. */
    private fun startNetworkDiag() {
        val manager = getSystemService(android.net.ConnectivityManager::class.java) ?: return
        var last: String? = null
        val callback = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: android.net.Network, capabilities: android.net.NetworkCapabilities) {
                val transport = when {
                    capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    else -> "other"
                }
                GatewayEndpoint.onDefaultNetwork(transport)
                val validated = capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                if ("$transport/$validated" == last) return
                last = "$transport/$validated"
                GatewayDiag.log("network.transport", mapOf("transport" to transport, "validated" to validated),
                    callId = activeCallId())
            }

            override fun onLost(network: android.net.Network) {
                if (last == "none") return
                last = "none"
                GatewayDiag.log("network.transport", mapOf("transport" to "none") + noNetworkCause(),
                    callId = activeCallId(), level = "warn")
            }
        }
        networkCallback = callback
        runCatching { manager.registerDefaultNetworkCallback(callback) }.onFailure {
            networkCallback = null
            GatewayDiag.log("network.diag_unavailable", mapOf("errorType" to it.javaClass.simpleName), level = "warn")
        }
    }

    /** S75: the call whose media leg this network change hits (in-memory; only calls with a media session). */
    private fun activeCallId(): String? = runCatching { GatewayActiveAudioSession.current()?.serverCallId }.getOrNull()

    /** S75: why the default network went away, from reads that need no new permission; unreadable = absent. */
    private fun noNetworkCause(): Map<String, Any?> = mapOf(
        "airplaneMode" to runCatching {
            android.provider.Settings.Global.getInt(contentResolver, android.provider.Settings.Global.AIRPLANE_MODE_ON) != 0
        }.getOrNull(),
        "dataState" to runCatching {
            when (getSystemService(android.telephony.TelephonyManager::class.java).dataState) {
                android.telephony.TelephonyManager.DATA_DISCONNECTED -> "disconnected"
                android.telephony.TelephonyManager.DATA_CONNECTING -> "connecting"
                android.telephony.TelephonyManager.DATA_CONNECTED -> "connected"
                android.telephony.TelephonyManager.DATA_SUSPENDED -> "suspended"
                android.telephony.TelephonyManager.DATA_DISCONNECTING -> "disconnecting"
                else -> "unknown"
            }
        }.getOrNull(),
    )

    private fun stopNetworkDiag() {
        val manager = runCatching { getSystemService(android.net.ConnectivityManager::class.java) }.getOrNull()
        networkCallback?.let { callback -> runCatching { manager?.unregisterNetworkCallback(callback) } }
        networkCallback = null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSafely()
            return START_NOT_STICKY
        }

        val runtime = GatewayRuntimeStore(this)
        val credential = DeviceCredentialVault(this).read()
        val commandIdentity = runtime.commandIdentity(credential)
        if (!runtime.enabled || credential.isNullOrBlank() || commandIdentity == null) {
            runtime.enabled = false
            runtime.connection = if (credential.isNullOrBlank()) ServerConnection.UNPAIRED else ServerConnection.DISABLED
            stopSelf()
            return START_NOT_STICKY
        }

        // Reuse the current text: a wake intent must not flash "正在连接" over a healthy notification.
        startForeground(NOTIFICATION_ID, notification(notificationText))
        if (outgoingSmsObserver == null) {
            outgoingSmsObserver = GatewayOutgoingSmsObserver(this) {
                if (GatewayRuntimeStore(this).enabled) wakeups.trySend(Unit)
            }
        }
        outgoingSmsObserver?.start()
        if (intent?.action == ACTION_RETRY_NOW &&
            runtime.connection in setOf(ServerConnection.OFFLINE, ServerConnection.DEGRADED)) {
            // Explicit user retry is the one place a transition out of OFFLINE is displayed eagerly.
            runtime.connection = ServerConnection.CONNECTING
            runtime.connectionDetail = "正在立即重试控制连接"
            updateNotification(CONNECTING_NOTIFICATION)
        }
        if (loopJob?.isActive != true) {
            if (!scope.isActive) scope = newScope()
            // The doorbell holds the transport that is about to be replaced; it must not survive it.
            stopCommandDoorbell(runtime)
            controlTransport.close()
            mediaSetupOwner.close()
            mediaProbeOwner?.close()
            recordingArchiveOwner?.close()
            controlTransport = OwnedGatewayHttpTransport()
            mediaSetupOwner = GatewayMediaSetupOwner()
            mediaProbeOwner = if (GatewayPhoneFeatureApproval.APPROVED) GatewayMediaProbeOwner(this, credential) else null
            recordingArchiveOwner = if (GatewayRecordingArchiveApproval.APPROVED) {
                GatewayRecordingArchiveOwner(this, credential)
            } else null
            val ownedTransport = controlTransport
            val ownedMediaSetup = mediaSetupOwner
            val ownedMediaProbe = mediaProbeOwner
            val ownedScope = scope
            GatewayDiag.attach(this, credential)
            GatewayDiag.log("service.start", mapOf("generation" to commandIdentity.generation, "action" to intent?.action))
            // S36b D2: device status runs on the diag thread's 60 s tick, never on the heartbeat's.
            GatewayDeviceStatus.start(this)
            // S41 §决策4 / S55: catches up now, then follows the provider (2 s debounce) and a 60 s turn.
            GatewaySystemBlocklistMirror.start(this)
            loopJob = ownedScope.launch {
                heartbeatLoop(credential, commandIdentity, ownedTransport, ownedMediaSetup, ownedMediaProbe, ownedScope)
            }
        } else if (intent?.action == ACTION_TELECOM_CHANGED || intent?.action == ACTION_SMS_CHANGED ||
            intent?.action == ACTION_RETRY_NOW) {
            wakeups.trySend(Unit)
        }
        return START_STICKY
    }

    /** State that outlives one heartbeat cycle. S52: split out so ART can compile each phase. */
    private class HeartbeatLoopContext(
        val token: String,
        var identity: GatewayCommandIdentity,
        val transport: GatewayHttpTransport,
        val mediaSetup: GatewayMediaSetupOwner,
        val mediaProbe: GatewayMediaProbeOwner?,
        val ownedScope: CoroutineScope,
        val runtime: GatewayRuntimeStore,
        val callExecutions: CallExecutionJournal,
        val api: GatewayApi,
        val replayMigration: GatewayReplayMigrationCoordinator,
        var connectionState: GatewayConnectionSnapshot,
    ) {
        var lastProbe: GatewayProbeReadiness? = null
        var lastSuccessfulProbe: GatewayProbeReadiness? = null
        var probeRefresh: Deferred<ProbeRefreshOutcome>? = null
        var explicitProbeFailure = false
        var probeRetryNotBeforeMs = 0L
        val mediaReconcile = MediaReconcileScheduler(ownedScope)
        var authorizedDialGraceUntilMs = 0L
        var lastHeartbeatStartedAtMs: Long? = null
        val rtt = HeartbeatRttWindow()
    }

    private class HeartbeatCycleInputs(
        val smsReady: Boolean,
        val callOrAudioActive: Boolean,
        val phoneCapabilities: GatewayPhoneCapabilities,
        val requestReplayStore: GatewayReplayHorizonStore?,
    )

    private class SentHeartbeat(val result: HeartbeatResult, val commandsReceivedAtMs: Long, val carriedPowerResult: String?)

    /** NEXT = wait for the poll, STOP = leave the loop, RESTART = next cycle at once (no counter, no wait). */
    private enum class CycleEnd { NEXT, STOP, RESTART }

    // S52: one method used to hold the whole cycle (20148 dex instructions); ART refused to compile it and
    // interpreted it forever. The phases below are a mechanical split with identical ordering.
    private suspend fun heartbeatLoop(
        token: String,
        initialIdentity: GatewayCommandIdentity,
        transport: GatewayHttpTransport,
        mediaSetup: GatewayMediaSetupOwner,
        mediaProbe: GatewayMediaProbeOwner?,
        ownedScope: CoroutineScope,
    ) {
        val runtime = GatewayRuntimeStore(this)
        val callExecutions = CallExecutionJournal(this)
        val api = GatewayApi(
            token = token,
            shouldContinue = { runtime.enabled && ownedScope.isActive },
            transport = transport,
        )
        val replayMigration = GatewayReplayMigrationCoordinator(
            this, runtime, api, token, stores = GatewayReplayStoreProvider(::replayStore),
        )
        // Hysteresis state is seeded from durable evidence. An elapsedRealtime stamp from a previous
        // boot is meaningless, so it is dropped and the display restarts at "正在连接".
        val loop = HeartbeatLoopContext(
            token, initialIdentity, transport, mediaSetup, mediaProbe, ownedScope,
            runtime, callExecutions, api, replayMigration,
            GatewayConnectionTracker.initial(
                lastSuccessAtMs = runtime.lastHeartbeatSuccessAtMs?.takeIf { it <= SystemClock.elapsedRealtime() },
                consecutiveFailures = runtime.consecutiveHeartbeatFailures,
                persisted = runtime.connection,
            ),
        )
        // The only unconditional CONNECTING write: the loop has started and nothing has answered yet.
        if (loop.connectionState.connection == ServerConnection.CONNECTING ||
            runtime.connection == ServerConnection.OFFLINE) {
            publishConnection(runtime, ServerConnection.CONNECTING, "正在连接控制服务")
            updateNotification(CONNECTING_NOTIFICATION)
        }
        while (ownedScope.isActive && runtime.enabled) {
            evictForeignReplayStores(loop.identity)
            if (replayMigration.hasBarrier(loop.identity)) {
                val resumedIdentity = runCatching { replayMigration.resume(loop.identity) }.getOrNull()
                if (resumedIdentity == null) {
                    // Barrier semantics are unchanged: no heartbeat runs this cycle, so the display
                    // is "正在连接". publishConnection dedupes, so a held barrier does not flicker.
                    publishConnection(runtime, ServerConnection.CONNECTING,
                        "回放迁移正在等待本地义务清空或服务端确认")
                    withTimeoutOrNull(MIGRATION_RETRY_MS) { wakeups.receive() }
                    continue
                }
                loop.identity = resumedIdentity
            }
            try {
                when (runHeartbeatCycle(loop)) {
                    CycleEnd.STOP -> break
                    CycleEnd.RESTART -> continue
                    CycleEnd.NEXT -> Unit
                }
            } catch (_: CancellationException) {
                break
            } catch (error: Exception) {
                recordHeartbeatCycleFailure(loop, error)
            }
            heartbeatCycles.incrementAndGet()
            withTimeoutOrNull(loop.connectionState.nextPollMs) { wakeups.receive() }
        }
    }

    private suspend fun runHeartbeatCycle(loop: HeartbeatLoopContext): CycleEnd {
        val runtime = loop.runtime
        val inputs = prepareHeartbeatCycle(loop)
        val sent = sendHeartbeat(loop, inputs)
        val result = sent.result
        if (!runtime.enabled) return CycleEnd.STOP
        sent.carriedPowerResult?.let { runtime.clearPowerResult(it) }
        // A remote OFF ends this cycle before any other work: the rest of the loop assumes an
        // enabled gateway, and the shutdown itself runs on the main thread.
        if (result.desiredPower == "off" && applyRemotePowerOff(runtime)) return CycleEnd.STOP
        val (replayStore, commands) = acceptHeartbeat(loop, inputs, result)
        // S21 §B: the blocked-call/SMS interception outbox is flushed before the Telecom
        // snapshot so an interception row exists before any snapshot item that mentions the
        // same deviceCallId. It never throws, so it cannot fail a heartbeat cycle.
        GatewayInterceptionReporter(this, loop.api).flush()
        // S55: phone-side blocklist changes; never throws, a refusal lets Control win.
        GatewaySystemBlocklistMirror.flushReports(this, loop.api, runtime.deviceEpoch)
        val sms = GatewaySmsCoordinator(this, runtime, loop.api, loop.identity, replayStore)
        val calls = GatewayCallCoordinator(
            this, runtime, loop.api, loop.identity, mediaPrepared = audioLifecycle::handoffPrepared,
            replayStore = replayStore,
        )
        val settings = GatewaySettingsCoordinator(this, runtime, loop.api, loop.identity, replayStore)
        val dtmf = GatewayDtmfCoordinator(loop.api, loop.identity, replayStore)
        val (telecom, syncFailureDetail) = syncTelecom(loop)
        flushAndRefreshReplayEvidence(loop, replayStore, sms, calls)
        executeCommands(loop, inputs, sent, replayStore, commands, sms, calls, settings, dtmf)
        replayStore.maybeMarkReady(result.serverSequence)
        val migrationIdle = telecom?.busyState == "idle" &&
            GatewayActiveAudioSession.current() == null && !audioLifecycle.hasExactNonTerminalCall()
        if (loop.replayMigration.begin(loop.identity, result.serverSequence, migrationIdle)) {
            // The barrier resumes immediately: no poll delay is applied on this path.
            return CycleEnd.RESTART
        }
        reconcileMediaAndPublish(loop, inputs, telecom, syncFailureDetail)
        return CycleEnd.NEXT
    }

    private suspend fun prepareHeartbeatCycle(loop: HeartbeatLoopContext): HeartbeatCycleInputs {
        val runtime = loop.runtime
        val mediaProbe = loop.mediaProbe
        val smsReady = SmsExecutionApproval.APPROVED &&
            checkSelfPermission(android.Manifest.permission.SEND_SMS) == android.content.pm.PackageManager.PERMISSION_GRANTED
        audioLifecycle.prepareIdleHandoff()
        val handoffPrepared = audioLifecycle.handoffPrepared()
        val shouldProbe = GatewayPhoneFeatureApproval.APPROVED && runtime.enabled && handoffPrepared
        refreshProbeReadiness(loop, shouldProbe)
        val exactNonTerminalCall = audioLifecycle.hasExactNonTerminalCall()
        if (exactNonTerminalCall) loop.authorizedDialGraceUntilMs = 0L
        val authorizedDialTransition = SystemClock.elapsedRealtime() < loop.authorizedDialGraceUntilMs
        val callOrAudioActive = gatewayCallOrAudioActive(
            exactNonTerminalCall,
            audioLifecycle.hasAnyNonTerminalCall(),
            authorizedDialTransition,
            GatewayActiveAudioSession.current() != null,
        )
        val sameProbeGeneration = loop.lastSuccessfulProbe?.let { successful ->
            runCatching { requireNotNull(mediaProbe).requireCurrent(successful.networkGeneration) }.isSuccess
        } == true
        val staleButRecentReachable = shouldRetainStaleProbeReadiness(
            loop.lastSuccessfulProbe,
            shouldProbe,
            sameProbeGeneration,
            Instant.now(),
        )
        val phoneCapabilities = GatewayPhoneReadinessPolicy.capabilities(
            GatewayPhoneFeatureApproval.APPROVED,
            runtime.enabled,
            handoffPrepared,
            // A refresh failure is a diagnostic, not a withdrawal: the Telecom snapshot ends
            // calls, so a probe timeout must never make the server kill a live call.
            mediaReachable = callOrAudioActive || staleButRecentReachable,
        )
        val requestReplayStore = if (GatewayReplayHorizonApproval.ENABLED && !loop.identity.gatewayId.startsWith("legacy-credential-")) {
            replayStore(loop.identity)
        } else null
        return HeartbeatCycleInputs(smsReady, callOrAudioActive, phoneCapabilities, requestReplayStore)
    }

    private suspend fun refreshProbeReadiness(loop: HeartbeatLoopContext, shouldProbe: Boolean) {
        val mediaProbe = loop.mediaProbe
        loop.probeRefresh?.takeIf { it.isCompleted }?.let { completed ->
            val outcome = completed.await()
            loop.probeRefresh = null
            val refreshed = outcome.readiness
            if (!outcome.failed && refreshed?.hasReachableNode == true) {
                loop.lastSuccessfulProbe = refreshed
                loop.explicitProbeFailure = false
                loop.probeRetryNotBeforeMs = 0L
            } else {
                loop.explicitProbeFailure = true
                loop.probeRetryNotBeforeMs = SystemClock.elapsedRealtime() + PROBE_FAILURE_RETRY_MS
            }
        }
        loop.lastProbe = if (shouldProbe) mediaProbe?.peekCurrent() else null
        // Any reachable accepted snapshot, including one taken by media signaling outside
        // this loop, becomes the retention evidence.
        loop.lastProbe?.takeIf { it.hasReachableNode }?.let { reachable ->
            if (loop.lastSuccessfulProbe?.acceptedAt?.isAfter(reachable.acceptedAt) != true) {
                loop.lastSuccessfulProbe = reachable
            }
        }
        val refreshCurrent = loop.lastProbe.takeUnless { loop.explicitProbeFailure }
        if (shouldScheduleProbeRefresh(
                shouldProbe,
                refreshCurrent,
                loop.probeRefresh != null,
                Instant.now(),
                SystemClock.elapsedRealtime() >= loop.probeRetryNotBeforeMs,
            )) {
            val current = loop.lastProbe
            val forceRefresh = shouldForceProbeRefresh(
                current,
                loop.explicitProbeFailure,
                Instant.now(),
            )
            if (current == null || forceRefresh) {
                // The first probe and every refresh run away from the command loop. Until an
                // accepted same-network snapshot exists, this heartbeat advertises mediaReady=false.
                loop.probeRefresh = loop.ownedScope.launchProbeRefresh(
                    refresh = {
                        if (forceRefresh) requireNotNull(mediaProbe).refreshNow()
                        else mediaProbe?.ensureCurrent()
                    },
                    onComplete = { wakeups.trySend(Unit) },
                )
            }
        }
    }

    private fun sendHeartbeat(loop: HeartbeatLoopContext, inputs: HeartbeatCycleInputs): SentHeartbeat {
        val runtime = loop.runtime
        // S21 §D: whichever channel is alive carries the last power result. Read before the
        // request so a result written while it is in flight survives the clear.
        val carriedPowerResult = runtime.pendingPowerResult
        val heartbeatStartedAtMs = SystemClock.elapsedRealtime()
        doorbellWakeAtMs.getAndSet(0L).takeIf { it > 0L }?.let { GatewayDiag.log("doorbell.wake", mapOf("ms" to heartbeatStartedAtMs - it)) }
        val result = loop.api.heartbeat(true, runtime.reportedSequence, inputs.smsReady, inputs.phoneCapabilities,
            inputs.requestReplayStore?.advertisedState(), GatewayReplayHorizonEnrollmentApproval.ENABLED,
            remotePowerAllowed = runtime.allowRemotePower,
            lastPowerResult = carriedPowerResult?.let { runCatching { org.json.JSONObject(it) }.getOrNull() },
            numberBlocklistVersion = GatewayNumberBlocklistStore(this@GatewayForegroundService).knownVersion())
        val commandsReceivedAtMs = SystemClock.elapsedRealtime()
        val rttMs = commandsReceivedAtMs - heartbeatStartedAtMs
        val cycleGapMs = loop.lastHeartbeatStartedAtMs?.let { heartbeatStartedAtMs - it }
        loop.lastHeartbeatStartedAtMs = heartbeatStartedAtMs
        // S36b D2: every cycle now, compact. S69: a slow cycle only counts into heartbeat.summary;
        // a single row is worth a warn only past VERY_SLOW_HEARTBEAT_MS.
        val slowHeartbeat = rttMs > SLOW_HEARTBEAT_MS ||
            (cycleGapMs != null && cycleGapMs > 2 * loop.connectionState.nextPollMs)
        loop.rtt.sample(rttMs, slowHeartbeat, cycleGapMs)
        GatewayDiag.log(
            "heartbeat.rtt",
            mapOf(
                "ms" to rttMs,
                "gapMs" to cycleGapMs,
                "commands" to result.commands.size,
                "expectedGapMs" to loop.connectionState.nextPollMs.takeIf { slowHeartbeat },
            ),
            level = if (rttMs > VERY_SLOW_HEARTBEAT_MS) "warn" else "debug",
        )
        loop.rtt.due(heartbeatStartedAtMs)?.let { GatewayDiag.log("heartbeat.summary", it) }
        return SentHeartbeat(result, commandsReceivedAtMs, carriedPowerResult)
    }

    private fun acceptHeartbeat(
        loop: HeartbeatLoopContext,
        inputs: HeartbeatCycleInputs,
        result: HeartbeatResult,
    ): Pair<GatewayReplayHorizonStore, PendingCommandStore> {
        val runtime = loop.runtime
        loop.identity = runtime.confirmServerIdentity(
            result.gatewayId, result.deviceEpoch, loop.token,
        )
        val replayStore = replayStore(loop.identity)
        result.replayHorizonEnrollment?.let(replayStore::applyEnrollment)
        if (result.replayHorizon != null && inputs.requestReplayStore == null) {
            error("unexpected replay horizon while capability disabled")
        }
        // Persist admissible identities before the rest of the cycle. A retired command is
        // ignored and a mismatch durably quarantines the fence; neither is a transport error.
        result.commands.forEach(replayStore::prepareCommand)
        result.commands.forEach { GatewayDiag.log("command.received", mapOf("commandId" to it.commandId, "kind" to it.kind, "sequence" to it.sequence), callId = it.callId) }
        val commands = PendingCommandStore(this, loop.identity)
        result.numberBlocklist?.let { snapshot ->
            val applied = GatewayNumberBlocklistStore(this).apply(snapshot)
            if (applied) rejectListedRingingCalls(this)
            // S55: the mode rides every heartbeat; a flag flip changes no version.
            val modeChanged = GatewaySystemBlocklistMirror.updateMode(this, snapshot.phoneSync)
            if (applied || modeChanged) GatewaySystemBlocklistMirror.schedule(this)
        }
        runtime.earlyMedia = result.earlyMedia
        // S69: the first accepted heartbeat after a failure run closes it.
        loop.connectionState.takeIf { it.consecutiveFailures > 0 }?.let { down ->
            GatewayDiag.log("heartbeat.recovered", mapOf(
                "failures" to down.consecutiveFailures,
                "downMs" to down.lastSuccessAtMs?.let { SystemClock.elapsedRealtime() - it }?.takeIf { it >= 0L },
            ))
        }
        // The heartbeat was accepted. State, detail and notification are written once per
        // cycle and only when they actually change, so the UI no longer blinks every 2 s.
        loop.connectionState = GatewayConnectionTracker.onSuccess(
            loop.connectionState, SystemClock.elapsedRealtime(), callOrAudioActive = inputs.callOrAudioActive,
        )
        runtime.recordHeartbeatSuccess(SystemClock.elapsedRealtime(), System.currentTimeMillis())
        // The announcement is the only thing that opens or closes the doorbell. Note this
        // runs before command execution, so a cycle that throws below still counts as failed.
        lastHeartbeatFailed = false
        ensureCommandDoorbell(result.commandDoorbellMaxHoldMs, loop.token, loop.transport, loop.ownedScope, runtime)
        updateNotification(when {
            inputs.phoneCapabilities.telephonyReady && inputs.phoneCapabilities.mediaReady -> "已连接 · 通话网关可用"
            inputs.smsReady -> "已连接 · 短信网关可用"
            else -> "已连接 · 状态同步"
        })
        return replayStore to commands
    }

    /** Refresh SIM identities before applying any command frozen to an assignment. */
    private fun syncTelecom(loop: HeartbeatLoopContext): Pair<GatewayTelecomSyncResult?, String?> =
        // A rejected or failed device-state sync must not stop command handling and the ACK flush below: the
        // sync heals its own payload, and this only degrades the reported device state for one cycle.
        try {
            GatewayTelecomSync(this, loop.runtime, loop.api).runOnce() to null
        } catch (error: Exception) {
            if (!loop.runtime.enabled) throw error
            GatewayDiag.log("telephony.sync_failed", mapOf(
                "errorType" to error.javaClass.simpleName,
                "message" to (error.message ?: error.javaClass.simpleName).take(120),
            ), level = "warn")
            null to "设备状态同步失败，命令通道继续：${
                (error.message ?: error.javaClass.simpleName).take(80)
            }"
        }

    private fun flushAndRefreshReplayEvidence(
        loop: HeartbeatLoopContext,
        replayStore: GatewayReplayHorizonStore,
        sms: GatewaySmsCoordinator,
        calls: GatewayCallCoordinator,
    ) {
        // Compression/upload runs on its own single-concurrency scope. Heartbeat only signals idle work.
        // S38 §4: a phone-dialled call is not an "exact" call, so its passive capture has to
        // hold the archive off on its own or the loop would compress mid-recording.
        val recordingBusy = audioLifecycle.hasExactActiveCall() ||
            GatewayActiveAudioSession.current() != null || GatewayPassiveCallRecorder.active()
        if (recordingBusy) recordingArchiveOwner?.signalBusy() else recordingArchiveOwner?.signalIdle()
        loop.api.flushReplayAcks(replayStore)
        sms.flushEvents()
        calls.flushAcks()
        replayStore.evidenceRows().forEach { (commandId, kind) ->
            if (kind in setOf("dial", "answer", "hangup")) {
                loop.callExecutions.find(commandId)?.let { execution ->
                    val ackAccepted = execution.ackDeliveredAt != null
                    val safe = ackAccepted && (execution.terminalConfirmedAt != null ||
                        (execution.phase == CallExecutionPhase.REJECTED && execution.effectStartedAt == null))
                    replayStore.refreshEvidence(commandId, ackAccepted, safe, !ackAccepted)
                }
            } else if (kind == "send_sms") {
                SmsExecutionJournal(this).find(commandId)?.let { execution ->
                    val eventsPending = execution.events.any { !it.delivered }
                    val safe = smsExecutionSafeToRetire(execution)
                    replayStore.refreshEvidence(commandId, execution.ackDelivered, safe,
                        !execution.ackDelivered || eventsPending)
                }
            }
        }
    }

    private suspend fun executeCommands(
        loop: HeartbeatLoopContext,
        inputs: HeartbeatCycleInputs,
        sent: SentHeartbeat,
        replayStore: GatewayReplayHorizonStore,
        commands: PendingCommandStore,
        sms: GatewaySmsCoordinator,
        calls: GatewayCallCoordinator,
        settings: GatewaySettingsCoordinator,
        dtmf: GatewayDtmfCoordinator,
    ) {
        val runtime = loop.runtime
        val result = sent.result
        val identity = loop.identity
        val smsReady = inputs.smsReady
        if(result.replayHorizonControlQuarantined)replayStore.quarantine("control_quarantined")
        var replayBlocked=replayStore.state().let { it.quarantined || it.localBlocked }
        result.replayHorizon?.let { proof ->
            val applied=replayStore.apply(proof)
            replayBlocked=replayStore.state().let { it.quarantined || it.localBlocked }
            if (proof.phase == "control_committed" && applied.disposition==ReplayApplyDisposition.APPLIED) {
                CallExecutionJournal(this).pruneBeforeCommitted(proof.retireBeforeSequence, identity.generation)
                SmsExecutionJournal(this).pruneBeforeCommitted(proof.retireBeforeSequence, identity.generation)
            }
        }
        val executable = if(replayBlocked)emptyList() else result.commands.filter {
            (it.kind == "send_sms" && smsReady) || it.kind == "apply_sim_settings" ||
                it.kind == "dtmf" || isCallCommandExecutable(it, GatewayCallExecutionApproval.READY)
        }
        if(!replayBlocked)result.commands.filter { command -> executable.none { it.commandId == command.commandId } }
            .forEach(commands::rememberRejected)
        val work = if(replayBlocked)emptyList() else (commands.pending() + executable).distinctBy { it.commandId }.sortedBy { it.sequence }
        // S73i: a dial whose hangup is already queued behind it in this batch is cancelled, not placed.
        val hangupCallIds = work.filter { it.kind == "hangup" }
            .mapNotNull { hangupSpecAllowingMissingDeviceCall(it)?.serverCallId }.toSet()
        for (command in work) {
            if (!runtime.enabled) break
            when(replayStore.prepareCommand(command)){
                ReplayCommandGate.EXECUTE -> Unit
                ReplayCommandGate.RETIRED -> { commands.markAcked(command);continue }
                ReplayCommandGate.BLOCKED -> break
                ReplayCommandGate.QUARANTINE -> break
            }
            val executedAtMs = SystemClock.elapsedRealtime()
            var outcome = "handled"
            // S69: a failed ACK (or any other throw) still gets its command.executed row, then
            // propagates unchanged - the cycle fails exactly as before.
            try {
                if (command.kind == "apply_sim_settings") {
                    settings.handle(command)
                    replayStore.markRetirementSafety(command.commandId, true, false)
                } else if (command.kind == "dtmf") {
                    // S36 C2: tones are not a call action. No CallCommandSpec, no execution
                    // journal, no terminal to wait for - the ACK is the whole proof.
                    dtmf.handle(command)
                    replayStore.markRetirementSafety(command.commandId, true, false)
                } else if (command.kind == "send_sms" && smsReady) {
                    sms.handle(command)
                    val record = SmsExecutionJournal(this).find(command.commandId)
                    val safe = record?.let(::smsExecutionSafeToRetire) == true
                    replayStore.markRetirementSafety(command.commandId, safe,
                        record?.events?.any { !it.delivered } == true)
                } else if (isCallCommandExecutable(command, GatewayCallExecutionApproval.READY)) {
                    if (calls.handle(command, hangupCallIds)) {
                        commands.markAcked(command)
                        val execution = loop.callExecutions.find(command.commandId)
                        if (execution?.spec?.kind == CallCommandKind.DIAL &&
                            execution.spec.generation == runtime.deviceEpoch &&
                            execution.phase == CallExecutionPhase.SUBMITTED) {
                            loop.authorizedDialGraceUntilMs = SystemClock.elapsedRealtime() + AUTHORIZED_DIAL_GRACE_MS
                        }
                        val safeExecution = execution?.let {
                            it.ackDeliveredAt != null && (it.terminalConfirmedAt != null ||
                                (it.phase == CallExecutionPhase.REJECTED && it.effectStartedAt == null))
                        } == true
                        replayStore.markRetirementSafety(command.commandId, safeExecution, false)
                    } else if (shouldBreakHeartbeatForUnhandledCallCommand()) {
                        break
                    }
                } else {
                    loop.api.rejectUnsupported(command, ReplayAckEvidence(
                        command.sequence, commandReplayFingerprint(identity.gatewayId, command),
                    ), replayStore)
                    commands.markAcked(command)
                    replayStore.markRetirementSafety(command.commandId, false, false)
                    outcome = "unsupported"
                }
            } catch (error: Exception) {
                if (error !is CancellationException) GatewayDiag.log("command.executed", mapOf("commandId" to command.commandId, "kind" to command.kind,
                    "ms" to SystemClock.elapsedRealtime() - executedAtMs, "result" to "failed",
                    "errorType" to error.javaClass.simpleName), callId = command.callId, level = "warn")
                throw error
            }
            GatewayDiag.log("command.executed", mapOf("commandId" to command.commandId, "kind" to command.kind, "ms" to SystemClock.elapsedRealtime() - executedAtMs, "sinceReceivedMs" to executedAtMs - sent.commandsReceivedAtMs, "result" to outcome), callId = command.callId)
            runtime.reportedSequence = maxOf(runtime.reportedSequence, command.sequence)
        }
    }

    private fun reconcileMediaAndPublish(
        loop: HeartbeatLoopContext,
        inputs: HeartbeatCycleInputs,
        telecom: GatewayTelecomSyncResult?,
        syncFailureDetail: String?,
    ) {
        val mediaProbe = loop.mediaProbe
        val mediaSetup = loop.mediaSetup
        val exactCall = audioLifecycle.hasExactNonTerminalCall()
        if (!exactCall) {
            loop.mediaReconcile.cancelCurrent()
            mediaSetup.cancelPending()
        }
        if (mediaProbe != null &&
            (exactCall || GatewayActiveAudioSession.current() != null)) {
            // Media negotiation may wait on options/offer/ICE/prebuffer. It must never delay
            // heartbeat command retrieval or a physical Telecom hangup.
            loop.mediaReconcile.schedule {
                runCatching { audioLifecycle.reconcile(loop.token, mediaSetup, mediaProbe, loop.api) }
            }
        }
        // S38 §4: deliberately outside the exact-call guard above, which by design never
        // matches a call the user dialled on the Pixel. Synchronous like the Telecom sync.
        GatewayPassiveCallRecorder.reconcile(this, loop.api, telecom?.confirmedActiveCallIds.orEmpty())
        publishConnection(loop.runtime, ServerConnection.ONLINE, gatewayConnectionDetail(
            smsReady = inputs.smsReady,
            remoteCallReady = inputs.phoneCapabilities.telephonyReady && inputs.phoneCapabilities.mediaReady,
            simsSynced = telecom?.simsSynced,
            probeRefreshFailed = loop.explicitProbeFailure,
            syncFailureDetail = syncFailureDetail,
        ))
    }

    private fun recordHeartbeatCycleFailure(loop: HeartbeatLoopContext, error: Exception) {
        val runtime = loop.runtime
        // Includes failures raised after a 2xx (quarantined replay horizon, fence mismatch):
        // those never drain the command, so the doorbell must stop ringing into them.
        lastHeartbeatFailed = true
        if (runtime.enabled) {
            val message = (error.message ?: error.javaClass.simpleName).take(120)
            // Nothing in a catch block may throw: an escape here would end the loop coroutine
            // and leave the service alive but silent until an unrelated intent restarted it.
            val activeWork = runCatching {
                gatewayCallOrAudioActive(
                    audioLifecycle.hasExactNonTerminalCall(),
                    audioLifecycle.hasAnyNonTerminalCall(),
                    SystemClock.elapsedRealtime() < loop.authorizedDialGraceUntilMs,
                    GatewayActiveAudioSession.current() != null,
                )
            }.getOrDefault(false)
            loop.connectionState = GatewayConnectionTracker.onFailure(
                loop.connectionState,
                SystemClock.elapsedRealtime(),
                callOrAudioActive = activeWork,
            )
            runtime.recordHeartbeatFailure(loop.connectionState.consecutiveFailures, message)
            if (heartbeatFailureLogged(loop.connectionState.consecutiveFailures)) {
                GatewayDiag.log("heartbeat.failed", mapOf(
                    "consecutive" to loop.connectionState.consecutiveFailures,
                    "errorType" to error.javaClass.simpleName,
                    "httpStatus" to (error as? GatewayApiHttpError)?.status,
                    "connection" to loop.connectionState.connection.name,
                    "callOrAudioActive" to activeWork,
                ), level = "warn")
            }
            publishConnection(runtime, loop.connectionState.connection, GatewayConnectionTracker.failureDetail(
                loop.connectionState.connection, loop.connectionState.consecutiveFailures, message,
            ))
            updateNotification(
                if (loop.connectionState.connection == ServerConnection.OFFLINE) "连接失败，稍后重试"
                else "正在重试控制连接（第 ${loop.connectionState.consecutiveFailures} 次）",
            )
        }
    }

    /**
     * S21 §D remote OFF. Returns true when the gateway is being shut down, so the heartbeat cycle ends.
     *
     * Remote OFF is more conservative than the local switch: the request was made by someone who
     * cannot see the phone, and a call may have started between the request and its delivery, so the
     * live call check is repeated here rather than trusted from request time.
     */
    private fun applyRemotePowerOff(runtime: GatewayRuntimeStore): Boolean {
        val at = Instant.now().toString()
        // An unreadable lifecycle reads as "in a call": refusing a power-off is always the safe error.
        val inCall = runCatching { audioLifecycle.hasAnyNonTerminalCall() }.getOrDefault(true)
        GatewayDiag.log("power.standby", mapOf("desiredPower" to "off", "allowed" to !inCall, "reason" to if (inCall) "call_in_progress" else null))
        if (inCall) {
            runCatching {
                runtime.recordPowerResult(
                    powerResultJson("off", ok = false, reason = "call_in_progress", at = at).toString(),
                )
            }
            return false
        }
        runCatching {
            runtime.recordPowerResult(powerResultJson("off", ok = true, reason = null, at = at).toString())
        }
        // Exactly the local OFF path (ACTION_STOP). Never cancel this coroutine's own scope from
        // inside it: the service tears itself down on the main thread like every other stop.
        Handler(Looper.getMainLooper()).post {
            runCatching { GatewayController(this).disable() }
        }
        return true
    }

    /**
     * Starts, keeps or stops the doorbell coroutine for the current announcement. Called only from
     * the heartbeat loop, so at most one loop exists per owned transport.
     */
    @Synchronized private fun ensureCommandDoorbell(
        announcedMaxHoldMs: Int,
        token: String,
        transport: GatewayHttpTransport,
        ownedScope: CoroutineScope,
        runtime: GatewayRuntimeStore,
    ) {
        doorbellMaxHoldMs = announcedMaxHoldMs
        if (!CommandDoorbellPolicy.plan(announcedMaxHoldMs, runtime.enabled, CommandDoorbellState()).run) {
            stopCommandDoorbell(runtime)
            return
        }
        if (doorbellJob?.isActive == true) return
        val generation = doorbellGeneration.incrementAndGet()
        doorbellJob = ownedScope.launch {
            commandDoorbellLoop(generation, token, transport, ownedScope, runtime)
        }
    }

    @Synchronized private fun stopCommandDoorbell(runtime: GatewayRuntimeStore?) {
        doorbellJob?.cancel()
        doorbellJob = null
        doorbellMaxHoldMs = 0
        // Retires the running loop's generation so its late cleanup cannot rewrite the display.
        doorbellGeneration.incrementAndGet()
        runCatching { runtime?.publishCommandDoorbell(CommandDoorbellDisplayState.DISABLED) }
    }

    /**
     * One hanging request at a time. Cancellation cannot interrupt the blocking OkHttp call, so the
     * loop exits at the end of the current hold (at most holdMs + 5 s); that delay is harmless
     * because nothing downstream waits on it.
     */
    private suspend fun commandDoorbellLoop(
        generation: Long,
        token: String,
        transport: GatewayHttpTransport,
        ownedScope: CoroutineScope,
        runtime: GatewayRuntimeStore,
    ) {
        val api = GatewayApi(
            token = token,
            shouldContinue = { runtime.enabled && ownedScope.isActive },
            transport = transport,
        )
        var state = CommandDoorbellState()
        try {
            while (ownedScope.isActive && runtime.enabled) {
                val plan = CommandDoorbellPolicy.plan(doorbellMaxHoldMs, runtime.enabled, state)
                if (!plan.run) break
                if (plan.backoffMs > 0L) {
                    runtime.publishCommandDoorbell(
                        CommandDoorbellDisplayState.BACKOFF, plan.backoffMs, state.lastWakeWallClockMs,
                    )
                    delay(plan.backoffMs)
                    if (!ownedScope.isActive || !runtime.enabled) break
                } else if (CommandDoorbellPolicy.shouldPauseForHeartbeat(lastHeartbeatFailed)) {
                    // A failing heartbeat announces nothing and never drains the pending command.
                    runtime.publishCommandDoorbell(
                        CommandDoorbellDisplayState.RUNNING, 0L, state.lastWakeWallClockMs,
                    )
                    awaitHeartbeatCycleAfter(heartbeatCycles.get())
                    continue
                } else if (CommandDoorbellPolicy.shouldWaitForHeartbeat(state, heartbeatCycles.get())) {
                    // The server answers wake=true while any command is still un-ACKed. Ringing again
                    // before the heartbeat has drained it would spin at one request per round trip.
                    runtime.publishCommandDoorbell(
                        CommandDoorbellDisplayState.RUNNING, 0L, state.lastWakeWallClockMs,
                    )
                    awaitHeartbeatCycleAfter(checkNotNull(state.wakeCycle))
                    state = state.copy(wakeCycle = null)
                    continue
                }
                runtime.publishCommandDoorbell(
                    CommandDoorbellDisplayState.HOLDING, 0L, state.lastWakeWallClockMs,
                )
                val result = try {
                    api.commandDoorbell(plan.holdMs)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (!runtime.enabled || !ownedScope.isActive) break
                    state = CommandDoorbellPolicy.onFailure(state)
                    continue
                }
                state = CommandDoorbellPolicy.onSuccess(
                    state, result.wake, System.currentTimeMillis(), heartbeatCycles.get(),
                )
                if (result.wake) {
                    doorbellWakeAtMs.set(SystemClock.elapsedRealtime())
                    wakeups.trySend(Unit)
                } else if (CommandDoorbellPolicy.serverClosedDoorbell(result)) {
                    // The announcement is stale; let the next heartbeat close the loop properly.
                    runtime.publishCommandDoorbell(
                        CommandDoorbellDisplayState.RUNNING, 0L, state.lastWakeWallClockMs,
                    )
                    delay(CommandDoorbellPolicy.POST_WAKE_SETTLE_MS)
                }
            }
        } catch (_: CancellationException) {
            // The owner is shutting the loop down; the finally block still clears the display.
        } finally {
            // A cancelled loop can only return once its blocking hold ends, which may be after a
            // replacement is already running. Only the current generation owns the display.
            if (doorbellGeneration.get() == generation) {
                runCatching { runtime.publishCommandDoorbell(CommandDoorbellDisplayState.DISABLED) }
            }
        }
    }

    /** Bounded wait for the heartbeat loop to finish the cycle that will collect the woken command. */
    private suspend fun awaitHeartbeatCycleAfter(cycle: Long) {
        val deadline = SystemClock.elapsedRealtime() + CommandDoorbellPolicy.POST_WAKE_SETTLE_MS
        while (heartbeatCycles.get() <= cycle && SystemClock.elapsedRealtime() < deadline) {
            delay(HEARTBEAT_CYCLE_POLL_MS)
        }
    }

    /** Writes connection state only on a real change; repeating a value is what made the UI blink. */
    private fun publishConnection(runtime: GatewayRuntimeStore, connection: ServerConnection, detail: String) {
        if (runtime.connection != connection) runtime.connection = connection
        val bounded = detail.take(180)
        if (runtime.connectionDetail != bounded) runtime.connectionDetail = bounded
    }

    @Synchronized private fun replayStore(identity: GatewayCommandIdentity): GatewayReplayHorizonStore =
        replayStores.getOrPut(identity) { GatewayReplayHorizonStore(this, identity) }

    /**
     * A replay migration briefly needs both the old and the new identity's store, so eviction happens
     * at the top of the next cycle rather than on the switch itself.
     */
    @Synchronized private fun evictForeignReplayStores(current: GatewayCommandIdentity) {
        replayStores.keys.filterNot { it == current }.forEach { key ->
            runCatching { replayStores.remove(key)?.close() }
        }
    }

    @Synchronized private fun closeReplayStores() {
        replayStores.values.forEach { store -> runCatching { store.close() } }
        replayStores.clear()
    }

    private fun stopSafely() {
        val runtime = GatewayRuntimeStore(this)
        runtime.enabled = false
        GatewayInCallAudioBridge.refreshRecordingForeground()
        runtime.connection = ServerConnection.DISABLED
        runtime.connectionDetail = ""
        runtime.resetHeartbeatDiagnostics()
        // A later re-enable must not post the last healthy text before the loop writes its own state.
        notificationText = CONNECTING_NOTIFICATION
        stopCommandDoorbell(runtime)
        closeReplayStores()
        controlTransport.close()
        mediaSetupOwner.close()
        mediaProbeOwner?.close()
        mediaProbeOwner = null
        recordingArchiveOwner?.close()
        recordingArchiveOwner = null
        outgoingSmsObserver?.stop()
        outgoingSmsObserver = null
        loopJob?.cancel()
        loopJob = null
        scope.cancel()
        audioEndpoint.stopAndRelease()
        GatewayAudioLifecycleCleanup.schedule(this, "incomplete")
        GatewayDeviceStatus.stop(this)
        GatewayDiag.log("service.stop", mapOf("reason" to "stopped"))
        GatewayDiag.detach()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopNetworkDiag()
        GatewayDeviceStatus.stop(this)
        GatewayDiag.log("service.stop", mapOf("reason" to "destroyed"))
        GatewayDiag.markCleanShutdown()
        GatewayDiag.detach()
        stopCommandDoorbell(runCatching { GatewayRuntimeStore(this) }.getOrNull())
        closeReplayStores()
        controlTransport.close()
        mediaSetupOwner.close()
        mediaProbeOwner?.close()
        mediaProbeOwner = null
        recordingArchiveOwner?.close()
        recordingArchiveOwner = null
        outgoingSmsObserver?.stop()
        outgoingSmsObserver = null
        loopJob?.cancel()
        scope.cancel()
        audioEndpoint.stopAndRelease()
        if (::audioLifecycle.isInitialized) GatewayAudioLifecycleCleanup.schedule(this, "incomplete")
        val runtime = GatewayRuntimeStore(this)
        // A system kill with START_STICKY restarts us within seconds. Only real silence is a failure.
        if (runtime.enabled) {
            val silentMs = runtime.lastHeartbeatSuccessAtMs
                ?.takeIf { it <= SystemClock.elapsedRealtime() }
                ?.let { SystemClock.elapsedRealtime() - it }
            runtime.connection =
                if (silentMs != null && silentMs < GatewayConnectionTracker.OFFLINE_SILENCE_MS) {
                    ServerConnection.DEGRADED
                } else ServerConnection.OFFLINE
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** S69: memory pressure is a leading indicator of the LMK kills app.killed reports after the fact. */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // UI_HIDDEN is just the admin screen going away, every time; not a signal.
        if (level == TRIM_MEMORY_UI_HIDDEN) return
        GatewayDiag.log("service.trim_memory", mapOf("level" to level),
            level = if (level >= TRIM_MEMORY_RUNNING_LOW) "warn" else "info")
    }

    /** S69: API 35+ FGS time limit. Defensive - Android only enforces it for dataSync/mediaProcessing. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        GatewayDiag.log("service.fgs_timeout", mapOf("startId" to startId, "fgsType" to fgsType), level = "error")
        super.onTimeout(startId, fgsType)
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "网关连接", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_phone_call)
        .setContentTitle("VoDog 网关总控")
        .setContentText(text)
        .setOngoing(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        )
        .build()

    /** Re-posting the same text every 2 s is what made the notification flicker. */
    private fun updateNotification(text: String) {
        if (text == notificationText) return
        notificationText = text
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    private fun newScope() = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        const val ACTION_START = "org.vodog.gateway.START"
        const val ACTION_STOP = "org.vodog.gateway.STOP"
        const val ACTION_TELECOM_CHANGED = "org.vodog.gateway.TELECOM_CHANGED"
        const val ACTION_SMS_CHANGED = "org.vodog.gateway.SMS_CHANGED"
        /** The UI's "立即重试" button: wake the loop and show the attempt immediately. */
        const val ACTION_RETRY_NOW = "org.vodog.gateway.RETRY_NOW"
        private const val CHANNEL_ID = "gateway_connection"
        private const val NOTIFICATION_ID = 701
        private const val CONNECTING_NOTIFICATION = "正在连接控制服务"
        private const val PROBE_FAILURE_RETRY_MS = 10_000L
        private const val MIGRATION_RETRY_MS = 5_000L
        private const val AUTHORIZED_DIAL_GRACE_MS = 10_000L
        private const val HEARTBEAT_CYCLE_POLL_MS = 100L
        /** S36 C3: above this a round trip counts as slow (S69: into heartbeat.summary slowCount). */
        private const val SLOW_HEARTBEAT_MS = 1_500L
        /** S69: only a round trip past this is a warn row of its own. */
        private const val VERY_SLOW_HEARTBEAT_MS = 5_000L
        private val CALL_COMMAND_KINDS = setOf("dial", "answer", "hangup")
    }
}

/**
 * S36 C3: heartbeat rtt min/avg/max, summarised once every 5 minutes. A 2 s cycle would otherwise
 * fill the whole diag ring with healthy round trips.
 */
internal class HeartbeatRttWindow(private val windowMs: Long = 300_000L) {
    private var min = Long.MAX_VALUE
    private var max = 0L
    private var sum = 0L
    private var count = 0L
    private var slowCount = 0L
    private var maxGapMs = 0L
    private var dueAtMs = 0L

    fun sample(rttMs: Long, slow: Boolean = false, gapMs: Long? = null) {
        min = minOf(min, rttMs); max = maxOf(max, rttMs); sum += rttMs; count++
        if (slow) slowCount++
        if (gapMs != null) maxGapMs = maxOf(maxGapMs, gapMs)
    }

    /** The summary fields when the window closed at [nowMs], else null. Reading one starts the next. */
    fun due(nowMs: Long): Map<String, Any?>? {
        if (dueAtMs == 0L) { dueAtMs = nowMs + windowMs; return null }
        if (nowMs < dueAtMs || count == 0L) return null
        val fields = mapOf("count" to count, "minMs" to min, "avgMs" to sum / count, "maxMs" to max,
            "slowCount" to slowCount, "maxGapMs" to maxGapMs)
        min = Long.MAX_VALUE; max = 0L; sum = 0L; count = 0L; slowCount = 0L; maxGapMs = 0L; dueAtMs = nowMs + windowMs
        return fields
    }
}

/** S69: a failure run is reported on its 1st, 3rd and 10th cycle, then every 10th. */
internal fun heartbeatFailureLogged(consecutive: Int): Boolean =
    consecutive == 1 || consecutive == 3 || consecutive == 10 || (consecutive > 10 && consecutive % 10 == 0)

internal fun isCallCommandExecutable(command: GatewayCommand, callExecutionReady: Boolean): Boolean =
    command.kind in setOf("dial", "answer", "hangup") &&
        (callExecutionReady || command.reconciliationOnly)

/** Deferred telecom_call_not_registered must skip that command and continue remaining heartbeat work. */
internal fun shouldBreakHeartbeatForUnhandledCallCommand(): Boolean = false

/** Keeps network/media setup single-flight without ever joining it from the heartbeat command loop. */
internal class MediaReconcileScheduler(private val scope: CoroutineScope) {
    private var job: Job? = null
    @Synchronized fun schedule(block: suspend () -> Unit): Boolean {
        // A cancelled job remains the cleanup owner until its finally blocks complete.
        if (!scope.isActive || job?.isCompleted == false) return false
        job = scope.launch { block() }
        return true
    }
    @Synchronized fun cancelCurrent() { job?.cancel() }
}

/**
 * Decision 2 (S18): while a call or an audio session is alive, media readiness is never withdrawn.
 * No prior-advertised precondition: requiring one turned a single early false into a sticky false
 * that no later call could recover from.
 */
internal fun gatewayCallOrAudioActive(
    exactNonTerminalCall: Boolean,
    anyNonTerminalCall: Boolean,
    authorizedDialTransition: Boolean,
    audioSessionActive: Boolean,
): Boolean = exactNonTerminalCall || anyNonTerminalCall || authorizedDialTransition || audioSessionActive

/** How long accepted reachability evidence keeps counting after its reuse window expired. */
internal const val PROBE_STALE_RETENTION_SECONDS = 300L

/**
 * "陈旧可用": the last accepted probe found a reachable node on this same network generation and is
 * at most five minutes old. A failing refresh no longer matters here; it only shows in diagnostics.
 */
internal fun shouldRetainStaleProbeReadiness(
    lastSuccessful: GatewayProbeReadiness?,
    probeAllowed: Boolean,
    sameNetworkGeneration: Boolean,
    now: Instant,
): Boolean = lastSuccessful?.let { successful ->
    successful.hasReachableNode && probeAllowed && sameNetworkGeneration &&
        !now.isBefore(successful.acceptedAt) &&
        !now.isAfter(successful.acceptedAt.plusSeconds(PROBE_STALE_RETENTION_SECONDS))
} == true

/** One line per cycle, built once so the displayed detail cannot change twice within a heartbeat. */
internal fun gatewayConnectionDetail(
    smsReady: Boolean,
    remoteCallReady: Boolean,
    simsSynced: Int?,
    probeRefreshFailed: Boolean,
    syncFailureDetail: String?,
): String = buildList {
    add("控制通道正常")
    add("短信${if (smsReady) "可用" else "未就绪"}")
    add("远程通话${if (remoteCallReady) "可用" else "尚未就绪"}")
    simsSynced?.let { add("已同步 $it 张 SIM") }
    if (probeRefreshFailed) add("媒体探测刷新失败（已保留既有可达证据）")
    syncFailureDetail?.let { add(it) }
}.joinToString("；").take(180)

internal fun shouldScheduleProbeRefresh(
    shouldProbe: Boolean,
    current: GatewayProbeReadiness?,
    refreshInFlight: Boolean,
    now: Instant,
    retryAllowed: Boolean = true,
): Boolean = shouldProbe && !refreshInFlight && retryAllowed &&
    (current == null || !current.validUntil.isAfter(now.plusSeconds(PROBE_REFRESH_AHEAD_SECONDS)))

internal fun shouldForceProbeRefresh(
    current: GatewayProbeReadiness?,
    explicitProbeFailure: Boolean,
    now: Instant,
): Boolean = explicitProbeFailure ||
    (current != null && !current.validUntil.isAfter(now.plusSeconds(PROBE_REFRESH_AHEAD_SECONDS)))

internal data class ProbeRefreshOutcome(
    val readiness: GatewayProbeReadiness?,
    val failed: Boolean,
)

internal fun CoroutineScope.launchProbeRefresh(
    refresh: suspend () -> GatewayProbeReadiness?,
    onComplete: () -> Unit,
): Deferred<ProbeRefreshOutcome> = async {
    try {
        val readiness = refresh()
        ProbeRefreshOutcome(readiness, readiness?.hasReachableNode != true)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ProbeRefreshOutcome(null, true)
    } finally {
        onComplete()
    }
}
