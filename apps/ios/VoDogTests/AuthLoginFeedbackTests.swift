import XCTest
@testable import VoDog

final class AuthLoginFeedbackTests: XCTestCase {
    @MainActor
    func testRejectedLoginRotatesSingleUseTokenAndKeepsReasonAcrossFreshChallenge() {
        let challenge = TurnstileChallenge()
        challenge.accept(.token("consumed-token"))

        challenge.reset(afterFailedLogin: LoginCopy.invalidCredentials)

        XCTAssertNil(challenge.token)
        XCTAssertNil(challenge.errorMessage)
        XCTAssertEqual(challenge.generation, 1)
        XCTAssertEqual(challenge.loginFailureMessage, "账号或密码不正确")

        challenge.accept(.token("next-token"))
        XCTAssertEqual(challenge.token, "next-token")
        XCTAssertEqual(
            challenge.loginFailureMessage, "账号或密码不正确",
            "The replacement widget must not erase the result of the request that caused it"
        )
        challenge.accept(.expired)
        XCTAssertEqual(challenge.loginFailureMessage, "账号或密码不正确")
        challenge.accept(.error("组件重试失败"))
        XCTAssertEqual(challenge.loginFailureMessage, "账号或密码不正确")
    }

    @MainActor
    func testNewSubmissionClearsOldReasonWithoutDiscardingSolvedToken() {
        let challenge = TurnstileChallenge()
        challenge.accept(.token("next-token"))
        challenge.reset(afterFailedLogin: "服务器暂时不可用")
        challenge.accept(.token("retry-token"))

        challenge.beginLoginSubmission()

        XCTAssertNil(challenge.loginFailureMessage)
        XCTAssertEqual(challenge.token, "retry-token")
        XCTAssertEqual(challenge.generation, 1)
    }

    @MainActor
    func testOrdinaryResetClearsPriorLoginAndWidgetErrors() {
        let challenge = TurnstileChallenge()
        challenge.reset(afterFailedLogin: "账号或密码不正确")
        challenge.accept(.error("组件加载失败"))

        challenge.reset()

        XCTAssertNil(challenge.token)
        XCTAssertNil(challenge.errorMessage)
        XCTAssertNil(challenge.loginFailureMessage)
        XCTAssertEqual(challenge.generation, 2)
    }

    func testOnlyKnownCredentialRejectionRequestsPasswordFocus() {
        XCTAssertEqual(
            LoginFailureState.resolve(APIError.unauthorized),
            LoginFailureState(message: "账号或密码不正确", shouldFocusPassword: true)
        )
        XCTAssertEqual(
            LoginFailureState.resolve(APIError.server(401, "ignored", "INVALID_CREDENTIALS")),
            LoginFailureState(message: "账号或密码不正确", shouldFocusPassword: true)
        )
    }

    func testTurnstileAndNetworkFailuresKeepTheirOwnMeaningWithoutPasswordFocus() {
        XCTAssertEqual(
            LoginFailureState.resolve(APIError.server(403, "人机验证未通过，请刷新后重试", "TURNSTILE_FAILED")),
            LoginFailureState(message: "人机验证未通过，请刷新后重试", shouldFocusPassword: false)
        )
        XCTAssertEqual(
            LoginFailureState.resolve(FakeNetworkError()),
            LoginFailureState(message: "网络连接中断", shouldFocusPassword: false)
        )
    }
}

private struct FakeNetworkError: LocalizedError {
    var errorDescription: String? { "网络连接中断" }
}
