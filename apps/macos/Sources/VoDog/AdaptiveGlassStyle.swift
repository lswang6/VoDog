import SwiftUI

enum AdaptiveGlassTreatment {
    case regular
    case clear
}

enum AdaptiveGlassButtonKind {
    case regular
    case prominent
    case accented
}

struct AdaptiveGlassBackdrop: View {
    let treatment: AdaptiveGlassTreatment

    init(treatment: AdaptiveGlassTreatment = .regular) {
        self.treatment = treatment
    }

    @ViewBuilder
    var body: some View {
        if #available(macOS 26.0, *) {
            switch treatment {
            case .regular:
                Rectangle()
                    .fill(Color.clear)
                    .glassEffect(.regular, in: Rectangle())
                    .overlay {
                        backdropGradient(whiteOpacity: 0.10, accentOpacity: 0.035)
                    }
            case .clear:
                Rectangle()
                    .fill(Color.clear)
                    .glassEffect(.clear, in: Rectangle())
                    .overlay {
                        backdropGradient(whiteOpacity: 0.055, accentOpacity: 0.018)
                    }
            }
        } else {
            Rectangle()
                .fill(.ultraThinMaterial)
        }
    }

    private func backdropGradient(
        whiteOpacity: Double,
        accentOpacity: Double
    ) -> some View {
        LinearGradient(
            colors: [
                Color.white.opacity(whiteOpacity),
                Color.clear,
                Color.accentColor.opacity(accentOpacity)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .allowsHitTesting(false)
    }
}

struct AdaptiveGlassContainer<Content: View>: View {
    private let spacing: CGFloat?
    private let content: Content

    init(spacing: CGFloat? = nil, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    @ViewBuilder
    var body: some View {
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
    }
}

struct AdaptiveGlassToggleStyle: ToggleStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Button {
            withAnimation(.smooth(duration: 0.22)) {
                configuration.isOn.toggle()
            }
        } label: {
            HStack(spacing: 10) {
                configuration.label

                Spacer(minLength: 0)

                AdaptiveGlassToggleTrack(isOn: configuration.isOn)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.48)
        .accessibilityValue(configuration.isOn ? "开启" : "关闭")
    }
}

private struct AdaptiveGlassToggleTrack: View {
    @Environment(\.controlSize) private var controlSize

    let isOn: Bool

    var body: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            track

            Circle()
                .fill(Color.white.opacity(0.94))
                .overlay {
                    Circle()
                        .strokeBorder(Color.white.opacity(0.55), lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.18), radius: 2.5, y: 1)
                .padding(thumbInset)
        }
        .frame(width: trackSize.width, height: trackSize.height)
        .animation(.smooth(duration: 0.22), value: isOn)
        .accessibilityHidden(true)
    }

    private var trackSize: CGSize {
        switch controlSize {
        case .mini:
            return CGSize(width: 30, height: 17)
        case .small:
            return CGSize(width: 36, height: 20)
        default:
            return CGSize(width: 42, height: 24)
        }
    }

    private var thumbInset: CGFloat {
        controlSize == .mini ? 2 : 3
    }

    @ViewBuilder
    private var track: some View {
        let shape = Capsule()
        if #available(macOS 26.0, *) {
            shape
                .fill(Color.clear)
                .glassEffect(
                    .regular
                        .tint(isOn ? Color.accentColor : Color.secondary.opacity(0.12))
                        .interactive(),
                    in: shape
                )
        } else {
            shape
                .fill(isOn ? Color.accentColor : Color.secondary.opacity(0.18))
                .overlay {
                    shape.strokeBorder(Color.white.opacity(0.28), lineWidth: 0.5)
                }
        }
    }
}

extension ToggleStyle where Self == AdaptiveGlassToggleStyle {
    static var adaptiveGlass: AdaptiveGlassToggleStyle {
        AdaptiveGlassToggleStyle()
    }
}

private struct AdaptiveGlassSurfaceModifier: ViewModifier {
    let cornerRadius: CGFloat
    let padding: CGFloat
    let treatment: AdaptiveGlassTreatment
    let tint: Color?
    let isInteractive: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            glassSurface(content: content)
        } else {
            let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            content
                .padding(padding)
                .background {
                    ZStack {
                        switch treatment {
                        case .regular:
                            shape.fill(.regularMaterial)
                        case .clear:
                            shape.fill(.ultraThinMaterial)
                        }

                        if let tint {
                            shape.fill(tint)
                        }
                    }
                    .allowsHitTesting(false)
                }
                .overlay {
                    shape
                        .strokeBorder(Color.white.opacity(0.30), lineWidth: 0.5)
                        .allowsHitTesting(false)
                }
        }
    }

    @available(macOS 26.0, *)
    @ViewBuilder
    private func glassSurface(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        switch (treatment, tint) {
        case let (.regular, .some(tint)):
            content
                .padding(padding)
                .glassEffect(.regular.tint(tint).interactive(isInteractive), in: shape)
        case (.regular, .none):
            content
                .padding(padding)
                .glassEffect(.regular.interactive(isInteractive), in: shape)
        case let (.clear, .some(tint)):
            content
                .padding(padding)
                .glassEffect(.clear.tint(tint).interactive(isInteractive), in: shape)
        case (.clear, .none):
            content
                .padding(padding)
                .glassEffect(.clear.interactive(isInteractive), in: shape)
        }
    }
}

