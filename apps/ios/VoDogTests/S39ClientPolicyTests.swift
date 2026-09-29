import XCTest
@testable import VoDog

/// S39 删除全链路闭合, iOS half. Two decisions the standalone report sheets make outside any view: when a poll's
/// failure means the call is gone, and which exported files an hour-old sweep may delete.
final class S39ClientPolicyTests: XCTestCase {

    // MARK: - CallExistencePolicy

    func testOnly404ClosesASheetAndEveryOtherFailureLeavesItOpen() {
        XCTAssertTrue(CallExistencePolicy.shouldClose(APIError.server(404, "call not found", "CALL_NOT_FOUND")))
        XCTAssertTrue(CallExistencePolicy.shouldClose(APIError.server(404, "", nil)))

        // A transient failure must never close a sheet the user is reading — the next poll decides instead.
        XCTAssertFalse(CallExistencePolicy.shouldClose(APIError.server(409, "call is in use", "CALL_IN_USE")))
        XCTAssertFalse(CallExistencePolicy.shouldClose(APIError.server(500, "boom", nil)))
        XCTAssertFalse(CallExistencePolicy.shouldClose(APIError.server(503, "unavailable", nil)))
        XCTAssertFalse(CallExistencePolicy.shouldClose(APIError.unauthorized))
        XCTAssertFalse(CallExistencePolicy.shouldClose(APIError.invalidResponse))
        XCTAssertFalse(CallExistencePolicy.shouldClose(URLError(.notConnectedToInternet)))
        XCTAssertFalse(CallExistencePolicy.shouldClose(SessionLifecycleError.staleSession))
    }

    func testTheClosedSheetShowsTheSameWordingAsTheDetailPage() {
        XCTAssertEqual(CallExistencePolicy.deletedTitle, "通话记录已被删除")
        XCTAssertEqual(CallExistencePolicy.deletedMessage, "这条通话记录已在其他客户端删除，相关报告和详情已关闭。")
        XCTAssertEqual(CallExistencePolicy.deletedAcknowledgeButton, "好")
    }

    // MARK: - ExportCleanupPolicy

    func testExportSweepDeletesOnlyFilesStrictlyOlderThanAnHour() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let fresh = FileManager.default.temporaryDirectory.appendingPathComponent("exports/fresh.mp3")
        let boundary = FileManager.default.temporaryDirectory.appendingPathComponent("exports/boundary.mp3")
        let stale = FileManager.default.temporaryDirectory.appendingPathComponent("exports/stale.mp3")

        let expired = ExportCleanupPolicy.expired(
            [
                (fresh, now.addingTimeInterval(-59 * 60)),
                // Exactly at the boundary is kept: the share sheet it belongs to may still be on screen.
                (boundary, now.addingTimeInterval(-ExportCleanupPolicy.maximumAge)),
                (stale, now.addingTimeInterval(-3 * 3600)),
            ],
            now: now
        )
        XCTAssertEqual(expired, [stale])
        XCTAssertEqual(ExportCleanupPolicy.expired([], now: now), [])
        XCTAssertEqual(ExportCleanupPolicy.maximumAge, 3600)
        // Exports live in their own directory so the sweep can never reach a playback temp file.
        XCTAssertEqual(ExportCleanupPolicy.directory.lastPathComponent, "exports")
        XCTAssertEqual(
            ExportCleanupPolicy.directory.deletingLastPathComponent().standardizedFileURL,
            FileManager.default.temporaryDirectory.standardizedFileURL
        )
    }

    func testExportSweepRemovesStaleFilesAndToleratesAMissingDirectory() throws {
        let manager = FileManager.default
        // The real `exports/` may not exist yet; a sweep over a missing directory must simply do nothing.
        XCTAssertNoThrow(ExportCleanupPolicy.prune())

        try manager.createDirectory(at: ExportCleanupPolicy.directory, withIntermediateDirectories: true)
        let stale = ExportCleanupPolicy.directory.appendingPathComponent("s39-stale-\(UUID().uuidString).mp3")
        let fresh = ExportCleanupPolicy.directory.appendingPathComponent("s39-fresh-\(UUID().uuidString).mp3")
        defer { try? manager.removeItem(at: fresh) }
        try Data("stale".utf8).write(to: stale)
        try Data("fresh".utf8).write(to: fresh)
        try manager.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-2 * ExportCleanupPolicy.maximumAge)],
            ofItemAtPath: stale.path
        )

        ExportCleanupPolicy.prune()
        XCTAssertFalse(manager.fileExists(atPath: stale.path))
        XCTAssertTrue(manager.fileExists(atPath: fresh.path))
    }
}
