import SwiftUI

enum AppTab: Hashable {
    case calls, messages, records, contacts, settings
}

struct HistoryRedialRequest: Equatable {
    let simID: String
    let remoteNumber: String
    let token: UUID
}

/// S21: a contact card opened without a SIM in context (通讯录, or a record whose SIM is unknown) fills the
/// dialer and lets the user pick the outgoing number, instead of auto-dialling on a SIM nobody chose.
///
/// S36 C5-b: `confirm` asks the dialer — the one screen that owns the SIM list — to resolve a SIM and
/// confirm "用 <号码> 拨打 <number>？" before dialling, so 拨打 from a contact or a record reaches the call
/// screen instead of stopping at a filled-in dialer. Without a usable SIM it degrades to the old prefill.
struct DialPrefillRequest: Equatable {
    let simID: String?
    let remoteNumber: String
    let token: UUID
    var confirm = false
}

struct HistoryComposeRequest: Equatable, Identifiable {
    var id: UUID { token }
    let simID: String?
    let remoteNumber: String
    let token: UUID
}

@MainActor @Observable
final class AppNavigation {
    static let shared = AppNavigation()
    var tab: AppTab = .calls
    var pendingRedial: HistoryRedialRequest?
    var pendingCompose: HistoryComposeRequest?
    var pendingDialPrefill: DialPrefillRequest?
    /// S69: an open SMS thread runs the one 5 s poll; the thread list's loop idles meanwhile.
    var smsThreadOpen = false
}

@main
struct VoDogApp: App {
    @UIApplicationDelegateAdaptor(VoDogAppDelegate.self) private var appDelegate
    @State private var session = SessionStore()
    @State private var navigation = AppNavigation.shared
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.dark.rawValue

    /// S33 UI acceptance needs a deterministic light/dark window while iOS 27 simulators may ignore
    /// `XCUIDevice.appearance` and process-wide interface-style arguments. The compiler removes this
    /// hook from Release and devices, and both real-backend guards must match the one fixed local API.
    private var s33UITestColorScheme: ColorScheme? {
        #if DEBUG && targetEnvironment(simulator)
        let environment = ProcessInfo.processInfo.environment
        guard environment["VODOG_UI_TEST_REAL_BACKEND"] == "1",
              environment["VODOG_UI_TEST_API_BASE_URL"] == "http://127.0.0.1:16880/api/v1" else { return nil }
        switch environment["VODOG_UI_TEST_COLOR_SCHEME"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
        #else
        return nil
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(navigation)
                .tint(Color.callerAccent)
                .preferredColorScheme(AppAppearance(storedValue: appearanceRawValue)
                    .resolvedColorScheme(testOverride: s33UITestColorScheme))
        }
    }
}

struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    /// UI automation needs to exercise the logged-out surface without deleting the retained simulator session.
    /// This hook exists only in Debug builds and also suppresses session restore and app-lifecycle side effects.
    private var presentsIsolatedLoginForUITesting: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["VODOG_UI_TEST_LOGIN_ONLY"] == "1"
        #else
        false
        #endif
    }

    var body: some View {
        Group {
            if presentsIsolatedLoginForUITesting { LoginView(remembered: nil) }
            else if session.isAuthenticated { MainView() }
            else { LoginView() }
        }
        // One `UITapGestureRecognizer` on the key window, installed here and nowhere else: sheets and
        // `NavigationStack` destinations are separate view hierarchies, so a tap modifier on this view would
        // never reach them, but they all share this window.
        .dismissesKeyboardOnBackgroundTap()
        .task {
            guard !presentsIsolatedLoginForUITesting else { return }
            await session.restore()
        }
        .task {
            guard !presentsIsolatedLoginForUITesting else { return }
            PushRegistrationManager.shared.attach(session: session)
            IncomingCallManager.shared.attach(session: session)
            Diag.shared.attach(session: session)
        }
        .onChange(of: scenePhase) { _, phase in
            guard !presentsIsolatedLoginForUITesting else { return }
            Diag.shared.log("app.scene", ["phase": String(describing: phase)])
            switch phase {
            case .active:
                Task { await CallMediaSession.shared.preflightMicrophonePermission() }
            case .background:
                IncomingCallManager.shared.releaseOccupancy(trigger: .background)
                // S36 C3: the last chance to hand over what the ring holds before the process is suspended.
                Diag.shared.flush()
            default:
                break
            }
        }
    }
}
