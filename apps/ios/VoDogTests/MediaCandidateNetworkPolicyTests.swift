import XCTest
@testable import VoDog

/// S45: 蜂窝网下 `.lowCost` 把唯一可用的接口过滤掉了（手机常驻的 IMS 隧道被当成「更便宜」的网络），
/// 于是每通电话 12 秒内 0 个 relay candidate、TURN 主机侧抓不到手机的任何一个包。这里锁死的就是
/// 「什么时候还能开这个过滤器」。
final class MediaCandidateNetworkPolicyTests: XCTestCase {

    func testWiFiAndEthernetKeepTheProvenFilter() {
        XCTAssertEqual(
            MediaCandidateNetworkPolicy.choice(isSatisfied: true, usesWiFi: true, usesWiredEthernet: false), .lowCost
        )
        XCTAssertEqual(
            MediaCandidateNetworkPolicy.choice(isSatisfied: true, usesWiFi: false, usesWiredEthernet: true), .lowCost
        )
    }

    func testCellularOnlyGathersOnEveryInterface() {
        // The bug itself: nothing but cellular, so the filter would leave libwebrtc with the tunnels alone.
        XCTAssertEqual(
            MediaCandidateNetworkPolicy.choice(isSatisfied: true, usesWiFi: false, usesWiredEthernet: false), .all
        )
    }

    func testAnUnusablePathFallsToTheSafeSide() {
        // No interfaces at all, and the cold-launch case where nothing has been read yet: more allocations is a
        // cost, zero candidates is a failed call.
        XCTAssertEqual(
            MediaCandidateNetworkPolicy.choice(isSatisfied: false, usesWiFi: false, usesWiredEthernet: false), .all
        )
        // Joined Wi-Fi that carries nothing (captive portal) must not switch the filter back on.
        XCTAssertEqual(
            MediaCandidateNetworkPolicy.choice(isSatisfied: false, usesWiFi: true, usesWiredEthernet: false), .all
        )
    }

    func testTheLabelIsWhatTheDiagnosticPrints() {
        XCTAssertEqual(MediaCandidateNetworkPolicy.Choice.lowCost.label, "lowCost")
        XCTAssertEqual(MediaCandidateNetworkPolicy.Choice.all.label, "all")
    }
}
