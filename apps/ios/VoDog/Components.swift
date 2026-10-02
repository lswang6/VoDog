import Foundation
import SwiftUI

/// S95 line chip: line-color rounded square + name + optional tail digits + status shape (never color alone).
enum LineStatus: Equatable { case online, offline, pending }

extension LineStatus {
    /// Shape only for what the current snapshot actually states; device-offline / unknown shows no shape.
    @MainActor init?(sim: SIMChannel, availability: UIAvailabilityState) {
        if sim.assignmentPending == true { self = .pending; return }
        switch availability.simStatus(sim) {
        case "在线": self = .online
        case "号码设备离线": self = .offline
        default: return nil
        }
    }
}

struct SimStatusShape: View {
    let status: LineStatus
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 8
    var body: some View {
        Group {
            switch status {
            case .online: Circle().fill(Signal.call)
            case .offline: Circle().strokeBorder(Signal.ink3, lineWidth: 1.5)
            case .pending:
                Circle().strokeBorder(Signal.warn, lineWidth: 1.5)
                    .background(Circle().trim(from: 0.25, to: 0.75).fill(Signal.warn).rotationEffect(.degrees(90)))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The 8–10 pt rounded square that carries a line's color.
struct SimSwatch: View {
    let color: Color
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 9
    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28).fill(color).frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Last four digits of a line's own number, for the chip tail.
func simTailDigits(_ sim: SIMChannel) -> String? {
    let digits = (sim.phoneLabel ?? "").filter(\.isNumber)
    return digits.count >= 4 ? String(digits.suffix(4)) : nil
}

/// S95b §A: a line answered by AI is recognisable everywhere it appears. Shown iff mode != normal.
struct AiBadge: View {
    let mode: String
    var timeoutSeconds: Int? = nil
    /// Compact `AI` inside chips; full `AI 代接` / `AI · N 秒后` in settings rows.
    var full = false

    init?(mode: String?, timeoutSeconds: Int? = nil, full: Bool = false) {
        guard let mode, Self.text(mode: mode, timeoutSeconds: timeoutSeconds, full: full) != nil else { return nil }
        self.mode = mode
        self.timeoutSeconds = timeoutSeconds
        self.full = full
    }

    init?(sim: SIMChannel, full: Bool = false) {
        self.init(mode: sim.settings?.mode, timeoutSeconds: sim.settings?.timeoutSeconds, full: full)
    }

    static func text(mode: String, timeoutSeconds: Int?, full: Bool) -> String? {
        switch ReceptionMode(rawValue: mode) {
        case .ai: full ? "AI 代接" : "AI"
        case .timeoutAI:
            !full ? "AI" : (timeoutSeconds.map { "AI · \($0) 秒后" } ?? "AI 兜底")
        case .normal, nil: nil
        }
    }

    static func accessibility(mode: String, timeoutSeconds: Int?) -> String? {
        switch ReceptionMode(rawValue: mode) {
        case .ai: "AI 代接已开启，立即由 AI 接听"
        case .timeoutAI:
            timeoutSeconds.map { "AI 代接已开启，响铃 \($0) 秒无人接听后由 AI 接听" } ?? "AI 代接已开启，无人接听后由 AI 接听"
        case .normal, nil: nil
        }
    }

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "sparkle").font(.caption2.weight(.bold))
            Text(Self.text(mode: mode, timeoutSeconds: timeoutSeconds, full: full) ?? "")
                .font(.caption2.weight(.semibold)).tracking(0.2).monospacedDigit().lineLimit(1)
        }
        .foregroundStyle(Signal.ai)
        .padding(.horizontal, 6)
        .frame(minHeight: 18)
        .background(Signal.aiSoft, in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibility(mode: mode, timeoutSeconds: timeoutSeconds) ?? "")
    }
}

struct SimChip: View {
    let name: String
    let color: Color
    var tail: String? = nil
    var detail: String? = nil
    var ai: AiBadge? = nil
    var status: LineStatus? = nil
    var selected = false
    /// Rows and banners use the 24 pt form; the title-row selector uses 40 pt.
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            SimSwatch(color: color)
            Text(name).font((compact ? Font.footnote : .subheadline).weight(.semibold)).foregroundStyle(Signal.ink)
                .lineLimit(1)
            if let detail { Text(detail).font(compact ? .footnote : .subheadline).foregroundStyle(Signal.ink2).lineLimit(1) }
            if let tail { Text(tail).font(compact ? .footnote : .subheadline).monospacedDigit().foregroundStyle(Signal.ink2) }
            if let ai { ai }
            if let status {
                SimStatusShape(status: status)
                if status == .offline { Text("离线").font(compact ? .footnote : .subheadline).foregroundStyle(Signal.ink2) }
            }
        }
        .padding(.horizontal, compact ? 8 : 14)
        .frame(minHeight: compact ? 24 : 40)
        .background(selected ? Signal.brandSoft : Signal.surface2, in: Capsule())
        .overlay { if selected { Capsule().strokeBorder(Signal.brand, lineWidth: 1.5) } }
    }
}

