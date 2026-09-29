package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test
import org.json.JSONObject

class ClientApiRoutesTest {
    @Test fun batchSmsUsesOneAtomicRequestWithOrderedPayloadAndSuppliedKey() {
        val requests = mutableListOf<ClientRequest>()
        val response = JSONObject("{\"batchId\":\"batch-1\",\"intervalSeconds\":5,\"items\":[]}")
        val api = ClientApi(transport = ClientTransport { requests.add(it); response })
        assertSame(response, api.sendSmsBatch("sim-a", listOf("10086", "10010"), "draft", "same-key"))
        val sent = requests.single()
        assertEquals("/sms/batch", sent.path)
        assertEquals("same-key", sent.idempotencyKey)
        assertEquals("sim-a", sent.body!!.getString("simId"))
        assertEquals("[\"10086\",\"10010\"]", sent.body.getJSONArray("recipients").toString())
        assertEquals("draft", sent.body.getString("body"))
    }

    @Test fun simIdCannotEscapePathSegment() {
        assertEquals("/sims/a%2Fb%20c/settings", ClientApiRoutes.simSettings("a/b c"))
        assertEquals("/sims/a%2Fb%20c", ClientApiRoutes.sim("a/b c"))
    }

    @Test fun callActionsKeepIdInOneSegment() {
        assertEquals("/calls/a%2Fb/claim", ClientApiRoutes.claimCall("a/b"))
        assertEquals("/calls/a%2Fb/end", ClientApiRoutes.endCall("a/b"))
    }

    /** S22 决策 10: an explicit calendar-day window plus the optional server-side search. */
    @Test fun reportRangeRouteCarriesFromToAndQuery() {
        val range = ReportDateRange(java.time.LocalDate.of(2026, 9, 6), java.time.LocalDate.of(2026, 9, 12))
        assertEquals(
            "/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12&limit=200",
            ClientApiRoutes.reports(range, "Asia/Shanghai"),
        )
        assertEquals(
            "/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12&limit=200&query=%E5%BC%A0%E4%B8%89",
            ClientApiRoutes.reports(range, "Asia/Shanghai", " 张三 "),
        )
    }

    /** A blank search keeps the plain list route, so clearing the box costs no extra parameters. */
    @Test fun callSearchRouteOnlyAppearsWhenThereIsSomethingToSearchFor() {
        assertEquals("/calls", ClientApiRoutes.calls())
        assertEquals("/calls", ClientApiRoutes.calls("   "))
        assertEquals("/calls?query=189%2F2&limit=100", ClientApiRoutes.calls("189/2"))
        assertEquals("/calls?query=189&limit=100", ClientApiRoutes.calls("189", limit = 5_000))
    }

    /**
     * S28: `page` 是分页的开关，所以分页路由永远带 `page`，永远不带 `limit`/游标（服务端把 `page`
     * 和游标的组合判成 400）。`simId` 和 `query` 只在非空时出现，参数顺序是固定的。
     */
    @Test fun pagedCallsRouteCarriesPageSizeSimAndQueryInAFixedOrder() {
        assertEquals("/calls?page=1&pageSize=50&includeBlocked=true", ClientApiRoutes.callsPage())
        assertEquals(
            "/calls?page=3&pageSize=100&includeBlocked=true&simId=a1b2&query=189%2F2",
            ClientApiRoutes.callsPage("189/2", "a1b2", 3, 100),
        )
        assertEquals(
            "/calls?page=2&pageSize=200&includeBlocked=true&query=%E5%BC%A0%E4%B8%89",
            ClientApiRoutes.callsPage(" 张三 ", "  ", 2, 200),
        )
        // 页码从 1 起，页长只能是服务端认的三个值。
        assertEquals("/calls?page=1&pageSize=50&includeBlocked=true", ClientApiRoutes.callsPage(page = 0, pageSize = 7))
        assertEquals("/calls?page=1&pageSize=200&includeBlocked=true", ClientApiRoutes.callsPage(page = -4, pageSize = 5_000))
    }

