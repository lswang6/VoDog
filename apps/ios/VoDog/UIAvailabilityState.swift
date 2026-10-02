import Foundation
@preconcurrency import Network
import Observation
import SwiftUI
import UIKit

/// Presentation only. This never changes authentication, request retries, or media connectivity.
@MainActor @Observable
final class UIAvailabilityState {
    enum PathState: Equatable { case unknown, available, unavailable }
    private(set) var path: PathState = .unknown
    private(set) var controlUnavailable = false
    private(set) var sims: [SIMChannel] = []
    private(set) var hasCurrentSIMSnapshot = false
    /// S73e: a call's media leg is up or rejoining; only the offline wording changes, never the gating.
    var callMediaActive = false

    var canMutate: Bool { path == .available && !controlUnavailable }
    var reason: String? {
        if path == .unavailable {
            return callMediaActive ? "网络已断开，恢复后通话将自动重连" : "设备未联网，已加载内容仍可查看；联网后可继续提交。"
        }
        if path == .unknown { return "正在确认设备网络，已加载内容仍可查看。" }
        if controlUnavailable { return "连接暂不可用，已保留上次内容；正在等待刷新。" }
        return nil
    }

    func resetSessionSnapshot() {
        sims = []
        hasCurrentSIMSnapshot = false
        controlUnavailable = false
    }

    func updatePath(available: Bool) {
        path = available ? .available : .unavailable
        if !available { hasCurrentSIMSnapshot = false }
    }

    func didRefreshSIMs(_ value: [SIMChannel]) {
        sims = value
        controlUnavailable = false
        hasCurrentSIMSnapshot = path != .unavailable
    }

    func didFailRefresh(_ error: Error) {
        // Business conflicts, cancellation and authorization errors are not connectivity evidence.
        if let error = error as? URLError,
           [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
            .cannotFindHost, .dnsLookupFailed, .timedOut].contains(error.code) {
            controlUnavailable = true
            hasCurrentSIMSnapshot = false
        } else if let error = error as? APIError, case let .server(status, _, _) = error,
                  (500...599).contains(status) {
            controlUnavailable = true
            hasCurrentSIMSnapshot = false
        }
    }

    func simStatus(_ sim: SIMChannel) -> String {
        if path == .unavailable { return "设备未联网" }
        if !canMutate { return path == .unknown ? "正在确认网络" : "连接暂不可用" }
        if !hasCurrentSIMSnapshot { return "号码状态待刷新" }
        guard let current = sims.first(where: { $0.id == sim.id }) else { return "号码状态待刷新" }
        return current.online == true ? "在线" : "号码设备离线"
    }

    func canDial(on simID: String?) -> Bool {
        canMutate && hasCurrentSIMSnapshot && SIMSelectionPolicy.canDial(on: simID, sims: sims)
    }

    func canSendSMS(on simID: String?) -> Bool {
        canMutate && hasCurrentSIMSnapshot && SIMSelectionPolicy.canSendSMS(on: simID, sims: sims)
    }

    func canChangeGatewayPower(_ item: GatewayPower) -> Bool {
        // A powered-off gateway may still be reachable through its standby channel.
        canMutate && GatewayPowerPolicy.toggleDisabledReason(item) == nil
    }

    func monitor() async {
        let monitor = NWPathMonitor()
        let updates = AsyncStream<Bool> { continuation in
            monitor.pathUpdateHandler = { path in continuation.yield(path.status == .satisfied) }
            continuation.onTermination = { _ in monitor.cancel() }
            monitor.start(queue: DispatchQueue(label: "org.vodog.ui-availability"))
        }
        defer { monitor.cancel() }
        for await available in updates {
            guard !Task.isCancelled else { return }
            updatePath(available: available)
        }
    }
}

/// Identity and its nonempty content travel together; snapshot refreshes do not change identity.
struct CallUIPayload: Identifiable {
    struct ID: Hashable { let session: UUID; let call: String }
    let id: ID
    var call: CallRecord
}

struct CallUIPresentationPolicy {
    private(set) var current: CallUIPayload?
    private(set) var presented: CallUIPayload?
    private var sessionID: UUID?
    private var seen: Set<CallUIPayload.ID> = []
    private var ended: Set<String> = []

