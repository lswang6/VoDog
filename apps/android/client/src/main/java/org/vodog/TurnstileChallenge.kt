package org.vodog

import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject
import java.net.URLEncoder

/**
 * Cloudflare Turnstile state for the native login screen.
 *
 * `enabled`/`siteKey` come from the control service (`GET /api/v1/auth/config`), so turning Turnstile on or rotating
 * the key never needs an app release. A token is single use, so `generation` bumps to request a fresh challenge after
 * any failed attempt.
 */
data class TurnstileUiState(
    val enabled: Boolean = false,
    val siteKey: String? = null,
    val token: String? = null,
    val error: String? = null,
    val generation: Int = 0,
    /**
     * S22 决策 11 (R4 A3 root cause): `false` until `GET /auth/config` has answered — success or
     * final failure. The login form stays disabled while it is false, because the defaults below
     * ("Turnstile off") are indistinguishable from "the config request has not come back yet", and a
     * password login sent in that window is rejected by the server with `TURNSTILE_REQUIRED`.
     */
    val configLoaded: Boolean = false,
    /** Set when every `GET /auth/config` attempt failed; shown outside the challenge card. */
    val configError: String? = null,
) {
    val required: Boolean get() = enabled && !siteKey.isNullOrBlank()
}

/** The copy shown when the pre-login configuration could not be read at all. */
internal const val TURNSTILE_CONFIG_FAILED_MESSAGE = "人机验证配置加载失败，请检查网络"

/** The button label while the pre-login configuration is still being read. */
internal const val TURNSTILE_CONFIG_LOADING_LABEL = "正在检查登录设置…"

/**
 * Whether the password 登录 button may be tapped. Split out of the composable so the S22 gating rule
 * is unit-testable: the button is dead until the auth config has arrived, even when a restored form
 * already carries a username and password (R4 A3 #1).
 */
internal fun passwordLoginEnabled(
    turnstile: TurnstileUiState,
    busy: Boolean,
    username: String,
    password: String,
): Boolean {
    if (busy || username.isBlank() || password.isBlank()) return false
    if (!turnstile.configLoaded) return false
    return !turnstile.required || !turnstile.token.isNullOrBlank()
}

/**
 * Passkey needs neither the password nor a solved challenge (S22 决策 11 / R4 A2); it still waits for
 * the config read so the two buttons do not disagree about whether the app is ready to talk to the
 * control service.
 */
internal fun passkeyLoginEnabled(
    turnstile: TurnstileUiState,
    busy: Boolean,
    username: String,
): Boolean = !busy && username.isNotBlank() && turnstile.configLoaded

sealed interface TurnstileEvent {
    data class Token(val value: String) : TurnstileEvent
    data class Failed(val message: String) : TurnstileEvent
    data object Expired : TurnstileEvent
}

/** Decodes one message from the hosted Turnstile page; unknown payloads are treated as a failed challenge. */
internal fun parseTurnstileBridgeMessage(raw: String?): TurnstileEvent {
    val payload = runCatching { JSONObject(raw.orEmpty()) }.getOrNull()
        ?: return TurnstileEvent.Failed("人机验证失败，请重试。")
    return when (payload.optString("type")) {
        "token" -> payload.optString("token").takeIf { it.isNotBlank() }
            ?.let(TurnstileEvent::Token) ?: TurnstileEvent.Failed("人机验证失败，请重试。")
        "expired" -> TurnstileEvent.Expired
        else -> TurnstileEvent.Failed(payload.optString("message").takeIf { it.isNotBlank() } ?: "人机验证失败，请重试。")
    }
}

internal class TurnstileBridge(private val onMessage: (String) -> Unit) {
    @JavascriptInterface
    fun postMessage(message: String) = onMessage(message)
}

/**
 * Renders the Cloudflare Turnstile widget in a WebView. Cloudflare validates the widget hostname, so the challenge
 * page is served from the control origin and the public site key is passed in as a query parameter.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TurnstileChallenge(state: TurnstileUiState, onEvent: (TurnstileEvent) -> Unit) {
    // Hooks stay unconditional: the parent may add or remove this composable, but its own group structure must not
    // depend on the configuration it renders.
    val currentOnEvent by rememberUpdatedState(onEvent)
    val handler = remember { Handler(Looper.getMainLooper()) }
    val siteKey = state.siteKey
    if (!state.required || siteKey.isNullOrBlank()) return
    key(state.generation) {
        AndroidView(
            modifier = Modifier.fillMaxWidth().height(96.dp),
            factory = { context ->
                WebView(context).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    setBackgroundColor(AndroidColor.TRANSPARENT)
                    webViewClient = WebViewClient()
                    addJavascriptInterface(
                        TurnstileBridge { raw -> handler.post { currentOnEvent(parseTurnstileBridgeMessage(raw)) } },
                        "TurnstileBridge",
                    )
                    loadUrl(
                        java.net.URI(BuildConfig.API_BASE_URL).resolve("/turnstile.html?sitekey=").toString() +
                            URLEncoder.encode(siteKey, "UTF-8"),
                    )
                }
            },
            onRelease = { view ->
                view.removeJavascriptInterface("TurnstileBridge")
                view.stopLoading()
                view.destroy()
            },
        )
    }
}