    @Test fun pagedReportRouteKeepsTheWindowAndAddsPageSizeAndSim() {
        val range = ReportDateRange(java.time.LocalDate.of(2026, 9, 6), java.time.LocalDate.of(2026, 9, 12))
        assertEquals(
            "/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12&page=1&pageSize=50",
            ClientApiRoutes.reportsPage(range, "Asia/Shanghai"),
        )
        assertEquals(
            "/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12&page=4&pageSize=200" +
                "&simId=sim-1&query=%E5%BC%A0%E4%B8%89",
            ClientApiRoutes.reportsPage(range, "Asia/Shanghai", " 张三 ", "sim-1", 4, 200),
        )
    }

    @Test fun pagedInterceptionsRouteReplacesTheLimit() {
        assertEquals("/blocklist/interceptions?page=1&pageSize=50", ClientApiRoutes.interceptionsPage())
        assertEquals("/blocklist/interceptions?page=6&pageSize=100", ClientApiRoutes.interceptionsPage(6, 100))
    }

    @Test fun reportAndTranscriptRoutesEncodeIanaZoneAndCallId() {
        assertEquals("/calls/a%2Fb/transcript", ClientApiRoutes.transcript("a/b"))
        assertEquals("/calls/a%2Fb/recordings?source=media_node", ClientApiRoutes.recordings("a/b", RecordingSource.MEDIA_NODE))
        assertEquals(
            "/calls/a%2Fb/recordings/remote_original?source=pixel",
            ClientApiRoutes.recordingTrack("a/b", OriginalTranscriptTrack.REMOTE_ORIGINAL, RecordingSource.PIXEL),
        )
        assertEquals(
            "/calls/a%2Fb/recordings/remote_original?source=pixel&disposition=attachment",
            ClientApiRoutes.recordingTrack("a/b", RecordingAudioTrack.REMOTE_ORIGINAL, RecordingSource.PIXEL, attachment = true),
        )
        assertEquals("/calls/a%2Fb", ClientApiRoutes.call("a/b"))
    }

    @Test fun derivedPlaybackRouteRequiresExplicitPixelSource() {
        assertEquals(
            "/calls/a%2Fb/recordings/caller_playout?source=pixel",
            ClientApiRoutes.recordingTrack("a/b", RecordingAudioTrack.CALLER_PLAYOUT, RecordingSource.PIXEL),
        )
        assertThrows(IllegalArgumentException::class.java) {
            ClientApiRoutes.recordingTrack("a/b", RecordingAudioTrack.CALLER_PLAYOUT, RecordingSource.MEDIA_NODE)
        }
    }

