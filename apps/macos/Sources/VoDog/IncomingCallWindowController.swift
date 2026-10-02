import AppKit
import SwiftUI

private final class CallIslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private final class CallIslandHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
private final class CallIslandPresentation: ObservableObject {
    @Published var isExpanded = false
}

@MainActor
final class CallIslandWindowController: NSObject, NSWindowDelegate {
    static let shared = CallIslandWindowController()

    private weak var appState: AppState?
    private var onOpenFullCall: (() -> Void)?
    private let presentation = CallIslandPresentation()
    private var panel: CallIslandPanel?
    private var isAdjustingFrame = false

    // v2 intentionally resets the original implementation's remembered
    // position so existing users receive the new upper-right default once.
    private static let storedOriginKey = "CallIslandWindowOrigin.v2"

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersDidChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    var isVisible: Bool { panel?.isVisible == true }

    func configure(appState: AppState, onOpenFullCall: @escaping () -> Void) {
        self.appState = appState
        self.onOpenFullCall = onOpenFullCall
    }

    func updateVisibility(shouldShow: Bool) {
        guard let appState else { return }
        guard shouldShow, appState.call.hasCall else {
            dismiss()
            return
        }

        if appState.call.phase != .active, presentation.isExpanded {
            presentation.isExpanded = false
        }
        ensurePanel(appState: appState)
        updatePanelSize(animated: panel?.isVisible == true)
        panel?.orderFrontRegardless()
    }

    func dismiss() {
        presentation.isExpanded = false
        panel?.orderOut(nil)
    }

    private func ensurePanel(appState: AppState) {
        guard panel == nil else { return }

        let rootView = CallIslandView(
            appState: appState,
            presentation: presentation,
            onOpenFullCall: { [weak self] in self?.onOpenFullCall?() },
            onLayoutChange: { [weak self] in self?.updatePanelSize(animated: true) }
        )
        .cellDockLanguageEnvironment()

        let size = CallIslandView.contentSize(
            for: appState.call.phase,
            isExpanded: presentation.isExpanded,
            showsAITimeout: CallIslandView.aiTimeoutSeconds(appState) != nil
        )
        let hostingView = CallIslandHostingView(rootView: rootView)
        hostingView.frame = NSRect(origin: .zero, size: size)
        hostingView.autoresizingMask = [.width, .height]

        let panel = CallIslandPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .ignoresCycle
        ]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.animationBehavior = .utilityWindow
        panel.isMovable = true
        panel.isMovableByWindowBackground = true
        panel.delegate = self
        panel.contentView = hostingView
        self.panel = panel
        restoreOrPosition(panel)
    }

    private func updatePanelSize(animated: Bool) {
        guard let appState, let panel else { return }
        let targetSize = CallIslandView.contentSize(
            for: appState.call.phase,
            isExpanded: presentation.isExpanded,
            showsAITimeout: CallIslandView.aiTimeoutSeconds(appState) != nil
        )
        guard panel.frame.size != targetSize else { return }

        let oldFrame = panel.frame
        let targetFrame = constrainedFrame(NSRect(
            x: oldFrame.maxX - targetSize.width,
            y: oldFrame.maxY - targetSize.height,
            width: targetSize.width,
            height: targetSize.height
        ))
        isAdjustingFrame = true
        panel.setFrame(targetFrame, display: true, animate: animated)
        isAdjustingFrame = false
    }

    private func restoreOrPosition(_ panel: NSPanel) {
        if let stored = UserDefaults.standard.string(forKey: Self.storedOriginKey) {
            var frame = panel.frame
            frame.origin = NSPointFromString(stored)
            panel.setFrame(constrainedFrame(frame), display: false)
            return
        }
        guard let visibleFrame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else {
            panel.center()
            return
        }
        panel.setFrameOrigin(NSPoint(
            x: visibleFrame.maxX - panel.frame.width - 22,
            y: visibleFrame.maxY - panel.frame.height - 22
        ))
    }

    private func constrainedFrame(_ frame: NSRect) -> NSRect {
        let screen = NSScreen.screens.first(where: { $0.frame.intersects(frame) }) ??
            NSScreen.main ?? NSScreen.screens.first
        guard let visibleFrame = screen?.visibleFrame else { return frame }
        var result = frame
        result.origin.x = min(
            visibleFrame.maxX - result.width,
            max(visibleFrame.minX, result.origin.x)
        )
        result.origin.y = min(
            visibleFrame.maxY - result.height,
            max(visibleFrame.minY, result.origin.y)
        )
        return result
    }

    func windowDidMove(_ notification: Notification) {
        guard !isAdjustingFrame, let panel else { return }
        UserDefaults.standard.set(
            NSStringFromPoint(panel.frame.origin),
            forKey: Self.storedOriginKey
        )
    }

    @objc private func screenParametersDidChange() {
        guard let panel else { return }
        panel.setFrame(constrainedFrame(panel.frame), display: true)
    }
}

