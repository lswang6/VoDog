import Foundation
import Observation
import Security
import UIKit

@MainActor
final class SessionTaskSlot<Value: Sendable> {
    private(set) var task: Task<Value, Error>?
    private(set) var id: UUID?

    @discardableResult
    func install(_ task: Task<Value, Error>) -> UUID {
        let id = UUID()
        self.task = task
        self.id = id
        return id
    }

    func clear(ifCurrent completedID: UUID) {
        guard id == completedID else { return }
        task = nil
        id = nil
    }

    func cancelAndClear() {
        task?.cancel()
        task = nil
        id = nil
    }
}

@MainActor @Observable
final class SessionStore {
    private(set) var user: User?
    private(set) var token: String?
    var errorMessage: String?
    private(set) var loginFailure: LoginFailureState?
    var isLoading = false
    private let networkSession: URLSession
    private let credentialStore: any CredentialStoring
    private let lastLoginStore: any LastLoginStoring
    private let mediaProbeManager: any MediaProbeLifecycleManaging
    private let refreshSlot = SessionTaskSlot<RefreshResponse>()
    private(set) var sessionIdentity: UUID?
    var isAuthenticated: Bool { token != nil && user != nil }

    init(
        networkSession: URLSession = .shared,
        credentialStore: any CredentialStoring = SystemCredentialStore(),
        mediaProbeManager: any MediaProbeLifecycleManaging = MediaProbeManager.shared,
        lastLoginStore: any LastLoginStoring = SystemLastLoginStore()
    ) {
        self.networkSession = networkSession
        self.credentialStore = credentialStore
        self.mediaProbeManager = mediaProbeManager
        self.lastLoginStore = lastLoginStore
    }

    func login(username: String, password: String, turnstileToken: String? = nil) async {
        isLoading = true; errorMessage = nil; loginFailure = nil
        defer { isLoading = false }
        do {
            let body = LoginBody(username: username, password: password, platform: "ios", deviceName: UIDevice.current.name,
                turnstileToken: turnstileToken)
            let response: LoginResponse = try await APIClient(token: nil).request("auth/login", method: "POST", body: body)
            try acceptLogin(response)
            // S22 decision 11. Deliberately after `acceptLogin` succeeds and deliberately not inside it: the
            // passkey path calls `acceptLogin` too and has no password to remember.
            rememberPasswordLogin(username: username, password: password)
        } catch {
            let failure = LoginFailureState.resolve(error)
            loginFailure = failure
            errorMessage = failure.message
        }
    }

    /// S22 decision 11: the last successful password login, so the form comes back filled after 退出登录.
    ///
    /// This is a separate keychain item from the session token on purpose — `logout()` erases the token item and
    /// must not touch this one — and it is `WhenUnlockedThisDeviceOnly` and non-synchronising because it holds a
    /// plaintext password that must never reach the iCloud keychain.
    func rememberPasswordLogin(username: String, password: String) {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !password.isEmpty else { return }
        try? lastLoginStore.save(LastLoginCredentials(username: name, password: password))
    }

    /// A passkey sign-in proves the account but never sees a password, so it updates only the username and
    /// leaves whatever password was remembered alone.
    func rememberPasskeyUsername(_ username: String) {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let existing = try? lastLoginStore.load()
        try? lastLoginStore.save(LastLoginCredentials(username: name, password: existing?.password))
    }

    func lastLogin() -> LastLoginCredentials? { try? lastLoginStore.load() }

    /// "忘记已保存的账号" — the only thing that erases the remembered login. Deliberately an explicit user
    /// action and never part of `logout()`, which is the whole point of keeping this in its own keychain item.
    /// Mirrors the Android client so the two apps offer the same escape hatch on a shared device.
    func forgetRememberedLogin() {
        try? lastLoginStore.delete()
    }

    /// Reads a public pre-login resource (for example the Turnstile configuration) without a session.
    func anonymousRequest<Response: Decodable & Sendable>(_ path: String) async throws -> Response {
        try await APIClient(token: nil, session: networkSession).request(path)
    }

    func restore() async {
        guard token == nil, let saved = try? credentialStore.load() else { return }
        token = saved.token; user = saved.user; sessionIdentity = UUID()
        do {
            let response: MeResponse = try await request("auth/me")
            user = response.user
            try persistCurrent(refreshToken: (try? credentialStore.load())?.refreshToken, expiresAt: (try? credentialStore.load())?.expiresAt)
            PushRegistrationManager.shared.attach(session: self)
        } catch APIError.unauthorized { clearLocalSession() }
        catch { errorMessage = "暂时无法验证服务器，已保留登录凭据。" }
    }

