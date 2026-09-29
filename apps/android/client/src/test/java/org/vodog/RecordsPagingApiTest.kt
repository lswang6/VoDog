package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * S28 记录分页的读法与落地。分页请求只准写自己的那份 state —— 拨号页轮询的 [ClientUiState.calls]
 * 喂运行时对账和占用释放，被第 3 页的 50 条覆盖会让「谁在通话中」整个错位。
 */
class RecordsPagingApiTest {
    private val range = ReportDateRange(LocalDate.of(2026, 9, 6), LocalDate.of(2026, 9, 12))

    private fun callRow(id: String) = JSONObject().put("id", id).put("simId", "sim-1")

    @Test fun callsPageReadsTheEnvelopeAndAsksForExactlyOnePagedRequest() {
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            JSONObject()
                .put("items", JSONArray().put(callRow("call-1")).put(callRow("call-2")))
                .put("page", 3)
                .put("pageSize", 100)
                .put("total", 640)
                .put("totalPages", 7)
        })

        val page = api.callsPage(query = " 张三 ", simId = "sim-1", page = 3, pageSize = 100)

        assertEquals(1, requests.size)
        assertEquals("GET", requests.single().method)
        assertEquals(
            "/calls?page=3&pageSize=100&includeBlocked=true&simId=sim-1&query=%E5%BC%A0%E4%B8%89",
            requests.single().path,
        )
        assertEquals(listOf("call-1", "call-2"), page.items.map { it.getString("id") })
        assertEquals(3, page.page)
        assertEquals(100, page.pageSize)
        assertEquals(640, page.total)
        assertEquals(7, page.totalPages)
        assertTrue(page.supported)
    }

    /** 旧 Control 忽略 `page`，回老的 `{items}`：整份结果当一页，分页条不出现。 */
    @Test fun aControlWithoutPagingAnswersOneUnsupportedPage() {
        val api = ClientApi(transport = ClientTransport {
            JSONObject().put("items", JSONArray().put(callRow("call-1")))
        })

        val page = api.callsPage(page = 4, pageSize = 200)

        assertEquals(1, page.page)
        assertEquals(200, page.pageSize)
        assertEquals(1, page.total)
        assertEquals(1, page.totalPages)
        assertFalse(page.supported)
        assertFalse(RecordsPagingPolicy.pagerVisible(page))
    }

    @Test fun interceptionsPageReadsTheSameEnvelope() {
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            JSONObject()
                .put("items", JSONArray().put(JSONObject().put("id", "int-1")))
                .put("page", 2)
                .put("pageSize", 50)
                .put("total", 51)
                .put("totalPages", 2)
        })

        val page = api.interceptionsPage(page = 2, pageSize = 50)

        assertEquals("/blocklist/interceptions?page=2&pageSize=50", requests.single().path)
        assertEquals(2, page.page)
        assertEquals(2, page.totalPages)
        assertTrue(RecordsPagingPolicy.pagerVisible(page))
    }

    /** 报告的信封是叠加的：`window` 和 `items` 都还在，一个解码器同时服务两条路由。 */
    @Test fun reportsPageKeepsTheWindowBesideTheEnvelope() {
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            JSONObject()
                .put(
                    "window",
                    JSONObject()
                        .put("timeZone", "Asia/Shanghai")
                        .put("fromInclusive", "2026-09-06T00:00:00.000Z")
                        .put("toExclusive", "2026-09-13T00:00:00.000Z"),
                )
                .put("page", 2)
                .put("pageSize", 200)
                .put("total", 300)
                .put("totalPages", 2)
                .put(
                    "items",
                    JSONArray().put(
                        JSONObject()
                            .put("callId", "call-1")
                            .put("startedAt", "2026-09-12T01:00:00.000Z")
                            .put("direction", "incoming")
                            .put("remoteNumber", "+8613800000000")
                            .put("sim", JSONObject().put("id", "sim-1").put("label", "北京号").put("slotIndex", 0)),
                    ),
                )
        })

        val report = api.reportsPage(range, "Asia/Shanghai", query = "", simId = "sim-1", page = 2, pageSize = 200)

        assertEquals(
            "/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12&page=2&pageSize=200&simId=sim-1",
            requests.single().path,
        )
        assertEquals("Asia/Shanghai", report.window.timeZone)
        assertEquals(listOf("call-1"), report.items.map { it.callId })
        assertEquals(2, report.paging.page)
        assertEquals(300, report.paging.total)
        assertTrue(report.paging.supported)
    }

    /** 不带 `page` 的老读法一个字都没变，信封缺席就退回 [Page.unpaged]。 */
    @Test fun theLegacyReportRouteStillDecodesAsASinglePage() {
        val api = ClientApi(transport = ClientTransport {
            JSONObject()
                .put(
                    "window",
                    JSONObject()
                        .put("period", "7d")
                        .put("timeZone", "Asia/Shanghai")
                        .put("fromInclusive", "2026-09-06T00:00:00.000Z")
                        .put("toExclusive", "2026-09-13T00:00:00.000Z"),
                )
                .put("items", JSONArray())
        })

        val report = api.reports(range, "Asia/Shanghai")

        assertFalse(report.paging.supported)
        assertEquals(1, report.paging.totalPages)
        assertTrue(report.items.isEmpty())
    }

    @Test fun landingAPagedResultNeverTouchesThePolledCallList() {
        val polled = RemoteList.Loaded(listOf(callRow("polled-1")))
        val before = ClientUiState(calls = polled, callsPageNum = 3, callsPageSize = 50, callsPageRefreshing = true)
        val loaded = RemoteResource.Loaded(Page(listOf(callRow("paged-1")), page = 3, pageSize = 50, total = 130, totalPages = 3))

        val after = clientStateWithCallsPage(before, loaded)

        assertSame(polled, after.calls)
        assertEquals(listOf("paged-1"), (after.callsPage as RemoteResource.Loaded).value.items.map { it.getString("id") })
        assertEquals(3, after.callsPageNum)
        // 除了 callsPage / callsPageNum / 转圈位之外一个字段都没动。
        assertEquals(
            before.copy(callsPage = after.callsPage, callsPageNum = after.callsPageNum, callsPageRefreshing = false),
            after,
        )
    }

    /** 失败时旧的一页留在屏幕上，但下拉刷新的转圈必须停 —— 否则它会一直转下去。 */
    @Test fun aFailedPageKeepsTheRowsThatAreAlreadyOnScreenAndStopsTheSpinner() {
        val loaded = RemoteResource.Loaded(Page(listOf(callRow("paged-1")), page = 2, pageSize = 50, total = 130, totalPages = 3))
        val before = ClientUiState(callsPage = loaded, callsPageNum = 2, callsPageRefreshing = true)

        val after = clientStateWithCallsPage(before, RemoteResource.Failed("网络不给力"))

        assertSame(loaded, after.callsPage)
        assertEquals(2, after.callsPageNum)
        assertFalse(after.callsPageRefreshing)
    }

    /** 服务端回来的页码为准：越界时夹回最后一页，并且 [RecordsPagingPolicy.rewindPage] 会要求重读。 */
    @Test fun aPagePastTheEndIsClampedAndAsksForTheLastPage() {
        val past = Page(emptyList<JSONObject>(), page = 3, pageSize = 50, total = 60, totalPages = 2)
        val after = clientStateWithCallsPage(ClientUiState(callsPageNum = 3), RemoteResource.Loaded(past))

        assertEquals(2, after.callsPageNum)
        assertEquals(2, RecordsPagingPolicy.rewindPage(past))
    }

    @Test fun interceptionsAndReportsLandOnTheirOwnFieldsOnly() {
        val interceptions = RemoteResource.Loaded(Page(listOf(callRow("int-1")), page = 2, pageSize = 100, total = 150, totalPages = 2))
        val afterInterceptions = clientStateWithInterceptionsPage(ClientUiState(interceptionsPageNum = 9), interceptions)
        assertEquals(2, afterInterceptions.interceptionsPageNum)
        assertEquals(
            ClientUiState(interceptionsPageNum = 2, interceptionsPage = interceptions),
            afterInterceptions,
        )

        val window = ReportWindow(null, "Asia/Shanghai", "2026-09-06T00:00:00.000Z", "2026-09-13T00:00:00.000Z")
        val reports = RemoteResource.Loaded(
            CallReportPage(window, Page(emptyList(), page = 4, pageSize = 50, total = 400, totalPages = 8)),
        )
        val afterReports = clientStateWithReportsPage(ClientUiState(reportsPageNum = 1), reports)
        assertEquals(4, afterReports.reportsPageNum)
        assertEquals(ClientUiState(reportsPageNum = 4, reports = reports), afterReports)
    }
}
