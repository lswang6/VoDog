import AuthenticationServices
import Foundation
import Observation
import UIKit

@MainActor @Observable
final class PasskeyService: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    /// The control service owns RP_ID (as it already does for Android), so the app follows the server value instead
    /// of a hardcoded constant that could silently drift. iOS still enforces the real app ↔ relying-party binding
    /// through the `webcredentials:` associated domain, so only a malformed value is refused here.
    private static func isExpectedRelyingParty(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 253 && !value.contains("/") && !value.contains(":") && value.contains(".")
    }
    nonisolated private static let challengeLifetime: TimeInterval = 4 * 60
    var errorMessage: String?
    var statusMessage: String?
    static let registeredMessage = "Passkey 已注册"
    private(set) var isBusy = false
    /// Turnstile token for the next passkey sign-in attempt; the options call consumes it exactly once.
    var turnstileToken: String?
    private var continuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialAssertion, Error>?
    private var registrationContinuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialRegistration, Error>?
    private var authorizationController: ASAuthorizationController?
    private var authorizationTimeout: Task<Void, Never>?
    private var resolvedWindow: UIWindow?
    private var prefetched: PrefetchedAssertion?

    func prefetchSignIn(username: String) async {
        let trimmed = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            prefetched = nil
            return
        }
        if let prefetched, prefetched.username == trimmed, prefetched.isFresh { return }
        do {
            prefetched = try await fetchAssertion(username: trimmed, turnstileToken: turnstileToken)
        } catch {
            if prefetched?.username != trimmed { prefetched = nil }
        }
    }

    func register(session: SessionStore) async {
        guard let identity = session.sessionIdentity else { return }
        errorMessage = nil
        statusMessage = nil
        isBusy = true
        defer { if session.isCurrentSession(identity) { isBusy = false } }
        do {
            let result: RegistrationOptions = try await session.request(
                "passkeys/register/options", method: "POST", requiredSessionIdentity: identity
            )
            // The relying party comes from the server (as it does on Android) so a server RP_ID change can never
            // silently break iOS; the expected host is still checked as defence in depth.
            let rpID = result.options.rp.id
            guard let challenge = Data(base64URLEncoded: result.options.challenge),
                  let userID = Data(base64URLEncoded: result.options.user.id),
                  Self.isExpectedRelyingParty(rpID),
                  result.options.authenticatorSelection.userVerification == "required" else { throw APIError.invalidResponse }
            let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
                .createCredentialRegistrationRequest(challenge: challenge, name: result.options.user.name, userID: userID)
            request.userVerificationPreference = .required
            if #available(iOS 17.4, *) {
                request.excludedCredentials = try descriptors(result.options.excludeCredentials)
            }
            try requirePresentationWindow()
            guard session.isCurrentSession(identity) else { throw SessionLifecycleError.staleSession }
            statusMessage = "Passkey 选项已验证，正在请求系统授权"
            let credential = try await performRegistration(request)
            guard session.isCurrentSession(identity) else { throw SessionLifecycleError.staleSession }
            let encodedID = credential.credentialID.base64URLEncodedString()
            // S18 decision 7: the server stores the attachment and the transports so the list can name the device.
            // iOS platform credentials are always `platform`, and iCloud Keychain offers them on nearby devices too.
            let payload = RegistrationPayload(
                id: encodedID, rawId: encodedID, type: "public-key", authenticatorAttachment: "platform",
                response: .init(
                    attestationObject: credential.rawAttestationObject?.base64URLEncodedString() ?? "",
                    clientDataJSON: credential.rawClientDataJSON.base64URLEncodedString(),
                    transports: ["internal", "hybrid"]))
            let _: Verified = try await session.request(
                "passkeys/register/verify", method: "POST",
                body: RegistrationVerifyBody(challengeId: result.challengeId, response: payload),
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            statusMessage = Self.registeredMessage
            // A confirmation clears itself after 5 s (same as Android / Web); an error or a newer status stays.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(5))
                if self?.statusMessage == Self.registeredMessage { self?.statusMessage = nil }
            }
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            record(error, operation: .register)
        }
    }

    func signIn(username: String, session: SessionStore) async {
        errorMessage = nil
        statusMessage = nil
        let trimmed = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            record(PasskeyClientError.missingUsername, operation: .signIn)
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let assertion: PrefetchedAssertion
            if let prefetched, prefetched.username == trimmed, prefetched.isFresh {
                assertion = prefetched
            } else {
                assertion = try await fetchAssertion(username: trimmed, turnstileToken: turnstileToken)
                prefetched = assertion
            }
            try requirePresentationWindow()
            statusMessage = "Passkey 选项已验证，正在请求系统授权"
            let credential = try await performAssertion(assertion.request)
            let encodedID = credential.credentialID.base64URLEncodedString()
            let payload = AssertionPayload(id: encodedID, rawId: encodedID, type: "public-key",
                response: .init(authenticatorData: credential.rawAuthenticatorData.base64URLEncodedString(),
                    clientDataJSON: credential.rawClientDataJSON.base64URLEncodedString(),
                    signature: credential.signature.base64URLEncodedString(), userHandle: credential.userID.base64URLEncodedString()))
            let result: LoginResponse = try await APIClient(token: nil).request(
                "passkeys/authenticate/verify", method: "POST",
                body: VerifyBody(challengeId: assertion.challengeId, response: payload, platform: "ios")
            )
            try session.acceptLogin(result)
            // S22 decision 11: a passkey sign-in identifies the account but never handles a password, so it
            // refreshes the remembered username only.
            session.rememberPasskeyUsername(trimmed)
            prefetched = nil
        } catch {
            record(error, operation: .signIn)
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        authorizationTimeout?.cancel()
        authorizationTimeout = nil
        authorizationController = nil
        if let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            registrationContinuation?.resume(returning: registration)
            registrationContinuation = nil
            return
        }
        guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            if continuation != nil {
                continuation?.resume(throwing: APIError.invalidResponse)
                continuation = nil
            }
            return
        }
        continuation?.resume(returning: assertion)
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        authorizationTimeout?.cancel()
        authorizationTimeout = nil
        authorizationController = nil
        if registrationContinuation != nil {
            registrationContinuation?.resume(throwing: error)
            registrationContinuation = nil
            return
        }
        guard continuation != nil else { return }
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        if let resolvedWindow { return resolvedWindow }
        if let window = PasskeyPresentationAnchor.keyWindow() { return window }
        preconditionFailure("Passkey presentation window missing")
    }

    private func fetchAssertion(username: String, turnstileToken: String?) async throws -> PrefetchedAssertion {
        let options: AuthenticationOptions = try await APIClient(token: nil).request(
            "passkeys/authenticate/options", method: "POST",
            body: UsernameBody(username: username, turnstileToken: turnstileToken)
        )
        let rpID = options.options.rpId
        guard let challenge = Data(base64URLEncoded: options.options.challenge),
              Self.isExpectedRelyingParty(rpID),
              options.options.userVerification == "required",
              !options.options.allowCredentials.isEmpty else { throw APIError.invalidResponse }
        let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
            .createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        request.allowedCredentials = try descriptors(options.options.allowCredentials)
        return PrefetchedAssertion(username: username, challengeId: options.challengeId, request: request, fetchedAt: Date())
    }

    private func performAssertion(
        _ request: ASAuthorizationPlatformPublicKeyCredentialAssertionRequest
    ) async throws -> ASAuthorizationPlatformPublicKeyCredentialAssertion {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            self.authorizationController = controller
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
            startAuthorizationTimeout { [weak self] in
                guard let self, self.continuation != nil else { return }
                self.continuation?.resume(throwing: PasskeyClientError.timedOut)
                self.continuation = nil
                self.authorizationController = nil
            }
        }
    }

    private func performRegistration(
        _ request: ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest
    ) async throws -> ASAuthorizationPlatformPublicKeyCredentialRegistration {
        try await withCheckedThrowingContinuation { continuation in
            self.registrationContinuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            self.authorizationController = controller
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
            startAuthorizationTimeout { [weak self] in
                guard let self, self.registrationContinuation != nil else { return }
                self.registrationContinuation?.resume(throwing: PasskeyClientError.timedOut)
                self.registrationContinuation = nil
                self.authorizationController = nil
            }
        }
    }

    private func startAuthorizationTimeout(resume: @escaping @MainActor () -> Void) {
        authorizationTimeout?.cancel()
        authorizationTimeout = Task { @MainActor in
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled else { return }
            resume()
        }
    }

    private func requirePresentationWindow() throws {
        guard let window = PasskeyPresentationAnchor.keyWindow() else {
            throw PasskeyClientError.missingPresentationWindow
        }
        resolvedWindow = window
    }

    private struct PrefetchedAssertion {
        let username: String
        let challengeId: String
        let request: ASAuthorizationPlatformPublicKeyCredentialAssertionRequest
        let fetchedAt: Date
        var isFresh: Bool { Date().timeIntervalSince(fetchedAt) < PasskeyService.challengeLifetime }
    }

    private struct UsernameBody: Encodable, Sendable {
        let username: String
        let turnstileToken: String?
    }
    private struct AuthenticationOptions: Decodable, Sendable { let challengeId: String; let options: PublicKey }
    private struct PublicKey: Decodable, Sendable { let challenge, rpId, userVerification: String; let allowCredentials: [CredentialDescriptor] }
    private struct RegistrationOptions: Decodable, Sendable { let challengeId: String; let options: RegistrationPublicKey }
    private struct RegistrationPublicKey: Decodable, Sendable {
        let challenge: String
        let rp: RelyingParty
        let user: RegistrationUser
        let authenticatorSelection: AuthenticatorSelection
        let excludeCredentials: [CredentialDescriptor]
    }
    private struct RelyingParty: Decodable, Sendable { let id: String }
    private struct AuthenticatorSelection: Decodable, Sendable { let userVerification: String }
    private struct RegistrationUser: Decodable, Sendable { let id, name: String }
    private struct CredentialDescriptor: Decodable, Sendable { let id: String; let type: String; let transports: [String]? }
    private struct RegistrationVerifyBody: Encodable, Sendable { let challengeId: String; let response: RegistrationPayload }
    private struct RegistrationPayload: Encodable, Sendable {
        let id, rawId, type, authenticatorAttachment: String; let response: RegistrationResponse
        struct RegistrationResponse: Encodable, Sendable {
            let attestationObject, clientDataJSON: String
            let transports: [String]
        }
    }
    private struct Verified: Decodable, Sendable { let verified: Bool }
    private struct VerifyBody: Encodable, Sendable { let challengeId: String; let response: AssertionPayload; let platform: String }
    private struct AssertionPayload: Encodable, Sendable {
        let id, rawId, type: String; let response: AssertionResponse
        struct AssertionResponse: Encodable, Sendable { let authenticatorData, clientDataJSON, signature, userHandle: String }
    }

    private func descriptors(_ values: [CredentialDescriptor]) throws -> [ASAuthorizationPlatformPublicKeyCredentialDescriptor] {
        try values.map { value in
            guard value.type == "public-key", let credentialID = Data(base64URLEncoded: value.id), !credentialID.isEmpty else {
                throw APIError.invalidResponse
            }
            return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credentialID)
        }
    }

    private func record(_ error: Error, operation: PasskeyErrorMapping.Operation) {
        statusMessage = nil
        let mapped = PasskeyErrorMapping.message(for: error, operation: operation)
        errorMessage = mapped.error
        if let status = mapped.status { statusMessage = status }
    }
}

