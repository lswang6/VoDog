package org.vodog.gateway

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SimCard
import androidx.compose.material.icons.filled.VpnKeyOff
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.vodog.gateway.media.GatewayMediaQualityDiagnosticSnapshot
import org.vodog.gateway.media.GatewayProbeDiagnosticSnapshot
import org.vodog.gateway.media.gatewayMediaQualityStageLabel
import org.vodog.gateway.media.readGatewayMediaQualityDiagnostic
import org.vodog.gateway.media.readGatewayProbeDiagnostic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // targetSdk 36 enforces edge-to-edge, so opt in explicitly rather than letting the framework
        // apply it with a scrim we never chose. SystemBarStyle.auto reads the same night-mode flag as
        // isSystemInDarkTheme(), so the bar icon polarity always matches VoDogTheme.
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Opening an already-enabled gateway after an app update must not display a stale ONLINE
        // state. A heartbeat seen within the hysteresis window is not stale, so it is left alone:
        // writing CONNECTING here unconditionally was itself a source of the reported flicker.
        val runtime = GatewayRuntimeStore(this)
        if (runtime.enabled) {
            val silentMs = runtime.lastHeartbeatSuccessAtMs
                ?.takeIf { it <= SystemClock.elapsedRealtime() }
                ?.let { SystemClock.elapsedRealtime() - it }
            if (silentMs == null || silentMs >= GatewayConnectionTracker.OFFLINE_SILENCE_MS) {
                runtime.connection = ServerConnection.CONNECTING
            }
            runCatching { GatewayController(this).enable() }.onSuccess { decision ->
                if (decision != EnableDecision.Allowed) {
                    runtime.enabled = false
                    runtime.connection = ServerConnection.DISABLED
                    runtime.connectionDetail = "权限或配对未满足，请检查后重新开启网关"
                }
            }.onFailure {
                runtime.connection = ServerConnection.OFFLINE
                runtime.connectionDetail = "后台连接未恢复，请重新开启网关"
            }
        }
        // S21 §D self-heal: OFF plus a local remote-power permission always means a live beacon.
        // Opening the app is the one moment this can be re-established from the foreground, which is
        // what recovers a beacon the system killed without a sticky restart.
        if (!runtime.enabled) runCatching { GatewayController(this).startStandbyIfAllowed() }
        setContent { VoDogTheme { GatewayScreen() } }
    }
}

/** One IPC-backed read of everything the screen renders about the device. Never on the main thread. */
private data class GatewaySimRow(
    val slotIndex: Int,
    val displayName: String,
    val carrierName: String,
    val subscriptionId: Int,
    val hasPhoneAccountMapping: Boolean,
    val identityVerified: Boolean,
    val ownership: String,
    val routable: Boolean,
    val answerMode: String,
)

private data class GatewayDeviceSnapshot(
    val requirements: EnableRequirements,
    val loaded: Boolean = false,
    val sims: List<GatewaySimRow> = emptyList(),
    val bindings: List<ServerSimBinding> = emptyList(),
    val networkValidated: Boolean = false,
    /** The slot ↔ protected-handle map the occupancy loop needs; reading it costs telephony IPC. */
    val occupancySims: List<GatewayOccupancySim> = emptyList(),
)

/**
 * Reads SIM identities, bindings, applied settings, network validation and the enable requirements in
 * one pass. `requirements()` decrypts the device credential through the Keystore, so it must not run
 * per recomposition either.
 */
private fun loadGatewayDeviceSnapshot(context: Context, deviceEpoch: Long): GatewayDeviceSnapshot {
    val status = DeviceStatusReader(context)
    val bindings = GatewaySimBindingStore(context).bindings()
    val bySlot = bindings.associateBy(ServerSimBinding::slotIndex)
    val settingsStore = GatewaySettingsStore(context)
    val simSnapshots = runCatching { status.activeSims() }.getOrDefault(emptyList())
    val sims = simSnapshots.map { sim ->
        val binding = bySlot[sim.slotIndex]
        val settings = binding?.let { runCatching { settingsStore.read(it.simId) }.getOrNull() }
            ?.takeIf { it.assignmentVersion == binding.assignmentVersion && it.generation == deviceEpoch }
        GatewaySimRow(
            slotIndex = sim.slotIndex,
            displayName = sim.displayName.ifBlank { "无显示名称" },
            carrierName = sim.carrierName.ifBlank { "未知" },
            subscriptionId = sim.subscriptionId,
            hasPhoneAccountMapping = sim.hasPhoneAccountMapping,
            identityVerified = sim.iccidFingerprint != null,
            ownership = gatewaySimOwnershipLabel(binding),
            routable = binding?.routable == true,
            answerMode = gatewaySimAnswerModeLabel(settings),
        )
    }
    return GatewayDeviceSnapshot(
        requirements = GatewayController(context).requirements(),
        loaded = true,
        sims = sims,
        bindings = bindings,
        networkValidated = runCatching { status.hasValidatedNetwork() }.getOrDefault(false),
        occupancySims = simSnapshots.map { GatewayOccupancySim(it.slotIndex, it.protectedPhoneAccountHandle) },
    )
}