extension SimChip {
    init(sim: SIMChannel, in sims: [SIMChannel], status: LineStatus? = nil, selected: Bool = false,
         compact: Bool = false, showsTail: Bool = true) {
        self.init(name: simDisplayName(sim), color: SIMPalette.color(for: sim, in: sims),
                  tail: showsTail ? simTailDigits(sim) : nil, ai: AiBadge(sim: sim), status: status, selected: selected,
                  compact: compact)
    }
}

/// S95 status banner: three connection kinds (spec §1.3), icon + bold title + one sentence.
struct StatusBanner: View {
    enum Kind { case deviceOffline, serviceUnavailable, gatewayOffline }
    let kind: Kind
    let title: String
    let message: String
    var chip: SimChip? = nil

    private var icon: String {
        switch kind {
        case .deviceOffline: "wifi.slash"
        case .serviceUnavailable: "exclamationmark.icloud"
        case .gatewayOffline: "antenna.radiowaves.left.and.right.slash"
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon).font(.subheadline.weight(.semibold))
                .foregroundStyle(kind == .serviceUnavailable ? Signal.warn : Signal.ink2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(title).font(.subheadline.weight(.semibold))
                    if let chip { chip }
                }
                Text(message).font(.footnote).fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(kind == .serviceUnavailable ? Signal.warn : Signal.ink)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(kind == .serviceUnavailable ? Signal.warnSoft : Signal.surface2, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}

/// The horizontal chip row under a page title. Online lines are listed first (display only); tapping selects.
struct SIMStrip: View {
    @Environment(UIAvailabilityState.self) private var availability
    let sims: [SIMChannel]
    @Binding var selectedID: String?
    /// S20 decision 8: before the first response, "没有已分配的 SIM" is a lie. Callers that have no load state
    /// keep the previous behaviour by leaving this at its default.
    var loaded = true
    /// S67: unread count per SIM id for this page (calls on 通话, SMS on 短信).
    var badges: [String: Int] = [:]

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                if sims.isEmpty, !loaded {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("正在读取号码…").foregroundStyle(Signal.ink2)
                    }
                    .padding(.horizontal, 4)
                    .accessibilityLabel("正在读取号码")
                } else if sims.isEmpty {
                    Label("没有已分配的 SIM", systemImage: "simcard")
                        .foregroundStyle(Signal.ink2).padding(.horizontal, 4)
                }
                ForEach(SIMStripDisplayPolicy.items(sims, networkAvailable: availability.path == .available), id: \.element.id) { index, sim in
                    let status = availability.simStatus(sim)
                    Button { selectedID = sim.id } label: {
                        SimChip(
                            name: SIMStripDisplayPolicy.title(sim, originalIndex: index),
                            color: SIMPalette.color(for: sim, in: sims),
                            tail: simTailDigits(sim),
                            ai: AiBadge(sim: sim),
                            status: LineStatus(sim: sim, availability: availability),
                            selected: selectedID == sim.id
                        )
                        .frame(minHeight: 44)
                        .contentShape(Capsule())
                        .overlay(alignment: .topTrailing) {
                            if let text = BadgeLabelPolicy.text(badges[sim.id] ?? 0) { UnreadBadge(text: text).offset(x: 4, y: -2) }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(([SIMStripDisplayPolicy.accessibilityLabel(sim, originalIndex: index, status: status)]
                        + [BadgeLabelPolicy.accessibility(badges[sim.id] ?? 0)].compactMap { $0 }).joined(separator: "，"))
                    .accessibilityAddTraits(selectedID == sim.id ? .isSelected : [])
                }
            }.padding(.horizontal)
        }
        .accessibilityIdentifier("sim.strip")
        .scrollIndicators(.hidden).padding(.vertical, 4)
    }
}