    @Test fun outboundSmsUsesTheCoordinatorSuppliedIdempotencyKey() {
        var captured: ClientRequest? = null
        val response = JSONObject().put("sms", JSONObject().put("id", "sms-1"))
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            response
        })

        assertSame(response, api.sendSms("sim-1", "+12025550123", "hello", "persisted-idem-key"))
        val sent = checkNotNull(captured)
        assertEquals("persisted-idem-key", sent.idempotencyKey)
        assertEquals("sim-1", sent.body!!.getString("simId"))
        assertEquals("+12025550123", sent.body.getString("remoteNumber"))
        assertEquals("hello", sent.body.getString("body"))
    }

    @Test fun outboundCallUsesTheCoordinatorSuppliedIdempotencyKey() {
        var captured: ClientRequest? = null
        val response = JSONObject().put("call", JSONObject().put("id", "call-1"))
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            response
        })

        assertSame(response, api.startCall("sim-1", "+12025550123", "persisted-call-key"))
        val sent = checkNotNull(captured)
        assertEquals("persisted-call-key", sent.idempotencyKey)
        assertEquals("sim-1", sent.body!!.getString("simId"))
        assertEquals("+12025550123", sent.body.getString("remoteNumber"))
    }

    /** S36 C2: 通话中拨号盘一次一位，路径与 `/end` 同形，体只有 `digits`。 */
    @Test fun inCallDtmfPostsOneDigitToTheCallsDtmfRoute() {
        assertEquals("/calls/a%2Fb/dtmf", ClientApiRoutes.dtmf("a/b"))
        var captured: ClientRequest? = null
        val response = JSONObject().put("ok", true).put("commandId", "cmd-1")
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            response
        })

        assertSame(response, api.sendDtmf("call-1", "5"))
        val sent = checkNotNull(captured)
        assertEquals("POST", sent.method)
        assertEquals("/calls/call-1/dtmf", sent.path)
        assertEquals("5", sent.body!!.getString("digits"))
        assertNull(sent.idempotencyKey)
    }

    /** S36 C4: 导出走服务端转码，`format=mp3` 只加在 attachment 请求上；播放 URL 一字不变。 */
    @Test fun mp3ExportRouteAddsFormatOnlyToTheAttachmentRequest() {
        assertEquals(
            "/calls/call-1/recordings/remote_original?source=media_node",
            ClientApiRoutes.recordingTrack("call-1", RecordingAudioTrack.REMOTE_ORIGINAL, RecordingSource.MEDIA_NODE),
        )
        assertEquals(
            "/calls/call-1/recordings/remote_original?source=media_node&disposition=attachment&format=mp3",
            ClientApiRoutes.recordingTrack(
                "call-1", RecordingAudioTrack.REMOTE_ORIGINAL, RecordingSource.MEDIA_NODE,
                attachment = true, format = "mp3",
            ),
        )
        assertThrows(IllegalArgumentException::class.java) {
            ClientApiRoutes.recordingTrack(
                "call-1", RecordingAudioTrack.REMOTE_ORIGINAL, RecordingSource.MEDIA_NODE, format = "aac",
            )
        }
        assertEquals(
            "call-call-1-media_node-remote_original.mp3",
            recordingAttachmentFileName("call-1", RecordingSource.MEDIA_NODE, RecordingAudioTrack.REMOTE_ORIGINAL, "audio/mpeg"),
        )
    }

    /** S36 C4: `conversation` 是服务器混好的虚拟轨——只有带 format=mp3 的 attachment 一条路。 */
    @Test fun conversationMixExportsAsOneAttachmentMp3() {
        assertEquals(
            "/calls/call-1/recordings/conversation?source=media_node&disposition=attachment&format=mp3",
            ClientApiRoutes.recordingTrack(
                "call-1", RecordingAudioTrack.CONVERSATION, RecordingSource.MEDIA_NODE,
                attachment = true, format = "mp3",
            ),
        )
        assertThrows(IllegalArgumentException::class.java) {
            ClientApiRoutes.recordingTrack("call-1", RecordingAudioTrack.CONVERSATION, RecordingSource.MEDIA_NODE)
        }
        assertEquals(
            "call-call-1-media_node-conversation.mp3",
            recordingAttachmentFileName("call-1", RecordingSource.MEDIA_NODE, RecordingAudioTrack.CONVERSATION, "audio/mpeg"),
        )
    }

    @Test fun simNotesPutUsesSimIdentityAndExpectedVersion() {
        var captured: ClientRequest? = null
        val response = JSONObject().put("sim", JSONObject().put("id", "sim-1"))
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            response
        })

        assertSame(response, api.setSimNotes("sim-1", 4, "家庭卡", "备卡"))
        val sent = checkNotNull(captured)
        assertEquals("PUT", sent.method)
        assertEquals("/sims/sim-1", sent.path)
        assertEquals(4L, sent.body!!.getLong("expectedVersion"))
        assertEquals("家庭卡", sent.body.getString("label"))
        assertEquals("备卡", sent.body.getString("phoneLabel"))
    }
}
