import SwiftUI
import UIKit
import XCTest
@testable import VoDog

final class ThemeContrastTests: XCTestCase {
    private func resolved(_ color: Color, _ style: UIUserInterfaceStyle) -> UIColor {
        UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
    }

    private func assertContrast(_ pairs: [(Color, Color, String)], atLeast minimum: Double) {
        for style: UIUserInterfaceStyle in [.light, .dark] {
            for (background, foreground, name) in pairs {
                let contrast = ThemeContrast.ratio(resolved(background, style), resolved(foreground, style))
                XCTAssertGreaterThanOrEqual(
                    contrast, minimum, "\(name) contrast \(contrast) in \(style == .dark ? "dark" : "light")"
                )
            }
        }
    }

    /// Body text: 4.5:1 in light and dark. `ink3` is only used on `surface` (it is 4.36:1 on light `bg`).
    func testSignalTextPairsMeetContrastInLightAndDark() {
        assertContrast([
            (Signal.surface, Signal.ink, "surface/ink"),
            (Signal.surface, Signal.ink2, "surface/ink2"),
            (Signal.surface, Signal.ink3, "surface/ink3"),
            (Signal.bg, Signal.ink, "bg/ink"),
            (Signal.bg, Signal.ink2, "bg/ink2"),
            (Signal.surface2, Signal.ink, "surface2/ink"),
            (Signal.surface2, Signal.brand, "surface2/brand"),
            (Signal.surface3, Signal.ink, "surface3/ink"),
            (Signal.brand, Signal.onBrand, "brand/onBrand"),
            (Signal.brandSoft, Signal.brand, "brandSoft/brand"),
            (Signal.bg, Signal.danger, "bg/danger"),
            (Signal.surface, Signal.danger, "surface/danger"),
            (Signal.bg, Signal.warn, "bg/warn"),
            (Signal.warnSoft, Signal.warn, "warnSoft/warn"),
            (Signal.aiSoft, Signal.ai, "aiSoft/ai"),
            (Signal.bubbleOut, Color.white, "bubbleOut/white"),
            (Signal.dangerFill, Color.white, "dangerFill/white"),
            (Color.callerAccent, Color.callerOnAccent, "legacy accent/onAccent"),
            (Color.callerBackground, Color.callerDanger, "legacy background/danger"),
        ], atLeast: 4.5)
        for style: UIUserInterfaceStyle in [.light, .dark] {
            let trait = UITraitCollection(userInterfaceStyle: style)
            for index in 0..<SIMPalette.light.count {
                let contrast = ThemeContrast.ratio(
                    SIMPalette.uiColor(hex: SIMPalette.hex(index: index, dark: style == .dark)),
                    UIColor(SIMPalette.onColor).resolvedColor(with: trait)
                )
                XCTAssertGreaterThanOrEqual(contrast, 4.5, "simPalette[\(index)]/onColor \(contrast)")
            }
        }
    }

    /// Solid call / hang-up discs, the call bar and the 通话中 pill carry icons or bold ≥17 pt text: the WCAG
    /// large-text / graphics bar of 3:1 (white on `callFill` is 4.37:1).
    func testSignalLargeTextAndFillPairsMeetThreeToOne() {
        assertContrast([
            (Signal.callFill, Color.white, "callFill/white"),
            (Signal.callSoft, Signal.call, "callSoft/call"),
            (Signal.dangerSoft, Signal.danger, "dangerSoft/danger"),
        ], atLeast: 3)
    }

    func testBackgroundIsTintedNotPureWhiteOrLockedPale() {
        let light = resolved(Color.callerBackground, .light)
        let dark = resolved(Color.callerBackground, .dark)
        XCTAssertNotEqual(light, dark)
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        light.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        XCTAssertFalse(red > 0.99 && green > 0.99 && blue > 0.99, "light bg must not be pure white")
        XCTAssertFalse(abs(red - 245 / 255) < 0.01 && abs(green - 247 / 255) < 0.01 && abs(blue - 251 / 255) < 0.01)
        let surface = resolved(Signal.surface, .light)
        surface.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        XCTAssertFalse(red > 0.99 && green > 0.99 && blue > 0.99, "light surface must not be pure white")
    }
}