    func logout() async {
        let identity = sessionIdentity
        endMediaProbeSession()
        if let identity {
            await IncomingCallManager.shared.prepareForLogout(session: self, sessionIdentity: identity)
            guard isCurrentSession(identity) else { return }
        }
        await PushRegistrationManager.shared.unregister(session: self)
        guard sessionIdentity == identity else { return }
        if token != nil {
            let _: EmptyResponse? = try? await request(
                "auth/logout", method: "POST", timeoutInterval: 5, requiredSessionIdentity: identity
            )
        }
        guard sessionIdentity == identity else { return }
        CallMediaSession.shared.stop()
        RecordingPlaybackController.shared.stop()
        IncomingCallManager.shared.sessionDidLogout()
        clearLocalSession(cancelMediaProbe: false)
    }

    func acceptLogin(_ response: LoginResponse) throws {
        endMediaProbeSession()
        refreshSlot.cancelAndClear()
        CallMediaSession.shared.stop()
        RecordingPlaybackController.shared.stop()
        IncomingCallManager.shared.sessionDidLogout()
        ReliableCallEndQueue.shared.cancelAll()
        try credentialStore.save(StoredCredentials(token: response.token, refreshToken: response.refreshToken, expiresAt: response.expiresAt, user: response.user))
        token = response.token; user = response.user; sessionIdentity = UUID()
        PushRegistrationManager.shared.attach(session: self)
    }

