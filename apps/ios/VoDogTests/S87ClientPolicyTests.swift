import SwiftUI
import XCTest
@testable import VoDog

/// S87：短信正文链接识别，三端共同测试向量逐条照抄。
final class S87ClientPolicyTests: XCTestCase {

    private func urls(_ text: String) -> [String] { SMSLinkPolicy.links(in: text).map(\.url) }

    func testSpecVectors() {
        XCTAssertEqual(urls("验证码见 https://a.com/x?y=1，请查收"), ["https://a.com/x?y=1"])
        XCTAssertEqual(urls("点击 t.cn/A6abc 退订回T"), ["http://t.cn/A6abc"])
        XCTAssertEqual(urls("访问 www.10086.cn。"), ["http://www.10086.cn"])
        XCTAssertEqual(urls("(详见 https://x.org/a)."), ["https://x.org/a"])
        XCTAssertEqual(urls("两个链接 https://a.cn 和 b.com/c"), ["https://a.cn", "http://b.com/c"])
        XCTAssertEqual(urls("HTTP://EXAMPLE.COM/A"), ["HTTP://EXAMPLE.COM/A"])
        XCTAssertEqual(urls("邮箱 foo@bar.com"), [])
        XCTAssertEqual(urls("版本 3.5.1 价格 12.50"), [])
        XCTAssertEqual(urls("abc.community"), [])
        XCTAssertEqual(urls("ftp://x.com"), [])
        XCTAssertEqual(urls("https://"), [])
        XCTAssertEqual(urls(""), [])
    }

    func testRangeExcludesTrimmedPunctuation() {
        let text = "(详见 https://x.org/a)."
        let link = SMSLinkPolicy.links(in: text)[0]
        XCTAssertEqual((text as NSString).substring(with: link.range), "https://x.org/a")
    }

    func testOpenGuardAllowsOnlyHttp() {
        XCTAssertTrue(SMSLinkPolicy.isOpenable(URL(string: "https://a.com")!))
        XCTAssertTrue(SMSLinkPolicy.isOpenable(URL(string: "HTTP://EXAMPLE.COM/A")!))
        XCTAssertFalse(SMSLinkPolicy.isOpenable(URL(string: "ftp://x.com")!))
        XCTAssertFalse(SMSLinkPolicy.isOpenable(URL(string: "javascript:alert(1)")!))
        XCTAssertFalse(SMSLinkPolicy.isOpenable(URL(string: "tel:10086")!))
        XCTAssertFalse(SMSLinkPolicy.isOpenable(URL(string: "a.com/x")!))
    }

    func testAttributedLinksOnlyOutsideSelection() {
        let text = "点击 t.cn/A6abc 退订"
        let linked = SMSLinkPolicy.attributed(text, color: .red, linked: true)
        let links = linked.runs.compactMap(\.link)
        XCTAssertEqual(links, [URL(string: "http://t.cn/A6abc")!])
        let run = linked.runs.first { $0.link != nil }!
        XCTAssertEqual(run.underlineStyle, .single)
        XCTAssertEqual(run.foregroundColor, .red)
        XCTAssertEqual(String(linked[run.range].characters), "t.cn/A6abc")

        let plain = SMSLinkPolicy.attributed(text, color: .red, linked: false)
        XCTAssertTrue(plain.runs.allSatisfy { $0.link == nil })
        XCTAssertEqual(plain, AttributedString(text))
        XCTAssertEqual(SMSLinkPolicy.attributed("没有链接", color: .red, linked: true), AttributedString("没有链接"))
    }
}
