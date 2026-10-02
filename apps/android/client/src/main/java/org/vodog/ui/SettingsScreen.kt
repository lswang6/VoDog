package org.vodog

import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Autorenew
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import org.json.JSONObject
import kotlin.math.roundToInt

@Composable
internal fun SettingsPage(
    state: ClientUiState,
    model: ClientViewModel,
    passkeys: PasskeyCredentialProvider,
    onDetailVisible: (Boolean) -> Unit,
) {
    val context = LocalContext.current
    var selectedSimId by rememberSaveable { mutableStateOf<String?>(null) }
    var managingBlocklist by rememberSaveable { mutableStateOf(false) }
    val settingsListState = rememberLazyListState()
    var notificationsAllowed by remember { mutableStateOf(canShowCallNotification(context)) }
    var microphoneAllowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
    }
    // S72 D3: 可选权限——没给也能用（退回音频模式判断），给了才能准确识别「手机正在打普通电话」。
    var phoneStateAllowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED)
    }
    val phoneStatePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { phoneStateAllowed = it }
    val backgroundPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationsAllowed = canShowCallNotification(context)
        microphoneAllowed = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (model.state.value.networkAvailable) model.refreshBackgroundCalling()
    }
    val sims = (state.sims as? RemoteList.Loaded)?.items.orEmpty()
    val displayedSims = if (state.networkAvailable) sims.sortedByDescending { it.optBoolean("online") } else sims
    val selectedSim = sims.singleOrNull { it.optString("id") == selectedSimId }
    var renaming by remember { mutableStateOf<PasskeyItem?>(null) }
    var deleting by remember { mutableStateOf<PasskeyItem?>(null) }
    var unblocking by remember { mutableStateOf<JSONObject?>(null) }
    // The list is only fetched once per signed-in session; the tab can be revisited freely.
    LaunchedEffect(state.session?.username, state.networkAvailable) { if (state.session != null && state.networkAvailable) model.loadPasskeys() }
    // S24 决策 3: the 设置 body is disposed when the tab changes, so this is exactly "重进页面重新加载".
    LaunchedEffect(state.session?.username, state.networkAvailable) { if (state.session != null && state.networkAvailable) model.loadVoiceProviders() }
    // S21 §D: /gateways/power every 5 s, and only while 设置 is on screen — the same start/stop
    // ticker the calls tab uses, so leaving the tab costs nothing.
    LifecycleStartEffect(Unit) {
        model.startForegroundRefresh(ClientRefreshScope.SETTINGS)
        model.startGatewayPowerRefresh()
        onStopOrDispose {
            model.stopForegroundRefresh(ClientRefreshScope.SETTINGS)
            model.stopGatewayPowerRefresh()
        }
    }
    LaunchedEffect(selectedSim != null, managingBlocklist) {
        onDetailVisible(selectedSim != null || managingBlocklist)
    }
    if (selectedSim != null) {
        BackHandler { selectedSimId = null }
        SimDetailPage(selectedSim, state, model) { selectedSimId = null }
        return
    }
    Box(Modifier.fillMaxSize()) {
        if (managingBlocklist) {
            BackHandler { managingBlocklist = false }
            BlocklistPage(
                state = state,
                model = model,
                onBack = { managingBlocklist = false },
                onUnblock = { unblocking = it },
            )
        } else LazyColumn(
            Modifier.fillMaxSize().testTag("settings.list"),
            state = settingsListState,
            // S68: first item is InlineSectionHeader (own 4 dp top), so the text lands 8 dp under the header.
            contentPadding = PaddingValues(start = ScreenPadding, top = 4.dp, end = ScreenPadding, bottom = ScreenPadding),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
        item { InlineSectionHeader("外观") }
        item { AppearancePicker() }
        item { InlineSectionHeader("角标") }
        item {
            BadgeSettingsSection(model, needsPermission = !notificationsAllowed && Build.VERSION.SDK_INT >= 33) {
                backgroundPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        item { InlineSectionHeader("账号") }
        item {
            SettingsCard {
                SettingsRow("用户名", state.session?.username ?: "未登录")
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow("角色", roleDisplayLabel(state.session?.role.orEmpty()))
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow("当前会话", "Android App")
            }
        }
        item { InlineSectionHeader("SIM 与接听模式") }
        when (val simState = state.sims) {
            RemoteList.NotLoaded, RemoteList.Loading -> item { LoadingRow("正在读取号码…") }
            is RemoteList.Failed -> item {
                SettingsRetryRow(
                    message = "号码读取失败：${simState.message}",
                    onRetry = model::retrySettingsSims,
                    tag = "settings.sims.retry",
                )
            }
            is RemoteList.Loaded -> if (sims.isEmpty()) {
                item { EmptyCard("没有已分配的 SIM", Modifier) }
            } else items(displayedSims, key = { it.optString("id") }) { sim ->
            val settings = sim.optJSONObject("settings") ?: JSONObject()
            Card(
                onClick = { selectedSimId = sim.optString("id") },
                modifier = Modifier.fillMaxWidth().testTag("settings.sim.${sim.optString("id")}"),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                ListItem(
                    modifier = Modifier.heightIn(min = TouchTarget),
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    headlineContent = {
                        Text(
                            sim.optString("phoneLabel").takeIf { it.isNotBlank() && it != "null" }
                                ?: sim.optString("label", "SIM"),
                            style = MaterialTheme.typography.titleMedium,
                        )
                    },
                    supportingContent = {
                        Column {
                            Text(
                                "${sim.optString("label", "SIM")} · ${simConnectionLabel(state.networkAvailable, sim.optBoolean("online"))} · ${modeDisplayLabel(settings.optString("mode"))}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            // 号码所在设备（与 iOS SIMIdentityDetail 一致）；顶部胶囊不再显示设备短号。
                            Text(
                                "设备：${runCatching { sim.toClientSim().gatewayFullLabel }.getOrDefault("网关身份待确认")}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    },
                    trailingContent = {
                        Icon(Icons.Filled.ChevronRight, contentDescription = "打开 SIM 设置", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    },
                )
            }
            }
        }
        if (state.sims is RemoteList.Loaded && state.simsRefreshError.isNotBlank()) {
            item {
                SettingsRetryRow(
                    message = "号码刷新失败：${state.simsRefreshError}",
                    onRetry = model::retrySettingsSims,
                    tag = "settings.sims.retry",
                )
            }
        }
        // S24 决策 3: right after SIM 与接听模式, like iOS. Hidden entirely on a Control that predates S24.
        if (!state.voiceProviderUnavailable) {
            item { InlineSectionHeader("AI 语音服务") }
            item { VoiceProviderSection(state, model) }
        }
        item { InlineSectionHeader("已屏蔽号码") }
        item {
            Card(
                onClick = { managingBlocklist = true },
                modifier = Modifier.fillMaxWidth().testTag("settings.blocklist.open"),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                ListItem(
                    modifier = Modifier.heightIn(min = TouchTarget),
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    leadingContent = { Icon(Icons.Filled.Block, null) },
                    headlineContent = { Text("管理已屏蔽号码") },
                    supportingContent = {
                        Text(blocklistSummary(state.blocklist, state.smsBlocklist))
                    },
                    trailingContent = { Icon(Icons.Filled.ChevronRight, null) },
                )
            }
        }
        item { InlineSectionHeader("通行密钥") }
        item {
            SettingsCard {
                Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        "使用系统通行密钥安全登录，无需输入密码。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(
                        onClick = { model.registerPasskey(passkeys) },
                        enabled = state.networkAvailable && passkeyRegistrationAllowed(state),
                        modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.passkey.add"),
                    ) {
                        Icon(Icons.Filled.Key, null)
                        Spacer(Modifier.width(8.dp))
                        Text("添加通行密钥")
                    }
                    if (state.passkeysLoading) LoadingRow("正在读取通行密钥…")
                    if (state.passkeysLoaded && !state.passkeysLoading && state.passkeys.isEmpty() && state.passkeyError.isBlank()) {
                        EmptyCard("还没有通行密钥", Modifier)
                    }
                    state.passkeys.forEachIndexed { index, passkey ->
                        if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        PasskeyRow(
                            item = passkey,
                            busy = state.passkeyPending.isNotEmpty(),
                            onRename = { renaming = passkey },
                            onDelete = { deleting = passkey },
                        )
                    }
                    if (state.passkeyStatus.isNotBlank()) StatusLine(state.passkeyStatus)
                    // errorContainer rather than raw `error` text: the saturated red drops below
                    // 4.5:1 as body copy on the dark surface.
                    if (state.passkeyError.isNotBlank()) {
                        SettingsRetryRow(
                            message = state.passkeyError,
                            onRetry = model::loadPasskeys,
                            tag = "settings.passkey.retry",
                        )
                    }
                }
            }
        }
        item { InlineSectionHeader("网关设备") }
        item { GatewayPowerSection(state, model) }
        item { InlineSectionHeader("设备与连接") }
        item {
            ItemCard(
                "后台来电",
                when {
                    !notificationsAllowed -> "请允许通知，才能在锁屏和后台接听"
                    !microphoneAllowed -> "请允许麦克风，接听后才能连接通话音频"
                    state.pushRegistration == PushRegistrationState.Ready -> "后台来电与通知已就绪"
                    state.pushRegistration == PushRegistrationState.Registering -> "正在完成后台通知设置…"
                    state.pushRegistration == PushRegistrationState.Failed -> "后台通知暂不可用，请稍后重试"
                    else -> "后台来电等待推送服务连接"
                },
            ) {
                if ((!notificationsAllowed && Build.VERSION.SDK_INT >= 33) || !microphoneAllowed) {
                    OutlinedButton(
                        onClick = {
                            backgroundPermission.launch(
                                if (!notificationsAllowed && Build.VERSION.SDK_INT >= 33) Manifest.permission.POST_NOTIFICATIONS
                                else Manifest.permission.RECORD_AUDIO,
                            )
                        },
                        modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
                    ) { Text(if (!notificationsAllowed) "允许来电通知" else "允许通话麦克风") }
                } else {
                    OutlinedButton(
                        onClick = model::refreshBackgroundCalling,
                        enabled = state.networkAvailable && state.pushRegistration != PushRegistrationState.Registering,
                        modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
                    ) { Text("检查后台来电") }
                }
                if (!phoneStateAllowed) {
                    TextButton(
                        onClick = { phoneStatePermission.launch(Manifest.permission.READ_PHONE_STATE) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
                    ) { Text("允许识别通话状态（通话中来电转 AI）") }
                }
                Text(
                    "系统强行停止应用后，需要重新打开 VoDog。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Filled.Autorenew, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        "通话和短信状态以服务器记录为准。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    "号码设备离线时，请在对应网关设备上重新开启 VoDog。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "通话网络：自动，标准连接失败后尝试兼容连接。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item {
            OutlinedButton(
                onClick = {
                    notificationsAllowed = canShowCallNotification(context)
                    microphoneAllowed = ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.RECORD_AUDIO,
                    ) == PackageManager.PERMISSION_GRANTED
                    model.refreshSettings()
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.refreshAll"),
                enabled = state.networkAvailable,
            ) {
                Icon(Icons.Filled.Refresh, null)
                Spacer(Modifier.width(8.dp))
                Text("刷新应用状态")
            }
        }
        item { InlineSectionHeader("退出登录") }
        item {
            SettingsCard {
                TextButton(
                    onClick = model::logout,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = TouchTarget)
                        .testTag("settings.logout"),
                    colors = destructiveTextColors(),
                ) { Text("退出登录") }
            }
        }
            // state.message is already banner-ed by Workspace above the tab body; no second copy here.
        }
        // Always-mounted, nonvisual readiness tags prevent tests from searching for an off-screen
        // LazyColumn child while its remote section is still loading.
        if (state.voiceProviders is RemoteResource.Loaded) {
            Box(Modifier.size(1.dp).testTag("settings.ready.provider"))
        }
        if (state.sims is RemoteList.Loaded) {
            Box(Modifier.size(1.dp).testTag("settings.ready.sims"))
        }
        if (state.blocklist is RemoteList.Loaded) {
            Box(Modifier.size(1.dp).testTag("settings.ready.blocklist"))
        }
        if (state.gatewayPower is RemoteList.Loaded) {
            Box(Modifier.size(1.dp).testTag("settings.ready.gateway"))
        }
        if (state.passkeysLoaded && !state.passkeysLoading) {
            Box(Modifier.size(1.dp).testTag("settings.ready.passkeys"))
        }
    }
    renaming?.let { target ->
        PasskeyRenameDialog(
            item = target,
            onDismiss = { renaming = null },
            onConfirm = { label -> model.renamePasskey(target.id, label); renaming = null },
        )
    }
    deleting?.let { target ->
        PasskeyDeleteDialog(
            onDismiss = { deleting = null },
            onConfirm = { model.deletePasskey(target.id); deleting = null },
        )
    }
    unblocking?.let { target ->
        AlertDialog(
            onDismissRequest = { unblocking = null },
            title = { Text("解除屏蔽？") },
            text = { Text(blocklistUnblockMessage(target.optString("remoteNumber", "这个号码"), target.optString("scope"))) },
            confirmButton = {
                TextButton(onClick = {
                    model.unblockBlocklistEntry(target.optString("id"))
                    unblocking = null
                }, enabled = state.networkAvailable, modifier = Modifier.testTag("settings.block.confirmUnblock"), colors = destructiveTextColors()) {
                    Text("解除屏蔽")
                }
            },
            dismissButton = { TextButton(onClick = { unblocking = null }) { Text("取消") } },
        )
    }
}

/**
 * S24 决策 3「AI 语音服务」。单选列表：`configured && online` 才可选，其余禁用并把原因写在行里，
 * 点可用项立刻 PUT。文案与状态语义和 iOS `VoiceProviderPolicy` 逐条一致。
 */
@Composable
private fun VoiceProviderSection(state: ClientUiState, model: ClientViewModel) {
    val haptic = LocalHapticFeedback.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when (val providers = state.voiceProviders) {
            RemoteResource.NotLoaded, RemoteResource.Loading -> LoadingRow("正在读取语音服务…")
            is RemoteResource.Failed -> EmptyCard("语音服务暂不可读：${providers.message}", Modifier)
            is RemoteResource.Loaded -> if (providers.value.items.isEmpty()) {
                EmptyCard("没有可选的语音服务", Modifier)
            } else {
                SettingsCard {
                    providers.value.items.forEachIndexed { index, provider ->
                        if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        VoiceProviderRow(
                            provider = provider,
                            selected = voiceProviderSelected(
                                provider,
                                state.voiceProviderReview ?: providers.value.selected,
                            ),
                            // One request at a time: two quick taps would otherwise leave the 勾 on the wrong row.
                            busy = state.voiceProviderPending.isNotEmpty() || state.voiceProviderConflict,
                            submitting = state.voiceProviderPending == provider.id,
                            onSelect = { haptic.performHapticFeedback(HapticFeedbackType.Confirm); model.selectVoiceProvider(provider.id) },
                        )
                    }
                }
            }
        }
        Text(
            VOICE_PROVIDER_FOOTER,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (state.voiceProviderMessage.isNotBlank()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { MessageCard(state.voiceProviderMessage) }
                TextButton(onClick = model::clearVoiceProviderMessage) { Text("知道了") }
            }
        }
        if (state.voiceProviders is RemoteResource.Failed || state.voiceProviderMessage.startsWith("语音服务刷新失败")) {
            OutlinedButton(
                onClick = model::loadVoiceProviders,
                enabled = state.networkAvailable,
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.provider.retry"),
            ) { Text("重试语音服务") }
        }
        if (state.voiceProviderConflict) {
            val latestVersion = (state.voiceProviders as? RemoteResource.Loaded)?.value?.configVersion ?: 0L
            OutlinedButton(
                onClick = model::discardVoiceProviderConflict,
                enabled = state.networkAvailable && latestVersion >= (state.voiceProviderConflictVersion ?: Long.MAX_VALUE),
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.provider.loadLatest"),
            ) { Text("载入最新设置（放弃当前选择）") }
        }
    }
}

@Composable
private fun BlocklistPage(
    state: ClientUiState,
    model: ClientViewModel,
    onBack: () -> Unit,
    onUnblock: (JSONObject) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var scope by rememberSaveable { mutableStateOf(ClientApiRoutes.BLOCK_SCOPE_CALL) }
    val scopes = listOf(ClientApiRoutes.BLOCK_SCOPE_CALL to "来电", ClientApiRoutes.BLOCK_SCOPE_SMS to "短信")
    Column(Modifier.fillMaxSize().testTag("settings.blocklist.page")) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = ScreenPadding),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack, modifier = Modifier.size(TouchTarget).testTag("settings.blocklist.back")) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回设置")
            }
            Text("已屏蔽号码", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            IconButton(
                onClick = model::loadBlocklist,
                enabled = state.networkAvailable,
                modifier = Modifier.size(TouchTarget).testTag("settings.blocklist.refresh"),
            ) { Icon(Icons.Filled.Refresh, contentDescription = "刷新屏蔽号码") }
        }
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("搜索号码") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = ScreenPadding)
                .testTag("settings.blocklist.search"),
        )
        // S66: 来电 / 短信 are two independent lists; each is searched and unblocked on its own.
        SingleChoiceSegmentedButtonRow(
            Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 6.dp).heightIn(min = TouchTarget),
        ) {
            scopes.forEachIndexed { index, (value, label) ->
                SegmentedButton(
                    selected = scope == value,
                    onClick = { scope = value },
                    shape = SegmentedButtonDefaults.itemShape(index, scopes.size),
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("settings.blocklist.scope.$value"),
                ) { Text(label) }
            }
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(ScreenPadding),
        ) {
            item {
                val list = if (scope == ClientApiRoutes.BLOCK_SCOPE_SMS) state.smsBlocklist else state.blocklist
                BlocklistSection(state, list, model, onUnblock, query)
            }
        }
    }
}

