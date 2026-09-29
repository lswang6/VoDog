import SwiftUI

/// "VoDog 网关" card in Settings › 蜂窝与通信 (S53, S54 一机多模组): the per-Mac master
/// switch plus one row per attached module.
struct GatewaySettingsSection: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var gateway: GatewayAgent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(L10n.tr("VoDog 网关"))
                .font(.headline)
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 12)

            Divider().padding(.horizontal, 16)

            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L10n.tr("启用网关")).font(.headline)
                        Text(L10n.tr("开启后由 VoDog 远程接听、拨号和收发短信；本机来电窗口不再显示接听按钮。"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 16)
                    Toggle(L10n.tr("启用网关"), isOn: Binding(
                        get: { gateway.isEnabled },
                        set: { gateway.setEnabled($0) }
                    ))
                    .labelsHidden()
                    .toggleStyle(.adaptiveGlass)
                }

                LabeledContent(L10n.tr("服务器地址")) {
                    TextField(GatewayAgent.defaultBaseURL, text: $gateway.baseURLString)
                        .textFieldStyle(.roundedBorder)
                        .disabled(gateway.isEnabled)
                }

                if gateway.runtimes.isEmpty {
                    Text(L10n.tr("未检测到模组")).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(gateway.runtimes) { runtime in
                    Divider()
                    GatewayModuleRow(runtime: runtime, account: appState.voDog)
                }
            }
            .padding(16)
        }
        .adaptiveGlassSurface(cornerRadius: 18, treatment: .regular)
    }
}

private struct GatewayModuleRow: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var runtime: GatewayRuntime
    @ObservedObject var account: VoDogAccount
    @State private var pairingCode = ""

    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { _ in
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(verbatim: title).font(.subheadline.weight(.semibold))
                    Text(stateText).font(.caption.weight(.semibold)).foregroundStyle(stateColor)
                    Spacer(minLength: 8)
                    if runtime.credentials != nil {
                        Toggle(L10n.tr("暂停"), isOn: Binding(
                            get: { runtime.isPaused },
                            set: { runtime.setPaused($0) }
                        ))
                        .toggleStyle(.checkbox)
                    }
                }
                if let sim = runtime.sim {
                    line("SIM", "\(sim.label ?? "SIM 1") · v\(sim.assignmentVersion)")
                }
                if let heartbeat = runtime.lastHeartbeatAt {
                    line(L10n.tr("最近心跳"), heartbeat.formatted(date: .omitted, time: .standard))
                }
                if let error = runtime.lastError {
                    line(L10n.tr("最近错误"), error, color: .orange)
                }
                if runtime.credentials == nil { unpairedControls }
                if let provision = runtime.provision, runtime.isProvisioning || provision.isFailed {
                    line(L10n.tr("加入账号"), provisionText(provision), color: provision.isFailed ? .orange : .secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var unpairedControls: some View {
        HStack {
            if account.user != nil && account.isAdmin {
                Button(runtime.provision?.isFailed == true ? L10n.tr("重试加入账号") : L10n.tr("加入账号")) {
                    runtime.startProvisioning(account: account)
                }
                .disabled(runtime.isProvisioning || runtime.isPairing)
            } else {
                Text(account.user == nil ? L10n.tr("登录 VoDog 后可一键加入") : L10n.tr("需管理员在 Web 分配"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            SecureField(L10n.tr("配对码"), text: $pairingCode)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 180)
            Button(L10n.tr("配对")) {
                runtime.pair(code: pairingCode)
                pairingCode = ""
            }
            .disabled(pairingCode.trimmingCharacters(in: .whitespaces).isEmpty || runtime.isPairing)
        }
    }

    /// `name · imei:后6位 · carrier · own number`.
    private var title: String {
        let state = appState.gatewayModuleState(imei: runtime.imei)
        let name = state.flatMap { state in appState.cellularModules.first { $0.id == state.id }?.displayName }
        return [name, runtime.displayKey, state?.modem.operatorName, state?.modem.simPhoneNumber]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " · ")
    }

    private var stateText: String {
        if runtime.credentials == nil { return L10n.tr("未配对") }
        if runtime.isPaused { return L10n.tr("暂停") }
        if runtime.isOnline { return L10n.tr("在线") }
        return runtime.lastError == nil ? L10n.tr("离线") : L10n.tr("错误")
    }

    private var stateColor: Color {
        if runtime.isOnline { return .green }
        return runtime.lastError != nil && runtime.credentials != nil ? .orange : .secondary
    }

    private func provisionText(_ provision: GatewayProvisionState) -> String {
        let step: String
        switch provision.step {
        case .createGateway: step = L10n.tr("创建网关")
        case .pairingCode: step = L10n.tr("生成配对码")
        case .pair: step = L10n.tr("配对")
        case .waitSIM: step = L10n.tr("等待 SIM 同步")
        case .assignOwner: step = L10n.tr("分配 SIM 到账号")
        case .labelSIM: step = L10n.tr("命名 SIM")
        case .done: step = L10n.tr("完成")
        }
        return provision.failure.map { "\(step) · \($0)" } ?? step
    }

    private func line(_ title: String, _ value: String, color: Color = .secondary) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).font(.caption.weight(.semibold))
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(color)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
