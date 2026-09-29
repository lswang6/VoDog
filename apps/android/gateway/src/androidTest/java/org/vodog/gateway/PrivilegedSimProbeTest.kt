package org.vodog.gateway

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Read-only probe. It deliberately logs neither ICCID/fingerprint nor PhoneAccount contents. */
@RunWith(AndroidJUnit4::class)
class PrivilegedSimProbeTest {
    @Test fun privilegedReaderReturnsStableProtectedRealSimMappings() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val privileged = listOf(
            "android.permission.CONTROL_INCALL_EXPERIENCE",
            "android.permission.MODIFY_PHONE_STATE",
            "android.permission.CAPTURE_AUDIO_OUTPUT",
            "android.permission.READ_PRIVILEGED_PHONE_STATE",
        )
        assertTrue(privileged.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED })

        val readerClass = Class.forName("org.vodog.gateway.DeviceStatusReader")
        val reader = readerClass.getConstructor(Context::class.java).newInstance(context)
        val read = { readerClass.getMethod("activeSims").invoke(reader) as List<*> }
        val first = read()
        val second = read()
        assertTrue("expected at least one active SIM", first.isNotEmpty())
        assertEquals(first.size, second.size)
        val secondBySlot = second.associateBy { value(it, "getSlotIndex") as Int }
        val slots = first.map { sim ->
            val slot = value(sim, "getSlotIndex") as Int
            val subscriptionId = value(sim, "getSubscriptionId") as Int
            val handlePresent = value(sim, "getPhoneAccountHandle") != null
            val fingerprint = value(sim, "getIccidFingerprint") as? String
            val identityKind = value(sim, "getIdentityKind")
            assertTrue(slot >= 0)
            assertTrue(subscriptionId >= 0)
            assertTrue("PhoneAccount mapping missing for slot $slot", handlePresent)
            assertTrue("identity kind missing for slot $slot", identityKind != null)
            assertEquals(64, fingerprint?.length)
            val repeated = secondBySlot.getValue(slot)
            assertEquals(fingerprint, value(repeated, "getIccidFingerprint") as? String)
            assertEquals(identityKind, value(repeated, "getIdentityKind"))
            slot to identityKind.toString()
        }
        Log.i(
            TAG,
            "simCount=${first.size} slots=${slots.map { it.first }.sorted()} identityKinds=${slots.map { it.second }} phoneAccountsPresent=true fingerprintsPresent=true fingerprintsStable=true",
        )
    }

    private fun value(instance: Any?, method: String): Any? =
        requireNotNull(instance).javaClass.getMethod(method).invoke(instance)

    private companion object { const val TAG = "PrivilegedSimProbe" }
}
