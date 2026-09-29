package org.vodog

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf

internal enum class ClientAppearance(val preferenceValue: String, val label: String) {
    DARK("dark", "深色"),
    LIGHT("light", "浅色"),
    SYSTEM("system", "跟随系统");

    fun usesDarkTheme(systemDark: Boolean): Boolean = when (this) {
        DARK -> true
        LIGHT -> false
        SYSTEM -> systemDark
    }

    companion object {
        fun fromPreference(value: String?): ClientAppearance =
            entries.firstOrNull { it.preferenceValue == value } ?: DARK
    }
}

/** Device-local preference, deliberately separate from the sign-in/session vault. */
internal class ClientAppearanceStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences("client_appearance", Context.MODE_PRIVATE)

    fun read(): ClientAppearance = ClientAppearance.fromPreference(preferences.getString("mode", null))

    fun write(appearance: ClientAppearance) {
        preferences.edit().putString("mode", appearance.preferenceValue).apply()
    }
}

internal val LocalClientAppearance = staticCompositionLocalOf { ClientAppearance.DARK }
internal val LocalSetClientAppearance = staticCompositionLocalOf<(ClientAppearance) -> Unit> { {} }