@Composable
private fun BlocklistSection(
    state: ClientUiState,
    blocklist: RemoteList,
    model: ClientViewModel,
    onUnblock: (JSONObject) -> Unit,
    query: String,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val list = blocklist) {
            RemoteList.NotLoaded, RemoteList.Loading -> LoadingRow("正在读取屏蔽号码…")
            is RemoteList.Failed -> EmptyCard("屏蔽号码读取失败：${list.message}", Modifier)
            is RemoteList.Loaded -> {
                val matches = list.items.filter { blockedNumberMatches(it.optString("remoteNumber"), query) }
                if (matches.isEmpty()) {
                    EmptyCard(if (query.isBlank()) "没有已屏蔽号码" else "没有匹配的屏蔽号码", Modifier)
                } else SettingsCard {
                    matches.forEachIndexed { index, item ->
                        if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        ListItem(
                            modifier = Modifier.testTag("settings.block.${item.optString("id")}"),
                            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                            leadingContent = { Icon(Icons.Filled.Block, contentDescription = null) },
                            headlineContent = { Text(item.optString("remoteNumber", "号码未知")) },
                            supportingContent = {
                                // S55: entries the Pixel's own system blocklist reported.
                                val origin = if (item.optString("source") == "phone") "手机屏蔽" else ""
                                val time = item.optString("createdAt").takeIf(String::isNotBlank)?.let { displayDateTime(it) }.orEmpty()
                                listOf(origin, time).filter(String::isNotBlank).joinToString(" · ")
                                    .takeIf(String::isNotBlank)?.let { Text(it) }
                            },
                            trailingContent = {
                                TextButton(
                                    onClick = { onUnblock(item) },
                                    enabled = state.networkAvailable && item.optString("id") !in state.blocklistPending,
                                    modifier = Modifier.testTag("settings.block.${item.optString("id")}.unblock"),
                                    colors = destructiveTextColors(),
                                ) { Text("解除") }
                            },
                        )
                    }
                }
            }
        }
        if (state.blocklistMessage.isNotBlank()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { MessageCard(state.blocklistMessage) }
                TextButton(onClick = model::clearBlocklistMessage) { Text("知道了") }
            }
        }
        if (blocklist is RemoteList.Failed) {
            OutlinedButton(
                onClick = model::loadBlocklist,
                enabled = state.networkAvailable,
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.blocklist.retry"),
            ) { Text("重试屏蔽号码") }
        }
    }
}

