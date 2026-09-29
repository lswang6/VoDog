import SwiftUI

// 号码与接听 and 账号 pages of the VoDog section (spec S54). Behaviour mirrors the iOS
// SettingsView / SIMSettingsView: expectedVersion CAS, dirty drafts never overwritten by refresh,
// S32 apply polling (2 s, 30 s), 404 on optional routes hides the block.

// MARK: Shared card chrome (same look as VoDogSettingsView's private helpers)

struct VoDogCard<Content: View>: View {
    let title: String
    var footer: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.headline)
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 12)
            Divider().padding(.horizontal, 16)
            VStack(alignment: .leading, spacing: 12) { content }
                .padding(16)
            if let footer {
                Text(footer)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlassSurface(cornerRadius: 18, treatment: .regular)
    }
}

extension View {
    /// S69 `ui.error_shown` for error text derived in a view body (no producer to report it): attach to the
    /// view that only exists while the error is on screen. Not for texts already reported by their builder.
    func reportsVoDogError(_ text: String, file: String = #fileID, site: String = #function) -> some View {
        onChange(of: text, initial: true) { _, new in VoDogErrorText.shown(new, file: file, site: site) }
    }
}

struct VoDogErrorLine: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: 号码与接听

struct VoDogNumbersView: View {
    @ObservedObject var account: VoDogAccount
    @State private var sidebarWidth: CGFloat = 300
    @State private var selectedID: String?

