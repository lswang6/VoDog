import XCTest
@testable import VoDog

/// S26 分页。记录 的三个分段都按页向服务端要数据，这里把"哪一页可达、什么时候回到第 1 页、分页条什么时候出现"
/// 定死成纯函数事实，Android 和 Web 照抄同一套规则。
final class RecordsPagingPolicyTests: XCTestCase {
    // MARK: - 每页条数与页码夹取

    func testPageSizesAreTheServerAllowListAndUnknownSizesFallBackToTheDefault() {
        XCTAssertEqual(RecordsPagingPolicy.pageSizes, [50, 100, 200])
        XCTAssertEqual(RecordsPagingPolicy.defaultPageSize, 50)
        XCTAssertEqual(RecordsPagingPolicy.firstPage, 1)
        for size in RecordsPagingPolicy.pageSizes {
            XCTAssertEqual(RecordsPagingPolicy.normalizedPageSize(size), size)
        }
        XCTAssertEqual(RecordsPagingPolicy.normalizedPageSize(75), 50, "服务端只接受 50/100/200")
        XCTAssertEqual(RecordsPagingPolicy.normalizedPageSize(0), 50)
        XCTAssertEqual(RecordsPagingPolicy.normalizedPageSize(-10), 50)
    }

    func testClampKeepsThePageInsideTheAnsweredRangeAndOnlyFloorsBeforeTheFirstAnswer() {
        XCTAssertEqual(RecordsPagingPolicy.clampPage(3, totalPages: 7), 3)
        XCTAssertEqual(RecordsPagingPolicy.clampPage(9, totalPages: 3), 3, "结果集缩小后要落在最后一页")
        XCTAssertEqual(RecordsPagingPolicy.clampPage(0, totalPages: 7), 1)
        XCTAssertEqual(RecordsPagingPolicy.clampPage(-5, totalPages: 7), 1)
        XCTAssertEqual(RecordsPagingPolicy.clampPage(4, totalPages: 0), 1, "空结果仍然是第 1 页，不是第 0 页")
        // 还没有任何分页答复时只兜住下界，请求照旧发出去，否则第一页永远问不到总页数。
        XCTAssertEqual(RecordsPagingPolicy.clampPage(12, totalPages: nil), 12)
        XCTAssertEqual(RecordsPagingPolicy.clampPage(0, totalPages: nil), 1)
    }

    func testNextAndPreviousStopAtTheEndsInsteadOfWrapping() {
        XCTAssertEqual(RecordsPagingPolicy.nextPage(3, totalPages: 7), 4)
        XCTAssertEqual(RecordsPagingPolicy.nextPage(7, totalPages: 7), 7)
        XCTAssertEqual(RecordsPagingPolicy.previousPage(3), 2)
        XCTAssertEqual(RecordsPagingPolicy.previousPage(1), 1)
        XCTAssertTrue(RecordsPagingPolicy.canGoPrevious(page: 2))
        XCTAssertFalse(RecordsPagingPolicy.canGoPrevious(page: 1))
        XCTAssertTrue(RecordsPagingPolicy.canGoNext(page: 6, totalPages: 7))
        XCTAssertFalse(RecordsPagingPolicy.canGoNext(page: 7, totalPages: 7))
        XCTAssertFalse(
            RecordsPagingPolicy.canGoNext(page: 1, totalPages: nil),
            "旧版 Control 没有总页数，下一页无从谈起"
        )
    }

    // MARK: - 内容变化才回到第 1 页

    func testOnlyAContentChangeResetsToPageOne() {
        XCTAssertTrue(RecordsPagingPolicy.resetsPage(oldKey: "", newKey: "张三"))
        XCTAssertTrue(RecordsPagingPolicy.resetsPage(oldKey: "张三", newKey: ""))
        XCTAssertTrue(
            RecordsPagingPolicy.resetsPage(
                oldKey: "2026-09-05\u{001f}2026-09-11", newKey: "2026-08-13\u{001f}2026-09-11"
            ),
            "换了日期范围就是换了一份结果，第 7 页不再是同一批通话"
        )
        XCTAssertFalse(RecordsPagingPolicy.resetsPage(oldKey: "张三", newKey: "张三"))
        XCTAssertFalse(RecordsPagingPolicy.resetsPage(oldKey: "", newKey: ""))
    }

    // MARK: - 分页条什么时候出现

