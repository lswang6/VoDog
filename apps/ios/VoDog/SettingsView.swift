import AVFoundation
import SwiftUI
import UIKit
import UserNotifications

enum SettingsRolePolicy {
    static func title(_ role: String?) -> String {
        switch role {
        case "admin": "管理员"
        case "user": "用户"
        default: "暂不可用"
        }
    }
}

enum SettingsPermissionState: Equatable {
    case allowed, denied, notDetermined, unavailable
}

enum SettingsPermissionPolicy {
    enum Kind: Equatable { case notifications, microphone }

    static func status(_ state: SettingsPermissionState) -> String {
        switch state {
        case .allowed: "已允许"
        case .denied: "未允许"
        case .notDetermined: "尚未请求"
        case .unavailable: "系统状态不可用"
        }
    }

    static func action(_ kind: Kind, state: SettingsPermissionState) -> String? {
        switch state {
        case .notDetermined:
            kind == .notifications ? "允许来电通知" : "允许通话麦克风"
        case .denied, .unavailable:
            "打开系统设置"
        case .allowed:
            nil
        }
    }
}

struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.dark.rawValue
    @State private var sims: [SIMChannel] = []
    @State private var error: String?
    @State private var passkey = PasskeyService()
    @State private var passkeys: [PasskeyItem] = []
    @State private var passkeysLoaded = false
    @State private var passkeyRefreshError: String?
    @State private var passkeyLoadGeneration = 0
    @State private var passkeyToDelete: PasskeyItem?
    @State private var passkeyToRename: PasskeyItem?
    @State private var renameText = ""
    @State private var renameError: String?
    @State private var push = PushRegistrationManager.shared
    @State private var loaded = false
    @State private var gateways: [GatewayPower] = []
    @State private var gatewaysLoaded = false
    @State private var gatewayLoadGeneration = 0
    /// A Control that predates S21 has no `/gateways/power`; the section hides rather than nagging about a 404.
    @State private var powerUnavailable = false
    @State private var powerError: String?
    @State private var powerBusy: Set<String> = []
    @State private var gatewayPowerOffConfirmation: PendingGatewayPowerOff?
    // S24 决策 3「AI 语音服务」。A Control that predates S24 has no `/ai/voice-providers`; like 远程开关,
    // the section hides on 404 instead of nagging.
    @State private var voiceProviders: [VoiceProvider] = []
    @State private var voiceProviderSelected: String?
    @State private var voiceProviderConfigVersion = 1
    @State private var voiceProvidersLoaded = false
    @State private var voiceProviderUnavailable = false
    @State private var voiceProviderRefreshError: String?
    @State private var voiceProviderOperationError: String?
    @State private var voiceProviderConflict: ProviderConflictState?
    @State private var voiceProviderConflictReloading = false
    @State private var voiceProviderBusy: String?
    @State private var voiceProviderLoadGeneration = 0
    @State private var settingsLoadGeneration = 0
    @State private var blockedNumbers: [BlocklistItem] = []
    @State private var blockedSMSNumbers: [BlocklistItem] = []
    @State private var blocklistLoaded = false
    @State private var blocklistRefreshError: String?
    @State private var blocklistLoadGeneration = 0
    @State private var notificationPermission: SettingsPermissionState = .unavailable
    @State private var microphonePermission: SettingsPermissionState = .unavailable
    @State private var permissionsLoaded = false
    @State private var permissionLoadGeneration = 0
    @State private var permissionActionError: String?
    @State private var refreshingApplicationStatus = false
    @State private var dataSessionIdentity: UUID?
    @AppStorage(BadgePreferences.enabledKey) private var badgeEnabled = true
    @AppStorage(BadgePreferences.callsKey) private var badgeCalls = true
    @AppStorage(BadgePreferences.smsKey) private var badgeSMS = true

    private var appearanceSection: some View {
        Section("外观") {
            Picker("显示模式", selection: Binding(
                get: { AppAppearance(storedValue: appearanceRawValue) },
                set: { appearanceRawValue = $0.rawValue }
            )) {
                ForEach(AppAppearance.allCases, id: \.self) { appearance in
                    Text(appearance.label).tag(appearance)
                }
            }
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("settings.appearance")
        }
    }

    /// S67 decision 4: only the app-icon badge; in-app badges always show.
    private var badgeSection: some View {
        Section {
            Toggle("App 图标角标", isOn: $badgeEnabled).accessibilityIdentifier("settings.badge.enabled")
            Toggle("通话", isOn: $badgeCalls).disabled(!badgeEnabled).accessibilityIdentifier("settings.badge.calls")
            Toggle("短信", isOn: $badgeSMS).disabled(!badgeEnabled).accessibilityIdentifier("settings.badge.sms")
        } header: {
            Text("角标")
        } footer: {
            Text("图标数字 = 待查看通话 + 未读短信。应用内的通话、短信与 SIM 角标始终显示。")
        }
        .onChange(of: badgeEnabled) { _, on in
            badgePreferencesChanged()
            guard on else { return }
            Task {
                guard await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .notDetermined
                else { return }
                // The same option set as 允许来电通知, so this prompt never narrows what that one asks for.
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                UIApplication.shared.registerForRemoteNotifications()
                await loadPermissionStatus()
            }
        }
        .onChange(of: badgeCalls) { _, _ in badgePreferencesChanged() }
        .onChange(of: badgeSMS) { _, _ in badgePreferencesChanged() }
    }

    private func badgePreferencesChanged() {
        BadgeStore.shared.applyIcon()
        Task { await PushRegistrationManager.shared.sync() }
    }

    private struct PendingGatewayPowerOff {
        let gatewayID: String
        let gatewayName: String
        let sessionIdentity: UUID
    }

    var body: some View {
        NavigationStack {
            List {
                Group {
                appearanceSection
                badgeSection
                if availability.reason != nil { Section { NetworkAvailabilityNotice() } }
                accountSection
                simSection
                voiceProviderSection
                blocklistSection
                passkeySection
                gatewayPowerSection
                deviceConnectionSection
                callNetworkSection
                refreshSection
                logoutSection
                loadErrorSection
                }
                .listRowBackground(Signal.surface)
            }
            .signalList().navigationTitle("设置").toolbarTitleDisplayMode(.inlineLarge).refreshable { await refreshApplicationStatus() }
            .task(id: "\(session.sessionIdentity?.uuidString ?? "none"):\(navigation.tab):\(scenePhase)") {
                guard navigation.tab == .settings, scenePhase == .active else { return }
                guard session.sessionIdentity != nil else { clearSessionData(); return }
                await refreshApplicationStatus()
                while !Task.isCancelled, navigation.tab == .settings, scenePhase == .active {
                    do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                    guard let identity = session.sessionIdentity else { return }
                    await refreshSettingsSnapshot(requiredIdentity: identity, syncPush: false)
                }
            }
            .confirmationDialog("删除这个通行密钥？", isPresented: Binding(
                get: { passkeyToDelete != nil },
                set: { if !$0 { passkeyToDelete = nil } }
            ), titleVisibility: .visible) {
                Button("删除", role: .destructive) {
                    if let item = passkeyToDelete { Task { await deletePasskey(item) } }
                    passkeyToDelete = nil
                }
                .disabled(!availability.canMutate)
                Button("取消", role: .cancel) { passkeyToDelete = nil }
            } message: {
                Text("删除后，这台设备将无法再用该通行密钥登录。")
                if let reason = availability.reason { Text(reason) }
            }
            .confirmationDialog(
                gatewayPowerOffConfirmation.map { "关闭 \($0.gatewayName)？" } ?? "关闭网关？",
                isPresented: Binding(
                    get: { gatewayPowerOffConfirmation != nil },
                    set: { if !$0 { gatewayPowerOffConfirmation = nil } }
                ), titleVisibility: .visible
            ) {
                Button("关闭网关", role: .destructive) {
                    guard let pending = gatewayPowerOffConfirmation else { return }
                    gatewayPowerOffConfirmation = nil
                    guard session.isCurrentSession(pending.sessionIdentity),
                          let current = gateways.first(where: { $0.gatewayId == pending.gatewayID }) else { return }
                    Task {
                        guard availability.canChangeGatewayPower(current) else { return }
                        await setGatewayPower(
                            current, on: false, requiredIdentity: pending.sessionIdentity
                        )
                    }
                }
                .disabled(!availability.canMutate)
                .accessibilityIdentifier("gatewayPower.confirmOff")
                Button("取消", role: .cancel) { gatewayPowerOffConfirmation = nil }
            } message: {
                if let reason = availability.reason { Text(reason) }
                if let pending = gatewayPowerOffConfirmation {
                    Text("将关闭 \(pending.gatewayName) 的网关总控。通话进行中时服务器会拒绝关闭。")
                }
            }
            .alert("重命名通行密钥", isPresented: Binding(
                get: { passkeyToRename != nil },
                set: { if !$0 { passkeyToRename = nil } }
            ), presenting: passkeyToRename) { item in
                TextField("名称", text: $renameText).disabled(!availability.canMutate)
                Button("保存") { Task { await renamePasskey(item) } }.disabled(!availability.canMutate)
                Button("取消", role: .cancel) { passkeyToRename = nil }
            } message: { _ in
                Text("名称只用于在这个列表里区分设备，1–64 个字符。")
                if let reason = availability.reason { Text(reason) }
            }
        }
    }

    private var accountSection: some View {
        Section("账号") {
            LabeledContent("用户名", value: session.user?.username ?? "—")
            LabeledContent("角色", value: SettingsRolePolicy.title(session.user?.role))
            LabeledContent("当前会话", value: "iOS App")
        }
    }

    private var displayedSIMs: [SIMChannel] {
        guard availability.canMutate else { return sims }
        return sims.enumerated().sorted { lhs, rhs in
            let leftOnline = lhs.element.online == true
            let rightOnline = rhs.element.online == true
            return leftOnline == rightOnline ? lhs.offset < rhs.offset : leftOnline
        }.map { $0.element }
    }

    private var simSection: some View {
        Section {
            if !loaded {
                // S20 decision 8: the first frame is "unknown", not "none assigned".
                HStack(spacing: 8) {
                    ProgressView()
                    Text("正在读取号码…").foregroundStyle(.secondary)
                }
            } else if sims.isEmpty, error == nil {
                Text("没有已分配的 SIM").foregroundStyle(.secondary)
            }
            ForEach(displayedSIMs) { sim in
                simRow(sim)
            }
        } header: {
            Text("SIM 与接听模式")
        } footer: {
            Text("显示名称和号码标注只用于辨认线路，不会更换 SIM 的稳定身份或中断通话。")
        }
    }

    private func simRow(_ sim: SIMChannel) -> some View {
        NavigationLink {
            SIMSettingsView(sim: sim) { await load() }
        } label: {
            // S95: line square + name, status shape + words, answer-mode summary; unconfirmed settings in warn.
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    SimSwatch(color: SIMPalette.color(for: sim, in: sims))
                    Text(simDisplayName(sim)).font(.body.weight(.semibold)).foregroundStyle(Signal.ink)
                    Spacer(minLength: 4)
                    if let status = LineStatus(sim: sim, availability: availability) { SimStatusShape(status: status) }
                    Text(availability.simStatus(sim)).font(.footnote).foregroundStyle(Signal.ink2)
                }
                // S95b §A: AI modes as the full badge (wraps under the name, never squeezes it); 人工接听 stays text.
                if let badge = AiBadge(sim: sim, full: true) { badge } else {
                    Text(modeTitle(sim.settings?.mode)).font(.subheadline).foregroundStyle(Signal.ink2)
                }
                if let settings = sim.settings, (settings.appliedVersion ?? -1) < settings.version {
                    HStack(spacing: 6) {
                        SimStatusShape(status: .pending)
                        Text(SettingsApplyPolicy.subtitle(appliedVersion: settings.appliedVersion, version: settings.version))
                    }
                    .font(.footnote).foregroundStyle(Signal.warn)
                }
                // Same identity block the compose sheet shows, instead of a second phrasing of it.
                SIMIdentityDetail(sim: sim)
            }
        }
    }

    private func simDisplayName(_ sim: SIMChannel) -> String {
        if let label = sim.label { return label }
        return "SIM \((sim.slotIndex ?? 0) + 1)"
    }

    private var blocklistSection: some View {
        Section("已屏蔽号码") {
            NavigationLink {
                InterceptionsView(blocklistOnly: true)
            } label: {
                LabeledContent("管理已屏蔽号码") {
                    if !blocklistLoaded {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(BlocklistSummaryPolicy.summary(call: blockedNumbers.count, sms: blockedSMSNumbers.count))
                    }
                }
            }
            .accessibilityIdentifier("settings.blocklist")
            if blocklistLoaded, blockedNumbers.isEmpty, blockedSMSNumbers.isEmpty, blocklistRefreshError == nil {
                Text("暂无已屏蔽号码").foregroundStyle(.secondary)
            }
            if let blocklistRefreshError {
                settingsRefreshError(
                    blocklistRefreshError, identifier: "settings.blocklistError"
                ) { await loadBlocklist() }
            }
        }
    }

    private var passkeySection: some View {
        Section("通行密钥") {
            Text("使用系统通行密钥安全登录，无需输入密码。")
                .font(.footnote).foregroundStyle(.secondary)
            Button { Task { await registerPasskey() } } label: {
                Label("添加通行密钥", systemImage: "person.badge.key")
            }
            .disabled(!availability.canMutate)
            .accessibilityIdentifier("passkey.register")
            if !passkeysLoaded {
                HStack(spacing: 8) { ProgressView(); Text("正在读取通行密钥…") }
                    .foregroundStyle(.secondary)
            } else if passkeys.isEmpty, passkeyRefreshError == nil {
                Text("尚未添加通行密钥").foregroundStyle(.secondary)
            }
            ForEach(passkeys) { item in passkeyRow(item).disabled(!availability.canMutate) }
            if let passkeyRefreshError {
                settingsRefreshError(
                    passkeyRefreshError, identifier: "settings.passkeyRefreshError"
                ) { await loadPasskeys() }
            }
            if let message = renameError {
                Text(message).font(.footnote).foregroundStyle(Color.callerDanger)
                    .accessibilityIdentifier("passkey-rename-error")
                    .reportsError(message, screen: "settings", site: "passkey_rename")
            }
            if let message = passkey.statusMessage {
                Label(message, systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Signal.call)
                    .accessibilityIdentifier("passkey-status")
            }
            if let message = passkey.errorMessage {
                Text(message).foregroundStyle(Color.callerDanger)
                    .accessibilityIdentifier("passkey-error")
                    .reportsError(message, screen: "settings", site: "passkey")
            }
        }
    }

    private var deviceConnectionSection: some View {
        Section("设备与连接") {
            if !permissionsLoaded {
                HStack(spacing: 8) { ProgressView(); Text("正在读取系统权限…") }
                    .foregroundStyle(.secondary)
            }
            LabeledContent("来电通知", value: SettingsPermissionPolicy.status(notificationPermission))
                .accessibilityIdentifier("settings.notificationPermission")
            if let action = SettingsPermissionPolicy.action(.notifications, state: notificationPermission) {
                Button(action) { Task { await resolveNotificationPermission() } }
                    .accessibilityIdentifier("settings.notificationPermissionAction")
            }
            LabeledContent("通话麦克风", value: SettingsPermissionPolicy.status(microphonePermission))
                .accessibilityIdentifier("settings.microphonePermission")
            if let action = SettingsPermissionPolicy.action(.microphone, state: microphonePermission) {
                Button(action) { Task { await resolveMicrophonePermission() } }
                    .accessibilityIdentifier("settings.microphonePermissionAction")
            }
            if let permissionActionError {
                Text(permissionActionError).font(.footnote).foregroundStyle(Color.callerDanger)
                    .accessibilityIdentifier("settings.permissionError")
                    .reportsError(permissionActionError, screen: "settings", site: "permission")
            }
            Label(push.tokenStatus, systemImage: "bell.badge")
                .accessibilityIdentifier("push-token-status")
            Label(
                "服务端推送注册：\(push.serverStatus)",
                systemImage: push.serverRegistrationSucceeded ? "checkmark.icloud" : "icloud.slash"
            )
            .accessibilityIdentifier("push-server-status")
            Text(push.lastIncomingStatus).font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("push-incoming-status")
            Label("通话和短信状态以服务器记录为准。", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(.secondary)
            Text("号码设备离线时，请在对应网关设备上重新开启 VoDog。").font(.footnote)
        }
    }

    private var callNetworkSection: some View {
        Section("通话网络") {
            LabeledContent("连接策略", value: "自动")
            Text("本机优先使用标准连接；受限网络下会自动改用兼容连接。")
                .font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("settings.callNetworkPolicy")
        }
    }

    private var refreshSection: some View {
        Section {
            Button {
                Task { await refreshApplicationStatus() }
            } label: {
                HStack(spacing: 8) {
                    if refreshingApplicationStatus { ProgressView().controlSize(.small) }
                    Label("刷新应用状态", systemImage: "arrow.clockwise")
                }
            }
            .disabled(refreshingApplicationStatus)
            .accessibilityIdentifier("settings.refreshAll")
        }
    }

    private var logoutSection: some View {
        Section {
            Button("退出登录", role: .destructive) { Task { await session.logout() } }
        }
    }

    @ViewBuilder private var loadErrorSection: some View {
        if let error {
            Section {
                ErrorBanner(screen: "settings", message: error) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
        }
    }

    @ViewBuilder private func settingsRefreshError(
        _ message: String, identifier: String, retry: @escaping @MainActor () async -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(Color.callerDanger)
            Button("重试") { Task { await retry() } }
                .frame(minHeight: 44)
        }
        .accessibilityIdentifier(identifier)
        .reportsError(message, screen: "settings", site: identifier)
    }

    /// S24 决策 3: one radio list. Every row that the server would refuse is disabled with the reason on it,
    /// so a tap either works or is visibly unavailable — never "失败" after the fact.
    @ViewBuilder private var voiceProviderSection: some View {
        if !voiceProviderUnavailable {
            Section {
                if !voiceProvidersLoaded {
                    HStack(spacing: 8) { ProgressView(); Text("正在读取语音服务…").foregroundStyle(.secondary) }
                } else if voiceProviders.isEmpty, voiceProviderRefreshError == nil {
                    Text("没有可选的语音服务").foregroundStyle(.secondary)
                }
                ForEach(voiceProviders) { voiceProviderRow($0) }
                if let conflict = voiceProviderConflict {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(ProviderConcurrencyPolicy.conflictMessage, systemImage: "arrow.triangle.2.circlepath")
                        Text(ProviderConcurrencyPolicy.attemptedChoiceMessage(conflict))
                            .font(.caption).foregroundStyle(.secondary)
                        Button("载入并确认最新配置") { Task { await acknowledgeProviderConflict() } }
                            .disabled(!availability.canMutate || voiceProviderConflictReloading)
                            .accessibilityIdentifier("voiceProvider.reloadConflict")
                    }
                    .font(.footnote).foregroundStyle(Color.callerDanger)
                    .accessibilityIdentifier("voiceProvider.conflict")
                    .reportsError(voiceProviderConflict != nil, message: ProviderConcurrencyPolicy.conflictMessage, screen: "settings", site: "voice_provider_conflict")
                }
                if let voiceProviderOperationError {
                    Text(voiceProviderOperationError).font(.footnote).foregroundStyle(Color.callerDanger)
                        .accessibilityIdentifier("voiceProvider.operationError")
                        .reportsError(voiceProviderOperationError, screen: "settings", site: "voice_provider_operation")
                }
                if let voiceProviderRefreshError {
                    Text(voiceProviderRefreshError).font(.footnote).foregroundStyle(Color.callerDanger)
                        .accessibilityIdentifier("voiceProvider.refreshError")
                        .reportsError(voiceProviderRefreshError, screen: "settings", site: "voice_provider_refresh")
                }
            } header: {
                Text("AI 语音服务")
            } footer: {
                Text(VoiceProviderPolicy.footerText)
            }
        }
    }

    @ViewBuilder private func voiceProviderRow(_ item: VoiceProvider) -> some View {
        let reason = VoiceProviderPolicy.disabledReason(item)
        let selected = VoiceProviderPolicy.isSelected(item, selected: voiceProviderSelected)
        Button {
            Task { await selectVoiceProvider(item) }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(VoiceProviderPolicy.displayLabel(item))
                    Label(VoiceProviderPolicy.statusTitle(item), systemImage: VoiceProviderPolicy.statusSymbol(item))
                        .font(.caption)
                        .foregroundStyle(reason == nil ? Signal.call : Signal.warn)
                    // The reason a row cannot be chosen is the row's own subtitle, not a banner somewhere else.
                    if let reason { Text(reason).font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
                if voiceProviderBusy == item.id {
                    ProgressView()
                } else if selected {
                    Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(.tint)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        // Plain, so the row reads like the rest of 设置 instead of a tinted action.
        .buttonStyle(.plain)
        // One request at a time: two quick taps would otherwise race and leave the wrong 勾.
        .disabled(!availability.canMutate || reason != nil || voiceProviderBusy != nil || voiceProviderConflict != nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("voiceProvider.row")
    }

    @discardableResult
    func loadVoiceProviders(
        acceptingConflict: Bool = false, requiredIdentity: UUID? = nil
    ) async -> Bool {
        guard voiceProviderBusy == nil,
              let identity = requiredIdentity ?? session.sessionIdentity,
              session.isCurrentSession(identity) else { return false }
        voiceProviderLoadGeneration += 1
        let generation = voiceProviderLoadGeneration
        do {
            let response: VoiceProviderList = try await session.request(
                "ai/voice-providers", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == voiceProviderLoadGeneration,
                  session.sessionIdentity == identity, voiceProviderBusy == nil else { return false }
            voiceProviders = response.items
            voiceProviderSelected = response.selected
            voiceProviderConfigVersion = response.configVersion
            voiceProviderUnavailable = false
            voiceProviderRefreshError = nil
            if acceptingConflict { voiceProviderConflict = nil }
            voiceProvidersLoaded = true
            return true
        } catch SessionLifecycleError.staleSession {
            return false
        } catch {
            guard !Task.isCancelled, generation == voiceProviderLoadGeneration,
                  session.sessionIdentity == identity, voiceProviderBusy == nil else { return false }
            if case APIError.server(404, _, _) = error {
                voiceProviders = []
                voiceProviderUnavailable = true
                voiceProviderRefreshError = nil
            } else {
                voiceProviderRefreshError = VoiceProviderPolicy.message(for: error)
            }
        }
        voiceProvidersLoaded = true
        return false
    }

    /// The 勾 moves immediately and is put back on any failure — a 409 (or a timeout) must never leave the UI
    /// claiming a provider the server did not accept.
    func selectVoiceProvider(_ item: VoiceProvider) async {
        guard availability.canMutate else { return }
        guard voiceProviderBusy == nil, voiceProviderConflict == nil,
              VoiceProviderPolicy.shouldSubmit(item, selected: voiceProviderSelected),
              let identity = session.sessionIdentity else { return }
        let previous = voiceProviderSelected
        voiceProviderLoadGeneration += 1
        voiceProviderBusy = item.id
        voiceProviderOperationError = nil
        voiceProviderSelected = item.id
        defer { if session.isCurrentSession(identity), voiceProviderBusy == item.id { voiceProviderBusy = nil } }
        do {
            let response: VoiceProviderList = try await session.request(
                "ai/voice-provider", method: "PUT",
                body: VoiceProviderBody(provider: item.id, expectedVersion: voiceProviderConfigVersion),
                timeoutInterval: 15, requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity), voiceProviderBusy == item.id else { return }
            voiceProviders = response.items
            voiceProviderSelected = response.selected
            voiceProviderConfigVersion = response.configVersion
            voiceProviderOperationError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch where ProviderConcurrencyPolicy.isConflict(error) {
            guard session.isCurrentSession(identity), voiceProviderBusy == item.id else { return }
            voiceProviderSelected = previous
            voiceProviderConflict = ProviderConflictState(
                attemptedProviderID: item.id,
                attemptedProviderLabel: VoiceProviderPolicy.displayLabel(item)
            )
            voiceProviderBusy = nil
            await loadVoiceProviders()
        } catch {
            guard session.isCurrentSession(identity), voiceProviderBusy == item.id else { return }
            voiceProviderSelected = previous
            voiceProviderOperationError = VoiceProviderPolicy.message(for: error)
        }
    }

    /// Polling may already have observed a newer server selection, but it cannot silently turn a stale write into
    /// a retry. This explicit read is the acknowledgement boundary that advances the version the next tap uses.
    private func acknowledgeProviderConflict() async {
        guard voiceProviderConflict != nil, !voiceProviderConflictReloading else { return }
        voiceProviderConflictReloading = true
        defer { voiceProviderConflictReloading = false }
        await loadVoiceProviders(acceptingConflict: true)
    }

    @ViewBuilder private var gatewayPowerSection: some View {
        if !powerUnavailable {
            Section {
                if !gatewaysLoaded {
                    HStack(spacing: 8) { ProgressView(); Text("正在读取网关状态…").foregroundStyle(.secondary) }
                } else if gateways.isEmpty, powerError == nil {
                    Text("没有可管理的网关").foregroundStyle(.secondary)
                }
                ForEach(gateways) { gatewayPowerRow($0) }
                if let powerError {
                    Text(powerError).font(.footnote).foregroundStyle(Color.callerDanger)
                        .accessibilityIdentifier("gatewayPower.error")
                        .reportsError(powerError, screen: "settings", site: "gateway_power")
                }
            } header: {
                Text("网关设备")
            } footer: {
                Text("远程开启需要先在网关设备上打开「允许远程开启（待命）」。通话进行中不会被远程关闭。")
            }
        }
    }

    /// §D: name, 状态, whether the phone allows remote power, and the 网关总控 switch. The switch is disabled
    /// with the reason spelled out whenever the server would refuse, so the user is never told "失败" for a
    /// condition that was already visible.
    @ViewBuilder private func gatewayPowerRow(_ item: GatewayPower) -> some View {
        let disabledReason = GatewayPowerPolicy.toggleDisabledReason(item)
        VStack(alignment: .leading, spacing: 6) {
            Text(GatewayPowerPolicy.displayName(item)).font(.body.weight(.semibold))
            Label(GatewayPowerPolicy.statusTitle(item), systemImage: GatewayPowerPolicy.statusSymbol(item))
                .font(.caption)
                .foregroundStyle(item.online || item.standbyOnline ? Color.secondary : Color.callerDanger)
            Text(GatewayPowerPolicy.remotePowerTitle(item))
                .font(.caption)
                .foregroundStyle(item.remotePowerAllowed ? Color.secondary : Signal.warn)
            Text(GatewayPowerPolicy.heartbeatTitle(item) { displayDate($0) })
                .font(.caption2).foregroundStyle(.secondary)
                .accessibilityIdentifier("gatewayPower.heartbeat")
            Toggle(isOn: Binding(
                get: { GatewayPowerPolicy.isOn(item) },
                set: { desired in
                    if desired {
                        Task { await setGatewayPower(item, on: true) }
                    } else {
                        requestGatewayPowerOff(item)
                    }
                }
            )) {
                HStack(spacing: 8) {
                    Text("网关总控")
                        .foregroundStyle(GatewayPowerPolicy.isOn(item) ? Color.callerDanger : Color.primary)
                    if powerBusy.contains(item.gatewayId) { ProgressView() }
                }
            }
            .disabled(!availability.canChangeGatewayPower(item) || powerBusy.contains(item.gatewayId))
            .frame(minHeight: 44)
            .tint(Color.callerDanger)
            .accessibilityIdentifier("gatewayPower.toggle")
            if let disabledReason {
                Text(disabledReason).font(.caption2).foregroundStyle(.secondary)
            }
            if let pending = GatewayPowerPolicy.pendingTitle(item) {
                Label(pending, systemImage: "clock.arrow.circlepath").font(.caption2).foregroundStyle(Signal.warn)
            }
            if let lastResult = GatewayPowerPolicy.lastResultMessage(item) {
                Text(lastResult).font(.caption2).foregroundStyle(Color.callerDanger)
                    .accessibilityIdentifier("gatewayPower.lastResult")
                    .reportsError(lastResult, screen: "settings", site: "gateway_power_result")
            }
            if let success = GatewayPowerPolicy.lastResultSuccessMessage(item) {
                Text(success).font(.caption2).foregroundStyle(Signal.call)
                    .accessibilityIdentifier("gatewayPower.lastResultSuccess")
            }
        }
        .padding(.vertical, 2)
    }

    private func pollGatewayPower() async {
        guard let identity = session.sessionIdentity else { return }
        // Re-probe on every appearance: a Control deployed mid-session gains the route without an app restart.
        powerUnavailable = false
        while !Task.isCancelled, session.isCurrentSession(identity), !powerUnavailable {
            await loadGatewayPower(requiredIdentity: identity)
            do { try await Task.sleep(for: GatewayPowerPolicy.refreshInterval) } catch { return }
        }
    }

    func loadGatewayPower(requiredIdentity identity: UUID? = nil) async {
        guard let identity = identity ?? session.sessionIdentity,
              session.isCurrentSession(identity) else { return }
        gatewayLoadGeneration += 1
        let generation = gatewayLoadGeneration
        do {
            let response: ItemEnvelope<GatewayPower> = try await session.request(
                "gateways/power", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == gatewayLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            gateways = response.items
            powerError = nil
            gatewaysLoaded = true
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == gatewayLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            gatewaysLoaded = true
            if case APIError.server(404, _, _) = error {
                gateways = []
                powerUnavailable = true
                return
            }
            powerError = GatewayPowerPolicy.message(for: error)
        }
    }

    private func requestGatewayPowerOff(_ item: GatewayPower) {
        guard let identity = session.sessionIdentity, session.isCurrentSession(identity) else { return }
        gatewayPowerOffConfirmation = PendingGatewayPowerOff(
            gatewayID: item.gatewayId, gatewayName: GatewayPowerPolicy.displayName(item),
            sessionIdentity: identity
        )
    }

    func setGatewayPower(_ item: GatewayPower, on: Bool, requiredIdentity: UUID? = nil) async {
        guard availability.canMutate else { return }
        guard !powerBusy.contains(item.gatewayId),
              let identity = requiredIdentity ?? session.sessionIdentity,
              session.isCurrentSession(identity) else { return }
        powerBusy.insert(item.gatewayId)
        defer { if session.isCurrentSession(identity) { powerBusy.remove(item.gatewayId) } }
        do {
            let response: GatewayPowerEnvelope = try await session.request(
                "gateways/\(item.gatewayId)/power", method: "POST",
                body: GatewayPowerBody(desired: on ? "on" : "off"), timeoutInterval: 15,
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            gatewayLoadGeneration += 1
            if let index = gateways.firstIndex(where: { $0.gatewayId == response.item.gatewayId }) {
                gateways[index] = response.item
            }
            powerError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            powerError = GatewayPowerPolicy.message(for: error)
            await loadGatewayPower(requiredIdentity: identity)
        }
    }

    /// Icon + name + what the authenticator is + when it was added and last used, so two passkeys are never
    /// indistinguishable. Rename and delete are offered as swipe actions and in a context menu for discoverability.
    @ViewBuilder private func passkeyRow(_ item: PasskeyItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.symbolName)
                .font(.title3).foregroundStyle(.tint).frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.resolvedName).font(.body.weight(.semibold))
                Text(item.platformSummary).font(.caption).foregroundStyle(.secondary)
                Text("添加于 \(displayDate(item.createdAt))").font(.caption2).foregroundStyle(.secondary)
                Text(item.lastUsedAt.map { "最近使用 \(displayDate($0))" } ?? "尚未使用")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            // The four lines stay one VoiceOver element; the menu below stays a separate, reachable one.
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(item.resolvedName)，\(item.platformSummary)")
            Spacer(minLength: 0)
            // Swipe and long-press are not discoverable; a visible menu is the third, findable way in.
            Menu {
                Button("重命名", systemImage: "pencil") { beginRename(item) }
                Button("删除", systemImage: "trash", role: .destructive) { passkeyToDelete = item }
            } label: {
                Image(systemName: "ellipsis.circle").font(.title3)
                    .frame(minWidth: 44, minHeight: 44, alignment: .trailing)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("\(item.resolvedName) 的更多操作")
            .accessibilityIdentifier("passkey.menu")
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("删除", role: .destructive) { passkeyToDelete = item }
            Button("重命名") { beginRename(item) }.tint(.accentColor)
        }
        .contextMenu {
            Button("重命名", systemImage: "pencil") { beginRename(item) }
            Button("删除", systemImage: "trash", role: .destructive) { passkeyToDelete = item }
        }
    }

    private func beginRename(_ item: PasskeyItem) {
        renameError = nil
        renameText = item.resolvedName
        passkeyToRename = item
    }

    func renamePasskey(_ item: PasskeyItem) async {
        guard availability.canMutate else { return }
        passkeyToRename = nil
        guard let label = PasskeyDisplayPolicy.normalizedLabel(renameText) else {
            renameError = PasskeyDisplayPolicy.labelValidationMessage
            return
        }
        guard let identity = session.sessionIdentity else { return }
        passkeyLoadGeneration += 1
        do {
            let _: EmptyResponse = try await session.request(
                "passkeys/\(item.id)", method: "PATCH", body: PasskeyLabelBody(label: label),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            passkeyLoadGeneration += 1
            if let index = passkeys.firstIndex(where: { $0.id == item.id }) {
                passkeys[index] = replacingPasskeyLabel(passkeys[index], with: label)
            }
            passkeysLoaded = true
            passkeyRefreshError = nil
            renameError = nil
            await loadPasskeys(requiredIdentity: identity)
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            renameError = error.localizedDescription
        }
    }

    private struct PasskeyLabelBody: Encodable, Sendable { let label: String }

    private func replacingPasskeyLabel(_ item: PasskeyItem, with label: String) -> PasskeyItem {
        PasskeyItem(
            id: item.id, createdAt: item.createdAt, deviceType: item.deviceType, backedUp: item.backedUp,
            transports: item.transports, label: label, displayName: item.displayName, aaguid: item.aaguid,
            clientPlatform: item.clientPlatform, authenticatorAttachment: item.authenticatorAttachment,
            lastUsedAt: item.lastUsedAt
        )
    }

    func load() async { await refreshApplicationStatus() }

    private func loadSimsAndProvider(requiredIdentity: UUID? = nil) async {
        guard let identity = requiredIdentity ?? session.sessionIdentity,
              session.isCurrentSession(identity) else { return }
        settingsLoadGeneration += 1
        let generation = settingsLoadGeneration
        do {
            let result: ItemEnvelope<SIMChannel> = try await session.request(
                "sims", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == settingsLoadGeneration,
                  session.sessionIdentity == identity else { return }
            sims = result.items
            error = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == settingsLoadGeneration,
                  session.sessionIdentity == identity else { return }
            self.error = error.localizedDescription
        }
        loaded = true
        guard session.isCurrentSession(identity) else { return }
        await loadVoiceProviders(requiredIdentity: identity)
    }

    private func refreshApplicationStatus() async {
        guard let identity = session.sessionIdentity, session.isCurrentSession(identity) else { return }
        prepareSessionData(for: identity)
        guard !refreshingApplicationStatus else { return }
        refreshingApplicationStatus = true
        defer {
            if session.isCurrentSession(identity) { refreshingApplicationStatus = false }
        }
        await refreshSettingsSnapshot(requiredIdentity: identity, syncPush: true)
    }

    private func refreshSettingsSnapshot(requiredIdentity identity: UUID, syncPush: Bool) async {
        guard session.isCurrentSession(identity) else { return }
        powerUnavailable = false
        await loadSimsAndProvider(requiredIdentity: identity)
        guard session.isCurrentSession(identity) else { return }
        await loadPasskeys(requiredIdentity: identity)
        await loadBlocklist(requiredIdentity: identity)
        await loadGatewayPower(requiredIdentity: identity)
        await loadPermissionStatus(requiredIdentity: identity)
        guard syncPush, session.isCurrentSession(identity) else { return }
        await push.sync()
    }

    private func prepareSessionData(for identity: UUID) {
        guard dataSessionIdentity != identity else { return }
        clearSessionData()
        dataSessionIdentity = identity
    }

    private func clearSessionData() {
        settingsLoadGeneration += 1
        voiceProviderLoadGeneration += 1
        gatewayLoadGeneration += 1
        passkeyLoadGeneration += 1
        blocklistLoadGeneration += 1
        permissionLoadGeneration += 1
        dataSessionIdentity = nil
        sims = []
        loaded = false
        error = nil
        voiceProviders = []
        voiceProviderSelected = nil
        voiceProviderConfigVersion = 1
        voiceProvidersLoaded = false
        voiceProviderUnavailable = false
        voiceProviderRefreshError = nil
        voiceProviderOperationError = nil
        voiceProviderConflict = nil
        voiceProviderConflictReloading = false
        voiceProviderBusy = nil
        passkeys = []
        passkeysLoaded = false
        passkeyRefreshError = nil
        passkeyToDelete = nil
        passkeyToRename = nil
        renameText = ""
        renameError = nil
        passkey.errorMessage = nil
        passkey.statusMessage = nil
        blockedNumbers = []
        blockedSMSNumbers = []
        blocklistLoaded = false
        blocklistRefreshError = nil
        gateways = []
        gatewaysLoaded = false
        powerUnavailable = false
        powerError = nil
        powerBusy = []
        gatewayPowerOffConfirmation = nil
        permissionsLoaded = false
        permissionActionError = nil
        refreshingApplicationStatus = false
    }

    private func loadBlocklist(requiredIdentity: UUID? = nil) async {
        guard let identity = requiredIdentity ?? session.sessionIdentity,
              session.isCurrentSession(identity) else { return }
        blocklistLoadGeneration += 1
        let generation = blocklistLoadGeneration
        do {
            let calls: ItemEnvelope<BlocklistItem> = try await session.request(
                "blocklist", requiredSessionIdentity: identity, queryItems: BlocklistScope.call.queryItems
            )
            let sms: ItemEnvelope<BlocklistItem> = try await session.request(
                "blocklist", requiredSessionIdentity: identity, queryItems: BlocklistScope.sms.queryItems
            )
            guard !Task.isCancelled, generation == blocklistLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            blockedNumbers = calls.items
            blockedSMSNumbers = sms.items
            blocklistLoaded = true
            blocklistRefreshError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == blocklistLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            blocklistLoaded = true
            blocklistRefreshError = error.localizedDescription
        }
    }

    private func loadPermissionStatus(requiredIdentity identity: UUID? = nil) async {
        guard let identity = identity ?? session.sessionIdentity,
              session.isCurrentSession(identity) else { return }
        permissionLoadGeneration += 1
        let generation = permissionLoadGeneration
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        guard !Task.isCancelled, generation == permissionLoadGeneration,
              session.isCurrentSession(identity) else { return }
        notificationPermission = Self.notificationPermissionState(notificationSettings.authorizationStatus)
        microphonePermission = Self.currentMicrophonePermissionState
        permissionsLoaded = true
    }

    private func resolveNotificationPermission() async {
        guard let identity = session.sessionIdentity else { return }
        permissionActionError = nil
        if notificationPermission == .notDetermined {
            do {
                _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                guard session.isCurrentSession(identity) else { return }
                UIApplication.shared.registerForRemoteNotifications()
            } catch {
                guard session.isCurrentSession(identity) else { return }
                permissionActionError = error.localizedDescription
            }
        } else {
            await openSystemSettings(requiredIdentity: identity)
        }
        await loadPermissionStatus(requiredIdentity: identity)
    }

    private func resolveMicrophonePermission() async {
        guard let identity = session.sessionIdentity else { return }
        permissionActionError = nil
        if microphonePermission == .notDetermined {
            _ = await AVAudioApplication.requestRecordPermission()
            guard session.isCurrentSession(identity) else { return }
        } else {
            await openSystemSettings(requiredIdentity: identity)
        }
        await loadPermissionStatus(requiredIdentity: identity)
    }

    private func openSystemSettings(requiredIdentity identity: UUID) async {
        guard session.isCurrentSession(identity),
              let url = URL(string: UIApplication.openSettingsURLString) else { return }
        let opened = await UIApplication.shared.open(url)
        guard session.isCurrentSession(identity), !opened else { return }
        permissionActionError = "无法打开系统设置，请稍后重试。"
    }

    private static func notificationPermissionState(_ value: UNAuthorizationStatus) -> SettingsPermissionState {
        switch value {
        case .authorized, .provisional, .ephemeral: .allowed
        case .denied: .denied
        case .notDetermined: .notDetermined
        @unknown default: .unavailable
        }
    }

    private static var currentMicrophonePermissionState: SettingsPermissionState {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .allowed
        case .denied: .denied
        case .undetermined: .notDetermined
        @unknown default: .unavailable
        }
    }

    private func registerPasskey() async {
        guard availability.canMutate else { return }
        guard let identity = session.sessionIdentity else { return }
        await passkey.register(session: session)
        guard session.isCurrentSession(identity) else { return }
        await loadPasskeys(requiredIdentity: identity)
    }
    func loadPasskeys(requiredIdentity: UUID? = nil) async {
        guard let identity = requiredIdentity ?? session.sessionIdentity,
              session.isCurrentSession(identity) else { return }
        passkeyLoadGeneration += 1
        let generation = passkeyLoadGeneration
        do {
            let result: ItemEnvelope<PasskeyItem> = try await session.request(
                "passkeys", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == passkeyLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            passkeys = result.items
            passkeysLoaded = true
            passkeyRefreshError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, generation == passkeyLoadGeneration,
                  session.isCurrentSession(identity) else { return }
            passkeysLoaded = true
            passkeyRefreshError = error.localizedDescription
        }
    }
    func deletePasskey(_ item: PasskeyItem) async {
        guard availability.canMutate else { return }
        guard let identity = session.sessionIdentity else { return }
        passkeyLoadGeneration += 1
        do {
            let _: EmptyResponse = try await session.request(
                "passkeys/\(item.id)", method: "DELETE", requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            passkeyLoadGeneration += 1
            passkeys.removeAll { $0.id == item.id }
            passkeysLoaded = true
            passkeyRefreshError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            passkey.errorMessage = error.localizedDescription
        }
    }
    func modeTitle(_ mode: String?) -> String { ReceptionMode(rawValue: mode ?? "")?.title ?? "未设置" }
}

struct SIMSettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(AppNavigation.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase
    let sim: SIMChannel; let onSaved: () async -> Void
    /// Latest server truth. Draft values and the versions they were based on are stored separately below.
    @State private var settings: SIMSettings?
    @State private var mode: ReceptionMode
    @State private var timeout: Double
    @State private var settingsBaseMode: String
    @State private var settingsBaseTimeout: Int
    @State private var settingsExpectedVersion: Int?
    @State private var settingsConflict = false
    @State private var notesBaseLabel: String
    @State private var notesBasePhoneLabel: String
    @State private var identityExpectedVersion: Int?
    @State private var notesConflict = false
    @State private var operationError: String?
    @State private var refreshError: String?
    @State private var saving = false
    @State private var notesSaving = false
    @State private var conflictReloading = false
    @State private var labelText: String
    @State private var phoneLabelText: String
    @State private var observationGeneration = 0
    /// 应用状态 after the last save in this screen. The PUT response is stale by design (Control writes the
    /// desired version; the gateway acks it a beat later), so the block is driven by a poll, not by the response.
    @State private var applyState: SettingsApplyPolicy.State = .idle
    @State private var applyTask: Task<Void, Never>?

    init(sim: SIMChannel, onSaved: @escaping () async -> Void) {
        self.sim = sim; self.onSaved = onSaved
        _settings = State(initialValue: sim.settings)
        _mode = State(initialValue: ReceptionMode(rawValue: sim.settings?.mode ?? "normal") ?? .normal)
        _timeout = State(initialValue: Double(sim.settings?.timeoutSeconds ?? 45))
        _settingsBaseMode = State(initialValue: sim.settings?.mode ?? "normal")
        _settingsBaseTimeout = State(initialValue: sim.settings?.timeoutSeconds ?? 45)
        _settingsExpectedVersion = State(initialValue: sim.settings?.version)
        _labelText = State(initialValue: sim.label ?? "")
        _phoneLabelText = State(initialValue: sim.phoneLabel ?? "")
        _notesBaseLabel = State(initialValue: sim.label ?? "")
        _notesBasePhoneLabel = State(initialValue: sim.phoneLabel ?? "")
        _identityExpectedVersion = State(initialValue: sim.version)
    }

    private var settingsDraftIsDirty: Bool {
        mode.rawValue != settingsBaseMode || Int(timeout) != settingsBaseTimeout
    }

    private var notesDraftIsDirty: Bool {
        labelText.trimmingCharacters(in: .whitespacesAndNewlines)
            != notesBaseLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            || phoneLabelText.trimmingCharacters(in: .whitespacesAndNewlines)
            != notesBasePhoneLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var controlsBusy: Bool { saving || notesSaving || conflictReloading }

    private var showsCachedSettings: Bool {
        !availability.canMutate || !availability.hasCurrentSIMSnapshot || refreshError != nil
            || availability.sims.first(where: { $0.id == sim.id })?.online != true
    }

    var body: some View {
        Form {
            Group {
            if availability.reason != nil { Section { NetworkAvailabilityNotice() } }
            Section {
                TextField("显示名称", text: $labelText)
                    .textInputAutocapitalization(.never)
                    .frame(minHeight: 44)
                    .disabled(!availability.canMutate || controlsBusy)
                TextField("号码标注", text: $phoneLabelText)
                    .textInputAutocapitalization(.never)
                    .frame(minHeight: 44)
                    .disabled(!availability.canMutate || controlsBusy)
                Button {
                    Task { await saveNotes() }
                } label: {
                    if notesSaving { ProgressView() } else { Text("保存备注") }
                }
                .disabled(
                    !availability.canMutate || saving || notesSaving || notesConflict
                        || labelText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || identityExpectedVersion == nil
                )
                .frame(minHeight: 44)
                if notesDraftIsDirty {
                    Text("未保存设置").font(.caption).foregroundStyle(Color.callerDanger)
                        .accessibilityIdentifier("simSettings.notesUnsaved")
                }
                if notesConflict {
                    Label(SIMDraftConcurrencyPolicy.notesConflictMessage, systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote).foregroundStyle(Color.callerDanger)
                        .reportsError(notesConflict, message: SIMDraftConcurrencyPolicy.notesConflictMessage, screen: "sim_settings", site: "notes_conflict")
                    Button("载入最新备注（替换当前草稿）") {
                        Task { await reloadLatestNotes() }
                    }
                    .disabled(!availability.canMutate || controlsBusy)
                    .accessibilityIdentifier("simSettings.reloadNotesConflict")
                }
            } header: {
                Text("号码备注")
            } footer: {
                Text("仅修改显示名称，不会更换 SIM 身份或中断通话。")
            }
            Section {
                Picker("模式", selection: $mode) {
                    ForEach(ReceptionMode.allCases) { candidate in
                        Text(candidate.title).tag(candidate).disabled(settings?.isAvailable(candidate) != true)
                    }
                }
                .disabled(!availability.canMutate || controlsBusy)
                if let reason = settings?.aiUnavailableReason, !reason.isEmpty {
                    Label(reason, systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary)
                } else if settings?.isAvailable(.ai) != true || settings?.isAvailable(.timeoutAI) != true {
                    Label("当前号码暂不支持 AI 接听模式。", systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary)
                }
                if settingsConflict {
                    Label(SIMDraftConcurrencyPolicy.settingsConflictMessage, systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote).foregroundStyle(Color.callerDanger)
                        .reportsError(settingsConflict, message: SIMDraftConcurrencyPolicy.settingsConflictMessage, screen: "sim_settings", site: "settings_conflict")
                    Button("载入最新设置（替换当前草稿）") {
                        Task { await reloadLatestSettings() }
                    }
                    .disabled(!availability.canMutate || controlsBusy)
                    .accessibilityIdentifier("simSettings.reloadSettingsConflict")
                }
            } header: { Text("接听模式") }
            if mode == .timeoutAI {
                Section("超时") {
                    Slider(value: $timeout, in: 10...120, step: 5).disabled(!availability.canMutate || controlsBusy)
                    LabeledContent("等待时间", value: "\(Int(timeout)) 秒")
                }
            }
            if settingsDraftIsDirty {
                Section {
                    Text("未保存设置").font(.caption).foregroundStyle(Color.callerDanger)
                        .accessibilityIdentifier("simSettings.modeUnsaved")
                }
            }
            Section("应用状态") {
                if showsCachedSettings {
                    Label("已加载快照", systemImage: "clock.arrow.circlepath")
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityIdentifier("simSettings.cachedSnapshot")
                    Text(!availability.canMutate
                         ? "以下版本为上次读取的记录，不代表当前设备确认；联网后可修改设置。"
                         : "以下版本为上次读取的记录，不代表当前设备确认；草稿仍可编辑。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                LabeledContent(showsCachedSettings ? "服务器版本（快照）" : "服务器版本", value: String(settings?.version ?? sim.version ?? 0))
                LabeledContent("草稿基于版本", value: settingsExpectedVersion.map(String.init) ?? "未知")
                LabeledContent(showsCachedSettings ? "设备已应用（快照）" : "设备已应用", value: settings?.appliedVersion.map(String.init) ?? "尚未确认")
                if !showsCachedSettings { applyStatusLine }
            }
            if let operationError {
                Section {
                    Text(operationError).foregroundStyle(Color.callerDanger)
                        .reportsError(operationError, screen: "sim_settings", site: "operation")
                }
            }
            if let refreshError {
                Section {
                    Text(refreshError).font(.footnote).foregroundStyle(Color.callerDanger)
                        .reportsError(refreshError, screen: "sim_settings", site: "refresh")
                }
            }
            Section {
                Button { Task { await save() } } label: {
                    if saving { ProgressView() } else { Text("保存设置") }
                }
                .disabled(
                    !availability.canMutate || saving || notesSaving || settingsConflict || settingsExpectedVersion == nil
                        || settings?.isAvailable(mode) != true
                )
            }
            }
            .listRowBackground(Signal.surface)
        }
        .signalList().navigationTitle(labelText.isEmpty ? (sim.label ?? "SIM 设置") : labelText).navigationBarTitleDisplayMode(.inline)
        .task(id: "\(session.sessionIdentity?.uuidString ?? "none"):\(navigation.tab):\(scenePhase)") {
            guard let identity = session.sessionIdentity, navigation.tab == .settings, scenePhase == .active else { return }
            await refreshServerTruth(requiredIdentity: identity)
            while !Task.isCancelled, session.isCurrentSession(identity),
                  navigation.tab == .settings, scenePhase == .active {
                do { try await Task.sleep(for: ForegroundRefreshPolicy.interval) } catch { return }
                await refreshServerTruth(requiredIdentity: identity)
            }
        }
        // Leaving the screen must not leave a poll running against a view that is gone.
        .onDisappear { applyTask?.cancel(); applyTask = nil }
    }

    /// 正在应用中… while the gateway has not answered yet, 应用成功 the moment it confirms this exact version,
    /// and the original orange sentence once the window closes without an ack.
    @ViewBuilder private var applyStatusLine: some View {
        let status = SettingsApplyPolicy.label(
            applyState, appliedVersion: settings?.appliedVersion, version: settings?.version
        )
        switch status.tone {
        case .pending:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(status.text).font(.footnote).foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("simSettings.applyStatus")
        case .success:
            Label(status.text, systemImage: "checkmark.circle.fill")
                .font(.footnote).foregroundStyle(Signal.call)
                .accessibilityIdentifier("simSettings.applyStatus")
        case .warning:
            Text(status.text).font(.footnote).foregroundStyle(Signal.warn)
                .accessibilityIdentifier("simSettings.applyStatus")
        case .none:
            EmptyView()
        }
    }
    func saveNotes() async {
        guard availability.canMutate else { return }
        let label = labelText.trimmingCharacters(in: .whitespacesAndNewlines)
        let phone = phoneLabelText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let version = identityExpectedVersion, !label.isEmpty, !notesConflict,
              let identity = session.sessionIdentity,
              !saving, !notesSaving, !conflictReloading else { return }
        observationGeneration += 1
        notesSaving = true; defer { if session.isCurrentSession(identity) { notesSaving = false } }
        operationError = nil
        do {
            let response: SIMNotesEnvelope = try await session.request(
                "sims/\(sim.id)", method: "PUT",
                body: SIMNotesBody(label: label, phoneLabel: phone.isEmpty ? nil : phone, expectedVersion: version),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            labelText = response.sim.label ?? label
            phoneLabelText = response.sim.phoneLabel ?? ""
            notesBaseLabel = labelText
            notesBasePhoneLabel = phoneLabelText
            identityExpectedVersion = response.sim.version
            notesConflict = false
            operationError = nil
            await onSaved()
        } catch SessionLifecycleError.staleSession {
            return
        } catch where SIMDraftConcurrencyPolicy.isConflict(error) {
            guard session.isCurrentSession(identity) else { return }
            notesConflict = true
            operationError = SIMDraftConcurrencyPolicy.notesConflictMessage
            notesSaving = false
            await refreshServerTruth(requiredIdentity: identity)
        } catch {
            guard session.isCurrentSession(identity) else { return }
            operationError = error.localizedDescription
        }
    }
    func save() async {
        guard availability.canMutate else { return }
        guard let version = settingsExpectedVersion, !settingsConflict, !saving, !notesSaving, !conflictReloading,
              settings?.isAvailable(mode) == true, let identity = session.sessionIdentity else { return }
        observationGeneration += 1
        saving = true; defer { if session.isCurrentSession(identity) { saving = false } }
        operationError = nil
        do {
            let response: SettingsEnvelope = try await session.request(
                "sims/\(sim.id)/settings", method: "PUT",
                body: SettingsBody(mode: mode.rawValue, timeoutSeconds: Int(timeout), expectedVersion: version),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            adoptSettings(response.settings.mergingCapabilities(from: settings))
            operationError = nil
            beginApplyPolling(target: response.settings.version)
            await onSaved()
        } catch SessionLifecycleError.staleSession {
            return
        } catch where SIMDraftConcurrencyPolicy.isConflict(error) {
            guard session.isCurrentSession(identity) else { return }
            settingsConflict = true
            operationError = SIMDraftConcurrencyPolicy.settingsConflictMessage
            applyTask?.cancel(); applyTask = nil; applyState = .idle
            saving = false
            await refreshServerTruth(requiredIdentity: identity)
        } catch {
            guard session.isCurrentSession(identity) else { return }
            operationError = error.localizedDescription
            // A refused save must not leave an older save's 正在应用中… on screen; fall back to the versions.
            applyTask?.cancel(); applyTask = nil; applyState = .idle
        }
    }

    /// The PUT response can never carry the ack, so watch `GET /sims` for it. The same list call the parent
    /// uses — this view just keeps its own copy of `settings` in step instead of waiting to be popped.
    private func beginApplyPolling(target: Int) {
        applyTask?.cancel()
        applyState = .applying(started: .now, target: target)
        applyTask = Task { await pollApplied() }
    }

    private func pollApplied() async {
        guard let identity = session.sessionIdentity else { return }
        while !Task.isCancelled, session.isCurrentSession(identity),
              navigation.tab == .settings, scenePhase == .active {
            do { try await Task.sleep(for: SettingsApplyPolicy.pollInterval) } catch { return }
            guard !Task.isCancelled, !saving, !notesSaving else { continue }
            observationGeneration += 1
            let generation = observationGeneration
            do {
                let response: ItemEnvelope<SIMChannel> = try await session.request(
                    "sims", requiredSessionIdentity: identity
                )
                guard !Task.isCancelled, generation == observationGeneration,
                      session.isCurrentSession(identity) else { return }
                if let current = response.items.first(where: { $0.id == sim.id }) {
                    observe(current)
                }
            } catch SessionLifecycleError.staleSession {
                return
            } catch {
                // A transient list failure is not a save failure: keep the banner clean and let the clock run.
            }
            guard !Task.isCancelled else { return }
            applyState = SettingsApplyPolicy.next(
                applyState, now: .now, appliedVersion: settings?.appliedVersion, version: settings?.version
            )
            switch applyState {
            case .applied, .superseded, .timedOut, .idle: return
            case .applying: continue
            }
        }
    }
    @discardableResult
    private func refreshServerTruth(
        requiredIdentity identity: UUID?, acceptingSettingsConflict: Bool = false,
        acceptingNotesConflict: Bool = false
    ) async -> Bool {
        guard let identity, session.isCurrentSession(identity), !saving, !notesSaving else { return false }
        observationGeneration += 1
        let generation = observationGeneration
        do {
            let response: ItemEnvelope<SIMChannel> = try await session.request(
                "sims", requiredSessionIdentity: identity
            )
            guard !Task.isCancelled, generation == observationGeneration,
                  session.isCurrentSession(identity) else { return false }
            if let current = response.items.first(where: { $0.id == sim.id }) {
                observe(
                    current, acceptingSettingsConflict: acceptingSettingsConflict,
                    acceptingNotesConflict: acceptingNotesConflict
                )
            }
            refreshError = nil
            return true
        } catch SessionLifecycleError.staleSession {
            return false
        } catch {
            guard !Task.isCancelled, generation == observationGeneration,
                  session.isCurrentSession(identity) else { return false }
            refreshError = error.localizedDescription
            return false
        }
    }

    private func observe(
        _ current: SIMChannel, acceptingSettingsConflict: Bool = false,
        acceptingNotesConflict: Bool = false
    ) {
        let settingsWereDirty = settingsDraftIsDirty
        let notesWereDirty = notesDraftIsDirty
        if let currentSettings = current.settings?.mergingCapabilities(from: settings) {
            settings = currentSettings
            if acceptingSettingsConflict {
                adoptSettings(currentSettings)
            } else if !settingsConflict {
                if SIMDraftConcurrencyPolicy.hasExternalChange(
                    currentVersion: currentSettings.version,
                    baseVersion: settingsExpectedVersion,
                    draftIsDirty: settingsWereDirty
                ) {
                    settingsConflict = true
                } else if !settingsWereDirty {
                    adoptSettings(currentSettings)
                }
            }
        }
        if acceptingNotesConflict {
            adoptNotes(current)
        } else if !notesConflict {
            if SIMDraftConcurrencyPolicy.hasExternalChange(
                currentVersion: current.version,
                baseVersion: identityExpectedVersion,
                draftIsDirty: notesWereDirty
            ) {
                notesConflict = true
            } else if !notesWereDirty {
                adoptNotes(current)
            }
        }
        applyState = SettingsApplyPolicy.next(
            applyState, now: .now, appliedVersion: settings?.appliedVersion, version: settings?.version
        )
    }

    private func adoptSettings(_ current: SIMSettings) {
        settings = current
        mode = ReceptionMode(rawValue: current.mode) ?? .normal
        timeout = Double(current.timeoutSeconds)
        settingsBaseMode = current.mode
        settingsBaseTimeout = current.timeoutSeconds
        settingsExpectedVersion = current.version
        settingsConflict = false
    }

    private func adoptNotes(_ current: SIMChannel) {
        labelText = current.label ?? ""
        phoneLabelText = current.phoneLabel ?? ""
        notesBaseLabel = labelText
        notesBasePhoneLabel = phoneLabelText
        identityExpectedVersion = current.version
        notesConflict = false
    }

    private func reloadLatestSettings() async {
        guard settingsConflict, !conflictReloading else { return }
        conflictReloading = true
        defer { conflictReloading = false }
        if await refreshServerTruth(
            requiredIdentity: session.sessionIdentity, acceptingSettingsConflict: true
        ) { operationError = nil }
    }

    private func reloadLatestNotes() async {
        guard notesConflict, !conflictReloading else { return }
        conflictReloading = true
        defer { conflictReloading = false }
        if await refreshServerTruth(
            requiredIdentity: session.sessionIdentity, acceptingNotesConflict: true
        ) { operationError = nil }
    }
    private struct SettingsBody: Encodable { let mode: String; let timeoutSeconds, expectedVersion: Int }
    private struct SettingsEnvelope: Decodable { let settings: SIMSettings }
    private struct SIMNotesBody: Encodable {
        let label: String
        let phoneLabel: String?
        let expectedVersion: Int
        enum CodingKeys: String, CodingKey { case label, phoneLabel, expectedVersion }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(label, forKey: .label)
            try container.encode(phoneLabel, forKey: .phoneLabel)
            try container.encode(expectedVersion, forKey: .expectedVersion)
        }
    }
    private struct SIMNotesEnvelope: Decodable {
        let sim: SIMNotesResult
    }
    private struct SIMNotesResult: Decodable {
        let version: Int
        let label: String?
        let phoneLabel: String?
    }
}
