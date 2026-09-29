import SwiftUI

struct LoginView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var username = ""
    @State private var password = ""
    @State private var passwordVisible = false
    @FocusState private var passwordFocused: Bool
    @State private var passkey = PasskeyService()
    @State private var turnstile = TurnstileChallenge()

    /// Whether a remembered login exists, which is the only condition under which 忘记已保存的账号 appears.
    @State private var hasRememberedLogin: Bool

    /// S22 decision 11: the form comes back filled after 退出登录. The keychain item is read directly rather
    /// than through the environment's `SessionStore` because `init()` runs before the environment exists.
    init(remembered: LastLoginCredentials? = try? SystemLastLoginStore().load()) {
        var name = remembered?.username ?? ""
        var secret = remembered?.password ?? ""
        _hasRememberedLogin = State(initialValue: !(remembered?.username ?? "").isEmpty)
        #if DEBUG
        // The UI tests drive a specific account; their values win over whatever the device remembers.
        let environment = ProcessInfo.processInfo.environment
        if let testUsername = environment["VODOG_UI_TEST_USERNAME"], !testUsername.isEmpty { name = testUsername }
        if let testPassword = environment["VODOG_UI_TEST_PASSWORD"], !testPassword.isEmpty { secret = testPassword }
        #endif
        _username = State(initialValue: name)
        _password = State(initialValue: secret)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                CallerTheme.canvas(colorScheme: colorScheme, reduceTransparency: reduceTransparency)
                ScrollView {
                    VStack(spacing: 20) {
                        brand
                        accountCard
                        if hasRememberedLogin { forgetRememberedButton }
                        if turnstile.isRequired {
                            TurnstileChallengeCard(challenge: turnstile)
                                .accessibilityIdentifier("turnstile-challenge")
                        }
                        passkeyCard
                        if let message = passkey.errorMessage {
                            errorBanner(message).accessibilityIdentifier("passkey-error")
                        }
                        if let message = session.errorMessage,
                           !turnstile.isRequired || message != turnstile.loginFailureMessage {
                            errorBanner(message)
                        }
                        if let message = passkey.statusMessage {
                            Label(message, systemImage: "person.badge.key")
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .accessibilityIdentifier("passkey-status")
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 32)
                }
                // Dragging the form down pushes the keyboard away with it, which is the gesture people already
                // expect here — the login page is the one screen with no bar to tap.
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .task { await turnstile.load(using: session) }
        .task(id: username) {
            // A passkey options call consumes a single-use Turnstile token, so nothing is prefetched before the
            // challenge is solved.
            guard !turnstile.isRequired else { return }
            await passkey.prefetchSignIn(username: username)
        }
    }

    private var brand: some View {
        VStack(spacing: 12) {
            Image(systemName: "phone.connection.fill")
                .font(.system(size: 36))
                .foregroundStyle(Color.callerAccent)
                .frame(width: 64, height: 64)
                .background(.ultraThinMaterial, in: Circle())
            Text("VoDog")
                .font(.largeTitle.bold())
                .foregroundStyle(.primary)
            Text("安全访问分配给你的 SIM 通道")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
    }

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("账号").font(.headline)
            TextField("用户名", text: $username)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .frame(minHeight: 44)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            passwordField
            if let message = turnstile.loginFailureMessage {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.callerDanger)
                    .accessibilityIdentifier("login.failure")
                    .reportsError(message, screen: "login", site: "login_failure")
            }
            Button {
                Task { await signIn() }
            } label: {
                HStack {
                    Spacer()
                    if session.isLoading { ProgressView() }
                    else { Text("登录").fontWeight(.semibold) }
                    Spacer()
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.callerAccent)
            // `isConfigurationSettled` is the S22 addition: with the form prefilled, 登录 is reachable before
            // /auth/config answers, and submitting then means a guaranteed 400 TURNSTILE_REQUIRED.
            .disabled(
                username.isEmpty || password.isEmpty || session.isLoading
                    || !turnstile.isConfigurationSettled || !challengeSolved
            )
        }
        .padding(20)
        .callerMaterialCard(colorScheme: colorScheme, reduceTransparency: reduceTransparency)
    }

    /// The escape hatch for a shared device: erase the remembered username and password and empty the form.
    /// Only shown when there is something to forget, so the screen stays quiet for a first-time sign-in.
    private var forgetRememberedButton: some View {
        Button {
            session.forgetRememberedLogin()
            username = ""
            password = ""
            passwordVisible = false
            passwordFocused = false
            hasRememberedLogin = false
        } label: {
            Text(LoginCopy.forgetRemembered)
                .font(.footnote)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.callerDanger)
        .accessibilityIdentifier("login.forgetRemembered")
    }

    /// One password row, two controls. Swapping `SecureField` for `TextField` changes the view's identity, so
    /// both branches carry the same `.id` and the same `@FocusState`, and the toggle re-asserts focus after the
    /// swap — otherwise showing the password dismisses the keyboard mid-typing.
    private var passwordField: some View {
        HStack(spacing: 8) {
            Group {
                if passwordVisible {
                    TextField("密码", text: $password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } else {
                    SecureField("密码", text: $password)
                }
            }
            .textContentType(.password)
            .focused($passwordFocused)
            .id("login.passwordField")
            Button {
                let wasFocused = passwordFocused
                passwordVisible.toggle()
                if wasFocused { DispatchQueue.main.async { passwordFocused = true } }
            } label: {
                Image(systemName: passwordVisible ? "eye.slash" : "eye")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel(passwordVisible ? "隐藏密码" : "显示密码")
            .accessibilityIdentifier("login.passwordVisibility")
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .frame(minHeight: 44)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private var passkeyCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                if username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    passkey.errorMessage = "请先输入用户名"
                    passkey.statusMessage = nil
                    return
                }
                // S22 decision 11: a passkey is its own proof of possession. The control service no longer
                // requires Turnstile on /passkeys/authenticate/options, so nothing here waits for it.
                Task { await signInWithPasskey() }
            } label: {
                HStack {
                    if passkey.isBusy { ProgressView() }
                    Label("使用 Passkey 登录", systemImage: "person.badge.key.fill")
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(passkey.isBusy)
            Text("Passkey 使用设备的安全验证保护登录。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .callerMaterialCard(colorScheme: colorScheme, reduceTransparency: reduceTransparency)
    }

    private var challengeSolved: Bool { !turnstile.isRequired || turnstile.token != nil }

    private func signIn() async {
        do {
            let token = try turnstile.requiredToken()
            turnstile.beginLoginSubmission()
            await session.login(username: username, password: password, turnstileToken: token)
            if let failure = session.loginFailure {
                if turnstile.isRequired { turnstile.reset(afterFailedLogin: failure.message) }
                else { turnstile.reset() }
                if failure.shouldFocusPassword { passwordFocused = true }
            }
        } catch {
            session.errorMessage = error.localizedDescription
        }
    }

    private func signInWithPasskey() async {
        // Carry a solved token if one happens to exist, never demand one: `requiredToken()` would throw
        // `unsolved` here, which is exactly the block S22 decision 11 removes.
        passkey.turnstileToken = turnstile.token
        await passkey.signIn(username: username, session: session)
        if passkey.errorMessage != nil { turnstile.reset() }
    }

    private func errorBanner(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.body)
            .foregroundStyle(Color.callerDanger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .reportsError(message, screen: "login", site: "banner")
            .callerMaterialCard(colorScheme: colorScheme, reduceTransparency: reduceTransparency)
    }
}

private extension View {
    func callerMaterialCard(colorScheme: ColorScheme, reduceTransparency: Bool) -> some View {
        background {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(reduceTransparency ? Color(uiColor: .secondarySystemGroupedBackground) : Color.clear)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.06), lineWidth: 1)
        )
    }
}
