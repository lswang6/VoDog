import SwiftUI

private struct MenuBarContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct MenuBarHubView: View {
    @EnvironmentObject private var appState: AppState
    @State private var contentHeight: CGFloat = 0
    @State private var quickDialText = ""
    @State private var codeCopied = false

    private let maximumHeight: CGFloat
    private let onDismiss: () -> Void

    init(
        maximumHeight: CGFloat = MenuBarHubMetrics.defaultMaximumHeight,
        onDismiss: @escaping () -> Void = {}
    ) {
        self.maximumHeight = maximumHeight
        self.onDismiss = onDismiss
    }

    var body: some View {
        ScrollView(.vertical) {
            menuContent
                .fixedSize(horizontal: false, vertical: true)
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: MenuBarContentHeightKey.self,
                            value: proxy.size.height
                        )
                    }
                }
        }
        .scrollBounceBehavior(.basedOnSize)
        .defaultScrollAnchor(.top)
        .frame(
            width: MenuBarHubMetrics.panelWidth,
            height: min(max(contentHeight, 1), maximumHeight)
        )
        .onPreferenceChange(MenuBarContentHeightKey.self) { height in
            guard height > 0 else { return }
            contentHeight = height
        }
    }

    private var menuContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            quickDial

            if let latest = latestCodeMessage, let code = latest.verificationCode {
                latestCodeCard(latest, code: code)
            }

            if let transientMessage = appState.transientMessage {
                Label {
                    Text(verbatim: transientMessage)
                } icon: {
                    Image(systemName: appState.transientIsError
                        ? "exclamationmark.triangle.fill"
                        : "checkmark.circle.fill")
                }
                .font(.caption)
                .foregroundStyle(appState.transientIsError ? Signal.danger : Signal.ink3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            MenuBarCommunicationSections(
                history: appState.callHistory,
                onOpenMessage: { message in
                    transition {
                        appState.showMessagesWindow(messageID: message.id)
                    }
                },
                onOpenMissedCall: { record in
                    transition {
                        appState.showPhoneWindow(callRecordID: record.id)
                    }
                }
            )

            footer
        }
        .foregroundStyle(Signal.ink)
        .padding(.horizontal, MenuBarHubMetrics.horizontalInset)
        .padding(.top, 14)
        .padding(.bottom, 8)
        .frame(width: MenuBarHubMetrics.panelWidth)
        .background(Signal.bg)
    }

    // MARK: Header

    private var header: some View {
        Button {
            transition { appState.showPhoneWindow(section: .sim, simModuleID: module?.id) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "phone.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Signal.onBrand)
                    .frame(width: 30, height: 30)
                    .background(Signal.brand, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: appName).font(.headline)
                    HStack(spacing: 5) {
                        if module != nil {
                            LineBlock(color: appState.lineColor(for: module?.id), size: 8)
                        }
                        Text(verbatim: headerDetail).lineLimit(1)
                        AiBadge(settings: aiSettings)
                    }
                    .font(.caption)
                    .foregroundStyle(Signal.ink3)
                }
                Spacer(minLength: 6)
                SignalBars(bars: hasSignal ? (module?.modem.signalBars ?? 0) : 0, barWidth: 3.5, height: 14)
            }
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(module?.accessibilitySummary ?? L10n.tr("没有可用模组"))
        .accessibilityLabel([module?.accessibilitySummary ?? L10n.tr("没有可用模组"), AiBadge.accessibilityText(aiSettings)]
            .compactMap { $0 }.joined(separator: ", "))
    }

    private var aiSettings: VoDogSIMSettings? { appState.accountSIM(for: module?.id)?.settings }

    private var module: CellularModuleSummary? {
        appState.currentCommunicationModule ?? appState.cellularModules.first
    }

    private var hasSignal: Bool {
        module.map { $0.modem.isConnected && $0.modem.signalDBm != nil } ?? false
    }

    private var appName: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? ProcessInfo.processInfo.processName
    }

    /// 「线路 · 运营商 制式」, or the module status while it is not connected.
    private var headerDetail: String {
        guard let module else { return L10n.tr("没有可用模组") }
        guard module.modem.isConnected else { return module.statusText }
        let network = [module.carrierName, module.technologyName].compactMap { $0 }.joined(separator: " ")
        return [appState.lineName(for: module.id) ?? module.localizedDisplayName, network]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Quick dial

    private var quickDial: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "circle.grid.3x3.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(Signal.ink3)
                TextField(L10n.tr("输入号码或姓名"), text: $quickDialText)
                    .textFieldStyle(.plain)
                    .onSubmit(quickDialAction)
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(Signal.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Signal.line, lineWidth: 1)
            }

            Button(action: quickDialAction) {
                Image(systemName: "phone.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Signal.callFill, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            .buttonStyle(.plain)
            .help(L10n.tr("拨打"))
            .accessibilityLabel(L10n.tr("拨打"))
        }
    }

    /// Signed out with a dialable number: the dialer's own path (`AppState.dial`). Otherwise the main
    /// window's dialer opens with the text prefilled (signed in, calls go through VoDog there).
    private func quickDialAction() {
        let text = quickDialText.trimmingCharacters(in: .whitespacesAndNewlines)
        if appState.voDog.user == nil,
           appState.call.canDial, !appState.isChangingCall,
           CallATParser.normalizedDialNumber(text) != nil {
            appState.dial(text)
            quickDialText = ""
            onDismiss()
            return
        }
        transition { appState.showPhoneWindow(number: text.isEmpty ? nil : text, section: .dialer) }
    }

    // MARK: Latest verification code

    private var latestCodeMessage: SMSMessage? {
        appState.messages
            .filter { !$0.isOutgoing && $0.verificationCode != nil }
            .max { $0.timestamp < $1.timestamp }
    }

    private func latestCodeCard(_ message: SMSMessage, code: String) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 0) {
                    Text(verbatim: L10n.tr("最新验证码") + " · " + CommunicationUI.displayText(message.sender) + " · ")
                    Text(message.timestamp, style: .relative)
                }
                .font(.caption)
                .foregroundStyle(Signal.ink2)
                .lineLimit(1)
                Text(verbatim: code)
                    .font(.system(size: 26, weight: .semibold).monospacedDigit())
                    .tracking(3)
                    .foregroundStyle(Signal.brand)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 4)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                codeCopied = true
            } label: {
                Label(codeCopied ? L10n.tr("已复制") : L10n.tr("复制"),
                      systemImage: codeCopied ? "checkmark" : "doc.on.doc")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Signal.onBrand)
                    .padding(.horizontal, 14)
                    .frame(height: 32)
                    .background(Signal.brand, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.tr("验证码 %@，点击复制", code))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Signal.brandSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onChange(of: code) { _, _ in codeCopied = false }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 4) {
            footerButton(L10n.tr("打开主窗口")) {
                transition { CommunicationWindowController.shared.handleApplicationReopen() }
            }
            footerButton(L10n.tr("设置…")) {
                transition { appState.showPhoneWindow(section: .settings) }
            }
            footerButton(L10n.tr("退出")) { appState.quit() }
                .help(L10n.tr("退出 VoDog"))
        }
        .padding(.top, 6)
        .overlay(alignment: .top) { Rectangle().fill(Signal.line).frame(height: 1) }
    }

    private func footerButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(verbatim: title)
                .font(.callout.weight(.medium))
                .foregroundStyle(Signal.ink2)
                .frame(maxWidth: .infinity, minHeight: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func transition(_ action: @escaping () -> Void) {
        onDismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: action)
    }
}

enum MenuBarHubMetrics {
    static let panelWidth: CGFloat = 360
    static let defaultMaximumHeight: CGFloat = 620
    static let horizontalInset: CGFloat = 12
}