/// S67: red pill, white digits; the owning control carries the spoken count.
struct UnreadBadge: View {
    let text: String
    var body: some View {
        Text(text).font(.caption2.weight(.bold)).monospacedDigit().foregroundStyle(.white)
            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
            .background(Signal.dangerFill, in: Capsule())
            .accessibilityHidden(true)
    }
}

/// S67c: Mail/Messages-style leading dot. The slot keeps its width when hidden so rows stay aligned.
struct UnreadDot: View {
    let visible: Bool
    /// Spoken first when the row combines its children; rows with an explicit label pass nil and prefix it themselves.
    var label: String?
    var body: some View {
        Circle().fill(Signal.brand).frame(width: 10, height: 10)
            .opacity(visible ? 1 : 0)
            .accessibilityLabel(label ?? "")
            .accessibilityHidden(!visible || label == nil)
    }
}

/// A presentation copy only: source order, default selection and original-index colors stay intact.
enum SIMStripDisplayPolicy {
    static func items(_ sims: [SIMChannel], networkAvailable: Bool) -> [(offset: Int, element: SIMChannel)] {
        let original = Array(sims.enumerated())
        guard networkAvailable else { return original }
        return original.filter { $0.element.online == true } + original.filter { $0.element.online != true }
    }

    static func title(_ sim: SIMChannel, originalIndex: Int) -> String {
        let label = sim.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let phone = sim.phoneLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !label.isEmpty, label != phone { return label }
        return "SIM \((sim.slotIndex ?? originalIndex) + 1)"
    }

    static func accessibilityLabel(_ sim: SIMChannel, originalIndex: Int, status: String) -> String {
        let phone = sim.phoneLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ([title(sim, originalIndex: originalIndex), phone.isEmpty ? "号码尚未核实" : phone,
                 "设备 \(simGatewayIdentity(sim, shortened: false))", status]
                + [answerModeBadge(sim).map { "接听方式：\($0)" }].compactMap { $0 }).joined(separator: "，")
    }

    /// S57: normal → 人工, ai / timeout_ai → AI; no settings (or an unknown mode) shows nothing.
    static func answerModeBadge(_ sim: SIMChannel) -> String? {
        guard let mode = sim.settings.flatMap({ ReceptionMode(rawValue: $0.mode) }) else { return nil }
        return mode == .normal ? "人工" : "AI"
    }
}

struct SIMIdentityDetail: View {
    let sim: SIMChannel

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(sim.phoneLabel ?? "号码尚未核实").font(.subheadline)
            // S95b §C: the screen shows the gateway's name; the full id (S91: tells same-named gateways apart)
            // stays in the spoken label.
            Text("设备：\(simGatewayIdentity(sim, shortened: true))")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityLabel("设备：\(simGatewayIdentity(sim, shortened: false))")
            if sim.assignmentPending == true {
                Label("号码分配正在同步", systemImage: "clock.arrow.circlepath").font(.caption).foregroundStyle(Signal.warn)
            } else if sim.present == false {
                Label("SIM 当前不在设备中", systemImage: "simcard.2.slash").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct DialPad: View {
    @Binding var number: String
    @State private var longPressed = false
    @State private var keyFeedback = 0

    private static let longPressSeconds: TimeInterval = 0.35

    private let keys: [(String, String)] = [
        ("1", ""), ("2", "ABC"), ("3", "DEF"),
        ("4", "GHI"), ("5", "JKL"), ("6", "MNO"),
        ("7", "PQRS"), ("8", "TUV"), ("9", "WXYZ"),
        ("*", ""), ("0", "+"), ("#", "")
    ]

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 20), count: 3), spacing: 16) {
            ForEach(keys, id: \.0) { key, letters in
                keypadKey(key, letters: letters)
            }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: keyFeedback)
    }

    /// A key inserts its digit on tap and, for "0", a leading-capable "+" on long press — the same contract the
    /// web and Android dialpads use. Presses play a short DTMF tone; "+" itself stays silent, like the iPhone app.
    @ViewBuilder private func keypadKey(_ key: String, letters: String) -> some View {
        let isZero = key == "0"
        VStack(spacing: 0) {
            Text(key).font(.system(.title, design: .default).weight(.regular)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.5)
            // A semantic style so the letters follow Dynamic Type instead of staying at a hardcoded 9 pt.
            Text(letters).font(.caption2.weight(.semibold)).tracking(1.6).foregroundStyle(Signal.ink2)
                .lineLimit(1).minimumScaleFactor(0.5)
        }
        .foregroundStyle(Signal.ink)
        .frame(width: 78, height: 78)
        .background(Signal.surface2, in: Circle())
        .contentShape(Circle())
        .onTapGesture {
            guard !longPressed else { return }
            DialTonePlayer.shared.play(key)
            keyFeedback += 1
            number = PhoneNumberText.appending(key, to: number)
        }
        .onLongPressGesture(minimumDuration: Self.longPressSeconds) {
            guard isZero else { return }
            longPressed = true
            keyFeedback += 1
            number = PhoneNumberText.appending("+", to: number)
        } onPressingChanged: { pressing in
            if pressing { longPressed = false }
        }
        .accessibilityElement()
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(letters.isEmpty ? key : "\(key)，\(letters)")
        .accessibilityHint(isZero ? "长按输入加号" : "")
    }
}

