package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidBackgroundCallsTest {
    private val callId = "11111111-1111-4111-8111-111111111111"
    private val notificationId = "22222222-2222-4222-8222-222222222222"

    @Test
    fun pushPayloadIsExactAndDataOnly() {
        val parsed = parseIncomingPush(mapOf(
            "version" to "1",
            "event" to "call.incoming",
            "callId" to callId,
            "notificationId" to notificationId,
        ))
        assertEquals(IncomingPush("call.incoming", callId, notificationId), parsed)
        // S36 C1: `remoteNumber` is now an allowed optional key, so the notification can show the
        // number before `GET /calls/:id` answers. Everything outside the allow-list still drops.
        assertEquals(
            IncomingPush("call.incoming", callId, notificationId, null, "+12025550101"),
            parseIncomingPush(mapOf(
                "version" to "1",
                "event" to "call.incoming",
                "callId" to callId,
                "notificationId" to notificationId,
                "remoteNumber" to "+12025550101",
            )),
        )
        assertNull(parseIncomingPush(mapOf(
            "version" to "1",
            "event" to "call.incoming",
            "callId" to callId,
            "notificationId" to notificationId,
            "callerHint" to "+12025550101",
        )))
        assertNull(parseIncomingPush(mapOf(
            "version" to "1",
            "event" to "call.changed",
            "callId" to callId,
            "notificationId" to notificationId,
        )))
    }

    @Test
    fun winnerCancellationKeepsOngoingCallButEndsRingingLoser() {
        assertEquals(
            CancelledCallDisposition.KEEP_ONGOING,
            cancelledCallDisposition(claimedByCurrentSession = true, state = "active"),
        )
        assertEquals(
            CancelledCallDisposition.END_LOCAL,
            cancelledCallDisposition(claimedByCurrentSession = false, state = "active"),
        )
        assertEquals(
            CancelledCallDisposition.END_LOCAL,
            cancelledCallDisposition(claimedByCurrentSession = true, state = "ended"),
        )
    }

    @Test
    fun pushRegistrationUsesFrozenAndroidContract() {
        val requests = mutableListOf<ClientRequest>()
        val transport = ClientTransport { request ->
            requests += request
            JSONObject().put("registration", JSONObject()
                .put("id", "33333333-3333-4333-8333-333333333333")
                .put("installationId", callId)
                .put("fcmEnabled", true)
                .put("updatedAt", "2026-09-10T00:00:00Z"))
        }
        val sessions = SessionCoordinator(Session("access", "refresh", "caller_test"))
        val api = ClientApi(sessions, transport)
        api.registerAndroidPush(callId, "t".repeat(32))
        api.deletePushRegistration(callId)

        val put = requests[0]
        assertEquals("PUT", put.method)
        assertEquals("/push/registrations/$callId", put.path)
        assertEquals(
            setOf("platform", "packageName", "deviceName", "fcmToken"),
            put.body!!.keys().asSequence().toSet(),
        )
        assertEquals("android", put.body!!.getString("platform"))
        assertEquals("org.vodog", put.body!!.getString("packageName"))
        assertTrue(put.bearerToken!!.isNotBlank())
        assertEquals("DELETE", requests[1].method)
        assertEquals(null, requests[1].body)
    }

    @Test
    fun staleServiceActionsCannotCreateForegroundCallState() {
        assertEquals(false, serviceActionPermitted(
            OngoingCallService.ACTION_ANSWER,
            hasExactTokenRecord = false,
            isActiveCall = false,
            ownsMedia = false,
        ))
        assertEquals(false, serviceActionPermitted(
            OngoingCallService.ACTION_SPEAKER,
            hasExactTokenRecord = false,
            isActiveCall = false,
            ownsMedia = false,
        ))
        assertEquals(true, serviceActionPermitted(
            OngoingCallService.ACTION_MUTE,
            hasExactTokenRecord = false,
            isActiveCall = true,
            ownsMedia = true,
        ))
        assertEquals(true, serviceActionPermitted(
            OngoingCallService.ACTION_CANCEL_RINGING,
            hasExactTokenRecord = false,
            isActiveCall = true,
            ownsMedia = false,
        ))
        assertEquals(true, serviceActionPermitted(
            OngoingCallService.ACTION_CONNECT,
            hasExactTokenRecord = true,
            isActiveCall = false,
            ownsMedia = false,
        ))
    }

    @Test
    fun serviceSweepsOnlyCallsNothingOwns() {
        val a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        val idle = CallMediaUiState()
        // S79: A's media failed and the server ended it; B is the live call.
        assertEquals(setOf(a), orphanedServiceCalls(setOf(a, b), emptySet(), emptySet(), CallMediaUiState(b, CallMediaPhase.CONNECTED)))
        assertEquals(setOf(a, b), orphanedServiceCalls(setOf(a, b), emptySet(), emptySet(), idle))
        // The ringing / authority loop owns it.
        assertEquals(emptySet<String>(), orphanedServiceCalls(setOf(a), setOf(a), emptySet(), idle))
        // ACTION_CONNECT is still fetching the call before the runtime begins.
        assertEquals(emptySet<String>(), orphanedServiceCalls(setOf(a), emptySet(), setOf(a), idle))
        // The grace window still owns a FAILED call.
        assertEquals(emptySet<String>(), orphanedServiceCalls(setOf(a), emptySet(), emptySet(), CallMediaUiState(a, CallMediaPhase.FAILED)))
    }

    @Test
    fun automaticEndUsesCurrentSessionOwnerFence() {
        val requests = mutableListOf<ClientRequest>()
        val transport = ClientTransport { request -> requests += request; JSONObject() }
        val api = ClientApi(SessionCoordinator(Session("access", "refresh", "caller_test")), transport)
        api.endCall(callId, onlyIfCurrentSessionOwner = true)
        assertEquals("POST", requests.single().method)
        assertEquals("/calls/$callId/end", requests.single().path)
        assertEquals(setOf("onlyIfCurrentSessionOwner"), requests.single().body!!.keys().asSequence().toSet())
        assertTrue(requests.single().body!!.getBoolean("onlyIfCurrentSessionOwner"))
    }

    @Test
    fun explicitRingingDeclineUsesAtomicRingingFence() {
        val requests = mutableListOf<ClientRequest>()
        val transport = ClientTransport { request -> requests += request; JSONObject() }
        val api = ClientApi(SessionCoordinator(Session("access", "refresh", "caller_test")), transport)
        api.endCall(callId, onlyIfRinging = true)
        assertEquals(setOf("onlyIfRinging"), requests.single().body!!.keys().asSequence().toSet())
        assertTrue(requests.single().body!!.getBoolean("onlyIfRinging"))
    }

    @Test
    fun expiredActionRecordsArePrunedBeforeCapacityAccounting() {
        val now = 1_000_000L
        val fresh = StoredIncomingCall(callId, notificationId, "account", "session", "action", now - 1)
        val expired = fresh.copy(callId = "33333333-3333-4333-8333-333333333333", createdAtMs = now - INCOMING_RECORD_TTL_MS - 1)
        assertEquals(listOf(fresh), freshIncomingRecords(listOf(expired, fresh), now))
    }

    @Test
    fun automaticActionsRequireExactPersistentLoginGeneration() {
        val expected = ServiceSessionIdentity(7, "generation-a", "caller_test")
        assertTrue(serviceIdentityMatches(expected, expected.copy()))
        assertEquals(false, serviceIdentityMatches(expected, expected.copy(epoch = 8)))
        assertEquals(false, serviceIdentityMatches(expected, expected.copy(generation = "generation-b")))
        assertEquals(false, serviceIdentityMatches(expected, expected.copy(username = "caller_test2")))
        assertEquals(false, serviceIdentityMatches(expected, null))
    }

    @Test
    fun replacementSessionCannotBeUsedByDelayedMutation() {
        val requests = mutableListOf<ClientRequest>()
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "caller_test"))
        val expected = sessions.snapshot()
        val api = ClientApi(sessions, ClientTransport { request -> requests += request; JSONObject() })
        sessions.clear()
        assertThrows(SessionChangedException::class.java) {
            api.claimCall(callId, expected)
        }
        assertThrows(SessionChangedException::class.java) {
            api.endCall(callId, onlyIfCurrentSessionOwner = true, requiredSession = expected)
        }
        assertTrue(requests.isEmpty())
    }

    @Test
    fun normalRefreshUsesLatestBearerButReloginRemainsFenced() {
        val requests = mutableListOf<ClientRequest>()
        val sessions = SessionCoordinator(Session("old-access", "old-refresh", "caller_test"))
        val expected = sessions.snapshot()
        sessions.refresh(expected) { Session("new-access", "new-refresh", it.username) }
        val api = ClientApi(sessions, ClientTransport { request -> requests += request; JSONObject() })
        api.endCall(callId, onlyIfCurrentSessionOwner = true, requiredSession = expected)
        assertEquals("new-access", requests.single().bearerToken)

        val refreshedEpoch = sessions.snapshot().epoch
        sessions.install(refreshedEpoch, Session("replacement", "replacement-refresh", "caller_test"))
        assertThrows(SessionChangedException::class.java) {
            api.endCall(callId, onlyIfCurrentSessionOwner = true, requiredSession = expected)
        }
        assertEquals(1, requests.size)
    }
}