    func testPagerHidesOnlyOnALegacyControlOrAShortSinglePageAtTheDefaultSize() {
        XCTAssertFalse(
            RecordsPagingPolicy.showsPager(supported: false, totalPages: nil, total: 613, pageSize: 50),
            "没有 totalPages 的旧 Control 只有一页，不该出现分页条"
        )
        XCTAssertFalse(RecordsPagingPolicy.showsPager(supported: true, totalPages: 1, total: 12, pageSize: 50))
        XCTAssertFalse(RecordsPagingPolicy.showsPager(supported: true, totalPages: 1, total: 50, pageSize: 50))
        XCTAssertFalse(RecordsPagingPolicy.showsPager(supported: true, totalPages: 0, total: 0, pageSize: 50))
        XCTAssertTrue(RecordsPagingPolicy.showsPager(supported: true, totalPages: 2, total: 60, pageSize: 50))
        XCTAssertTrue(
            RecordsPagingPolicy.showsPager(supported: true, totalPages: 1, total: 80, pageSize: 50),
            "总数超过一页容量时即使服务端说只有一页也要能翻"
        )
        // 每页 200 条、共 160 条：确实只有一页，但把分页条藏起来就等于把用户锁在自己选的 200 条里，
        // 再也换不回 50 条。只要不是默认每页条数，分页条就必须留在屏幕上。
        XCTAssertTrue(RecordsPagingPolicy.showsPager(supported: true, totalPages: 1, total: 160, pageSize: 200))
        XCTAssertTrue(RecordsPagingPolicy.showsPager(supported: true, totalPages: 1, total: 12, pageSize: 100))
        XCTAssertTrue(RecordsPagingPolicy.showsPager(supported: true, totalPages: 0, total: 0, pageSize: 200))
    }

    func testPagerCopyMatchesTheThreeEndWording() {
        XCTAssertEqual(RecordsPagingPolicy.pageLabel(page: 3, totalPages: 7), "第 3 / 7 页")
        XCTAssertEqual(RecordsPagingPolicy.pageLabel(page: 2, totalPages: nil), "第 2 / 2 页")
        XCTAssertEqual(RecordsPagingPolicy.totalLabel(total: 613), "共 613 条")
        XCTAssertEqual(RecordsPagingPolicy.totalLabel(total: nil), "共 0 条")
        XCTAssertEqual(RecordsPagingPolicy.pageSizeLabel(100), "每页 100 条")
        XCTAssertEqual(RecordsPagingPolicy.pageSizeAccessibilityLabel(100), "每页 100 条，点击更改")
        XCTAssertEqual(RecordsPagingPolicy.previousLabel, "上一页")
        XCTAssertEqual(RecordsPagingPolicy.nextLabel, "下一页")
        XCTAssertEqual(RecordsPagingPolicy.jumpLabel, "跳转到指定页")
        XCTAssertEqual(RecordsPagingPolicy.jumpFieldPrompt, "页码")
    }

    // MARK: - 分页状态

    @MainActor
    func testStoreClampsTheAnsweredPageAndDropsPagingWhenTheRequestFails() {
        let store = RecordsPagingStore(page: 9, pageSize: 100)
        XCTAssertFalse(store.supported, "第一次答复之前不知道有没有分页")
        XCTAssertFalse(store.showsPager)

        store.apply(page: 9, total: 240, totalPages: 3, requestedPage: 9)
        XCTAssertEqual(store.page, 3, "服务端只有 3 页时停在第 3 页")
        XCTAssertEqual(store.total, 240)
        XCTAssertTrue(store.supported)
        XCTAssertTrue(store.showsPager)

        // 旧 Control：只有 items，没有任何计数。
        store.apply(page: nil, total: nil, totalPages: nil, requestedPage: 3)
        XCTAssertEqual(store.page, 3, "不分页的服务端不该把用户踢回第 1 页")
        XCTAssertFalse(store.supported)
        XCTAssertFalse(store.showsPager)

        store.apply(page: 2, total: 187, totalPages: 4, requestedPage: 2)
        XCTAssertEqual(store.page, 2)
        store.clearPaging()
        XCTAssertFalse(store.showsPager, "请求失败后分页条消失，而不是停在一个过期的页码上")
        XCTAssertEqual(store.page, 2, "失败不改变用户当前所在的页")

        store.goToFirstPage()
        XCTAssertEqual(store.page, 1)
        XCTAssertEqual(store.kind, .all)
    }

