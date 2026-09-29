package org.vodog.gateway

import org.junit.Assert.*
import org.junit.Test

class GatewaySettingsTest {
    private val saved = AppliedSimSettings("sim", "normal", 45, 3, 2, 1)
    @Test fun replayIsSafeButOlderAndChangedVersionsCannotOverwrite() {
        assertNull(settingsTransitionError(saved, saved))
        assertEquals("settings_version_stale", settingsTransitionError(saved, saved.copy(version = 2)))
        assertEquals("settings_version_collision", settingsTransitionError(saved, saved.copy(timeoutSeconds = 60)))
        assertNull(settingsTransitionError(saved, saved.copy(version = 4, timeoutSeconds = 60)))
    }
    @Test fun priorOwnerOrPriorEpochDoesNotFenceNewAssignment() {
        assertNull(settingsTransitionError(saved, saved.copy(version = 1, assignmentVersion = 3)))
        assertNull(settingsTransitionError(saved, saved.copy(version = 1, generation = 2)))
    }
    @Test fun aiAnswerModesAreApplicableAndUnknownModesStayInvalid() {
        // S22 decision 8: rejecting these was the only reason applied_version never caught up.
        assertNull(settingsTransitionError(null, saved.copy(mode = "ai")))
        assertNull(settingsTransitionError(null, saved.copy(mode = "timeout_ai")))
        assertNull(settingsTransitionError(saved, saved.copy(mode = "ai", version = 4)))
        assertEquals("settings_invalid", settingsTransitionError(null, saved.copy(mode = "voicemail")))
        assertEquals("settings_invalid", settingsTransitionError(null, saved.copy(mode = "")))
        assertEquals("settings_invalid", settingsTransitionError(null, saved.copy(mode = "AI")))
    }

    @Test fun invalidTimeoutsAndVersionsAreNeverAcknowledgedAsApplied() {
        assertEquals("settings_invalid", settingsTransitionError(null, saved.copy(timeoutSeconds = 121)))
        assertEquals("settings_invalid", settingsTransitionError(null, saved.copy(timeoutSeconds = 9)))
        assertEquals("settings_invalid", settingsTransitionError(null, saved.copy(version = 0)))
        // An accepted mode never bypasses the remaining fences.
        assertEquals("settings_invalid", settingsTransitionError(null, saved.copy(mode = "ai", timeoutSeconds = 121)))
        assertEquals(
            "settings_version_collision",
            settingsTransitionError(saved, saved.copy(mode = "timeout_ai")),
        )
        assertEquals(
            "settings_version_stale",
            settingsTransitionError(saved.copy(version = 5), saved.copy(mode = "ai", version = 4)),
        )
    }
}
