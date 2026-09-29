package org.vodog

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

class ClientThemeTest {
    @Test
    fun semanticTextPairsRemainReadableInLightAndDarkSchemes() {
        listOf(false, true).forEach { dark ->
            val scheme = clientColorScheme(dark)
            val pairs = listOf(
                scheme.background to scheme.onBackground,
                scheme.surface to scheme.onSurface,
                scheme.surfaceVariant to scheme.onSurfaceVariant,
                scheme.surfaceVariant to scheme.onSurface,
                scheme.primary to scheme.onPrimary,
                scheme.secondary to scheme.onSecondary,
                // SegmentedButton / NavigationBarItem indicator / login badge read these; an unset
                // role silently falls back to Material's lavender baseline.
                scheme.primaryContainer to scheme.onPrimaryContainer,
                scheme.secondaryContainer to scheme.onSecondaryContainer,
                scheme.tertiaryContainer to scheme.onTertiaryContainer,
                scheme.errorContainer to scheme.onErrorContainer,
            )
            pairs.forEach { (background, foreground) ->
                assertTrue(
                    "dark=$dark contrast=${contrastRatio(background, foreground)}",
                    contrastRatio(background, foreground) >= 4.5,
                )
            }
        }
    }

    /**
     * The destructive "结束通话" button fills with `error` and writes with `onError`. Before S19 the
     * dark scheme left `onError` unset, so it fell back to M3's dark maroon baseline on a pastel
     * pink fill — unreadable and not recognisably destructive.
     */
    @Test
    fun errorAndOnErrorStayReadableInBothSchemes() {
        listOf(false, true).forEach { dark ->
            val scheme = clientColorScheme(dark)
            val ratio = contrastRatio(scheme.error, scheme.onError)
            assertTrue("dark=$dark error/onError contrast=$ratio", ratio >= 4.5)
        }
    }

    /**
     * S22 (R4 Part B must-fix): `error` is iOS `callerDanger` verbatim, and it changes with the
     * appearance. A single fixed red matched neither theme and drifted from the iOS app.
     */
    @Test
    fun errorMatchesTheIosCallerDangerValuePerAppearance() {
        assertEquals(0xFFD70015.toInt(), clientColorScheme(false).error.toArgb())
        assertEquals(0xFFFF453A.toInt(), clientColorScheme(true).error.toArgb())
    }

    /** `error` must read as red, not pink: a dominant red channel with muted green and blue. */
    @Test
    fun errorIsRedDominantInBothSchemes() {
        listOf(false, true).forEach { dark ->
            val error = clientColorScheme(dark).error
            val red = channel(error.red)
            val green = channel(error.green)
            val blue = channel(error.blue)
            assertTrue("dark=$dark red=$red", red >= 0xC0)
            assertTrue("dark=$dark green=$green", green <= 0x60)
            assertTrue("dark=$dark blue=$blue", blue <= 0x60)
        }
    }

    /** Warning amber is only legible if it also clears 4.5:1 on the scheme it belongs to. */
    @Test
    fun warningColorStaysReadableOnItsOwnSurface() {
        listOf(false, true).forEach { dark ->
            val scheme = clientColorScheme(dark)
            val ratio = contrastRatio(scheme.surface, clientWarningColor(dark))
            assertTrue("dark=$dark warning contrast=$ratio", ratio >= 4.5)
        }
    }

    private fun channel(value: Float): Int = (value * 255f).roundToInt()

    private fun contrastRatio(first: Color, second: Color): Double {
        val firstLuminance = relativeLuminance(first)
        val secondLuminance = relativeLuminance(second)
        return (max(firstLuminance, secondLuminance) + 0.05) /
            (min(firstLuminance, secondLuminance) + 0.05)
    }

    private fun relativeLuminance(color: Color): Double {
        fun linear(channel: Float): Double {
            val value = channel.toDouble()
            return if (value <= 0.04045) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
    }

    @Test
    fun simPaletteRanksBySlotThenIdAndNeverRepeats() {
        fun sim(id: String, slot: Int?) = ClientSim(id, null, "SIM", null, slot, null, null, true, false, true, true, true, true)
        val sims = listOf(sim("b", 0), sim("z", null), sim("a", 1), sim("a0", 0))
        listOf(sims, sims.reversed()).forEach { list ->
            assertEquals(listOf(0, 1, 2, 3), listOf("a0", "b", "a", "z").map { id -> simPaletteIndex(list.first { it.id == id }, list) })
        }
        val many = (0 until 40).map { sim("sim-%02d".format(it), it) }
        assertEquals(
            listOf(0xFF2457C5, 0xFF147D78, 0xFFB45309, 0xFF7C3AED, 0xFFBE185D, 0xFF4338CA, 0xFF8A5A2B, 0xFF0E7490).map { it.toInt() },
            many.take(8).map { simPaletteColor(it, many, dark = false).toArgb() },
        )
        assertEquals(
            listOf(0xFF66A8FF, 0xFF63D3CC, 0xFFFDBA74, 0xFFC4B5FD, 0xFFF9A8D4, 0xFFA5B4FC, 0xFFE0B48A, 0xFF67E8F9).map { it.toInt() },
            many.take(8).map { simPaletteColor(it, many, dark = true).toArgb() },
        )
        listOf(false, true).forEach { dark ->
            val rest = many.drop(8).map { simPaletteColor(it, many, dark).toArgb() }
            assertEquals(rest.size, rest.toSet().size)
            assertEquals(rest, many.drop(8).map { simPaletteColor(it, many.reversed(), dark).toArgb() })
            // The eight fixed colors carry their on-color at 4.5:1; the golden-angle tail is not guaranteed to.
            many.take(8).forEach { assertTrue(contrastRatio(simPaletteColor(it, many, dark), simOnPaletteColor(dark)) >= 4.5) }
        }
        val wide = (0 until 64).map { sim("s%02d".format(it), it) }
        wide.drop(8).forEach {
            val contrast = contrastRatio(simPaletteColor(it, wide, dark = false), Color.White)
            assertTrue("${it.id} contrast=$contrast", contrast >= 4.5)
        }
    }
}