/// S36 C2: the in-call keypad. Deliberately not `DialPad`: that one accumulates digits into a number, while
/// every tap here is one DTMF digit handed straight to the gateway. No "+", no long press.
struct InCallKeypad: View {
    let onKey: (String) -> Void
    @State private var keyFeedback = 0

    private static let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 3), spacing: 12) {
            ForEach(Self.keys, id: \.self) { key in
                Button {
                    DialTonePlayer.shared.play(key, preservingSession: true)
                    keyFeedback += 1
                    onKey(key)
                } label: {
                    Text(key)
                        .font(.title2.weight(.medium)).monospacedDigit().foregroundStyle(Signal.ink)
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .frame(width: 64, height: 64)
                        .background(Signal.surface2, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(key)
                .accessibilityIdentifier("calls.dtmf.\(key)")
            }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: keyFeedback)
    }
}

/// S20 decision 6: the occupancy strip under `SIMStrip`. It states who holds the gateway and since when, and — only
/// for another session's call that this account may release — offers a confirmed "结束该通话".
struct SIMOccupancyBar: View {
    let call: CallRecord
    let timeZone: TimeZone
    var simLabel: String? = nil
    let onRelease: () async -> Void
    @State private var confirming = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "lock.circle.fill")
                .foregroundStyle(Signal.warn)
                .accessibilityHidden(true)
            Text(SIMOccupancyDisplayPolicy.summary(call, timeZone: timeZone, simLabel: simLabel))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if SIMOccupancyDisplayPolicy.canRelease(call) {
                Button(SIMOccupancyDisplayPolicy.releaseTitle, role: .destructive) { confirming = true }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
                    .tint(Color.callerDanger)
                    .accessibilityIdentifier("calls.releaseOccupancy")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Signal.surface2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(SIMOccupancyDisplayPolicy.summary(call, timeZone: timeZone, simLabel: simLabel))
        .confirmationDialog(
            SIMOccupancyDisplayPolicy.confirmTitle(call),
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button(SIMOccupancyDisplayPolicy.confirmActionTitle(call), role: .destructive) {
                Task { await onRelease() }
            }
            Button("取消", role: .cancel) { }
        } message: {
            Text(SIMOccupancyDisplayPolicy.confirmMessage(call))
        }
    }
}

extension View {
    /// S69: every user-visible error text/alert reports `ui.error_shown` when it (re)appears with a new message.
    /// Cancellation never reaches here: catch sites drop it before setting the message.
    func reportsError(_ message: String?, screen: String, site: String) -> some View {
        onChange(of: message, initial: true) { _, message in
            guard let message, !message.isEmpty else { return }
            Diag.shared.logErrorShown(screen: screen, site: site, message: message)
        }
    }

    /// Flag form for fixed-text errors (`报告读取失败`) and alerts driven by an `isPresented` bool.
    func reportsError(_ shown: Bool, message: String, screen: String, site: String) -> some View {
        reportsError(shown ? message : nil, screen: screen, site: site)
    }
}

