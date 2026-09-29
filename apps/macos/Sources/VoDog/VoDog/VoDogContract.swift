import AppKit
import Foundation
import Security
import SwiftUI

// VoDog macOS client (spec: vodog docs/specs/S54-celldock-macos-client-and-multi-module.md).
// Shared seam between implementers. Owner C1 (account/shell/settings) replaces the
// VoDogAccount placeholder bodies; C2 (contacts/blocklist) and C3 (records) move their
// view stubs below into their own files. Change a signature here only with every owner.

struct VoDogUser: Codable, Equatable {
    var id: String
    var username: String
    var role: String            // "admin" | "user"
}

struct VoDogAPIError: Error, CustomStringConvertible {
    var status: Int
    var code: String?
    var message: String?
    var body: Data
    /// Transport failures (status 0): S69 `errorType` and the NSError's domain/code, never its description.
    var network: (type: String, domain: String, code: Int)? = nil
    var description: String { "HTTP \(status) \(code ?? "") \(message ?? "")" }
}

/// Logged-in user session against `https://vodog.example.invalid/api/v1` (platform "macos").
/// Login (Turnstile + password), Keychain tokens, single-flight refresh on 401 with one retry,
/// logout, `/auth/me`, client diagnostics (`X-Diag-Source: macos`).
@MainActor
final class VoDogAccount: ObservableObject {
    @Published var user: VoDogUser?
    /// Stored session being re-validated with `/auth/me` at launch.
    @Published private(set) var isVerifying = false
    /// Non-fatal session notice (e.g. the server could not be reached at launch).
    @Published var notice: String?
    var isAdmin: Bool { user?.role == "admin" }
    /// S57: the one `/sims` cache shared by the SIM strip, settings and records.
    @Published private(set) var sims: [VoDogSIM] = []
    /// Why the last `/sims` refresh failed; non-nil means `sims` is stale (every online dot greys out).
    @Published private(set) var simsError: String?
    @Published private(set) var simsLoaded = false
    /// Runs before `/auth/logout` revokes the token (S57: end an owned remote call first).
    var willLogout: (() async -> Void)?
    /// S67 unread badges (separate object so a count change re-renders only the badge sites).
    let badges = VoDogBadgeStore()
    let baseURL = VoDogServer.baseURL

    /// Session persistence; the Keychain in the app, in memory in self-tests.
    struct Store {
        var load: () -> VoDogStoredSession?
        var save: (VoDogStoredSession) -> Void
        var delete: () -> Void

        static let keychain = Store(load: VoDogKeychain.load, save: VoDogKeychain.save,
                                    delete: VoDogKeychain.delete)
    }

    private var session: VoDogStoredSession?
    private let store: Store
    private let urlSession: URLSession
    private var refreshTask: Task<Void, Error>?
    /// Bumped on login/logout so a late refresh or response cannot resurrect a replaced session.
    private var generation = 0
    private var diagQueue: [[String: Any]] = []
    private var diagFlushTask: Task<Void, Never>?
    private var diagFlushing = false
    private var apiErrorThrottle = VoDogDiagThrottle()
    private var errorShownThrottle = VoDogDiagThrottle()

    init(store: Store = .keychain, urlSession: URLSession = .shared) {
        self.store = store
        self.urlSession = urlSession
        badges.account = self
        logContext()
        if let stored = store.load() {
            session = stored
            user = stored.user
            Task { await verify() }
        }
    }

    // MARK: Session

    static var deviceName: String {
        String((Host.current().localizedName ?? "Mac").prefix(120))
    }

    /// `GET /auth/config` → Turnstile site key when the server requires a challenge.
    func turnstileSiteKey() async throws -> String? {
        let config = try await json("GET", "/auth/config")
        let turnstile = config["turnstile"] as? [String: Any]
        guard turnstile?["enabled"] as? Bool == true else { return nil }
        return turnstile?["siteKey"] as? String
    }

    func login(username: String, password: String, turnstileToken: String?) async throws {
        var body: [String: Any] = [
            "username": username.trimmingCharacters(in: .whitespacesAndNewlines), "password": password,
            "platform": "macos", "deviceName": Self.deviceName
        ]
        if let turnstileToken { body["turnstileToken"] = turnstileToken }
        do {
            let response = try await json("POST", "/auth/login", body: body)
            let stored = try VoDogJSON.decode(VoDogStoredSession.self, from: response)
            generation += 1
            session = stored
            store.save(stored)
            user = stored.user
            notice = nil
            diag("auth.login", fields: ["result": "ok", "role": stored.user.role])
            logContext()
        } catch {
            let api = error as? VoDogAPIError
            diag("auth.login", level: "warn", fields: ["result": "failed", "status": api?.status ?? 0, "code": api?.code ?? ""])
            throw error
        }
    }

