import AppKit
import Foundation

@MainActor
final class AppTerminationDelegate: NSObject, NSApplicationDelegate {
    private var menuBarPanelController: MenuBarPanelController?
    private weak var appState: AppState?
    private var didFinishLaunching = false
    private var didShowInitialCommunicationWindow = false

    func configure(appState: AppState) {
        self.appState = appState
        menuBarPanelController = MenuBarPanelController(appState: appState)
        if didFinishLaunching {
            menuBarPanelController?.start()
            showInitialCommunicationWindowIfNeeded()
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppAppearanceMode.storedPreference.apply()
        didFinishLaunching = true
        menuBarPanelController?.start()
        showInitialCommunicationWindowIfNeeded()
    }

    func applicationWillTerminate(_ notification: Notification) {
        menuBarPanelController?.stop()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard confirmQuit() else { return .terminateCancel }
        return AppTerminationCoordinator.shared.beginTermination(of: sender)
    }

    /// Every in-app quit (menu bar, Settings, Cmd-Q) lands here. Apple-event quits (logout, restart,
    /// shutdown, osascript, `NSRunningApplication.terminate`) are never blocked by a modal.
    private func confirmQuit() -> Bool {
        guard NSAppleEventManager.shared().currentAppleEvent == nil, let appState else { return true }
        let gatewayRunning = appState.gateway.runtimes.contains { $0.isRunning }
        let inCall = appState.call.hasCall || VoDogCallStore.shared.active != nil
        guard gatewayRunning || inCall else { return true }
        let alert = NSAlert()
        alert.messageText = L10n.tr("退出 VoDog？")
        alert.informativeText = [
            inCall ? L10n.tr("正在进行的通话将中断。") : nil,
            gatewayRunning ? L10n.tr("退出后 VoDog 网关停止，远程客户端的来电、通话和短信将中断。") : nil,
        ].compactMap { $0 }.joined(separator: "\n")
        alert.addButton(withTitle: L10n.tr("退出"))
        alert.addButton(withTitle: L10n.tr("取消"))
        alert.buttons.first?.hasDestructiveAction = true
        NSApp.activate()
        return alert.runModal() == .alertFirstButtonReturn
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag {
            CommunicationWindowController.shared.handleApplicationReopen()
        }
        return true
    }

    private func showInitialCommunicationWindowIfNeeded() {
        guard !didShowInitialCommunicationWindow, let appState else { return }
        didShowInitialCommunicationWindow = true
        // A login launch stays in the menu bar (VoDog gateway / background monitoring).
        guard !LaunchAtLoginController.launchedAtLogin else { return }
        DispatchQueue.main.async {
            appState.showMessagesWindow()
        }
    }
}

final class AppTerminationCoordinator {
    static let shared = AppTerminationCoordinator()

    var cleanup: ((@escaping (Bool) -> Void) -> Void)?
    private var terminationPending = false

    private init() {}

    func beginTermination(of application: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationPending else { return .terminateLater }
        guard let cleanup else { return .terminateNow }
        terminationPending = true
        var replied = false
        let reply: (Bool) -> Void = { shouldTerminate in
            DispatchQueue.main.async {
                guard !replied else { return }
                replied = true
                self.terminationPending = false
                application.reply(toApplicationShouldTerminate: shouldTerminate)
            }
        }
        cleanup(reply)
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { reply(false) }
        return .terminateLater
    }
}
