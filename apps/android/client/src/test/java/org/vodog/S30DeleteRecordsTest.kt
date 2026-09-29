package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S30 删除：通话记录单条删除、短信选择删除、对话删除与「删除并屏蔽」。
 *
 * 这一份刻意是新文件：S28 钉死 [clientStateWithCallsPage] 不写 [ClientUiState.calls] 的那条测试
 * （`RecordsPagingApiTest.landingAPagedResultNeverTouchesThePolledCallList`）一个字都不许改，删除走
 * 的是另一条路 [clientStateWithoutCall]，两条路的约束在下面 `deletionWritesCallsWhilePagingStillDoesNot`
 * 里正面对照了一次。
 */
class S30DeleteRecordsTest {
    private fun callRow(id: String) = JSONObject().put("id", id).put("simId", "sim-1")

    private fun reportItem(callId: String) = CallReportItem(
        callId = callId,
        startedAt = "2026-09-12T02:00:00Z",
        direction = "incoming",
        remoteNumber = "+8619900000102",
        sim = ReportSim("sim-1", "SIM", 0),
        summary = null,
        actionItems = emptyList(),
        advertisingClassification = "unknown",
        recordingStatus = "ready",
        callUrl = "",
        transcriptUrl = "",
        recordingUrl = "",
        transcriptCompletedAt = "",
    )

    private val reportWindow =
        ReportWindow(null, "Asia/Shanghai", "2026-09-06T00:00:00.000Z", "2026-09-13T00:00:00.000Z")

    private fun smsRow(
        id: String,
        simId: String = "sim-1",
        remoteNumber: String = "+8613800000000",
        conversationAddress: String = remoteNumber,
        state: String = "delivered",
    ) = JSONObject()
        .put("id", id)
        .put("simId", simId)
        .put("direction", "incoming")
        .put("remoteNumber", remoteNumber)
        .put("conversationAddress", conversationAddress)
        .put("replyNumber", remoteNumber)
        .put("canReply", true)
        .put("body", "hi")
        .put("state", state)
        .put("receivedAt", "2026-09-13T01:00:00Z")

    private fun conversation(vararg rows: JSONObject): SmsConversation =
        smsConversations(rows.toList(), rows.first().getString("simId")).single()

    // ---- §4.1 三个新接口的方法 / 路由 / 空体 -------------------------------------------------

