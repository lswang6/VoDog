import AppKit
import SwiftUI

private final class VoDogHeadlessSetupWindow: NSWindow {
    var onRequestClose: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           event.charactersIgnoringModifiers?.lowercased() == "w" {
            onRequestClose?()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

@MainActor
final class InitialSetupWindowController: NSObject, NSWindowDelegate {
    static let shared = InitialSetupWindowController()

    private weak var appState: AppState?
    private var window: NSWindow?
    private var dismissalGeneration = 0

    var isVisible: Bool {
        window?.isVisible == true
    }

    private override init() {
        super.init()
    }

    func configure(appState: AppState) {
        self.appState = appState
    }

    func show() {
        guard let appState else { return }

        dismissalGeneration &+= 1

        let rootView = VoDogInitialSetupView(
            onDismiss: { [weak self] in
                self?.requestClose()
            },
            onPreferredHeightChange: { [weak self] height in
                self?.resizeContent(to: height)
            }
        )
        .environmentObject(appState)
        .cellDockLanguageEnvironment()

        SettingsSceneWindowRegistry.shared.orderOut()
        let window = window ?? makeWindow()
        window.contentViewController = nil
        window.contentView = makeContentView(rootView: rootView)
        window.setContentSize(Self.compactContentSize)
        center(window)

        NSApp.setActivationPolicy(.regular)
        SettingsSceneWindowRegistry.shared.orderOut()
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func requestClose() {
        guard let window, window.isVisible else { return }
        guard canClose else {
            NSSound.beep()
            return
        }

        dismissalGeneration &+= 1
        window.close()
    }

    func scheduleDismissAfterSuccess() {
        dismissalGeneration &+= 1
        let generation = dismissalGeneration

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self,
                  generation == self.dismissalGeneration,
                  self.isVisible,
                  self.canClose else { return }
            self.requestClose()
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard canClose else {
            NSSound.beep()
            return false
        }
        return true
    }

    func windowWillClose(_ notification: Notification) {
        dismissalGeneration &+= 1
        appState?.initialSetupDidDismiss()

        guard !MainWindowController.shared.isVisible,
              !StandaloneFlowWindowController.shared.hasVisibleWindows,
              !CommunicationWindowController.shared.hasVisibleWindows else { return }
        NSApp.setActivationPolicy(.accessory)
    }

    private var canClose: Bool {
        guard let appState else { return true }
        return !appState.isConfiguringECM && !appState.isConvertingModuleIdentity
    }

    private func makeWindow() -> NSWindow {
        let window = VoDogHeadlessSetupWindow(
            contentRect: NSRect(origin: .zero, size: Self.compactContentSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.onRequestClose = { [weak self] in
            self?.requestClose()
        }
        window.title = L10n.tr("DJI 模块配置")
        window.isReleasedWhenClosed = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .normal
        window.animationBehavior = .utilityWindow
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.delegate = self

        if #available(macOS 15.0, *) {
            window.isMovableByWindowBackground = false
        } else {
            window.isMovableByWindowBackground = true
        }

        return window
    }

    private func makeContentView<Content: View>(rootView: Content) -> NSView {
        let bounds = NSRect(origin: .zero, size: Self.compactContentSize)
        let container = NSView(frame: bounds)
        container.wantsLayer = true
        container.layer?.cornerRadius = Self.cornerRadius
        container.layer?.cornerCurve = .continuous
        container.layer?.masksToBounds = true

        let backdrop: NSView
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: bounds)
            glass.cornerRadius = Self.cornerRadius
            backdrop = glass
        } else {
            let material = NSVisualEffectView(frame: bounds)
            material.material = .popover
            material.blendingMode = .behindWindow
            material.state = .active
            backdrop = material
        }
        backdrop.autoresizingMask = [.width, .height]
        container.addSubview(backdrop)

        let hostingView = NSHostingView(rootView: rootView)
        hostingView.frame = bounds
        hostingView.autoresizingMask = [.width, .height]
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = NSColor.clear.cgColor
        container.addSubview(hostingView)

        return container
    }

    private func resizeContent(to requestedHeight: CGFloat) {
        guard let window else { return }
        let height = min(max(requestedHeight, Self.compactContentSize.height), Self.expandedHeight)
        guard abs(window.frame.height - height) > 0.5 else { return }

        let oldFrame = window.frame
        var newFrame = oldFrame
        newFrame.size = NSSize(width: Self.compactContentSize.width, height: height)
        newFrame.origin.y = oldFrame.maxY - height

        if let visibleFrame = window.screen?.visibleFrame {
            newFrame.origin.y = max(newFrame.origin.y, visibleFrame.minY + 8)
        }

        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        NSAnimationContext.runAnimationGroup { context in
            context.duration = reduceMotion ? 0 : 0.22
            context.allowsImplicitAnimation = !reduceMotion
            window.animator().setFrame(newFrame, display: true)
        }
    }

    private func center(_ window: NSWindow) {
        guard let screen = NSApp.keyWindow?.screen ?? NSApp.mainWindow?.screen ?? NSScreen.main else {
            window.center()
            return
        }

        let visibleFrame = screen.visibleFrame
        let origin = NSPoint(
            x: visibleFrame.midX - Self.compactContentSize.width / 2,
            y: visibleFrame.midY - Self.compactContentSize.height / 2
        )
        window.setFrameOrigin(origin)
    }

    private static let compactContentSize = NSSize(width: 520, height: 330)
    private static let expandedHeight: CGFloat = 400
    private static let cornerRadius: CGFloat = 30
}
