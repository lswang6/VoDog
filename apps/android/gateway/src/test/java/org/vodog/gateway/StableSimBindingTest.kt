package org.vodog.gateway

import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class StableSimBindingTest {
    @Test fun `slot exchange binds by fingerprint instead of response order or old slot`() {
        val localA = local(slot = 1, subscription = 101, fingerprint = FINGERPRINT_A)
        val localB = local(slot = 0, subscription = 202, fingerprint = FINGERPRINT_B)
        val server = listOf(
            synced("sim-b", slot = 0, subscription = 202, fingerprint = FINGERPRINT_B),
            synced("sim-a", slot = 1, subscription = 101, fingerprint = FINGERPRINT_A),
        )

        val matches = matchStableSimBindings(listOf(localA, localB), server)

        assertEquals(listOf("sim-a", "sim-b"), matches.map { it.server.id })
    }

    @Test fun `missing duplicate or route-mismatched identity fails closed`() {
        val local = local(slot = 0, subscription = 101, fingerprint = FINGERPRINT_A)
        assertThrows(IllegalArgumentException::class.java) { matchStableSimBindings(listOf(local), emptyList()) }
        assertThrows(IllegalArgumentException::class.java) {
            matchStableSimBindings(listOf(local, local.copy(slotIndex = 1)), listOf(
                synced("a", 0, 101, FINGERPRINT_A), synced("b", 1, 101, FINGERPRINT_B),
            ))
        }
        assertThrows(IllegalArgumentException::class.java) {
            matchStableSimBindings(listOf(local), listOf(synced("a", 1, 101, FINGERPRINT_A)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            matchStableSimBindings(listOf(local), listOf(synced("a", 0, 101, FINGERPRINT_B)))
        }
    }

    @Test fun `country metadata accepts only a two-letter SIM country`() {
        assertEquals("CN", normalizedSimCountryIso("cn"))
        assertEquals("US", normalizedSimCountryIso(" Us "))
        assertEquals(null, normalizedSimCountryIso("CHN"))
        assertEquals(null, normalizedSimCountryIso("1n"))
        assertEquals(null, normalizedSimCountryIso(null))
    }

    @Test fun `iccid cardId and fallback domains never collide and stay stable`() {
        val fp = hmac()
        val iccid = fp.derive(ICCID_A)
        val card = fp.deriveCardId(12)
        val fallback = fp.deriveFallback(0, 101, 42)
        assertEquals(64, iccid.length)
        assertEquals(64, card.length)
        assertEquals(64, fallback.length)
        assertEquals(iccid, fp.derive(ICCID_A))
        assertEquals(card, fp.deriveCardId(12))
        assertEquals(fallback, fp.deriveFallback(0, 101, 42))
        assertNotEquals(fallback, fp.deriveFallback(1, 101, 42))
        assertEquals(3, setOf(iccid, card, fallback).size)
        val shared = "12"
        assertEquals(
            3,
            setOf(
                fp.deriveDomain("iccid", shared),
                fp.deriveDomain("card-id", shared),
                fp.deriveDomain("fallback", shared),
            ).size,
        )
    }

    @Test fun `cascade prefers ICCID then physical cardId and skips eSIM cardId`() {
        val fp = hmac()
        val iccidHit = resolveSimIdentity(ICCID_A, ICCID_B, cardId = 4, embedded = false, 0, 10, fp, true)
        assertEquals(SimIdentityKind.ICCID, iccidHit!!.kind)
        assertEquals(portableIccidFingerprint(ICCID_A), iccidHit.fingerprint)
        assertEquals(fp.derive(ICCID_A), iccidHit.legacyFingerprint)

        val serialBlankUsesInfoIccid = resolveSimIdentity("  ", ICCID_B, cardId = 4, embedded = false, 0, 10, fp, true)
        assertEquals(SimIdentityKind.ICCID, serialBlankUsesInfoIccid!!.kind)
        assertEquals(portableIccidFingerprint(ICCID_B), serialBlankUsesInfoIccid.fingerprint)

        val cardHit = resolveSimIdentity(null, "", cardId = 4, embedded = false, 0, 10, fp, true)
        assertEquals(SimIdentityKind.CARD_ID, cardHit!!.kind)
        assertEquals(fp.deriveCardId(4), cardHit.fingerprint)
        assertNull(cardHit.legacyFingerprint)

        val shortIccidFallsThrough = resolveSimIdentity("12345", null, cardId = 3, embedded = false, 0, 1, fp, false)
        assertEquals(SimIdentityKind.CARD_ID, shortIccidFallsThrough!!.kind)

        val esimSkipsCardId = resolveSimIdentity(null, "", cardId = 4, embedded = true, 1, 11, fp, true)
        assertEquals(SimIdentityKind.FALLBACK, esimSkipsCardId!!.kind)
        assertEquals(fp.deriveFallback(1, 11, "".hashCode()), esimSkipsCardId.fingerprint)

        val invalidCardUsesFallback = resolveSimIdentity(null, null, cardId = -1, embedded = false, 2, 12, fp, true)
        assertEquals(SimIdentityKind.FALLBACK, invalidCardUsesFallback!!.kind)
        assertEquals(fp.deriveFallback(2, 12, 0), invalidCardUsesFallback.fingerprint)

        val privilegedPixelFailsClosed = resolveSimIdentity(
            null, null, cardId = -1, embedded = true, 0, 1, fp, allowFallback = false,
        )
        assertNull(privilegedPixelFailsClosed)
    }

    @Test fun `portable ICCID fingerprint matches the S65 vector and ignores non-digits`() {
        assertEquals("99730339b1c3bf294190599953620ef3", portableIccidFingerprint("89860321234567890123"))
        assertEquals("99730339b1c3bf294190599953620ef3", portableIccidFingerprint("89860321234567890123F"))
        assertEquals("99730339b1c3bf294190599953620ef3", portableIccidFingerprint("89860321234567890123f"))
        assertThrows(IllegalArgumentException::class.java) { portableIccidFingerprint("1234") }
    }

    @Test fun `embedded eSIM with readable ICCID uses portable identity plus legacy HMAC`() {
        val fp = hmac()
        val esim = resolveSimIdentity(null, ICCID_A, cardId = 4, embedded = true, 1, 11, fp, allowFallback = false)
        assertEquals(SimIdentityKind.ICCID, esim!!.kind)
        assertEquals(portableIccidFingerprint(ICCID_A), esim.fingerprint)
        assertEquals(fp.derive(ICCID_A), esim.legacyFingerprint)
        // The portable value never depends on the device key; the legacy one does.
        val otherDevice = IccidFingerprint(SecretKeySpec(ByteArray(32) { 7 }, "HmacSHA256"))
        val moved = resolveSimIdentity(null, ICCID_A, cardId = 4, embedded = true, 0, 99, otherDevice, false)!!
        assertEquals(esim.fingerprint, moved.fingerprint)
        assertNotEquals(esim.legacyFingerprint, moved.legacyFingerprint)
    }

    @Test fun `phone number is normalized or omitted`() {
        assertEquals("+8613312345678", normalizedSimPhoneNumber("+86 133-1234-5678"))
        assertEquals("13312345678", normalizedSimPhoneNumber("13312345678"))
        assertNull(normalizedSimPhoneNumber(""))
        assertNull(normalizedSimPhoneNumber("12"))
        assertNull(normalizedSimPhoneNumber("(133) 1234"))
        assertNull(normalizedSimPhoneNumber(null))
    }

    @Test fun `upgrade re-keys the stored binding to the portable fingerprint and keeps simId`() {
        val portable = portableIccidFingerprint(ICCID_A)
        val legacy = hmac().derive(ICCID_A)
        lateinit var request: GatewayHttpRequest
        val local = local(0, 101, portable).copy(
            identityKind = SimIdentityKind.ICCID, legacyIccidFingerprint = legacy, phoneNumber = "133 1234 5678",
        )
        // Control (S65) rewrote the stored hash in place: same id, echoes the new fingerprint.
        val synced = GatewayApi("token", { true }, GatewayHttpTransport {
            request = it
            GatewayHttpResponse(200, """{"items":[{
                "id":"sim-old","iccidFingerprint":"$portable","slotIndex":0,"subscriptionId":101,
                "phoneAccountHandle":null,"countryIso":null,"embedded":false,"label":"SIM 1",
                "version":3,"assignmentVersion":3,"assignmentPending":false,"needsOwnerAssignment":false,"routable":true
            }]}""")
        }).syncSims(listOf(local))
        val item = JSONObject(String(requireNotNull(request.jsonBody))).getJSONArray("items").getJSONObject(0)
        assertEquals(portable, item.getString("iccidFingerprint"))
        assertEquals(legacy, item.getString("legacyIccidFingerprint"))
        assertEquals("13312345678", item.getString("phoneNumber"))
        assertFalse(item.toString().contains(ICCID_A))
        assertEquals("sim-old", matchStableSimBindings(listOf(local), synced).single().server.id)

        // An old Control echoing the legacy fingerprint must not be silently accepted as the same SIM.
        assertThrows(IllegalArgumentException::class.java) {
            matchStableSimBindings(listOf(local), listOf(synced("sim-old", 0, 101, legacy)))
        }
    }

    // A "/" is illegal in a JVM method name, so the test name spells the zone without the separator.
    @Test fun `heartbeat time zone rejects offsets and Asia-Beijing`() {
        assertEquals("Asia/Shanghai", gatewayTimeZoneId("Asia/Shanghai"))
        assertNull(gatewayTimeZoneId("GMT+08:00"))
        assertNull(gatewayTimeZoneId("UTC"))
        assertNull(gatewayTimeZoneId("Asia/Beijing"))
        assertNull(gatewayTimeZoneId(null))
    }

    @Test fun `identity log never includes ICCID material`() {
        val line = describeSimIdentity(0, SimIdentityKind.ICCID, "abcdef0123456789")
        assertEquals("slot=0 identityKind=iccid fingerprint=abcdef01", line)
        assertFalse(line.contains(ICCID_A))
        assertFalse(line.contains("abcdef0123456789"))
    }

    @Test fun `sim sync sends optional identityKind without raw ICCID`() {
        lateinit var request: GatewayHttpRequest
        val local = local(0, 101, FINGERPRINT_A).copy(identityKind = SimIdentityKind.CARD_ID)
        GatewayApi("token", { true }, GatewayHttpTransport {
            request = it
            GatewayHttpResponse(
                200,
                """{"items":[{
                    "id":"sim-a","iccidFingerprint":"$FINGERPRINT_A","slotIndex":0,"subscriptionId":101,
                    "phoneAccountHandle":null,"countryIso":null,"embedded":false,"label":"SIM 1",
                    "version":1,"assignmentVersion":1,"assignmentPending":false,"needsOwnerAssignment":false,"routable":true
                }]}""",
            )
        }).syncSims(listOf(local))
        val item = JSONObject(String(requireNotNull(request.jsonBody))).getJSONArray("items").getJSONObject(0)
        assertEquals("cardId", item.getString("identityKind"))
        assertEquals(FINGERPRINT_A, item.getString("iccidFingerprint"))
        assertFalse(item.toString().contains(ICCID_A))
        assertTrue(request.url.endsWith(GatewayApiRoutes.SIM_SYNC))

        GatewayApi("token", { true }, GatewayHttpTransport {
            request = it
            GatewayHttpResponse(200, """{"items":[{
                "id":"sim-a","iccidFingerprint":"$FINGERPRINT_A","slotIndex":0,"subscriptionId":101,
                "phoneAccountHandle":null,"countryIso":null,"embedded":false,"label":"SIM 1",
                "version":1,"assignmentVersion":1,"assignmentPending":false,"needsOwnerAssignment":false,"routable":true
            }]}""")
        }).syncSims(listOf(local.copy(identityKind = null)))
        assertFalse(
            JSONObject(String(requireNotNull(request.jsonBody)))
                .getJSONArray("items").getJSONObject(0).has("identityKind"),
        )
        val bare = JSONObject(String(requireNotNull(request.jsonBody))).getJSONArray("items").getJSONObject(0)
        assertFalse(bare.has("legacyIccidFingerprint"))
        assertFalse(bare.has("phoneNumber"))
    }

    private fun hmac() = IccidFingerprint(SecretKeySpec(ByteArray(32) { 9 }, "HmacSHA256"))

    private fun local(slot: Int, subscription: Int, fingerprint: String) = SimSnapshot(
        slotIndex = slot,
        subscriptionId = subscription,
        carrierName = "carrier",
        displayName = "display",
        phoneAccountHandle = null,
        protectedPhoneAccountHandle = null,
        iccidFingerprint = fingerprint,
        countryIso = null,
        embedded = false,
    )

    private fun synced(id: String, slot: Int, subscription: Int, fingerprint: String) = SyncedSim(
        id = id,
        iccidFingerprint = fingerprint,
        slotIndex = slot,
        subscriptionId = subscription,
        phoneAccountHandle = null,
        countryIso = null,
        embedded = false,
        label = id,
        assignmentVersion = 1,
        assignmentPending = false,
        needsOwnerAssignment = false,
        routable = true,
    )

    private companion object {
        const val FINGERPRINT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val FINGERPRINT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        const val ICCID_A = "89012345678901234567"
        const val ICCID_B = "89999999999999999999"
    }
}