@Composable
private fun VoiceProviderRow(
    provider: ClientVoiceProvider,
    selected: Boolean,
    busy: Boolean,
    submitting: Boolean,
    onSelect: () -> Unit,
) {
    val reason = voiceProviderDisabledReason(provider)
    val enabled = LocalNetworkAvailable.current && reason.isEmpty() && !busy
    ListItem(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = TouchTarget)
            .testTag("settings.provider.${provider.id}")
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect),
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        headlineContent = { Text(provider.label, style = MaterialTheme.typography.bodyLarge) },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (voiceProviderAvailability(provider) == VoiceProviderAvailability.AVAILABLE) {
                        Icon(Icons.Filled.CheckCircle, contentDescription = null,
                            modifier = Modifier.size(16.dp).testTag("settings.provider.${provider.id}.available"),
                            tint = MaterialTheme.colorScheme.tertiary)
                    }
                    Text(voiceProviderStatusLabel(provider), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                // The reason a row cannot be chosen belongs on that row, not in a banner elsewhere.
                if (reason.isNotEmpty()) {
                    Text(
                        reason,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        trailingContent = {
            if (submitting) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                // The checkmark stays on the selected provider even when it is offline: that is still
                // what the server has stored. `onClick = null` because the whole row is already the
                // selectable target — two actionable nodes would double the ripple and the TalkBack stop.
                RadioButton(selected = selected, enabled = enabled, onClick = null)
            }
        },
    )
}

