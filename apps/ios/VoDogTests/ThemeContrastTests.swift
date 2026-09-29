import SwiftUI
import UIKit
import XCTest
@testable import VoDog

final class ThemeContrastTests: XCTestCase {
    func testSemanticPairsMeetContrastInLightAndDark() {
        for style: UIUserInterfaceStyle in [.light, .dark] {
            let trait = UITraitCollection(userInterfaceStyle: style)
            let pairs: [(UIColor, UIColor, String)] = [
                (
                    UIColor(Color.callerAccent).resolvedColor(with: trait),
                    UIColor(Color.callerOnAccent).resolvedColor(with: trait),
                    "accent/onAccent"
                ),
                (
                    UIColor.systemGroupedBackground.resolvedColor(with: trait),
                    UIColor.label.resolvedColor(with: trait),
                    "grouped/label"
                ),
                (
                    UIColor.secondarySystemGroupedBackground.resolvedColor(with: trait),
                    UIColor.label.resolvedColor(with: trait),
                    "surface/label"
                ),
                (
                    UIColor.systemGroupedBackground.resolvedColor(with: trait),
                    UIColor(Color.callerDanger).resolvedColor(with: trait),
                    "grouped/danger"
                ),
            ] + (0..<SIMPalette.light.count).map { index in
                (SIMPalette.uiColor(hex: SIMPalette.hex(index: index, dark: style == .dark)),
                 UIColor(SIMPalette.onColor).resolvedColor(with: trait), "simPalette[\(index)]/onColor")
            }
            for (background, foreground, name) in pairs {
                let contrast = ThemeContrast.ratio(background, foreground)
                XCTAssertGreaterThanOrEqual(
                    contrast, 4.5,
                    "\(name) contrast \(contrast) in \(style == .dark ? "dark" : "light")"
                )
            }
        }
    }

    func testCallerBackgroundIsSystemGroupedNotLockedPale() {
        let light = UIColor(Color.callerBackground)
            .resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        let dark = UIColor(Color.callerBackground)
            .resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        XCTAssertNotEqual(light, dark)
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        light.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        XCTAssertFalse(abs(red - 245 / 255) < 0.01 && abs(green - 247 / 255) < 0.01 && abs(blue - 251 / 255) < 0.01)
    }
}