    /// Re-validates the stored session; 401 goes through refresh, whose failure logs out.
    func verify() async {
        guard session != nil else { return }
        isVerifying = true
        defer { isVerifying = false }
        let expected = generation
        do {
            let me = try await json("GET", "/auth/me")
            guard expected == generation, var current = session,
                  let object = me["user"] as? [String: Any] else { return }
            current.user = try VoDogJSON.decode(VoDogUser.self, from: object)
            session = current
            store.save(current)
            user = current.user
            notice = nil
        } catch {
            guard expected == generation, session != nil else { return }
            notice = VoDogErrorText.shown(L10n.tr("暂时无法验证服务器，已保留登录凭据。"), error: error)
        }
    }

    func logout() async {
        await willLogout?()
        await flushDiag()
        if session != nil { _ = try? await json("POST", "/auth/logout", timeout: 5) }
        clearLocal()
    }

    private func clearLocal() {
        generation += 1
        refreshTask?.cancel()
        refreshTask = nil
        session = nil
        store.delete()
        user = nil
        sims = []
        simsError = nil
        simsLoaded = false
        badges.reset()
    }

    /// `GET /sims` into the shared cache. A failure keeps the last list but marks it stale.
    func refreshSIMs() async {
        guard user != nil else { return }
        let expected = generation
        struct List: Decodable { var items: [VoDogSIM] }
        do {
            let list = try await decode(List.self, "GET", "/sims")
            guard expected == generation else { return }
            sims = list.items
            simsError = nil
        } catch is CancellationError {
            return
        } catch {
            guard expected == generation else { return }
            simsError = VoDogErrorText.message(error)
        }
        simsLoaded = true
    }

    /// Single flight: concurrent 401s share one `POST /auth/refresh`.
    func refresh() async throws {
        if let refreshTask { return try await refreshTask.value }
        let expected = generation
        guard let refreshToken = session?.refreshToken else {
            clearLocal()
            throw VoDogAPIError(status: 401, code: "UNAUTHENTICATED", message: nil, body: Data())
        }
        let task = Task { @MainActor in
            do {
                let (data, status) = try await self.send("POST", "/auth/refresh", query: [:],
                                                         body: ["refreshToken": refreshToken], token: nil)
                guard (200..<300).contains(status) else { throw Self.apiError(status: status, data: data) }
                guard expected == self.generation, var current = self.session else { return }
                let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
                guard let token = object["token"] as? String else {
                    throw VoDogAPIError(status: status, code: "INVALID_RESPONSE", message: nil, body: data)
                }
                current.token = token
                current.refreshToken = object["refreshToken"] as? String ?? current.refreshToken
                current.expiresAt = object["expiresAt"] as? String
                self.session = current
                self.store.save(current)
            } catch let error as VoDogAPIError where error.status == 401 {
                if expected == self.generation {
                    self.diag("auth.refresh_failed", level: "warn", fields: ["status": 401, "code": error.code ?? ""])
                    self.clearLocal()
                }
                throw error
            }
        }
        refreshTask = task
        defer { if expected == generation { refreshTask = nil } }
        try await task.value
    }

    // MARK: Requests

    /// JSON request to `/api/v1<path>`. Non-2xx throws `VoDogAPIError`.
    /// `idempotent: true` adds a fresh `Idempotency-Key` header.
    func json(_ method: String, _ path: String, query: [String: String] = [:],
              body: [String: Any]? = nil, idempotent: Bool = false) async throws -> [String: Any] {
        try await json(method, path, query: query, body: body, idempotent: idempotent, timeout: 20)
    }

    private func json(_ method: String, _ path: String, query: [String: String] = [:], body: [String: Any]? = nil,
                      idempotent: Bool = false, timeout: TimeInterval) async throws -> [String: Any] {
        let data = try await perform(method, path, query: query, body: body,
                                     idempotencyKey: idempotent ? UUID().uuidString : nil, timeout: timeout)
        guard !data.isEmpty, let object = try? JSONSerialization.jsonObject(with: data) else { return [:] }
        if let dictionary = object as? [String: Any] { return dictionary }
        return ["items": object]
    }

