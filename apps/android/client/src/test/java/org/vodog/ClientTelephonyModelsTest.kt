package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientTelephonyModelsTest {
    @Test fun `conversation identity uses stable SIM and server canonical address`() {
        val incoming = sms("sim-a", "+8613812345678", "13812345678")
        val outgoing = sms("sim-a", "13812345678", "13812345678")
        val otherSim = sms("sim-b", "13812345678", "13812345678")
        val conversations = smsConversations(listOf(incoming, outgoing, otherSim), "sim-a")
        assertEquals(1, conversations.size)
        assertEquals("13812345678", conversations.single().key.address)
        assertNotEquals(incoming.toClientSmsMessage().conversationKey, otherSim.toClientSmsMessage().conversationKey)
    }

    @Test fun `refreshed server sent outgoing sms joins thread and drives preview without local send state`() {
        val incomingOld = JSONObject()
            .put("id", "incoming-old").put("simId", "sim-a")
            .put("remoteNumber", "19900000201").put("conversationAddress", "+8619900000201")
            .put("replyNumber", "+8619900000201").put("canReply", true)
            .put("direction", "incoming").put("body", "earlier").put("state", "received")
            .put("createdAt", "2026-09-21T10:00:00Z").put("receivedAt", "2026-09-21T10:00:01Z")
        val otherThread = JSONObject()
            .put("id", "other").put("simId", "sim-a")
            .put("remoteNumber", "10086").put("conversationAddress", "10086")
            .put("replyNumber", "10086").put("canReply", true)
            .put("direction", "incoming").put("body", "other thread").put("state", "received")
            .put("createdAt", "2026-09-21T10:30:00Z").put("receivedAt", "2026-09-21T10:30:01Z")
        val serverSent = JSONObject()
            .put("id", "server-sent").put("simId", "sim-a")
            .put("remoteNumber", "+86 199 0000 0201").put("conversationAddress", "+8619900000201")
            .put("replyNumber", "+8619900000201").put("canReply", true)
            .put("direction", "outgoing").put("body", "sent elsewhere").put("state", "sent")
            .put("createdAt", "2026-09-21T11:00:00Z").put("sentAt", "2026-09-21T11:00:05Z")

        val previous = RemoteList.Loaded(listOf(incomingOld, otherThread))
        val refreshed = remoteListAfterRefresh(
            previous,
            RemoteList.Loaded(listOf(otherThread, serverSent, incomingOld)),
        )
        val rows = (refreshed as RemoteList.Loaded).items
        val conversations = smsConversations(rows, "sim-a")

        assertEquals(listOf("+8619900000201", "10086"), conversations.map { it.key.address })
        val thread = conversations.first()
        assertEquals(listOf("incoming-old", "server-sent"), thread.messages.map(ClientSmsMessage::id))
        assertEquals("server-sent", thread.latest.id)
        assertEquals("outgoing", thread.latest.direction)
        assertEquals("sent elsewhere", thread.latest.body)
        assertEquals("2026-09-21T11:00:05Z", thread.latest.timestamp)
        assertEquals("发出 · SIM 1 · 已发送", smsRowCaption(thread.latest, "SIM 1"))
    }

    @Test fun `explicit cannot reply is never bypassed by remote number fallback`() {
        val blocked = sms("sim-a", "+8613812345678", "13812345678")
            .put("replyNumber", JSONObject.NULL).put("canReply", false)
        val legacy = JSONObject().put("id", "legacy").put("simId", "sim-a")
            .put("remoteNumber", "+8613812345678").put("direction", "incoming")
        assertFalse(blocked.toClientSmsMessage().canReply)
        assertNull(blocked.toClientSmsMessage().replyNumber)
        assertTrue(legacy.toClientSmsMessage().canReply)
        assertEquals("+8613812345678", legacy.toClientSmsMessage().conversationAddress)
    }

    @Test fun `inactive and capability-specific SIM actions fail closed`() {
        val smsOnly = sim(telephony = false, sms = true)
        assertFalse(smsOnly.canCall)
        assertTrue(smsOnly.canSms)
        val inactive = smsOnly.copy(present = false)
        assertFalse(inactive.canSms)
        assertEquals("此号码当前未启用", inactive.unavailableReason(forCall = false))
    }

    @Test fun `one Pixel call blocks its SIMs while another Pixel remains independent`() {
        val active = JSONObject().put("id", "call-a").put("gatewayId", "gateway-a").put("state", "active")
            .put("claimedByPlatform", "ios")
        assertEquals("call-a", gatewayBusyForSim(sim(gateway = "gateway-a"), listOf(active))?.getString("id"))
        assertNull(gatewayBusyForSim(sim(gateway = "gateway-b"), listOf(active)))
    }

    @Test fun `draft identity is isolated by account SIM and conversation`() {
        assertNotEquals(newSmsDraftKey("owner-a", "sim-a"), newSmsDraftKey("owner-a", "sim-b"))
        assertNotEquals(newSmsDraftKey("owner-a", "sim-a"), newSmsDraftKey("owner-b", "sim-a"))
        assertNotEquals(newSmsDraftKey("owner-a", "sim-a"), newSmsNumberDraftKey("owner-a", "sim-a"))
        assertNotEquals(newSmsNumberDraftKey("owner-a", "sim-a"), newSmsNumberDraftKey("owner-a", "sim-b"))
        assertNotEquals(
            replySmsDraftKey("owner-a", SmsConversationKey("sim-a", "+86138")),
            replySmsDraftKey("owner-a", SmsConversationKey("sim-a", "+86139")),
        )
    }

    @Test fun `refresh retains loaded account data while loading and on failure`() {
        val loaded = RemoteList.Loaded(listOf(JSONObject().put("id", "sms-1")))
        assertTrue(remoteListDuringRefresh(loaded) === loaded)
        assertTrue(remoteListDuringRefresh(RemoteList.NotLoaded) === RemoteList.Loading)
        assertTrue(remoteListAfterRefresh(loaded, RemoteList.Failed("offline")) === loaded)
        val replacement = RemoteList.Loaded(listOf(JSONObject().put("id", "sms-2")))
        assertTrue(remoteListAfterRefresh(loaded, replacement) === replacement)
        assertEquals(
            "部分数据刷新失败，请稍后重试（SIM、短信）",
            refreshFailureMessage(
                "SIM" to RemoteList.Failed("offline"),
                "通话" to replacement,
                "短信" to RemoteList.Failed("timeout"),
            ),
        )
        assertEquals("", refreshFailureMessage("短信" to replacement))
    }

    @Test fun `only token refresh preserves account-bound UI state`() {
        val alice = Session("access-a", "refresh-a", "alice")
        val current = ClientUiState(
            checkingSession = false,
            session = alice,
            sims = RemoteList.Loaded(listOf(JSONObject().put("id", "sim-a"))),
            calls = RemoteList.Loaded(listOf(JSONObject().put("id", "call-a"))),
            sms = RemoteList.Loaded(listOf(JSONObject().put("id", "sms-a"))),
            smsDrafts = mapOf("new:alice:sim-a" to "private draft"),
        )
        val refreshed = stateAfterSessionChange(
            current,
            Session("access-b", "refresh-b", "alice"),
            sameLoginGeneration = true,
        )
        assertTrue(refreshed.sims is RemoteList.Loaded)
        assertEquals(1, refreshed.smsDrafts.size)

        val sameAccountRelogin = stateAfterSessionChange(
            current,
            Session("access-new", "refresh-new", "alice"),
            sameLoginGeneration = false,
        )
        assertTrue(sameAccountRelogin.sims is RemoteList.NotLoaded)
        assertTrue(sameAccountRelogin.calls is RemoteList.NotLoaded)
        assertTrue(sameAccountRelogin.sms is RemoteList.NotLoaded)
        assertTrue(sameAccountRelogin.smsDrafts.isEmpty())

        val otherAccount = stateAfterSessionChange(
            current,
            Session("access-c", "refresh-c", "bob"),
            sameLoginGeneration = false,
        )
        assertTrue(otherAccount.sms is RemoteList.NotLoaded)
        assertTrue(otherAccount.smsDrafts.isEmpty())

        val loggedOut = stateAfterSessionChange(current, null, sameLoginGeneration = false)
        assertNull(loggedOut.session)
        assertTrue(loggedOut.sims is RemoteList.NotLoaded)
        assertTrue(loggedOut.smsDrafts.isEmpty())
    }

    @Test fun `singleton media blocks only a different local call`() {
        val media = CallMediaUiState(callId = "call-a", phase = CallMediaPhase.CONNECTED)
        assertTrue(localMediaBlocks(null, media))
        assertTrue(localMediaBlocks("call-b", media))
        assertFalse(localMediaBlocks("call-a", media))
    }

    @Test fun `primary call controls select only the current session owner`() {
        val calls = listOf(
            JSONObject().put("id", "other").put("state", "active").put("claimedByCurrentSession", false),
            JSONObject().put("id", "ring").put("state", "incoming_ringing"),
            JSONObject().put("id", "owned").put("state", "connecting").put("claimedByCurrentSession", true),
        )
        assertEquals("owned", primaryOwnedCall(calls, null)?.getString("id"))
        assertEquals("owned", primaryOwnedCall(calls, "owned")?.getString("id"))
        assertNull(primaryOwnedCall(calls.take(2), null))
        assertEquals("Alice 的 iPhone", callOwnerLabel(JSONObject().put("answeredByDevice", "Alice 的 iPhone").put("answeredByPlatform", "ios")))
        assertEquals("网页端", callOwnerLabel(JSONObject().put("originatingPlatform", "web")))
    }

    @Test fun `accepted hangup remains pending until the call reaches a terminal state`() {
        val pending = setOf("active", "gone")
        val active = RemoteList.Loaded(listOf(
            JSONObject().put("id", "active").put("state", "ending"),
            JSONObject().put("id", "done").put("state", "ended"),
        ))
        assertEquals(setOf("active"), endingCallIdsAfterRefresh(pending, active))
        assertEquals(pending, endingCallIdsAfterRefresh(pending, RemoteList.Failed("offline")))
    }

    private fun sms(sim: String, remote: String, canonical: String) = JSONObject()
        .put("id", "$sim-$remote").put("simId", sim).put("remoteNumber", remote)
        .put("conversationAddress", canonical).put("replyNumber", remote).put("canReply", true)
        .put("direction", "incoming").put("body", "hello").put("createdAt", "2026-09-09T00:00:00Z")

    private fun sim(gateway: String = "gateway-a", telephony: Boolean = true, sms: Boolean = true) = ClientSim(
        id = "sim-a", gatewayId = gateway, label = "主号码", phoneLabel = null, slotIndex = 0,
        countryIso = "CN", embedded = false, present = true, assignmentPending = false,
        online = true, telephonyReady = telephony, smsReady = sms, mediaReady = telephony,
    )
}
