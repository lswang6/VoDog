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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * S95 Signal semantic colors (Signal-UI-Handoff tokens). Material roles come from [toMaterial];
 * the slots Material has no role for (call / warn / ai / line colors) are read via [LocalSignal].
 */
@Immutable
internal data class SignalColors(
    val bg: Color, val chrome: Color, val surface: Color, val surface2: Color, val surface3: Color, val line: Color,
    val ink: Color, val ink2: Color, val ink3: Color,
    val brand: Color, val onBrand: Color, val brandSoft: Color, val bubbleOut: Color,
    val call: Color, val callFill: Color, val callSoft: Color,
    val danger: Color, val dangerFill: Color, val dangerSoft: Color,
    val warn: Color, val warnSoft: Color, val ai: Color, val aiSoft: Color,
    val sim: List<Color>,
)

internal val SignalLight = SignalColors(
    bg = Color(0xFFEEEFF3), chrome = Color(0xFFF6F6F9), surface = Color(0xFFFBFBFD),
    surface2 = Color(0xFFECEDF1), surface3 = Color(0xFFE1E3E9), line = Color(0xFFE2E4EA),
    ink = Color(0xFF111827), ink2 = Color(0xFF424B59), ink3 = Color(0xFF667080),
    brand = Color(0xFF1F5FD1), onBrand = Color(0xFFFFFFFF), brandSoft = Color(0xFFE9F0FD), bubbleOut = Color(0xFF1F5FD1),
    call = Color(0xFF17824B), callFill = Color(0xFF1E8A50), callSoft = Color(0xFFE4F4EA),
    danger = Color(0xFFC2302B), dangerFill = Color(0xFFD33A35), dangerSoft = Color(0xFFFCECEB),
    warn = Color(0xFF9A5800), warnSoft = Color(0xFFFFF4DE), ai = Color(0xFF6941C6), aiSoft = Color(0xFFF2EDFD),
    sim = listOf(0xFF2457C5, 0xFF147D78, 0xFFB45309, 0xFF7C3AED, 0xFFBE185D, 0xFF4338CA, 0xFF8A5A2B, 0xFF0E7490).map { Color(it) },
)

internal val SignalDark = SignalColors(
    bg = Color(0xFF0B0E13), chrome = Color(0xFF141920), surface = Color(0xFF141920),
    surface2 = Color(0xFF1B2129), surface3 = Color(0xFF252C36), line = Color(0xFF28303B),
    ink = Color(0xFFEDF0F5), ink2 = Color(0xFFBAC2CE), ink3 = Color(0xFF8F99A7),
    brand = Color(0xFF7AA7FF), onBrand = Color(0xFF0B1730), brandSoft = Color(0xFF1A2945), bubbleOut = Color(0xFF2F64D6),
    call = Color(0xFF3DCC85), callFill = Color(0xFF1E8A50), callSoft = Color(0xFF11301F),
    danger = Color(0xFFFF7A73), dangerFill = Color(0xFFD33A35), dangerSoft = Color(0xFF3A1B1B),
    warn = Color(0xFFF4BA4E), warnSoft = Color(0xFF38290D), ai = Color(0xFFB9A2FF), aiSoft = Color(0xFF261F42),
    sim = listOf(0xFF66A8FF, 0xFF63D3CC, 0xFFFDBA74, 0xFFC4B5FD, 0xFFF9A8D4, 0xFFA5B4FC, 0xFFE0B48A, 0xFF67E8F9).map { Color(it) },
)

internal val LocalSignal = staticCompositionLocalOf { SignalDark }

internal fun signalColors(dark: Boolean): SignalColors = if (dark) SignalDark else SignalLight

/**
 * Token mapping per tokens/Theme.kt. Additions the reference leaves unset (so Material's lavender
 * baseline cannot leak in): secondary/tertiary roles, and `onError`/`onErrorContainer`. The dark
 * `danger` is a bright salmon on which white is only ~2.4:1, so dark `onError` is near-black;
 * filled destructive buttons use [FilledDestructiveRed] (= dangerFill) with white instead.
 */
internal fun SignalColors.toMaterial(dark: Boolean): ColorScheme = if (dark) darkColorScheme(
    primary = brand, onPrimary = onBrand, primaryContainer = brandSoft, onPrimaryContainer = ink,
    secondary = brand, onSecondary = onBrand, secondaryContainer = brandSoft, onSecondaryContainer = ink,
    tertiary = call, onTertiary = onBrand, tertiaryContainer = callSoft, onTertiaryContainer = ink,
    background = bg, onBackground = ink, surface = surface, onSurface = ink, onSurfaceVariant = ink2,
    surfaceContainerLowest = bg, surfaceContainerLow = chrome, surfaceContainer = surface,
    surfaceContainerHigh = surface2, surfaceContainerHighest = surface3, surfaceVariant = surface2,
    outline = ink3, outlineVariant = line, error = danger, onError = Color(0xFF330A08),
    errorContainer = dangerSoft, onErrorContainer = danger,
) else lightColorScheme(
    primary = brand, onPrimary = onBrand, primaryContainer = brandSoft, onPrimaryContainer = ink,
    secondary = brand, onSecondary = onBrand, secondaryContainer = brandSoft, onSecondaryContainer = ink,
    tertiary = call, onTertiary = Color.White, tertiaryContainer = callSoft, onTertiaryContainer = ink,
    background = bg, onBackground = ink, surface = surface, onSurface = ink, onSurfaceVariant = ink2,
    surfaceContainerLowest = surface, surfaceContainerLow = chrome, surfaceContainer = surface,
    surfaceContainerHigh = surface2, surfaceContainerHighest = surface3, surfaceVariant = surface2,
    outline = ink3, outlineVariant = line, error = danger, onError = Color.White,
    errorContainer = dangerSoft, onErrorContainer = danger,
)

internal fun clientColorScheme(dark: Boolean): ColorScheme = signalColors(dark).toMaterial(dark)

/** Non-fatal warnings (pending gateway apply, incomplete capture): Signal `warn`. */
internal fun clientWarningColor(dark: Boolean): Color = signalColors(dark).warn

@Composable
internal fun warningColor(): Color = LocalSignal.current.warn

private val LocalClientDarkTheme = staticCompositionLocalOf { true }

// S57 配色：每张 SIM 不同色。颜色序号 = 在账号列表按 (slotIndex, id) 升序的名次，与展示顺序、在线与否无关。
private val SIM_PALETTE_LIGHT = SignalLight.sim
private val SIM_PALETTE_DARK = SignalDark.sim

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
        headlineMedium = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold),
        headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
        // Single-line TopAppBar title (S68): 22 Medium.
        titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
        titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
        titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp),
    )
    MaterialTheme(
        colorScheme = scheme,
        typography = typography,
        shapes = Shapes(
            // Signal radii: tag 6 · button/input 12 · card 16 · panel 20–22.
            extraSmall = RoundedCornerShape(6.dp),
            small = RoundedCornerShape(12.dp),
            medium = RoundedCornerShape(16.dp),
            large = RoundedCornerShape(20.dp),
            extraLarge = RoundedCornerShape(22.dp),
        ),
    ) {
        CompositionLocalProvider(
            LocalClientDarkTheme provides darkTheme,
            LocalSignal provides signalColors(darkTheme),
            content = content,
        )
    }
}
