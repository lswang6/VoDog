import SwiftUI

struct ProxyManagementView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var controller: SOCKSProxyController
    @Binding var sidebarWidth: CGFloat
    @Binding var networkToolsTab: NetworkToolsTab
    @State private var selectedID: UUID?

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            sidebar
                .communicationSidebarColumnStyle()
                .communicationModuleFloatingSidebar()
        } detail: {
            detail
                .communicationDetailColumnStyle()
        }
        .onAppear { reconcileSelection() }
        .onChange(of: controller.store.configurations.map(\.id)) { _, _ in reconcileSelection() }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            NetworkToolsTabBar(selection: $networkToolsTab)

            HStack {
                Text(verbatim: L10n.tr("代理")).font(.title2.weight(.semibold))
                Spacer()
                CommunicationIconActionButton(
                    systemImage: "plus",
                    accessibilityLabel: L10n.tr("新建代理"),
                    action: createProxy
                )
                .disabled(availableModules.isEmpty)
            }
            .padding(16)

            if availableModules.isEmpty && controller.store.configurations.isEmpty {
                ContentUnavailableView(
                    L10n.tr("没有可用模组"),
                    systemImage: "antenna.radiowaves.left.and.right.slash",
                    description: Text(verbatim: L10n.tr("连接并识别蜂窝模组后即可创建代理。"))
                )
                .frame(maxHeight: .infinity)
            } else {
                List {
                    ForEach(availableModules) { module in
                        if let imei = module.modem.moduleIMEI {
                            Section(module.selectorTitle) {
                                ForEach(configurations(for: imei)) { config in
                                    ProxyRow(
                                        configuration: config,
                                        state: controller.runtimeStates[config.id] ?? .disabled
                                    )
                                    .communicationSelectionHighlight(selectedID == config.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture { selectedID = config.id }
                                    .accessibilityAddTraits(
                                        selectedID == config.id ? .isSelected : []
                                    )
                                    .tag(config.id)
                                }
                            }
                        }
                    }
                    if !orphanedConfigurations.isEmpty {
                        Section(L10n.tr("离线模组")) {
                            ForEach(orphanedConfigurations) { config in
                                ProxyRow(
                                    configuration: config,
                                    state: controller.runtimeStates[config.id]
                                        ?? .stoppedModuleOffline
                                )
                                .communicationSelectionHighlight(selectedID == config.id)
                                .contentShape(Rectangle())
                                .onTapGesture { selectedID = config.id }
                                .accessibilityAddTraits(
                                    selectedID == config.id ? .isSelected : []
                                )
                                .tag(config.id)
                            }
                        }
                    }
                }
                .listStyle(.sidebar)
                .communicationEmphasizedSelection()
            }
        }
    }

    @ViewBuilder private var detail: some View {
        if let selectedID,
           let configuration = controller.store.configurations.first(where: { $0.id == selectedID }) {
            ProxyEditorView(
                configuration: configuration,
                controller: controller,
                modules: availableModules,
                onDelete: { self.selectedID = nil }
            )
            // ProxyEditorView keeps an editable draft in local state. Give each
            // configuration its own identity so selecting another row replaces
            // that draft instead of continuing to edit the previous proxy.
            .id(configuration.id)
        } else {
            ContentUnavailableView(
                L10n.tr("选择代理"),
                systemImage: "point.forward.to.point.capsulepath",
                description: Text(verbatim: L10n.tr("选择现有代理或新建代理以编辑设置。"))
            )
        }
    }

    private var availableModules: [CellularModuleSummary] {
        appState.cellularModules.filter { $0.modem.moduleIMEI?.isEmpty == false }
    }

    private func configurations(for imei: String) -> [SOCKSProxyConfiguration] {
        controller.store.configurations.filter { $0.moduleIMEI == imei }
    }

    private var orphanedConfigurations: [SOCKSProxyConfiguration] {
        let presentIMEIs = Set(availableModules.compactMap(\.modem.moduleIMEI))
        return controller.store.configurations.filter { !presentIMEIs.contains($0.moduleIMEI) }
    }

    private func createProxy() {
        guard let module = availableModules.first, let imei = module.modem.moduleIMEI,
              let port = SOCKSProxyPortAllocator.nextAvailable(
                used: Set(controller.store.configurations.map(\.port))
              ) else { return }
        // A newly-created proxy remains unnamed and disabled until the user
        // reviews the draft, gives it a name, and explicitly enables it.
        let config = SOCKSProxyConfiguration.newDraft(moduleIMEI: imei, port: port)
        try? controller.store.save(config)
        selectedID = config.id
    }

    private func reconcileSelection() {
        let ids = controller.store.configurations.map(\.id)
        if let selectedID, ids.contains(selectedID) { return }
        selectedID = ids.first
    }
}

