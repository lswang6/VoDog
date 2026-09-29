package org.vodog

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Brand scheme for the user client. No dynamic color on purpose: the three brand hues
 * (primary blue, secondary teal, tertiary iOS-green) must match the iOS app and the web client.
 *
 * `error` is iOS's `callerDanger` verbatim (S22, R4 Part B must-fix): #D70015 on light, #FF453A on
 * dark, the two values `Theme.swift` picks per appearance. They used to be one fixed #D32F2F here,
 * which matched neither and did not follow the theme at all.
 *
 * `onError` differs per scheme because the fills do: white clears 4.5:1 on the deep light red, but
 * only 3.4:1 on the bright dark one, so the dark scheme writes near-black on it instead. (S19's note
 * about "pink fill, maroon text" was about M3's pastel *baseline* with no `onError` set — this is an
 * explicit saturated pair, and `ClientThemeTest` pins the contrast, the red dominance and both hexes.)
 * Long error *messages* use errorContainer/onErrorContainer (see MessageCard), which stays high
 * contrast in dark mode; raw `error` is reserved for buttons, icons and borders.
 */
private val CLIENT_ERROR_LIGHT = Color(0xFFD70015)
private val CLIENT_ERROR_DARK = Color(0xFFFF453A)
private val CLIENT_ON_ERROR_LIGHT = Color.White
private val CLIENT_ON_ERROR_DARK = Color(0xFF330A08)

internal fun clientColorScheme(dark: Boolean): ColorScheme = if (dark) {
    darkColorScheme(
        primary = Color(0xFF66A8FF),
        onPrimary = Color(0xFF071E41),
        primaryContainer = Color(0xFF1B3A6B),
        onPrimaryContainer = Color(0xFFD9EBFF),
        secondary = Color(0xFF63D3CC),
        onSecondary = Color(0xFF042B29),
        // SegmentedButton's active fill and NavigationBarItem's indicator both read
        // secondaryContainer; leaving it unset let Material's lavender baseline through.
        secondaryContainer = Color(0xFF0F3F3C),
        onSecondaryContainer = Color(0xFFB7ECE7),
        tertiary = Color(0xFF45D36B),
        onTertiary = Color(0xFF05250E),
        tertiaryContainer = Color(0xFF173E23),
        onTertiaryContainer = Color(0xFFA9EDBB),
        background = Color.Black,
        onBackground = Color(0xFFF2F2F7),
        surface = Color(0xFF1C1C1E),
        onSurface = Color(0xFFF2F2F7),
        surfaceVariant = Color(0xFF2C2C2E),
        onSurfaceVariant = Color(0xFFAEAEB2),
        // Neutral elevation ramp so AlertDialog/DropdownMenu/bottom sheets stay grey, not tinted.
        surfaceContainerLowest = Color.Black,
        surfaceContainerLow = Color(0xFF141416),
        surfaceContainer = Color(0xFF1C1C1E),
        surfaceContainerHigh = Color(0xFF252527),
        surfaceContainerHighest = Color(0xFF2C2C2E),
        outline = Color(0xFF8E8E93),
        outlineVariant = Color(0xFF48484A),
        error = CLIENT_ERROR_DARK,
        onError = CLIENT_ON_ERROR_DARK,
        errorContainer = Color(0xFF57212B),
        onErrorContainer = Color(0xFFFFD9DF),
    )
} else {
    lightColorScheme(
        primary = Color(0xFF2457C5),
        onPrimary = Color.White,
        secondary = Color(0xFF147D78),
        onSecondary = Color.White,
        secondaryContainer = Color(0xFFCFEDEA),
        onSecondaryContainer = Color(0xFF04302E),
        tertiary = Color(0xFF34C759),
        onTertiary = Color.White,
        tertiaryContainer = Color(0xFFB7E8C1),
        onTertiaryContainer = Color(0xFF174624),
        primaryContainer = Color(0xFFD9EBFF),
        onPrimaryContainer = Color(0xFF0B2A5B),
        background = Color(0xFFF2F2F7),
        onBackground = Color(0xFF111114),
        surface = Color.White,
        onSurface = Color(0xFF111114),
        surfaceVariant = Color(0xFFEFEFF4),
        onSurfaceVariant = Color(0xFF5D5D66),
        surfaceContainerLowest = Color.White,
        surfaceContainerLow = Color(0xFFF7F7FA),
        surfaceContainer = Color(0xFFF2F2F7),
        surfaceContainerHigh = Color(0xFFEDEDF2),
        surfaceContainerHighest = Color(0xFFEFEFF4),
        outline = Color(0xFF8E8E93),
        outlineVariant = Color(0xFFD1D1D6),
        error = CLIENT_ERROR_LIGHT,
        onError = CLIENT_ON_ERROR_LIGHT,
        errorContainer = Color(0xFFFFE9ED),
        onErrorContainer = Color(0xFF8D2035),
    )
}