    func request<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ path: String, method: String = "GET", body: Body? = Optional<String>.none, idempotencyKey: String? = nil,
        timeoutInterval: TimeInterval? = nil, requiredSessionIdentity: UUID? = nil,
        queryItems: [URLQueryItem] = [], headers: [String: String] = [:]
    ) async throws -> Response {
        let startedAt = ContinuousClock.now
        do {
            return try await send(
                path, method: method, body: body, idempotencyKey: idempotencyKey,
                timeoutInterval: timeoutInterval, requiredSessionIdentity: requiredSessionIdentity,
                queryItems: queryItems, headers: headers
            )
        } catch {
            // S36 C3: one place records every API failure, including the ones a caller swallows on purpose.
            // Only the final outcome is recorded — the 401 that the refresh below fixes is not a failure.
            Diag.shared.logAPIFailure(path: path, error: error, ms: Diag.ms(since: startedAt))
            throw error
        }
    }

    private func send<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ path: String, method: String, body: Body?, idempotencyKey: String?,
        timeoutInterval: TimeInterval?, requiredSessionIdentity: UUID?,
        queryItems: [URLQueryItem], headers: [String: String]
    ) async throws -> Response {
        try requireCurrentSession(requiredSessionIdentity)
        do {
            let response: Response = try await APIClient(token: token, session: networkSession).request(
                path, method: method, body: body, idempotencyKey: idempotencyKey,
                timeoutInterval: timeoutInterval, queryItems: queryItems, headers: headers
            )
            try requireCurrentSession(requiredSessionIdentity)
            return response
        } catch APIError.unauthorized {
            try requireCurrentSession(requiredSessionIdentity)
            try await refreshAccessToken()
            try requireCurrentSession(requiredSessionIdentity)
            let response: Response = try await APIClient(token: token, session: networkSession).request(
                path, method: method, body: body, idempotencyKey: idempotencyKey,
                timeoutInterval: timeoutInterval, queryItems: queryItems, headers: headers
            )
            try requireCurrentSession(requiredSessionIdentity)
            return response
        }
    }

    func isCurrentSession(_ identity: UUID) -> Bool { sessionIdentity == identity && isAuthenticated }

    private func requireCurrentSession(_ required: UUID?) throws {
        if let required, !isCurrentSession(required) { throw SessionLifecycleError.staleSession }
    }

    func recordingPreflight(_ path: String, source: RecordingSource, requiredSessionIdentity: UUID) async throws -> RecordingPreflightResponse {
        try requireCurrentSession(requiredSessionIdentity)
        do {
            let result = try await APIClient(token: token, session: networkSession).recordingPreflight(path, source: source)
            try requireCurrentSession(requiredSessionIdentity)
            return result
        } catch APIError.unauthorized {
            try requireCurrentSession(requiredSessionIdentity)
            try await refreshAccessToken(); try requireCurrentSession(requiredSessionIdentity)
            let result = try await APIClient(token: token, session: networkSession).recordingPreflight(path, source: source)
            try requireCurrentSession(requiredSessionIdentity)
            return result
        }
    }

    func download(_ path: String, source: RecordingSource = .mediaNode,
                  requiredSessionIdentity: UUID? = nil, disposition: String? = nil,
                  format: String? = nil) async throws -> DownloadedFile {
        try requireCurrentSession(requiredSessionIdentity)
        do {
            let result = try await APIClient(token: token, session: networkSession)
                .download(path, source: source, disposition: disposition, format: format)
            return try validateDownloadedFile(result, requiredSessionIdentity: requiredSessionIdentity)
        } catch APIError.unauthorized {
            try requireCurrentSession(requiredSessionIdentity)
            try await refreshAccessToken()
            try requireCurrentSession(requiredSessionIdentity)
            let result = try await APIClient(token: token, session: networkSession)
                .download(path, source: source, disposition: disposition, format: format)
            return try validateDownloadedFile(result, requiredSessionIdentity: requiredSessionIdentity)
        }
    }

    /// The download finishes in a system temporary location before it becomes playable. Re-check
    /// the login generation at that handoff and erase bytes that belong to a replaced session.
    internal func validateDownloadedFile(
        _ result: DownloadedFile, requiredSessionIdentity: UUID?
    ) throws -> DownloadedFile {
        do { try requireCurrentSession(requiredSessionIdentity); return result }
        catch { try? FileManager.default.removeItem(at: result.url); throw error }
    }

    private func refreshAccessToken() async throws {
        let identity = sessionIdentity
        if let refreshTask = refreshSlot.task {
            let response = try await refreshTask.value
            guard identity == sessionIdentity else { throw SessionLifecycleError.staleSession }
            token = response.token
            try persistCurrent(refreshToken: response.refreshToken, expiresAt: response.expiresAt)
            return
        }
        guard let credentials = try credentialStore.load(), let refreshToken = credentials.refreshToken else {
            clearLocalSession(); throw APIError.unauthorized
        }
        let client = APIClient(token: nil, session: networkSession)
        let task = Task<RefreshResponse, Error> {
            try await client.request("auth/refresh", method: "POST", body: RefreshBody(refreshToken: refreshToken))
        }
        let taskID = refreshSlot.install(task)
        defer { refreshSlot.clear(ifCurrent: taskID) }
        do {
            let response = try await task.value
            guard identity == sessionIdentity else { throw SessionLifecycleError.staleSession }
            token = response.token
            try persistCurrent(refreshToken: response.refreshToken, expiresAt: response.expiresAt)
        } catch APIError.unauthorized {
            guard identity == sessionIdentity else { throw SessionLifecycleError.staleSession }
            clearLocalSession(); throw APIError.unauthorized
        }
    }

    private func persistCurrent(refreshToken: String?, expiresAt: String?) throws {
        guard let token, let user else { throw APIError.unauthorized }
        try credentialStore.save(StoredCredentials(token: token, refreshToken: refreshToken, expiresAt: expiresAt, user: user))
    }

    private func clearLocalSession(cancelMediaProbe: Bool = true) {
        // Invalidate the generation before callbacks can schedule work. A callback from
        // the old CallKit provider must never acquire the next login's credentials.
        sessionIdentity = nil
        if cancelMediaProbe { endMediaProbeSession() }
        RecordingPlaybackController.shared.stop()
        IncomingCallManager.shared.sessionDidLogout()
        ReliableCallEndQueue.shared.cancelAll()
        refreshSlot.cancelAndClear()
        try? credentialStore.delete(); token = nil; user = nil
    }

    private func endMediaProbeSession() {
        mediaProbeManager.cancelInFlight()
        mediaProbeManager.invalidateEvidence()
    }

    private struct LoginBody: Encodable, Sendable {
        let username, password, platform, deviceName: String
        let turnstileToken: String?
    }
    private struct RefreshBody: Encodable, Sendable { let refreshToken: String }
    private struct RefreshResponse: Decodable, Sendable { let token, refreshToken, expiresAt: String }
}

