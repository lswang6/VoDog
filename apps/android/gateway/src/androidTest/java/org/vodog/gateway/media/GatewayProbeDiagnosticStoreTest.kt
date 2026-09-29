package org.vodog.gateway.media

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class GatewayProbeDiagnosticStoreTest {
    @Test fun latestDiagnosticIsWrittenOnlyToDeviceProtectedStorage() {
        val base = ApplicationProvider.getApplicationContext<Context>()
        val context = IsolatedStorageContext(base, "probe_diagnostic_test_${UUID.randomUUID()}_")
        val name = "gateway_media_probe_diagnostic"
        val deviceContext = context.createDeviceProtectedStorageContext()
        try {
            GatewayProbeDiagnosticStore(context).record(GatewayProbeDiagnosticSnapshot(
                generation = "network-generation",
                stage = "accepted",
                optionsStatus = "ok",
                optionsDurationMs = 12,
                resultsStatus = "ok",
                resultsDurationMs = 9,
                nodeOutcomes = listOf(GatewayProbeNodeOutcomes("control-node", 3, 0, 0)),
                validUntil = "2026-09-10T00:00:30Z",
                localReady = true,
            ))

            assertTrue(deviceContext.getSharedPreferences(name, Context.MODE_PRIVATE).contains("latest"))
            assertFalse(context.getSharedPreferences(name, Context.MODE_PRIVATE).contains("latest"))
        } finally {
            context.clearTestPreferences()
        }
    }

    private class IsolatedStorageContext(
        base: Context,
        private val prefix: String,
        private val deviceProtected: Boolean = false,
        private val openedPreferences: MutableList<Pair<Context, String>> = mutableListOf(),
    ) : ContextWrapper(base) {
        override fun getApplicationContext(): Context = this

        override fun createDeviceProtectedStorageContext(): Context =
            IsolatedStorageContext(
                baseContext.createDeviceProtectedStorageContext(), prefix, true, openedPreferences,
            )

        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            val isolatedName = "$prefix${if (deviceProtected) "de_" else "ce_"}$name"
            openedPreferences += baseContext to isolatedName
            return baseContext.getSharedPreferences(isolatedName, mode)
        }

        fun clearTestPreferences() {
            openedPreferences.distinctBy { (storage, name) -> System.identityHashCode(storage) to name }
                .forEach { (storage, name) -> storage.deleteSharedPreferences(name) }
        }
    }
}
