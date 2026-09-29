package org.vodog.gateway

import android.provider.Telephony
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutgoingSmsObservationTest {
    private val sim = SimSnapshot(
        slotIndex = 0,
        subscriptionId = 15,
        carrierName = "carrier",
        displayName = "SIM",
        phoneAccountHandle = null,
        protectedPhoneAccountHandle = "protected-account",
        iccidFingerprint = "fingerprint",
        countryIso = "CN",
        embedded = false,
        identityKind = SimIdentityKind.ICCID,
    )
    private val binding = ServerSimBinding(
        simId = "22222222-2222-4222-8222-222222222222",
        slotIndex = 0,
        label = "SIM 1",
        assignmentVersion = 7,
        subscriptionId = 15,
        phoneAccountHandle = "protected-account",
        iccidFingerprint = "fingerprint",
        routable = true,
        countryIso = "CN",
        embedded = false,
    )
    private val manual = OutgoingSmsProviderRow(
        providerRowId = 91,
        providerDateMillis = Instant.parse("2026-09-21T05:59:59Z").toEpochMilli(),
        subscriptionId = 15,
        remoteNumber = "1001298",
        body = "1",
        sentAtMillis = Instant.parse("2026-09-21T06:00:00Z").toEpochMilli(),
        creator = "com.google.android.apps.messaging",
        type = Telephony.Sms.MESSAGE_TYPE_SENT,
    )

    @Test fun manualSentRowBecomesFrozenObservationButGatewayOwnRowIsExcluded() {
        val record = outgoingSmsObservedRecord(manual, 4, binding, sim, "org.vodog.gateway")
        requireNotNull(record)
        assertEquals("1001298", record.remoteNumber)
        assertEquals("1", record.body)
        assertEquals(7, record.assignmentVersion)
        assertNull(outgoingSmsObservedRecord(
            manual.copy(creator = "org.vodog.gateway"),
            4, binding, sim, "org.vodog.gateway",
        ))
    }

    @Test fun unknownCreatorIsNeverReported() {
        assertNull(outgoingSmsObservedRecord(manual.copy(creator = null), 4, binding, sim, "org.vodog.gateway"))
    }

    @Test fun sameProviderRowObservedTwiceIsJournaledOnceAndLeavesPendingAfterReport() {
        val first = requireNotNull(outgoingSmsObservedRecord(manual, 4, binding, sim, "gateway"))
        // Observer double-fire / rescan, including a later date_sent that would change the fingerprint.
        val again = requireNotNull(outgoingSmsObservedRecord(
            manual.copy(sentAtMillis = manual.sentAtMillis + 5_000), 4, binding, sim, "gateway",
        ))
        val rows = mergeOutgoingSmsObservation(mergeOutgoingSmsObservation(emptyList(), first), again)
        assertEquals(listOf(first), rows)
        assertEquals(listOf(first), pendingOutgoingSmsObservations(rows))
        val reported = markOutgoingSmsObservationReported(rows, first.eventId, Instant.parse("2026-09-21T07:00:00Z"))
        assertEquals(1, reported.size)
        assertTrue(pendingOutgoingSmsObservations(reported).isEmpty())
        assertTrue(pendingOutgoingSmsObservations(mergeOutgoingSmsObservation(reported, again)).isEmpty())
    }

    @Test fun observationRequiresSentActiveBoundRouteAndContractSizedPayload() {
        assertNull(outgoingSmsObservedRecord(manual.copy(type = Telephony.Sms.MESSAGE_TYPE_OUTBOX), 4, binding, sim, "gateway"))
        assertNull(outgoingSmsObservedRecord(manual.copy(subscriptionId = 99), 4, binding, sim, "gateway"))
        assertNull(outgoingSmsObservedRecord(manual.copy(body = ""), 4, binding, sim, "gateway"))
        assertNull(outgoingSmsObservedRecord(manual.copy(body = "x".repeat(5001)), 4, binding, sim, "gateway"))
        assertNull(outgoingSmsObservedRecord(manual, 4, binding.copy(routable = false), sim, "gateway"))
        assertNull(outgoingSmsObservedRecord(manual, 4, binding, sim.copy(iccidFingerprint = "replacement"), "gateway"))
    }

    @Test fun eventIdIsStableForProviderRowAndNeverReusedAcrossGenerationOrSim() {
        val sourceAt = manual.providerDateMillis
        val first = outgoingSmsObservedEventId(91, 4, binding.simId, binding.iccidFingerprint, sourceAt)
        assertEquals(first, outgoingSmsObservedEventId(91, 4, binding.simId, binding.iccidFingerprint, sourceAt))
        assertEquals(first, requireNotNull(outgoingSmsObservedRecord(
            manual.copy(sentAtMillis = manual.sentAtMillis + 1_000), 4, binding, sim, "gateway",
        )).eventId)
        assertNotEquals(first, outgoingSmsObservedEventId(91, 5, binding.simId, binding.iccidFingerprint, sourceAt))
        assertNotEquals(first, outgoingSmsObservedEventId(91, 4, "33333333-3333-4333-8333-333333333333", binding.iccidFingerprint, sourceAt))
        assertNotEquals(first, outgoingSmsObservedEventId(91, 4, binding.simId, "replacement", sourceAt))
        assertNotEquals(first, outgoingSmsObservedEventId(91, 4, binding.simId, binding.iccidFingerprint, sourceAt + 1))
        assertNotEquals(first, outgoingSmsObservedEventId(92, 4, binding.simId, binding.iccidFingerprint, sourceAt))
    }

    @Test fun reassignmentKeepsReceiptVersionForControlToSettleLocalOnly() {
        val record = requireNotNull(outgoingSmsObservedRecord(manual, 4, binding, sim, "gateway"))
        assertTrue(eligibleOutgoingSmsBinding(record, binding.copy(assignmentVersion = 8), 4))
        assertTrue(eligibleOutgoingSmsBinding(record, binding.copy(assignmentVersion = 8, routable = false), 4))
        assertTrue(eligibleOutgoingSmsBinding(record, null, 4))
        assertEquals(7, record.assignmentVersion)
        assertFalse(eligibleOutgoingSmsBinding(record, binding.copy(iccidFingerprint = "replacement"), 4))
        assertFalse(eligibleOutgoingSmsBinding(record, binding, 5))
        assertFalse(eligibleOutgoingSmsBinding(record, null, 5))
    }

    @Test fun reportedObservationCompactsToIdempotencyTombstoneButPendingBodyIsRetained() {
        val record = requireNotNull(outgoingSmsObservedRecord(manual, 4, binding, sim, "gateway"))
            .copy(reported = true, reportedAt = "2026-09-01T00:00:00Z")
        val tombstone = compactOutgoingSmsObservedRecords(
            listOf(record), Instant.parse("2026-09-08T00:00:00Z"),
        ).single()
        assertTrue(tombstone.tombstone)
        assertEquals("", tombstone.body)
        assertEquals(record.eventId, tombstone.eventId)
        val pending = record.copy(reported = false, reportedAt = null)
        assertEquals("1", compactOutgoingSmsObservedRecords(
            listOf(pending), Instant.parse("2026-12-01T00:00:00Z"),
        ).single().body)
    }

    @Test fun pendingHistoricalSampleRoundTripsThroughDurableJournalEncoding() {
        val record = requireNotNull(outgoingSmsObservedRecord(manual, 4, binding, sim, "gateway"))
        assertEquals(listOf(record), decodeOutgoingSmsObservedRecords(encodeOutgoingSmsObservedRecords(listOf(record))))
        assertFalse(record.reported)
        assertEquals("1001298", record.remoteNumber)
        assertEquals("1", record.body)
    }

    @Test fun backfillWindowIsBoundedToTwoDays() {
        val now = Instant.parse("2026-09-21T08:40:00Z").toEpochMilli()
        assertEquals(now - 2L * 24 * 60 * 60 * 1000, outgoingSmsBackfillStartMillis(now))
        assertEquals(200, OUTGOING_SMS_SCAN_LIMIT)

        val historicalSampleDate = Instant.parse("2026-09-21T06:41:42.544Z").toEpochMilli()
        assertTrue(historicalSampleDate >= outgoingSmsBackfillStartMillis(now))
        assertTrue(historicalSampleDate <= now)
    }

    @Test fun realPixelDateSentZeroFallsBackToProviderDate() {
        val providerDate = Instant.parse("2026-09-21T06:41:42.544Z").toEpochMilli()
        assertEquals(providerDate, outgoingSmsProviderSentAtMillis(providerDate, 0L))
        assertEquals(providerDate, outgoingSmsProviderSentAtMillis(providerDate, -1L))
        val explicitDateSent = providerDate + 1234L
        assertEquals(explicitDateSent, outgoingSmsProviderSentAtMillis(providerDate, explicitDateSent))

        val realSample = manual.copy(
            providerRowId = 656L,
            providerDateMillis = providerDate,
            sentAtMillis = outgoingSmsProviderSentAtMillis(providerDate, 0L),
            subscriptionId = 15,
            remoteNumber = "1001298",
            body = "1",
            creator = "com.google.android.apps.messaging",
            type = Telephony.Sms.MESSAGE_TYPE_SENT,
        )
        val record = requireNotNull(outgoingSmsObservedRecord(realSample, 4, binding, sim, "org.vodog.gateway"))
        assertEquals("2026-09-21T06:41:42.544Z", record.sentAt)
        assertEquals(656L, record.providerRowId)
        assertEquals("1001298", record.remoteNumber)
        assertEquals("1", record.body)
    }
}