/**
 * S21 §D 远程开关. The switch is the *request*, not the state: turning it on writes `desired_power`
 * and the Pixel picks it up from its standby beacon, so the row keeps showing 待命中 until the real
 * heartbeat comes back. Refusals arrive as 409 codes and are mapped in [gatewayPowerErrorMessage].
 */
@Composable
private fun GatewayPowerSection(state: ClientUiState, model: ClientViewModel) {
    val powers = (state.gatewayPower as? RemoteList.Loaded)?.items.orEmpty()
        .mapNotNull { runCatching { it.toClientGatewayPower() }.getOrNull() }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when (val loaded = state.gatewayPower) {
            RemoteList.NotLoaded, RemoteList.Loading -> LoadingRow("正在读取网关状态…")
            // An older control service has no /gateways/power at all; say so instead of alarming.
            is RemoteList.Failed -> SettingsRetryRow(
                message = "网关远程开关暂不可用：${loaded.message}",
                onRetry = model::retryGatewayPower,
                tag = "settings.gateway.retry",
            )
            is RemoteList.Loaded -> if (powers.isEmpty()) {
                EmptyCard("这个账号名下还没有可远程控制的网关", Modifier)
            } else {
                powers.forEach { GatewayPowerCard(it, state, model) }
            }
        }
        if (state.gatewayPowerMessage.isNotBlank()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { MessageCard(state.gatewayPowerMessage) }
                TextButton(onClick = model::clearGatewayPowerMessage) { Text("知道了") }
            }
        }
        if (state.gatewayPower is RemoteList.Loaded && state.gatewayPowerRefreshError.isNotBlank()) {
            SettingsRetryRow(
                message = "网关状态刷新失败：${state.gatewayPowerRefreshError}",
                onRetry = model::retryGatewayPower,
                tag = "settings.gateway.retry",
            )
        }
    }
}

