package org.vodog

import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.ContextThemeWrapper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

/**
 * The Activity is intentionally thin: it applies [VoDogTheme] and hands off to [ClientRoot].
 * Every screen lives in `ui/` (Theme, Components, Formatting, LoginScreen, Workspace, CallScreen,
 * SmsScreen, HistoryScreen, SettingsScreen) — all in this package so the existing unit tests keep
 * calling the display helpers unqualified.
 */
class MainActivity : ComponentActivity() {
    private var appliedDarkAppearance: Boolean? = null

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ClientDiag.attach(this)
        // S39 §F: 上一次进程被杀时留在 `cacheDir/exports/` 里的导出残骸，开机顺手收掉。
        pruneRecordingExports(this)
        val appearanceStore = ClientAppearanceStore(this)
        val initialAppearance = appearanceStore.read()
        applyWindowAppearance(
            initialAppearance.usesDarkTheme(
                resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES,
            ),
        )
        setContent {
            var appearance by remember { mutableStateOf(initialAppearance) }
            val darkTheme = appearance.usesDarkTheme(isSystemInDarkTheme())
            SideEffect { applyWindowAppearance(darkTheme) }
            CompositionLocalProvider(
                LocalClientAppearance provides appearance,
                LocalSetClientAppearance provides { selected ->
                    appearanceStore.write(selected)
                    appearance = selected
                },
            ) {
                VoDogTheme(darkTheme = darkTheme) {
                    // S30: `testTag` 只有打开这一位才会在 uiautomator 的 dump 里变成 `resource-id`，装机
                    // 验收的 adb 脚本就是靠它找「删除」「全选」这些新控件的。纯语义，不改任何布局。
                    //
                    // 同一个 Box 也是「点空白处收键盘」的唯一落点：[LoginPage] 与 [Workspace] 是
                    // [ClientRoot] 的两个兄弟分支，只有这里同时在两者之上（对话框/底部弹层另有窗口，
                    // 各自贴一次，见 [dismissKeyboardOnTapOutside] 的注释）。
                    Box(
                        Modifier.fillMaxSize()
                            .background(MaterialTheme.colorScheme.background)
                            .dismissKeyboardOnTapOutside()
                            .semantics { testTagsAsResourceId = true },
                    ) { ClientRoot() }
                }
            }
        }
    }

    @Suppress("DEPRECATION") // Bar colors still apply on Android 10–14; newer OS versions enforce edge-to-edge.
    private fun applyWindowAppearance(dark: Boolean) {
        if (appliedDarkAppearance == dark) return
        appliedDarkAppearance = dark
        // Dialog windows inherit this native theme. Copy its existing day/night resources without
        // recreating the Activity, so changing appearance keeps the current UI and call session.
        val configuration = Configuration(resources.configuration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        }
        val themedContext = ContextThemeWrapper(createConfigurationContext(configuration), R.style.Theme_VoDog)
        theme.setTo(themedContext.theme)
        val background = clientColorScheme(dark).background.toArgb()
        window.setBackgroundDrawable(ColorDrawable(background))
        window.statusBarColor = background
        window.navigationBarColor = background
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
}

@Composable
internal fun ClientRoot(model: ClientViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    // Deliberately a second flow: the saved account survives 退出登录, which replaces the whole
    // [ClientUiState] (S22 决策 11).
    val lastLogin by model.lastLogin.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val passkeys = remember(context) { AndroidPasskeyCredentialProvider(context) }
    passkeys.updateContext(context)
    when {
        state.checkingSession -> LoadingPage("正在验证登录")
        state.session == null -> LoginPage(
            state,
            model::login,
            model::acceptTurnstile,
            onPasskeyLogin = { username -> model.loginWithPasskey(username, passkeys) },
            lastLogin = lastLogin,
            onForgetLastLogin = model::forgetLastLogin,
        )
        else -> Workspace(state, model, passkeys)
    }
}
