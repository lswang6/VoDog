import Foundation
import Observation

/// S26. 记录 asks the server for one page at a time instead of a `limit`-capped prefix, so a busy line's older
/// calls stop falling off the end of the list. Everything the pager decides — which page is reachable, when a
/// content change starts over at page 1, when the bar is worth showing at all — lives here as pure functions so
/// Android and Web mirror one rule set rather than re-deriving three.
///
/// The page sizes are the server's own allow-list: `GET calls`, `GET reports/calls` and
/// `GET blocklist/interceptions` accept `pageSize` ∈ {50, 100, 200} and default to 50.
enum RecordsPagingPolicy {
    static let pageSizes = [50, 100, 200]
    static let defaultPageSize = 50
    static let firstPage = 1

    /// A page number the list can actually ask for. `totalPages` is nil until the first paged answer arrives —
    /// the page is then only floored, never capped, so the first request still goes out as asked.
    static func clampPage(_ page: Int, totalPages: Int?) -> Int {
        let floored = max(firstPage, page)
        guard let totalPages else { return floored }
        return min(floored, max(firstPage, totalPages))
    }

    static func nextPage(_ page: Int, totalPages: Int?) -> Int {
        clampPage(page + 1, totalPages: totalPages)
    }

    static func previousPage(_ page: Int) -> Int {
        clampPage(page - 1, totalPages: nil)
    }

    static func canGoPrevious(page: Int) -> Bool { page > firstPage }

    static func canGoNext(page: Int, totalPages: Int?) -> Bool {
        guard let totalPages else { return false }
        return page < totalPages
    }

    /// Whether a change of *what* is being listed — the search text, the report window, the SIM filter — makes
    /// the current page number meaningless. It always does: page 7 of the old result set is not page 7 of the
    /// new one, so any content change starts over at page 1 while a page or page-size change does not.
    static func resetsPage(oldKey: String, newKey: String) -> Bool { oldKey != newKey }

    /// A page size the server accepts; anything else falls back to the default rather than being rejected.
    static func normalizedPageSize(_ pageSize: Int) -> Int {
        pageSizes.contains(pageSize) ? pageSize : defaultPageSize
    }

    /// The bar is hidden on a Control that does not page (`supported == false`) and on a single short page at
    /// the default size, where it would only state that there is nothing to page through.
    ///
    /// The page size is deliberately part of the test rather than just the row count: with 160 rows at 每页 200
    /// 条 there is one page, but hiding the bar would stand the user in a size they chose with no control left
    /// to change it back. A size other than the default therefore keeps the bar on screen.
    static func showsPager(supported: Bool, totalPages: Int?, total: Int?, pageSize: Int) -> Bool {
        guard supported, let totalPages else { return false }
        if totalPages > 1 { return true }
        if pageSize != defaultPageSize { return true }
        return (total ?? 0) > defaultPageSize
    }

    static func pageLabel(page: Int, totalPages: Int?) -> String {
        "第 \(page) / \(totalPages ?? page) 页"
    }

    static func totalLabel(total: Int?) -> String { "共 \(total ?? 0) 条" }

    static func pageSizeLabel(_ pageSize: Int) -> String { "每页 \(pageSize) 条" }

    static let pageSizeAccessibilitySuffix = "，点击更改"
    static let previousLabel = "上一页"
    static let nextLabel = "下一页"
    static let jumpLabel = "跳转到指定页"
    static let jumpFieldPrompt = "页码"
    static let jumpConfirm = "跳转"
    static let jumpCancel = "取消"

    static func pageSizeAccessibilityLabel(_ pageSize: Int) -> String {
        pageSizeLabel(pageSize) + pageSizeAccessibilitySuffix
    }
}

/// The paging state of one 记录 segment.
///
/// It is a reference type on purpose: 拦截记录 is re-instantiated on every segment switch (its `@State` is
/// lost), so the store is owned by `RecordsView` and handed down — leaving the segment and coming back keeps
/// the page instead of silently snapping to the first one. 全部通话 and 报告 use the same type so `PagerBar`
/// has exactly one signature.
@MainActor @Observable
final class RecordsPagingStore {
    var page: Int
    var pageSize: Int
    var total: Int?
    var totalPages: Int?
    /// 拦截记录's 类型 filter. It lives here for the same reason the page does — the segment loses its own state.
    var kind: InterceptionKindFilter

    init(
        page: Int = RecordsPagingPolicy.firstPage,
        pageSize: Int = RecordsPagingPolicy.defaultPageSize,
        total: Int? = nil,
        totalPages: Int? = nil,
        kind: InterceptionKindFilter = .all
    ) {
        self.page = page
        self.pageSize = pageSize
        self.total = total
        self.totalPages = totalPages
        self.kind = kind
    }

    /// Nil `totalPages` — an older Control, or a failed request — means "not paged", which hides the bar.
    var supported: Bool { totalPages != nil }

    /// What the 每页 menu writes to. Page 7 at 50 a page is not page 7 at 200, so the size and the page move in
    /// one state change: the list then asks for page 1 at the new size once instead of fetching the old page at
    /// the new size first and correcting itself.
    var pageSizeSelection: Int {
        get { pageSize }
        set {
            guard newValue != pageSize else { return }
            pageSize = RecordsPagingPolicy.normalizedPageSize(newValue)
            page = RecordsPagingPolicy.firstPage
        }
    }

    var showsPager: Bool {
        RecordsPagingPolicy.showsPager(
            supported: supported, totalPages: totalPages, total: total, pageSize: pageSize
        )
    }

    /// What the server said it actually returned. The page is re-clamped because asking for page 9 of a result
    /// that shrank to 3 pages must land on 3 rather than leave the bar claiming a page that does not exist.
    func apply(page: Int?, total: Int?, totalPages: Int?, requestedPage: Int) {
        self.total = total
        self.totalPages = totalPages
        let resolved = RecordsPagingPolicy.clampPage(page ?? requestedPage, totalPages: totalPages)
        if self.page != resolved { self.page = resolved }
    }

    /// A request that failed or answered `{items}`: no page count, so no bar.
    func clearPaging() {
        total = nil
        totalPages = nil
    }

    func goToFirstPage() { page = RecordsPagingPolicy.firstPage }
}
