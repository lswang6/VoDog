import Foundation
import AppKit
import SwiftUI

enum CommunicationUI {
    static let navigationWidth: CGFloat = 220
    static let sidebarWidth: CGFloat = 300
    static let sidebarMinimumWidth: CGFloat = 210
    static let sidebarMaximumWidth: CGFloat = 420
    /// Rows sit ~16pt from the column edge (6 inset + 10 highlight padding), like the mockups.
    static let listRowInsets = EdgeInsets(top: 1, leading: 6, bottom: 1, trailing: 6)

    static func listTimestamp(_ date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        let timeFormatter = DateFormatter()
        timeFormatter.locale = AppLanguage.storedPreference.locale
        timeFormatter.timeStyle = .short
        let time = timeFormatter.string(from: date)
        if calendar.isDateInToday(date) { return time }
        if calendar.isDateInYesterday(date) { return L10n.tr("昨天") }
        let dateFormatter = DateFormatter()
        dateFormatter.locale = AppLanguage.storedPreference.locale
        dateFormatter.setLocalizedDateFormatFromTemplate("MMMd")
        return dateFormatter.string(from: date)
    }

    /// First non-blank value (e.g. contact name, then number), else `fallback`.
    static func displayText(_ values: String?..., fallback: String = L10n.tr("未知号码")) -> String {
        values.lazy.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? fallback
    }
}

struct ResizableCommunicationSplit<Sidebar: View, Detail: View>: View {
    @Binding var sidebarWidth: CGFloat
    @State private var dragStartWidth: CGFloat?
    @State private var liveSidebarWidth: CGFloat
    @State private var isDragging = false
    @State private var isDividerHovered = false
    private let sidebar: Sidebar
    private let detail: Detail

    init(
        sidebarWidth: Binding<CGFloat>,
        @ViewBuilder sidebar: () -> Sidebar,
        @ViewBuilder detail: () -> Detail
    ) {
        _sidebarWidth = sidebarWidth
        _liveSidebarWidth = State(initialValue: sidebarWidth.wrappedValue)
        self.sidebar = sidebar()
        self.detail = detail()
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: liveSidebarWidth)

            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .leading) {
                    Color.clear
                        .frame(width: 9)
                        .contentShape(Rectangle())
                        .onHover(perform: dividerHoverChanged)
                        .gesture(resizeGesture)
                }
        }
        .onChange(of: sidebarWidth) { _, newWidth in
            guard !isDragging else { return }
            liveSidebarWidth = clamped(newWidth)
        }
        .onDisappear {
            if isDividerHovered || isDragging {
                NSCursor.arrow.set()
            }
        }
    }

    private var resizeGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { value in
                let start = dragStartWidth ?? liveSidebarWidth
                if dragStartWidth == nil {
                    dragStartWidth = start
                    isDragging = true
                    NSCursor.resizeLeftRight.set()
                }
                var transaction = Transaction()
                transaction.animation = nil
                withTransaction(transaction) {
                    liveSidebarWidth = clamped(start + value.translation.width)
                }
            }
            .onEnded { _ in
                sidebarWidth = liveSidebarWidth
                dragStartWidth = nil
                isDragging = false
                (isDividerHovered ? NSCursor.resizeLeftRight : NSCursor.arrow).set()
            }
    }

    private func dividerHoverChanged(_ hovering: Bool) {
        isDividerHovered = hovering
        if hovering || isDragging {
            NSCursor.resizeLeftRight.set()
        } else {
            NSCursor.arrow.set()
        }
    }

    private func clamped(_ width: CGFloat) -> CGFloat {
        min(
            CommunicationUI.sidebarMaximumWidth,
            max(CommunicationUI.sidebarMinimumWidth, width)
        )
    }
}

private struct CommunicationSidebarMaterial: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let effectView = NSVisualEffectView()
        configure(effectView)
        return effectView
    }

    func updateNSView(_ effectView: NSVisualEffectView, context: Context) {
        configure(effectView)
    }

    private func configure(_ effectView: NSVisualEffectView) {
        effectView.material = .sidebar
        effectView.blendingMode = .behindWindow
        effectView.state = .active
        effectView.isEmphasized = false
    }
}

private struct CommunicationSearchFieldModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(Signal.surface2, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct CommunicationSidebarColumnModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.top, 10)
            .background { Signal.chrome.ignoresSafeArea(edges: .vertical) }
            .overlay(alignment: .trailing) {
                Rectangle().fill(Signal.line).frame(width: 1).ignoresSafeArea(edges: .vertical)
            }
    }
}

private struct CommunicationDetailColumnModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.background { Signal.chrome.ignoresSafeArea(.container, edges: .vertical) }
    }
}

private struct CommunicationInitialListFocusModifier: ViewModifier {
    let focus: FocusState<Bool>.Binding

    func body(content: Content) -> some View {
        content
            .focused(focus)
            .onAppear {
                focus.wrappedValue = true
            }
    }
}

