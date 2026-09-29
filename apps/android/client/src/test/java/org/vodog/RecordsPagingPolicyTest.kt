package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** S28 记录分页的纯规则。UI 和 ViewModel 只是把这些结论接上去，所以判断都定在这里。 */
class RecordsPagingPolicyTest {
    /** 服务端的 `pageSize` 是闭集，集合外的值是 400；客户端往下取最近的档位，永远送得出去。 */
    @Test fun pageSizeIsAlwaysOneOfTheThreeTheServerAccepts() {
        assertEquals(listOf(50, 100, 200), RecordsPagingPolicy.PAGE_SIZES)
        assertEquals(50, RecordsPagingPolicy.DEFAULT_PAGE_SIZE)
        assertEquals(50, RecordsPagingPolicy.clampPageSize(0))
        assertEquals(50, RecordsPagingPolicy.clampPageSize(-20))
        assertEquals(50, RecordsPagingPolicy.clampPageSize(49))
        assertEquals(50, RecordsPagingPolicy.clampPageSize(50))
        assertEquals(50, RecordsPagingPolicy.clampPageSize(99))
        assertEquals(100, RecordsPagingPolicy.clampPageSize(100))
        assertEquals(100, RecordsPagingPolicy.clampPageSize(199))
        assertEquals(200, RecordsPagingPolicy.clampPageSize(200))
        assertEquals(200, RecordsPagingPolicy.clampPageSize(5_000))
        RecordsPagingPolicy.PAGE_SIZES.forEach {
            assertEquals(it, RecordsPagingPolicy.clampPageSize(it))
        }
    }

    @Test fun pageNumberStartsAtOneAndStopsAtTheLastPage() {
        assertEquals(1, RecordsPagingPolicy.clampPage(0, 7))
        assertEquals(1, RecordsPagingPolicy.clampPage(-3, 7))
        assertEquals(7, RecordsPagingPolicy.clampPage(9, 7))
        assertEquals(4, RecordsPagingPolicy.clampPage(4, 7))
        // 空列表仍然是第 1 页，而不是第 0 页。
        assertEquals(1, RecordsPagingPolicy.clampPage(3, 0))
    }

    /** 搜索词 / 日期窗口 / SIM 变了就必须回第 1 页；只翻页不算换内容。 */
    @Test fun onlyAContentChangeResetsToPageOne() {
        assertFalse(RecordsPagingPolicy.resetsPage("2026-09-06|2026-09-12||Asia/Shanghai|sim-1", "2026-09-06|2026-09-12||Asia/Shanghai|sim-1"))
        assertTrue(RecordsPagingPolicy.resetsPage("|sim-1", "|sim-2"))
        assertTrue(RecordsPagingPolicy.resetsPage("张三|sim-1", "|sim-1"))
    }

    @Test fun pagerHidesItselfOnlyForAShortSinglePageAtTheDefaultSize() {
        assertFalse(RecordsPagingPolicy.pagerVisible(Page(emptyList<String>(), 1, 50, 0, 1)))
        assertFalse(RecordsPagingPolicy.pagerVisible(Page(List(50) { "" }, 1, 50, 50, 1)))
        assertTrue(RecordsPagingPolicy.pagerVisible(Page(List(50) { "" }, 1, 50, 51, 2)))
        // 旧 Control：即使结果很长也不画分页条，因为页码是假的。
        assertFalse(RecordsPagingPolicy.pagerVisible(Page.unpaged(List(400) { "" })))
    }

    /**
     * 选了「每页 200 条」而总数只有 160 时分页条必须还在 —— 改页长的下拉菜单只长在这条上，藏了就
     * 再也换不回 50 条。
     */
    @Test fun aNonDefaultPageSizeAlwaysKeepsThePagerReachable() {
        assertTrue(RecordsPagingPolicy.pagerVisible(Page(List(160) { "" }, 1, 200, 160, 1)))
        assertTrue(RecordsPagingPolicy.pagerVisible(Page(List(20) { "" }, 1, 100, 20, 1)))
        assertTrue(RecordsPagingPolicy.pagerVisible(Page(emptyList<String>(), 1, 200, 0, 1)))
        // 但旧 Control 仍旧不画：那里的页码和页长都是客户端凑出来的。
        assertFalse(RecordsPagingPolicy.pagerVisible(Page.unpaged(List(160) { "" }, pageSize = 200)))
    }

    /** 删掉最后一页的唯一一行之后，服务端照实回 `page=3,totalPages=2`，客户端自己退回去。 */
    @Test fun anEmptyPagePastTheEndRewindsToTheLastPage() {
        assertEquals(2, RecordsPagingPolicy.rewindPage(Page(emptyList<String>(), 3, 50, 60, 2)))
        assertNull(RecordsPagingPolicy.rewindPage(Page(List(50) { "" }, 2, 50, 120, 3)))
        assertNull(RecordsPagingPolicy.rewindPage(Page(emptyList<String>(), 1, 50, 0, 1)))
    }

    @Test fun unpagedEnvelopeKeepsTheRequestedPageSizeAndOnePage() {
        val page = Page.unpaged(listOf("a", "b"), pageSize = 200)
        assertEquals(1, page.page)
        assertEquals(200, page.pageSize)
        assertEquals(2, page.total)
        assertEquals(1, page.totalPages)
        assertFalse(page.supported)
    }

    @Test fun envelopeIsReadFromTheResponseAndDegradesWithoutTotalPages() {
        val paged = readPageEnvelope(
            JSONObject()
                .put("items", JSONArray())
                .put("page", 3)
                .put("pageSize", 100)
                .put("total", 640)
                .put("totalPages", 7),
            listOf("row"),
            requestedPageSize = 100,
        )
        assertEquals(Page(listOf("row"), page = 3, pageSize = 100, total = 640, totalPages = 7), paged)
        assertTrue(paged.supported)

        val legacy = readPageEnvelope(JSONObject().put("items", JSONArray()), listOf("row"), requestedPageSize = 50)
        assertEquals(Page.unpaged(listOf("row"), pageSize = 50), legacy)
        assertFalse(legacy.supported)
    }
}