    mutating func update(sessionID: UUID?, calls: [CallRecord], mediaCallID: String?) {
        if self.sessionID != sessionID {
            self.sessionID = sessionID
            current = nil; presented = nil; seen.removeAll(); ended.removeAll()
        }
        guard let sessionID else { return }
        ended.formUnion(calls.filter { ["ended", "failed"].contains($0.state ?? "") }.map(\.id))
        if let current, let row = calls.first(where: { $0.id == current.id.call }),
           ["ended", "failed"].contains(row.state ?? "") || row.claimedByCurrentSession != true || row.suppressesRinging {
            self.current = nil; presented = nil
        }
        guard let call = CallAvailabilityPolicy.primaryOwnedCall(calls.filter { !ended.contains($0.id) }, currentMediaCallID: mediaCallID),
              !call.suppressesRinging else { return }
        let payload = CallUIPayload(id: .init(session: sessionID, call: call.id), call: call)
        current = payload
        let firstAppearance = seen.insert(payload.id).inserted
        presented = presented?.id == payload.id || firstAppearance ? payload : nil
    }

    mutating func minimize() { presented = nil }
    mutating func restore() { presented = current }
}

struct NetworkAvailabilityNotice: View {
    @Environment(UIAvailabilityState.self) private var availability
    var body: some View {
        if let reason = availability.reason {
            // S95: 本机未联网 / 服务连接暂不可用 (spec §1.3); the existing reason stays the explanation.
            let device = availability.path != .available
            StatusBanner(
                kind: device ? .deviceOffline : .serviceUnavailable,
                title: availability.path == .unknown ? "正在确认网络" : (device ? "本机未联网" : "服务连接暂不可用"),
                message: reason
            )
            .accessibilityIdentifier("network.availability")
        }
    }
}

enum CallUIEndPolicy {
    /// A UI wait bound, not a success/failure signal from the private reliable-end queue.
    static var confirmationWindow: TimeInterval {
        TimeInterval(ReliableCallEndPolicy.totalDelay.components.seconds)
            + Double(ReliableCallEndPolicy.retryDelays.count) * ReliableCallEndPolicy.requestTimeout
    }

    static func isPending(requestedAt: Date?, state: String?, now: Date) -> Bool {
        if state == "ending" { return true }
        guard let requestedAt else { return false }
        return now.timeIntervalSince(requestedAt) < confirmationWindow
    }
}

enum CallElapsedTimePolicy {
    static func seconds(answeredAt: String?, endedAt: String?, now: Date, state: String? = nil, requestedAt: Date? = nil, endingObservedAt: Date? = nil) -> Int? {
        if ["ended", "failed"].contains(state ?? ""), endedAt == nil { return nil }
        guard let answeredAt, let answered = GatewayTimeDisplay.parseISO(answeredAt) else { return nil }
        let end: Date
        if let endedAt {
            guard let parsed = GatewayTimeDisplay.parseISO(endedAt) else { return nil }
            end = parsed
        } else if let requestedAt, CallUIEndPolicy.isPending(requestedAt: requestedAt, state: state, now: now) {
            end = requestedAt
        } else if state == "ending" {
            guard let endingObservedAt else { return nil }
            end = endingObservedAt
        } else { end = now }
        return Int(floor(max(0, end.timeIntervalSince(answered))))
    }

    static func text(seconds: Int) -> String {
        if seconds >= 3600 { return String(format: "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60) }
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

/// Only this small label ticks; it never participates in the presentation identity or call polling.
struct CallElapsedTime: View {
    let call: CallRecord
    var requestedAt: Date? = nil
    var endingObservedAt: Date? = nil
    var body: some View {
        if let answeredAt = call.answeredAt, GatewayTimeDisplay.parseISO(answeredAt) != nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let seconds = CallElapsedTimePolicy.seconds(answeredAt: answeredAt, endedAt: call.endedAt, now: context.date, state: call.state, requestedAt: requestedAt, endingObservedAt: endingObservedAt)
                Text(seconds.map { CallElapsedTimePolicy.text(seconds: $0) } ?? "—")
                    .monospacedDigit()
                    .accessibilityHidden(true)
            }
            // A stable accessible element, with an explicitly requested announcement only.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("通话时长")
            .accessibilityAction(named: Text("朗读当前通话时长")) {
                let seconds = CallElapsedTimePolicy.seconds(answeredAt: answeredAt, endedAt: call.endedAt, now: .now, state: call.state, requestedAt: requestedAt, endingObservedAt: endingObservedAt)
                let value = seconds.map { CallElapsedTimePolicy.text(seconds: $0) } ?? "暂不可用"
                UIAccessibility.post(notification: .announcement, argument: "通话时长 \(value)")
            }
        }
    }
}

struct CallUIStatusLabel: View {
    let call: CallRecord
    let requestedAt: Date?
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if CallUIEndPolicy.isPending(requestedAt: requestedAt, state: call.state, now: context.date) {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini).accessibilityHidden(true)
                    Text("正在结束…")
                }
            } else if requestedAt != nil {
                Text("结束待确认，点按查看")
            } else {
                Text(callStateTitle(call.state))
            }
        }
    }
}