private struct ProxyRow: View {
    let configuration: SOCKSProxyConfiguration
    let state: SOCKSProxyRuntimeState

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(statusColor).frame(width: 8, height: 8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(configuration.name).lineLimit(1)
                    Spacer()
                    Text(verbatim: ":\(configuration.port)").foregroundStyle(.secondary)
                }
                Text(statusText).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 5)
    }

    private var statusColor: Color {
        switch state {
        case .running: return .green
        case .failedPortInUse, .failedToStart: return .red
        case .stoppedLinkDown, .stoppedMissingCredentials: return .orange
        default: return .secondary
        }
    }

    private var statusText: String {
        switch state {
        case let .running(connections): return L10n.tr("运行中 · %lld 个连接", Int64(connections))
        case .stoppedModuleOffline: return L10n.tr("已停止 · 模组离线")
        case .stoppedCellularDisabled: return L10n.tr("已停止 · 蜂窝网络关闭")
        case .stoppedLinkDown: return L10n.tr("已停止 · ECM 链路中断")
        case let .failedPortInUse(port): return L10n.tr("启动失败 · 端口 %lld 被占用", Int64(port))
        case let .failedToStart(reason): return L10n.tr("启动失败 · %@", reason)
        case .stoppedMissingCredentials: return L10n.tr("已停止 · 缺少认证密码")
        case .disabled: return L10n.tr("已停用")
        }
    }
}

