import AppKit
import Darwin
import SwiftUI

@main
struct VoDogApp: App {
    @NSApplicationDelegateAdaptor(AppTerminationDelegate.self) private var appDelegate
    @StateObject private var appState: AppState

    init() {
        ModuleMaintenanceCLI.runIfRequested()
        AppIdentityMigration.migratePreferencesIfNeeded()
        let state = AppState()
        _appState = StateObject(wrappedValue: state)
        state.start()
        appDelegate.configure(appState: state)
    }

    var body: some Scene {
        Settings {
            Color.clear
                .frame(width: 1, height: 1)
                .onAppear {
                    appState.showPhoneWindow(section: .settings)
                    DispatchQueue.main.async {
                        SettingsSceneWindowRegistry.shared.orderOut()
                    }
                }
                .background(SettingsSceneWindowReader())
                .cellDockLanguageEnvironment()
        }
        .commands {
            VoDogCommands(appState: appState)
        }
    }
}

private enum ModuleMaintenanceCLI {
    static func runIfRequested() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let action = arguments.first,
              action == "--module-shell" || action == "--module-push" else {
            return
        }

        func fail(_ message: String, code: Int32 = 64) -> Never {
            FileHandle.standardError.write(Data("VoDog module tool: \(message)\n".utf8))
            Darwin.exit(code)
        }

        guard arguments.count >= 3 else {
            fail("usage: --module-shell LOCATION COMMAND | --module-push LOCATION LOCAL_PATH REMOTE_PATH")
        }
        let rawLocation = arguments[1].lowercased().hasPrefix("0x")
            ? String(arguments[1].dropFirst(2))
            : arguments[1]
        guard let locationID = UInt32(rawLocation, radix: 16), locationID != 0 else {
            fail("LOCATION must be a non-zero hexadecimal USB location ID")
        }

        let controller = ADBModuleController(locationID: locationID)
        do {
            switch action {
            case "--module-shell":
                let command = arguments.dropFirst(2).joined(separator: " ")
                guard !command.isEmpty else { fail("COMMAND cannot be empty") }
                let result = try controller.shellChecked(command, timeout: 30)
                FileHandle.standardOutput.write(Data(result.output.utf8))
                Darwin.exit(Int32(clamping: result.status))
            case "--module-push":
                guard arguments.count == 4 else {
                    fail("usage: --module-push LOCATION LOCAL_PATH REMOTE_PATH")
                }
                let localURL = URL(fileURLWithPath: arguments[2])
                let data = try Data(contentsOf: localURL, options: .mappedIfSafe)
                try controller.push(data, to: arguments[3])
                print("pushed \(data.count) bytes to \(arguments[3])")
                Darwin.exit(0)
            default:
                fail("unsupported action")
            }
        } catch {
            fail(error.localizedDescription, code: 1)
        }
    }
}

private struct VoDogCommands: Commands {
    @ObservedObject private var languageController = AppLanguageController.shared
    let appState: AppState

    var body: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button(L10n.tr("设置…")) {
                appState.showStandaloneSettings()
            }
            .keyboardShortcut(",", modifiers: .command)
        }
    }
}

@MainActor
final class SettingsSceneWindowRegistry {
    static let shared = SettingsSceneWindowRegistry()

    private weak var window: NSWindow?

    private init() {}

    func register(_ window: NSWindow?) {
        self.window = window
    }

    func orderOut() {
        window?.orderOut(nil)
    }
}

private struct SettingsSceneWindowReader: NSViewRepresentable {
    func makeNSView(context: Context) -> SettingsSceneWindowReaderView {
        SettingsSceneWindowReaderView()
    }

    func updateNSView(_ nsView: SettingsSceneWindowReaderView, context: Context) {
        nsView.registerWindow()
    }
}

private final class SettingsSceneWindowReaderView: NSView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        registerWindow()
    }

    func registerWindow() {
        SettingsSceneWindowRegistry.shared.register(window)
    }
}