enum SessionLifecycleError: LocalizedError, Equatable {
    case staleSession
    var errorDescription: String? { "登录会话已更改" }
}

struct StoredCredentials: Codable, Sendable {
    let token: String
    let refreshToken: String?
    let expiresAt: String?
    let user: User
}

protocol CredentialStoring: Sendable {
    func save(_ value: StoredCredentials) throws
    func load() throws -> StoredCredentials?
    func delete() throws
}

struct SystemCredentialStore: CredentialStoring {
    func save(_ value: StoredCredentials) throws { try Keychain.save(value) }
    func load() throws -> StoredCredentials? { try Keychain.load() }
    func delete() throws { try Keychain.delete() }
}

/// S22 decision 11. The username (and, for a password login, the password) of the last successful sign-in.
/// Stored outside `StoredCredentials` so that erasing the session never erases the form.
struct LastLoginCredentials: Codable, Sendable, Equatable {
    let username: String
    let password: String?
}

/// Login-screen wording shared with the Android client so the two apps read identically.
enum LoginCopy {
    static let forgetRemembered = "忘记已保存的账号"
    static let invalidCredentials = "账号或密码不正确"
}

/// A password-login rejection retains enough meaning for the UI to guide the next attempt without treating a
/// server verification or network failure as a bad password. `APIClient` maps a 401 to `.unauthorized`; on the
/// public password-login endpoint that status has the single `INVALID_CREDENTIALS` meaning.
struct LoginFailureState: Equatable, Sendable {
    let message: String
    let shouldFocusPassword: Bool

    static func resolve(_ error: Error) -> LoginFailureState {
        switch error {
        case APIError.unauthorized:
            LoginFailureState(message: LoginCopy.invalidCredentials, shouldFocusPassword: true)
        case let APIError.server(_, _, code) where code == "INVALID_CREDENTIALS":
            LoginFailureState(message: LoginCopy.invalidCredentials, shouldFocusPassword: true)
        case let APIError.server(_, message, code)
            where code == "TURNSTILE_REQUIRED" || code == "TURNSTILE_FAILED":
            LoginFailureState(
                message: message.isEmpty ? "人机验证未通过，请重新验证后重试。" : message,
                shouldFocusPassword: false
            )
        default:
            LoginFailureState(message: error.localizedDescription, shouldFocusPassword: false)
        }
    }
}

protocol LastLoginStoring: Sendable {
    func save(_ value: LastLoginCredentials) throws
    func load() throws -> LastLoginCredentials?
    func delete() throws
}

struct SystemLastLoginStore: LastLoginStoring {
    func save(_ value: LastLoginCredentials) throws { try LastLoginKeychain.save(value) }
    func load() throws -> LastLoginCredentials? { try LastLoginKeychain.load() }
    func delete() throws { try LastLoginKeychain.delete() }
}

enum LastLoginKeychain {
    static let service = Keychain.service
    /// A second account under the same service. `Keychain.delete()` matches on account, so 退出登录 leaves it.
    static let account = "last-login-credentials"
    /// Stricter than the session token's `AfterFirstUnlockThisDeviceOnly`: the token is needed by background
    /// push work before the first unlock, a plaintext password is only ever needed with the user looking at it.
    static var accessibility: CFString { kSecAttrAccessibleWhenUnlockedThisDeviceOnly }

    static func save(_ value: LastLoginCredentials) throws {
        try? delete()
        let encoded = try JSONEncoder().encode(value)
        let status = SecItemAdd([
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
            kSecValueData: encoded, kSecAttrAccessible: accessibility,
        ] as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    static func load() throws -> LastLoginCredentials? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
            kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
        ] as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return try JSONDecoder().decode(LastLoginCredentials.self, from: data)
    }

    /// Never called by `logout()`; it exists so a future "忘记我" affordance has one place to do it.
    static func delete() throws {
        let status = SecItemDelete([
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}

enum Keychain {
    static var service: String { AppRuntimeConfiguration.keychainService }
    private static let account = "access-token"
    static func save(_ value: StoredCredentials) throws {
        try? delete()
        let encoded = try JSONEncoder().encode(value)
        let status = SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrService: service,
            kSecAttrAccount: account, kSecValueData: encoded, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
    static func load() throws -> StoredCredentials? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: service,
            kSecAttrAccount: account, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return try JSONDecoder().decode(StoredCredentials.self, from: data)
    }
    static func delete() throws {
        let status = SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}
