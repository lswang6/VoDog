package org.vodog

import org.json.JSONObject

/**
 * S89：`GET /sms` 键集分页拉全量（docs/specs/S89-sms-list-no-cap.md）。每页 `limit=500`，跟着
 * `nextCursor` 拉到 `null`，按页顺序拼接、按 `id` 去重（先到先得）。任一页抛错就整体抛出，
 * 调用方保留上一次成功的列表；调用方继续整表替换（S32 / S88 的「轮询里没有 = 已删除」依赖它）。
 *
 * ponytail: 每次轮询都拉全量；条数到 2000–3000 或单次响应约 500 KB 时，改为会话摘要接口 +
 * 按会话分页（或墓碑增量同步）。
 */
internal object SmsPagingPolicy {
    const val PAGE_LIMIT = 500
    const val MAX_PAGES = 20

    data class Cursor(val before: String, val beforeId: String)
    data class Page(val items: List<JSONObject>, val nextCursor: Cursor?)

    /** 旧 Control 不回 `nextCursor`，`optJSONObject` 对缺键和 `null` 都给 null，即只有一页。 */
    fun readPage(response: JSONObject): Page {
        val array = response.getJSONArray("items")
        val items = buildList { for (index in 0 until array.length()) add(array.getJSONObject(index)) }
        val cursor = response.optJSONObject("nextCursor")?.let {
            Cursor(it.getString("before"), it.getString("beforeId"))
        }
        return Page(items, cursor)
    }

    /**
     * [fetchLegacy]：回滚安全。只有第一页回 HTTP 400（旧 Control 拒绝 `limit=500`）时，改发一次
     * `/sms?limit=100` 并把它当全集返回；其余任何失败照常抛出。
     */
    fun fetchAll(fetchPage: (Cursor?) -> Page, fetchLegacy: () -> List<JSONObject>): List<JSONObject> {
        val first = try {
            fetchPage(null)
        } catch (error: ApiError) {
            if (error.status == 400) return fetchLegacy() else throw error
        }
        val seen = HashSet<String>()
        val out = ArrayList<JSONObject>()
        var page = first
        repeat(MAX_PAGES - 1) {
            page.items.forEach { if (seen.add(it.getString("id"))) out += it }
            page = fetchPage(page.nextCursor ?: return out)
        }
        page.items.forEach { if (seen.add(it.getString("id"))) out += it }
        if (page.nextCursor == null) return out
        ClientDiag.log("sms.page_cap", mapOf("pages" to MAX_PAGES, "items" to out.size), level = "warn")
        return out
    }
}
