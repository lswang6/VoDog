package org.vodog

import org.json.JSONObject

/**
 * S28 记录分页信封。Control 给 `/calls`、`/reports/calls`、`/blocklist/interceptions` 三条列表加了
 * *可选* 的偏移分页：只有带上 `page` 的请求才会付一次 COUNT 并回 `{items,page,pageSize,total,
 * totalPages}`，不带 `page` 时整条路由与以前一字不差。所以分页只用在「记录」页，拨号页每 2–5 秒轮询
 * 的 [ClientUiState.calls] 一行都不会被分页请求改写。
 *
 * [supported] 是「这台 Control 还没有 S28」的标记：旧服务忽略 `page`，回老的 `{items}`，信封里没有
 * `totalPages`，于是整份结果当作一页、分页条隐藏，页面退回旧行为而不是报错。
 */
data class Page<T>(
    val items: List<T>,
    val page: Int,
    val pageSize: Int,
    val total: Int,
    val totalPages: Int,
    val supported: Boolean = true,
) {
    companion object {
        /** 旧 Control 的 `{items}`：一页、没有分页条、总数就是这一页的条数。 */
        fun <T> unpaged(items: List<T>, pageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE): Page<T> =
            Page(items, page = 1, pageSize = pageSize, total = items.size, totalPages = 1, supported = false)
    }
}

/**
 * 读信封。缺 `totalPages` 就是旧 Control（见 [Page.supported]）；其余字段缺失时退回请求时用的值，
 * 免得分页条自己算出一个和服务端不一致的页码。
 */
internal fun <T> readPageEnvelope(json: JSONObject, items: List<T>, requestedPageSize: Int): Page<T> {
    if (!json.has("totalPages") || json.isNull("totalPages")) return Page.unpaged(items, requestedPageSize)
    return Page(
        items = items,
        page = json.optInt("page", 1).coerceAtLeast(1),
        pageSize = json.optInt("pageSize", requestedPageSize).takeIf { it > 0 } ?: requestedPageSize,
        total = json.optInt("total", items.size).coerceAtLeast(0),
        totalPages = json.optInt("totalPages", 1).coerceAtLeast(1),
        supported = true,
    )
}

/**
 * 分页的纯规则，没有任何 Compose / 网络依赖，所以每一条都能单测。
 */
object RecordsPagingPolicy {
    /** 服务端的 `pageSize` 是闭集，集合外的值是 400，所以客户端只送这三个数。 */
    val PAGE_SIZES = listOf(50, 100, 200)

    val DEFAULT_PAGE_SIZE = PAGE_SIZES.first()

    /** 往下取最近的合法档位（0/49→50，150→100，5000→200），保证请求永远不会被 400 挡回来。 */
    fun clampPageSize(size: Int): Int = PAGE_SIZES.lastOrNull { it <= size } ?: PAGE_SIZES.first()

    /** 页码从 1 开始，且不会越过最后一页；`totalPages` 为 0 的空列表仍然是第 1 页。 */
    fun clampPage(page: Int, totalPages: Int): Int = page.coerceIn(1, totalPages.coerceAtLeast(1))

    /**
     * S30：本地删掉一行之后要跟着改的总页数。服务端算的是同一个式子，客户端只是在重读回来之前先把
     * 分页条改对，免得删掉第 3 页唯一一行之后分页条还写着「共 3 页」。空列表仍旧是 1 页。
     */
    fun totalPagesFor(total: Int, pageSize: Int): Int {
        val size = clampPageSize(pageSize)
        return ((total.coerceAtLeast(0) + size - 1) / size).coerceAtLeast(1)
    }

    /** 过滤条件（搜索词 / 日期窗口 / SIM）一变就回到第 1 页，否则第 7 页的翻页结果会是空的。 */
    fun resetsPage(oldKey: String, newKey: String): Boolean = oldKey != newKey

    /**
     * 分页条只在「默认页长的一小页」时才隐藏：旧 Control（[Page.supported] 为 false）永远不显示，
     * 默认 50 条一页且总数不超过 50 的结果也不显示。
     *
     * 判据里必须有 `pageSize != DEFAULT_PAGE_SIZE`：否则选了「每页 200 条」而总数只有 160 的人会看着
     * 分页条消失，再也换不回 50 —— 唯一能改页长的控件就在这条上。
     */
    fun pagerVisible(page: Page<*>): Boolean = page.supported &&
        (page.total > DEFAULT_PAGE_SIZE || page.pageSize != DEFAULT_PAGE_SIZE || page.totalPages > 1)

    /**
     * 服务端不会把越界的页码夹回来——删掉最后一页的唯一一行之后它照实回 `page=3,totalPages=2` 和空
     * `items`，让客户端能自己走回去。返回要退回的页码，没越界则是 null。
     */
    fun rewindPage(page: Page<*>): Int? = page.totalPages.takeIf { page.page > it && it >= 1 }
}
