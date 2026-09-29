import Foundation

/// S18 decision 7: the list used to show a bare creation date and "singleDevice/multiDevice", so two passkeys were
/// indistinguishable. The server now returns a label, an AAGUID-derived display name, the client platform, the
/// authenticator attachment and the last use, and the row is built from those.
extension PasskeyItem {
    /// The user's own label wins over the vendor name, which wins over the raw device type.
    var resolvedName: String {
        if let label = Self.trimmed(label) { return label }
        if let displayName = Self.trimmed(displayName) { return displayName }
        return deviceTypeTitle
    }

    var platformSummary: String {
        var parts: [String] = []
        switch authenticatorAttachment {
        case "platform": parts.append("本机")
        case "cross-platform": parts.append("跨设备")
        default: break
        }
        if backedUp == true { parts.append("已同步") }
        if let platform = Self.trimmed(clientPlatform) { parts.append(platform) }
        return parts.isEmpty ? deviceTypeTitle : parts.joined(separator: " · ")
    }

    /// An app passkey reads as the phone even though iCloud Keychain also syncs it, so the platform check comes first.
    var symbolName: String {
        if authenticatorAttachment == "platform" { return "iphone" }
        if let platform = Self.trimmed(clientPlatform) {
            if platform.localizedCaseInsensitiveContains("iOS App") || platform.localizedCaseInsensitiveContains("Android App") {
                return "iphone"
            }
            if PasskeyDisplayPolicy.desktopPlatformHints.contains(where: platform.localizedCaseInsensitiveContains) {
                return "laptopcomputer"
            }
        }
        if backedUp == true { return "key.icloud" }
        return "key"
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum PasskeyDisplayPolicy {
    static let desktopPlatformHints = ["macOS", "Windows", "Linux", "Chrome", "Edge", "Firefox", "Safari"]
    static let labelLimit = 64

    /// `PATCH /passkeys/:id` accepts 1–64 characters; the trimmed value is what is sent and shown.
    static func normalizedLabel(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= labelLimit else { return nil }
        return trimmed
    }

    static let labelValidationMessage = "名称需为 1–64 个字符"
}