/**
 * Non-fatal warnings (pending gateway apply, incomplete capture). Material 3 has no warning slot,
 * and the iOS `.orange` is unreadable on white, so each theme gets its own readable amber.
 */
internal fun clientWarningColor(dark: Boolean): Color =
    if (dark) Color(0xFFFFB259) else Color(0xFFB25E00)

private val LocalClientDarkTheme = staticCompositionLocalOf { true }

@Composable
internal fun warningColor(): Color = clientWarningColor(LocalClientDarkTheme.current)

// S57 配色：每张 SIM 不同色。颜色序号 = 在账号列表按 (slotIndex, id) 升序的名次，与展示顺序、在线与否无关。
private val SIM_PALETTE_LIGHT = listOf(0xFF2457C5, 0xFF147D78, 0xFFB45309, 0xFF7C3AED, 0xFFBE185D, 0xFF4338CA, 0xFF8A5A2B, 0xFF0E7490).map { Color(it) }
private val SIM_PALETTE_DARK = listOf(0xFF66A8FF, 0xFF63D3CC, 0xFFFDBA74, 0xFFC4B5FD, 0xFFF9A8D4, 0xFFA5B4FC, 0xFFE0B48A, 0xFF67E8F9).map { Color(it) }

internal fun simPaletteIndex(sim: ClientSim, sims: List<ClientSim>): Int =
    sims.sortedWith(compareBy<ClientSim>({ it.slotIndex ?: Int.MAX_VALUE }, { it.id }))
        .indexOfFirst { it.id == sim.id }.coerceAtLeast(0)

/** 序号 0–7 固定色；≥ 8 用黄金角色相（浅 hsl(h,65%,28%) / 深 hsl(h,80%,75%)）。 */
internal fun simPaletteColor(sim: ClientSim, sims: List<ClientSim>, dark: Boolean): Color {
    val index = simPaletteIndex(sim, sims)
    return (if (dark) SIM_PALETTE_DARK else SIM_PALETTE_LIGHT).getOrNull(index)
        ?: Color.hsl(((index * 137.508 + 20) % 360).toFloat(), if (dark) 0.8f else 0.65f, if (dark) 0.75f else 0.28f)
}

internal fun simOnPaletteColor(dark: Boolean): Color = if (dark) Color(0xFF0B1220) else Color.White

@Composable
internal fun simColor(sim: ClientSim, sims: List<ClientSim>): Color = simPaletteColor(sim, sims, LocalClientDarkTheme.current)

@Composable
internal fun simOnColor(): Color = simOnPaletteColor(LocalClientDarkTheme.current)

@Composable
internal fun VoDogTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val scheme = clientColorScheme(darkTheme)
    val typography = Typography(
        headlineLarge = TextStyle(fontSize = 34.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold),
        headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
        titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
        titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 22.sp),
        bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp),
    )
    MaterialTheme(
        colorScheme = scheme,
        typography = typography,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(10.dp),
            small = RoundedCornerShape(12.dp),
            medium = RoundedCornerShape(14.dp),
            large = RoundedCornerShape(18.dp),
            extraLarge = RoundedCornerShape(20.dp),
        ),
    ) {
        CompositionLocalProvider(LocalClientDarkTheme provides darkTheme, content = content)
    }
}