@Composable
private fun GatewayPowerCard(power: ClientGatewayPower, state: ClientUiState, model: ClientViewModel) {
    val submitting = power.gatewayId in state.gatewayPowerPending
    var confirmingOff by remember(power.gatewayId) { mutableStateOf(false) }
    // Remote ON needs the standby beacon; remote OFF needs a live heartbeat. Either way the server
    // decides — this only keeps the switch from firing a request that cannot succeed.
    val canToggle = if (power.powerOn) power.online else power.remotePowerAllowed && power.standbyOnline
    ItemCard(
        power.name,
        if (!state.networkAvailable) "设备未联网" else listOf("状态 ${gatewayPowerStatusLabel(power)}", gatewayRemotePowerLabel(power)).joinToString(" · "),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                // S92: same wording as iOS — a neutral 「网关总控」 title; the subtitle carries the state and
                // turning it off still goes through the confirmation dialog below.
                Text("网关总控", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
                Text(
                    when {
                        !state.networkAvailable -> "设备未联网"
                        submitting || power.pending -> "正在等待网关执行…"
                        power.online -> "已开启"
                        power.standbyOnline -> "已关闭（待命中，可远程开启）"
                        else -> "号码设备离线"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = power.powerOn,
                onCheckedChange = { desiredOn ->
                    if (desiredOn) model.setGatewayPower(power.gatewayId, true)
                    else confirmingOff = true
                },
                enabled = state.networkAvailable && canToggle && !submitting && !power.pending,
                modifier = Modifier.testTag("settings.gateway.${power.gatewayId}"),
            )
        }
        if (!state.networkAvailable || !canToggle) {
            Text(
                if (!state.networkAvailable) "设备未联网，联网后可操作号码设备。"
                else if (power.powerOn) "网关当前不在线，无法远程关闭。"
                else if (!power.remotePowerAllowed) "请先在网关设备上打开“允许远程开启（待命）”。"
                else "网关的待命通道已离线，需要在网关设备上手动开启。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (power.occupied) {
            Text(
                "这台网关设备正在通话中，远程关闭会被拒绝。",
                style = MaterialTheme.typography.bodySmall,
                color = warningColor(),
            )
        }
        gatewayPowerResultLabel(power.lastPowerResult)?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(
            listOfNotNull(
                power.lastSeenAt?.let { "最近心跳 ${displayDateTime(it)}" },
                power.standbySeenAt?.let { "待命心跳 ${displayDateTime(it)}" },
            ).joinToString(" · ").ifBlank { "尚未收到心跳" },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    if (confirmingOff) AlertDialog(
        onDismissRequest = { confirmingOff = false },
        title = { Text("关闭这台网关？") },
        text = { Text("关闭后，这台网关将停止处理来电和短信；再次远程开启需要待命通道在线。") },
        confirmButton = {
            TextButton(
                onClick = {
                    confirmingOff = false
                    model.setGatewayPower(power.gatewayId, false)
                },
                colors = destructiveTextColors(),
                modifier = Modifier.testTag("settings.gateway.confirmOff"),
                enabled = state.networkAvailable && canToggle && !submitting && !power.pending,
            ) { Text("关闭网关") }
        },
        dismissButton = { TextButton(onClick = { confirmingOff = false }) { Text("取消") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppearancePicker() {
    val appearance = LocalClientAppearance.current
    val onAppearanceChange = LocalSetClientAppearance.current
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().testTag("settings.appearance")) {
        ClientAppearance.entries.forEachIndexed { index, option ->
            SegmentedButton(
                selected = appearance == option,
                onClick = { onAppearanceChange(option) },
                shape = SegmentedButtonDefaults.itemShape(index, ClientAppearance.entries.size),
                modifier = Modifier.heightIn(min = TouchTarget)
                    .testTag("settings.appearance.${option.preferenceValue}"),
            ) { Text(option.label) }
        }
    }
}

/** S67: only the app-icon badge follows these; in-app badges always show. */
@Composable
private fun BadgeSettingsSection(model: ClientViewModel, needsPermission: Boolean, onAllow: () -> Unit) {
    val prefs by model.badgePrefs.collectAsState()
    SettingsCard {
        // The icon badge rides on a notification, so it needs the notification permission.
        if (prefs.enabled && needsPermission) {
            OutlinedButton(onClick = onAllow, modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget)) {
                Text("允许通知以显示图标角标")
            }
        }
        BadgeSwitchRow("App 图标角标", "关闭后图标不显示数字，应用内角标不受影响", prefs.enabled, true, "settings.badge.enabled") {
            model.setBadgePrefs(prefs.copy(enabled = it))
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        BadgeSwitchRow("通话", "未接与 AI 代接的来电", prefs.calls, prefs.enabled, "settings.badge.calls") {
            model.setBadgePrefs(prefs.copy(calls = it))
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        BadgeSwitchRow("短信", "未读短信", prefs.sms, prefs.enabled, "settings.badge.sms") {
            model.setBadgePrefs(prefs.copy(sms = it))
        }
    }
}

@Composable
private fun BadgeSwitchRow(
    title: String,
    detail: String,
    checked: Boolean,
    enabled: Boolean,
    tag: String,
    onChange: (Boolean) -> Unit,
) {
    ListItem(
        modifier = Modifier.heightIn(min = TouchTarget),
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        headlineContent = { Text(title) },
        supportingContent = { Text(detail, style = MaterialTheme.typography.labelSmall) },
        trailingContent = {
            Switch(checked = checked, onCheckedChange = onChange, enabled = enabled, modifier = Modifier.testTag(tag))
        },
    )
}

@Composable
private fun SettingsCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.fillMaxWidth(), content = content)
    }
}

@Composable
private fun SettingsRetryRow(message: String, onRetry: () -> Unit, tag: String) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        MessageCard(message)
        OutlinedButton(
            onClick = onRetry,
            enabled = LocalNetworkAvailable.current,
            modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag(tag),
        ) { Text("重试") }
    }
}

@Composable
private fun SettingsRow(title: String, value: String) {
    ListItem(
        modifier = Modifier.heightIn(min = TouchTarget),
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        headlineContent = { Text(title, style = MaterialTheme.typography.bodyLarge) },
        trailingContent = {
            Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        },
    )
}

@Composable
private fun PasskeyRow(item: PasskeyItem, busy: Boolean, onRename: () -> Unit, onDelete: () -> Unit) {
    var menuOpen by remember { mutableStateOf(false) }
    val name = PasskeyDisplayPolicy.resolvedName(item)
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.passkey.${item.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            when (PasskeyDisplayPolicy.icon(item)) {
                PasskeyDisplayPolicy.Icon.PHONE -> Icons.Filled.Smartphone
                PasskeyDisplayPolicy.Icon.LAPTOP -> Icons.Filled.Laptop
                PasskeyDisplayPolicy.Icon.CLOUD_KEY -> Icons.Filled.CloudDone
                PasskeyDisplayPolicy.Icon.KEY -> Icons.Filled.Key
            },
            contentDescription = null,
            Modifier.size(24.dp),
            tint = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
            Text(
                PasskeyDisplayPolicy.platformSummary(item),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "添加于 ${displayDateTime(item.createdAt)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                item.lastUsedAt?.takeIf(String::isNotBlank)?.let { "最近使用 ${displayDateTime(it)}" } ?: "尚未使用",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Box {
            IconButton(
                onClick = { menuOpen = true },
                enabled = LocalNetworkAvailable.current && !busy,
                modifier = Modifier.size(TouchTarget).testTag("settings.passkey.${item.id}.manage"),
            ) {
                Icon(Icons.Filled.MoreVert, contentDescription = "管理 $name")
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text("重命名") },
                    leadingIcon = { Icon(Icons.Filled.Edit, null) },
                    modifier = Modifier.testTag("settings.passkey.rename"),
                    enabled = LocalNetworkAvailable.current && !busy,
                    onClick = { menuOpen = false; onRename() },
                )
                DropdownMenuItem(
                    text = { Text("删除", color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Filled.Delete, null, tint = MaterialTheme.colorScheme.error) },
                    modifier = Modifier.testTag("settings.passkey.delete"),
                    enabled = LocalNetworkAvailable.current && !busy,
                    onClick = { menuOpen = false; onDelete() },
                )
            }
        }
    }
}

@Composable
private fun PasskeyRenameDialog(item: PasskeyItem, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    // Prefill with the name the row shows, so a server-named credential is not edited from blank.
    var text by remember(item.id) { mutableStateOf(PasskeyDisplayPolicy.resolvedName(item)) }
    val normalized = PasskeyDisplayPolicy.normalizedLabel(text)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("重命名通行密钥") },
        text = {
            // S30：对话框自成一个窗口，根 Box 的「点空白处收键盘」够不着，这里自己贴一次。
            Column(Modifier.dismissKeyboardOnTapOutside(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.fillMaxWidth().testTag("settings.passkey.rename.input"),
                    enabled = LocalNetworkAvailable.current,
                    label = { Text("名称") },
                    singleLine = true,
                    isError = text.isNotEmpty() && normalized == null,
                    supportingText = {
                        Text(
                            if (text.isNotEmpty() && normalized == null) PasskeyDisplayPolicy.LABEL_VALIDATION_MESSAGE
                            else "名称只用于在这个列表里区分设备，1–64 个字符。",
                        )
                    },
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { normalized?.let(onConfirm) },
                enabled = LocalNetworkAvailable.current && normalized != null,
                modifier = Modifier.testTag("settings.passkey.rename.confirm"),
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun PasskeyDeleteDialog(onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("删除这个通行密钥？") },
        text = { Text("删除后，这台设备将无法再用该通行密钥登录。") },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                enabled = LocalNetworkAvailable.current,
                colors = destructiveTextColors(),
                modifier = Modifier.testTag("settings.passkey.delete.confirm"),
            ) { Text("删除") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun SimDetailPage(sim: JSONObject, state: ClientUiState, model: ClientViewModel, onBack: () -> Unit) {
    val busy = state.busy
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack, modifier = Modifier.size(TouchTarget)) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回设置")
                }
                Text(
                    sim.optString("label").takeIf { it.isNotBlank() && it != "null" } ?: "SIM 设置",
                    style = MaterialTheme.typography.titleLarge,
                )
            }
        }
        if (!state.networkAvailable || !sim.optBoolean("online")) item {
            MessageCard(simConnectionLabel(state.networkAvailable, sim.optBoolean("online")))
        }
        item { InlineSectionHeader("号码备注") }
        item {
            SimNotesCard(
                sim = sim,
                busy = busy,
                submission = state.simNotesSubmissions[sim.optString("id")],
                conflictVersion = state.simNotesConflicts[sim.optString("id")],
                onAcceptLatest = model::acceptLatestSimNotes,
                onSave = model::setSimNotes,
            )
        }
        item { InlineSectionHeader("接听模式") }
        item {
            SimSettingsCard(
                sim,
                busy,
                state.settingsApply[sim.optString("id")] ?: SettingsApplyState.Idle,
                state.simSettingsSubmissions[sim.optString("id")],
                state.simSettingsConflicts[sim.optString("id")],
                model::acceptLatestSimSettings,
                model::setMode,
            )
        }
    }
}

