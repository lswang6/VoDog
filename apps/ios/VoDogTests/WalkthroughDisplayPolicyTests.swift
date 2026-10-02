import Foundation
import XCTest
@testable import VoDog

/// 2026-10-01 en_US device walkthrough: dates, received-SMS state, contact labels, snapshot caption.
final class WalkthroughDisplayPolicyTests: XCTestCase {
    func testDisplayDateIsChinesePatternNotDeviceLocale() {
        // 07:32Z is 15:32 in the records fallback zone (UTC+8); the formatter pins en_US_POSIX, so an en_US
        // device no longer gets "Oct 1, 2026 at 3:32 PM".
        XCTAssertEqual(displayDate("2026-10-01T07:32:00Z"), "2026年10月1日 15:32")
        XCTAssertEqual(displayDate("2026-10-01T07:32:00.123Z"), "2026年10月1日 15:32")
        XCTAssertEqual(displayDate("2026-01-05T16:04:00Z"), "2026年1月6日 00:04")
        XCTAssertEqual(displayDate("2026-10-01T07:32:00Z", timeZone: TimeZone(identifier: "UTC")!), "2026年10月1日 07:32")
        XCTAssertEqual(displayDate(nil), "—")
        XCTAssertEqual(displayDate("not a date"), "not a date")
    }

    func testDeliveredReadsReceivedForIncoming() throws {
        func message(_ direction: String) throws -> SMSMessage {
            try JSONDecoder().decode(SMSMessage.self, from: Data(#"{"id":"1","direction":"\#(direction)","state":"delivered"}"#.utf8))
        }
        XCTAssertEqual(try message("incoming").deliveryTitle, "已收到")
        XCTAssertEqual(try message("outgoing").deliveryTitle, "已送达")
    }

    func testIncomingRowOmitsArrivedState() throws {
        func message(_ direction: String, _ state: String) throws -> SMSMessage {
            try JSONDecoder().decode(SMSMessage.self, from: Data(#"{"id":"1","direction":"\#(direction)","state":"\#(state)"}"#.utf8))
        }
        XCTAssertNil(try message("incoming", "delivered").statusTitleForRow)
        XCTAssertNil(try message("incoming", "received").statusTitleForRow)
        XCTAssertEqual(try message("outgoing", "delivered").statusTitleForRow, "已送达")
        XCTAssertEqual(try message("incoming", "failed").statusTitleForRow, "发送失败")
        XCTAssertEqual(try message("incoming", "unknown").statusTitleForRow, "状态待确认")
    }

    func testContactLabelsMatchAndroidWords() {
        XCTAssertEqual(ContactLabelDisplay.text("mobile", fallback: "电话"), "手机")
        XCTAssertEqual(ContactLabelDisplay.text("Mobile", fallback: "电话"), "手机")
        XCTAssertEqual(ContactLabelDisplay.text("cell", fallback: "电话"), "手机")
        XCTAssertEqual(ContactLabelDisplay.text("home", fallback: "电话"), "住宅")
        XCTAssertEqual(ContactLabelDisplay.text("work", fallback: "电话"), "工作")
        XCTAssertEqual(ContactLabelDisplay.text("main", fallback: "电话"), "主要")
        XCTAssertEqual(ContactLabelDisplay.text("other", fallback: "电话"), "其他")
        XCTAssertEqual(ContactLabelDisplay.text("iphone", fallback: "电话"), "iPhone")
        XCTAssertEqual(ContactLabelDisplay.text("pager", fallback: "电话"), "寻呼机")
        XCTAssertEqual(ContactLabelDisplay.text("家里座机", fallback: "电话"), "家里座机")
        XCTAssertEqual(ContactLabelDisplay.text(nil, fallback: "电话"), "电话")
        XCTAssertEqual(ContactLabelDisplay.text("  ", fallback: "邮箱"), "邮箱")
    }

    func testEditorSavesCanonicalLabel() {
        for key in ["mobile", "home", "work", "main", "iphone", "other", "work_mobile"] {
            XCTAssertEqual(ContactLabelDisplay.stored(ContactLabelDisplay.text(key, fallback: "")), key)
        }
        XCTAssertEqual(ContactLabelDisplay.stored("cell"), "cell")
        XCTAssertEqual(ContactLabelDisplay.stored(" 家里座机 "), "家里座机")
        XCTAssertNil(ContactLabelDisplay.stored(""))
    }

    func testSnapshotCaptionOnlyWhenInformative() {
        XCTAssertFalse(RecordSearchPolicy.showsSnapshotCaption(query: "", page: 1, stale: false))
        XCTAssertFalse(RecordSearchPolicy.showsSnapshotCaption(query: "  ", page: 1, stale: false))
        XCTAssertTrue(RecordSearchPolicy.showsSnapshotCaption(query: "159", page: 1, stale: false))
        XCTAssertTrue(RecordSearchPolicy.showsSnapshotCaption(query: "", page: 2, stale: false))
        XCTAssertTrue(RecordSearchPolicy.showsSnapshotCaption(query: "", page: 1, stale: true))
    }
}
