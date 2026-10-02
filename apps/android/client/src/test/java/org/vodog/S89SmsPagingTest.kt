package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class S89SmsPagingTest {
    private fun row(id: String, body: String = id) = JSONObject().put("id", id).put("body", body)
    private val noLegacy: () -> List<JSONObject> = { error("legacy must not be called") }
    private fun fetchAll(page: (SmsPagingPolicy.Cursor?) -> SmsPagingPolicy.Page) = SmsPagingPolicy.fetchAll(page, noLegacy)
    private val cursor = SmsPagingPolicy.Cursor("2026-09-20T10:00:00.000+08:00", "uuid-b")

    @Test
    fun onePageRequestsOnce() {
        val calls = mutableListOf<SmsPagingPolicy.Cursor?>()
        val out = fetchAll { calls += it; SmsPagingPolicy.Page(listOf(row("a"), row("b")), null) }
        assertEquals(listOf<SmsPagingPolicy.Cursor?>(null), calls)
        assertEquals(listOf("a", "b"), out.map { it.getString("id") })
    }

    @Test
    fun twoPagesFollowCursorInPageOrder() {
        val calls = mutableListOf<SmsPagingPolicy.Cursor?>()
        val out = fetchAll {
            calls += it
            if (it == null) SmsPagingPolicy.Page(listOf(row("a"), row("b")), cursor)
            else SmsPagingPolicy.Page(listOf(row("c")), null)
        }
        assertEquals(listOf(null, cursor), calls)
        assertEquals(listOf("a", "b", "c"), out.map { it.getString("id") })
        assertEquals(
            "/sms?limit=500&before=2026-09-20T10%3A00%3A00.000%2B08%3A00&beforeId=uuid-b",
            ClientApiRoutes.smsPage(cursor),
        )
        assertEquals("/sms?limit=500", ClientApiRoutes.smsPage(null))
    }

    @Test
    fun duplicateIdsKeepFirstOccurrence() {
        val out = fetchAll {
            if (it == null) SmsPagingPolicy.Page(listOf(row("a"), row("b", "first")), cursor)
            else SmsPagingPolicy.Page(listOf(row("b", "second"), row("c")), null)
        }
        assertEquals(listOf("a", "b", "c"), out.map { it.getString("id") })
        assertEquals("first", out[1].getString("body"))
    }

    @Test
    fun secondPageFailureFailsWholeRefresh() = kotlinx.coroutines.runBlocking {
        val previous = RemoteList.Loaded(listOf(row("old")))
        val result = loadRemoteList {
            fetchAll {
                if (it == null) SmsPagingPolicy.Page(listOf(row("a")), cursor)
                else throw ApiError(500, "INTERNAL", "boom")
            }
        }
        assertTrue(result is RemoteList.Failed)
        assertSame(previous, remoteListAfterRefresh(previous, result))
    }

    @Test
    fun endlessCursorStopsAfterTwentyPages() {
        var calls = 0
        val out = fetchAll {
            calls++
            SmsPagingPolicy.Page(listOf(row("id-$calls")), cursor)
        }
        assertEquals(20, calls)
        assertEquals(20, out.size)
    }

    @Test
    fun oldServerWithoutNextCursorIsOnePage() {
        val page = SmsPagingPolicy.readPage(JSONObject().put("items", org.json.JSONArray().put(row("a"))))
        assertNull(page.nextCursor)
        assertEquals(1, page.items.size)
        assertNull(SmsPagingPolicy.readPage(JSONObject().put("items", org.json.JSONArray()).put("nextCursor", JSONObject.NULL)).nextCursor)
    }

    @Test
    fun firstPage400FallsBackToLegacyLimit() {
        var pageCalls = 0
        val out = SmsPagingPolicy.fetchAll(
            fetchPage = { pageCalls++; throw ApiError(400, "VALIDATION", "limit") },
            fetchLegacy = { listOf(row("x"), row("y")) },
        )
        assertEquals(1, pageCalls)
        assertEquals(listOf("x", "y"), out.map { it.getString("id") })
        assertEquals("/sms?limit=100", ClientApiRoutes.SMS_LEGACY)
    }

    @Test
    fun only400OnFirstPageFallsBack() {
        val other = runCatching { fetchAll { throw ApiError(500, "INTERNAL", "boom") } }
        assertEquals(500, (other.exceptionOrNull() as ApiError).status)
        val later400 = runCatching {
            fetchAll {
                if (it == null) SmsPagingPolicy.Page(listOf(row("a")), cursor)
                else throw ApiError(400, "VALIDATION", "cursor")
            }
        }
        assertEquals(400, (later400.exceptionOrNull() as ApiError).status)
    }
}
