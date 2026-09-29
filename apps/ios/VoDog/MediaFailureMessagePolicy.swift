import Foundation

/// Maps a media failure to the exact sentence the user sees.
///
/// Production logs showed every `media/options` 503 — `GATEWAY_OFFLINE`, `MEDIA_UNAVAILABLE` and
/// `MEDIA_NODE_UNAVAILABLE` alike — reported as "没有共同可用的媒体节点", which sent users hunting for a network
/// problem that did not exist. The message now follows the server's error code.
enum MediaFailureMessagePolicy {
    static func message(status: Int, code: String?, serverMessage: String, transport: MediaTransport) -> String {
        switch code {
        case "GATEWAY_OFFLINE": return "网关当前不在线（心跳超时），请稍后重试"
        case "MEDIA_UNAVAILABLE": return "网关媒体能力暂不可用，请稍后重试"
        case "MEDIA_NODE_UNAVAILABLE": return "当前网络与设备没有共同可用的媒体节点"
        case "MEDIA_BRIDGE_UNAVAILABLE": return "媒体节点未接受连接，请重试"
        case "MEDIA_REVOKED": return "通话已结束或媒体授权失效"
        case "MEDIA_PROBE_REQUIRED": return "网络测量尚未完成，请重试"
        case "MEDIA_NODE_MISMATCH": return "媒体节点不一致，请重新连接音频"
        case "MEDIA_NOT_WINNER": return "此通话已由其他设备接听"
        default:
            // The code is more actionable than the status when the server sent one; the status is the fallback.
            let detail = code?.isEmpty == false ? code! : String(status)
            let text = serverMessage.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? "\(transport.label) 音频连接失败（\(detail)）" : "\(text)（\(detail)）"
        }
    }

    static func message(for error: Error, transport: MediaTransport) -> String {
        if case let APIError.server(status, serverMessage, code) = error {
            return message(status: status, code: code, serverMessage: serverMessage, transport: transport)
        }
        return error.localizedDescription
    }
}
