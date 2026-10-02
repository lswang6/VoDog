import Foundation
import XCTest
@testable import VoDog

/// S89：短信列表跟随 nextCursor 拉全量，四端共同测试表逐条对应，外加旧 Control 400 回退。
final class S89ClientPolicyTests: XCTestCase {
    private struct Row: Identifiable, Codable, Sendable, Equatable { let id: String; var body = "" }
    private enum Boom: Error { case failed }

    private func rows(_ ids: String...) -> [Row] { ids.map { Row(id: $0) } }
    private func cursor(_ n: Int) -> SMSPageCursor { SMSPageCursor(before: "2026-09-2\(n)T00:00:00.000+08:00", beforeId: "id-\(n)") }
    private func value(_ q: [URLQueryItem], _ name: String) -> String? { q.first { $0.name == name }?.value }
    private func url(_ q: [URLQueryItem]) -> String {
        (try! APIClient.url("sms", queryItems: q, base: URL(string: "https://x/api/v1")!)).absoluteString
    }

    func testOnePage() async throws {
        var calls: [[URLQueryItem]] = []
        let result = try await SMSFullListPolicy.fetchAll { q -> SMSPageEnvelope<Row> in
            calls.append(q); return SMSPageEnvelope(items: self.rows("a", "b"), nextCursor: nil)
        }
        XCTAssertEqual(calls, [[URLQueryItem(name: "limit", value: "500")]])
        XCTAssertEqual(result.items.map(\.id), ["a", "b"])
        XCTAssertFalse(result.capped)
    }

    func testTwoPagesConcatInOrderAndSecondCarriesCursor() async throws {
        var calls: [[URLQueryItem]] = []
        let result = try await SMSFullListPolicy.fetchAll { q -> SMSPageEnvelope<Row> in
            calls.append(q)
            return calls.count == 1 ? SMSPageEnvelope(items: self.rows("a", "b"), nextCursor: self.cursor(1))
                : SMSPageEnvelope(items: self.rows("c"), nextCursor: nil)
        }
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(value(calls[1], "limit"), "500")
        XCTAssertEqual(value(calls[1], "before"), cursor(1).before)
        XCTAssertEqual(value(calls[1], "beforeId"), "id-1")
        XCTAssertEqual(result.items.map(\.id), ["a", "b", "c"])
    }

    func testCursorTimestampIsPercentEncodedInURL() {
        XCTAssertEqual(
            url(SMSFullListPolicy.query(cursor(1))),
            "https://x/api/v1/sms?limit=500&before=2026-09-21T00:00:00.000%2B08:00&beforeId=id-1"
        )
    }

    func testDuplicateIdKeepsFirst() async throws {
        var n = 0
        let result = try await SMSFullListPolicy.fetchAll { _ -> SMSPageEnvelope<Row> in
            n += 1
            return n == 1 ? SMSPageEnvelope(items: [Row(id: "a", body: "first"), Row(id: "b", body: "first")], nextCursor: self.cursor(1))
                : SMSPageEnvelope(items: [Row(id: "b", body: "second"), Row(id: "c")], nextCursor: nil)
        }
        XCTAssertEqual(result.items.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(result.items[1].body, "first")
    }

    func testSecondPageFailureThrows() async {
        var n = 0
        do {
            _ = try await SMSFullListPolicy.fetchAll { _ -> SMSPageEnvelope<Row> in
                n += 1
                if n == 2 { throw Boom.failed }
                return SMSPageEnvelope(items: self.rows("a"), nextCursor: self.cursor(1))
            }
            XCTFail("partial list must not be returned")
        } catch {
            XCTAssertTrue(error is Boom)
        }
    }

    func testEndlessCursorStopsAfterTwentyPages() async throws {
        var n = 0
        let result = try await SMSFullListPolicy.fetchAll { _ -> SMSPageEnvelope<Row> in
            n += 1; return SMSPageEnvelope(items: self.rows("r\(n)"), nextCursor: self.cursor(n % 10))
        }
        XCTAssertEqual(n, 20)
        XCTAssertEqual(result.items.count, 20)
        XCTAssertTrue(result.capped)
    }

    func testFirstPage400FallsBackToSingleLimit100Request() async throws {
        var calls: [[URLQueryItem]] = []
        let result = try await SMSFullListPolicy.fetchAll { q -> SMSPageEnvelope<Row> in
            calls.append(q)
            if calls.count == 1 { throw APIError.server(400, "limit", nil) }
            return SMSPageEnvelope(items: self.rows("old"), nextCursor: self.cursor(1))  // ignored: no paging
        }
        XCTAssertEqual(calls, [[URLQueryItem(name: "limit", value: "500")], [URLQueryItem(name: "limit", value: "100")]])
        XCTAssertEqual(result.items.map(\.id), ["old"])
        XCTAssertFalse(result.capped)
    }

    func testOnlyPageOne400FallsBack() async {
        for (failOn, status) in [(1, 500), (2, 400)] {
            var n = 0
            do {
                _ = try await SMSFullListPolicy.fetchAll { _ -> SMSPageEnvelope<Row> in
                    n += 1
                    if n == failOn { throw APIError.server(status, "", nil) }
                    return SMSPageEnvelope(items: self.rows("a"), nextCursor: self.cursor(1))
                }
                XCTFail("page \(failOn) \(status) must throw")
            } catch {
                XCTAssertEqual(n, failOn, "no fallback request after page \(failOn) \(status)")
            }
        }
    }

    func testOldServerWithoutNextCursorDecodesAsLastPage() throws {
        let page = try JSONDecoder().decode(SMSPageEnvelope<Row>.self, from: Data(#"{"items":[{"id":"a","body":""}]}"#.utf8))
        XCTAssertNil(page.nextCursor)
    }
}