extension View {
    /// Native macOS list selection: brand solid fill, onBrand text (secondary styles derive from it).
    func communicationSelectionHighlight(_ isSelected: Bool) -> some View {
        padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(isSelected ? AnyShapeStyle(Signal.onBrand) : AnyShapeStyle(.primary))
            .background(isSelected ? Signal.brand : Color.clear,
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .environment(\.signalRowSelected, isSelected)
            .listRowInsets(CommunicationUI.listRowInsets)
    }

    func communicationSidebarMaterial() -> some View {
        background {
            CommunicationSidebarMaterial()
                .ignoresSafeArea(edges: .vertical)
        }
    }

    func communicationSearchField() -> some View {
        modifier(CommunicationSearchFieldModifier())
    }

    func communicationSidebarColumnStyle() -> some View {
        modifier(CommunicationSidebarColumnModifier())
    }

    func communicationDetailColumnStyle() -> some View {
        modifier(CommunicationDetailColumnModifier())
    }

    /// Kept as the common hook for communication lists. Selection visuals are
    /// drawn by each row so macOS does not cover them with NSTableView styling.
    func communicationEmphasizedSelection() -> some View {
        self
    }

    func communicationInitialListFocus(
        _ focus: FocusState<Bool>.Binding
    ) -> some View {
        modifier(CommunicationInitialListFocusModifier(focus: focus))
    }

    @ViewBuilder
    func communicationSidebarScrollEdgeEffect() -> some View {
        if #available(macOS 26.0, *) {
            scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            self
        }
    }
}

struct CommunicationGlassTabs<Selection: Hashable>: View {
    let items: [(Selection, String)]
    @Binding var selection: Selection

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                let isSelected = selection == item.0
                Button {
                    withAnimation(.smooth(duration: 0.22)) {
                        selection = item.0
                    }
                } label: {
                    Text(L10n.tr(item.1))
                        .font(.callout.weight(isSelected ? .semibold : .regular))
                        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 5)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background {
                    if isSelected {
                        Capsule()
                            .fill(Color.accentColor.opacity(0.10))
                            .overlay {
                                Capsule()
                                    .strokeBorder(Color.white.opacity(0.48), lineWidth: 0.6)
                            }
                    }
                }
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(3)
        .adaptiveGlassSurface(
            cornerRadius: 14,
            padding: 0,
            treatment: .clear,
            isInteractive: true
        )
    }
}

/// Compact, icon-only action used by the communication list headers.
/// Its filled tint and capsule shape match the dialer's primary call action.
struct CommunicationIconActionButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var tint: Color = .accentColor
    var width: CGFloat = 44
    var height: CGFloat = 30
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
        }
        .buttonStyle(
            CommunicationIconActionButtonStyle(
                width: width,
                height: height,
                tint: tint
            )
        )
        .help(accessibilityLabel)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct CommunicationIconActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let width: CGFloat
    let height: CGFloat
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        let cornerRadius = height / 2
        let isPressed = configuration.isPressed && !reduceMotion

        configuration.label
            .foregroundStyle(.white)
            .frame(width: width, height: height)
            .contentShape(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .adaptiveGlassSurface(
                cornerRadius: cornerRadius,
                treatment: .regular,
                tint: tint.opacity(isEnabled ? 0.82 : 0.34),
                isInteractive: isEnabled
            )
            .scaleEffect(isPressed ? 0.96 : 1)
            .brightness(configuration.isPressed ? -0.04 : 0)
            .opacity(isEnabled ? 1 : 0.48)
            .animation(.easeOut(duration: 0.09), value: configuration.isPressed)
    }
}

struct CircularLiquidCallButton: View {
    let title: String
    let systemImage: String
    var tint: Color = .accentColor
    var selected = false
    var prominent = false
    var role: ButtonRole? = nil
    var isEnabled = true
    var diameter: CGFloat = 66
    var showsTitle = true
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            VStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: diameter * 0.32, weight: .semibold))
                    .foregroundStyle(
                        prominent ? Color.white : (selected ? tint : Color.primary)
                    )
                    .frame(width: diameter, height: diameter)
                    .background {
                        Circle()
                            .fill(semanticBaseFill)
                            .allowsHitTesting(false)
                    }
                    .adaptiveGlassSurface(
                        cornerRadius: diameter / 2,
                        treatment: prominent || selected ? .regular : .clear,
                        tint: controlTint,
                        isInteractive: isEnabled
                    )
                    .contentShape(Circle())

                if showsTitle {
                    Text(L10n.tr(title))
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
            }
        }
        .buttonStyle(CircularLiquidCallPressStyle())
        .disabled(!isEnabled)
        .help(title)
        .frame(minWidth: diameter)
        .opacity(isEnabled ? 1 : 0.46)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var controlTint: Color? {
        if prominent { return tint }
        if selected { return tint.opacity(0.18) }
        return nil
    }

    private var semanticBaseFill: Color {
        if prominent { return tint.opacity(0.68) }
        if selected { return tint.opacity(0.06) }
        return .clear
    }
}

private struct CircularLiquidCallPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.95 : 1)
            .brightness(configuration.isPressed ? -0.035 : 0)
            .animation(.easeOut(duration: 0.09), value: configuration.isPressed)
    }
}
