package org.vodog.gateway

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GatewayAdminRoutingPanel(
    api: GatewayAdminApi,
    session: GatewayAdminSession,
    localBindings: List<ServerSimBinding>,
    controlEnabled: () -> Boolean,
) {
    val scope = rememberCoroutineScope()
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var snapshot by remember { mutableStateOf<GatewayAdminSnapshot?>(null) }
    var resolution by remember { mutableStateOf<GatewayResolution?>(null) }
    var selectedOwners by remember { mutableStateOf<Map<String, String?>>(emptyMap()) }
    var message by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var assigningSimId by remember { mutableStateOf<String?>(null) }
    var requestEpoch by remember { mutableIntStateOf(0) }

    fun clearUiSession() {
        requestEpoch++
        api.cancelAll()
        session.clear()
        password = ""
        snapshot = null
        resolution = null
        selectedOwners = emptyMap()
        loading = false
        assigningSimId = null
    }

    fun applyLoaded(epoch: Int, token: String, loaded: GatewayAdminSnapshot, notice: String = "") {
        if (epoch != requestEpoch || !controlEnabled() || session.token != token) return
        val nextResolution = GatewayAdminRoutingPolicy.resolve(localBindings.map { it.simId }.toSet(), loaded.sims)
        snapshot = loaded
        resolution = nextResolution
        selectedOwners = when (nextResolution) {
            is GatewayResolution.Ready -> nextResolution.sims.associate { it.id to it.ownerUserId }
            is GatewayResolution.Blocked -> emptyMap()
        }
        message = notice
        loading = false
    }

    fun refresh(token: String, notice: String = "") {
        val networkToken = runCatching { api.beginRequest() }.getOrElse {
            message = gatewayAdminErrorMessage(it)
            return
        }
        val epoch = ++requestEpoch
        loading = true
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { api.load(networkToken, token) } }
                .onSuccess { applyLoaded(epoch, token, it, notice) }
                .onFailure { error ->
                    if (epoch != requestEpoch || !controlEnabled()) return@onFailure
                    loading = false
                    if (error is GatewayAdminHttpException && error.status == 401) {
                        clearUiSession()
                        message = "管理员登录已过期，请重新登录"
                    } else {
                        message = gatewayAdminErrorMessage(error)
                    }
                }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            api.cancelAll()
            session.clear()
        }
    }

    // Content only: the caller supplies the card so this panel can nest inside an expandable section.
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "管理员登录只在当前页面内有效。选择账号后需点击保存，不会自动改派。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
            if (session.token == null) {
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("管理员账号") },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("管理员密码") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                Button(
                    enabled = !loading && username.isNotBlank() && password.isNotBlank(),
                    onClick = {
                        val submittedUsername = username.trim()
                        val submittedPassword = password
                        password = ""
                        val epoch = ++requestEpoch
                        val networkToken = runCatching { api.beginRequest() }.getOrElse {
                            loading = false
                            message = gatewayAdminErrorMessage(it)
                            return@Button
                        }
                        loading = true
                        message = ""
                        scope.launch {
                            runCatching { withContext(Dispatchers.IO) {
                                api.login(networkToken, submittedUsername, submittedPassword)
                            } }
                                .onSuccess { (token, confirmedUsername) ->
                                    if (epoch != requestEpoch || !controlEnabled()) return@onSuccess
                                    session.open(token, confirmedUsername)
                                    refresh(token)
                                }
                                .onFailure { error ->
                                    if (epoch != requestEpoch || !controlEnabled()) return@onFailure
                                    loading = false
                                    session.clear()
                                    message = gatewayAdminErrorMessage(error)
                                }
                        }
                    },
                ) { Text(if (loading) "正在登录…" else "管理员登录") }
            } else {
                Text("管理员：${session.username}")
                TextButton(
                    onClick = { clearUiSession(); message = "管理员会话已退出" },
                ) { Text("退出管理员") }

                when {
                    loading && snapshot == null -> Text("正在读取账号归属…")
                    resolution is GatewayResolution.Blocked -> Text(
                        (resolution as GatewayResolution.Blocked).reason,
                        color = MaterialTheme.colorScheme.error,
                    )
                    resolution is GatewayResolution.Ready && snapshot != null -> {
                        val ready = resolution as GatewayResolution.Ready
                        val data = snapshot!!
                        val gatewayName = data.gateways.singleOrNull { it.id == ready.gatewayId }?.name
                            ?: "当前网关"
                        Text(gatewayName, style = MaterialTheme.typography.titleSmall)
                        ready.sims.forEachIndexed { index, sim ->
                            if (index > 0) HorizontalDivider(Modifier.padding(vertical = 4.dp))
                            val currentOwner = data.users.singleOrNull { it.id == sim.ownerUserId }
                            val selectedOwnerId = selectedOwners[sim.id]
                            val selectedOwner = data.users.singleOrNull { it.id == selectedOwnerId }
                            val selectedOwnerLabel = when {
                                selectedOwner != null -> selectedOwner.username
                                selectedOwnerId == null -> "未分配"
                                else -> "账号不可用"
                            }
                            var expanded by remember(sim.id) { mutableStateOf(false) }
                            Text(sim.slotIndex?.let { "SIM ${it + 1} · ${sim.label}" } ?: "未启用 · ${sim.label}", style = MaterialTheme.typography.titleSmall)
                            Text(
                                "当前账号：${currentOwner?.username ?: if (sim.ownerUserId == null) "未分配" else "账号不可用"}",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            sim.settings?.let { settings ->
                                val applied = settings.appliedVersion == settings.version
                                Text("接听模式：${adminModeLabel(settings.mode, settings.timeoutSeconds)} · ${if (applied) "已生效" else "等待设备确认"}")
                                if ("ai" !in settings.availableModes || "timeout_ai" !in settings.availableModes) {
                                    Text(
                                        settings.aiUnavailableReason ?: "AI 接听尚未开放",
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                            ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                                OutlinedTextField(
                                    value = selectedOwnerLabel,
                                    onValueChange = {},
                                    readOnly = true,
                                    label = { Text("选择账号") },
                                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                                    modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
                                )
                                ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                                    DropdownMenuItem(
                                        text = { Text("未分配") },
                                        onClick = {
                                            selectedOwners = selectedOwners + (sim.id to null)
                                            expanded = false
                                        },
                                    )
                                    data.users.forEach { user ->
                                        DropdownMenuItem(
                                            text = { Text(user.username) },
                                            onClick = {
                                                selectedOwners = selectedOwners + (sim.id to user.id)
                                                expanded = false
                                            },
                                        )
                                    }
                                }
                            }
                            Button(
                                enabled = !loading && assigningSimId == null && sim.present && selectedOwnerId != sim.ownerUserId,
                                onClick = {
                                    val token = session.token ?: return@Button
                                    val networkToken = runCatching { api.beginRequest() }.getOrElse {
                                        message = gatewayAdminErrorMessage(it)
                                        return@Button
                                    }
                                    val ownerAtSubmit = selectedOwners[sim.id]
                                    val epoch = ++requestEpoch
                                    assigningSimId = sim.id
                                    message = ""
                                    scope.launch {
                                        runCatching { withContext(Dispatchers.IO) {
                                            api.assignOwner(networkToken, token, sim, ownerAtSubmit)
                                        } }.onSuccess {
                                            if (epoch != requestEpoch || !controlEnabled() || session.token != token) return@onSuccess
                                            assigningSimId = null
                                            refresh(token, "账号归属已保存")
                                        }.onFailure { error ->
                                            if (epoch != requestEpoch || !controlEnabled()) return@onFailure
                                            assigningSimId = null
                                            if (error is GatewayAdminHttpException && GatewayAdminRoutingPolicy.refreshAfterFailure(error)) {
                                                refresh(token, "${gatewayAdminErrorMessage(error)}；已刷新，请重新确认后保存")
                                            } else {
                                                message = gatewayAdminErrorMessage(error)
                                            }
                                        }
                                    }
                                },
                            ) { Text(if (assigningSimId == sim.id) "正在保存…" else "保存归属") }
                            if (!sim.present) Text("SIM 当前不在设备中，不能改派", color = MaterialTheme.colorScheme.error)
                            if (sim.assignmentPending) Text("归属正在同步", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(
                            enabled = !loading && assigningSimId == null,
                            onClick = { session.token?.let(::refresh) },
                        ) { Text("刷新账号归属") }
                        GatewayAdminReportsPanel(
                            api = api,
                            session = session,
                            gatewayId = ready.gatewayId,
                            controlEnabled = controlEnabled,
                        )
                    }
                }
            }
        if (message.isNotBlank()) {
            Spacer(Modifier.height(2.dp))
            Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

internal fun gatewayAdminErrorMessage(error: Throwable): String = when (error) {
    is GatewayAdminHttpException -> when {
        error.status == 401 -> "管理员登录已过期，请重新登录"
        error.code == "GATEWAY_BUSY" -> "当前有通话或待确认任务，暂时不能改派账号"
        error.code == "SIM_ABSENT" -> "SIM 当前不在设备中，不能改派账号"
        error.code == "VERSION_CONFLICT" -> "归属状态已变化，请刷新后重新确认"
        error.code == "INVALID_CREDENTIALS" -> "管理员账号或密码不正确"
        error.code in setOf("ADMIN_REQUIRED", "FORBIDDEN") -> "此账号没有管理员权限"
        else -> "账号操作暂时失败"
    }
    is GatewayAdminRequestCancelledException -> "管理员请求已取消"
    else -> "账号操作暂时失败"
}

private fun adminModeLabel(mode: String, timeoutSeconds: Int): String = when (mode) {
    "normal" -> "普通接听"
    "ai" -> "AI 代接"
    "timeout_ai" -> "$timeoutSeconds 秒后转 AI"
    else -> "状态待确认"
}
