package org.vodog.gateway

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit deployment probe restoring the authorized SMS/control mode without opening any UI. */
@RunWith(AndroidJUnit4::class)
class GatewayControlSyncProbeTest {
    @Test fun resumeApprovedControlAndObserveNormalSettings() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertFalse(GatewayCallExecutionApproval.READY)
        assertFalse(GatewayAudioMediaSessionApproval.APPROVED)
        assertTrue(SmsExecutionApproval.APPROVED)
        assertFalse(DeviceCredentialVault(context).read().isNullOrBlank())
        val runtime = GatewayRuntimeStore(context)
        val wasEnabled = runtime.enabled
        var success = false
        try {
            runtime.enabled = true
            ContextCompat.startForegroundService(context, Intent(context, GatewayForegroundService::class.java)
                .setAction(GatewayForegroundService.ACTION_START))
            val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(45)
            while (System.nanoTime() < deadline) {
                val bindings = GatewaySimBindingStore(context).bindings().filter { it.routable }
                if (runtime.connection == ServerConnection.ONLINE && bindings.isNotEmpty() && bindings.all { binding ->
                    val value = GatewaySettingsStore(context).read(binding.simId)
                    value != null && value.mode == "normal" && value.assignmentVersion == binding.assignmentVersion &&
                        value.generation == runtime.deviceEpoch
                }) { success = true; break }
                Thread.sleep(250)
            }
            assertTrue("Gateway must durably apply the current normal settings", success)
        } finally {
            if (!success) {
                runtime.enabled = wasEnabled
                if (!wasEnabled) context.stopService(Intent(context, GatewayForegroundService::class.java))
            }
        }
    }
}
