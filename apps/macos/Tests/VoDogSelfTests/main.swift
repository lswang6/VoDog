import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    if !condition() {
        FileHandle.standardError.write(Data("VoDogSelfTests failed (line \(line)): \(message)\n".utf8))
        exit(1)
    }
}

func object(_ text: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
}

// Apply state machine (S32 port).
do {
    typealias P = VoDogApplyPolicy
    let t0 = Date(timeIntervalSince1970: 1_000)
    let applying = P.State.applying(started: t0, target: 5)
    check(P.next(applying, now: t0.addingTimeInterval(2), appliedVersion: 4, version: 5) == applying, "no ack yet keeps applying")
    check(P.next(applying, now: t0.addingTimeInterval(2), appliedVersion: 5, version: 5) == .applied, "exact ack applies")
    check(P.next(applying, now: t0.addingTimeInterval(2), appliedVersion: 5, version: 4) == applying,
          "applied without version==target is not success")
    check(P.next(applying, now: t0.addingTimeInterval(2), appliedVersion: 5, version: 6) == .superseded, "newer version supersedes")
    check(P.next(applying, now: t0.addingTimeInterval(30), appliedVersion: 4, version: 5) == .timedOut, "30 s without ack times out")
    check(P.next(applying, now: t0.addingTimeInterval(29.9), appliedVersion: 4, version: 5) == applying, "29.9 s still applying")
    check(P.next(.timedOut, now: t0, appliedVersion: 9, version: 9) == .timedOut, "only applying moves")
    check(P.label(applying, appliedVersion: 4, version: 5).tone == .pending, "applying label pending")
    check(P.label(applying, appliedVersion: 5, version: 5).tone == .success, "applying label success on exact ack")
    check(P.label(applying, appliedVersion: 6, version: 6).tone == .warning, "applying label superseded")
    check(P.label(.idle, appliedVersion: 3, version: 3).tone == .success, "idle applied>=version success")
    check(P.label(.idle, appliedVersion: 2, version: 3).tone == .warning, "idle unacked warning")
    check(P.label(.idle, appliedVersion: nil, version: nil).tone == .none, "no settings says nothing")
    check(P.hasExternalChange(currentVersion: 4, baseVersion: 3, draftIsDirty: true), "dirty draft + new version conflicts")
    check(!P.hasExternalChange(currentVersion: 4, baseVersion: 3, draftIsDirty: false), "clean draft adopts")
}

// Token policy.
do {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    check(!VoDogTokenPolicy.needsRefresh(expiresAt: nil, now: now), "unknown expiry never forces refresh")
    check(!VoDogTokenPolicy.needsRefresh(expiresAt: GatewayJSON.iso(now.addingTimeInterval(120)), now: now), "2 min left ok")
    check(VoDogTokenPolicy.needsRefresh(expiresAt: GatewayJSON.iso(now.addingTimeInterval(59)), now: now), "59 s left refreshes")
    check(VoDogTokenPolicy.needsRefresh(expiresAt: "2023-11-14T22:00:00Z", now: now), "expired refreshes (no fraction)")
    check(VoDogTokenPolicy.shouldRefreshAndRetry(status: 401, path: "/sims", hadToken: true), "401 refreshes")
    check(!VoDogTokenPolicy.shouldRefreshAndRetry(status: 401, path: "/auth/login", hadToken: true), "login 401 is credentials")
    check(!VoDogTokenPolicy.shouldRefreshAndRetry(status: 401, path: "/sims", hadToken: false), "anonymous 401 no refresh")
    check(!VoDogTokenPolicy.shouldRefreshAndRetry(status: 403, path: "/sims", hadToken: true), "403 no refresh")
}