/**
 * The occupancy read on its own, tighter cadence: the journal is a device-protected SharedPreferences
 * file, so unlike [loadGatewayDeviceSnapshot] this touches no telephony IPC and no Keystore. A card
 * titled "当前占用" that appears ten seconds after the phone starts ringing is not worth showing.
 * An unreadable journal is a diagnostic, never a crash — the rest of the screen still renders.
 */
private fun loadGatewayOccupancy(context: Context, sims: List<GatewayOccupancySim>): List<GatewayOccupancyRow> =
    gatewayOccupancyRows(
        runCatching { DeviceCallJournal(context).recordsForSnapshot() }.getOrDefault(emptyList()),
        sims,
    )

/**
 * Every runtime field the hero and the advanced card render, read once per displayed-key change
 * instead of a scattered property read per recomposition. The one-second heartbeat-age tick used to
 * re-enter SharedPreferences for each of these on every frame it caused.
 */
private data class GatewayHeaderUiState(
    val connection: ServerConnection,
    val connectionDetail: String,
    val lastHeartbeatWallClockMs: Long?,
    val consecutiveFailures: Int,
    val lastError: String,
    val gatewayId: String?,
    val deviceEpoch: Long,
    val reportedSequence: Long,
    val doorbellState: CommandDoorbellDisplayState,
    val doorbellBackoffMs: Long,
    val doorbellLastWakeMs: Long?,
    val allowRemotePower: Boolean,
    val standbyState: StandbyDisplayState,
    val standbyBackoffMs: Long,
    val lastPowerResult: String?,
)