    /// Typed convenience over `json`.
    func decode<T: Decodable>(_ type: T.Type, _ method: String = "GET", _ path: String, query: [String: String] = [:],
                              body: [String: Any]? = nil, idempotent: Bool = false) async throws -> T {
        try VoDogJSON.decode(type, from: await json(method, path, query: query, body: body, idempotent: idempotent))
    }

    /// Raw bytes (recording download / mp3 export).
    func data(_ method: String, _ path: String, query: [String: String] = [:]) async throws -> Data {
        try await perform(method, path, query: query, body: nil, idempotencyKey: nil, timeout: 120)
    }

    /// Authorized GET request with a fresh access token (for AVPlayer/AVURLAsset streaming).
    func authorizedRequest(_ path: String, query: [String: String] = [:]) async throws -> URLRequest {
        if VoDogTokenPolicy.needsRefresh(expiresAt: session?.expiresAt) { try? await refresh() }
        guard let token = session?.token else {
            throw VoDogAPIError(status: 401, code: "UNAUTHENTICATED", message: nil, body: Data())
        }
        var request = URLRequest(url: url(path, query: query), timeoutInterval: 120)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func perform(_ method: String, _ path: String, query: [String: String], body: [String: Any]?,
                         idempotencyKey: String?, timeout: TimeInterval) async throws -> Data {
        let started = Date()
        do {
            if session != nil, VoDogTokenPolicy.needsRefresh(expiresAt: session?.expiresAt),
               !path.hasPrefix("/auth/") {
                try? await refresh()
            }
            let token = session?.token
            var (data, status) = try await send(method, path, query: query, body: body, token: token,
                                                idempotencyKey: idempotencyKey, timeout: timeout)
            if VoDogTokenPolicy.shouldRefreshAndRetry(status: status, path: path, hadToken: token != nil) {
                try await refresh()
                guard let fresh = session?.token else { throw Self.apiError(status: 401, data: data) }
                (data, status) = try await send(method, path, query: query, body: body, token: fresh,
                                                idempotencyKey: idempotencyKey, timeout: timeout)
            }
            guard (200..<300).contains(status) else { throw Self.apiError(status: status, data: data) }
            return data
        } catch is CancellationError {
            // A view's `.task` went away (tab switch): not an error, never logged or shown.
            throw CancellationError()
        } catch {
            let api = error as? VoDogAPIError
            // `path` never carries the query string; ids collapse so one route coalesces (S69, 60 s).
            let template = VoDogDiagThrottle.routeTemplate(path)
            let status = api?.status ?? 0
            if let repeats = apiErrorThrottle.admit("\(method) \(template)|\(status)", now: Date()) {
                var fields: [String: Any] = ["path": template, "method": method, "code": status,
                                             "ms": Int(Date().timeIntervalSince(started) * 1_000)]
                if let serverCode = api?.code, status != 0 { fields["serverCode"] = serverCode }
                if let network = api?.network {
                    fields["errorType"] = network.type
                    fields["domain"] = network.domain
                    fields["errorCode"] = network.code
                } else if api == nil {
                    let ns = error as NSError
                    fields["domain"] = ns.domain
                    fields["errorCode"] = ns.code
                }
                if repeats > 0 { fields["repeat"] = repeats }
                diag("api.error", level: "warn", fields: fields)
            }
            throw error
        }
    }

    private func send(_ method: String, _ path: String, query: [String: String], body: [String: Any]?,
                      token: String?, idempotencyKey: String? = nil,
                      timeout: TimeInterval = 20) async throws -> (Data, Int) {
        var request = URLRequest(url: url(path, query: query), timeoutInterval: timeout)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        if let body {
            guard JSONSerialization.isValidJSONObject(body) else {
                throw VoDogAPIError(status: 0, code: "INVALID_BODY", message: nil, body: Data())
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        do {
            let (data, response) = try await urlSession.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            if VoDogDiagThrottle.isCancellation(error) || Task.isCancelled { throw CancellationError() }
            let ns = error as NSError
            throw VoDogAPIError(status: 0, code: "NETWORK", message: error.localizedDescription, body: Data(),
                                       network: (VoDogDiagThrottle.networkErrorType(error), ns.domain, ns.code))
        }
    }

    func url(_ path: String, query: [String: String]) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/v1" + (path.hasPrefix("/") ? path : "/" + path)
        if !query.isEmpty {
            // `+` must be escaped: Fastify's query parser reads a bare `+` as a space (E.164 numbers).
            var allowed = CharacterSet.urlQueryAllowed
            allowed.remove(charactersIn: "+&=")
            components.percentEncodedQuery = query.sorted { $0.key < $1.key }.map {
                "\($0.key.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")="
                    + ($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
            }.joined(separator: "&")
        }
        return components.url!
    }

    static func apiError(status: Int, data: Data) -> VoDogAPIError {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let error = object?["error"] as? [String: Any]
        return VoDogAPIError(status: status, code: error?["code"] as? String,
                                    message: error?["message"] as? String, body: data)
    }

    // MARK: Diagnostics

    /// Client diagnostic event (never pass full numbers or message bodies).
    func diag(_ event: String, level: String = "info", callId: String? = nil, fields: [String: Any] = [:]) {
        var item: [String: Any] = ["ts": GatewayJSON.iso(Date()), "level": level, "event": String(event.prefix(120)),
                                   "fields": GatewayDiagPrivacy.sanitize(fields), "appVersion": GatewayDiagLog.appVersion]
        if let callId, UUID(uuidString: callId) != nil { item["callId"] = callId }
        guard JSONSerialization.isValidJSONObject(item) else { return }
        diagQueue.append(item)
        // ponytail: in-memory only, 200 rows; events raised while logged out wait for the next login.
        if diagQueue.count > 200 { diagQueue.removeFirst(diagQueue.count - 200) }
        guard diagFlushTask == nil else { return }
        diagFlushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await self?.flushDiag()
            self?.diagFlushTask = nil
        }
    }

    /// S69 `ui.error_shown` (warn), one per (screen, message) per 60 s with `repeat`.
    func errorShown(screen: String, site: String, message: String, code: Int?, serverCode: String?) {
        guard let repeats = errorShownThrottle.admit("\(screen)|\(message)", now: Date()) else { return }
        var fields: [String: Any] = ["screen": screen, "site": site, "message": String(message.prefix(300))]
        if let code { fields["code"] = code }
        if let serverCode { fields["serverCode"] = serverCode }
        if repeats > 0 { fields["repeat"] = repeats }
        diag("ui.error_shown", level: "warn", fields: fields)
    }

    /// S69 `client.context` (iOS Diag shape): once per launch and again after each login.
    private func logContext() {
        let info = Bundle.main.infoDictionary
        let os = ProcessInfo.processInfo.operatingSystemVersion
        diag("client.context", fields: [
            "platform": "macos", "appVersion": info?["CFBundleShortVersionString"] as? String ?? "",
            "appBuild": info?["CFBundleVersion"] as? String ?? "",
            "osVersion": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            "deviceModel": Self.deviceModel, "locale": Locale.current.identifier,
            "timeZone": TimeZone.current.identifier, "installId": GatewayDiagLog.shared.installId,
        ])
    }

    /// `hw.model`, e.g. `Mac16,10`.
    static let deviceModel: String = {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return "Mac" }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &bytes, &size, nil, 0) == 0 else { return "Mac" }
        return String(cString: bytes)
    }()

    /// Uploads directly (not via `perform`) so a failed upload never records another `api.error`.
    /// Single flight; the batch leaves the queue before the POST and is put back only on a retryable failure.
    func flushDiag() async {
        guard !diagFlushing, let token = session?.token, !diagQueue.isEmpty else { return }
        diagFlushing = true
        defer { diagFlushing = false }
        let batch = Array(diagQueue.prefix(100))
        diagQueue.removeFirst(batch.count)
        var request = URLRequest(url: url("/diag/events", query: [:]), timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("macos", forHTTPHeaderField: "X-Diag-Source")
        request.setValue(GatewayDiagLog.shared.installId, forHTTPHeaderField: "X-Diag-Install")
        // S75: Control derives diag_events.clock_offset_ms from this.
        request.setValue(String(Int64(Date().timeIntervalSince1970 * 1_000)), forHTTPHeaderField: "X-Diag-Sent-At")
        request.httpBody = try? JSONSerialization.data(withJSONObject: batch)
        let status = ((try? await urlSession.data(for: request))?.1 as? HTTPURLResponse)?.statusCode ?? 0
        let delivered = (200..<300).contains(status) || ((400..<500).contains(status) && ![401, 408, 429].contains(status))
        if !delivered {
            diagQueue.insert(contentsOf: batch, at: 0)
            if diagQueue.count > 200 { diagQueue.removeFirst(diagQueue.count - 200) }
        }
    }

    var pendingDiagCount: Int { diagQueue.count }
}

