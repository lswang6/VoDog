import AppKit
import SwiftUI

@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    static let shared = MainWindowController()

    private var window: NSWindow?
    private weak var appState: AppState?
    private var closesAfterPresentedFlow = false
    private var closeRequestSerial = 0

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appLanguageDidChange),
            name: .cellDockAppLanguageDidChange,
            object: nil
        )
    }

    @objc private func appLanguageDidChange() {
        window?.title = L10n.tr("设备与网络")
    }

    var isVisible: Bool {
        window?.isVisible == true
    }

    func configure(appState: AppState) {
        self.appState = appState
    }

    func show() {
        cancelPendingClose()
        closesAfterPresentedFlow = false
        showWindow()
    }

    func showForPresentedFlow() {
        let wasAlreadyVisible = window?.isVisible == true
        cancelPendingClose()
        closesAfterPresentedFlow = !wasAlreadyVisible
        showWindow()
    }

    func presentedFlowDidDismiss() {
        guard closesAfterPresentedFlow, let window else { return }
        closesAfterPresentedFlow = false
        closeRequestSerial &+= 1
        closeWhenSheetDetaches(window, requestSerial: closeRequestSerial, attemptsRemaining: 40)
    }

    private func cancelPendingClose() {
        closeRequestSerial &+= 1
    }

    private func closeWhenSheetDetaches(
        _ targetWindow: NSWindow,
        requestSerial: Int,
        attemptsRemaining: Int
    ) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak targetWindow] in
            guard let self,
                  let targetWindow,
                  self.closeRequestSerial == requestSerial,
                  self.window === targetWindow,
                  targetWindow.isVisible else {
                return
            }
            if targetWindow.attachedSheet != nil, attemptsRemaining > 0 {
                self.closeWhenSheetDetaches(
                    targetWindow,
                    requestSerial: requestSerial,
                    attemptsRemaining: attemptsRemaining - 1
                )
                return
            }
            guard targetWindow.attachedSheet == nil else { return }
            targetWindow.performClose(nil)
        }
    }

    private func showWindow() {
        guard let appState else { return }
        if window == nil {
            let rootView = MenuContentView(presentation: .window)
                .environmentObject(appState)
                .cellDockLanguageEnvironment()
            let hostingController = NSHostingController(rootView: rootView)
            let window = NSWindow(contentViewController: hostingController)
            window.title = L10n.tr("设备与网络")
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
            window.isOpaque = false
            window.backgroundColor = .clear
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .visible
            // Only the title bar should move the window. Dragging controls,
            // message text, or empty content must remain a content gesture.
            window.isMovableByWindowBackground = false
            window.minSize = NSSize(width: 520, height: 500)
            window.setContentSize(NSSize(width: 560, height: 620))
            window.isReleasedWhenClosed = false
            window.setFrameAutosaveName("VoDogMainWindow.v2")
            window.delegate = self
            window.center()
            self.window = window
        }

        NSApplication.shared.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        // The status item and its panel own the application lifetime. Closing
        // this standard window only orders it out; modem/SMS monitoring continues.
        appState?.dismissTransientMessage()
        cancelPendingClose()
        closesAfterPresentedFlow = false
        if !StandaloneFlowWindowController.shared.hasVisibleWindows,
           !CommunicationWindowController.shared.hasVisibleWindows,
           !InitialSetupWindowController.shared.isVisible {
            NSApplication.shared.setActivationPolicy(.accessory)
        }
    }
}