    @MainActor
    func testChangingThePageSizeReturnsToPageOneInTheSameStateChange() {
        let store = RecordsPagingStore(page: 5, pageSize: 50, total: 613, totalPages: 13)
        store.pageSizeSelection = 200
        XCTAssertEqual(store.pageSize, 200)
        XCTAssertEqual(store.page, 1, "第 5 页（每页 50）不是第 5 页（每页 200），只能从头开始")

        store.page = 3
        store.pageSizeSelection = 200
        XCTAssertEqual(store.page, 3, "选中同一个每页条数不该把用户踢回第 1 页")

        store.pageSizeSelection = 75
        XCTAssertEqual(store.pageSize, 50, "服务端不接受的每页条数落回默认值")
        XCTAssertEqual(store.page, 1)
    }

    // MARK: - 查询串

    func testCallsQuerySendsPageAndPageSizeInsteadOfLimit() {
        let paged = query(RecordSearchPolicy.callsQuery(query: "  张三  ", page: 2, pageSize: 100))
        XCTAssertEqual(paged["query"], "张三")
        XCTAssertEqual(paged["page"], "2")
        XCTAssertEqual(paged["pageSize"], "100")
        XCTAssertNil(paged["limit"], "page 与 limit 会给出两个互相矛盾的窗口，只能留一个")

        // 没有 page 时与 S22 的请求完全一样，旧 Control 照样答得出来。
        let legacy = query(RecordSearchPolicy.callsQuery(query: "张三"))
        XCTAssertEqual(legacy["limit"], "100")
        XCTAssertNil(legacy["page"])
        XCTAssertNil(legacy["pageSize"])
        XCTAssertNil(query(RecordSearchPolicy.callsQuery(query: "   "))["query"])

        // 选中某条线路时按 simId 让服务端筛，而不是把一页里不属于它的行删掉。
        let bySIM = query(RecordSearchPolicy.callsQuery(query: "", simId: "sim-1", page: 1, pageSize: 50))
        XCTAssertEqual(bySIM["simId"], "sim-1")
        XCTAssertNil(query(RecordSearchPolicy.callsQuery(query: "", simId: "  ", page: 1, pageSize: 50))["simId"])

        // 越界或不被接受的每页条数在发出去之前就被纠正。
        let corrected = query(RecordSearchPolicy.callsQuery(query: "", page: 0, pageSize: 75))
        XCTAssertEqual(corrected["page"], "1")
        XCTAssertEqual(corrected["pageSize"], "50")
    }

    func testReportQueryPagesTheCalendarWindowAndKeepsTheLegacyLimitWhenUnpaged() {
        let paged = query(RecordSearchPolicy.reportQuery(
            from: "2026-09-05", to: "2026-09-11", timeZone: "Asia/Shanghai", query: "保险",
            page: 3, pageSize: 200, simId: "sim-2"
        ))
        XCTAssertEqual(paged["from"], "2026-09-05")
        XCTAssertEqual(paged["to"], "2026-09-11")
        XCTAssertEqual(paged["timeZone"], "Asia/Shanghai")
        XCTAssertEqual(paged["query"], "保险")
        XCTAssertEqual(paged["page"], "3")
        XCTAssertEqual(paged["pageSize"], "200")
        XCTAssertEqual(paged["simId"], "sim-2")
        XCTAssertNil(paged["limit"])
        XCTAssertNil(paged["period"], "S22 起只发显式日历窗口")

        let legacy = query(RecordSearchPolicy.reportQuery(
            from: "2026-09-05", to: "2026-09-11", timeZone: "Asia/Shanghai", query: ""
        ))
        XCTAssertEqual(legacy["limit"], "200")
        XCTAssertNil(legacy["page"])
        XCTAssertNil(legacy["query"])
        XCTAssertNil(legacy["simId"])
    }

    func testInterceptionsQueryPagesOrFallsBackToTheS21Limit() {
        let paged = query(RecordSearchPolicy.interceptionsQuery(page: 4, pageSize: 200))
        XCTAssertEqual(paged["page"], "4")
        XCTAssertEqual(paged["pageSize"], "200")
        XCTAssertNil(paged["limit"])

        let legacy = query(RecordSearchPolicy.interceptionsQuery())
        XCTAssertEqual(legacy["limit"], "100")
        XCTAssertNil(legacy["page"])
        XCTAssertEqual(RecordSearchPolicy.interceptionsLimit, 100)
    }

    private func query(_ items: [URLQueryItem]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }
}