// S69 api.error / gateway.error coalescing: one per key per 60 s, the next admitted row reports `repeat`.
do {
    var throttle = VoDogDiagThrottle()
    let t0 = Date(timeIntervalSince1970: 0)
    check(throttle.admit("GET /sims|503", now: t0) == 0, "first error admitted")
    check(throttle.admit("GET /sims|503", now: t0.addingTimeInterval(1)) == nil, "repeat within window dropped")
    check(throttle.admit("GET /sims|503", now: t0.addingTimeInterval(59)) == nil, "still inside window")
    check(throttle.admit("GET /calls|503", now: t0.addingTimeInterval(2)) == 0, "other routes independent")
    check(throttle.admit("GET /sims|0", now: t0.addingTimeInterval(2)) == 0, "other codes independent")
    check(throttle.admit("GET /sims|503", now: t0.addingTimeInterval(60)) == 2, "after window, repeat count reported")
    check(throttle.admit("GET /sims|503", now: t0.addingTimeInterval(121)) == 0, "count resets")
    check(VoDogDiagThrottle.routeTemplate("/calls/5f0c4b1e-8a4e-4c1a-9a55-1f2e3d4c5b6a/end") == "/calls/:id/end",
          "uuid segment templated")
    check(VoDogDiagThrottle.routeTemplate("/sms/42") == "/sms/:id", "numeric segment templated")
    check(VoDogDiagThrottle.routeTemplate("/sims") == "/sims", "plain route unchanged")
    check(VoDogDiagThrottle.networkErrorType(URLError(.timedOut)) == "timeout", "timeout type")
    check(VoDogDiagThrottle.networkErrorType(URLError(.notConnectedToInternet)) == "offline", "offline type")
    check(VoDogDiagThrottle.networkErrorType(URLError(.cannotFindHost)) == "dns", "dns type")
    check(VoDogDiagThrottle.networkErrorType(URLError(.serverCertificateUntrusted)) == "tls", "tls type")
    check(VoDogDiagThrottle.networkErrorType(CocoaError(.fileNoSuchFile)) == "other", "non-URL error is other")

    // S69 ui.error_shown hook: fires with the calling file/function, never for cancellation.
    var shown: [(String, String, Int?, String?)] = []
    VoDogErrorText.onShown = { screen, site, _, code, serverCode in shown.append((screen, site, code, serverCode)) }
    _ = VoDogErrorText.message(CancellationError())
    _ = VoDogErrorText.message(VoDogAPIError(status: 409, code: "VERSION_CONFLICT", message: nil, body: Data()))
    check(shown.count == 1 && shown[0].0 == "main" && shown[0].2 == 409 && shown[0].3 == "VERSION_CONFLICT",
          "ui.error_shown reported once with screen and code (\(shown))")
    shown.removeAll()
    check(VoDogErrorText.shown("local") == "local", "shown returns its text")
    VoDogErrorText.shown("cancelled", error: CancellationError())
    VoDogErrorText.shown("conflict", error: VoDogAPIError(status: 409, code: nil, message: nil, body: Data()))
    check(shown.count == 2 && shown[0].2 == nil && shown[1].2 == 409,
          "local error text reported without code, cancellation skipped (\(shown))")
    VoDogErrorText.onShown = nil
    check(VoDogDiagThrottle.isCancellation(URLError(.cancelled)), "URLError.cancelled is cancellation")
    check(VoDogDiagThrottle.isCancellation(CancellationError()), "CancellationError is cancellation")
    check(!VoDogDiagThrottle.isCancellation(URLError(.timedOut)), "timeout is a real error")
}