    private var sims: [VoDogSIM] { account.sims }
    private var loaded: Bool { account.simsLoaded }
    private var loadError: String? { account.simsError }

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            sidebar.communicationSidebarColumnStyle()
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let sim = sims.first(where: { $0.id == selectedID }) {
                        VoDogSIMDetail(account: account, sim: sim) { await load() }
                            .id(sim.id)
                    } else {
                        Text(loaded ? L10n.tr("选择一个号码查看接听设置") : L10n.tr("正在读取号码…"))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 120)
                    }
                    VoDogVoiceProviderCard(account: account)
                }
                .padding(22)
            }
            .scrollContentBackground(.hidden)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .communicationDetailColumnStyle()
        }
        .task {
            // ponytail: plain 5 s poll while the page is on screen (iOS ForegroundRefreshPolicy).
            while !Task.isCancelled, account.user != nil {
                await load()
                await VoDogPollCadence.sleep()
            }
        }
    }

    private var sidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.tr("号码与接听")).font(.title2.bold()).padding(.horizontal, 14).padding(.bottom, 8)
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if sims.isEmpty, loadError == nil {
                    Text(L10n.tr("没有已分配的 SIM")).foregroundStyle(.secondary).padding(.horizontal, 14)
                }
                ForEach(sims) { sim in row(sim) }
                if let loadError { VoDogErrorLine(text: loadError).padding(.horizontal, 14) }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 16)
        }
    }

    private func row(_ sim: VoDogSIM) -> some View {
        let selected = sim.id == selectedID
        return Button { selectedID = sim.id } label: {
            HStack(spacing: 11) {
                Image(systemName: "simcard")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(sim.displayName).font(.body.weight(selected ? .semibold : .regular))
                    Text([sim.phoneLabel, VoDogReceptionMode(rawValue: sim.settings?.mode ?? "")?.title]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                VoDogAnswerModeBadge(mode: sim.settings?.mode)
                let online = VoDogPhonePolicy.showsOnline(sim, fresh: loadError == nil)
                Circle().fill(online ? Color.green : Color.secondary.opacity(0.4)).frame(width: 7, height: 7)
                    .help(online ? L10n.tr("在线") : L10n.tr("离线"))
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 13, style: .continuous).fill(Color.accentColor.opacity(0.12))
            }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func load() async {
        await account.refreshSIMs()
        if selectedID == nil || !sims.contains(where: { $0.id == selectedID }) { selectedID = sims.first?.id }
    }
}

/// One SIM: 号码备注 (label/phoneLabel) and 接听模式, each with its own expectedVersion.
private struct VoDogSIMDetail: View {
    @ObservedObject var account: VoDogAccount
    let sim: VoDogSIM
    let onSaved: () async -> Void

    @State private var settings: VoDogSIMSettings?
    @State private var mode: VoDogReceptionMode
    @State private var timeout: Double
    @State private var settingsBaseMode: String
    @State private var settingsBaseTimeout: Int
    @State private var settingsExpectedVersion: Int?
    @State private var settingsConflict = false
    @State private var labelText: String
    @State private var phoneLabelText: String
    @State private var notesBaseLabel: String
    @State private var notesBasePhoneLabel: String
    @State private var identityExpectedVersion: Int?
    @State private var notesConflict = false
    @State private var saving = false
    @State private var notesSaving = false
    @State private var operationError: String?
    @State private var applyState: VoDogApplyPolicy.State = .idle
    @State private var applyTask: Task<Void, Never>?

    init(account: VoDogAccount, sim: VoDogSIM, onSaved: @escaping () async -> Void) {
        self.account = account
        self.sim = sim
        self.onSaved = onSaved
        _settings = State(initialValue: sim.settings)
        _mode = State(initialValue: VoDogReceptionMode(rawValue: sim.settings?.mode ?? "normal") ?? .normal)
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

    private var settingsDirty: Bool { mode.rawValue != settingsBaseMode || Int(timeout) != settingsBaseTimeout }
    private var notesDirty: Bool {
        labelText.trimmingCharacters(in: .whitespacesAndNewlines) != notesBaseLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            || phoneLabelText.trimmingCharacters(in: .whitespacesAndNewlines)
            != notesBasePhoneLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var busy: Bool { saving || notesSaving }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(labelText.isEmpty ? sim.displayName : labelText).font(.largeTitle.bold())
                Text(sim.online == true ? L10n.tr("在线") : L10n.tr("离线"))
                    .font(.body).foregroundStyle(sim.online == true ? Color.green : Color.secondary)
            }
            notesCard
            modeCard
            if let operationError { VoDogErrorLine(text: operationError) }
        }
        .onChange(of: sim) { _, current in observe(current) }
        .onDisappear { applyTask?.cancel(); applyTask = nil }
    }

    private var notesCard: some View {
        VoDogCard(title: L10n.tr("号码备注"),
                         footer: L10n.tr("显示名称和号码标注只用于辨认线路，不会更换 SIM 的稳定身份或中断通话。")) {
            LabeledContent(L10n.tr("显示名称")) {
                TextField(L10n.tr("显示名称"), text: $labelText).textFieldStyle(.roundedBorder).frame(maxWidth: 280)
            }
            LabeledContent(L10n.tr("号码标注")) {
                TextField(L10n.tr("号码标注"), text: $phoneLabelText).textFieldStyle(.roundedBorder).frame(maxWidth: 280)
            }
            if notesConflict {
                Label(L10n.tr("号码备注已在其他客户端更新，当前草稿已保留。请载入并确认最新备注后再保存。"),
                      systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.red)
                    .reportsVoDogError(L10n.tr("号码备注已在其他客户端更新，当前草稿已保留。请载入并确认最新备注后再保存。"))
                Button(L10n.tr("载入最新备注（替换当前草稿）")) { Task { await reload(acceptNotes: true) } }
                    .disabled(busy)
            }
            HStack {
                if notesDirty { Text(L10n.tr("未保存设置")).font(.caption).foregroundStyle(.red) }
                Spacer()
                Button { Task { await saveNotes() } } label: {
                    if notesSaving { ProgressView().controlSize(.small) } else { Text(L10n.tr("保存备注")) }
                }
                .disabled(busy || notesConflict || identityExpectedVersion == nil
                          || labelText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var modeCard: some View {
        VoDogCard(title: L10n.tr("接听模式"), footer: nil) {
            Picker(L10n.tr("模式"), selection: $mode) {
                ForEach(VoDogReceptionMode.allCases) { candidate in
                    Text(candidate.title).tag(candidate).disabled(settings?.isAvailable(candidate) != true)
                }
            }
            .pickerStyle(.radioGroup)
            .disabled(busy)
            if let reason = settings?.aiUnavailableReason, !reason.isEmpty {
                Label(reason, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
            } else if settings?.isAvailable(.ai) != true || settings?.isAvailable(.timeoutAI) != true {
                Label(L10n.tr("当前号码暂不支持 AI 接听模式。"), systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if mode == .timeoutAI {
                HStack {
                    Slider(value: $timeout, in: 10...120, step: 5).disabled(busy)
                    Text(L10n.tr("%lld 秒", Int64(timeout))).monospacedDigit().frame(width: 60, alignment: .trailing)
                }
                Text(L10n.tr("无人接听超过这个时间后由 AI 代接。")).font(.caption).foregroundStyle(.secondary)
            }
            if settingsConflict {
                Label(L10n.tr("接听设置已在其他客户端更新，当前草稿已保留。请载入并确认最新设置后再保存。"),
                      systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.red)
                    .reportsVoDogError(L10n.tr("接听设置已在其他客户端更新，当前草稿已保留。请载入并确认最新设置后再保存。"))
                Button(L10n.tr("载入最新设置（替换当前草稿）")) { Task { await reload(acceptSettings: true) } }
                    .disabled(busy)
            }
            Divider()
            LabeledContent(L10n.tr("服务器版本"), value: String(settings?.version ?? 0))
            LabeledContent(L10n.tr("草稿基于版本"), value: settingsExpectedVersion.map(String.init) ?? L10n.tr("未知"))
            LabeledContent(L10n.tr("设备已应用"), value: settings?.appliedVersion.map(String.init) ?? L10n.tr("尚未确认"))
            applyStatusLine
            HStack {
                if settingsDirty { Text(L10n.tr("未保存设置")).font(.caption).foregroundStyle(.red) }
                Spacer()
                Button { Task { await saveSettings() } } label: {
                    if saving { ProgressView().controlSize(.small) } else { Text(L10n.tr("保存设置")) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || settingsConflict || settingsExpectedVersion == nil || settings?.isAvailable(mode) != true)
            }
        }
    }

    @ViewBuilder private var applyStatusLine: some View {
        let status = VoDogApplyPolicy.label(applyState, appliedVersion: settings?.appliedVersion,
                                                   version: settings?.version)
        switch status.tone {
        case .pending:
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text(status.text).font(.caption).foregroundStyle(.secondary) }
        case .success:
            Label(status.text, systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
        case .warning:
            Text(status.text).font(.caption).foregroundStyle(.orange).reportsVoDogError(status.text)
        case .none:
            EmptyView()
        }
    }

    private func saveNotes() async {
        let label = labelText.trimmingCharacters(in: .whitespacesAndNewlines)
        let phone = phoneLabelText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let version = identityExpectedVersion, !label.isEmpty, !busy else { return }
        notesSaving = true
        defer { notesSaving = false }
        operationError = nil
        do {
            // An empty 号码标注 is an explicit null so the server clears it.
            let response = try await account.json("PUT", "/sims/\(sim.id)", body: [
                "label": label, "phoneLabel": phone.isEmpty ? NSNull() : phone, "expectedVersion": version
            ])
            let saved = response["sim"] as? [String: Any]
            labelText = saved?["label"] as? String ?? label
            phoneLabelText = saved?["phoneLabel"] as? String ?? ""
            notesBaseLabel = labelText
            notesBasePhoneLabel = phoneLabelText
            identityExpectedVersion = GatewayJSON.int(saved?["version"]) ?? version + 1
            notesConflict = false
            await onSaved()
        } catch where VoDogErrorText.isVersionConflict(error) {
            notesConflict = true
            operationError = nil
            notesSaving = false
            await reload()
        } catch is CancellationError {
            return
        } catch {
            operationError = VoDogErrorText.message(error)
        }
    }

    private func saveSettings() async {
        guard let version = settingsExpectedVersion, !busy, settings?.isAvailable(mode) == true else { return }
        saving = true
        defer { saving = false }
        operationError = nil
        do {
            let response = try await account.json("PUT", "/sims/\(sim.id)/settings", body: [
                "mode": mode.rawValue, "timeoutSeconds": Int(timeout), "expectedVersion": version
            ])
            let saved = try VoDogJSON.decode(VoDogSIMSettings.self,
                                                    from: response["settings"] as? [String: Any] ?? [:])
            adoptSettings(saved.mergingCapabilities(from: settings))
            beginApplyPolling(target: saved.version)
            await onSaved()
        } catch where VoDogErrorText.isVersionConflict(error) {
            settingsConflict = true
            applyTask?.cancel(); applyTask = nil; applyState = .idle
            saving = false
            await reload()
        } catch is CancellationError {
            return
        } catch {
            operationError = VoDogErrorText.message(error)
            applyTask?.cancel(); applyTask = nil; applyState = .idle
        }
    }

    /// The PUT response can never carry the gateway's ack, so watch `GET /sims` for it.
    private func beginApplyPolling(target: Int) {
        applyTask?.cancel()
        let started = Date()
        applyState = .applying(started: started, target: target)
        let modeValue = mode.rawValue
        applyTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(VoDogApplyPolicy.pollInterval * 1_000_000_000))
                guard !Task.isCancelled else { return }
                if !saving, !notesSaving { await reload() }
                applyState = VoDogApplyPolicy.next(applyState, now: Date(),
                                                          appliedVersion: settings?.appliedVersion, version: settings?.version)
                let result: String
                switch applyState {
                case .applying: continue
                case .applied: result = "applied"
                case .superseded: result = "superseded"
                case .timedOut: result = "timed_out"
                case .idle: return
                }
                account.diag("settings.apply", level: result == "applied" ? "info" : "warn", fields: [
                    "simId": sim.id, "mode": modeValue, "target": target, "result": result,
                    "ms": Int(Date().timeIntervalSince(started) * 1_000)
                ])
                return
            }
        }
    }

    private func reload(acceptSettings: Bool = false, acceptNotes: Bool = false) async {
        await account.refreshSIMs()
        guard account.simsError == nil, let current = account.sims.first(where: { $0.id == sim.id }) else { return }
        observe(current, acceptSettings: acceptSettings, acceptNotes: acceptNotes)
        if acceptSettings || acceptNotes { operationError = nil }
    }

    /// Server truth arrives; a dirty draft is never overwritten, and a version change under it is a conflict.
    private func observe(_ current: VoDogSIM, acceptSettings: Bool = false, acceptNotes: Bool = false) {
        let settingsWereDirty = settingsDirty
        let notesWereDirty = notesDirty
        if let latest = current.settings?.mergingCapabilities(from: settings) {
            settings = latest
            if acceptSettings {
                adoptSettings(latest)
            } else if !settingsConflict {
                if VoDogApplyPolicy.hasExternalChange(currentVersion: latest.version,
                                                             baseVersion: settingsExpectedVersion,
                                                             draftIsDirty: settingsWereDirty) {
                    settingsConflict = true
                } else if !settingsWereDirty {
                    adoptSettings(latest)
                }
            }
        }
        if acceptNotes {
            adoptNotes(current)
        } else if !notesConflict {
            if VoDogApplyPolicy.hasExternalChange(currentVersion: current.version,
                                                         baseVersion: identityExpectedVersion,
                                                         draftIsDirty: notesWereDirty) {
                notesConflict = true
            } else if !notesWereDirty {
                adoptNotes(current)
            }
        }
    }

    private func adoptSettings(_ current: VoDogSIMSettings) {
        settings = current
        mode = VoDogReceptionMode(rawValue: current.mode) ?? .normal
        timeout = Double(current.timeoutSeconds)
        settingsBaseMode = current.mode
        settingsBaseTimeout = current.timeoutSeconds
        settingsExpectedVersion = current.version
        settingsConflict = false
    }

    private func adoptNotes(_ current: VoDogSIM) {
        labelText = current.label ?? ""
        phoneLabelText = current.phoneLabel ?? ""
        notesBaseLabel = labelText
        notesBasePhoneLabel = phoneLabelText
        identityExpectedVersion = current.version
        notesConflict = false
    }
}

/// Account-level AI voice provider (S24 决策 3). Hidden when the route 404s.
private struct VoDogVoiceProviderCard: View {
    @ObservedObject var account: VoDogAccount
    @State private var list: VoDogVoiceProviderList?
    @State private var unavailable = false
    @State private var busy: String?
    @State private var error: String?
    @State private var conflict = false

    var body: some View {
        if !unavailable {
            VoDogCard(title: L10n.tr("AI 语音服务"), footer: L10n.tr("切换只影响之后的 AI 即接 / 超时代接来电。")) {
                if let list {
                    if list.items.isEmpty { Text(L10n.tr("没有可用的语音服务")).foregroundStyle(.secondary) }
                    ForEach(list.items) { item in row(item, selected: list.selected == item.id) }
                } else {
                    ProgressView().controlSize(.small)
                }
                if conflict {
                    Label(L10n.tr("AI 语音服务已在其他客户端更新，请载入最新配置后再选择。"),
                          systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption).foregroundStyle(.red)
                        .reportsVoDogError(L10n.tr("AI 语音服务已在其他客户端更新，请载入最新配置后再选择。"))
                    Button(L10n.tr("载入并确认最新配置")) { Task { await load(); conflict = false } }
                }
                if let error { VoDogErrorLine(text: error) }
            }
            .task {
                while !Task.isCancelled, !unavailable, account.user != nil {
                    if busy == nil { await load() }
                    await VoDogPollCadence.sleep()
                }
            }
        }
    }

    private func row(_ item: VoDogVoiceProvider, selected: Bool) -> some View {
        Button { Task { await select(item) } } label: {
            HStack(spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.displayLabel)
                    Text(item.disabledReason ?? L10n.tr("可用")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if busy == item.id { ProgressView().controlSize(.small) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(item.disabledReason != nil || busy != nil || conflict || selected)
    }

    private func load() async {
        do {
            list = try await account.decode(VoDogVoiceProviderList.self, "GET", "/ai/voice-providers")
            error = nil
        } catch is CancellationError {
            return
        } catch {
            if VoDogErrorText.isNotFound(error) { unavailable = true } else { self.error = VoDogErrorText.message(error) }
        }
    }

    private func select(_ item: VoDogVoiceProvider) async {
        guard let current = list, busy == nil else { return }
        busy = item.id
        defer { busy = nil }
        error = nil
        do {
            list = try await account.decode(VoDogVoiceProviderList.self, "PUT", "/ai/voice-provider",
                                            body: ["provider": item.id, "expectedVersion": current.configVersion])
        } catch where VoDogErrorText.isProviderConflict(error) {
            conflict = true
        } catch is CancellationError {
            return
        } catch {
            // 409 PROVIDER_UNAVAILABLE carries a Chinese message from the server.
            self.error = VoDogErrorText.message(error)
            await load()
        }
    }
}

// MARK: 账号

struct VoDogAccountView: View {
    @ObservedObject var account: VoDogAccount
    @State private var passkeys: [VoDogPasskey] = []
    @State private var passkeysLoaded = false
    @State private var passkeyError: String?
    @State private var renaming: VoDogPasskey?
    @State private var renameText = ""
    @State private var deleting: VoDogPasskey?
    @State private var gateways: [VoDogGatewayPower] = []
    @State private var gatewaysLoaded = false
    @State private var powerUnavailable = false
    @State private var powerError: String?
    @State private var powerBusy: Set<String> = []
    @State private var confirmingOff: VoDogGatewayPower?
    @State private var loggingOut = false

    private struct PasskeyList: Decodable { var items: [VoDogPasskey] }
    private struct PowerList: Decodable { var items: [VoDogGatewayPower] }
    private struct PowerItem: Decodable { var item: VoDogGatewayPower }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(L10n.tr("账号")).font(.largeTitle.bold())
                userCard
                passkeyCard
                if !powerUnavailable { gatewayCard }
                HStack {
                    Spacer()
                    Button(role: .destructive) {
                        loggingOut = true
                        Task { await account.logout(); loggingOut = false }
                    } label: {
                        if loggingOut { ProgressView().controlSize(.small) } else { Text(L10n.tr("退出登录")) }
                    }
                    .disabled(loggingOut)
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollContentBackground(.hidden)
        .communicationDetailColumnStyle()
        .task { await loadPasskeys() }
        .task {
            powerUnavailable = false
            while !Task.isCancelled, !powerUnavailable, account.user != nil {
                await loadGateways()
                await VoDogPollCadence.sleep()
            }
        }
        .sheet(item: $renaming) { item in renameSheet(item) }
        .confirmationDialog(L10n.tr("删除这个通行密钥？"),
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { item in
            Button(L10n.tr("删除"), role: .destructive) { Task { await deletePasskey(item) } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: { item in
            Text(L10n.tr("删除后，%@ 将不能再用于登录。", item.resolvedName))
        }
        .confirmationDialog(L10n.tr("关闭网关？"),
                            isPresented: Binding(get: { confirmingOff != nil }, set: { if !$0 { confirmingOff = nil } }),
                            titleVisibility: .visible, presenting: confirmingOff) { item in
            Button(L10n.tr("关闭"), role: .destructive) { Task { await setPower(item, on: false) } }
            Button(L10n.tr("取消"), role: .cancel) {}
        } message: { item in
            Text(L10n.tr("将关闭 %@ 的网关总控。通话进行中时服务器会拒绝关闭。", item.displayName))
        }
    }

    private var userCard: some View {
        VoDogCard(title: L10n.tr("账号信息")) {
            LabeledContent(L10n.tr("用户名"), value: account.user?.username ?? "—")
            LabeledContent(L10n.tr("角色"), value: account.isAdmin ? L10n.tr("管理员") : L10n.tr("普通用户"))
            LabeledContent(L10n.tr("当前会话"), value: "macOS App · \(VoDogAccount.deviceName)")
        }
    }

    private var passkeyCard: some View {
        VoDogCard(title: L10n.tr("通行密钥"), footer: L10n.tr("在 Mac 上添加通行密钥暂不支持，请在 iPhone 或网页上添加。")) {
            if !passkeysLoaded {
                ProgressView().controlSize(.small)
            } else if passkeys.isEmpty, passkeyError == nil {
                Text(L10n.tr("尚未添加通行密钥")).foregroundStyle(.secondary)
            }
            ForEach(passkeys) { item in
                HStack(spacing: 12) {
                    Image(systemName: "person.badge.key.fill").foregroundStyle(Color.accentColor).frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.resolvedName).font(.body.weight(.semibold))
                        Text(L10n.tr("添加于 %@", display(item.createdAt))).font(.caption).foregroundStyle(.secondary)
                        Text(item.lastUsedAt.map { L10n.tr("最近使用 %@", display($0)) } ?? L10n.tr("尚未使用"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(L10n.tr("重命名")) { renameText = item.label ?? ""; renaming = item }
                    Button(L10n.tr("删除"), role: .destructive) { deleting = item }
                }
            }
            if let passkeyError { VoDogErrorLine(text: passkeyError) }
        }
    }

    private var gatewayCard: some View {
        VoDogCard(title: L10n.tr("网关总控"), footer: L10n.tr("远程开启需要网关允许远程开启（待命）。通话进行中不会被远程关闭。")) {
            if !gatewaysLoaded {
                ProgressView().controlSize(.small)
            } else if gateways.isEmpty, powerError == nil {
                Text(L10n.tr("没有可管理的网关")).foregroundStyle(.secondary)
            }
            ForEach(gateways) { item in
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.displayName).font(.body.weight(.semibold))
                        Text(item.statusTitle).font(.caption)
                            .foregroundStyle(item.online || item.standbyOnline ? Color.secondary : Color.red)
                        if let reason = item.toggleDisabledReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
                        if let pending = item.pendingTitle { Text(pending).font(.caption).foregroundStyle(.orange) }
                        if let failure = item.lastResultFailure {
                            Text(failure).font(.caption).foregroundStyle(.red).reportsVoDogError(failure)
                        }
                    }
                    Spacer()
                    if powerBusy.contains(item.gatewayId) { ProgressView().controlSize(.small) }
                    Toggle(L10n.tr("网关总控"), isOn: Binding(
                        get: { item.controlEnabled },
                        set: { on in if on { Task { await setPower(item, on: true) } } else { confirmingOff = item } }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .disabled(item.toggleDisabledReason != nil || powerBusy.contains(item.gatewayId))
                }
            }
            if let powerError { VoDogErrorLine(text: powerError) }
        }
    }

    private func renameSheet(_ item: VoDogPasskey) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.tr("重命名通行密钥")).font(.headline)
            TextField(L10n.tr("名称"), text: $renameText).textFieldStyle(.roundedBorder).frame(width: 280)
            HStack {
                Spacer()
                Button(L10n.tr("取消"), role: .cancel) { renaming = nil }.keyboardShortcut(.cancelAction)
                Button(L10n.tr("保存")) { Task { await rename(item) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
    }

    private func display(_ iso: String) -> String {
        guard let date = GatewayJSON.date(iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func loadPasskeys() async {
        do {
            passkeys = try await account.decode(PasskeyList.self, "GET", "/passkeys").items
            passkeyError = nil
        } catch is CancellationError {
            return
        } catch {
            passkeyError = VoDogErrorText.message(error)
        }
        passkeysLoaded = true
    }

    private func rename(_ item: VoDogPasskey) async {
        let label = String(renameText.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
        renaming = nil
        do {
            _ = try await account.json("PATCH", "/passkeys/\(item.id)", body: ["label": label])
            await loadPasskeys()
        } catch is CancellationError {
            return
        } catch {
            passkeyError = VoDogErrorText.message(error)
        }
    }

    private func deletePasskey(_ item: VoDogPasskey) async {
        do {
            _ = try await account.json("DELETE", "/passkeys/\(item.id)")
            passkeys.removeAll { $0.id == item.id }
        } catch is CancellationError {
            return
        } catch {
            passkeyError = VoDogErrorText.message(error)
            await loadPasskeys()
        }
    }

    private func loadGateways() async {
        do {
            gateways = try await account.decode(PowerList.self, "GET", "/gateways/power").items
            powerError = nil
        } catch is CancellationError {
            return
        } catch {
            if VoDogErrorText.isNotFound(error) { powerUnavailable = true } else { powerError = VoDogErrorText.message(error) }
        }
        gatewaysLoaded = true
    }

    private func setPower(_ item: VoDogGatewayPower, on: Bool) async {
        guard !powerBusy.contains(item.gatewayId) else { return }
        powerBusy.insert(item.gatewayId)
        defer { powerBusy.remove(item.gatewayId) }
        do {
            let updated = try await account.decode(PowerItem.self, "POST", "/gateways/\(item.gatewayId)/power",
                                                   body: ["desired": on ? "on" : "off"], idempotent: true).item
            if let index = gateways.firstIndex(where: { $0.gatewayId == updated.gatewayId }) { gateways[index] = updated }
            powerError = nil
        } catch is CancellationError {
            return
        } catch {
            powerError = VoDogErrorText.message(error)
            await loadGateways()
        }
    }
}
