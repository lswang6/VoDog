import Observation
import SwiftUI
import WebKit

/// Pre-login configuration published by the control service.
struct TurnstileSettings: Decodable, Sendable { let enabled: Bool; let siteKey: String? }
struct AuthConfigResponse: Decodable, Sendable { let turnstile: TurnstileSettings }

enum TurnstileEvent: Sendable { case token(String), error(String), expired }

/// Solves the Cloudflare Turnstile challenge for the native login screen.
///
/// Cloudflare validates the widget's hostname, so the challenge page is served from the control origin and the public
/// site key is passed in by the app. The token is single use, so `reset()` starts a fresh challenge after any failed
/// attempt. When the control service does not require Turnstile, `enabled` stays false and login is unchanged.
@MainActor @Observable
final class TurnstileChallenge {
    private(set) var enabled = false
    private(set) var siteKey: String?
    private(set) var token: String?
    private(set) var errorMessage: String?
    /// The result of the login request that consumed the preceding token.
    ///
    /// This is separate from widget errors because the replacement widget can emit its own token/error events.
    /// Those events must not erase the reason the previous login returned to a fresh challenge.
    private(set) var loginFailureMessage: String?
    private(set) var isLoading = false
    private(set) var generation = 0
    /// Whether `load(using:)` has finished at least one attempt, successful or not.
    ///
    /// S22 decision 11 / R4 A1⚠: once the login form is prefilled from the keychain, the password button is
    /// tappable the instant the screen appears. Before the config lands `isRequired` is false, so the app would
    /// post a login with no Turnstile token and the server would answer 400. Gating on this makes the race
    /// impossible without making a failed config read a permanent lockout — a failed attempt still sets it.
    private(set) var attempted = false
    private var loaded = false

    var isRequired: Bool { enabled && siteKey != nil }

    /// Safe to submit a password login: the app knows whether a Turnstile token is required.
    var isConfigurationSettled: Bool { attempted && !isLoading }

    var challengeURL: URL? {
        guard isRequired, let siteKey,
              var components = URLComponents(url: AppRuntimeConfiguration.productionAPIBaseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/turnstile.html"
        components.queryItems = [URLQueryItem(name: "sitekey", value: siteKey), URLQueryItem(name: "lang", value: "zh-cn")]
        return components.url
    }

    func load(using session: SessionStore, force: Bool = false) async {
        if loaded && !force { attempted = true; return }
        isLoading = true
        defer { isLoading = false; attempted = true }
        do {
            let response: AuthConfigResponse = try await session.anonymousRequest("auth/config")
            enabled = response.turnstile.enabled
            siteKey = response.turnstile.siteKey
            loaded = true
            if !isRequired { token = nil }
        } catch {
            // A failed config read must not block login: the server still decides whether a token is required.
        }
    }
    func accept(_ event: TurnstileEvent) {
        switch event {
        case let .token(value):
            token = value
            errorMessage = nil
        case let .error(message):
            token = nil
            errorMessage = message
        case .expired:
            token = nil
        }
    }

    /// A single-use token can never be reused, so every failed attempt starts a new challenge.
    func reset() {
        token = nil
        errorMessage = nil
        loginFailureMessage = nil
        generation += 1
    }

    /// Rotates the single-use token while keeping the rejected request visible near the login controls.
    func reset(afterFailedLogin message: String) {
        token = nil
        errorMessage = nil
        loginFailureMessage = message
        generation += 1
    }

    /// Clears the preceding result when the user deliberately starts another request. The solved token remains
    /// available for that request and is rotated only if the request fails.
    func beginLoginSubmission() {
        loginFailureMessage = nil
    }

    /// Returns the token for a request, throwing the user-facing message when the challenge is still unsolved.
    func requiredToken() throws -> String? {
        guard isRequired else { return nil }
        guard let token else { throw TurnstileChallengeError.unsolved }
        return token
    }
}

enum TurnstileChallengeError: LocalizedError {
    case unsolved
    var errorDescription: String? { "请先完成人机验证" }
}

struct TurnstileChallengeCard: View {
    let challenge: TurnstileChallenge
    /// The widget is a fixed-size web view; scaling its container with the text size keeps it from being clipped
    /// at large Dynamic Type settings.
    @ScaledMetric(relativeTo: .body) private var challengeHeight: CGFloat = 78

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("人机验证").font(.headline)
            if let url = challenge.challengeURL {
                TurnstileWebView(url: url, onEvent: { event in challenge.accept(event) })
                    .frame(height: challengeHeight)
                    .id(challenge.generation)
                if let message = challenge.errorMessage {
                    Text(message).font(.footnote).foregroundStyle(Color.callerDanger)
                        .reportsError(message, screen: "login", site: "turnstile")
                } else if challenge.token == nil {
                    Text("请完成验证后继续登录。").font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                Text(challenge.errorMessage ?? "人机验证配置不可用，请稍后重试。")
                    .font(.footnote).foregroundStyle(Color.callerDanger)
                    .reportsError(challenge.errorMessage ?? "人机验证配置不可用，请稍后重试。", screen: "login", site: "turnstile_config")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .callerLoginCard()
        // The web view has no accessible identity of its own, so the card names the task and keeps its children
        // individually reachable rather than collapsing them into one unlabelled element.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("人机验证")
    }
}

private struct BridgeMessage: Decodable {
    let type: String
    let token: String?
    let message: String?
}

/// Hosts the Turnstile page and forwards its bridge messages to `onEvent`.
struct TurnstileWebView: UIViewRepresentable {
    let url: URL
    let onEvent: (TurnstileEvent) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onEvent: onEvent) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "turnstile")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "turnstile")
        view.navigationDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        private let onEvent: (TurnstileEvent) -> Void
        init(onEvent: @escaping (TurnstileEvent) -> Void) { self.onEvent = onEvent }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? String, let data = body.data(using: .utf8),
                  let payload = try? JSONDecoder().decode(BridgeMessage.self, from: data) else { return }
            switch payload.type {
            case "token": if let token = payload.token, !token.isEmpty { onEvent(.token(token)) } else { onEvent(.error("人机验证失败，请重试。")) }
            case "expired": onEvent(.expired)
            default: onEvent(.error(payload.message ?? "人机验证失败，请重试。"))
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onEvent(.error("人机验证页面加载失败，请检查网络。"))
        }
    }
}

extension View {
    func callerLoginCard() -> some View {
        background {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Signal.surface)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
        )
    }
}
