import SwiftUI
import WebKit

/// VoDog password login (spec S54). Turnstile uses the same hosted page and JS bridge as
/// the iOS app (`TurnstileChallengeView.swift`): the page posts a JSON string to `turnstile`.
struct VoDogLoginView: View {
    @ObservedObject var account: VoDogAccount
    @AppStorage("VoDogAccount.lastUsername.v1") private var username = ""
    @State private var password = ""
    /// False until `/auth/config` has been tried once; login stays disabled until then so a
    /// password login never races the Turnstile requirement.
    @State private var configLoaded = false
    @State private var siteKey: String?
    @State private var turnstileToken: String?
    @State private var turnstileError: String?
    @State private var challengeGeneration = 0
    @State private var submitting = false
    @State private var errorMessage: String?
    @State private var passwordVisible = false
    @FocusState private var passwordFocused: Bool

    private var canSubmit: Bool {
        configLoaded && !submitting && !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
            && (siteKey == nil || turnstileToken != nil)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                        .font(.system(size: 44, weight: .light))
                        .foregroundStyle(Color.accentColor)
                    Text(L10n.tr("登录 VoDog"))
                        .font(.largeTitle.bold())
                    Text(L10n.tr("登录后可在这台 Mac 上管理通讯录、屏蔽名单、通话记录与接听设置。"))
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 14) {
                    TextField(L10n.tr("用户名"), text: $username)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.username)
                        .onSubmit { passwordFocused = true }
                    HStack(spacing: 6) {
                        Group {
                            if passwordVisible {
                                TextField(L10n.tr("密码"), text: $password)
                            } else {
                                SecureField(L10n.tr("密码"), text: $password)
                            }
                        }
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.password)
                        .focused($passwordFocused)
                        .onSubmit { Task { await submit() } }
                        Button {
                            passwordVisible.toggle()
                        } label: {
                            Image(systemName: passwordVisible ? "eye.slash" : "eye").frame(width: 22)
                        }
                        .buttonStyle(.borderless)
                        .help(passwordVisible ? L10n.tr("隐藏密码") : L10n.tr("显示密码"))
                        .accessibilityLabel(passwordVisible ? L10n.tr("隐藏密码") : L10n.tr("显示密码"))
                    }

                    if let url = challengeURL {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(L10n.tr("人机验证")).font(.headline)
                            VoDogTurnstileWebView(url: url) { event in accept(event) }
                                .frame(height: 78)
                                .id(challengeGeneration)
                            if let turnstileError {
                                Text(turnstileError).font(.caption).foregroundStyle(.red)
                            } else if turnstileToken == nil {
                                Text(L10n.tr("请完成验证后继续登录。")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }

                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        Task { await submit() }
                    } label: {
                        HStack(spacing: 8) {
                            if submitting { ProgressView().controlSize(.small) }
                            Text(L10n.tr("登录"))
                        }
                        .frame(maxWidth: .infinity, minHeight: 24)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit)
                }
                .padding(22)
                .adaptiveGlassSurface(cornerRadius: 20, treatment: .regular)

                Text(L10n.tr("通行密钥登录暂不支持 Mac，请使用用户名和密码。"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 24)
            .padding(.vertical, 48)
            .frame(maxWidth: .infinity)
        }
        .scrollContentBackground(.hidden)
        .task {
            // S57: remembered login survives sign-out; Turnstile is still required.
            if password.isEmpty, let saved = VoDogKeychain.loadCredentials() {
                username = saved.username
                password = saved.password
            }
            await loadConfig()
        }
    }

    private var challengeURL: URL? {
        guard let siteKey, var components = URLComponents(url: account.baseURL.appendingPathComponent("turnstile.html"),
                                                          resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [URLQueryItem(name: "sitekey", value: siteKey), URLQueryItem(name: "lang", value: "zh-cn")]
        return components.url
    }

    private func loadConfig() async {
        guard !configLoaded else { return }
        // A failed config read must not block login: the server still decides whether a token is required.
        siteKey = try? await account.turnstileSiteKey()
        configLoaded = true
    }

    private func accept(_ event: VoDogTurnstileEvent) {
        switch event {
        case let .token(value): turnstileToken = value; turnstileError = nil
        case let .error(message): turnstileToken = nil; turnstileError = VoDogErrorText.shown(message)
        case .expired: turnstileToken = nil
        }
    }

    private func submit() async {
        guard canSubmit else { return }
        submitting = true
        errorMessage = nil
        defer { submitting = false }
        do {
            try await account.login(username: username, password: password, turnstileToken: turnstileToken)
            VoDogKeychain.saveCredentials(.init(username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                                                       password: password))
            password = ""
        } catch {
            errorMessage = VoDogErrorText.message(error)
            if (error as? VoDogAPIError)?.code == "INVALID_CREDENTIALS" { passwordFocused = true }
            // The token is single use: every failed attempt gets a fresh challenge.
            if siteKey != nil {
                turnstileToken = nil
                turnstileError = nil
                challengeGeneration += 1
            } else if (error as? VoDogAPIError)?.code == "TURNSTILE_REQUIRED" {
                configLoaded = false
                await loadConfig()
            }
        }
    }
}

enum VoDogTurnstileEvent { case token(String), error(String), expired }

struct VoDogTurnstileWebView: NSViewRepresentable {
    let url: URL
    let onEvent: (VoDogTurnstileEvent) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onEvent: onEvent) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "turnstile")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.onEvent = onEvent
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "turnstile")
        view.navigationDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var onEvent: (VoDogTurnstileEvent) -> Void
        init(onEvent: @escaping (VoDogTurnstileEvent) -> Void) { self.onEvent = onEvent }

        private struct BridgeMessage: Decodable { let type: String; let token: String?; let message: String? }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? String,
                  let payload = try? JSONDecoder().decode(BridgeMessage.self, from: Data(body.utf8)) else { return }
            switch payload.type {
            case "token":
                if let token = payload.token, !token.isEmpty { onEvent(.token(token)) }
                else { onEvent(.error(L10n.tr("人机验证失败，请重试。"))) }
            case "expired": onEvent(.expired)
            default: onEvent(.error(payload.message ?? L10n.tr("人机验证失败，请重试。")))
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onEvent(.error(L10n.tr("人机验证页面加载失败，请检查网络。")))
        }
    }
}