private struct ProxyEditorView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var controller: SOCKSProxyController
    let modules: [CellularModuleSummary]
    let onDelete: () -> Void
    @State private var draft: SOCKSProxyConfiguration
    @State private var password: String
    @State private var errorMessage: String?

    init(
        configuration: SOCKSProxyConfiguration,
        controller: SOCKSProxyController,
        modules: [CellularModuleSummary],
        onDelete: @escaping () -> Void
    ) {
        _draft = State(initialValue: configuration)
        _password = State(initialValue: controller.store.password(for: configuration.id) ?? "")
        self.controller = controller
        self.modules = modules
        self.onDelete = onDelete
    }

    var body: some View {
        ScrollView {
            AdaptiveGlassContainer(spacing: 18) {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    settingsCard

                    if draft.listenScope == .lan {
                        warningCard
                    }
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                            .font(.callout)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .adaptiveGlassSurface(
                                cornerRadius: 14,
                                padding: 12,
                                treatment: .clear,
                                tint: Color.red.opacity(0.08)
                            )
                    }

                    actionBar
                }
            }
            .padding(28)
            .frame(maxWidth: 760, alignment: .leading)
        }
        .onChange(of: draft.listenScope) { _, scope in
            if scope == .lan, case .none = draft.authentication {
                draft.authentication = .usernamePassword(username: "")
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: L10n.tr("代理详情"))
                    .font(.title2.weight(.semibold))
                Text(draft.name.isEmpty ? L10n.tr("新建代理") : draft.name)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 16)
            runtimeBadge
                .adaptiveGlassSurface(
                    cornerRadius: 12,
                    padding: 8,
                    treatment: .clear
                )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var settingsCard: some View {
        Form {
            TextField(L10n.tr("名称"), text: $draft.name)
            Picker(L10n.tr("绑定模组"), selection: $draft.moduleIMEI) {
                ForEach(modules) { module in
                    if let imei = module.modem.moduleIMEI {
                        Text(verbatim: module.selectorTitle).tag(imei)
                    }
                }
            }
            Picker(L10n.tr("监听范围"), selection: $draft.listenScope) {
                Text(verbatim: L10n.tr("仅本机"))
                    .tag(SOCKSProxyConfiguration.ListenScope.loopback)
                Text(verbatim: L10n.tr("局域网"))
                    .tag(SOCKSProxyConfiguration.ListenScope.lan)
            }
            TextField(
                L10n.tr("端口"),
                value: $draft.port,
                format: .number.grouping(.never)
            )
            Picker(L10n.tr("认证"), selection: authenticationEnabled) {
                Text(verbatim: L10n.tr("无认证")).tag(false)
                Text(verbatim: L10n.tr("用户名密码")).tag(true)
            }
            if case let .usernamePassword(username) = draft.authentication {
                TextField(L10n.tr("用户名"), text: Binding(
                    get: { username },
                    set: { draft.authentication = .usernamePassword(username: $0) }
                ))
                SecureField(L10n.tr("密码"), text: $password)
            }
        }
        .formStyle(.columns)
        .controlSize(.regular)
        .adaptiveGlassSurface(
            cornerRadius: 20,
            padding: 18,
            treatment: .regular
        )
    }

    private var warningCard: some View {
        Label(
            L10n.tr("局域网模式必须使用用户名和密码。"),
            systemImage: "exclamationmark.triangle.fill"
        )
        .font(.callout)
        .foregroundStyle(.orange)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlassSurface(
            cornerRadius: 14,
            padding: 12,
            treatment: .clear,
            tint: Color.orange.opacity(0.09)
        )
    }

    private var actionBar: some View {
        HStack(spacing: 12) {
            Toggle(L10n.tr("已启用"), isOn: $draft.isEnabled)
                .toggleStyle(.adaptiveGlass)
                .controlSize(.small)
                .frame(maxWidth: 170)
            Spacer(minLength: 20)
            Button(L10n.tr("删除代理"), role: .destructive) {
                try? controller.store.delete(draft.id)
                controller.reconcile()
                onDelete()
            }
            .adaptiveGlassButton(.regular)
            Button(L10n.tr("保存")) { save() }
                .adaptiveGlassButton(.prominent)
                .keyboardShortcut("s", modifiers: [.command])
        }
        .adaptiveGlassSurface(
            cornerRadius: 16,
            padding: 12,
            treatment: .clear
        )
    }

    private var authenticationEnabled: Binding<Bool> {
        Binding(
            get: { if case .usernamePassword = draft.authentication { true } else { false } },
            set: { enabled in
                draft.authentication = enabled ? .usernamePassword(username: "") : .none
                if !enabled { password = "" }
            }
        )
    }

    @ViewBuilder private var runtimeBadge: some View {
        let state = controller.runtimeStates[draft.id] ?? .disabled
        if case let .running(connections) = state {
            Label(L10n.tr("运行中 · %lld", Int64(connections)), systemImage: "circle.fill")
                .foregroundStyle(.green).font(.callout)
        } else {
            Text(verbatim: L10n.tr("已停止")).foregroundStyle(.secondary).font(.callout)
        }
    }

    private func save() {
        errorMessage = nil
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, draft.port > 0 else { errorMessage = L10n.tr("名称和端口不能为空。"); return }
        if draft.listenScope == .lan, case .none = draft.authentication {
            errorMessage = L10n.tr("局域网监听必须启用用户名密码认证。"); return
        }
        if case let .usernamePassword(username) = draft.authentication,
           username.utf8.isEmpty || username.utf8.count > 255 ||
            password.utf8.isEmpty || password.utf8.count > 255 {
            errorMessage = L10n.tr("用户名和密码必须为 1–255 字节。"); return
        }
        draft.name = name
        do {
            try controller.store.save(draft, password: password)
            controller.reconcile()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
