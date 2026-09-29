package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientAppearanceTest {
    @Test fun absentOrUnknownPreferenceDefaultsToDark() {
        for (value in listOf(null, "", "unknown")) {
            val appearance = ClientAppearance.fromPreference(value)
            assertEquals(ClientAppearance.DARK, appearance)
            assertTrue(appearance.usesDarkTheme(systemDark = false))
        }
    }

    @Test fun storedChoicesRoundTrip() {
        for (appearance in ClientAppearance.entries) {
            assertEquals(appearance, ClientAppearance.fromPreference(appearance.preferenceValue))
        }
    }

    @Test fun explicitChoicesIgnoreSystemAppearance() {
        for (systemDark in listOf(false, true)) {
            assertTrue(ClientAppearance.DARK.usesDarkTheme(systemDark))
            assertFalse(ClientAppearance.LIGHT.usesDarkTheme(systemDark))
        }
    }

    @Test fun systemChoiceTracksBothSystemAppearances() {
        assertFalse(ClientAppearance.SYSTEM.usesDarkTheme(systemDark = false))
        assertTrue(ClientAppearance.SYSTEM.usesDarkTheme(systemDark = true))
    }
}