    @Test fun deletingACallIsADeleteThatToleratesTheEmpty204Body() {
        var captured: ClientRequest? = null
        // 204 No Content: the transport hands the caller an empty JSONObject, exactly as it does for
        // deleteContact/unblock. Reading anything off it would turn a success into a JSONException.
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            JSONObject()
        })

        api.deleteCall("call-1")

        val sent = checkNotNull(captured)
        assertEquals("DELETE", sent.method)
        assertEquals("/calls/call-1", sent.path)
        assertNull(sent.body)
        // 合同明说不用幂等键：DELETE 天然幂等，重复一次是 404。
        assertNull(sent.idempotencyKey)
    }

    @Test fun aCallIdStaysInsideOnePathSegment() {
        assertEquals("/calls/a%2Fb%20c", ClientApiRoutes.call("a/b c"))
        assertEquals("/sms/delete", ClientApiRoutes.SMS_DELETE)
        assertEquals("/sms/threads/delete", ClientApiRoutes.SMS_THREADS_DELETE)
    }

    @Test fun deletingSmsPostsTheIdsAndMergesTheServerReceipt() {
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            JSONObject().put("deleted", 2).put(
                "skipped",
                JSONArray().put(JSONObject().put("id", "sms-3").put("reason", "in_flight")),
            )
        })

        val response = api.deleteSms(listOf(" sms-1 ", "sms-2", "sms-3", "", "sms-1"))

        assertEquals(1, requests.size)
        assertEquals("POST", requests.single().method)
        assertEquals("/sms/delete", requests.single().path)
        assertNull(requests.single().idempotencyKey)
        // 去重、去空白、去空串之后才上路。
        val ids = requests.single().body!!.getJSONArray("ids")
        assertEquals(listOf("sms-1", "sms-2", "sms-3"), (0 until ids.length()).map { ids.getString(it) })
        assertEquals(2, response.getInt("deleted"))
        assertEquals(1, response.getJSONArray("skipped").length())
    }

    /** 服务端一次最多 500 个 id（§1.2），所以「全选」一段超长对话要切批，回执再合并。 */
    @Test fun deletingMoreThanOneBatchOfSmsSplitsAndSumsTheReceipts() {
        val batches = mutableListOf<Int>()
        val api = ClientApi(transport = ClientTransport { request ->
            batches += request.body!!.getJSONArray("ids").length()
            JSONObject().put("deleted", request.body.getJSONArray("ids").length())
        })

        val response = api.deleteSms((1..1_250).map { "sms-$it" })

        assertEquals(listOf(500, 500, 250), batches)
        assertEquals(1_250, response.getInt("deleted"))
        assertEquals(0, response.getJSONArray("skipped").length())
    }

    @Test fun anEmptySelectionNeverReachesTheNetwork() {
        val api = ClientApi(transport = ClientTransport { throw AssertionError("不该发请求") })
        assertThrows(IllegalArgumentException::class.java) { api.deleteSms(listOf("", "   ")) }
        assertThrows(IllegalArgumentException::class.java) { api.deleteSmsThread("", "+8613800000000") }
        assertThrows(IllegalArgumentException::class.java) { api.deleteSmsThread("sim-1", " ") }
    }

    @Test fun deletingAThreadPostsTheSimAndTheConversationAddress() {
        var captured: ClientRequest? = null
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            JSONObject().put("deleted", 4).put("skipped", JSONArray())
        })

        val response = api.deleteSmsThread("sim-1", "13800000000")

        val sent = checkNotNull(captured)
        assertEquals("POST", sent.method)
        assertEquals("/sms/threads/delete", sent.path)
        assertEquals("sim-1", sent.body!!.getString("simId"))
        // 归一化是服务端两边都做的事，客户端照发手上的写法（`13800000000` 与 `+8613800000000` 同线程）。
        assertEquals("13800000000", sent.body.getString("conversationAddress"))
        assertNull(sent.idempotencyKey)
        assertEquals(4, response.getInt("deleted"))
    }

    /** 「删除并屏蔽」的第一步：新建 201 与已存在 200 都回 `{item}`，两者都算成功。 */
    @Test fun blockingBeforeAThreadDeleteAcceptsBothANewAndAnExistingEntry() {
        var sent: ClientRequest? = null
        val api = ClientApi(transport = ClientTransport {
            sent = it
            JSONObject().put("item", JSONObject().put("id", "b-1").put("remoteNumber", "+8613800000000"))
        })
        assertEquals("b-1", api.block("+8613800000000", null, ClientApiRoutes.BLOCK_SCOPE_SMS).getString("id"))
        // S66: 删除并屏蔽 only joins the SMS list.
        assertEquals("sms", checkNotNull(sent).body!!.getString("scope"))
    }

    // ---- §4.3 clientStateWithoutCall ----------------------------------------------------------

    @Test fun deletingACallRemovesItFromThePolledListThePageAndTheReport() {
        val before = ClientUiState(
            calls = RemoteList.Loaded(listOf(callRow("call-1"), callRow("call-2"))),
            callsPage = RemoteResource.Loaded(
                Page(listOf(callRow("call-1"), callRow("call-2")), page = 1, pageSize = 50, total = 2, totalPages = 1),
            ),
            reports = RemoteResource.Loaded(
                CallReportPage(
                    reportWindow,
                    Page(listOf(reportItem("call-1"), reportItem("call-2")), page = 1, pageSize = 50, total = 2, totalPages = 1),
                ),
            ),
        )

        val after = clientStateWithoutCall(before, "call-1")

        assertEquals(listOf("call-2"), (after.calls as RemoteList.Loaded).items.map { it.getString("id") })
        val page = (after.callsPage as RemoteResource.Loaded).value
        assertEquals(listOf("call-2"), page.items.map { it.getString("id") })
        assertEquals(1, page.total)
        assertEquals(1, page.totalPages)
        val report = (after.reports as RemoteResource.Loaded).value
        assertEquals(listOf("call-2"), report.items.map(CallReportItem::callId))
        assertEquals(1, report.paging.total)
    }

    /** 这一条与 S28 的钉死测试是正面对照：分页落地不写 `calls`，删除必须写。 */
    @Test fun deletionWritesCallsWhilePagingStillDoesNot() {
        val polled = RemoteList.Loaded(listOf(callRow("call-1"), callRow("call-2")))
        val before = ClientUiState(calls = polled)

        val paged = clientStateWithCallsPage(
            before,
            RemoteResource.Loaded(Page(listOf(callRow("paged-1")), page = 1, pageSize = 50, total = 1, totalPages = 1)),
        )
        assertSame(polled, paged.calls)

        val deleted = clientStateWithoutCall(before, "call-1")
        assertEquals(listOf("call-2"), (deleted.calls as RemoteList.Loaded).items.map { it.getString("id") })
    }

    @Test fun totalPagesAreRecomputedFromTheNewTotal() {
        assertEquals(1, RecordsPagingPolicy.totalPagesFor(0, 50))
        assertEquals(1, RecordsPagingPolicy.totalPagesFor(50, 50))
        assertEquals(2, RecordsPagingPolicy.totalPagesFor(51, 50))
        assertEquals(3, RecordsPagingPolicy.totalPagesFor(101, 50))
        assertEquals(1, RecordsPagingPolicy.totalPagesFor(200, 200))

        val before = ClientUiState(
            callsPage = RemoteResource.Loaded(
                Page(List(50) { callRow("call-$it") }, page = 1, pageSize = 50, total = 101, totalPages = 3),
            ),
            callsPageNum = 1,
        )

        val page = (clientStateWithoutCall(before, "call-0").callsPage as RemoteResource.Loaded).value

        assertEquals(100, page.total)
        assertEquals(2, page.totalPages)
        assertEquals(1, page.page)
    }

    /** 删掉最后一页上的唯一一行：就地退回上一页，否则紧接着的重读会去请求一页空结果。 */
    @Test fun deletingTheOnlyRowOfTheLastPageRewindsOnePage() {
        val before = ClientUiState(
            callsPage = RemoteResource.Loaded(
                Page(listOf(callRow("call-101")), page = 3, pageSize = 50, total = 101, totalPages = 3),
            ),
            callsPageNum = 3,
        )

        val after = clientStateWithoutCall(before, "call-101")
        val page = (after.callsPage as RemoteResource.Loaded).value

        assertTrue(page.items.isEmpty())
        assertEquals(100, page.total)
        assertEquals(2, page.totalPages)
        assertEquals(2, page.page)
        // 页码也要落到 state 上，否则默认参数的 loadCallsPage() 还会去读第 3 页。
        assertEquals(2, after.callsPageNum)
    }

    /** 第 1 页删空不退页（没有第 0 页），旧 Control 的 `supported=false` 信封也不去算页数。 */
    @Test fun theFirstPageAndAnUnpagedControlNeverRewind() {
        val first = ClientUiState(
            callsPage = RemoteResource.Loaded(Page(listOf(callRow("call-1")), page = 1, pageSize = 50, total = 1, totalPages = 1)),
        )
        val afterFirst = (clientStateWithoutCall(first, "call-1").callsPage as RemoteResource.Loaded).value
        assertEquals(1, afterFirst.page)
        assertEquals(0, afterFirst.total)
        assertEquals(1, afterFirst.totalPages)

        val legacy = ClientUiState(
            callsPage = RemoteResource.Loaded(Page.unpaged(listOf(callRow("call-1"), callRow("call-2")))),
        )
        val afterLegacy = (clientStateWithoutCall(legacy, "call-1").callsPage as RemoteResource.Loaded).value
        assertFalse(afterLegacy.supported)
        assertEquals(1, afterLegacy.total)
        assertEquals(1, afterLegacy.totalPages)
        assertEquals(1, afterLegacy.page)
    }

    @Test fun deletingACallThatIsNotOnScreenChangesNothing() {
        val before = ClientUiState(
            calls = RemoteList.Loaded(listOf(callRow("call-2"))),
            callsPage = RemoteResource.Loaded(
                Page(listOf(callRow("call-2")), page = 2, pageSize = 50, total = 60, totalPages = 2),
            ),
            callsPageNum = 2,
        )

        val after = clientStateWithoutCall(before, "call-1")

        assertEquals(60, (after.callsPage as RemoteResource.Loaded).value.total)
        assertEquals(2, after.callsPageNum)
        assertEquals(before.copy(calls = after.calls, callsPage = after.callsPage), after)
        // 空 id 是 no-op，连一份新对象都不该造出来。
        assertSame(before, clientStateWithoutCall(before, ""))
    }

    /** 打开着的转录 / 录音页说的就是这一通：删掉之后它已经没有内容可读了。 */
    @Test fun deletingTheCallBehindTheOpenViewerClosesIt() {
        val open = CallDetailUiState(reportItem("call-1"), HistoryViewerKind.TRANSCRIPT)
        val before = ClientUiState(callDetail = open)

        assertNull(clientStateWithoutCall(before, "call-1").callDetail)
        assertSame(open, clientStateWithoutCall(before, "call-9").callDetail)
    }

    /** 没读过的列表保持 NotLoaded：删除不该把一条请求都没发过的页面变成「空」。 */
    @Test fun listsThatWereNeverLoadedStayNotLoaded() {
        val after = clientStateWithoutCall(ClientUiState(), "call-1")
        assertSame(RemoteList.NotLoaded, after.calls)
        assertSame(RemoteResource.NotLoaded, after.callsPage)
        assertSame(RemoteResource.NotLoaded, after.reports)
    }

    // ---- §4.6 选择模式 -------------------------------------------------------------------------

    @Test fun theSelectionPolicyTogglesSelectsAllAndClears() {
        val ids = listOf("sms-1", "sms-2", "sms-3")
        var selected = SmsSelectionPolicy.clear()
        assertFalse(SmsSelectionPolicy.canDelete(selected))
        assertEquals("已选 0 条", SmsSelectionPolicy.title(selected))

        selected = SmsSelectionPolicy.toggle(selected, "sms-2")
        assertEquals(setOf("sms-2"), selected)
        assertTrue(SmsSelectionPolicy.canDelete(selected))
        assertEquals("已选 1 条", SmsSelectionPolicy.title(selected))

        // 再点一次就是取消选中。
        assertEquals(emptySet<String>(), SmsSelectionPolicy.toggle(selected, "sms-2"))
        // 空 id 进不来（本地占位的气泡没有服务端 id，删了服务端也不认）。
        assertSame(selected, SmsSelectionPolicy.toggle(selected, ""))

        selected = SmsSelectionPolicy.selectAll(ids + "")
        assertEquals(ids.toSet(), selected)
        assertTrue(SmsSelectionPolicy.allSelected(selected, ids))
        assertEquals("已选 3 条", SmsSelectionPolicy.title(selected))

        assertFalse(SmsSelectionPolicy.allSelected(SmsSelectionPolicy.toggle(selected, "sms-1"), ids))
        assertFalse(SmsSelectionPolicy.allSelected(emptySet(), emptyList()))
        // 刷新之后被删掉的 id 不能继续留在选中集合里。
        assertEquals(setOf("sms-1"), SmsSelectionPolicy.retain(selected, listOf("sms-1")))
    }

    @Test fun deletingSelectionStopsAtTheServerBatchLimitWithAnExplanation() {
        val fiveHundred = (1..500).map { "sms-$it" }.toSet()
        assertTrue(SmsSelectionPolicy.canDelete(fiveHundred))
        val tooMany = fiveHundred + "sms-501"
        assertFalse(SmsSelectionPolicy.canDelete(tooMany))
        assertEquals("一次最多删除 500 条短信，请减少选择", SmsSelectionPolicy.deleteLimitMessage(tooMany))
    }

    @Test fun partialDeleteRemovesOnlyAcceptedIdsAndKeepsEverySkippedRow() {
        val requested = setOf("sms-1", "sms-2", "sms-3")
        val response = JSONObject().put(
            "skipped",
            JSONArray()
                .put(JSONObject().put("id", "sms-2").put("reason", "in_flight"))
                .put(JSONObject().put("id", "sms-3").put("reason", "not_found")),
        )
        assertEquals(setOf("sms-1"), smsAcceptedDeletedIds(requested, response))
        assertEquals(
            listOf("sms-2", "sms-3"),
            smsRowsWithoutIds(requested.map(::smsRow), smsAcceptedDeletedIds(requested, response))
                .map { it.getString("id") },
        )
        assertEquals(
            listOf("sms-2", "sms-3"),
            smsRowsAfterThreadDelete(requested.map(::smsRow), "sim-1", "+8613800000000", response)
                .map { it.getString("id") },
        )
    }

    // ---- §4.6 确认文案 ------------------------------------------------------------------------

    @Test fun theConfirmCopyIsTheSameSentenceAsTheOtherTwoClients() {
        val call = callDeleteConfirm()
        assertEquals("删除这条通话记录？", call.title)
        assertEquals("录音、转写、报告条目和手机上的通话记录会一起删除，无法恢复。", call.message)
        assertEquals("删除", call.confirmLabel)

        val thread = smsThreadDeleteConfirm(block = false)
        assertEquals("删除这段对话？", thread.title)
        assertEquals("删除", thread.confirmLabel)
        assertTrue(thread.message.contains("正在发送中"))

        val blocking = smsThreadDeleteConfirm(block = true)
        assertEquals("删除并屏蔽此号码？", blocking.title)
        assertEquals("删除并屏蔽", blocking.confirmLabel)
        assertTrue(blocking.message.contains("不再接收该号码的短信"))
        assertFalse(blocking.message.contains("拒接"))

        assertEquals("删除选中的 3 条短信？", smsMessagesDeleteConfirm(3).title)
        assertEquals("删除", smsMessagesDeleteConfirm(3).confirmLabel)
    }

    // ---- §4.4 线程删除发什么、删完本地留什么 ---------------------------------------------------

    @Test fun theThreadDeleteSendsTheConversationAddressAndBlocksTheRawNumber() {
        val plain = conversation(smsRow("sms-1", remoteNumber = "13800000000", conversationAddress = "+8613800000000"))
        assertEquals("+8613800000000", smsThreadDeleteAddress(plain))
        assertEquals("13800000000", smsThreadBlockNumber(plain))
        assertTrue(canBlockSmsThread(plain))

        // 服务端没给 conversationAddress 时客户端自己造了个占位，那种写法服务端一行都匹配不上，
        // 所以退回原始号码 —— 正是合同里的 `conversationAddress ?? remoteNumber`。
        val unresolved = conversation(
            JSONObject(plain.latest.raw.toString()).put("conversationAddress", JSONObject.NULL),
        )
        assertTrue(smsAddressPlaceholder(unresolved.key.address))
        assertEquals("13800000000", smsThreadDeleteAddress(unresolved))

        val emergency = conversation(smsRow("sms-9", remoteNumber = "112", conversationAddress = "112"))
        assertFalse(canBlockSmsThread(emergency))
    }

    @Test fun localFilteringDropsExactlyTheDeletedRows() {
        val rows = listOf(
            smsRow("sms-1"),
            smsRow("sms-2"),
            smsRow("sms-3", remoteNumber = "+8613900000000", conversationAddress = "+8613900000000"),
            smsRow("sms-4", simId = "sim-2"),
        )

        assertEquals(
            listOf("sms-2", "sms-3", "sms-4"),
            smsRowsWithoutIds(rows, setOf("sms-1")).map { it.getString("id") },
        )
        assertSame(rows, smsRowsWithoutIds(rows, emptySet()))

        // 同一段对话整段消失，别的号码和另一张 SIM 的同号码都留着。
        assertEquals(
            listOf("sms-3", "sms-4"),
            smsRowsWithoutThread(rows, "sim-1", "+8613800000000").map { it.getString("id") },
        )
    }

    /** 成功静默（Web / iOS 也静默）；只有「还在发、没删成」才出声。 */
    @Test fun onlyTheInFlightSkipsAreWorthASentence() {
        assertEquals("", smsDeleteSkippedMessage(JSONObject().put("deleted", 4)))
        assertEquals("", smsDeleteSkippedMessage(JSONObject()))
        assertEquals(
            "1 条短信正在发送中，暂时不能删除",
            smsDeleteSkippedMessage(
                JSONObject().put("deleted", 4)
                    .put("skipped", JSONArray().put(JSONObject().put("id", "sms-9").put("reason", "in_flight"))),
            ),
        )
        assertEquals(
            "2 条短信正在发送中，暂时不能删除",
            smsDeleteSkippedMessage(
                JSONObject().put("deleted", 0).put(
                    "skipped",
                    JSONArray()
                        .put(JSONObject().put("id", "sms-9").put("reason", "in_flight"))
                        .put(JSONObject().put("id", "sms-8").put("reason", "in_flight")),
                ),
            ),
        )
        // `not_found` 是别处已经删掉了，对用户来说和删掉没区别，不该被说成「正在发送中」。
        assertEquals(
            "",
            smsDeleteSkippedMessage(
                JSONObject().put("deleted", 1)
                    .put("skipped", JSONArray().put(JSONObject().put("id", "sms-8").put("reason", "not_found"))),
            ),
        )
    }

    // ---- §4.3 409 -----------------------------------------------------------------------------

    @Test fun aCallStillInUseGetsItsOwnChineseSentence() {
        val api = ClientApi(transport = ClientTransport {
            throw ApiError(409, "CALL_IN_USE", "call is still in use")
        })
        val error = assertThrows(ApiError::class.java) { api.deleteCall("call-1") }
        assertEquals(409, error.status)
        assertEquals("通话仍在进行或处理中，稍后再删", error.userMessage())
        // 404（已经被别处删掉 / 不是本人的）仍旧读服务端自己的话。
        assertEquals("not found", ApiError(404, "NOT_FOUND", "not found").userMessage())
    }
}
