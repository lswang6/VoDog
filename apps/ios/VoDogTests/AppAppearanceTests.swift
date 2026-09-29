import SwiftUI
import XCTest
@testable import VoDog

final class AppAppearanceTests: XCTestCase {
    func testMissingOrInvalidPreferenceDefaultsToDark() {
        for value in [nil, "", "unknown"] as [String?] {
            XCTAssertEqual(AppAppearance(storedValue: value), .dark)
        }
    }

    func testAppearanceChoicesAndSystemInheritance() {
        XCTAssertEqual(AppAppearance.allCases.map(\.label), ["深色", "浅色", "跟随系统"])
        XCTAssertEqual(AppAppearance.dark.resolvedColorScheme(testOverride: nil), .dark)
        XCTAssertEqual(AppAppearance.light.resolvedColorScheme(testOverride: nil), .light)
        XCTAssertNil(AppAppearance.system.resolvedColorScheme(testOverride: nil))
    }

    func testGuardedTestOverrideTakesPrecedenceOverEveryPreference() {
        for appearance in AppAppearance.allCases {
            XCTAssertEqual(appearance.resolvedColorScheme(testOverride: .light), .light)
            XCTAssertEqual(appearance.resolvedColorScheme(testOverride: .dark), .dark)
        }
    }

    @MainActor
    func testLocalPreferencePersistsAcrossStorageInstances() throws {
        let suiteName = "AppAppearanceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let preference = AppStorage(wrappedValue: AppAppearance.dark.rawValue,
                                    AppAppearance.storageKey, store: defaults)
        XCTAssertEqual(AppAppearance(storedValue: preference.wrappedValue), .dark)

        for appearance in AppAppearance.allCases {
            preference.wrappedValue = appearance.rawValue
            let reloadedDefaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
            let reloaded = AppStorage(wrappedValue: AppAppearance.dark.rawValue,
                                      AppAppearance.storageKey, store: reloadedDefaults)
            XCTAssertEqual(AppAppearance(storedValue: reloaded.wrappedValue), appearance)
        }
    }
}
