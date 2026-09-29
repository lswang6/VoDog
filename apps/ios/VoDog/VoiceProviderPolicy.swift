import Foundation

/// S24 决策 3 设置页「AI 语音服务」分组的全部判断。iOS 是三端参考实现，Android 与 Web 逐项对齐这里的
/// 文案、状态语义与禁用逻辑。
///
/// 两个布尔位来自两个不同的来源：`configured` 是 Control 的环境变量（这台服务器允许哪些供应商），
/// `online` 是 Voice worker 心跳里宣告的 `providers`。缺配置永远压过离线——没配好的供应商即使有心跳
/// 也切不过去，所以状态文字先看 `configured`。
enum VoiceProviderPolicy {
    enum Availability: String, Sendable, Equatable {
        /// 已配置且有新鲜心跳：可以切换。
        case available
        /// Control 没把它列进 `AI_VOICE_PROVIDERS`。
        case notConfigured
        /// 配置齐全，但没有 worker 宣告这个供应商。
        case offline
    }

    /// 分组底部说明：切换只改之后新建的 AI run，进行中的通话不受影响。
    static let footerText = "切换只影响之后的 AI 即接 / 超时代接来电。"

    static func availability(_ item: VoiceProvider) -> Availability {
        if !item.configured { return .notConfigured }
        return item.online ? .available : .offline
    }

    static func statusTitle(_ item: VoiceProvider) -> String {
        switch availability(item) {
        case .available: "可用"
        case .notConfigured: "未配置"
        case .offline: "服务离线"
        }
    }

    static func statusSymbol(_ item: VoiceProvider) -> String {
        switch availability(item) {
        case .available: "checkmark.circle.fill"
        case .notConfigured: "slash.circle"
        case .offline: "bolt.horizontal.circle"
        }
    }

    /// `nil` 表示这一项可以点。否则就是不能点的原因，直接作为副标题显示——不能让用户点完才知道为什么失败。
    static func disabledReason(_ item: VoiceProvider) -> String? {
        switch availability(item) {
        case .available: nil
        case .notConfigured: "服务器未配置这个语音服务"
        case .offline: "语音服务当前离线，暂时无法切换"
        }
    }

    static func isSelectable(_ item: VoiceProvider) -> Bool { disabledReason(item) == nil }

    static func displayLabel(_ item: VoiceProvider) -> String {
        guard let label = item.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else {
            return item.id
        }
        return label
    }

    /// 当前项是否打勾。被选中的供应商可能同时是不可用的（worker 掉线），勾还是要显示：它仍然是服务器上的设置。
    static func isSelected(_ item: VoiceProvider, selected: String?) -> Bool {
        guard let selected, !selected.isEmpty else { return false }
        return selected == item.id
    }

    /// 是否值得发 PUT：不可用的不发，已经是当前选择的也不发（避免多一条审计记录）。
    static func shouldSubmit(_ item: VoiceProvider, selected: String?) -> Bool {
        isSelectable(item) && !isSelected(item, selected: selected)
    }

    /// 409 的兜底文案。服务器的 `message` 优先，这里只在 message 为空时用。
    static let codeMessages: [String: String] = [
        "PROVIDER_UNAVAILABLE": "这个语音服务当前不可用（未配置或服务离线），已保留原来的选择。",
    ]

    static func message(for error: Error) -> String {
        if case let APIError.server(_, message, code) = error {
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
            if let code, let text = codeMessages[code] { return text }
        }
        return error.localizedDescription
    }
}
