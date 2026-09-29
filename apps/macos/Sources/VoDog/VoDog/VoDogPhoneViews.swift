import AppKit
import SwiftUI

// S57: while signed in to VoDog, the Phone window's dialer and messages go through Control
// (the account's SIMs, including this Mac's own module as its gateway identity). Signed out, the
// original local-module views are shown untouched.

/// Picks the local-module view or the VoDog one; observing the account re-renders on login/logout.
struct VoDogPhoneRoute<Local: View, Remote: View>: View {
    @ObservedObject var account: VoDogAccount
    @ViewBuilder let local: () -> Local
    @ViewBuilder let remote: () -> Remote

    var body: some View {
        if VoDogPhonePolicy.usesRemoteRoute(signedIn: account.user != nil) { remote() } else { local() }
    }
}

extension Color {
    /// S57 SIM palette (rank by `(slotIndex, id)`), light/dark aware.
    static func voDogSIM(rank: Int) -> Color {
        dynamic(light: VoDogPhonePolicy.simColorHex(rank: rank, dark: false),
                dark: VoDogPhonePolicy.simColorHex(rank: rank, dark: true))
    }

    static let voDogOnSIM = dynamic(light: VoDogPhonePolicy.textOnColor.light,
                                           dark: VoDogPhonePolicy.textOnColor.dark)

    private static func dynamic(light: String, dark: String) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            let value = Int(hex.dropFirst(), radix: 16) ?? 0
            return NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                           blue: CGFloat(value & 0xFF) / 255, alpha: 1)
        })
    }
}

// MARK: - S67 unread badges

/// Red capsule, white text, hidden at 0, `99+` above 99; VoiceOver reads 「N 条未读」.
struct VoDogCountBadge: View {
    let count: Int

    var body: some View {
        if let text = VoDogBadges.text(count) {
            Text(text)
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(.white)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 5)
                .frame(minWidth: 16, minHeight: 16)
                .background(Color.red, in: Capsule())
                .accessibilityLabel(L10n.tr("%lld 条未读", Int64(count)))
        }
    }
}

/// Live count from the shared badge store (`kind == nil` sums calls + SMS).
struct VoDogBadgeCount: View {
    @ObservedObject var store: VoDogBadgeStore
    var kind: VoDogBadges.Kind?
    var simID: String?

    var body: some View { VoDogCountBadge(count: store.counts.count(kind, simID: simID)) }
}

/// S67c leading unread dot (Mail / Messages style); the slot keeps its width when hidden so rows align.
/// Row labels carry 「未查看」/「未读」, so the dot itself is hidden from VoiceOver.
struct VoDogUnreadDot: View {
    let visible: Bool

    var body: some View {
        Circle().fill(Color.accentColor)
            .frame(width: 8, height: 8)
            .opacity(visible ? 1 : 0)
            .frame(width: 10)
            .accessibilityHidden(true)
    }
}

/// Re-renders `content` when the badge store's optimistic seen / read sets change (list views observe
/// only the account).
struct VoDogBadgeReader<Content: View>: View {
    @ObservedObject var store: VoDogBadgeStore
    @ViewBuilder var content: (VoDogBadgeStore) -> Content

    var body: some View { content(store) }
}

/// Rail slot: shown only while signed in (the store polls itself, see `startPolling`).
struct VoDogRailBadge: View {
    @ObservedObject var account: VoDogAccount
    var kind: VoDogBadges.Kind?

    var body: some View {
        if account.user != nil { VoDogBadgeCount(store: account.badges, kind: kind) }
    }
}

/// 人工 / AI answer-mode tag; text, not color, carries the meaning.
struct VoDogAnswerModeBadge: View {
    let mode: String?

    var body: some View {
        if let key = VoDogPhonePolicy.answerModeBadge(mode) {
            Text(L10n.tr(key))
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .overlay(Capsule().strokeBorder(lineWidth: 1).opacity(0.5))
                .accessibilityLabel(L10n.tr("接听方式：%@", L10n.tr(key)))
        }
    }
}

/// Account SIM picker shown above the VoDog dialer and messages (iOS `SIMStrip`).
struct VoDogSIMStrip: View {
    @ObservedObject var account: VoDogAccount
    @Binding var selection: String?
    /// S67: which count the chips carry (calls page → calls, messages → SMS, nil → both).
    var badgeKind: VoDogBadges.Kind?