private struct AdaptiveConcentricGlassSurfaceModifier: ViewModifier {
    let minimumCornerRadius: CGFloat
    let padding: CGFloat
    let treatment: AdaptiveGlassTreatment
    let tint: Color?
    let isInteractive: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            glassSurface(content: content)
        } else {
            content.modifier(
                AdaptiveGlassSurfaceModifier(
                    cornerRadius: minimumCornerRadius,
                    padding: padding,
                    treatment: treatment,
                    tint: tint,
                    isInteractive: isInteractive
                )
            )
        }
    }

    @available(macOS 26.0, *)
    @ViewBuilder
    private func glassSurface(content: Content) -> some View {
        let shape = ConcentricRectangle(
            corners: .concentric(minimum: .fixed(minimumCornerRadius)),
            isUniform: true
        )
        switch (treatment, tint) {
        case let (.regular, .some(tint)):
            content
                .padding(padding)
                .glassEffect(.regular.tint(tint).interactive(isInteractive), in: shape)
        case (.regular, .none):
            content
                .padding(padding)
                .glassEffect(.regular.interactive(isInteractive), in: shape)
        case let (.clear, .some(tint)):
            content
                .padding(padding)
                .glassEffect(.clear.tint(tint).interactive(isInteractive), in: shape)
        case (.clear, .none):
            content
                .padding(padding)
                .glassEffect(.clear.interactive(isInteractive), in: shape)
        }
    }
}

private struct AdaptiveGlassButtonModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovered = false

    let kind: AdaptiveGlassButtonKind

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            switch kind {
            case .regular:
                content.buttonStyle(.glass)
            case .prominent:
                content.buttonStyle(.glassProminent)
            case .accented:
                content.buttonStyle(.glass(.regular.tint(Color.accentColor)))
            }
        } else {
            switch kind {
            case .regular:
                hoverFeedback(content.buttonStyle(.bordered))
            case .prominent, .accented:
                hoverFeedback(content.buttonStyle(.borderedProminent))
            }
        }
    }

    private func hoverFeedback<Content: View>(_ content: Content) -> some View {
        content
            .scaleEffect(isHovered && !reduceMotion ? 1.025 : 1)
            .brightness(isHovered ? 0.045 : 0)
            .shadow(
                color: Color.black.opacity(isHovered ? 0.16 : 0),
                radius: isHovered ? 8 : 0,
                y: isHovered ? 3 : 0
            )
            .animation(.easeOut(duration: 0.13), value: isHovered)
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

private struct AdaptiveTranslucentCardModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    let cornerRadius: CGFloat
    let padding: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .padding(padding)
            .background {
                shape.fill(
                    Color.white.opacity(colorScheme == .dark ? 0.055 : 0.12)
                )
            }
            .overlay {
                shape.strokeBorder(
                    Color.white.opacity(colorScheme == .dark ? 0.14 : 0.32),
                    lineWidth: 0.6
                )
            }
            .shadow(
                color: Color.black.opacity(colorScheme == .dark ? 0.10 : 0.035),
                radius: 9,
                y: 3
            )
    }
}

extension View {
    func adaptiveGlassSurface(
        cornerRadius: CGFloat,
        padding: CGFloat = 0,
        treatment: AdaptiveGlassTreatment = .regular,
        tint: Color? = nil,
        isInteractive: Bool = false
    ) -> some View {
        modifier(
            AdaptiveGlassSurfaceModifier(
                cornerRadius: cornerRadius,
                padding: padding,
                treatment: treatment,
                tint: tint,
                isInteractive: isInteractive
            )
        )
    }

    func adaptiveGlassCard(
        cornerRadius: CGFloat = 18,
        treatment: AdaptiveGlassTreatment = .regular
    ) -> some View {
        adaptiveGlassSurface(
            cornerRadius: cornerRadius,
            padding: 13,
            treatment: treatment
        )
    }

    func adaptiveConcentricGlassSurface(
        minimumCornerRadius: CGFloat,
        padding: CGFloat = 0,
        treatment: AdaptiveGlassTreatment = .regular,
        tint: Color? = nil,
        isInteractive: Bool = false
    ) -> some View {
        modifier(
            AdaptiveConcentricGlassSurfaceModifier(
                minimumCornerRadius: minimumCornerRadius,
                padding: padding,
                treatment: treatment,
                tint: tint,
                isInteractive: isInteractive
            )
        )
    }

    func adaptiveGlassButton(_ kind: AdaptiveGlassButtonKind = .regular) -> some View {
        modifier(AdaptiveGlassButtonModifier(kind: kind))
    }

    func adaptiveTranslucentCard(
        cornerRadius: CGFloat = 18,
        padding: CGFloat = 13
    ) -> some View {
        modifier(
            AdaptiveTranslucentCardModifier(
                cornerRadius: cornerRadius,
                padding: padding
            )
        )
    }
}
