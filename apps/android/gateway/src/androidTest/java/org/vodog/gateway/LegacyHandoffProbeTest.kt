package org.vodog.gateway

import android.content.Context
import android.telecom.TelecomManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit no-call probe: temporarily disables only the two audited services, then restores them. */
@RunWith(AndroidJUnit4::class)
class LegacyHandoffProbeTest {
    @Test fun idlePhoneComponentHandoffRestoresExactOriginalStates() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val telecom = context.getSystemService(TelecomManager::class.java)
        assertFalse("phone must be idle", telecom.isInCall)
        assertFalse(GatewayCallExecutionApproval.READY)
        assertFalse(GatewayAudioMediaSessionApproval.APPROVED)
        val components = AndroidLegacyComponentBackend(context)
        assertTrue("fifth privileged permission is required", components.canChangeComponents())
        val originals = LegacyAudioOwnerHandoff.LEGACY_KEYS.associateWith(components::currentState)
        val journal = DeviceProtectedAudioHandoffJournal(context)
        assertEquals(AudioHandoffPhase.IDLE, journal.read().phase)
        // No audio session exists in this gated probe; it does not change the user's mute state.
        val cleanup = object : GatewayAudioSessionCleanup {
            override fun stopAndRelease() = true
            override fun restorePreSessionMuteState() = true
        }
        val handoff = LegacyAudioOwnerHandoff(journal, components, cleanup) { !telecom.isInCall }
        try {
            assertEquals(AudioHandoffResult.Acquired, handoff.acquire())
            assertEquals(AudioHandoffPhase.ACQUIRED, journal.read().phase)
        } finally {
            assertEquals(AudioHandoffResult.Restored, handoff.release())
            originals.forEach { (key, original) -> assertEquals(original, components.currentState(key)) }
        }
        assertEquals(AudioHandoffPhase.IDLE, journal.read().phase)
        assertFalse(telecom.isInCall)
    }
}
