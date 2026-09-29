import XCTest
@testable import VoDog

final class MediaFailureMessagePolicyTests: XCTestCase {
    private func message(_ code: String?, status: Int = 503, serverMessage: String = "", transport: MediaTransport = .udp) -> String {
        MediaFailureMessagePolicy.message(status: status, code: code, serverMessage: serverMessage, transport: transport)
    }

    func testEveryKnownCodeHasItsOwnSentence() {
        XCTAssertEqual(message("GATEWAY_OFFLINE"), "网关当前不在线（心跳超时），请稍后重试")
        XCTAssertEqual(message("MEDIA_UNAVAILABLE"), "网关媒体能力暂不可用，请稍后重试")
        XCTAssertEqual(message("MEDIA_NODE_UNAVAILABLE"), "当前网络与设备没有共同可用的媒体节点")
        XCTAssertEqual(message("MEDIA_BRIDGE_UNAVAILABLE"), "媒体节点未接受连接，请重试")
        XCTAssertEqual(message("MEDIA_REVOKED", status: 409), "通话已结束或媒体授权失效")
        XCTAssertEqual(message("MEDIA_PROBE_REQUIRED", status: 409), "网络测量尚未完成，请重试")
        XCTAssertEqual(message("MEDIA_NODE_MISMATCH", status: 409), "媒体节点不一致，请重新连接音频")
        XCTAssertEqual(message("MEDIA_NOT_WINNER", status: 409), "此通话已由其他设备接听")
    }

    /// The three 503 codes used to share one sentence ("没有共同可用的媒体节点"), which misreported an offline gateway
    /// as a network problem.
    func testGatewayOfflineIsNotReportedAsMissingMediaNode() {
        XCTAssertNotEqual(message("GATEWAY_OFFLINE"), message("MEDIA_NODE_UNAVAILABLE"))
        XCTAssertNotEqual(message("MEDIA_UNAVAILABLE"), message("MEDIA_NODE_UNAVAILABLE"))
    }

    func testUnknownCodeFallsBackToServerMessageWithCode() {
        XCTAssertEqual(
            message("SOMETHING_ELSE", status: 500, serverMessage: "服务器内部错误"),
            "服务器内部错误（SOMETHING_ELSE）"
        )
    }

    func testUnknownCodelessErrorFallsBackToHTTPStatus() {
        XCTAssertEqual(message(nil, status: 502, serverMessage: "网关错误"), "网关错误（502）")
        XCTAssertEqual(message("", status: 502, serverMessage: "网关错误"), "网关错误（502）")
    }

    func testEmptyServerMessageNamesTheTransport() {
        XCTAssertEqual(message(nil, status: 500, serverMessage: "   ", transport: .udp), "UDP 音频连接失败（500）")
        XCTAssertEqual(message(nil, status: 500, serverMessage: "", transport: .tls), "TLS 音频连接失败（500）")
    }

    func testServerErrorsAreMappedThroughTheErrorEntryPoint() {
        let error = APIError.server(503, "Gateway is offline", "GATEWAY_OFFLINE")
        XCTAssertEqual(
            MediaFailureMessagePolicy.message(for: error, transport: .udp),
            "网关当前不在线（心跳超时），请稍后重试"
        )
    }

    func testIceFailuresNameTheTransportThatFailed() {
        XCTAssertEqual(
            MediaFailureMessagePolicy.message(for: MediaSessionError.iceGatheringTimedOut(.udp), transport: .udp),
            "未取得 UDP 中继候选，请检查网络或代理设置"
        )
        XCTAssertEqual(
            MediaFailureMessagePolicy.message(for: MediaSessionError.noRelayCandidate(.tls), transport: .tls),
            "未取得 TLS 中继候选，请检查网络或代理设置"
        )
        XCTAssertEqual(
            MediaFailureMessagePolicy.message(for: MediaSessionError.iceConnectTimedOut(.tls), transport: .tls),
            "TLS 中继已取得候选但未能连通，请重试音频"
        )
        XCTAssertEqual(
            MediaFailureMessagePolicy.message(for: MediaSessionError.iceConnectionFailed(.udp), transport: .udp),
            "UDP 音频中继连接失败"
        )
    }

    /// A TLS attempt must never be told to "可尝试 TLS".
    func testTimeoutMessageNeverSuggestsRetryingTheTransportThatJustFailed() {
        let message = MediaFailureMessagePolicy.message(for: MediaSessionError.iceGatheringTimedOut(.tls), transport: .tls)
        XCTAssertFalse(message.contains("可尝试 TLS"))
        XCTAssertTrue(message.contains("TLS"))
    }

    func testMicrophoneAndContractErrorsKeepTheirOwnText() {
        XCTAssertEqual(
            MediaFailureMessagePolicy.message(for: MediaSessionError.microphonePermissionDenied, transport: .udp),
            MediaSessionError.microphonePermissionDenied.errorDescription
        )
        XCTAssertEqual(
            MediaFailureMessagePolicy.message(for: MediaSessionError.invalidRelayOptions, transport: .udp),
            "服务器返回的中继配置无效"
        )
    }
}