private struct CallIslandView: View {
    @ObservedObject var appState: AppState
    @ObservedObject var presentation: CallIslandPresentation
    @ObservedObject private var contacts = SystemContactStore.shared
    @ObservedObject private var recordings = CallRecordingStore.shared
    @AppStorage("CallRecordingConsentAcknowledged.v1") private var recordingConsent = false
    @State private var showingRecordingConsent = false
    /// Local timestamp of the moment this call started ringing here (AI countdown base only).
    @State private var ringStartedAt: Date?

    let onOpenFullCall: () -> Void
    let onLayoutChange: () -> Void

    static func contentSize(for phase: CallPhase, isExpanded: Bool, showsAITimeout: Bool) -> NSSize {
        switch phase {
        case .incoming:
            // Sized to content: the AI countdown strip adds a row; no transparent dead zone without it.
            return NSSize(width: 420, height: showsAITimeout ? 190 : 116)
        case .active where isExpanded:
            return NSSize(width: 430, height: 176)
        default:
            return NSSize(width: 350, height: 86)
        }
    }

    var body: some View {
        Group {
            switch appState.call.phase {
            case .incoming:
                incomingContent
            case .active where presentation.isExpanded:
                expandedActiveContent
            case .active:
                compactActiveContent
            case .dialing, .alerting, .ending, .recovering:
                compactProgressContent
            case .idle, .unavailable, .error:
                EmptyView()
            }
        }
        .frame(
            width: currentSize.width,
            height: currentSize.height
        )
        .animation(.spring(response: 0.32, dampingFraction: 0.82), value: presentation.isExpanded)
        .onChange(of: appState.call.phase) { _, phase in
            if phase != .active { presentation.isExpanded = false }
            ringStartedAt = phase == .incoming ? Date() : nil
            onLayoutChange()
        }
        .onAppear { if appState.call.phase == .incoming, ringStartedAt == nil { ringStartedAt = Date() } }
        .onChange(of: presentation.isExpanded) { _, _ in onLayoutChange() }
        .onChange(of: aiTimeoutSeconds) { _, _ in onLayoutChange() }
        .alert(L10n.tr("开始通话录音？"), isPresented: $showingRecordingConsent) {
            Button(L10n.tr("取消"), role: .cancel) {}
            Button(L10n.tr("同意并开始")) {
                recordingConsent = true
                appState.startCallRecording()
            }
        } message: {
            Text(CallRecordingStore.manualConsentText)
        }
    }