@Composable
internal fun SimNotesCard(
    sim: JSONObject,
    busy: Boolean,
    submission: SimNotesSubmission?,
    conflictVersion: Long?,
    onAcceptLatest: (String, Long) -> Boolean,
    onSave: (String, String, String?, Long) -> Unit,
) {
    val simId = sim.optString("id")
    val version = if (!sim.has("version") || sim.isNull("version")) 0 else sim.optLong("version")
    val serverLabel = sim.optString("label")
    val serverPhoneLabel = sim.optString("phoneLabel").takeUnless { it.isBlank() || it == "null" }.orEmpty()
    var baselineVersion by rememberSaveable(simId) { mutableStateOf(version) }
    var baselineLabel by rememberSaveable(simId) { mutableStateOf(serverLabel) }
    var baselinePhoneLabel by rememberSaveable(simId) { mutableStateOf(serverPhoneLabel) }
    var label by rememberSaveable(simId) { mutableStateOf(serverLabel) }
    var phoneLabel by rememberSaveable(simId) { mutableStateOf(serverPhoneLabel) }
    val dirty = label != baselineLabel || phoneLabel != baselinePhoneLabel
    val conflict = simDraftConflicted(
        serverVersion = version,
        baselineVersion = baselineVersion,
        dirty = dirty,
        submittedTargetVersion = submission?.targetVersion,
        latchedConflictVersion = conflictVersion,
    )
    val syncingFreshCleanDraft = !dirty && version > baselineVersion
    val awaitingSubmittedVersion = submission?.targetVersion?.let { it > baselineVersion } == true
    LaunchedEffect(version, serverLabel, serverPhoneLabel, dirty, submission) {
        when {
            submission != null && submission.targetVersion > baselineVersion && version == submission.targetVersion -> {
                // Normalize only the acknowledged draft, never a newer edit or a conflict.
                if (label.trim() == submission.label && phoneLabel.trim() == submission.phoneLabel.orEmpty()) {
                    label = submission.label
                    phoneLabel = submission.phoneLabel.orEmpty()
                }
                baselineVersion = submission.targetVersion
                baselineLabel = submission.label
                baselinePhoneLabel = submission.phoneLabel.orEmpty()
            }
            !dirty && conflictVersion == null && version > baselineVersion -> {
                baselineVersion = version
                baselineLabel = serverLabel
                baselinePhoneLabel = serverPhoneLabel
                label = serverLabel
                phoneLabel = serverPhoneLabel
            }
        }
    }
    ItemCard("号码备注", "仅修改显示名称，不会更换 SIM 身份或中断通话。") {
        OutlinedTextField(
            value = label,
            onValueChange = { label = it.take(80) },
            modifier = Modifier.fillMaxWidth().testTag("settings.sim.label"),
            label = { Text("显示名称") },
            enabled = LocalNetworkAvailable.current && !busy,
            singleLine = true,
        )
        OutlinedTextField(
            value = phoneLabel,
            onValueChange = { phoneLabel = it.take(80) },
            modifier = Modifier.fillMaxWidth().testTag("settings.sim.phoneLabel"),
            label = { Text("号码标注") },
            placeholder = { Text("例如：家庭卡") },
            enabled = LocalNetworkAvailable.current && !busy,
            singleLine = true,
        )
        if (dirty) Text("未保存设置", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("settings.sim.notes.unsaved"))
        if (conflict) {
            MessageCard("号码备注已被另一端更新，当前草稿已保留。")
            OutlinedButton(
                onClick = {
                    if (onAcceptLatest(simId, version)) {
                        baselineVersion = version
                        baselineLabel = serverLabel
                        baselinePhoneLabel = serverPhoneLabel
                        label = serverLabel
                        phoneLabel = serverPhoneLabel
                    }
                },
                enabled = LocalNetworkAvailable.current && !busy && (conflictVersion == null || version >= conflictVersion),
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.sim.loadLatestNotes"),
            ) {
                Text(
                    if (conflictVersion == null || version >= conflictVersion) "载入最新备注（替换当前草稿）"
                    else "正在载入最新备注…",
                )
            }
        }
        Button(
            onClick = {
                onSave(
                    simId,
                    label.trim(),
                    phoneLabel.trim().takeIf(String::isNotEmpty),
                    baselineVersion,
                )
            },
            enabled = LocalNetworkAvailable.current && !busy && !conflict && !syncingFreshCleanDraft && !awaitingSubmittedVersion &&
                label.trim().isNotEmpty(),
            modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.sim.saveNotes"),
        ) { Text("保存备注") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SimSettingsCard(
    sim: JSONObject,
    busy: Boolean,
    applyState: SettingsApplyState,
    submission: SimSettingsSubmission?,
    conflictVersion: Long?,
    onAcceptLatest: (String, Long) -> Boolean,
    onApply: (String, String, Int, Long) -> Unit,
) {
    val settings = sim.optJSONObject("settings") ?: JSONObject()
    val version = settings.optLong("version", 0)
    val serverMode = settings.optString("mode", "normal")
    val serverTimeout = settings.optInt("timeoutSeconds", 45).coerceIn(10, 120)
    var baselineVersion by rememberSaveable(sim.optString("id")) { mutableStateOf(version) }
    var baselineMode by rememberSaveable(sim.optString("id")) { mutableStateOf(serverMode) }
    var baselineTimeout by rememberSaveable(sim.optString("id")) { mutableStateOf(serverTimeout) }
    var mode by rememberSaveable(sim.optString("id")) {
        mutableStateOf(serverMode)
    }
    var timeoutSeconds by rememberSaveable(sim.optString("id")) {
        mutableStateOf(serverTimeout)
    }
    val draftDirty = mode != baselineMode || timeoutSeconds != baselineTimeout
    val conflict = simDraftConflicted(
        serverVersion = version,
        baselineVersion = baselineVersion,
        dirty = draftDirty,
        submittedTargetVersion = submission?.targetVersion,
        latchedConflictVersion = conflictVersion,
    )
    val syncingFreshCleanDraft = !draftDirty && version > baselineVersion
    val awaitingSubmittedVersion = submission?.targetVersion?.let { it > baselineVersion } == true
    LaunchedEffect(version, serverMode, serverTimeout, draftDirty, submission) {
        when {
            submission != null && submission.targetVersion > baselineVersion && version == submission.targetVersion -> {
                baselineVersion = submission.targetVersion
                baselineMode = submission.mode
                baselineTimeout = submission.timeoutSeconds
            }
            !draftDirty && conflictVersion == null && version > baselineVersion -> {
                baselineVersion = version
                baselineMode = serverMode
                baselineTimeout = serverTimeout
                mode = serverMode
                timeoutSeconds = serverTimeout
            }
        }
    }
    val availableModes = settings.optJSONArray("availableModes")?.let { values ->
        (0 until values.length()).map { values.optString(it) }.toSet()
    } ?: setOf("normal")
    val applied = sim.simSettingsVersions().appliedVersion
    val applyLabel = SettingsApplyPolicy.label(applyState, applied, version)
    val choices = listOf("normal", "ai", "timeout_ai").map { it to modeDisplayLabel(it) }
    val haptic = LocalHapticFeedback.current
    ItemCard(
        sim.optString("label", sim.optString("id", "SIM")),
        "${modeDisplayLabel(settings.optString("mode"))} · " +
            SettingsApplyPolicy.subtitle(applyState, applied, version),
    ) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().heightIn(min = TouchTarget)) {
            choices.forEachIndexed { index, (value, label) ->
                SegmentedButton(
                    selected = mode == value,
                    onClick = { if (mode != value) haptic.performHapticFeedback(HapticFeedbackType.VirtualKey); mode = value },
                    enabled = LocalNetworkAvailable.current && !busy && value in availableModes,
                    shape = SegmentedButtonDefaults.itemShape(index, choices.size),
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("settings.sim.mode.$value"),
                ) { Text(label) }
            }
        }
        if ("ai" !in availableModes || "timeout_ai" !in availableModes) {
            Text(
                if (!settings.isNull("aiUnavailableReason")) settings.optString("aiUnavailableReason", "AI 接听尚未开放")
                else "AI 接听尚未开放",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (mode == "timeout_ai") {
            Text("等待时间 $timeoutSeconds 秒", style = MaterialTheme.typography.bodyMedium)
            Slider(
                value = timeoutSeconds.toFloat(),
                onValueChange = { timeoutSeconds = ((it / 5f).roundToInt() * 5).coerceIn(10, 120) },
                valueRange = 10f..120f,
                steps = 21,
                enabled = LocalNetworkAvailable.current && !busy && !conflict,
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
            )
        }
        if (draftDirty) Text("未保存设置", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("settings.sim.mode.unsaved"))
        if (conflict) {
            MessageCard("设置已被另一端更新，当前草稿已保留。请载入最新设置后重新核对。")
            OutlinedButton(
                onClick = {
                    if (onAcceptLatest(sim.optString("id"), version)) {
                        baselineVersion = version
                        baselineMode = serverMode
                        baselineTimeout = serverTimeout
                        mode = serverMode
                        timeoutSeconds = serverTimeout
                    }
                },
                enabled = LocalNetworkAvailable.current && !busy && (conflictVersion == null || version >= conflictVersion),
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
            ) {
                Text(
                    if (conflictVersion == null || version >= conflictVersion) "载入最新设置（替换当前草稿）"
                    else "正在载入最新设置…",
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        InlineSectionHeader("应用状态")
        SettingsRow("草稿基于版本", baselineVersion.toString())
        if (version != baselineVersion) SettingsRow("服务器当前版本", version.toString())
        SettingsRow("设备已应用", applied?.toString() ?: "尚未确认")
        SettingsApplyStatusLine(applyLabel)
        Button(
            onClick = { haptic.performHapticFeedback(HapticFeedbackType.Confirm); onApply(sim.optString("id"), mode, timeoutSeconds, baselineVersion) },
            enabled = LocalNetworkAvailable.current && !busy && !conflict && !syncingFreshCleanDraft && !awaitingSubmittedVersion &&
                mode in availableModes,
            modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("settings.sim.saveMode"),
        ) { Text("保存设置") }
    }
}

internal fun simDraftConflicted(
    serverVersion: Long,
    baselineVersion: Long,
    dirty: Boolean,
    submittedTargetVersion: Long?,
    latchedConflictVersion: Long?,
): Boolean {
    val protectedVersion = maxOf(baselineVersion, submittedTargetVersion ?: baselineVersion)
    return latchedConflictVersion != null || (dirty && serverVersion > protectedVersion)
}

/**
 * 「应用状态」的那一行。等待用网关总控 pending 同一种次要色加一个 16 dp 转圈，成功用应用里
 * 「在线」的那支绿（`colorScheme.tertiary`），未确认仍是原来的 [warningColor]。
 */
@Composable
private fun SettingsApplyStatusLine(label: SettingsApplyLabel) {
    if (label.text.isBlank()) return
    val color = when (label.tone) {
        SettingsApplyTone.SUCCESS -> MaterialTheme.colorScheme.tertiary
        SettingsApplyTone.WARNING -> warningColor()
        SettingsApplyTone.PENDING, SettingsApplyTone.NONE -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (label.tone == SettingsApplyTone.PENDING) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = color)
        }
        Text(label.text, style = MaterialTheme.typography.bodySmall, color = color)
    }
}

internal fun blockedNumberMatches(number: String, query: String): Boolean {
    fun compact(value: String) = value.filterNot { it.isWhitespace() || it in "()-" }
    return compact(number).contains(compact(query))
}

/** S66 设置摘要：两份名单的数量；任何一份还没读到就不报数字。 */
internal fun blocklistSummary(calls: RemoteList, sms: RemoteList): String = when {
    calls is RemoteList.Loaded && sms is RemoteList.Loaded -> "来电 ${calls.items.size} · 短信 ${sms.items.size}"
    calls is RemoteList.Failed || sms is RemoteList.Failed -> "读取失败，打开重试"
    else -> "正在读取屏蔽号码…"
}

/** S66 解除确认说清楚是哪一份名单；老 Control 不回 `scope` 的行即来电黑名单。 */
internal fun blocklistUnblockMessage(number: String, scope: String): String =
    if (scope == ClientApiRoutes.BLOCK_SCOPE_SMS) "$number 将移出短信黑名单，之后的短信重新进入收件箱。"
    else "$number 将移出来电黑名单，来电不再被挂断。"
