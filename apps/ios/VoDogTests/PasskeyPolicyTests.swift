import AuthenticationServices
import XCTest
@testable import VoDog

final class PasskeyPolicyTests: XCTestCase {
    func testEmptyUsernameMapsToVisiblePrompt() {
        let mapped = PasskeyErrorMapping.message(for: PasskeyClientError.missingUsername, operation: .signIn)
        XCTAssertEqual(mapped.error, "请先输入用户名")
        XCTAssertNil(mapped.status)
    }

    func testMissingWindowAndTimeoutAreVisible() {
        XCTAssertEqual(
            PasskeyErrorMapping.message(for: PasskeyClientError.missingPresentationWindow, operation: .signIn).error,
            "无法显示系统 Passkey 界面"
        )
        XCTAssertEqual(
            PasskeyErrorMapping.message(for: PasskeyClientError.timedOut, operation: .signIn).error,
            "无法显示系统 Passkey 界面"
        )
    }

    func testCanceledSignInIsVisibleAndDoesNotHang() {
        let error = NSError(domain: ASAuthorizationError.errorDomain, code: 1001)
        XCTAssertEqual(PasskeyErrorMapping.message(for: error, operation: .signIn).error, "已取消 Passkey")
    }

    func testMatchedExcludedCredentialIsRegisterOnly() {
        let error = NSError(domain: ASAuthorizationError.errorDomain, code: 1006)
        let register = PasskeyErrorMapping.message(for: error, operation: .register)
        XCTAssertNil(register.error)
        XCTAssertEqual(register.status, "本机已注册此 Passkey，无需重复创建")
        let signIn = PasskeyErrorMapping.message(for: error, operation: .signIn)
        XCTAssertEqual(signIn.error, "此账号没有可用的 Passkey")
        XCTAssertNil(signIn.status)
    }

    func testFailedAndMissingCredentialsAreVisibleOnSignIn() {
        let failed = NSError(domain: ASAuthorizationError.errorDomain, code: 1004)
        XCTAssertEqual(PasskeyErrorMapping.message(for: failed, operation: .signIn).error, "此账号没有可用的 Passkey")
        XCTAssertEqual(
            PasskeyErrorMapping.message(for: APIError.server(404, "", nil), operation: .signIn).error,
            "此账号没有可用的 Passkey"
        )
    }

    private func item(
        label: String? = nil, displayName: String? = nil, deviceType: String? = "multiDevice",
        backedUp: Bool? = nil, clientPlatform: String? = nil, attachment: String? = nil, lastUsedAt: String? = nil
    ) -> PasskeyItem {
        PasskeyItem(
            id: "id", createdAt: "2026-09-09T00:00:00Z", deviceType: deviceType, backedUp: backedUp,
            transports: nil, label: label, displayName: displayName, aaguid: nil,
            clientPlatform: clientPlatform, authenticatorAttachment: attachment, lastUsedAt: lastUsedAt
        )
    }

    func testDecodesTheNewMetadataFields() throws {
        let json = """
        {"items":[{"id":"abc","createdAt":"2026-09-09T00:00:00Z","deviceType":"multiDevice","backedUp":true,\
        "transports":["internal","hybrid"],"label":"我的 iPhone","displayName":"Apple iCloud Keychain",\
        "aaguid":"00000000-0000-4000-8000-000000000022","clientPlatform":"iOS App",\
        "authenticatorAttachment":"platform","lastUsedAt":"2026-09-10T08:00:00Z"}]}
        """
        let envelope = try JSONDecoder().decode(ItemEnvelope<PasskeyItem>.self, from: Data(json.utf8))
        let item = try XCTUnwrap(envelope.items.first)
        XCTAssertEqual(item.label, "我的 iPhone")
        XCTAssertEqual(item.displayName, "Apple iCloud Keychain")
        XCTAssertEqual(item.aaguid, "00000000-0000-4000-8000-000000000022")
        XCTAssertEqual(item.clientPlatform, "iOS App")
        XCTAssertEqual(item.authenticatorAttachment, "platform")
        XCTAssertEqual(item.lastUsedAt, "2026-09-10T08:00:00Z")
        XCTAssertEqual(item.resolvedName, "我的 iPhone")
    }

