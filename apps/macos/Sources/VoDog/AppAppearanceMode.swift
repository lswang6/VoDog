import AppKit
import Foundation

enum AppAppearanceMode: String, CaseIterable, Identifiable {
    static let defaultsKey = "VoDogAppearanceMode.v1"

    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return L10n.tr("跟随系统")
        case .light: return L10n.tr("浅色")
        case .dark: return L10n.tr("深色")
        }
    }

    var detail: String {
        switch self {
        case .system: return L10n.tr("根据 macOS 外观自动切换")
        case .light: return L10n.tr("始终使用浅色外观")
        case .dark: return L10n.tr("始终使用深色外观")
        }
    }

    static var storedPreference: AppAppearanceMode {
        guard let rawValue = UserDefaults.standard.string(forKey: defaultsKey),
              let mode = AppAppearanceMode(rawValue: rawValue) else {
            return .system
        }
        return mode
    }

    @MainActor
    func apply() {
        switch self {
        case .system:
            NSApp.appearance = nil
        case .light:
            NSApp.appearance = NSAppearance(named: .aqua)
        case .dark:
            NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }
}
