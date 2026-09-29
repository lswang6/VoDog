package org.vodog

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp

/**
 * S22 决策 11. Three changes over S21, all of them about not lying to the user:
 *  - the form is seeded from [lastLogin] (kept across 退出登录 in its own encrypted store), and the
 *    password is masked with an eye toggle rather than being unreadable forever;
 *  - the 登录 button waits for `GET /auth/config` (`turnstile.configLoaded`). A restored form used to
 *    look ready while the config was still in flight, so the first tap sent no Turnstile token and
 *    came back 400 — R4 A3 #1;
 *  - Passkey no longer needs a solved challenge (or a password); the server stopped requiring one.
 */
@Composable
internal fun LoginPage(
    state: ClientUiState,
    onLogin: (String, String) -> Unit,
    onTurnstileEvent: (TurnstileEvent) -> Unit,
    onPasskeyLogin: (String) -> Unit,
    lastLogin: LastLogin? = null,
    onForgetLastLogin: () -> Unit = {},
) {
    var username by rememberSaveable { mutableStateOf(lastLogin?.username.orEmpty()) }
    var password by rememberSaveable { mutableStateOf(lastLogin?.password.orEmpty()) }
    var passwordVisible by rememberSaveable { mutableStateOf(false) }
    var seeded by rememberSaveable { mutableStateOf(lastLogin != null) }
    // The store is read on a background-safe path, so the value can arrive after the first frame.
    LaunchedEffect(lastLogin) {
        if (!seeded && lastLogin != null) {
            if (username.isBlank()) username = lastLogin.username
            if (password.isBlank()) password = lastLogin.password
            seeded = true
        }
    }
    val challengeSolved = !state.turnstile.required || !state.turnstile.token.isNullOrBlank()
    val turnstileMisconfigured = state.turnstile.enabled && state.turnstile.siteKey.isNullOrBlank()
    val configLoaded = state.turnstile.configLoaded
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    Box(
        // S30: `imePadding()` 让键盘弹出时整页抬起来 —— 在这之前「登录」按钮就藏在键盘底下，输完密码
        // 只能先收键盘才能点。页面本来就能竖向滚，抬起之后配合滚动足够放下整张卡片。
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).imePadding().testTag("login.screen")
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.size(72.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.PhoneInTalk, null, Modifier.size(36.dp), tint = MaterialTheme.colorScheme.primary)
            }
            // MaterialTheme does not set LocalContentColor, so a plain Text would render black on the dark canvas.
            Text("VoDog", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onSurface)
            Text(
                "安全访问分配给你的 SIM 通道",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            InlineSectionHeader("账号")
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = username,
                        onValueChange = { username = it },
                        modifier = Modifier.fillMaxWidth().testTag("login.username"),
                        label = { Text("用户名") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            keyboardType = KeyboardType.Text,
                            // 用户名的回车走到密码，密码的回车收键盘（见下）：两步都不必先去点空白处。
                            imeAction = ImeAction.Next,
                        ),
                        keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        modifier = Modifier.fillMaxWidth().testTag("login.password"),
                        label = { Text("密码") },
                        singleLine = true,
                        // Masked by default; the eye reveals it in place, so a saved password can be
                        // checked before it is sent instead of being retyped blind.
                        visualTransformation = if (passwordVisible) VisualTransformation.None
                        else PasswordVisualTransformation(),
                        trailingIcon = {
                            IconButton(
                                onClick = { passwordVisible = !passwordVisible },
                                modifier = Modifier.size(TouchTarget),
                            ) {
                                Icon(
                                    if (passwordVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                                    contentDescription = if (passwordVisible) "隐藏密码" else "显示密码",
                                )
                            }
                        },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Done,
                        ),
                        // 只收键盘，不替用户按「登录」：这颗按钮还要等 `GET /auth/config` 回来
                        // （S22 决策 11），提前提交会发出一条没有 Turnstile token 的 400。
                        keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); keyboard?.hide() }),
                    )
                    Button(
                        onClick = { onLogin(username, password) },
                        enabled = passwordLoginEnabled(state.turnstile, state.busy, username, password),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("login.submit"),
                    ) {
                        if (state.busy || !configLoaded) {
                            CircularProgressIndicator(
                                Modifier.size(18.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(if (state.busy) "正在登录…" else TURNSTILE_CONFIG_LOADING_LABEL)
                        } else {
                            Text("登录")
                        }
                    }
                    if (lastLogin != null) {
                        TextButton(
                            onClick = {
                                onForgetLastLogin()
                                username = ""
                                password = ""
                            },
                            modifier = Modifier.heightIn(min = TouchTarget),
                            colors = destructiveTextColors(),
                        ) { Text("忘记已保存的账号") }
                    }
                }
            }
            if (state.turnstile.required) {
                InlineSectionHeader("人机验证")
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        TurnstileChallenge(state.turnstile, onTurnstileEvent)
                        Text(
                            state.turnstile.error ?: if (challengeSolved) "验证已通过。" else "请完成验证后继续登录。",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (state.turnstile.error != null) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            } else if (state.turnstile.configError != null) {
                MessageCard(state.turnstile.configError)
            } else if (turnstileMisconfigured) {
                LaunchedEffect(Unit) { "人机验证配置不可用，请稍后重试。".asUiError("login.turnstile.config") }
                MessageCard("人机验证配置不可用，请稍后重试。")
            }
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { onPasskeyLogin(username) },
                        // No 人机验证 gate: `POST /passkeys/authenticate/options` stopped requiring a
                        // Turnstile token in S22, and a passkey is its own proof of possession.
                        enabled = passkeyLoginEnabled(state.turnstile, state.busy, username),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                    ) {
                        Icon(Icons.Filled.Key, null)
                        Spacer(Modifier.width(8.dp))
                        Text("使用 Passkey 登录")
                    }
                    Text(
                        "Passkey 使用设备的安全验证保护登录。",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (state.passkeyError.isNotBlank()) MessageCard(state.passkeyError)
            if (state.message.isNotBlank()) StateMessage(state)
            if (state.passkeyStatus.isNotBlank()) {
                Box(Modifier.fillMaxWidth()) { StatusLine(state.passkeyStatus) }
            }
        }
    }
}