    /// An older control service returns none of the S18 fields; the row must still render.
    func testLegacyItemWithoutNewFieldsStillResolves() {
        let legacy = item(deviceType: "singleDevice")
        XCTAssertEqual(legacy.resolvedName, "singleDevice")
        XCTAssertEqual(legacy.platformSummary, "singleDevice")
        XCTAssertEqual(legacy.symbolName, "key")
    }

    func testResolvedNamePrefersLabelThenDisplayNameThenDeviceType() {
        XCTAssertEqual(item(label: "办公 Mac", displayName: "Chrome on macOS").resolvedName, "办公 Mac")
        XCTAssertEqual(item(displayName: "Chrome on macOS").resolvedName, "Chrome on macOS")
        XCTAssertEqual(item(label: "   ", displayName: "Chrome on macOS").resolvedName, "Chrome on macOS")
        XCTAssertEqual(item(label: "", displayName: "").resolvedName, "multiDevice")
    }

    func testPlatformSummaryJoinsAttachmentSyncAndPlatform() {
        XCTAssertEqual(
            item(backedUp: true, clientPlatform: "iOS App", attachment: "platform").platformSummary,
            "本机 · 已同步 · iOS App"
        )
        XCTAssertEqual(
            item(backedUp: false, clientPlatform: "Chrome on macOS", attachment: "cross-platform").platformSummary,
            "跨设备 · Chrome on macOS"
        )
        XCTAssertEqual(item(backedUp: true).platformSummary, "已同步")
        XCTAssertEqual(item(deviceType: "multiDevice", attachment: "unknown-value").platformSummary, "multiDevice")
    }

    /// An app passkey is also iCloud-synced, so the phone symbol has to win over `key.icloud`.
    func testSymbolPrefersTheDeviceOverTheSyncBadge() {
        XCTAssertEqual(item(backedUp: true, clientPlatform: "iOS App", attachment: "platform").symbolName, "iphone")
        XCTAssertEqual(item(backedUp: true, clientPlatform: "Android App").symbolName, "iphone")
        XCTAssertEqual(item(backedUp: false, clientPlatform: "Chrome on macOS").symbolName, "laptopcomputer")
        XCTAssertEqual(item(backedUp: true, clientPlatform: "Windows Hello").symbolName, "laptopcomputer")
        XCTAssertEqual(item(backedUp: true).symbolName, "key.icloud")
        XCTAssertEqual(item().symbolName, "key")
    }

    func testLabelValidationTrimsAndBoundsTheLength() {
        XCTAssertEqual(PasskeyDisplayPolicy.normalizedLabel("  我的 iPhone  "), "我的 iPhone")
        XCTAssertEqual(PasskeyDisplayPolicy.normalizedLabel("a"), "a")
        XCTAssertEqual(PasskeyDisplayPolicy.normalizedLabel(String(repeating: "x", count: 64))?.count, 64)
        XCTAssertNil(PasskeyDisplayPolicy.normalizedLabel(""))
        XCTAssertNil(PasskeyDisplayPolicy.normalizedLabel("   \n "))
        XCTAssertNil(PasskeyDisplayPolicy.normalizedLabel(String(repeating: "x", count: 65)))
    }

    func testPasskeyListItemDecodesPublicFieldsWithoutSecrets() throws {
        let json = #"{"items":[{"id":"abc-_def","createdAt":"2026-09-09T00:00:00Z","deviceType":"phone","backedUp":true,"transports":["internal"]}]}"#
        let envelope = try JSONDecoder().decode(ItemEnvelope<PasskeyItem>.self, from: Data(json.utf8))
        let item = try XCTUnwrap(envelope.items.first)
        XCTAssertEqual(item.id, "abc-_def")
        XCTAssertEqual(item.createdAt, "2026-09-09T00:00:00Z")
        XCTAssertEqual(item.deviceType, "phone")
        XCTAssertEqual(item.backedUp, true)
        XCTAssertEqual(item.transports, ["internal"])
        XCTAssertEqual(item.deviceTypeTitle, "phone")
        let extra = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        let rawItem = try XCTUnwrap((extra?["items"] as? [[String: Any]])?.first)
        XCTAssertNil(rawItem["public_key"])
        XCTAssertNil(rawItem["counter"])
    }
}
