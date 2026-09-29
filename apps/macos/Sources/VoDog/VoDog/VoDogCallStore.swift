import AppKit
import Foundation

/// S57 remote call state for the signed-in Mac (iOS `CallsView` dial/claim/end/DTMF + Web ringing
/// filter): the one call this session owns, the ringing call it may answer, and the guarded end queue.
@MainActor
final class VoDogCallStore: ObservableObject {
    static let shared = VoDogCallStore()

    let media = VoDogCallMedia()
    /// The call this session dialed or claimed; nil once it ended.
    @Published private(set) var active: VoDogLiveCall?
    @Published private(set) var incoming: VoDogLiveCall? {
        didSet { if oldValue?.id != incoming?.id { onIncomingChange?() } }
    }
    /// S72 D1: AppState's single ring arbiter (shared ringtone + "call-incoming" notification).
    var onIncomingChange: (() -> Void)?
    @Published private(set) var busy = false
    @Published var error: String?

    private weak var account: VoDogAccount?
    private var declined = Set<String>()
    private var watchTask: Task<Void, Never>?
    private var poller: Task<Void, Never>?

    private struct Envelope: Decodable { var call: VoDogLiveCall }
    private struct List: Decodable { var items: [VoDogLiveCall] }

    func bind(_ account: VoDogAccount) {
        guard self.account !== account else { return }
        self.account = account
        account.willLogout = { [weak self] in await self?.endForLogout() }
    }

