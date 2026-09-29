import SwiftUI
import UIKit

extension Color {
    static let callerAccent = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 102 / 255, green: 168 / 255, blue: 255 / 255, alpha: 1)
            : UIColor(red: 36 / 255, green: 87 / 255, blue: 197 / 255, alpha: 1)
    })
    static let callerOnAccent = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 7 / 255, green: 30 / 255, blue: 65 / 255, alpha: 1)
            : UIColor.white
    })
    /// S21 user item 4: the end-call buttons read as pink in dark mode because the danger colour was a tinted
    /// rose rather than a red. Both sides are now the system red pair (#D70015 / #FF453A), which keeps the
    /// 4.5:1 contrast the theme tests assert while making 结束通话 unmistakably red.
    static let callerDanger = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 255 / 255, green: 69 / 255, blue: 58 / 255, alpha: 1)
            : UIColor(red: 215 / 255, green: 0 / 255, blue: 21 / 255, alpha: 1)
    })
    static let callerBackground = Color(uiColor: .systemGroupedBackground)
    static let callerText = Color.primary
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
            Color(uiColor: .systemGroupedBackground)
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
