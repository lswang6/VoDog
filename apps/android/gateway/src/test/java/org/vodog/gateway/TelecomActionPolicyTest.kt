package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TelecomActionPolicyTest {
    private val fullyGranted = TelecomGateState(true, true, true, true)

    @Test fun everyMutationIsRejectedWhileControlDisabled() {
        val disabled = fullyGranted.copy(controlEnabled = false)
        TelecomAction.entries.forEach { action ->
            assertEquals(
                TelecomActionResult.Rejected("CONTROL_DISABLED"),
                TelecomActionPolicy.authorize(action, disabled),
            )
        }
    }

    @Test fun privilegedPermissionIsRequiredBeforeAnyMutation() {
        val missingPrivilege = fullyGranted.copy(privilegedTelephony = false)
        TelecomAction.entries.forEach { action ->
            assertEquals(
                TelecomActionResult.Rejected("TELECOM_PRIVILEGE_MISSING"),
                TelecomActionPolicy.authorize(action, missingPrivilege),
            )
        }
    }

    @Test fun actionSpecificRuntimePermissionsAndKnownCallAreRequired() {
        assertEquals(
            TelecomActionResult.Rejected("CALL_PHONE_MISSING"),
            TelecomActionPolicy.authorize(TelecomAction.DIAL, fullyGranted.copy(callPhoneGranted = false)),
        )
        assertEquals(
            TelecomActionResult.Rejected("ANSWER_PHONE_CALLS_MISSING"),
            TelecomActionPolicy.authorize(TelecomAction.ANSWER, fullyGranted.copy(answerPhoneCallsGranted = false)),
        )
        assertEquals(
            TelecomActionResult.Rejected("CALL_NOT_FOUND"),
            TelecomActionPolicy.authorize(TelecomAction.HANG_UP, fullyGranted, callPresent = false),
        )
        assertTrue(TelecomActionPolicy.authorize(TelecomAction.DIAL, fullyGranted) is TelecomActionResult.Executed)
    }

    @Test fun answerRequiresRingingAndHangupRejectsDisconnectedCall() {
        assertEquals(
            TelecomActionResult.Rejected("CALL_NOT_RINGING"),
            TelecomActionPolicy.authorize(
                TelecomAction.ANSWER, fullyGranted, callState = ActualTelecomState.ACTIVE,
            ),
        )
        assertTrue(TelecomActionPolicy.authorize(
            TelecomAction.ANSWER, fullyGranted, callState = ActualTelecomState.RINGING,
        ) is TelecomActionResult.Executed)
        assertEquals(
            TelecomActionResult.Rejected("CALL_NOT_ACTIONABLE"),
            TelecomActionPolicy.authorize(
                TelecomAction.HANG_UP, fullyGranted, callState = ActualTelecomState.DISCONNECTED,
            ),
        )
    }

    @Test fun dialNumbersAllowE164DomesticAndServiceDigitsOnly() {
        listOf("+8619900000201", "19900000201", "10000").forEach {
            assertEquals(null, GatewayDialNumberPolicy.rejectionReason(it, isEmergency = false))
        }
        listOf("", "12", "1234567890123456", "*100#", "tel:10000", "100 00", "10000\n1", "10000,1", "10000;1").forEach {
            assertEquals("REMOTE_NUMBER_INVALID", GatewayDialNumberPolicy.rejectionReason(it, isEmergency = false))
        }
    }

    @Test fun systemEmergencyClassificationBlocksOtherwiseValidDigits() {
        listOf("110", "119", "120").forEach {
            assertEquals("EMERGENCY_NUMBER_BLOCKED", GatewayDialNumberPolicy.rejectionReason(it, isEmergency = true))
        }
        listOf("112", "911").forEach {
            assertEquals("EMERGENCY_NUMBER_BLOCKED", GatewayDialNumberPolicy.rejectionReason(it, isEmergency = false))
        }
    }
}