    /// S72 D1: app-lifetime `/calls` poll every 5 s while signed in, window shown or not, so a menu-bar-only
    /// Mac still rings (S69 kept the 30 s background cadence for every other list; this one is ring-critical).
    // ponytail: ~17k requests/day while signed in; a push/long-poll channel would replace it.
    func startPolling() {
        guard poller == nil else { return }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.account?.user == nil {
                    if self.incoming != nil { self.incoming = nil }
                } else if self.active == nil {
                    await self.pollIncoming()
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    /// Signed out (logout or a failed refresh): drop everything local; the server revoked the session.
    func reset() {
        watchTask?.cancel()
        watchTask = nil
        media.stop()
        active = nil
        incoming = nil
        error = nil
        declined = []
    }

    /// Also called once by AppState's local 接听 before the gateway has bound its call id.
    func pollIncoming() async {
        guard let account else { return }
        do {
            let list = try await account.decode(List.self, "GET", "/calls",
                                                 query: ["includeBlocked": "true", "limit": "20"])
            let ringing = VoDogPhonePolicy.incomingRinging(list.items.filter { !declined.contains($0.id) })
            if active == nil { incoming = ringing }
        } catch {
            // A missed tick only delays the ring by 5 s; the ring card keeps its last known state.
        }
    }

    // MARK: Actions

    func dial(simId: String, number: String) async {
        guard let account, active == nil, !busy else { return }
        let remote = VoDogPhonePolicy.normalizedNumber(number)
        guard !remote.isEmpty else { return }
        busy = true
        error = nil
        defer { busy = false }
        let started = Date()
        do {
            let response = try await account.decode(Envelope.self, "POST", "/calls/outbound",
                                                    body: ["simId": simId, "remoteNumber": remote], idempotent: true)
            account.diag("call.outbound", callId: response.call.id, fields: [
                "simId": simId, "numberLength": remote.count, "ms": Int(Date().timeIntervalSince(started) * 1_000)
            ])
            // Own the call id before anything else awaits: a lost id would leave the gateway locked.
            begin(response.call, account: account)
        } catch is CancellationError {
            return
        } catch {
            let api = error as? VoDogAPIError
            account.diag("call.outbound", level: "warn", fields: ["simId": simId, "status": api?.status ?? 0, "code": api?.code ?? ""])
            self.error = VoDogErrorText.message(error)
        }
    }

    func answer(_ call: VoDogLiveCall) async {
        guard let account, active == nil, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let response = try await account.decode(Envelope.self, "POST", "/calls/\(call.id)/claim",
                                                    body: ["platform": "macos", "deviceName": VoDogAccount.deviceName])
            account.diag("call.claim", callId: call.id, fields: ["result": "ok"])
            incoming = nil
            begin(response.call, account: account)
        } catch is CancellationError {
            return
        } catch {
            let api = error as? VoDogAPIError
            account.diag("call.claim", level: "warn", callId: call.id, fields: ["status": api?.status ?? 0, "code": api?.code ?? ""])
            self.error = VoDogErrorText.message(error)
            incoming = nil   // taken elsewhere or gone; the next poll shows it again if it still rings
        }
    }

    func decline(_ call: VoDogLiveCall) {
        guard call.state == "incoming_ringing", !call.suppressesRinging else { return }
        declined.insert(call.id)
        incoming = nil
        enqueueEnd(call.id, declining: true)
    }

    func hangUp() {
        guard let call = active else { return }
        media.stop()
        watchTask?.cancel()
        active = nil
        enqueueEnd(call.id, declining: false)
    }

    func sendDTMF(_ digit: String) async {
        guard let account, let call = active else { return }
        do {
            _ = try await account.json("POST", "/calls/\(call.id)/dtmf", body: ["digits": digit])
        } catch {
            self.error = VoDogErrorText.message(error)
        }
    }

    // MARK: Lifecycle

    private func begin(_ call: VoDogLiveCall, account: VoDogAccount) {
        active = call
        // S56 early media: media starts at once, so ringback / carrier tones are heard before `active`.
        Task { await media.start(callID: call.id, account: account) }
        watchTask?.cancel()
        watchTask = Task { [weak self] in await self?.watch(call.id) }
    }

    /// Call state every 1.5 s until the server reports it ended (the far end or the gateway hung up).
    private func watch(_ id: String) async {
        while !Task.isCancelled, active?.id == id, let account {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled, active?.id == id else { return }
            do {
                let call = try await account.decode(Envelope.self, "GET", "/calls/\(id)").call
                guard active?.id == id else { return }
                active = call
                if call.isFinished { finish(id) }
            } catch let error as VoDogAPIError where error.status == 404 {
                finish(id)
            } catch {
                // Transient: keep the call and its controls; 结束通话 always works through the end queue.
            }
        }
    }

    private func finish(_ id: String) {
        guard active?.id == id else { return }
        if media.callID == id { media.stop() }
        active = nil
    }

    /// Guarded `POST /calls/:id/end` with backoff: a lost end keeps the SIM locked, and the guard makes a
    /// late retry harmless to a call another device answered meanwhile.
    private func enqueueEnd(_ id: String, declining: Bool) {
        guard let account else { return }
        let body = VoDogPhonePolicy.endBody(declining: declining)
        Task { [weak account] in
            for (index, delay) in VoDogPhonePolicy.endRetryDelays.enumerated() {
                if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                guard let account, account.user != nil else { return }
                do {
                    let response = try await account.decode(Envelope.self, "POST", "/calls/\(id)/end", body: body)
                    if response.call.isFinished { return }
                } catch let error as VoDogAPIError
                    where VoDogPhonePolicy.shouldStopEnding(status: error.status, code: error.code) {
                    return
                } catch {
                    account.diag("call.end_retry", level: "warn", callId: id, fields: [
                        "attempt": index + 1, "status": (error as? VoDogAPIError)?.status ?? 0
                    ])
                }
            }
        }
    }

    /// Sign-out ends an owned call first, while the token still works (one guarded request).
    private func endForLogout() async {
        if let call = active, let account {
            media.stop()
            _ = try? await account.json("POST", "/calls/\(call.id)/end",
                                        body: VoDogPhonePolicy.endBody(declining: false))
        }
        reset()
    }
}

extension VoDogLiveCall {
    /// Ring card / notification title; S72 internal calls read "{calling SIM}（内部）".
    var ringTitle: String {
        if let peer = internalPeerLabel { return L10n.tr("%@（内部）", peer) }
        return [contactName, remoteNumber].compactMap { $0 }.first { !$0.isEmpty } ?? L10n.tr("未知号码")
    }
}
