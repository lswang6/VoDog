import SwiftUI
import UserNotifications

struct MainView: View {
    @Environment(AppNavigation.self) private var navigation
    @State private var media = CallMediaSession.shared
    @State private var availability = UIAvailabilityState()
    @State private var badges = BadgeStore.shared
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var navigation = navigation
        CallsView { callTab in
            TabView(selection: $navigation.tab) {
                // S20 decision 8: a call this device is holding stays visible from the other tabs.
                callTab.tabItem { Label("电话", systemImage: "phone") }.tag(AppTab.calls)
                    // S67: pending calls; a held call still marks the tab (S20 decision 8).
                    .badge(BadgeLabelPolicy.text(max(badges.counts.calls, media.callID == nil ? 0 : 1)))
                MessagesView().tabItem { Label("短信", systemImage: "message") }.tag(AppTab.messages)
                    .badge(BadgeLabelPolicy.text(badges.counts.sms))
                RecordsView().tabItem { Label("记录", systemImage: "clock.arrow.circlepath") }.tag(AppTab.records)
                ContactsView().tabItem { Label("通讯录", systemImage: "person") }.tag(AppTab.contacts)
                SettingsView().tabItem { Label("设置", systemImage: "slider.horizontal.3") }.tag(AppTab.settings)
            }
        }
        .environment(availability)
        .task { await availability.monitor() }
        .onChange(of: media.isRejoining || (media.callID != nil && media.isConnectingOrConnected), initial: true) {
            availability.callMediaActive = $1
        }
        // S67: one app-level poller covers both tabs and the SIM strips.
        .task(id: "\(session.sessionIdentity?.uuidString ?? "none"):\(scenePhase)") {
            guard let identity = session.sessionIdentity else { return }
            // S67: the icon badge needs notification permission; ask once (same options as 允许来电通知).
            if BadgePreferences.current().enabled,
               await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .notDetermined {
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                UIApplication.shared.registerForRemoteNotifications()
            }
            while !Task.isCancelled, session.isCurrentSession(identity), scenePhase == .active {
                await badges.refresh(session: session)
                do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
            }
        }
        .onDisappear { badges.reset() }
    }
}