    private var incomingContent: some View {
        VStack(spacing: 14) {
            HStack(spacing: 14) {
                Button(action: onOpenFullCall) {
                    HStack(spacing: 14) {
                        Image(systemName: "person")
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle(Signal.ink2)
                            .frame(width: 52, height: 52)
                            .background(Signal.surface3, in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(L10n.tr("来电")) + Text(verbatim: " ·")
                                LineBlock(color: appState.lineColor(for: appState.call.moduleID), size: 8)
                                Text(verbatim: incomingLineName)
                                AiBadge(settings: (ringingSIM ?? appState.accountSIM(for: appState.call.moduleID))?.settings)
                            }
                            .font(.caption)
                            .foregroundStyle(Signal.ink3)
                            .lineLimit(1)
                            Text(verbatim: displayName)
                                .font(.system(size: 20, weight: .semibold).monospacedDigit())
                                .foregroundStyle(Signal.ink)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Text(verbatim: incomingSecondaryLine)
                                .font(.callout)
                                .foregroundStyle(Signal.ink3)
                                .lineLimit(1)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(L10n.tr("打开完整通话页面"))

                Spacer(minLength: 4)

                // Signed in, 接听 claims the call through VoDog (AppState.answerCall).
                if appState.gateway.handlesCalls(on: appState.call.moduleID), appState.voDog.user == nil {
                    Text(L10n.tr("请在 VoDog 客户端接听"))
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Signal.ink3)
                } else {
                    HStack(spacing: 10) {
                        incomingButton(title: L10n.tr("拒接"), systemImage: "phone.down.fill", fill: Signal.dangerFill,
                                       isEnabled: !appState.isChangingCall, action: appState.hangUp)
                        incomingButton(title: L10n.tr("接听"), systemImage: "phone.fill", fill: Signal.callFill,
                                       isEnabled: canAnswer, action: appState.answerCall)
                    }
                }
            }

            if let timeout = aiTimeoutSeconds, let ringStartedAt {
                TimelineView(.periodic(from: ringStartedAt, by: 1)) { context in
                    let elapsed = context.date.timeIntervalSince(ringStartedAt)
                    let remaining = max(0, Int((Double(timeout) - elapsed).rounded(.up)))
                    HStack(spacing: 10) {
                        Image(systemName: "sparkle")
                        Text(L10n.tr("无人接听，%lld 秒后由 AI 代接", Int64(remaining)))
                            .monospacedDigit()
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        ProgressView(value: min(1, max(0, elapsed / Double(timeout))))
                            .progressViewStyle(.linear)
                            .tint(Signal.ai)
                            .frame(width: 90)
                            .accessibilityHidden(true)
                    }
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Signal.ai)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Signal.aiSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .top)
        .background(Signal.chrome, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Signal.line, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
        .padding(10)
    }

    private func incomingButton(
        title: String,
        systemImage: String,
        fill: Color,
        isEnabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 48, height: 48)
                .background(fill, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.46)
        .help(title)
        .accessibilityLabel(title)
    }

    /// The account SIM this ring belongs to (gateway ring), else the module's line name / module name.
    private var ringingSIM: VoDogSIM? {
        guard let simID = appState.gateway.ringingCall(on: appState.call.moduleID)?.simId else { return nil }
        return appState.voDog.sims.first { $0.id == simID }
    }

    private var incomingLineName: String {
        if let sim = ringingSIM { return sim.displayName }
        let moduleID = appState.call.moduleID
        return appState.lineName(for: moduleID)
            ?? appState.cellularModules.first { $0.id == moduleID }?.localizedDisplayName
            ?? L10n.tr("蜂窝来电")
    }

    /// Number under a contact name, else 「不在通讯录」 (no location data exists).
    private var incomingSecondaryLine: String {
        contacts.displayName(for: callNumber) == nil ? L10n.tr("不在通讯录") : callNumber
    }

    private var currentSize: NSSize {
        Self.contentSize(for: appState.call.phase, isExpanded: presentation.isExpanded,
                         showsAITimeout: aiTimeoutSeconds != nil)
    }

    private var aiTimeoutSeconds: Int? { Self.aiTimeoutSeconds(appState) }

    /// Only while ringing, when the signed-in SIM's existing setting is 无人接听再交给 AI with a known timeout.
    @MainActor
    static func aiTimeoutSeconds(_ appState: AppState) -> Int? {
        guard appState.call.phase == .incoming,
              let simID = appState.gateway.ringingCall(on: appState.call.moduleID)?.simId,
              let settings = appState.voDog.sims.first(where: { $0.id == simID })?.settings,
              settings.mode == VoDogReceptionMode.timeoutAI.rawValue,
              settings.timeoutSeconds > 0 else { return nil }
        return settings.timeoutSeconds
    }

    private var compactActiveContent: some View {
        HStack(spacing: 10) {
            callerButton
            Spacer(minLength: 2)
            islandActionButton(
                title: appState.call.muted ? L10n.tr("取消静音") : L10n.tr("静音"),
                systemImage: appState.call.muted ? "mic.slash.fill" : "mic.fill",
                tint: .blue,
                isSelected: appState.call.muted
            ) {
                appState.setCallMuted(!appState.call.muted)
            }
            islandActionButton(
                title: L10n.tr("展开通话控制"),
                systemImage: "chevron.down",
                tint: .secondary
            ) {
                presentation.isExpanded = true
            }
            islandActionButton(
                title: L10n.tr("挂断"),
                systemImage: "phone.down.fill",
                tint: .red,
                isProminent: true,
                isEnabled: !appState.isChangingCall,
                action: appState.hangUp
            )
        }
        .padding(10)
        .callIslandSurface(cornerRadius: 32)
        .padding(6)
    }

    private var compactProgressContent: some View {
        HStack(spacing: 10) {
            callerButton
            Spacer(minLength: 4)
            if appState.isChangingCall || [.ending, .recovering].contains(appState.call.phase) {
                ProgressView().controlSize(.small)
            }
            islandActionButton(
                title: L10n.tr("挂断"),
                systemImage: "phone.down.fill",
                tint: .red,
                isProminent: true,
                isEnabled: !appState.isChangingCall || appState.call.phase == .recovering,
                action: appState.hangUp
            )
        }
        .padding(10)
        .callIslandSurface(cornerRadius: 32)
        .padding(6)
    }

    private var expandedActiveContent: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                callerButton
                Spacer()
                islandActionButton(
                    title: L10n.tr("收起通话控制"),
                    systemImage: "chevron.up",
                    tint: .secondary
                ) {
                    presentation.isExpanded = false
                }
            }

            Divider().opacity(0.45)

            HStack(spacing: 20) {
                labeledIslandAction(
                    title: appState.call.muted ? L10n.tr("取消静音") : L10n.tr("静音"),
                    systemImage: appState.call.muted ? "mic.slash.fill" : "mic.fill",
                    tint: .blue,
                    isSelected: appState.call.muted
                ) {
                    appState.setCallMuted(!appState.call.muted)
                }
                labeledIslandAction(
                    title: L10n.tr("拨号盘"),
                    systemImage: "circle.grid.3x3.fill",
                    tint: .blue,
                    action: onOpenFullCall
                )
                labeledIslandAction(
                    title: recordings.isRecording ? L10n.tr("停止录音") : L10n.tr("录音"),
                    systemImage: recordings.isRecording ? "stop.circle.fill" : "record.circle",
                    tint: .red,
                    isSelected: recordings.isRecording,
                    isEnabled: canToggleRecording,
                    action: toggleRecording
                )
                labeledIslandAction(
                    title: L10n.tr("挂断"),
                    systemImage: "phone.down.fill",
                    tint: .red,
                    isProminent: true,
                    isEnabled: !appState.isChangingCall,
                    action: appState.hangUp
                )
            }
            .frame(maxWidth: .infinity)
        }
        .padding(14)
        .callIslandSurface(cornerRadius: 34)
        .padding(6)
    }

    @ViewBuilder
    private var callerButton: some View {
        if appState.call.phase == .active {
            callerIdentity
                .contentShape(Rectangle())
                .onTapGesture(count: 2, perform: onOpenFullCall)
                .help(L10n.tr("双击打开完整通话页面"))
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction(
                    named: Text(L10n.tr("打开完整通话页面")),
                    onOpenFullCall
                )
        } else {
            Button(action: onOpenFullCall) {
                callerIdentity
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(L10n.tr("打开完整通话页面"))
        }
    }

    private var callerIdentity: some View {
        HStack(spacing: 10) {
            callerAvatar
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(displayName)
                        .font(.headline.weight(.semibold))
                        .lineLimit(1)
                    if appState.call.phase == .active {
                        Circle().fill(.green).frame(width: 7, height: 7)
                    }
                }
                callDetail
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var callDetail: some View {
        switch appState.call.phase {
        case .active:
            if let startedAt = appState.call.startedAt {
                Text(startedAt, style: .timer)
            } else {
                Text(L10n.tr("通话中"))
            }
        case .incoming:
            Text(networkDetail.isEmpty
                ? L10n.tr("蜂窝来电")
                : L10n.tr("蜂窝来电") + " · " + networkDetail)
        case .alerting:
            Text(L10n.tr("对方正在响铃"))
        case .dialing:
            Text(L10n.tr("正在建立通话"))
        case .ending:
            Text(L10n.tr("正在结束通话"))
        case .recovering:
            Text(L10n.tr("正在核对通话状态…"))
        case .idle, .unavailable, .error:
            EmptyView()
        }
    }

    private var callerAvatar: some View {
        ZStack {
            Circle().fill(avatarTint.gradient)
            if contacts.displayName(for: callNumber) == nil {
                Image(systemName: appState.call.direction == .incoming
                    ? "phone.arrow.down.left.fill"
                    : "phone.arrow.up.right.fill")
                    .font(.system(size: 19, weight: .semibold))
            } else {
                Text(String(displayName.prefix(1)))
                    .font(.system(size: 21, weight: .semibold))
            }
        }
        .foregroundStyle(.white)
        .frame(width: 44, height: 44)
        .shadow(color: avatarTint.opacity(0.18), radius: 6, y: 2)
    }

    private func islandActionButton(
        title: String,
        systemImage: String,
        tint: Color,
        isProminent: Bool = false,
        isSelected: Bool = false,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        CircularLiquidCallButton(
            title: title,
            systemImage: systemImage,
            tint: tint,
            selected: isSelected,
            prominent: isProminent,
            isEnabled: isEnabled,
            diameter: 42,
            showsTitle: false,
            action: action
        )
    }

    private func labeledIslandAction(
        title: String,
        systemImage: String,
        tint: Color,
        isProminent: Bool = false,
        isSelected: Bool = false,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        CircularLiquidCallButton(
            title: title,
            systemImage: systemImage,
            tint: tint,
            selected: isSelected,
            prominent: isProminent,
            isEnabled: isEnabled,
            diameter: 46,
            showsTitle: true,
            action: action
        )
    }

    private var callNumber: String { appState.call.number ?? L10n.tr("未知号码") }

    private var displayName: String {
        CommunicationUI.displayText(contacts.displayName(for: callNumber), callNumber, fallback: L10n.tr("未知号码"))
    }

    private var networkDetail: String {
        let modem = appState.activeCallModemSnapshot
        return [
            modem.operatorName.map(CarrierNameFormatter.localized),
            modem.accessTechnology
        ]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }

    private var avatarTint: Color {
        appState.call.phase == .incoming ? .orange : .blue
    }

    private var canAnswer: Bool {
        appState.call.voiceOverUSBSupported &&
            !appState.isChangingCall
    }

    private var canToggleRecording: Bool {
        if recordings.isRecording { return true }
        return recordings.phase == .idle &&
            appState.call.phase == .active &&
            appState.call.audioActive
    }

    private func toggleRecording() {
        if recordings.isRecording {
            appState.stopCallRecording()
        } else if recordingConsent {
            appState.startCallRecording()
        } else {
            showingRecordingConsent = true
        }
    }
}

private struct CallIslandSurfaceModifier: ViewModifier {
    let cornerRadius: CGFloat

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(macOS 26.0, *) {
            // Clear Liquid Glass keeps the optical material for every call
            // phase without adding a separate alert-state rim.
            content.glassEffect(.clear.interactive(), in: shape)
        } else {
            content
                .background { shape.fill(.ultraThinMaterial) }
        }
    }
}

private extension View {
    func callIslandSurface(cornerRadius: CGFloat) -> some View {
        modifier(CallIslandSurfaceModifier(cornerRadius: cornerRadius))
    }
}