enum PasskeyPresentationAnchor {
    @MainActor
    static func keyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        return scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first
    }
}

enum PasskeyErrorMapping {
    enum Operation { case signIn, register }

    static func message(for error: Error, operation: Operation) -> (error: String?, status: String?) {
        if let client = error as? PasskeyClientError {
            return (client.errorDescription, nil)
        }
        let value = error as NSError
        if value.domain == ASAuthorizationError.errorDomain || value.domain == "com.apple.AuthenticationServices.AuthorizationError" {
            switch value.code {
            case 1001: return ("已取消 Passkey", nil)
            case 1003, 1005: return ("无法显示系统 Passkey 界面", nil)
            case 1006:
                if operation == .register {
                    return (nil, "本机已注册此 Passkey，无需重复创建")
                }
                return ("此账号没有可用的 Passkey", nil)
            case 1004: return ("此账号没有可用的 Passkey", nil)
            default: break
            }
        }
        if let apiError = error as? APIError, case .server(404, _, _) = apiError, operation == .signIn {
            return ("此账号没有可用的 Passkey", nil)
        }
        #if DEBUG
        return ("\(error.localizedDescription) [\(value.domain):\(value.code)]", nil)
        #else
        return (error.localizedDescription, nil)
        #endif
    }
}

enum PasskeyClientError: LocalizedError {
    case missingPresentationWindow
    case missingUsername
    case timedOut
    var errorDescription: String? {
        switch self {
        case .missingPresentationWindow, .timedOut: "无法显示系统 Passkey 界面"
        case .missingUsername: "请先输入用户名"
        }
    }
}

private extension Data {
    init?(base64URLEncoded string: String) {
        var value = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        self.init(base64Encoded: value)
    }
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
