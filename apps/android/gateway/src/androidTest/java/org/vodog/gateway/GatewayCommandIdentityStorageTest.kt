package org.vodog.gateway

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Exercises the real device-protected SharedPreferences adapters behind command ownership.
 * Every preference name is redirected to a per-test UUID namespace; no production gateway
 * credential, queue, service, network or Telecom API is touched.
 */
@RunWith(AndroidJUnit4::class)
class GatewayCommandIdentityStorageTest {
    private lateinit var context: IsolatedDeviceProtectedContext

    @Before
    fun setUp() {
        val application = ApplicationProvider.getApplicationContext<Context>()
        context = IsolatedDeviceProtectedContext(
            application.createDeviceProtectedStorageContext(),
            "vodog_identity_test_${UUID.randomUUID()}_",
        )
    }

    @After
    fun tearDown() {
        context.clearTestPreferences()
    }

    @Test
    fun oldAckAndPendingQueuesRemainReadableOnlyThroughTheirExactIdentity() {
        val runtime = GatewayRuntimeStore(context)
        val oldCredential = "old-device-token-${UUID.randomUUID()}"
        runtime.activatePairingIdentity(GATEWAY_A, 7, oldCredential)
        val oldIdentity = runtime.confirmServerIdentity(GATEWAY_A, 7, oldCredential)
        val command = rejectedCommand(generation = 7, sequence = 11)
        val spec = rejectedSpec(command)

        PendingCommandStore(context, oldIdentity).rememberRejected(command)
        CallAckOutbox(context, oldIdentity).enqueue(spec, CallExecutionDecision.Rejected("not_executed"))

        val newCredential = "new-device-token-${UUID.randomUUID()}"
        runtime.activatePairingIdentity(GATEWAY_B, 9, newCredential)
        val newIdentity = runtime.confirmServerIdentity(GATEWAY_B, 9, newCredential)

        assertNotEquals(oldIdentity.storageSuffix, newIdentity.storageSuffix)
        assertTrue(PendingCommandStore(context, newIdentity).pending().isEmpty())
        assertTrue(CallAckOutbox(context, newIdentity).pending().isEmpty())
        assertEquals(listOf(command.commandId), PendingCommandStore(context, oldIdentity).pending().map { it.commandId })
        assertEquals(listOf(command.commandId), CallAckOutbox(context, oldIdentity).pending().map { it.commandId })
    }

    @Test
    fun sameIdentityAndEpochSurviveRuntimeStoreRecreationWithoutQueueMigration() {
        val credential = "restart-device-token-${UUID.randomUUID()}"
        val firstRuntime = GatewayRuntimeStore(context)
        firstRuntime.activatePairingIdentity(GATEWAY_A, 12, credential)
        val firstIdentity = firstRuntime.confirmServerIdentity(GATEWAY_A, 12, credential)
        val command = rejectedCommand(generation = 12, sequence = 4)
        val spec = rejectedSpec(command)
        PendingCommandStore(context, firstIdentity).rememberRejected(command)
        CallAckOutbox(context, firstIdentity).enqueue(spec, CallExecutionDecision.Rejected("not_executed"))
        firstRuntime.reportedSequence = 3

        val restartedRuntime = GatewayRuntimeStore(context)
        val restartedIdentity = restartedRuntime.confirmServerIdentity(GATEWAY_A, 12, credential)

        assertEquals(firstIdentity, restartedIdentity)
        assertEquals(3L, restartedRuntime.reportedSequence)
        assertEquals(listOf(command.commandId), PendingCommandStore(context, restartedIdentity).pending().map { it.commandId })
        assertEquals(listOf(command.commandId), CallAckOutbox(context, restartedIdentity).pending().map { it.commandId })
    }

    @Test
    fun pairingActivationConfirmationAndClearChangeOnlyThePairingIdentityFields() {
        val runtime = GatewayRuntimeStore(context)
        runtime.enabled = true
        runtime.connection = ServerConnection.ONLINE
        runtime.connectionDetail = "test-only"
        runtime.reportedSequence = 99
        runtime.deviceEpoch = 6
        assertEquals(1L, runtime.nextTelecomSnapshotSequence())

        val credential = "pairing-device-token-${UUID.randomUUID()}"
        runtime.activatePairingIdentity(GATEWAY_A, 15, credential)
        assertEquals(GATEWAY_A, runtime.gatewayId)
        assertEquals(15L, runtime.deviceEpoch)
        assertEquals(0L, runtime.reportedSequence)
        assertEquals(1L, runtime.nextTelecomSnapshotSequence())
        val confirmed = runtime.confirmServerIdentity(GATEWAY_A, 15, credential)
        assertEquals(confirmed, runtime.activeCommandIdentity())

        assertThrows(IllegalStateException::class.java) {
            runtime.confirmServerIdentity(GATEWAY_B, 15, credential)
        }
        assertEquals(confirmed, runtime.activeCommandIdentity())

        runtime.clearPairingIdentity()
        assertNull(runtime.gatewayId)
        assertEquals(0L, runtime.deviceEpoch)
        assertEquals(0L, runtime.reportedSequence)
        assertNull(runtime.activeCommandIdentity())
        assertEquals(1L, runtime.nextTelecomSnapshotSequence())
        assertTrue(runtime.enabled)
        assertEquals(ServerConnection.ONLINE, runtime.connection)
        assertEquals("test-only", runtime.connectionDetail)
    }

    private fun rejectedCommand(generation: Long, sequence: Long) = GatewayCommand(
        commandId = UUID.randomUUID().toString(),
        generation = generation,
        sequence = sequence,
        callId = UUID.randomUUID().toString(),
        kind = "hangup",
        payloadJson = "{\"deviceCallId\":\"identity-storage-test-call\"}",
        expiresAt = "2099-01-01T00:00:00Z",
    )

    private fun rejectedSpec(command: GatewayCommand) = CallCommandSpec(
        commandId = command.commandId,
        serverCallId = requireNotNull(command.callId),
        generation = command.generation,
        sequence = command.sequence,
        expiresAt = requireNotNull(command.expiresAt),
        kind = CallCommandKind.HANG_UP,
        deviceCallId = "identity-storage-test-call",
    )

    private class IsolatedDeviceProtectedContext(
        base: Context,
        private val prefix: String,
    ) : ContextWrapper(base) {
        private val openedNames = linkedSetOf<String>()

        override fun createDeviceProtectedStorageContext(): Context = this

        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            val isolatedName = prefix + name
            openedNames += isolatedName
            return baseContext.getSharedPreferences(isolatedName, mode)
        }

        fun clearTestPreferences() {
            openedNames.forEach(baseContext::deleteSharedPreferences)
        }
    }

    private companion object {
        const val GATEWAY_A = "11111111-1111-1111-1111-111111111111"
        const val GATEWAY_B = "22222222-2222-2222-2222-222222222222"
    }
}
