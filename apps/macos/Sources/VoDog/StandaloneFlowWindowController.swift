import AppKit
import SwiftUI

@MainActor
final class StandaloneFlowWindowController: NSObject, NSWindowDelegate {
    static let shared = StandaloneFlowWindowController()

    private enum Flow: Hashable {
        case smsComposer
        case atConsole
        case messageDetail
        case simPIN
    }

    private weak var appState: AppState?
    private var windows: [Flow: NSWindow] = [:]
    private var smsComposerTitleKey = "新短信"

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
        windows.forEach { flow, window in
            switch flow {
            case .smsComposer: window.title = L10n.tr(smsComposerTitleKey)
            case .atConsole: window.title = L10n.tr("AT 控制台")
            case .messageDetail: window.title = L10n.tr("短信详情")
            case .simPIN: window.title = L10n.tr("输入 SIM PIN")
            }
        }
    }

    var hasVisibleWindows: Bool {
        windows.values.contains(where: \.isVisible)
    }

    func configure(appState: AppState) {
        self.appState = appState
    }

    func showSMSComposer(to destination: String = "") {
        smsComposerTitleKey = destination.isEmpty ? "新短信" : "回复短信"
        show(
            .smsComposer,
            title: L10n.tr(smsComposerTitleKey),
            size: NSSize(width: 520, height: 440),
            content: SMSComposerView(destination: destination) { [weak self] in
                self?.close(.smsComposer)
            }
        )
    }

    func showATConsole() {
        show(
            .atConsole,
            title: L10n.tr("AT 控制台"),
            size: NSSize(width: 700, height: 560),
            content: ATConsoleView { [weak self] in self?.close(.atConsole) }
        )
    }

    func showMessageDetail(_ message: SMSMessage) {
        show(
            .messageDetail,
            title: L10n.tr("短信详情"),
            size: NSSize(width: 500, height: 500),
            content: SMSDetailView(message: message) { [weak self] in self?.close(.messageDetail) }
        )
    }

    // ponytail: one PIN window; a second locked module replaces the first prompt.
    func showSIMPIN(moduleID: CellularModuleID, disablingLock: Bool = false) {
        show(
            .simPIN,
            title: L10n.tr(disablingLock ? "关闭 PIN 锁" : "输入 SIM PIN"),
            size: NSSize(width: 360, height: 280),
            content: SIMPINPromptView(moduleID: moduleID, disablingLock: disablingLock) { [weak self] in
                self?.close(.simPIN)
            }
        )
    }

    private func show<Content: View>(
        _ flow: Flow,
        title: String,
        size: NSSize,
        content: Content
    ) {
        guard let appState else { return }
        let rootView = AnyView(
            content
                .environmentObject(appState)
                .cellDockLanguageEnvironment()
        )
        let hostingController = NSHostingController(rootView: rootView)

        let window: NSWindow
        if let existing = windows[flow] {
            window = existing
            window.contentViewController = hostingController
        } else {
            window = NSWindow(contentViewController: hostingController)
            window.styleMask = [.titled, .closable, .miniaturizable, .fullSizeContentView]
            window.isOpaque = false
            window.backgroundColor = .clear
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            // Keep content interactions (notably SMS text selection) from
            // turning into a window drag and triggering macOS edge tiling.
            window.isMovableByWindowBackground = false
            window.isReleasedWhenClosed = false
            window.delegate = self
            windows[flow] = window
        }

        window.title = title
        window.setContentSize(size)
        window.center()
        NSApplication.shared.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func close(_ flow: Flow) {
        windows[flow]?.performClose(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closingWindow = notification.object as? NSWindow,
              let flow = windows.first(where: { $0.value === closingWindow })?.key else {
            return
        }
        windows.removeValue(forKey: flow)
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  !self.windows.values.contains(where: \.isVisible),
                  !MainWindowController.shared.isVisible,
                  !CommunicationWindowController.shared.hasVisibleWindows,
                  !InitialSetupWindowController.shared.isVisible else {
                return
            }
            NSApplication.shared.setActivationPolicy(.accessory)
        }
    }
}
