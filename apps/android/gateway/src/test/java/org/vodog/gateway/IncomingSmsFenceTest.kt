package org.vodog.gateway

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingSmsFenceTest {
    private val receipt = IncomingSmsRecord(
        eventId = "11111111-1111-4111-8111-111111111111",
        generation = 4,
        simIdAtReceipt = "22222222-2222-4222-8222-222222222222",
        assignmentVersionAtReceipt = 7,
        subscriptionId = 2,
        phoneAccountHandle = "pa:protected",
        iccidFingerprint = "fingerprint",
        remoteNumber = "+12025550101",
        body = "private message",
        receivedAt = "2026-09-09T01:00:00Z",
        reported = false,
    )

    @Test fun reassignmentNeverOverwritesReceiptVersion() {
        val currentAfterReassignment = binding(assignmentVersion = 8)
        assertTrue(eligibleIncomingBinding(receipt, currentAfterReassignment, 4))
        // Eligibility permits only an attempt using receipt.assignmentVersionAtReceipt=7;
        // the server sees 7 != 8 and returns local_only without storing for the new owner.
        assertTrue(receipt.assignmentVersionAtReceipt != currentAfterReassignment.assignmentVersion)
    }

    @Test fun missingReceiptFenceWrongEpochOrChangedSimIdentityStaysLocal() {
        assertFalse(eligibleIncomingBinding(receipt.copy(assignmentVersionAtReceipt = null), binding(), 4))
        assertFalse(eligibleIncomingBinding(receipt, binding(), 5))
        assertFalse(eligibleIncomingBinding(receipt, binding().copy(iccidFingerprint = "replacement"), 4))
        assertFalse(eligibleIncomingBinding(receipt, binding(routable = false), 4))
    }

    @Test fun listedSenderIsDroppedOnlyWhileControlIsEnabled() {
        assertTrue(shouldDropIncomingSms(enabled = true, listed = true))
        assertFalse(shouldDropIncomingSms(enabled = false, listed = true))
        assertFalse(shouldDropIncomingSms(enabled = true, listed = false))
        assertTrue(numberBlocklistMatches("+12025550101", listOf("+1 202 555 0101"), "US"))
        assertFalse(numberBlocklistMatches(receipt.remoteNumber, listOf("+12025550102"), "US"))
    }

    @Test fun outboundRouteSnapshotRejectsSubscriptionAssignmentOrIdentityChange() {
        val frozen = binding()
        assertTrue(sameExecutionRoute(frozen, frozen.copy()))
        assertFalse(sameExecutionRoute(frozen.copy(subscriptionId = 99), frozen))
        assertFalse(sameExecutionRoute(frozen.copy(assignmentVersion = 8), frozen))
        assertFalse(sameExecutionRoute(frozen.copy(phoneAccountHandle = "replacement"), frozen))
        assertFalse(sameExecutionRoute(frozen.copy(iccidFingerprint = "replacement"), frozen))
    }

    private fun binding(assignmentVersion: Int = 7, routable: Boolean = true) = ServerSimBinding(
        simId = requireNotNull(receipt.simIdAtReceipt),
        slotIndex = 0,
        label = "SIM 1",
        assignmentVersion = assignmentVersion,
        subscriptionId = receipt.subscriptionId,
        phoneAccountHandle = receipt.phoneAccountHandle,
        iccidFingerprint = receipt.iccidFingerprint,
        routable = routable,
    )
}
