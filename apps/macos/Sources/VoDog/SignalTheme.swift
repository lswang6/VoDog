import AppKit
import SwiftUI

/// Signal semantic tokens (light / dark). Light mode is a tinted ground, never large pure white.
enum Signal {
    static let bg = color(0xEEEFF3, 0x0B0E13)
    static let chrome = color(0xF6F6F9, 0x141920)
    static let surface = color(0xFBFBFD, 0x141920)
    static let surface2 = color(0xECEDF1, 0x1B2129)
    static let surface3 = color(0xE1E3E9, 0x252C36)
    static let line = color(0xE2E4EA, 0x28303B)
    static let ink = color(0x111827, 0xEDF0F5)
    static let ink2 = color(0x424B59, 0xBAC2CE)
    static let ink3 = color(0x667080, 0x8F99A7)
    static let brand = color(0x1F5FD1, 0x7AA7FF)
    static let onBrand = color(0xFFFFFF, 0x0B1730)
    static let brandSoft = color(0xE9F0FD, 0x1A2945)
    static let bubbleOut = color(0x1F5FD1, 0x2F64D6)
    static let call = color(0x17824B, 0x3DCC85)
    static let callFill = color(0x1E8A50, 0x1E8A50)
    static let callSoft = color(0xE4F4EA, 0x11301F)
    static let danger = color(0xC2302B, 0xFF7A73)
    static let dangerFill = color(0xD33A35, 0xD33A35)
    static let dangerSoft = color(0xFCECEB, 0x3A1B1B)
    static let warn = color(0x9A5800, 0xF4BA4E)
    static let warnSoft = color(0xFFF4DE, 0x38290D)
    static let ai = color(0x6941C6, 0xB9A2FF)
    static let aiSoft = color(0xF2EDFD, 0x261F42)

    enum Radius {
        static let tag: CGFloat = 6
        static let control: CGFloat = 8
        static let card: CGFloat = 16
        static let bubble: CGFloat = 18
        static let bubbleTail: CGFloat = 6
    }

    private static func color(_ light: UInt32, _ dark: UInt32) -> Color {
        func components(_ value: UInt32) -> NSColor {
            NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                    blue: CGFloat(value & 0xFF) / 255, alpha: 1)
        }
        let lightColor = components(light), darkColor = components(dark)
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? darkColor : lightColor
        })
    }
}

// MARK: - Selected-row awareness

private struct SignalRowSelectedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True inside a list row drawn with the brand-solid selection (`communicationSelectionHighlight`).
    var signalRowSelected: Bool {
        get { self[SignalRowSelectedKey.self] }
        set { self[SignalRowSelectedKey.self] = newValue }
    }
}

private struct SelectionTintModifier: ViewModifier {
    @Environment(\.signalRowSelected) private var selected
    let style: AnyShapeStyle

    func body(content: Content) -> some View {
        content.foregroundStyle(selected ? AnyShapeStyle(Signal.onBrand) : style)
    }
}

private struct SelectionBackgroundModifier<S: Shape>: ViewModifier {
    @Environment(\.signalRowSelected) private var selected
    let color: Color
    let opacity: Double
    let shape: S

    func body(content: Content) -> some View {
        content.background((selected ? Signal.onBrand : color).opacity(selected ? min(opacity * 2, 0.25) : opacity),
                           in: shape)
    }
}

extension View {
    /// Fixed colour that turns onBrand on a brand-solid selected row (also fills bare shapes such as `Circle()`).
    func selectionTint<S: ShapeStyle>(_ style: S) -> some View {
        modifier(SelectionTintModifier(style: AnyShapeStyle(style)))
    }

    /// Tinted backdrop that stays visible on a brand-solid selected row.
    func selectionBackground<S: Shape>(_ color: Color, opacity: Double, in shape: S) -> some View {
        modifier(SelectionBackgroundModifier(color: color, opacity: opacity, shape: shape))
    }
}