/// S20 decision 8: one error presentation for Calls / Messages / Settings, matching the Records behaviour —
/// the message, and a retry when the caller has something to retry.
struct ErrorBanner: View {
    /// S69: which page showed it, for `ui.error_shown`.
    let screen: String
    let message: String
    var onRetry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(Color.callerDanger)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let onRetry {
                Button("重试") { onRetry() }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("error.retry")
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Signal.surface, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .reportsError(message, screen: screen, site: "banner")
    }
}

/// S20 decision 8: shared by the dialer, the call list and the records list, which used to print the raw state.
func callStateTitle(_ state: String?) -> String {
    switch state {
    case "incoming_ringing": "来电响铃"
    case "outgoing_pending": "等待拨号"
    case "connecting": "连接中"
    case "active": "通话中"
    case "ending": "正在结束"
    case "ended": "已结束"
    case "failed": "失败"
    default: "状态待确认"
    }
}

/// S21 §F: a history row prints `186…1768 · 张三`, while a header or a card leads with the name. The server
/// decides the match (decision 3), so both helpers just present whatever `contactName` arrived — including
/// nothing, on a Control that predates S21.
enum ContactDisplay {
    static let unknownNumber = "未知号码"
    static let blockedSymbol = "hand.raised.slash.fill"

    static func numberWithName(number: String?, contactName: String?) -> String {
        let number = number?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = contactName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if number.isEmpty { return name.isEmpty ? unknownNumber : name }
        return name.isEmpty ? number : "\(number) · \(name)"
    }

    /// S22 report card, line 1. The history row leads with the number (§F); a report card leads with whoever
    /// called, because the card is read as a story about a person rather than scanned as a call log.
    static func nameWithNumber(number: String?, contactName: String?) -> String {
        let number = number?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = contactName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if name.isEmpty { return number.isEmpty ? unknownNumber : number }
        return number.isEmpty ? name : "\(name) · \(number)"
    }

    static func title(number: String?, contactName: String?) -> String {
        let name = contactName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty { return name }
        let number = number?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return number.isEmpty ? unknownNumber : number
    }
}

/// S36 C5-a: the 最近通话 / 全部通话 row title. A matched name takes the first line and the number gets the
/// second, untruncated, line; without a name the row is the number alone, exactly as before. The
/// `ContactDisplay` helpers stay the single-string form the accessibility labels and every other surface use.
struct RecentCallTitle: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let number: String?
    let contactName: String?
    var nameFont: Font = .body.weight(.medium)
    var titleColor: Color = Signal.ink

    private var name: String {
        contactName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    private var shownNumber: String {
        let value = number?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? ContactDisplay.unknownNumber : value
    }

    var body: some View {
        if name.isEmpty {
            // Accessibility sizes get a second line rather than "159…"; the default size stays one line.
            Text(shownNumber).font(nameFont).monospacedDigit().foregroundStyle(titleColor)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(nameFont).foregroundStyle(titleColor).lineLimit(1)
                Text(shownNumber).font(.subheadline).monospacedDigit().foregroundStyle(Signal.ink2)
            }
        }
    }
}

/// The occupant wording shared with the Android client (`ClientViewModel.kt` `callOwnerLabel`).
func callPlatformTitle(_ platform: String?, gatewayKind: String? = nil) -> String? {
    switch platform {
    case "ios": "iPhone 端"
    case "android": "Android 端"
    case "macos": "Mac 端"
    case "web": "网页端"
    case "ai": "AI 接听"
    // S72：在网关设备本机（Pixel 系统界面 / Mac 上模组来电窗）接的。
    case "device": "网关本机"
    // S38：Pixel 自己在拨号盘上拨出去的通话。
    case "pixel": GatewayKind(gatewayKind).directDialTitle
    default: nil
    }
}

func callOwnerTitle(_ call: CallRecord) -> String? {
    if let device = call.answeredByDevice, !device.isEmpty { return device }
    let platform = call.answeredByPlatform ?? call.originatingPlatform
    return callPlatformTitle(platform, gatewayKind: call.gatewayKind) ?? platform
}

func simDisplayName(_ sim: SIMChannel) -> String {
    sim.label ?? sim.phoneLabel ?? "SIM \((sim.slotIndex ?? 0) + 1)"
}