private fun GatewayRuntimeStore.headerUiState() = GatewayHeaderUiState(
    connection = connection,
    connectionDetail = connectionDetail,
    lastHeartbeatWallClockMs = lastHeartbeatWallClockMs,
    consecutiveFailures = consecutiveHeartbeatFailures,
    lastError = lastHeartbeatError,
    gatewayId = gatewayId,
    deviceEpoch = deviceEpoch,
    reportedSequence = reportedSequence,
    doorbellState = commandDoorbellState,
    doorbellBackoffMs = commandDoorbellBackoffMs,
    doorbellLastWakeMs = commandDoorbellLastWakeMs,
    allowRemotePower = allowRemotePower,
    standbyState = standbyState,
    standbyBackoffMs = standbyBackoffMs,
    lastPowerResult = pendingPowerResult,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GatewayScreen() {
    val context = LocalContext.current
    val runtime = remember { GatewayRuntimeStore(context) }
    val controller = remember { GatewayController(context) }
    val adminSession = remember { GatewayAdminSession() }
    val adminApi = remember { GatewayAdminApi(controlEnabled = { runtime.enabled }) }
    val scope = rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    var message by rememberSaveable { mutableStateOf("") }
    var pairCode by rememberSaveable { mutableStateOf("") }
    var deviceLabel by rememberSaveable { mutableStateOf("Pixel ${Build.MODEL}") }
    var pairing by rememberSaveable { mutableStateOf(false) }
    var identityChanging by rememberSaveable { mutableStateOf(false) }
    // Seeded once so the first frame is already correct; every later read happens off the main thread.
    var snapshot by remember { mutableStateOf(GatewayDeviceSnapshot(controller.requirements())) }
    var refreshTick by remember { mutableIntStateOf(0) }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    // Exactly one confirmation can be open, so its state belongs to the screen, not to either caller.
    var dangerConfirm by remember { mutableStateOf<GatewayDangerConfirm?>(null) }
    var opus by remember { mutableStateOf(OpusCodecSnapshot(emptyList(), emptyList(), false, false)) }
    var occupancy by remember { mutableStateOf(emptyList<GatewayOccupancyRow>()) }

    // Only keys this screen renders may force a recomposition. The heartbeat also commits snapshot
    // sequences and journals to the same file; those used to recompose the whole screen every cycle.
    DisposableEffect(runtime) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == null || key in GatewayRuntimeStore.DISPLAYED_KEYS) revision++
        }
        runtime.register(listener)
        onDispose {
            runtime.unregister(listener)
            adminApi.close()
        }
    }

    // The heartbeat-age line is the only thing that needs a clock. It reads a persisted timestamp,
    // never an IPC.
    LaunchedEffect(Unit) {
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
    }

    LaunchedEffect(refreshTick) {
        while (true) {
            val epoch = runtime.deviceEpoch
            snapshot = withContext(Dispatchers.IO) { loadGatewayDeviceSnapshot(context, epoch) }
            delay(10_000)
        }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refreshTick++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        revision++
        refreshTick++
    }

    // MediaCodecList enumerates every system codec over IPC; that never belonged on the main thread.
    LaunchedEffect(Unit) {
        opus = withContext(Dispatchers.IO) { runCatching { CodecCapabilityReader.probe() }.getOrDefault(opus) }
    }

    LaunchedEffect(snapshot.occupancySims) {
        while (true) {
            occupancy = withContext(Dispatchers.IO) { loadGatewayOccupancy(context, snapshot.occupancySims) }
            delay(OCCUPANCY_REFRESH_MS)
        }
    }

    val requirements = snapshot.requirements
    val enabled = runtime.enabled
    // One immutable read per displayed-key change, shared by the hero and the advanced card.
    val header = remember(revision) { runtime.headerUiState() }
    val connection = when {
        !requirements.paired -> ServerConnection.UNPAIRED
        !enabled -> ServerConnection.DISABLED
        else -> header.connection
    }
    val busySlots = remember(occupancy) { occupancy.mapNotNull(GatewayOccupancyRow::slotIndex).toSet() }

    dangerConfirm?.let { confirm ->
        GatewayDangerConfirmDialog(
            title = confirm.title,
            body = confirm.body,
            confirmLabel = confirm.confirmLabel,
            onConfirm = confirm.onConfirm,
            onDismiss = { dangerConfirm = null },
        )
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("VoDog 网关") }) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            // Edge-to-edge: the list scrolls under the navigation bar instead of stopping above it.
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = padding.calculateTopPadding() + 16.dp,
                bottom = padding.calculateBottomPadding() + 16.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                HeroStatusCard(
                    connection = connection,
                    enabled = enabled,
                    subtitle = gatewayHeroSubtitle(
                        gatewayHeartbeatAgeText(header.lastHeartbeatWallClockMs, nowMs),
                        connection,
                    ),
                    capabilities = gatewayCapabilityPills(header.connectionDetail),
                    consecutiveFailures = header.consecutiveFailures,
                    lastError = header.lastError,
                    switchEnabled = !identityChanging && !pairing,
                    allowRemotePower = header.allowRemotePower,
                    standbySummary = gatewayStandbySummary(
                        header.allowRemotePower, enabled, header.standbyState, header.standbyBackoffMs,
                    ),
                    onToggleRemotePower = { allowed ->
                        message = ""
                        controller.setAllowRemotePower(allowed)
                        message = if (allowed) "已允许远程开启：关闭总控后保留一条待命请求"
                        else "已关闭远程开启：关闭总控后不再连接控制服务"
                        revision++
                        refreshTick++
                    },
                    onRetry = {
                        ContextCompat.startForegroundService(
                            context,
                            Intent(context, GatewayForegroundService::class.java)
                                .setAction(GatewayForegroundService.ACTION_RETRY_NOW),
                        )
                        revision++
                    },
                    onToggle = { requested ->
                        message = ""
                        if (requested) {
                            when (val result = controller.enable()) {
                                EnableDecision.Allowed -> Unit
                                is EnableDecision.Blocked -> message = result.reason
                            }
                            revision++
                            refreshTick++
                        } else {
                            dangerConfirm = GatewayDangerConfirm(
                                title = "关闭远端总控？",
                                body = listOfNotNull(
                                    gatewayOccupancyInterruptionWarning(occupancy),
                                    "关闭后这台 Pixel 只能本机接打电话和收发短信，账号下的其他设备将无法远程使用它。",
                                ).joinToString(""),
                                confirmLabel = "关闭总控",
                                onConfirm = {
                                    adminApi.cancelAll()
                                    adminSession.clear()
                                    controller.disable()
                                    message = "网关已关闭"
                                    revision++
                                    refreshTick++
                                },
                            )
                        }
                    },
                )
            }

            if (occupancy.isNotEmpty()) item { OccupancyCard(occupancy, nowMs) }

            if (message.isNotBlank()) item { StatusMessage(message) }

            if (!requirements.actionRuntimePermissions || !requirements.notificationPermission ||
                !requirements.privilegedTelephony
            ) {
                item {
                    SectionCard("权限", subtitle = "远程网关需要电话、短信、音频和通知权限") {
                        StatusRow("电话状态权限", if (requirements.phonePermission) "已授权" else "未授权")
                        StatusRow("系统电话特权", if (requirements.privilegedTelephony) "已授予" else "未授予")
                        StatusRow("运行权限", if (requirements.actionRuntimePermissions) "已授权" else "未完整授权")
                        StatusRow("通知权限", if (requirements.notificationPermission) "已授权" else "未授权")
                        Spacer(Modifier.height(4.dp))
                        Button(
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            onClick = { permissionLauncher.launch(gatewayRuntimePermissions()) },
                        ) { Text("检查并申请权限") }
                    }
                }
            }

            when {
                !requirements.phonePermission -> item {
                    SectionCard("SIM 通道") { Text("授权后读取系统真实 SIM；当前不显示占位数据") }
                }
                !snapshot.loaded -> item { SectionCard("SIM 通道") { Text("正在读取系统 SIM…") } }
                snapshot.sims.isEmpty() -> item {
                    SectionCard("SIM 通道") { Text("系统未返回活动 SIM") }
                }
                else -> items(snapshot.sims) { sim ->
                    SimChannelCard(sim, busy = sim.slotIndex in busySlots)
                }
            }

            item {
                NetworkAndMediaCard(
                    networkValidated = snapshot.networkValidated,
                    connection = connection,
                    connectionDetail = header.connectionDetail,
                    opus = opus,
                    refreshTick = refreshTick,
                )
            }

            item {
                AdvancedCard(
                    runtime = runtime,
                    header = header,
                    paired = requirements.paired,
                    refreshTick = refreshTick,
                    nowMs = nowMs,
                    onCopy = { label, value ->
                        copyToClipboard(context, label, value)
                        message = "$label 已复制"
                    },
                )
            }

            if (enabled) item {
                ExpandableSectionCard("账号归属（管理员）", summary = "登录后可改派 SIM 归属，不会自动改派") {
                    GatewayAdminRoutingPanel(
                        api = adminApi,
                        session = adminSession,
                        localBindings = snapshot.bindings,
                        controlEnabled = { runtime.enabled },
                    )
                }
            }

            item {
                SectionCard("设备凭据") {
                    Text("输入管理员发放的一次性配对码。长期设备凭据只写入 Android Keystore，不在界面显示。")
                    Spacer(Modifier.height(4.dp))
                    if (!requirements.paired) {
                        OutlinedTextField(
                            value = pairCode,
                            onValueChange = { pairCode = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("一次性配对码") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        )
                        OutlinedTextField(
                            value = deviceLabel,
                            onValueChange = { deviceLabel = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("设备标签") },
                            singleLine = true,
                        )
                        Spacer(Modifier.height(4.dp))
                        Button(
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            onClick = {
                                if (pairCode.isBlank() || deviceLabel.isBlank()) {
                                    message = "配对码和设备标签不能为空"
                                } else {
                                    pairing = true
                                    message = ""
                                    scope.launch {
                                        runCatching {
                                            withContext(Dispatchers.IO) {
                                                controller.pairSafely(pairCode.trim(), deviceLabel.trim())
                                            }
                                        }.onSuccess { result ->
                                            pairCode = ""
                                            runtime.connection = ServerConnection.DISABLED
                                            message = "已配对 ${result.gatewayId}；总控仍保持关闭"
                                            revision++
                                            refreshTick++
                                        }.onFailure { error ->
                                            message = error.message ?: "配对失败"
                                        }
                                        pairing = false
                                    }
                                }
                            },
                            enabled = !pairing && !identityChanging,
                        ) { Text(if (pairing) "正在配对…" else "使用一次性配对码") }
                    } else {
                        OutlinedButton(
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            colors = ButtonDefaults.outlinedButtonColors(
                                contentColor = MaterialTheme.colorScheme.error,
                            ),
                            onClick = {
                                dangerConfirm = GatewayDangerConfirm(
                                    title = "移除设备凭据？",
                                    body = listOfNotNull(
                                        gatewayOccupancyInterruptionWarning(occupancy),
                                        "移除后这台 Pixel 立刻脱离账号，需要管理员重新发放一次性配对码才能恢复远程服务。",
                                    ).joinToString(""),
                                    confirmLabel = "移除凭据",
                                    onConfirm = {
                                        identityChanging = true
                                        message = "正在核验本机状态…"
                                        scope.launch {
                                            runCatching {
                                                withContext(Dispatchers.IO) { controller.removeCredentialSafely() }
                                            }
                                                .onSuccess {
                                                    adminApi.cancelAll()
                                                    adminSession.clear()
                                                    message = "凭据已移除，网关保持离线"
                                                    revision++
                                                    refreshTick++
                                                }
                                                .onFailure { error ->
                                                    message = error.message ?: "无法安全移除设备凭据"
                                                }
                                            identityChanging = false
                                        }
                                    },
                                )
                            },
                            enabled = !identityChanging && !pairing,
                        ) { Text("移除设备凭据") }
                        Text(
                            "请先关闭远端总控，等待电话和待同步记录处理完毕",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun HeroStatusCard(
    connection: ServerConnection,
    enabled: Boolean,
    subtitle: String,
    capabilities: List<String>,
    consecutiveFailures: Int,
    lastError: String,
    switchEnabled: Boolean,
    allowRemotePower: Boolean,
    standbySummary: String,
    onToggleRemotePower: (Boolean) -> Unit,
    onRetry: () -> Unit,
    onToggle: (Boolean) -> Unit,
) {
    val colors = gatewayConnectionColors(connection)
    val container = colors.container
    val onContainer = colors.onContainer
    val icon: ImageVector? = when (connection) {
        ServerConnection.ONLINE -> Icons.Filled.CheckCircle
        ServerConnection.DEGRADED -> Icons.Filled.Warning
        ServerConnection.OFFLINE -> Icons.Filled.CloudOff
        ServerConnection.CONNECTING -> null
        ServerConnection.DISABLED -> Icons.Filled.PowerSettingsNew
        ServerConnection.UNPAIRED -> Icons.Filled.VpnKeyOff
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = GATEWAY_CARD_SHAPE,
        colors = CardDefaults.cardColors(containerColor = container, contentColor = onContainer),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    modifier = Modifier.size(44.dp),
                    shape = CircleShape,
                    color = onContainer.copy(alpha = 0.12f),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        if (icon == null) {
                            CircularProgressIndicator(modifier = Modifier.size(22.dp), color = onContainer)
                        } else {
                            Icon(
                                imageVector = icon,
                                contentDescription = "连接状态：${connection.label}",
                                tint = onContainer,
                            )
                        }
                    }
                }
                Spacer(Modifier.width(14.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(connection.label, style = MaterialTheme.typography.headlineSmall)
                    Text(
                        subtitle,
                        style = MaterialTheme.typography.bodyMedium,
                        color = onContainer.copy(alpha = 0.8f),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Switch(
                    checked = enabled,
                    enabled = switchEnabled,
                    onCheckedChange = onToggle,
                    modifier = Modifier.semantics { contentDescription = "远端总控开关" },
                )
            }
            if (capabilities.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    capabilities.forEach { capability ->
                        StatusPill(
                            capability,
                            container = onContainer.copy(alpha = 0.12f),
                            content = onContainer,
                        )
                    }
                }
            }
            Text(
                if (enabled) "远端总控开启：按各 SIM 的账号分配和接听设置提供远程服务"
                else "远端总控关闭：使用 Pixel 本机接打电话和收发短信",
                style = MaterialTheme.typography.bodySmall,
                color = onContainer.copy(alpha = 0.75f),
                modifier = Modifier.padding(top = 10.dp),
            )
            // S21 §D. The beacon is the single controlled exception to "关闭后不再连接 VPS", so the
            // switch that opens it sits next to the master switch and says exactly what it keeps open.
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("允许远程开启（待命）", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "关闭总控后，仅保留一条经设备凭据鉴权的待命请求到控制服务，用于远程重新开启。",
                        style = MaterialTheme.typography.bodySmall,
                        color = onContainer.copy(alpha = 0.75f),
                    )
                    Text(
                        "该请求不携带电话、短信、媒体或 SIM 数据；关掉此开关即恢复“关闭后零外连”。",
                        style = MaterialTheme.typography.bodySmall,
                        color = onContainer.copy(alpha = 0.75f),
                    )
                    Text(
                        standbySummary,
                        style = MaterialTheme.typography.bodySmall,
                        color = onContainer.copy(alpha = 0.6f),
                    )
                }
                Switch(
                    checked = allowRemotePower,
                    enabled = switchEnabled,
                    onCheckedChange = onToggleRemotePower,
                    modifier = Modifier.semantics { contentDescription = "允许远程开启网关开关" },
                )
            }
            if (connection == ServerConnection.DEGRADED || connection == ServerConnection.OFFLINE) {
                Spacer(Modifier.height(6.dp))
                Text(
                    // A sustained outage and a retry in progress must not read alike.
                    GatewayConnectionTracker.failureHeadline(connection, consecutiveFailures),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (lastError.isNotBlank()) {
                    Text(
                        lastError,
                        style = MaterialTheme.typography.bodySmall,
                        color = onContainer.copy(alpha = 0.75f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                TextButton(
                    onClick = onRetry,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, tint = onContainer)
                    Spacer(Modifier.width(8.dp))
                    Text("立即重试", color = onContainer)
                }
            }
        }
    }
}

/**
 * S20 D7 "当前占用". Rendered only while a call is live, so an idle gateway keeps its short screen.
 * The client platform holding the call is intentionally missing: it is not knowable on the device.
 */
@Composable
private fun OccupancyCard(rows: List<GatewayOccupancyRow>, nowMs: Long) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = GATEWAY_CARD_SHAPE,
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        ),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.PhoneInTalk, contentDescription = null)
                Spacer(Modifier.width(10.dp))
                Text("当前占用", style = MaterialTheme.typography.titleMedium)
            }
            rows.forEach { row ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(gatewayOccupancyLine(row, nowMs), style = MaterialTheme.typography.bodyMedium)
                    // The journal holds the full number; only the last four digits may be displayed.
                    Text(
                        row.maskedNumber ?: "号码未知",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
            Text(
                "以 Pixel 系统电话状态为准；结束通话后占用会自动解除。",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun SimChannelCard(sim: GatewaySimRow, busy: Boolean) {
    Card(modifier = Modifier.fillMaxWidth(), shape = GATEWAY_CARD_SHAPE) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.SimCard,
                    contentDescription = "SIM 卡槽 ${sim.slotIndex + 1}",
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text("SIM ${sim.slotIndex + 1} · ${sim.displayName}", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "运营商：${sim.carrierName}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusPill(
                    sim.ownership,
                    container = if (sim.routable) MaterialTheme.colorScheme.primaryContainer
                    else MaterialTheme.colorScheme.surfaceVariant,
                    content = if (sim.routable) MaterialTheme.colorScheme.onPrimaryContainer
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                StatusPill(sim.answerMode)
                if (busy) {
                    StatusPill(
                        "通话中",
                        container = MaterialTheme.colorScheme.tertiaryContainer,
                        content = MaterialTheme.colorScheme.onTertiaryContainer,
                    )
                }
            }
            if (!sim.identityVerified) {
                Text(
                    "稳定身份：未核实（slot/subId 不用于自动分配）",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            if (!sim.hasPhoneAccountMapping) {
                // Without a PhoneAccountHandle neither dial nor answer can be routed to this slot.
                Text(
                    "系统未建立电话账户映射，暂不可远程接听/拨号",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun NetworkAndMediaCard(
    networkValidated: Boolean,
    connection: ServerConnection,
    connectionDetail: String,
    opus: OpusCodecSnapshot,
    refreshTick: Int,
) {
    val context = LocalContext.current
    var probe by remember { mutableStateOf<GatewayProbeDiagnosticSnapshot?>(null) }
    var quality by remember { mutableStateOf<GatewayMediaQualityDiagnosticSnapshot?>(null) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(refreshTick) {
        while (true) {
            val read = withContext(Dispatchers.IO) {
                readGatewayProbeDiagnostic(context) to readGatewayMediaQualityDiagnostic(context)
            }
            probe = read.first
            quality = read.second
            loaded = true
            delay(10_000)
        }
    }
    ExpandableSectionCard(
        "网络与媒体",
        summary = if (networkValidated) "系统网络已验证可用" else "系统网络不可用或未验证",
    ) {
        StatusRow("系统网络", if (networkValidated) "已验证可用" else "不可用或未验证")
        StatusRow("控制连接", connection.label)
        StatusRow("蜂窝音频构建", if (GatewayPhoneFeatureApproval.APPROVED) "支持远程通话" else "此构建尚未开放")
        // Only the segments the hero does not already show as capability pills.
        gatewayConnectionDetailExtras(connectionDetail).forEach { extra ->
            Text(
                extra,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(4.dp))
        Text("媒体节点可达性探测", style = MaterialTheme.typography.titleSmall)
        when {
            !loaded -> Text("正在读取…", style = MaterialTheme.typography.bodySmall)
            probe == null -> Text(
                "尚无探测记录",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> probe?.let { snapshot ->
                val now = Instant.now()
                StatusRow("阶段", snapshot.stage)
                StatusRow(
                    "探测选项请求",
                    "${snapshot.optionsStatus}${snapshot.optionsDurationMs?.let { " · $it ms" }.orEmpty()}",
                )
                StatusRow(
                    "探测结果回报",
                    "${snapshot.resultsStatus}${snapshot.resultsDurationMs?.let { " · $it ms" }.orEmpty()}",
                )
                StatusRow("本地可达", if (snapshot.localReady) "是" else "否")
                // Expiring evidence is still valid; expired or missing evidence means no media readiness.
                StatusRow(
                    "证据",
                    gatewayProbeValidityText(snapshot.validUntil, now),
                    valueColor = gatewayProbeFreshnessColor(gatewayProbeFreshness(snapshot.validUntil, now)),
                )
                if (snapshot.nodeOutcomes.isEmpty()) {
                    Text(
                        "本次未取得逐节点结果",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    snapshot.nodeOutcomes.forEach { outcome ->
                        Text(
                            gatewayProbeNodeLine(outcome),
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text("中继质量探测", style = MaterialTheme.typography.titleSmall)
        StatusRow("状态", gatewayMediaQualityStageLabel(quality?.stage))
        quality?.nodes?.forEach { node ->
            Text(
                "${node.nodeId}：${node.outcome} · 发 ${node.sent} 收 ${node.received}" +
                    (node.rttP95Ms?.let { " · RTT p95 ${it.toInt()} ms" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(4.dp))
        StatusRow("Opus 16 kHz 编码", if (opus.supports16kMonoEncode) "支持" else "未报告支持")
        StatusRow("Opus 16 kHz 解码", if (opus.supports16kMonoDecode) "支持" else "未报告支持")
        Text(
            "编码器：${opus.encoderNames.joinToString().ifBlank { "无" }}",
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "解码器：${opus.decoderNames.joinToString().ifBlank { "无" }}",
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun AdvancedCard(
    runtime: GatewayRuntimeStore,
    header: GatewayHeaderUiState,
    paired: Boolean,
    refreshTick: Int,
    nowMs: Long,
    onCopy: (String, String) -> Unit,
) {
    val context = LocalContext.current
    var replaySummary by remember { mutableStateOf<String?>(null) }
    // The replay fence lives in SQLite. Reading it on the main thread would block the frame.
    LaunchedEffect(refreshTick) {
        replaySummary = withContext(Dispatchers.IO) {
            if (!GatewayReplayHorizonApproval.ENABLED) "此构建未开启命令回放围栏"
            else runCatching {
                val identity = runtime.activeCommandIdentity() ?: return@runCatching null
                val store = GatewayReplayHorizonStore(context, identity)
                try { gatewayReplayHorizonSummary(store.state()) } finally { store.close() }
            }.getOrNull() ?: gatewayReplayHorizonSummary(null)
        }
    }
    val gatewayId = header.gatewayId
    ExpandableSectionCard("高级", summary = "设备身份、命令门铃、回放围栏与构建开关") {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 48.dp)
                .clickable(enabled = gatewayId != null) { gatewayId?.let { onCopy("网关 ID", it) } }
                .semantics { contentDescription = "复制网关 ID" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("网关 ID", style = MaterialTheme.typography.bodyMedium)
                Text(
                    gatewayId ?: if (paired) "等待服务端确认" else "未配对",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (gatewayId != null) {
                Icon(
                    Icons.Filled.ContentCopy,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        StatusRow("设备世代 epoch", header.deviceEpoch.takeIf { it > 0 }?.toString() ?: "未配对")
        StatusRow("已上报序号", header.reportedSequence.toString())
        StatusRow("连续失败次数", header.consecutiveFailures.toString())
        // S20 D4: confirming the doorbell must not require logcat.
        StatusRow(
            "命令门铃",
            gatewayCommandDoorbellSummary(
                header.doorbellState, header.doorbellBackoffMs, header.doorbellLastWakeMs, nowMs,
            ),
        )
        StatusRow("回放围栏", replaySummary ?: "正在读取…")
        // S21 §D: confirming the beacon and the last remote power outcome must not require logcat.
        StatusRow("远程开启", if (header.allowRemotePower) "已允许（本机）" else "未允许")
        StatusRow(
            "待命信标",
            gatewayStandbySummary(
                header.allowRemotePower, runtime.enabled, header.standbyState, header.standbyBackoffMs,
            ).removePrefix("当前状态："),
        )
        StatusRow("远程开关结果", gatewayPowerResultSummary(header.lastPowerResult))
        Spacer(Modifier.height(4.dp))
        Text("构建开关", style = MaterialTheme.typography.titleSmall)
        StatusRow("蜂窝验收", gatewayBuildGateLabel(BuildConfig.CELLULAR_ACCEPTANCE_ENABLED))
        StatusRow("录音归档", gatewayBuildGateLabel(BuildConfig.RECORDING_ARCHIVE_ENABLED))
        StatusRow("libopus FEC", gatewayBuildGateLabel(BuildConfig.LIBOPUS_FEC_ENABLED))
        StatusRow("接收恢复", gatewayBuildGateLabel(BuildConfig.RECEIVE_RECOVERY_ENABLED))
        StatusRow("命令回放围栏", gatewayBuildGateLabel(BuildConfig.COMMAND_REPLAY_HORIZON_ENABLED))
        StatusRow("应用版本", BuildConfig.VERSION_NAME)
        if (header.lastError.isNotBlank()) {
            Text(
                "最近连接错误：${header.lastError}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun copyToClipboard(context: Context, label: String, value: String) {
    runCatching {
        context.getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText(label, value))
    }
}

private fun gatewayRuntimePermissions(): Array<String> = buildList {
    add(Manifest.permission.READ_PHONE_STATE)
    add(Manifest.permission.READ_PHONE_NUMBERS)
    add(Manifest.permission.CALL_PHONE)
    if (Build.VERSION.SDK_INT >= 26) add(Manifest.permission.ANSWER_PHONE_CALLS)
    add(Manifest.permission.READ_CALL_LOG)
    add(Manifest.permission.WRITE_CALL_LOG)
    add(Manifest.permission.SEND_SMS)
    add(Manifest.permission.READ_SMS)
    add(Manifest.permission.RECEIVE_SMS)
    add(Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
}.toTypedArray()

/** Journal-only, no IPC: cheap enough to run while the screen is visible. */
private const val OCCUPANCY_REFRESH_MS = 2_000L

/** A pending destructive action. Only the screen owns one, so two dialogs can never overlap. */
private data class GatewayDangerConfirm(
    val title: String,
    val body: String,
    val confirmLabel: String,
    val onConfirm: () -> Unit,
)

/**
 * S20 D7 — explicit semantic colours for the three connection states.
 *
 * ONLINE/DEGRADED/OFFLINE used to borrow primary/tertiary/error containers. Under dynamic colour a
 * user's wallpaper can make primary and tertiary nearly the same hue, which is exactly the pair that
 * has to stay distinguishable. These are fixed green/amber/red tonal pairs with a light and a dark
 * variant, chosen to sit at container-level tone so they still read as Material surfaces next to the
 * dynamic scheme. The redundant status icon is kept: colour is never the only signal.
 */
internal data class GatewayStatusColors(val container: Color, val onContainer: Color)

private val GATEWAY_ONLINE_LIGHT = GatewayStatusColors(Color(0xFFD2F0D9), Color(0xFF0B3620))
private val GATEWAY_ONLINE_DARK = GatewayStatusColors(Color(0xFF1E4D33), Color(0xFFB6EFC7))
private val GATEWAY_DEGRADED_LIGHT = GatewayStatusColors(Color(0xFFFFE3B8), Color(0xFF432B06))
private val GATEWAY_DEGRADED_DARK = GatewayStatusColors(Color(0xFF50380F), Color(0xFFFFDFB0))
private val GATEWAY_OFFLINE_LIGHT = GatewayStatusColors(Color(0xFFFFDAD5), Color(0xFF48120C))
private val GATEWAY_OFFLINE_DARK = GatewayStatusColors(Color(0xFF632019), Color(0xFFFFDAD5))

/** Foreground-only variants for text drawn on the plain surface rather than in a container. */
private val GATEWAY_WARNING_ON_SURFACE_LIGHT = Color(0xFF855200)
private val GATEWAY_WARNING_ON_SURFACE_DARK = Color(0xFFFFC46B)

@Composable
private fun gatewayConnectionColors(connection: ServerConnection): GatewayStatusColors {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val scheme = MaterialTheme.colorScheme
    return when (connection) {
        ServerConnection.ONLINE -> if (dark) GATEWAY_ONLINE_DARK else GATEWAY_ONLINE_LIGHT
        ServerConnection.DEGRADED -> if (dark) GATEWAY_DEGRADED_DARK else GATEWAY_DEGRADED_LIGHT
        ServerConnection.OFFLINE -> if (dark) GATEWAY_OFFLINE_DARK else GATEWAY_OFFLINE_LIGHT
        // The neutral states stay on the dynamic scheme: they carry no semantic colour.
        ServerConnection.CONNECTING -> GatewayStatusColors(scheme.surfaceVariant, scheme.onSurfaceVariant)
        ServerConnection.DISABLED, ServerConnection.UNPAIRED ->
            GatewayStatusColors(scheme.surface, scheme.onSurface)
    }
}

@Composable
private fun gatewayProbeFreshnessColor(freshness: GatewayProbeFreshness): Color {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    return when (freshness) {
        GatewayProbeFreshness.FRESH -> MaterialTheme.colorScheme.onSurfaceVariant
        GatewayProbeFreshness.EXPIRING ->
            if (dark) GATEWAY_WARNING_ON_SURFACE_DARK else GATEWAY_WARNING_ON_SURFACE_LIGHT
        GatewayProbeFreshness.EXPIRED, GatewayProbeFreshness.UNKNOWN -> MaterialTheme.colorScheme.error
    }
}

@Composable
private fun VoDogTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val scheme = when {
        Build.VERSION.SDK_INT >= 31 && dark -> dynamicDarkColorScheme(context)
        Build.VERSION.SDK_INT >= 31 -> dynamicLightColorScheme(context)
        dark -> darkColorScheme(
            primary = Color(0xFFADC6FF),
            secondary = Color(0xFF8FD5CF),
            tertiary = Color(0xFFE7BA6B),
        )
        else -> lightColorScheme(
            primary = Color(0xFF2457C5),
            secondary = Color(0xFF147D78),
            tertiary = Color(0xFF7A5900),
            error = Color(0xFFBC3347),
        )
    }
    MaterialTheme(colorScheme = scheme, content = content)
}
