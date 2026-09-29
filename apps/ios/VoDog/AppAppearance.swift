import SwiftUI

/// Device-local presentation preference; independent of the signed-in account and network state.
enum AppAppearance: String, CaseIterable {
    case dark
    case light
    case system

    static let storageKey = "app.appearance"

    init(storedValue: String?) {
        self = storedValue.flatMap(Self.init(rawValue:)) ?? .dark
    }

    var label: String {
        switch self {
        case .dark: "深色"
        case .light: "浅色"
        case .system: "跟随系统"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .dark: .dark
        case .light: .light
        case .system: nil
        }
    }

    /// The caller supplies only the existing, strictly guarded S33 simulator override.
    func resolvedColorScheme(testOverride: ColorScheme?) -> ColorScheme? {
        testOverride ?? colorScheme
    }
}