/// S91: the gateway's name when Control sends one; the full form keeps the short id so same-named gateways differ.
func simGatewayIdentity(_ sim: SIMChannel, shortened: Bool) -> String {
    guard let id = sim.gatewayId, !id.isEmpty else { return "设备待确认" }
    let prefix = GatewayKind(sim.gatewayKind).shortPrefix
    let short = "\(prefix)\(id.prefix(8))"
    if let name = sim.gatewayName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
        return shortened ? name : "\(name) · \(short)"
    }
    return shortened ? short : "\(prefix)\(id)"
}

struct LoadStateView: View {
    let icon: String, title: String, detail: String
    var body: some View {
        ContentUnavailableView { Label(title, systemImage: icon) } description: { Text(detail) }
    }
}

/// SMS and passkey dates: the Android client's 「2026年10月1日 15:32」, never the device locale's wording. No
/// gateway zone travels with these rows, so the zone is the records fallback (`resolvedTimeZone(callZone: nil)`).
func displayDate(_ value: String?, timeZone: TimeZone = GatewayTimeDisplay.resolvedTimeZone(callZone: nil)) -> String {
    guard let value else { return "—" }
    guard let date = GatewayTimeDisplay.parseISO(value) else { return value }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = timeZone
    formatter.dateFormat = "yyyy年M月d日 HH:mm"
    return formatter.string(from: date)
}

enum GatewayTimeDisplay {
    static let fallbackIANA = "Asia/Shanghai"

    static func resolvedTimeZone(callZone: String?, simZone: String? = nil) -> TimeZone {
        if let callZone, let zone = TimeZone(identifier: callZone) { return zone }
        if let simZone, let zone = TimeZone(identifier: simZone) { return zone }
        return TimeZone(identifier: fallbackIANA) ?? .gmt
    }

    static func compact(_ value: String?, timeZone: TimeZone) -> String {
        guard let value, let date = parseISO(value) else { return "—" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    static func talkSeconds(answeredAt: String?, endedAt: String?) -> Int? {
        guard let answeredAt, let endedAt, let answered = parseISO(answeredAt), let ended = parseISO(endedAt) else {
            return nil
        }
        return max(0, Int(ended.timeIntervalSince(answered).rounded()))
    }

    static func parseISO(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

enum PlaybackClock {
    static func format(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    static func formatMilliseconds(_ milliseconds: Int64?) -> String? {
        guard let milliseconds, milliseconds >= 0 else { return nil }
        return format(Double(milliseconds) / 1_000)
    }
}

enum TranscriptPollPolicy {
    static let interval: Duration = .seconds(5)

    static func shouldPoll(_ status: String) -> Bool {
        switch status {
        case "queued", "running", "retry": true
        default: false
        }
    }
}

enum RecordingAttachmentName {
    private static let allowed = try! NSRegularExpression(
        pattern: #"^call-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-(?:media_node|pixel)-(?:remote_original|caller_original|caller_playout|conversation)\.(?:ogg|wav|mp3)$"#
    )

    /// S36 C4: an export asks for `format=mp3`; everything else keeps the recording's own container.
    static func fileExtension(source: RecordingSource, format: String? = nil) -> String {
        if let format, !format.isEmpty { return format }
        return source == .pixel ? "wav" : "ogg"
    }

    static func mediaType(source: RecordingSource, format: String? = nil) -> String {
        switch fileExtension(source: source, format: format) {
        case "mp3": "audio/mpeg"
        case "wav": "audio/wav"
        default: "audio/ogg"
        }
    }

    static func filename(callID: String, source: RecordingSource, track: String, header: String?,
                         format: String? = nil) -> String {
        let ext = fileExtension(source: source, format: format)
        let fallback = "call-\(callID)-\(source.rawValue)-\(track).\(ext)"
        guard let quoted = quotedFilename(header), quoted.hasSuffix(".\(ext)") else { return fallback }
        let range = NSRange(quoted.startIndex..<quoted.endIndex, in: quoted)
        guard allowed.firstMatch(in: quoted, range: range) != nil else { return fallback }
        return quoted
    }

    private static func quotedFilename(_ header: String?) -> String? {
        guard let header, let marker = header.range(of: "filename=\"", options: .caseInsensitive) else { return nil }
        let rest = header[marker.upperBound...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        return String(rest[..<end])
    }
}