/// Line status is carried by shape, never colour alone: ● online, ○ offline, ◐ pending.
enum LineStatus {
    case online, offline, pending
}

struct LineStatusShape: View {
    @Environment(\.signalRowSelected) private var rowSelected
    let status: LineStatus
    var size: CGFloat = 7

    var body: some View {
        Group {
            switch status {
            case .online: Circle().fill(rowSelected ? Signal.onBrand : Signal.call)
            case .offline: Circle().strokeBorder(rowSelected ? Signal.onBrand : Signal.ink3, lineWidth: 1.5)
            case .pending:
                Circle().strokeBorder(rowSelected ? Signal.onBrand : Signal.warn, lineWidth: 1.5)
                    .background(Circle().trim(from: 0.25, to: 0.75).fill(rowSelected ? Signal.onBrand : Signal.warn))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The line colour as a small rounded square (not a dot).
struct LineBlock: View {
    @Environment(\.signalRowSelected) private var rowSelected
    let color: Color
    var size: CGFloat = 9

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(color)
            .overlay {  // keep the line colour, ring it so it reads on brand blue
                if rowSelected {
                    RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                        .strokeBorder(Signal.onBrand, lineWidth: 1)
                }
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Four rising bars; filled bars use `tint`, the rest `surface3`.
struct SignalBars: View {
    @Environment(\.signalRowSelected) private var rowSelected
    let bars: Int
    var tint: Color = Signal.call
    var barWidth: CGFloat = 3
    var height: CGFloat = 12

    var body: some View {
        HStack(alignment: .bottom, spacing: barWidth * 0.66) {
            ForEach(0 ..< 4, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(index < min(max(bars, 0), 4) ? (rowSelected ? Signal.onBrand : tint)
                          : (rowSelected ? Signal.onBrand.opacity(0.3) : Signal.surface3))
                    .frame(width: barWidth, height: height * CGFloat(index + 1) / 4 + 1)
            }
        }
        .frame(height: height + 1, alignment: .bottom)
        .accessibilityHidden(true)
    }
}

/// 「复制验证码 NNNNNN」: copy only; detection happens in the caller.
struct CopyCodeButton: View {
    let code: String
    @State private var copied = false

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(code, forType: .string)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                Text(copied ? L10n.tr("验证码已复制") : L10n.tr("复制验证码"))
                if !copied { Text(verbatim: code).monospacedDigit() }
            }
            .font(.callout.weight(.semibold))
            .foregroundStyle(Signal.brand)
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
            .background(Signal.brandSoft, in: RoundedRectangle(cornerRadius: Signal.Radius.control, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Signal.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.tr("验证码 %@，点击复制", code))
    }
}

extension View {
    /// Card: soft surface, 1px line, radius 16.
    func signalCard(cornerRadius: CGFloat = Signal.Radius.card, padding: CGFloat = 13) -> some View {
        self.padding(padding)
            .background(Signal.surface, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Signal.line, lineWidth: 1)
            }
    }

    /// SMS bubble: received `surface3`/ink, sent `bubbleOut`/white; radius 18 with a 6pt tail corner.
    func signalBubble(outgoing: Bool) -> some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: Signal.Radius.bubble,
            bottomLeadingRadius: outgoing ? Signal.Radius.bubble : Signal.Radius.bubbleTail,
            bottomTrailingRadius: outgoing ? Signal.Radius.bubbleTail : Signal.Radius.bubble,
            topTrailingRadius: Signal.Radius.bubble,
            style: .continuous
        )
        return self.padding(.horizontal, 13)
            .padding(.vertical, 8)
            .foregroundStyle(outgoing ? Color.white : Signal.ink)
            .background(outgoing ? Signal.bubbleOut : Signal.surface3, in: shape)
    }

    /// 52pt column toolbar with a bottom hairline.
    func signalToolbar() -> some View {
        self.padding(.horizontal, 14)
            .frame(minHeight: 52)
            .overlay(alignment: .bottom) { Rectangle().fill(Signal.line).frame(height: 1) }
    }
}

// MARK: - Line identity for a local module (presentation only)

@MainActor
extension AppState {
    /// The gateway runtime driving this module, if it is paired as a gateway.
    func gatewayRuntime(for moduleID: CellularModuleID?) -> GatewayRuntime? {
        guard let moduleID else { return nil }
        return gateway.runtimes.first { gatewayModuleState(imei: $0.imei)?.id == moduleID }
    }

    /// The account SIM this module serves (signed in and paired only).
    func accountSIM(for moduleID: CellularModuleID?) -> VoDogSIM? {
        guard let simID = gatewayRuntime(for: moduleID)?.sim?.id else { return nil }
        return voDog.sims.first { $0.id == simID }
    }

    /// S57 palette: the account SIM's rank when known, else the module's position on this Mac.
    func lineColor(for moduleID: CellularModuleID?) -> Color {
        if let sim = accountSIM(for: moduleID) {
            return .voDogSIM(rank: VoDogPhonePolicy.colorRank(of: sim.id, in: voDog.sims))
        }
        return .voDogSIM(rank: cellularModules.firstIndex { $0.id == moduleID } ?? 0)
    }

    /// The line's name (account SIM label, else the gateway binding label), if any.
    func lineName(for moduleID: CellularModuleID?) -> String? {
        let name = accountSIM(for: moduleID)?.displayName ?? gatewayRuntime(for: moduleID)?.sim?.label
        return name?.isEmpty == false ? name : nil
    }
}

// MARK: - AI answer badge

/// `✦ AI` pill for a line whose answer mode is AI; nothing for `normal` or unknown settings.
/// Compact = `AI` (chips, popups, headers); full = `AI 代接` / `AI · N 秒后` (SIM cards, settings rows).
struct AiBadge: View {
    let settings: VoDogSIMSettings?
    var full = false

    var body: some View {
        if let text = Self.text(settings, full: full) {
            HStack(spacing: 3) {
                Text(verbatim: "✦")
                Text(verbatim: text)
            }
            .font(.system(size: 11, weight: .semibold).monospacedDigit())
            .tracking(0.22)
            .foregroundStyle(Signal.ai)  // never inverted on selected rows
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(height: 16)
            .background(Signal.aiSoft, in: Capsule())
            .fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.accessibilityText(settings) ?? text)
        }
    }

    private static func mode(_ settings: VoDogSIMSettings?) -> VoDogReceptionMode? {
        guard let mode = settings.flatMap({ VoDogReceptionMode(rawValue: $0.mode) }), mode != .normal else { return nil }
        return mode
    }

    static func text(_ settings: VoDogSIMSettings?, full: Bool = false) -> String? {
        guard let mode = mode(settings), let settings else { return nil }
        guard full else { return "AI" }
        if mode == .ai { return L10n.tr("AI 代接") }
        return settings.timeoutSeconds > 0 ? L10n.tr("AI · %lld 秒后", Int64(settings.timeoutSeconds)) : L10n.tr("AI 兜底")
    }

    /// Plain-text form for NSMenu items, which cannot host the pill.
    static func menuSuffix(_ settings: VoDogSIMSettings?) -> String? {
        text(settings).map { "✦ \($0)" }
    }

    static func accessibilityText(_ settings: VoDogSIMSettings?) -> String? {
        guard let mode = mode(settings), let settings else { return nil }
        if mode == .ai { return L10n.tr("AI 代接已开启，立即由 AI 接听") }
        return settings.timeoutSeconds > 0
            ? L10n.tr("AI 代接已开启，响铃 %lld 秒无人接听后由 AI 接听", Int64(settings.timeoutSeconds))
            : L10n.tr("AI 代接已开启，响铃无人接听后由 AI 接听")
    }
}
