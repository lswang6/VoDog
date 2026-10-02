import SwiftUI
import UIKit

/// Signal semantic tokens (S95). Light mode is a tinted ground, never large pure white.
private func signal(_ light: UInt32, _ dark: UInt32) -> Color {
    func color(_ value: UInt32) -> UIColor {
        UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }
    let lightColor = color(light), darkColor = color(dark)
    return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? darkColor : lightColor })
}

enum Signal {
    static let bg         = signal(0xEEEFF3, 0x0B0E13)
    static let chrome     = signal(0xF6F6F9, 0x141920)
    static let surface    = signal(0xFBFBFD, 0x141920)
    static let surface2   = signal(0xECEDF1, 0x1B2129)
    static let surface3   = signal(0xE1E3E9, 0x252C36)
    static let line       = signal(0xE2E4EA, 0x28303B)
    static let ink        = signal(0x111827, 0xEDF0F5)
    static let ink2       = signal(0x424B59, 0xBAC2CE)
    /// ≥4.5:1 only on `surface`.
    static let ink3       = signal(0x667080, 0x8F99A7)
    static let brand      = signal(0x1F5FD1, 0x7AA7FF)
    static let onBrand    = signal(0xFFFFFF, 0x0B1730)
    static let brandSoft  = signal(0xE9F0FD, 0x1A2945)
    static let bubbleOut  = signal(0x1F5FD1, 0x2F64D6)
    static let call       = signal(0x17824B, 0x3DCC85)
    static let callFill   = signal(0x1E8A50, 0x1E8A50)
    static let callSoft   = signal(0xE4F4EA, 0x11301F)
    static let danger     = signal(0xC2302B, 0xFF7A73)
    static let dangerFill = signal(0xD33A35, 0xD33A35)
    static let dangerSoft = signal(0xFCECEB, 0x3A1B1B)
    static let warn       = signal(0x9A5800, 0xF4BA4E)
    static let warnSoft   = signal(0xFFF4DE, 0x38290D)
    static let ai         = signal(0x6941C6, 0xB9A2FF)
    static let aiSoft     = signal(0xF2EDFD, 0x261F42)

    enum Radius { static let tag: CGFloat = 6, control: CGFloat = 12, card: CGFloat = 16, panel: CGFloat = 22 }
}

/// Legacy names, kept as aliases of the Signal tokens.
extension Color {
    static let callerAccent = Signal.brand
    static let callerOnAccent = Signal.onBrand
    static let callerDanger = Signal.danger
    static let callerBackground = Signal.bg
    static let callerText = Signal.ink
}

extension View {
    /// Signal grouped list: tinted page ground, `surface` rows.
    func signalList() -> some View {
        scrollContentBackground(.hidden).background(Signal.bg)
    }
}

/// S57 配色：每张 SIM 不同色。颜色序号 = 在账号列表按 (slotIndex, id) 升序的名次，与展示顺序、在线与否无关。
enum SIMPalette {
    static let light = ["#2457C5", "#147D78", "#B45309", "#7C3AED", "#BE185D", "#4338CA", "#8A5A2B", "#0E7490"]
    static let dark = ["#66A8FF", "#63D3CC", "#FDBA74", "#C4B5FD", "#F9A8D4", "#A5B4FC", "#E0B48A", "#67E8F9"]

    static func index(of sim: SIMChannel, in sims: [SIMChannel]) -> Int {
        let ranked = sims.sorted { ($0.slotIndex ?? .max, $0.id) < ($1.slotIndex ?? .max, $1.id) }
        return ranked.firstIndex { $0.id == sim.id } ?? 0
    }

    /// 序号 0–7 固定色；≥ 8 用黄金角色相（浅 hsl(h,65%,28%) / 深 hsl(h,80%,75%)）。
    static func hex(index: Int, dark: Bool) -> String {
        if index < light.count { return dark ? self.dark[index] : light[index] }
        let hue = (Double(index) * 137.508 + 20).truncatingRemainder(dividingBy: 360)
        let (s, l) = dark ? (0.8, 0.75) : (0.65, 0.28)
        let a = s * min(l, 1 - l)
        func channel(_ n: Double) -> Int {
            let k = (n + hue / 30).truncatingRemainder(dividingBy: 12)
            return Int((255 * (l - a * max(-1, min(k - 3, 9 - k, 1)))).rounded())
        }
        return String(format: "#%02X%02X%02X", channel(0), channel(8), channel(4))
    }

    static func uiColor(hex: String) -> UIColor {
        let value = Int(hex.dropFirst(), radix: 16) ?? 0
        return UIColor(red: CGFloat(value >> 16 & 0xFF) / 255, green: CGFloat(value >> 8 & 0xFF) / 255,
                       blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }

    static func color(for sim: SIMChannel, in sims: [SIMChannel]) -> Color {
        let index = index(of: sim, in: sims)
        return Color(uiColor: UIColor { uiColor(hex: hex(index: index, dark: $0.userInterfaceStyle == .dark)) })
    }

    static let onColor = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark ? uiColor(hex: "#0B1220") : .white
    })
}

enum CallerTheme {
    static func canvas(colorScheme: ColorScheme, reduceTransparency: Bool) -> some View {
        ZStack {
            Signal.bg
            if !reduceTransparency {
                LinearGradient(
                    colors: colorScheme == .dark
                        ? [Color(red: 26 / 255, green: 42 / 255, blue: 74 / 255).opacity(0.70), .clear]
                        : [Color(red: 217 / 255, green: 235 / 255, blue: 255 / 255).opacity(0.55), .clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
        }
        .ignoresSafeArea()
    }
}

enum ThemeContrast {
    static func ratio(_ first: UIColor, _ second: UIColor) -> Double {
        let firstLuminance = relativeLuminance(first)
        let secondLuminance = relativeLuminance(second)
        return (max(firstLuminance, secondLuminance) + 0.05) / (min(firstLuminance, secondLuminance) + 0.05)
    }

    static func relativeLuminance(_ color: UIColor) -> Double {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        func linear(_ channel: CGFloat) -> Double {
            let value = Double(channel)
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
}