/// S67 unread badges shared by the rail, section picker, records tab and SIM strips.
/// One 5 s poll (`VoDogBadgePoller`) while signed in; a failed refresh keeps the last value.
@MainActor
final class VoDogBadgeStore: ObservableObject {
    @Published private(set) var counts = VoDogBadges()
    weak var account: VoDogAccount?
    /// Calls already marked this session: no second POST, no second −1. S67c rows hide their dot for
    /// these (and for `readSMS`) right away; the next list refresh carries the server's answer.
    @Published private(set) var seenCalls: Set<String> = []
    @Published private(set) var readSMS: Set<String> = []

    private var poller: Task<Void, Never>?

    /// One 5 s `GET /badges` loop for the app's lifetime; `refresh()` is a no-op while signed out.
    func startPolling() {
        guard poller == nil else { return }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                await VoDogPollCadence.sleep()
            }
        }
    }

    func refresh() async {
        guard let account, let user = account.user?.id else { return }
        guard let fresh = try? await account.decode(VoDogBadges.self, "GET", "/badges"),
              account.user?.id == user, fresh != counts else { return }
        counts = fresh
    }

    /// Opening a call's detail: `POST /calls/:id/seen`, then −1 if the call was pending, then refresh.
    func markCallSeen(_ callID: String, simID: String?, pending: Bool) async {
        guard let account, account.user != nil, !seenCalls.contains(callID) else { return }
        seenCalls.insert(callID)  // optimistic; undone on failure so the dot returns and a later open retries
        guard (try? await account.json("POST", "/calls/\(callID)/seen")) != nil else {
            seenCalls.remove(callID)
            return
        }
        if pending { counts.decrementCall(simID: simID) }
        await refresh()
    }

    /// Opening an SMS conversation: `POST /sms/read` with its incoming ids (server skips already-read ones).
    func markSMSRead(_ ids: [String]) async {
        guard let account, account.user != nil, !ids.isEmpty else { return }
        let fresh = Set(ids).subtracting(readSMS)
        readSMS.formUnion(fresh)  // optimistic; undone on failure
        guard let result = try? await account.json("POST", "/sms/read", body: ["ids": Array(ids.suffix(500))]) else {
            readSMS.subtract(fresh)
            return
        }
        if (result["updated"] as? Int ?? 0) > 0 { await refresh() }
    }

    func reset() {
        counts = VoDogBadges()
        seenCalls = []
        readSMS = []
    }
}