    private var fresh: Bool { account.simsError == nil }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                if account.sims.isEmpty {
                    Label(account.simsLoaded ? L10n.tr("没有已分配的 SIM") : L10n.tr("正在读取号码…"), systemImage: "simcard")
                        .foregroundStyle(.secondary)
                }
                ForEach(VoDogPhonePolicy.displayOrder(account.sims, fresh: fresh)) { sim in chip(sim) }
                if let error = account.simsError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                        .help(error)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .scrollIndicators(.never)
        .task {
            // ponytail: plain 5 s poll while the strip is on screen, same as the 号码与接听 page.
            while !Task.isCancelled, account.user != nil {
                await account.refreshSIMs()
                // Write only to repair a missing/unknown SIM: this long-lived task holds a stale copy of
                // `selection`, so an unconditional write would undo the user's latest tap every 5 s.
                let preferred = VoDogPhonePolicy.preferredSIM(account.sims, current: selection)
                if preferred != selection { selection = preferred }
                await VoDogPollCadence.sleep()
            }
        }
    }

    private func chip(_ sim: VoDogSIM) -> some View {
        let selected = selection == sim.id
        let color = Color.voDogSIM(rank: VoDogPhonePolicy.colorRank(of: sim.id, in: account.sims))
        let online = VoDogPhonePolicy.showsOnline(sim, fresh: fresh)
        let status = !fresh ? L10n.tr("号码状态待刷新") : online ? L10n.tr("在线") : L10n.tr("号码设备离线")
        return Button { selection = sim.id } label: {
            HStack(spacing: 8) {
                Circle().fill(online ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(sim.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(selected ? Color.voDogOnSIM : color)
                            .lineLimit(1)
                        VoDogAnswerModeBadge(mode: sim.settings?.mode)
                    }
                    Text([sim.phoneLabel, status].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .opacity(0.85)
                }
                .frame(maxWidth: 220, alignment: .leading)
            }
            .foregroundStyle(selected ? Color.voDogOnSIM : Color.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: 40)
            .background(selected ? color : Color.secondary.opacity(0.12), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .topTrailing) {
            VoDogBadgeCount(store: account.badges, kind: badgeKind, simID: sim.id).offset(x: 4, y: -4)
        }
        .help(sim.phoneLabel ?? sim.displayName)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Dialer

struct VoDogDialerView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var account: VoDogAccount
    @ObservedObject private var calls = VoDogCallStore.shared
    @AppStorage("VoDogPhone.sim.v1") private var storedSIM = ""
    @State private var number = ""

    private var selection: Binding<String?> {
        Binding(get: { storedSIM.isEmpty ? nil : storedSIM }, set: { storedSIM = $0 ?? "" })
    }

    private var selectedSIM: VoDogSIM? { account.sims.first { $0.id == storedSIM } }

    private var localModule: CellularModuleID? { selectedSIM.flatMap { appState.localDialModuleID(simID: $0.id) } }

    private var canDial: Bool {
        guard let sim = selectedSIM, calls.active == nil, !calls.busy,
              !VoDogPhonePolicy.normalizedNumber(number).isEmpty else { return false }
        return localModule != nil || (account.simsError == nil && sim.online == true)
    }

    var body: some View {
        VStack(spacing: 0) {
            VoDogSIMStrip(account: account, selection: selection, badgeKind: .calls)
            Divider()
            ScrollView {
                VStack(spacing: 18) {
                    TextField(L10n.tr("输入电话号码"), text: $number)
                        .textFieldStyle(.plain)
                        .font(.system(size: 24, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .multilineTextAlignment(.center)
                        .onSubmit(dial)
                        .padding(.horizontal, 15)
                        .frame(width: 260, height: 46)
                        .adaptiveGlassSurface(cornerRadius: 23, treatment: .clear, isInteractive: true)

                    VoDogKeypad { number = String((number + $0).prefix(32)) }

                    HStack(spacing: 28) {
                        CircularLiquidCallButton(title: L10n.tr("拨打"), systemImage: "phone.fill", tint: .green,
                                                 prominent: true, isEnabled: canDial, action: dial)
                        CircularLiquidCallButton(title: L10n.tr("删除最后一位"), systemImage: "delete.left",
                                                 isEnabled: !number.isEmpty, showsTitle: false) {
                            number = String(number.dropLast())
                        }
                    }

                    Text(hint).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    if let error = calls.error {
                        Label(error, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(.red)
                    }
                }
                .padding(28)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.never)
        }
        .communicationDetailColumnStyle()
    }

    private var hint: String {
        guard let sim = selectedSIM else { return L10n.tr("选择一个号码后拨打") }
        if localModule != nil { return L10n.tr("通过本机模组直拨") }
        return L10n.tr("通过 VoDog 的「%@」拨出", sim.displayName)
    }

    private func dial() {
        guard canDial, let sim = selectedSIM else { return }
        let target = number
        if let localModule {
            appState.dial(target, moduleID: localModule)
            return
        }
        Task {
            await calls.dial(simId: sim.id, number: target)
            if calls.active != nil { number = "" }
        }
    }
}

/// 3×4 keypad; one tap = one character (dial) or one DTMF digit (in call).
struct VoDogKeypad: View {
    let press: (String) -> Void

    var body: some View {
        Grid(horizontalSpacing: 16, verticalSpacing: 12) {
            ForEach([["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["*", "0", "#"]], id: \.self) { row in
                GridRow {
                    ForEach(row, id: \.self) { digit in
                        Button { press(digit) } label: {
                            Text(verbatim: digit)
                                .font(.system(size: 24, weight: .medium, design: .rounded))
                                .frame(width: 62, height: 62)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .adaptiveGlassSurface(cornerRadius: 31, treatment: .clear, isInteractive: true)
                        .accessibilityLabel(digit)
                    }
                }
            }
        }
    }
}

// MARK: - Ringing + active call layer

/// Overlay on the Phone window (S72: the 5 s incoming poll is app-lifetime in the store): shows the ring card, and
/// covers the window with the remote call while this Mac owns one.
struct VoDogCallLayer: View {
    @ObservedObject var account: VoDogAccount
    @ObservedObject private var calls = VoDogCallStore.shared
    @ObservedObject private var media = VoDogCallStore.shared.media
    @State private var keypadVisible = false

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear.allowsHitTesting(false)
            if account.user != nil {
                if let call = calls.active {
                    activeCall(call)
                } else if let call = calls.incoming {
                    ringCard(call).padding(.top, 18)
                }
            }
        }
        .task(id: account.user?.id) {
            calls.bind(account)
            if account.user == nil { calls.reset() }
        }
    }

    private func title(_ call: VoDogLiveCall) -> String { call.ringTitle }

    private func simName(_ call: VoDogLiveCall) -> String? {
        account.sims.first { $0.id == call.simId }?.displayName ?? call.simLabel
    }

    private func ringCard(_ call: VoDogLiveCall) -> some View {
        VStack(spacing: 12) {
            Text(L10n.tr("VoDog 来电")).font(.caption).foregroundStyle(.secondary)
            Text(title(call)).font(.title2.weight(.semibold)).lineLimit(1)
            if let sim = simName(call) { Text(sim).font(.callout).foregroundStyle(.secondary) }
            HStack(spacing: 40) {
                CircularLiquidCallButton(title: L10n.tr("拒接"), systemImage: "phone.down.fill", tint: .red,
                                         prominent: true, role: .destructive, isEnabled: !calls.busy, diameter: 58) {
                    calls.decline(call)
                }
                CircularLiquidCallButton(title: L10n.tr("接听"), systemImage: "phone.fill", tint: .green,
                                         prominent: true, isEnabled: !calls.busy, diameter: 58) {
                    Task { await calls.answer(call) }
                }
            }
        }
        .padding(22)
        .frame(width: 340)
        .adaptiveGlassSurface(cornerRadius: 28, treatment: .regular)
        .shadow(color: .black.opacity(0.15), radius: 14, y: 6)
    }

    private func activeCall(_ call: VoDogLiveCall) -> some View {
        VStack(spacing: 16) {
            Spacer(minLength: 12)
            Text(stateText(call.state)).font(.callout.weight(.medium)).foregroundStyle(.secondary)
            Text(title(call)).font(.system(size: 30, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.7)
            if let sim = simName(call) { Text(L10n.tr("经「%@」", sim)).font(.callout).foregroundStyle(.secondary) }
            Label(media.statusText, systemImage: media.state == .connected ? "waveform" : "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(mediaColor)
            if case .failed = media.state {
                Button(L10n.tr("重试音频")) { Task { await media.start(callID: call.id, account: account) } }
            }
            if keypadVisible { VoDogKeypad { digit in Task { await calls.sendDTMF(digit) } } }
            HStack(spacing: 16) {
                CircularLiquidCallButton(title: media.muted ? L10n.tr("取消静音") : L10n.tr("静音"),
                                         systemImage: media.muted ? "mic.slash.fill" : "mic.fill",
                                         selected: media.muted, diameter: 58) { media.setMuted(!media.muted) }
                CircularLiquidCallButton(title: L10n.tr("拨号盘"), systemImage: "circle.grid.3x3.fill",
                                         selected: keypadVisible, diameter: 58) { keypadVisible.toggle() }
                CircularLiquidCallButton(title: L10n.tr("挂断"), systemImage: "phone.down.fill", tint: .red,
                                         prominent: true, role: .destructive, diameter: 58) {
                    keypadVisible = false
                    calls.hangUp()
                }
            }
            if let error = calls.error { Text(error).font(.caption).foregroundStyle(.red) }
            Spacer(minLength: 12)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var mediaColor: Color {
        switch media.state {
        case .connected: return .green
        case .failed: return .orange
        default: return .secondary
        }
    }

    private func stateText(_ state: String?) -> String {
        switch state {
        case "active": return L10n.tr("通话中")
        case "connecting": return L10n.tr("正在接通…")
        case "ending": return L10n.tr("正在结束…")
        default: return L10n.tr("正在呼叫…")
        }
    }
}