// Decoding (fail-closed defaults).
do {
    let sims = try VoDogJSON.decode(SimList.self, from: object("""
    {"items":[{"id":"s1","gatewayId":"g","slotIndex":0,"label":null,"phoneLabel":"工作","version":3,"online":true,
      "settings":{"mode":"timeout_ai","timeoutSeconds":45,"version":7,"appliedVersion":6,
                  "availableModes":["normal","ai","timeout_ai"],"aiUnavailableReason":null}},
     {"id":"s2","slotIndex":1,"label":"Pixel","version":1,"settings":{"mode":"normal","timeoutSeconds":30,"version":1}}]}
    """)).items
    check(sims.count == 2 && sims[0].settings?.appliedVersion == 6, "sims decode")
    check(sims[0].settings?.isAvailable(.ai) == true, "advertised modes available")
    check(sims[1].settings?.isAvailable(.ai) == false && sims[1].settings?.isAvailable(.normal) == true,
          "missing availableModes fails closed to normal")
    check(sims[1].settings?.mergingCapabilities(from: sims[0].settings).isAvailable(.ai) == true, "capabilities merge")
    check(sims[1].displayName == "Pixel", "label display name")

    let providers = try VoDogJSON.decode(VoDogVoiceProviderList.self, from: object("""
    {"items":[{"id":"xai","label":"xAI","configured":true,"online":true},{"id":"doubao"}],"selected":"xai","configVersion":4}
    """))
    check(providers.configVersion == 4 && providers.selected == "xai", "provider list decode")
    check(providers.items[0].disabledReason == nil, "configured+online selectable")
    check(providers.items[1].disabledReason != nil && providers.items[1].displayLabel == "doubao", "partial provider disabled")
    let emptyList = try VoDogJSON.decode(VoDogVoiceProviderList.self, from: [:])
    check(emptyList.configVersion == 1, "empty list defaults")

    let power = try VoDogJSON.decode(VoDogGatewayPower.self, from: object(#"{"gatewayId":"abcdef1234"}"#))
    check(!power.online && !power.controlEnabled && !power.remotePowerAllowed && !power.occupied, "power fails closed")
    check(power.toggleDisabledReason != nil && power.displayName == "GW-abcdef12", "power disabled with reason")
    let on = try VoDogJSON.decode(VoDogGatewayPower.self, from: object("""
    {"gatewayId":"g","controlEnabled":true,"online":true,"remotePowerAllowed":true,"occupied":true,
     "lastPowerResult":{"desired":"off","ok":false,"reason":"call_in_progress"}}
    """))
    check(on.toggleDisabledReason != nil, "occupied gateway cannot be switched off")
    check(on.lastResultFailure?.contains("call_in_progress") == true, "last failure reported")

    let passkey = try VoDogJSON.decode(VoDogPasskey.self, from: object(#"{"id":"abc","createdAt":"2026-01-01T00:00:00Z","label":"  "}"#))
    check(passkey.resolvedName == "通行密钥", "blank label falls back")

    let error = VoDogAccount.apiError(status: 409, data: Data(#"{"error":{"code":"VERSION_CONFLICT","message":"x"}}"#.utf8))
    check(VoDogErrorText.isVersionConflict(error) && !VoDogErrorText.isProviderConflict(error), "error envelope")
} catch {
    check(false, "decode threw \(error)")
}

struct SimList: Decodable { var items: [VoDogSIM] }

// Account: URL building, single-flight refresh, one retry, refresh failure logs out.
final class StubProtocol: URLProtocol {
    static let lock = NSLock()
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, String))?
    nonisolated(unsafe) static var log: [String] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    override func startLoading() {
        let (status, body) = Self.lock.withLock {
            Self.log.append("\(request.httpMethod ?? "") \(request.url?.path ?? "") \(request.value(forHTTPHeaderField: "Authorization") ?? "-")")
            return Self.handler!(request)
        }
        // A small delay so concurrent requests overlap and must share one refresh.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            let response = HTTPURLResponse(url: self.request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: Data(body.utf8))
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

@MainActor
func accountTests() async {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    let urlSession = URLSession(configuration: configuration)
    var saved: VoDogStoredSession? = VoDogStoredSession(
        token: "old", refreshToken: "r1", expiresAt: nil,
        user: VoDogUser(id: "u", username: "a@b", role: "admin"))
    var refreshCalls = 0
    var refreshStatus = 200
    var diagPosts: [[String]] = []
    var diagStatus = 200
    StubProtocol.handler = { request in
        let auth = request.value(forHTTPHeaderField: "Authorization")
        switch (request.httpMethod ?? "", request.url?.path ?? "") {
        case ("POST", "/api/v1/auth/refresh"):
            refreshCalls += 1
            return refreshStatus == 200
                ? (200, #"{"token":"new","refreshToken":"r2","expiresAt":"2099-01-01T00:00:00.000Z"}"#)
                : (401, #"{"error":{"code":"INVALID_REFRESH_TOKEN"}}"#)
        case ("GET", "/api/v1/auth/me"):
            return auth == "Bearer new" ? (200, #"{"user":{"id":"u","username":"a@b","role":"user"}}"#) : (401, "{}")
        case ("GET", "/api/v1/sims"):
            return auth == "Bearer new" ? (200, #"{"items":[]}"#) : (401, #"{"error":{"code":"UNAUTHENTICATED"}}"#)
        case ("DELETE", "/api/v1/passkeys/x"):
            return (204, "")
        case ("POST", "/api/v1/diag/events"):
            let items = (try? JSONSerialization.jsonObject(with: StubProtocol.body(request))) as? [[String: Any]] ?? []
            diagPosts.append(items.compactMap { $0["event"] as? String })
            return (diagStatus, #"{"accepted":1}"#)
        case ("GET", "/api/v1/slow"):
            return (200, "{}")
        default:
            return (404, "{}")
        }
    }
    let store = VoDogAccount.Store(load: { saved }, save: { saved = $0 }, delete: { saved = nil })
    let account = VoDogAccount(store: store, urlSession: urlSession)
    check(account.user?.role == "admin", "stored session restores synchronously")

    let url = account.url("/contacts/lookup", query: ["number": "+86 138&x=1"])
    check(url.absoluteString == "https://vodog.example.invalid/api/v1/contacts/lookup?number=%2B86%20138%26x%3D1",
          "query escapes + & = (\(url.absoluteString))")

    async let first = account.json("GET", "/sims")
    async let second = account.json("GET", "/sims")
    let results = try? await (first, second)
    check(results != nil, "both 401'd requests succeed after refresh")
    check(refreshCalls == 1, "single-flight refresh (\(refreshCalls) calls)")
    check(saved?.token == "new" && saved?.refreshToken == "r2", "refreshed tokens persisted")
    try? await Task.sleep(nanoseconds: 300_000_000)  // let the launch-time /auth/me settle
    check(account.user?.role == "user", "/auth/me refreshed the user")

    let deleted = try? await account.json("DELETE", "/passkeys/x")
    check(deleted?.isEmpty == true, "204 decodes to an empty object")

    // Cancelled requests (tab switch) are neither logged nor surfaced as API errors.
    await account.flushDiag()
    let before = account.pendingDiagCount
    let cancelled = Task { try await account.json("GET", "/slow") }
    cancelled.cancel()
    do {
        _ = try await cancelled.value
        check(false, "cancelled request must throw")
    } catch {
        check(error is CancellationError, "cancellation surfaces as CancellationError (\(error))")
    }
    check(account.pendingDiagCount == before, "cancellation logs no api.error")
    account.errorShown(screen: "S", site: "f()", message: "m", code: 500, serverCode: nil)
    account.errorShown(screen: "S", site: "g()", message: "m", code: 500, serverCode: nil)
    check(account.pendingDiagCount == before + 1, "ui.error_shown deduped per (screen, message)")

    // Flush is single flight and never re-sends a delivered batch.
    diagPosts.removeAll()
    for index in 0..<3 { account.diag("test.event\(index)") }
    async let flushA: Void = account.flushDiag()
    async let flushB: Void = account.flushDiag()
    _ = await (flushA, flushB)
    await account.flushDiag()
    let sent = diagPosts.flatMap { $0 }.filter { $0.hasPrefix("test.event") }
    check(sent == ["test.event0", "test.event1", "test.event2"], "each event uploaded exactly once (\(diagPosts))")
    check(account.pendingDiagCount == 0, "queue drained")
    diagStatus = 503
    account.diag("test.retry")
    await account.flushDiag()
    check(account.pendingDiagCount == 1, "retryable failure re-queues")
    diagStatus = 200
    await account.flushDiag()
    check(account.pendingDiagCount == 0 && diagPosts.last == ["test.retry"], "re-queued event delivered once")

    // Refresh rejected → logged out, Keychain cleared, one refresh attempt only.
    refreshStatus = 401
    refreshCalls = 0
    StubProtocol.log.removeAll()
    saved?.token = "stale"
    let reloaded = VoDogAccount(store: store, urlSession: urlSession)
    do {
        _ = try await reloaded.json("GET", "/sims")
        check(false, "request after refresh failure must throw")
    } catch {
        check((error as? VoDogAPIError)?.status == 401, "refresh failure surfaces 401")
    }
    try? await Task.sleep(nanoseconds: 300_000_000)
    check(reloaded.user == nil && saved == nil, "refresh failure logs out and clears the store")
    check(refreshCalls == 1, "refresh failure is not retried (\(refreshCalls))")
    check(StubProtocol.log.filter { $0.hasPrefix("GET /api/v1/sims") }.count == 1, "no retry without a fresh token")
    check(reloaded.pendingDiagCount > 0, "auth.refresh_failed / api.error queued")
}

// S67 badges: decode, per-kind / per-SIM counts, text, optimistic decrement.
do {
    let badges = try VoDogJSON.decode(VoDogBadges.self, from: object(
        #"{"calls":3,"sms":120,"sims":[{"simId":"a","calls":2,"sms":0},{"simId":"b","calls":1,"sms":120}]}"#))
    check(badges.count(.calls) == 3 && badges.count(.sms) == 120 && badges.count(nil) == 123, "totals")
    check(badges.count(.calls, simID: "a") == 2 && badges.count(nil, simID: "b") == 121, "per SIM")
    check(badges.count(nil, simID: "missing") == 0, "SIM not listed = 0")
    check(VoDogBadges.text(0) == nil && VoDogBadges.text(-1) == nil, "0 hidden")
    check(VoDogBadges.text(1) == "1" && VoDogBadges.text(99) == "99" && VoDogBadges.text(100) == "99+", "99+")
    var copy = badges
    copy.decrementCall(simID: "a")
    check(copy.calls == 2 && copy.count(.calls, simID: "a") == 1 && copy.count(.calls, simID: "b") == 1, "decrement total + SIM")
    copy.decrementCall(simID: nil); copy.decrementCall(simID: nil); copy.decrementCall(simID: nil)
    check(copy.calls == 0, "never below 0")
} catch {
    check(false, "badges decode threw \(error)")
}

@MainActor
func badgeStoreTests() async {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    var saved: VoDogStoredSession? = VoDogStoredSession(
        token: "t", refreshToken: "r", expiresAt: nil, user: VoDogUser(id: "u", username: "a@b", role: "user"))
    var badgeStatus = 200
    var calls = 2
    var readBodies: [[String]] = []
    StubProtocol.handler = { request in
        switch (request.httpMethod ?? "", request.url?.path ?? "") {
        case ("GET", "/api/v1/auth/me"): return (200, #"{"user":{"id":"u","username":"a@b","role":"user"}}"#)
        case ("GET", "/api/v1/badges"):
            return (badgeStatus, badgeStatus == 200 ? #"{"calls":\#(calls),"sms":1,"sims":[{"simId":"a","calls":\#(calls),"sms":1}]}"# : "{}")
        case ("POST", "/api/v1/calls/c1/seen"):
            calls -= 1
            return (204, "")
        case ("POST", "/api/v1/sms/read"):
            let body = (try? JSONSerialization.jsonObject(with: StubProtocol.body(request))) as? [String: Any]
            readBodies.append(body?["ids"] as? [String] ?? [])
            return (200, #"{"updated":1}"#)
        default: return (404, "{}")
        }
    }
    let store = VoDogAccount.Store(load: { saved }, save: { saved = $0 }, delete: { saved = nil })
    let account = VoDogAccount(store: store, urlSession: URLSession(configuration: configuration))
    let badges = account.badges
    await badges.refresh()
    check(badges.counts.calls == 2 && badges.counts.count(.sms, simID: "a") == 1, "refresh loads /badges")
    badgeStatus = 404
    await badges.refresh()
    check(badges.counts.calls == 2, "404 keeps the last value")
    await badges.markCallSeen("c1", simID: "a", pending: true)
    check(badges.counts.calls == 1 && badges.counts.count(.calls, simID: "a") == 1, "seen → optimistic −1 (refresh failed)")
    StubProtocol.log.removeAll()
    await badges.markCallSeen("c1", simID: "a", pending: true)
    check(StubProtocol.log.isEmpty && badges.counts.calls == 1, "same call not posted or decremented twice")
    badgeStatus = 200
    await badges.markSMSRead(["m1", "m2"])
    check(readBodies == [["m1", "m2"]], "sms/read sends the ids")
    check(badges.counts.calls == 1, "read triggers a refresh")
    await badges.markSMSRead([])
    check(readBodies.count == 1, "empty ids not posted")
    await account.logout()
    check(badges.counts == VoDogBadges(), "logout clears badges")
    StubProtocol.log.removeAll()
    await badges.refresh()
    check(StubProtocol.log.isEmpty, "no poll while signed out")
}

await accountTests()
await badgeStoreTests()
print("VoDogSelfTests passed")