enum VoDogKeychain {
    static let service = "org.vodog.macos.vodog-account"

    /// S57: remembered login, prefilled after sign-out. `clearLocal()` never deletes it.
    struct Credentials: Codable, Equatable { var username: String; var password: String }

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func load() -> VoDogStoredSession? { read(VoDogStoredSession.self, account: "session") }
    static func save(_ session: VoDogStoredSession) { write(session, account: "session") }
    static func delete() { SecItemDelete(query("session") as CFDictionary) }

    static func loadCredentials() -> Credentials? { read(Credentials.self, account: "credentials") }
    static func saveCredentials(_ credentials: Credentials) { write(credentials, account: "credentials") }

    private static func read<T: Decodable>(_ type: T.Type, account: String) -> T? {
        var item: CFTypeRef?
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func write<T: Encodable>(_ value: T, account: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        let attributes: [String: Any] = [kSecValueData as String: data,
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query(account).merging(attributes) { _, new in new } as CFDictionary, nil)
        }
    }
}

/// S69 poll cadence for every VoDog loop except the S72 `/calls` ring poll (`/sims`, `/sms`, settings, `/badges`):
/// 5 s while VoDog is the active app or a communication window is on screen, otherwise 30 s.
@MainActor
enum VoDogPollCadence {
    static var isForeground: Bool {
        guard let app = NSApp else { return true }  // self-tests run without an NSApplication
        return app.isActive || onScreen(["VoDogCommunicationWindow.v5", "VoDogMessagesWindow.v4"])
    }

    /// Open, not minimized, and not fully covered (`isVisible` alone stays true behind other windows).
    static func onScreen(_ autosaveNames: Set<String>) -> Bool {
        (NSApp?.windows ?? []).contains {
            autosaveNames.contains($0.frameAutosaveName) && $0.isVisible && !$0.isMiniaturized
                && $0.occlusionState.contains(.visible)
        }
    }

    /// One 5 s step; in the background keep stepping up to 30 s, ending early once back in the foreground.
    static func sleep() async {
        var waited = 0
        repeat {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            waited += 5
        } while !Task.isCancelled && waited < 30 && !isForeground
    }
}
