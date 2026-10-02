import AVFoundation
import CryptoKit
import Security
import XCTest
@testable import VoDog

final class ContractTests: XCTestCase {
    func testRelayQualityFrameIsExactBoundedCCQ1Binary() throws {
        let frame = MediaQualityProbeFrame.encode(sequence: 169, sentUs: 0x0102030405060708)
        XCTAssertEqual(frame.count, 32)
        XCTAssertEqual(Array(frame[0..<16]), [
            0x43, 0x43, 0x51, 0x31, 0x00, 0x00, 0x00, 0xa9,
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        ])
        XCTAssertTrue(frame[16..<32].allSatisfy { $0 == 0 })
        let decoded = try XCTUnwrap(MediaQualityProbeFrame.decode(frame))
        XCTAssertEqual(decoded.sequence, 169)
        XCTAssertEqual(decoded.sentUs, 0x0102030405060708)
        XCTAssertNil(MediaQualityProbeFrame.decode(Data(frame.dropLast())))
        XCTAssertNil(MediaQualityProbeFrame.decode(MediaQualityProbeFrame.encode(sequence: 250, sentUs: 1)))
    }

    func testRelayQualityMetricsUseEchoRTTAndSuccessiveDifference() throws {
        let metrics = try XCTUnwrap(MediaQualityProbeFrame.summarize([10, 30, 20, 40]))
        XCTAssertEqual(metrics.median, 20)
        XCTAssertEqual(metrics.p95, 40)
        XCTAssertEqual(metrics.jitter, 20)
    }

    func testRelayQualitySDPRequiresCompletedUDPRelayCandidatesOnly() throws {
        let base = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
        let relay = "a=candidate:1 1 UDP 1 203.0.113.1 3478 typ relay\r\n"
        let completed = try MediaQualityProbeSDP.completedRelayOnly(base + relay)
        XCTAssertTrue(completed.contains("a=end-of-candidates\r\n"))
        XCTAssertEqual(completed.components(separatedBy: "a=end-of-candidates").count - 1, 1)
        XCTAssertThrowsError(try MediaQualityProbeSDP.completedRelayOnly(
            base + "a=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r\n"
        ))
        XCTAssertThrowsError(try MediaQualityProbeSDP.completedRelayOnly(
            base + relay + "a=candidate:2 1 TCP 1 203.0.113.1 3478 typ relay tcptype passive\r\n"
        ))
    }

    func testRelayQualityBudgetDoesNotWaitForNeverCompletingSDPCallback() async {
        let cancelled = expectation(description: "peer close initiated")
        let started = ContinuousClock().now
        let result = await MediaQualityProbeBudget.race(
            milliseconds: 50,
            timeoutValue: "timeout",
            cancel: { cancelled.fulfill() },
            operation: {
                await withUnsafeContinuation { (_: UnsafeContinuation<String, Never>) in
                    // Models a WebRTC SDP callback that never fires and ignores cancellation.
                }
            }
        )
        XCTAssertEqual(result, "timeout")
        await fulfillment(of: [cancelled], timeout: 0.5)
        XCTAssertLessThan(started.duration(to: ContinuousClock().now), .milliseconds(500))
    }

    @MainActor
    func testRelayQualityBudgetCancelBeforeInstallStillResumes() async {
        let operationStarts = LockedCounter()
        let cancellationHooks = LockedCounter()
        let task = Task {
            await MediaQualityProbeBudget.race(
                milliseconds: 5_000,
                timeoutValue: "cancelled",
                cancel: { cancellationHooks.increment() },
                operation: {
                    operationStarts.increment()
                    return await withUnsafeContinuation { (_: UnsafeContinuation<String, Never>) in }
                }
            )
        }
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result, "cancelled")
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(operationStarts.value, 0)
        XCTAssertEqual(cancellationHooks.value, 1)
    }

    func testRelayQualityCallbackBridgeCancellationResumesNeverCallback() async {
        let task = Task<Void, Error> {
            let _: Void = try await MediaQualityProbeCallbackBridge.wait { _ in
                // Deliberately never call the simulated WebRTC completion.
            }
        }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("A cancelled callback bridge must not stay suspended")
        } catch is CancellationError {}
        catch { XCTFail("Unexpected error: \(error)") }
    }

    func testRelayQualityCallbackBridgeDiscardsLateDuplicateCallbacks() async {
        typealias Completion = @Sendable (Result<Void, Error>) -> Void
        let callback = LockedBox<Completion>()
        let registered = expectation(description: "callback registered")
        let task = Task<Void, Error> {
            let _: Void = try await MediaQualityProbeCallbackBridge.wait { completion in
                callback.set(completion)
                registered.fulfill()
            }
        }
        await fulfillment(of: [registered], timeout: 0.5)
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") }
        catch is CancellationError {}
        catch { XCTFail("Unexpected error: \(error)") }
        let completion = try? XCTUnwrap(callback.value)
        completion?(.success(()))
        completion?(.failure(MediaQualityProbeError.signaling))
    }

    func testRelayQualityBudgetInvokesCloseHookExactlyOnceAcrossTimeoutCancelRace() async {
        for _ in 0..<10 {
            let hooks = LockedCounter()
            let task = Task {
                await MediaQualityProbeBudget.race(
                    milliseconds: 10, timeoutValue: "timeout",
                    cancel: { hooks.increment() },
                    operation: {
                        do {
                            let _: Void = try await MediaQualityProbeCallbackBridge.wait { _ in }
                        } catch {}
                        return "cancelled"
                    }
                )
            }
            try? await Task.sleep(for: .milliseconds(10))
            task.cancel()
            _ = await task.value
            XCTAssertEqual(hooks.value, 1)
        }
    }

    func testRelayQualityCollectorPropagatesLogoutCancellationToNodeAttempt() async {
        let closeStarted = expectation(description: "node transport close initiated")
        let operationExited = expectation(description: "node operation released")
        let node = Task {
            await MediaQualityProbeBudget.race(
                milliseconds: 5_000,
                timeoutValue: "cancelled",
                cancel: { closeStarted.fulfill() },
                operation: {
                    defer { operationExited.fulfill() }
                    do {
                        let _: Void = try await MediaQualityProbeCallbackBridge.wait { _ in }
                    } catch {}
                    return "cancelled"
                }
            )
        }
        let started = ContinuousClock().now
        let collector = Task { await MediaQualityProbeTaskCollector.collect([node]) }
        collector.cancel()
        _ = await collector.value
        await fulfillment(of: [closeStarted, operationExited], timeout: 0.5)
        XCTAssertLessThan(started.duration(to: ContinuousClock().now), .milliseconds(500))
    }

    func testRelayQualityNetworkChangeCancelsEveryNodeAttempt() async {
        let generation = FixedMediaNetworkGeneration("network-1")
        let closed = expectation(description: "all node transports closed")
        closed.expectedFulfillmentCount = 2
        let nodes = (0..<2).map { _ in
            Task {
                await MediaQualityProbeBudget.race(
                    milliseconds: 5_000, timeoutValue: "timeout",
                    cancel: { closed.fulfill() },
                    operation: {
                        do { let _: Void = try await MediaQualityProbeCallbackBridge.wait { _ in } }
                        catch {}
                        return "cancelled"
                    }
                )
            }
        }
        let monitor = MediaQualityProbeGenerationMonitor.start(
            tasks: nodes, expected: "network-1", source: generation
        )
        generation.value = "network-2"
        await fulfillment(of: [closed], timeout: 0.5)
        monitor.cancel()
        for node in nodes { _ = await node.value }
    }

    @MainActor
    func testRelayQualityCloseGateClosesTransportExactlyOnce() {
        let gate = MediaQualityProbeCloseGate()
        var closes = 0
        gate.close { closes += 1 }
        gate.close { closes += 1 }
        XCTAssertTrue(gate.isClosed)
        XCTAssertEqual(closes, 1)
    }

    func testRelayQualityHTTPWaitCancelsUnderlyingURLSessionTask() async {
        let started = expectation(description: "HTTP started")
        let stopped = expectation(description: "HTTP stopped")
        HangingURLProtocol.onStart = { started.fulfill() }
        HangingURLProtocol.onStop = { stopped.fulfill() }
        defer { HangingURLProtocol.onStart = nil; HangingURLProtocol.onStop = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HangingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let task = Task { try await session.data(from: URL(string: "https://probe.example.com/webrtc-probe/offer")!) }
        await fulfillment(of: [started], timeout: 0.5)
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") }
        catch is CancellationError {}
        catch let error as URLError { XCTAssertEqual(error.code, .cancelled) }
        catch { XCTFail("Unexpected error: \(error)") }
        await fulfillment(of: [stopped], timeout: 0.5)
        session.invalidateAndCancel()
    }

    @MainActor
    func testRelayQualityOptionsRequireFixedRelayOnlyContract() throws {
        let node = MediaQualityProbeNode(
            nodeId: "control-node", probeUrl: "https://control.example.com/webrtc-probe/offer",
            expiresAt: "2099-01-01T00:00:00Z", grant: "opaque-grant",
            iceServers: [.init(urls: ["turn:control.example.com:3478?transport=udp"], username: "user", credential: "credential")]
        )
        let valid = MediaQualityProbeOptionsResponse(
            networkGeneration: "generation-1", measurement: "relay_data_channel_echo_v1",
            lifetimeMs: 5_000, sampleDurationMs: 2_000, packetIntervalMs: 20,
            maxPackets: 250, maxPacketBytes: 512, iceTransportPolicy: "relay", nodes: [node]
        )
        XCTAssertNoThrow(try MediaQualityProbeRunner.validate(valid, generation: "generation-1"))
        let invalid = MediaQualityProbeOptionsResponse(
            networkGeneration: valid.networkGeneration, measurement: valid.measurement,
            lifetimeMs: valid.lifetimeMs, sampleDurationMs: valid.sampleDurationMs,
            packetIntervalMs: valid.packetIntervalMs, maxPackets: 251,
            maxPacketBytes: valid.maxPacketBytes, iceTransportPolicy: valid.iceTransportPolicy, nodes: valid.nodes
        )
        XCTAssertThrowsError(try MediaQualityProbeRunner.validate(invalid, generation: "generation-1"))
    }

    @MainActor
    func testLoginRotationAndLogoutEntryCancelProbeLifecycleImmediately() async throws {
        MockURLProtocol.handler = { _ in (200, #"{}"#) }
        let lifecycle = ProbeLifecycleSpy()
        let store = SessionStore(
            networkSession: mockSession(), credentialStore: MemoryCredentialStore(nil),
            mediaProbeManager: lifecycle
        )
        let login = LoginResponse(
            token: "access", refreshToken: "refresh", expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")
        )
        try store.acceptLogin(login)
        XCTAssertEqual(lifecycle.cancelCount, 1)
        try store.acceptLogin(login)
        XCTAssertEqual(lifecycle.cancelCount, 2)
        await store.logout()
        XCTAssertEqual(lifecycle.cancelCount, 3)
        XCTAssertEqual(lifecycle.invalidateCount, 3)
    }

    /// S22 决策 11：退出登录保留用户名密码。
    @MainActor
    func testLogoutKeepsTheRememberedCredentialsAndPasskeyOnlyUpdatesTheUsername() async throws {
        MockURLProtocol.handler = { _ in (200, #"{}"#) }
        let remembered = MemoryLastLoginStore()
        let credentials = MemoryCredentialStore(nil)
        let store = SessionStore(
            networkSession: mockSession(), credentialStore: credentials,
            mediaProbeManager: ProbeLifecycleSpy(), lastLoginStore: remembered
        )
        try store.acceptLogin(.init(
            token: "access", refreshToken: "refresh", expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")
        ))
        store.rememberPasswordLogin(username: "  tester@example.com  ", password: "secret")
        XCTAssertEqual(try remembered.load(), LastLoginCredentials(username: "tester@example.com", password: "secret"))

        await store.logout()
        XCTAssertNil(try credentials.load(), "The session token item is cleared on logout")
        XCTAssertEqual(
            try remembered.load(), LastLoginCredentials(username: "tester@example.com", password: "secret"),
            "The remembered login lives in its own keychain item and must survive 退出登录"
        )
        XCTAssertEqual(store.lastLogin()?.password, "secret")

        // A passkey sign-in has no password to offer; it must not blank the stored one.
        store.rememberPasskeyUsername("other@example.com")
        XCTAssertEqual(try remembered.load(), LastLoginCredentials(username: "other@example.com", password: "secret"))
        // Nothing empty is ever written over a good value.
        store.rememberPasswordLogin(username: "", password: "")
        XCTAssertEqual(try remembered.load()?.username, "other@example.com")
    }

    /// 忘记已保存的账号 — the explicit erase, matched with the Android client.
    @MainActor
    func testForgetRememberedLoginErasesUsernameAndPassword() async throws {
        MockURLProtocol.handler = { _ in (200, #"{}"#) }
        let remembered = MemoryLastLoginStore()
        let store = SessionStore(
            networkSession: mockSession(), credentialStore: MemoryCredentialStore(nil),
            mediaProbeManager: ProbeLifecycleSpy(), lastLoginStore: remembered
        )
        store.rememberPasswordLogin(username: "tester@example.com", password: "secret")
        XCTAssertNotNil(store.lastLogin())
        store.forgetRememberedLogin()
        XCTAssertNil(try remembered.load(), "忘记已保存的账号 erases the username and the password together")
        XCTAssertNil(store.lastLogin())
        // Idempotent: a second tap on an already empty store is not an error.
        store.forgetRememberedLogin()
        XCTAssertNil(store.lastLogin())
        XCTAssertEqual(LoginCopy.forgetRemembered, "忘记已保存的账号")
    }

    /// The real keychain delete path, so "忘记已保存的账号" is proven against `SecItemDelete`, not only a fake.
    func testRememberedLoginKeychainRoundTripAndDelete() throws {
        try LastLoginKeychain.delete()
        try LastLoginKeychain.save(LastLoginCredentials(username: "tester@example.com", password: "secret"))
        XCTAssertEqual(try LastLoginKeychain.load()?.username, "tester@example.com")
        XCTAssertEqual(try LastLoginKeychain.load()?.password, "secret")
        // The session token item lives under a different account and is untouched by this erase.
        try Keychain.delete()
        try Keychain.save(.init(token: "access", refreshToken: "refresh", expiresAt: nil,
                                user: .init(id: "u1", username: "tester@example.com", role: "user")))
        try LastLoginKeychain.delete()
        XCTAssertNil(try LastLoginKeychain.load())
        XCTAssertEqual(try Keychain.load()?.token, "access", "Forgetting the saved account must not sign the user out")
        // Deleting twice must not throw: errSecItemNotFound is a success for this operation.
        XCTAssertNoThrow(try LastLoginKeychain.delete())
        try Keychain.delete()
    }

    func testRememberedLoginUsesItsOwnKeychainAccountUnderTheSameService() {
        XCTAssertEqual(LastLoginKeychain.service, Keychain.service)
        XCTAssertEqual(LastLoginKeychain.account, "last-login-credentials")
        XCTAssertNotEqual(LastLoginKeychain.account, "access-token")
        // A plaintext password is stricter than the session token and never syncs to the iCloud keychain.
        XCTAssertEqual(LastLoginKeychain.accessibility, kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
    }

    @MainActor
    func testOldLogoutCompletionCannotClearReplacementLogin() async throws {
        let requestStarted = expectation(description: "old logout request started")
        let pending = LockedBox<DeferredURLProtocol>()
        DeferredURLProtocol.handler = { protocolInstance in
            if protocolInstance.request.url?.path.hasSuffix("/auth/logout") == true {
                pending.set(protocolInstance)
                requestStarted.fulfill()
            } else {
                protocolInstance.respond(status: 200, body: #"{}"#)
            }
        }
        defer { DeferredURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredURLProtocol.self]
        let store = SessionStore(
            networkSession: URLSession(configuration: configuration),
            credentialStore: MemoryCredentialStore(nil), mediaProbeManager: ProbeLifecycleSpy()
        )
        try store.acceptLogin(.init(
            token: "old", refreshToken: "old-refresh", expiresAt: nil,
            user: .init(id: "old-user", username: "old@example.com", role: "user")
        ))
        let logout = Task { @MainActor in await store.logout() }
        await fulfillment(of: [requestStarted], timeout: 0.5)
        try store.acceptLogin(.init(
            token: "new", refreshToken: "new-refresh", expiresAt: nil,
            user: .init(id: "new-user", username: "new@example.com", role: "user")
        ))
        pending.value?.respond(status: 200, body: #"{}"#)
        await logout.value
        XCTAssertEqual(store.token, "new")
        XCTAssertEqual(store.user?.id, "new-user")
        XCTAssertTrue(store.isAuthenticated)
    }

    @MainActor
    func testOldUnauthorizedResponseCannotRefreshOrClearReplacementLogin() async throws {
        let requestStarted = expectation(description: "old protected request started")
        let pending = LockedBox<DeferredURLProtocol>()
        let refreshes = LockedCounter()
        DeferredURLProtocol.handler = { protocolInstance in
            if protocolInstance.request.url?.path.hasSuffix("/protected") == true {
                pending.set(protocolInstance)
                requestStarted.fulfill()
            } else if protocolInstance.request.url?.path.hasSuffix("/auth/refresh") == true {
                refreshes.increment()
                protocolInstance.respond(status: 401, body: #"{"error":{"message":"unauthorized"}}"#)
            } else {
                protocolInstance.respond(status: 200, body: #"{}"#)
            }
        }
        defer { DeferredURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredURLProtocol.self]
        let store = SessionStore(
            networkSession: URLSession(configuration: configuration),
            credentialStore: MemoryCredentialStore(nil), mediaProbeManager: ProbeLifecycleSpy()
        )
        try store.acceptLogin(.init(
            token: "old", refreshToken: "old-refresh", expiresAt: nil,
            user: .init(id: "old-user", username: "old@example.com", role: "user")
        ))
        let oldIdentity = try XCTUnwrap(store.sessionIdentity)
        let request = Task { @MainActor in
            let _: EmptyResponse = try await store.request("protected", requiredSessionIdentity: oldIdentity)
        }
        await fulfillment(of: [requestStarted], timeout: 0.5)
        try store.acceptLogin(.init(
            token: "new", refreshToken: "new-refresh", expiresAt: nil,
            user: .init(id: "new-user", username: "new@example.com", role: "user")
        ))
        pending.value?.respond(status: 401, body: #"{"error":{"message":"unauthorized"}}"#)
        do { try await request.value; XCTFail("Expected stale session") }
        catch SessionLifecycleError.staleSession {}
        catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertEqual(refreshes.value, 0)
        XCTAssertEqual(store.token, "new")
        XCTAssertEqual(store.user?.id, "new-user")
    }

    @MainActor
    func testPreCancelledMediaPrepareStartsNoRequest() async throws {
        let requests = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url?.path.contains("/media/") == true { requests.increment() }
            return (500, "")
        }
        let store = SessionStore(networkSession: mockSession(), credentialStore: MemoryCredentialStore(nil))
        try store.acceptLogin(.init(
            token: "access", refreshToken: "refresh", expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")
        ))
        let manager = MediaProbeManager(
            generationSource: FixedMediaNetworkGeneration("network-1"), probeSession: mockSession()
        )
        let identity = try XCTUnwrap(store.sessionIdentity)
        let prepare = Task { @MainActor in
            try await manager.prepare(session: store, requiredSessionIdentity: identity)
        }
        prepare.cancel()
        do { _ = try await prepare.value; XCTFail("Expected cancellation") }
        catch is CancellationError {}
        catch { XCTFail("Unexpected error: \(error)") }
        await Task.yield()
        XCTAssertEqual(requests.value, 0)
    }

    @MainActor
    func testSharedMediaPrepareCancelsTransportOnlyAfterLastWaiterLeaves() async throws {
        let requestStarted = expectation(description: "shared options request started")
        let requestStopped = expectation(description: "shared options request stopped")
        DeferredURLProtocol.stopCount.reset()
        DeferredURLProtocol.onStop = { requestStopped.fulfill() }
        DeferredURLProtocol.handler = { protocolInstance in
            if protocolInstance.request.url?.path.contains("/media/probes/options") == true {
                requestStarted.fulfill()
            } else {
                protocolInstance.respond(status: 500, body: "")
            }
        }
        defer { DeferredURLProtocol.handler = nil; DeferredURLProtocol.onStop = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredURLProtocol.self]
        let networkSession = URLSession(configuration: configuration)
        let store = SessionStore(networkSession: networkSession, credentialStore: MemoryCredentialStore(nil))
        try store.acceptLogin(.init(
            token: "access", refreshToken: "refresh", expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")
        ))
        let identity = try XCTUnwrap(store.sessionIdentity)
        let manager = MediaProbeManager(
            generationSource: FixedMediaNetworkGeneration("network-1"), probeSession: networkSession
        )
        let first = Task { @MainActor in
            try await manager.prepare(session: store, requiredSessionIdentity: identity)
        }
        await fulfillment(of: [requestStarted], timeout: 0.5)
        let second = Task { @MainActor in
            try await manager.prepare(session: store, requiredSessionIdentity: identity)
        }
        for _ in 0..<100 where manager.activeWaiterCount < 2 { await Task.yield() }
        XCTAssertEqual(manager.activeWaiterCount, 2)
        let firstCancel = ContinuousClock().now
        first.cancel()
        do { _ = try await first.value; XCTFail("Expected first waiter cancellation") }
        catch is CancellationError {}
        catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertLessThan(firstCancel.duration(to: ContinuousClock().now), .milliseconds(500))
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(DeferredURLProtocol.stopCount.value, 0)
        let secondCancel = ContinuousClock().now
        second.cancel()
        do { _ = try await second.value; XCTFail("Expected second waiter cancellation") }
        catch is CancellationError {}
        catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertLessThan(secondCancel.duration(to: ContinuousClock().now), .milliseconds(500))
        await fulfillment(of: [requestStopped], timeout: 0.5)
        XCTAssertEqual(DeferredURLProtocol.stopCount.value, 1)
        networkSession.invalidateAndCancel()
    }

    @MainActor
    func testOldRefreshCompletionCannotClearReplacementRefreshHandle() async {
        let slot = SessionTaskSlot<String>()
        let old = Task<String, Error> { "old" }
        let oldID = slot.install(old)
        let replacement = Task<String, Error> { "replacement" }
        let replacementID = slot.install(replacement)
        slot.clear(ifCurrent: oldID)
        XCTAssertEqual(slot.id, replacementID)
        XCTAssertNotNil(slot.task)
        slot.cancelAndClear()
    }

    func testReportRequestEncodesCalendarPeriodAndIANATimeZoneAsQuery() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/reports/calls")
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            XCTAssertEqual(Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })["period"]!, "6m")
            XCTAssertEqual(Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })["timeZone"]!, "America/New_York")
            return (200, #"{"window":{"period":"6m","timeZone":"America/New_York","fromInclusive":"2026-03-09T12:00:00Z","toExclusive":"2026-09-09T12:00:00Z"},"items":[]}"#)
        }
        let response: CallReportEnvelope = try await APIClient(token: "access", session: mockSession()).request(
            "reports/calls", queryItems: [URLQueryItem(name: "period", value: "6m"), URLQueryItem(name: "timeZone", value: "America/New_York")]
        )
        XCTAssertTrue(response.items.isEmpty)
        XCTAssertEqual(response.window.period, "6m")
    }

    func testTranscriptSegmentsKeepSpeakerTrackAndExplicitAdvertisingExclusion() throws {
        let json = #"{"transcript":{"id":"job-1","callId":"call-1","status":"succeeded","attempts":1,"nextAttemptAt":null,"error":null,"result":{"text":"内容","segments":[{"track":"remote_original","speaker":"remote","text":"客户讲话","startMs":0,"endMs":1500},{"track":"caller_original","speaker":"vodog_user","text":"本人讲话"}],"providers":[{"track":"remote_original","provider":"provider","model":"model","version":"v1"}],"advertisingClassification":"advertising","includeInReports":false,"summary":"广告摘要","actionItems":[]},"createdAt":"2026-09-09T00:00:00Z","updatedAt":"2026-09-09T00:01:00Z","completedAt":"2026-09-09T00:01:00Z"}}"#
        let transcript = try XCTUnwrap(JSONDecoder().decode(TranscriptEnvelope.self, from: Data(json.utf8)).transcript)
        XCTAssertEqual(transcript.result?.segments.map(\.speakerTitle), ["对方", "本人"])
        XCTAssertEqual(transcript.result?.segments.map(\.trackTitle), ["对方原声", "我的原声"])
        XCTAssertEqual(transcript.result?.segments.map(\.playbackCaption), ["对方原声 · 0:00", "我的原声"])
        XCTAssertEqual(transcript.result?.advertisingClassification, "advertising")
        XCTAssertEqual(transcript.result?.includeInReports, false)
    }

    func testIOSCanDecodeSyntheticOggOpusToPCM() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "synthetic-opus", withExtension: "ogg"))
        let asset = AVURLAsset(url: url)
        let isPlayable = try await asset.load(.isPlayable)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        XCTAssertTrue(isPlayable)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMBitDepthKey: 16,
        ])
        XCTAssertTrue(reader.canAdd(output))
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        XCTAssertNotNil(output.copyNextSampleBuffer(), "AVFoundation advertised Ogg/Opus but produced no decoded PCM")
        reader.cancelReading()
    }

    // MARK: - S22 决策 10：全部通话与报告的服务端搜索

    func testCallsSearchRequestEncodesQueryAndLimit() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/calls")
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(query["query"], "张三")
            XCTAssertEqual(query["limit"], "100")
            return (200, #"{"items":[]}"#)
        }
        let response: ItemEnvelope<CallRecord> = try await APIClient(token: "access", session: mockSession()).request(
            "calls", queryItems: RecordSearchPolicy.callsQuery(query: "  张三  ")
        )
        XCTAssertTrue(response.items.isEmpty)
        // An empty search must not send `query=` at all; that is what makes it the plain local list.
        XCTAssertNil(RecordSearchPolicy.callsQuery(query: "   ").first { $0.name == "query" })
    }

    func testReportRequestEncodesCalendarDayRangeSearchAndTimeZone() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/reports/calls")
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(query["from"], "2026-09-05")
            XCTAssertEqual(query["to"], "2026-09-11")
            XCTAssertEqual(query["timeZone"], "Asia/Shanghai")
            XCTAssertEqual(query["limit"], "200")
            XCTAssertEqual(query["query"], "保险")
            // S22 sends an explicit calendar window; `period` is only kept alive server-side for old clients.
            XCTAssertFalse(query.keys.contains("period"))
            return (200, #"{"window":{"timeZone":"Asia/Shanghai","fromInclusive":"2026-09-04T16:00:00Z","toExclusive":"2026-09-11T16:00:00Z"},"items":[]}"#)
        }
        let response: CallReportEnvelope = try await APIClient(token: "access", session: mockSession()).request(
            "reports/calls",
            queryItems: RecordSearchPolicy.reportQuery(
                from: "2026-09-05", to: "2026-09-11", timeZone: "Asia/Shanghai", query: "保险"
            )
        )
        // A window built from `from`/`to` has no period at all, which must not fail decoding.
        XCTAssertNil(response.window.period)
        XCTAssertTrue(response.items.isEmpty)
    }

    // MARK: - S26 决策：记录分页

    func testPagedCallsResponseCarriesTotalsWhileALegacyEnvelopeDecodesAsUnpaged() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/calls")
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query["page"], "2")
            XCTAssertEqual(query["pageSize"], "50")
            XCTAssertNil(query["limit"], "分页请求不再发 limit")
            return (200, #"{"items":[{"id":"c1","simId":"s1","direction":"incoming","remoteNumber":"2025550101","state":"completed","startedAt":"2026-09-12T01:00:00Z"}],"page":2,"pageSize":50,"total":187,"totalPages":4}"#)
        }
        let paged: PagedEnvelope<CallRecord> = try await APIClient(token: "access", session: mockSession()).request(
            "calls", queryItems: RecordSearchPolicy.callsQuery(query: "", page: 2, pageSize: 50)
        )
        XCTAssertEqual(paged.items.map(\.id), ["c1"])
        XCTAssertEqual(paged.page, 2)
        XCTAssertEqual(paged.pageSize, 50)
        XCTAssertEqual(paged.total, 187)
        XCTAssertEqual(paged.totalPages, 4)
        XCTAssertTrue(paged.supported)

        // A Control that predates the contract answers the bare `{items}` it always did: one page, no pager.
        MockURLProtocol.handler = { _ in
            (200, #"{"items":[{"id":"c1","simId":"s1","direction":"incoming","remoteNumber":"2025550101","state":"completed","startedAt":"2026-09-12T01:00:00Z"}]}"#)
        }
        let legacy: PagedEnvelope<CallRecord> = try await APIClient(token: "access", session: mockSession()).request(
            "calls", queryItems: RecordSearchPolicy.callsQuery(query: "", page: 2, pageSize: 50)
        )
        XCTAssertEqual(legacy.items.count, 1)
        XCTAssertNil(legacy.totalPages)
        XCTAssertFalse(legacy.supported)
        XCTAssertFalse(
            RecordsPagingPolicy.showsPager(
                supported: legacy.supported, totalPages: legacy.totalPages,
                total: legacy.total, pageSize: 50
            )
        )

        // The report route carries the same four fields next to its window.
        MockURLProtocol.handler = { _ in
            (200, #"{"window":{"timeZone":"Asia/Shanghai","fromInclusive":"2026-09-04T16:00:00Z","toExclusive":"2026-09-11T16:00:00Z"},"items":[],"page":1,"pageSize":200,"total":401,"totalPages":3}"#)
        }
        let report: CallReportEnvelope = try await APIClient(token: "access", session: mockSession()).request(
            "reports/calls",
            queryItems: RecordSearchPolicy.reportQuery(
                from: "2026-09-05", to: "2026-09-11", timeZone: "Asia/Shanghai", query: "", page: 1, pageSize: 200
            )
        )
        XCTAssertEqual(report.totalPages, 3)
        XCTAssertEqual(report.total, 401)
        XCTAssertTrue(report.supported)
    }

    func testCallRecordDecodesS22AnswerModeFieldsAndFailsClosedWithoutThem() throws {
        let suppressed = #"{"call":{"id":"c1","simId":"s1","direction":"incoming","remoteNumber":"2025550101","state":"incoming_ringing","answerMode":"ai","aiHandling":true,"aiTriggerAt":"2026-09-11T14:57:43.689Z"}}"#
        let call = try JSONDecoder().decode(TestCallEnvelope.self, from: Data(suppressed.utf8)).call
        XCTAssertEqual(call.answerMode, "ai")
        XCTAssertEqual(call.aiHandling, true)
        XCTAssertEqual(call.aiTriggerAt, "2026-09-11T14:57:43.689Z")
        XCTAssertTrue(call.suppressesRinging)

        let legacy = #"{"call":{"id":"c1","simId":"s1","direction":"incoming","remoteNumber":"2025550101","state":"incoming_ringing"}}"#
        let old = try JSONDecoder().decode(TestCallEnvelope.self, from: Data(legacy.utf8)).call
        XCTAssertNil(old.answerMode)
        XCTAssertNil(old.aiHandling)
        XCTAssertNil(old.aiTriggerAt)
        XCTAssertFalse(old.suppressesRinging, "A pre-S22 server must never suppress the answer buttons")
    }

    func testCallReportItemDecodesS22ContractAndLegacyRowsAlike() throws {
        let json = #"{"window":{"timeZone":"Asia/Shanghai","fromInclusive":"2026-09-04T16:00:00Z","toExclusive":"2026-09-11T16:00:00Z"},"items":[{"callId":"c1","startedAt":"2026-09-11T14:57:43.689Z","answeredAt":"2026-09-11T14:57:45.000Z","endedAt":"2026-09-11T14:58:33.000Z","direction":"incoming","remoteNumber":"2025550101","contactName":"张三","contactId":"ct1","blocked":false,"blockedEntryId":null,"sim":{"id":"s1","label":"SIM 1","slotIndex":0},"gatewayTimeZone":"Asia/Shanghai","answerMode":"ai","answeredByPlatform":"ai","recordingStatus":"ready","transcriptState":"failed","transcriptError":{"code":"RECORDING_EMPTY"},"summary":null,"actionItems":["回电确认"],"classification":"advertising","blockRecommended":true,"blockCategory":"insurance","blockReason":"保险销售","hasAiTranscript":true,"transcriptCompletedAt":null,"callUrl":"/calls/c1","transcriptUrl":"/calls/c1/transcript","recordingUrl":"/calls/c1/recordings","aiTranscriptUrl":"/calls/c1/ai-transcript"}]}"#
        let item = try XCTUnwrap(JSONDecoder().decode(CallReportEnvelope.self, from: Data(json.utf8)).items.first)
        XCTAssertEqual(item.contactName, "张三")
        XCTAssertEqual(item.transcriptState, "failed")
        XCTAssertEqual(item.transcriptError?.code, "RECORDING_EMPTY")
        XCTAssertEqual(item.blockRecommended, true)
        XCTAssertEqual(item.blockReason, "保险销售")
        XCTAssertEqual(item.blockCategory, "insurance")
        XCTAssertTrue(item.hasAiTranscriptText)
        XCTAssertFalse(item.isBlocked)
        XCTAssertNil(item.transcriptCompletedAt)
        XCTAssertEqual(item.actionItems, ["回电确认"])

        // A pre-S22 Control sends none of the new keys and still sends `advertisingClassification`.
        let legacy = #"{"window":{"period":"7d","timeZone":"Asia/Shanghai","fromInclusive":"2026-09-04T16:00:00Z","toExclusive":"2026-09-11T16:00:00Z"},"items":[{"callId":"c1","startedAt":"2026-09-11T14:57:43Z","direction":"incoming","remoteNumber":"2025550101","sim":{"id":"s1","label":"SIM 1","slotIndex":0},"summary":"摘要","actionItems":[],"advertisingClassification":"unknown","recordingStatus":"ready","callUrl":"/calls/c1","transcriptUrl":"/calls/c1/transcript","recordingUrl":"/calls/c1/recordings","transcriptCompletedAt":"2026-09-11T15:00:00Z"}]}"#
        let envelope = try JSONDecoder().decode(CallReportEnvelope.self, from: Data(legacy.utf8))
        let old = try XCTUnwrap(envelope.items.first)
        XCTAssertEqual(envelope.window.period, "7d")
        XCTAssertEqual(old.summary, "摘要")
        XCTAssertEqual(old.advertisingClassification, "unknown")
        XCTAssertNil(old.transcriptState)
        XCTAssertNil(old.blockRecommended, "An un-reclassified row is 未分类, not 'no block recommended'")
        XCTAssertFalse(old.hasAiTranscriptText)
        XCTAssertTrue(old.actionItems.isEmpty)
    }

    // MARK: - S22 决策 7：录音时间戳与空录音

    func testMediaNodeManifestAcceptsFractionalSecondFinalizedAt() throws {
        let id = "00000000-0000-4000-8000-000000000001"
        let hash = String(repeating: "a", count: 64)
        // Go serialises `time.Time` as RFC 3339 *Nano*; this string is what production actually sends.
        let json = #"{"recording":{"version":1,"callId":"\#(id)","finalizedAt":"2026-09-11T14:58:33.4821936Z","complete":true,"artifacts":[{"name":"remote_original.ogg","bytes":120,"sha256":"\#(hash)"},{"name":"caller_original.ogg","bytes":240,"sha256":"\#(hash)"},{"name":"timeline.jsonl","bytes":40,"sha256":"\#(hash)"}]}}"#
        let manifest = try XCTUnwrap(JSONDecoder().decode(RecordingEnvelope.self, from: Data(json.utf8)).recording)
        XCTAssertTrue(manifest.isValid(for: id), "Fractional seconds must not read as a source/file mismatch")
        XCTAssertFalse(manifest.isEmptyCapture)
        XCTAssertNotNil(GatewayTimeDisplay.parseISO(manifest.finalizedAt))
    }

    func testPixelManifestDecodesFractionalSecondStartedAt() throws {
        let id = "00000000-0000-4000-8000-000000000001"
        let archive = "00000000-0000-4000-8000-000000000002"
        let hash = String(repeating: "a", count: 64)
        // `GatewayRecordingArchive` writes `appendInstant(3)`, so every Pixel archive carries milliseconds.
        let json = #"{"recording":{"source":"pixel","version":2,"archiveId":"\#(archive)","callId":"\#(id)","archiveComplete":true,"captureComplete":true,"startedAt":"2026-09-11T14:57:43.689Z","endedAt":"2026-09-11T14:58:33.245Z","tracks":[{"track":"remote_original","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0},{"track":"caller_original","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0}],"timeline":{"mediaType":"application/x-ndjson","bytes":20,"sha256":"\#(hash)"}}}"#
        let manifest = try XCTUnwrap(JSONDecoder().decode(RecordingEnvelope.self, from: Data(json.utf8)).recording)
        XCTAssertTrue(manifest.isValid(for: id, requestedSource: .pixel))
        XCTAssertFalse(manifest.isEmptyCapture)
        XCTAssertEqual(manifest.finalizedAt, "2026-09-11T14:58:33.245Z")
    }

    func testHeaderOnlyArchivesReadAsEmptyRecordingsNotAsManifestMismatches() throws {
        let id = "00000000-0000-4000-8000-000000000001"
        let archive = "00000000-0000-4000-8000-000000000002"
        let hash = String(repeating: "a", count: 64)
        let mediaNode = #"{"recording":{"version":1,"callId":"\#(id)","finalizedAt":"2026-09-11T14:58:33.4821936Z","complete":false,"artifacts":[{"name":"remote_original.ogg","bytes":95,"sha256":"\#(hash)"},{"name":"caller_original.ogg","bytes":95,"sha256":"\#(hash)"},{"name":"timeline.jsonl","bytes":0,"sha256":"\#(hash)"}]}}"#
        let node = try XCTUnwrap(JSONDecoder().decode(RecordingEnvelope.self, from: Data(mediaNode.utf8)).recording)
        XCTAssertTrue(node.isValid(for: id, requestedSource: .mediaNode), "complete:false must still decode and validate")
        XCTAssertTrue(node.isEmptyCapture)

        // The matching Pixel archive: 44-byte WAV headers with captureComplete false.
        let pixel = #"{"recording":{"source":"pixel","version":2,"archiveId":"\#(archive)","callId":"\#(id)","archiveComplete":true,"captureComplete":false,"startedAt":"2026-09-11T14:57:43.689Z","endedAt":"2026-09-11T14:57:47.240Z","tracks":[{"track":"remote_original","mediaType":"audio/wav","bytes":44,"sha256":"\#(hash)","captureComplete":false,"gapCount":0,"droppedFrames":0},{"track":"caller_original","mediaType":"audio/wav","bytes":44,"sha256":"\#(hash)","captureComplete":false,"gapCount":0,"droppedFrames":0}],"timeline":{"mediaType":"application/x-ndjson","bytes":20,"sha256":"\#(hash)"}}}"#
        let archiveManifest = try XCTUnwrap(JSONDecoder().decode(RecordingEnvelope.self, from: Data(pixel.utf8)).recording)
        XCTAssertTrue(archiveManifest.isValid(for: id, requestedSource: .pixel))
        XCTAssertTrue(archiveManifest.isEmptyCapture)

        let presentation = recordingErrorPresentation(RecordingPresentationError.emptyCapture, source: .mediaNode)
        XCTAssertEqual(presentation.message, "录音为空或采集失败，暂无法播放")
        XCTAssertFalse(presentation.canRetry, "Retrying cannot produce audio that was never captured")
        XCTAssertNotEqual(presentation.message, RecordingErrorCopy.inconsistentManifest)
    }

    func testRecordingErrorCopySeparatesMismatchFromEmptyAndNeverLeaksDecodingErrors() throws {
        let mismatch = recordingErrorPresentation(APIError.invalidResponse, source: .mediaNode)
        XCTAssertEqual(mismatch.message, "录音来源或文件信息不一致，请刷新后重试。")
        XCTAssertTrue(mismatch.canRetry)
        // R1 §5.2: a manifest the app cannot decode used to surface Foundation's English description.
        let corrupt = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "v2 start time mismatch"))
        let decoded = recordingErrorPresentation(corrupt, source: .pixel)
        XCTAssertEqual(decoded.message, RecordingErrorCopy.inconsistentManifest)
    }

    func testRecordingManifestRepresentsPartialTracksWithoutInventingCompleteness() throws {
        let id = "00000000-0000-4000-8000-000000000001"
        let hash = String(repeating: "a", count: 64)
        let json = #"{"recording":{"version":1,"callId":"\#(id)","finalizedAt":"2026-09-09T00:00:00Z","complete":false,"artifacts":[{"name":"remote_original.ogg","bytes":120,"sha256":"\#(hash)"},{"name":"caller_original.ogg","bytes":0,"sha256":"\#(hash)"},{"name":"timeline.jsonl","bytes":40,"sha256":"\#(hash)"}]}}"#
        let envelope = try JSONDecoder().decode(RecordingEnvelope.self, from: Data(json.utf8))
        let manifest = try XCTUnwrap(envelope.recording)
        XCTAssertTrue(manifest.isValid(for: id))
        XCTAssertFalse(manifest.complete)
        XCTAssertEqual(manifest.artifact(for: .remoteOriginal)?.bytes, 120)
        XCTAssertEqual(manifest.artifact(for: .callerOriginal)?.bytes, 0)
    }

    func testPixelRecordingManifestRequiresExplicitV2WavIdentityAndPreservesQuality() throws {
        let id = "00000000-0000-4000-8000-000000000001"
        let archive = "00000000-0000-4000-8000-000000000002"
        let hash = String(repeating: "a", count: 64)
        let json = #"{"recording":{"source":"pixel","version":2,"archiveId":"\#(archive)","callId":"\#(id)","archiveComplete":true,"captureComplete":false,"startedAt":"2026-09-09T00:00:00Z","endedAt":"2026-09-09T00:01:00Z","tracks":[{"track":"remote_original","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0},{"track":"caller_original","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":false,"gapCount":1,"droppedFrames":2}],"timeline":{"mediaType":"application/x-ndjson","bytes":20,"sha256":"\#(hash)"}}}"#
        let manifest = try XCTUnwrap(JSONDecoder().decode(RecordingEnvelope.self, from: Data(json.utf8)).recording)
        XCTAssertTrue(manifest.isValid(for: id, requestedSource: .pixel))
        XCTAssertFalse(manifest.isValid(for: id, requestedSource: .mediaNode))
        XCTAssertEqual(manifest.artifact(for: .callerOriginal)?.gapCount, 1)
        XCTAssertEqual(manifest.artifact(for: .callerOriginal)?.droppedFrames, 2)
        XCTAssertEqual(manifest.artifact(for: .callerOriginal)?.mediaType, "audio/wav")
    }

    func testPixelV3KeepsDerivedPlayoutSeparateFromOriginalCapture() throws {
        let id = "00000000-0000-4000-8000-000000000001"
        let archive = "00000000-0000-4000-8000-000000000002"
        let hash = String(repeating: "a", count: 64)
        let json = #"{"recording":{"source":"pixel","version":3,"archiveId":"\#(archive)","callId":"\#(id)","manifestSha256":"\#(hash)","archiveComplete":true,"captureComplete":false,"startedAt":"2026-09-09T00:00:00Z","endedAt":"2026-09-09T00:01:00Z","tracks":[{"track":"remote_original","sourceRole":"original_capture","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0},{"track":"caller_original","sourceRole":"original_capture","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":false,"gapCount":1,"droppedFrames":2}],"derivedTracks":[{"track":"caller_playout","sourceRole":"derived_playout","mediaType":"audio/wav","bytes":3044,"sha256":"\#(hash)","playoutComplete":true,"gapCount":0,"recoveryFrames":2}],"timeline":{"mediaType":"application/x-ndjson","bytes":20,"sha256":"\#(hash)"}}}"#
        let manifest = try XCTUnwrap(JSONDecoder().decode(RecordingEnvelope.self, from: Data(json.utf8)).recording)
        XCTAssertTrue(manifest.isValid(for: id, requestedSource: .pixel))
        XCTAssertFalse(manifest.captureComplete ?? true)
        XCTAssertEqual(manifest.artifact(for: .callerOriginal)?.droppedFrames, 2)
        XCTAssertEqual(manifest.derivedArtifacts.first?.sourceRole, "derived_playout")
        XCTAssertEqual(manifest.derivedArtifacts.first?.recoveryFrames, 2)
        XCTAssertEqual(manifest.combinedPlaybackArtifacts.map(\.path), ["remote_original", "caller_original"])
        XCTAssertEqual(manifest.compensatedPlaybackArtifacts.map(\.path), ["remote_original", "caller_playout"])
    }

    func testV2RejectsDerivedTrackAndV3RequiresDerivedTrack() throws {
        let id = "00000000-0000-4000-8000-000000000001", archive = "00000000-0000-4000-8000-000000000002"
        let hash = String(repeating: "a", count: 64)
        let tracks = #"[{"track":"remote_original","sourceRole":"original_capture","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0},{"track":"caller_original","sourceRole":"original_capture","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0}]"#
        let common = #""archiveId":"\#(archive)","callId":"\#(id)","archiveComplete":true,"captureComplete":true,"startedAt":"2026-09-09T00:00:00Z","endedAt":"2026-09-09T00:01:00Z","tracks":\#(tracks),"timeline":{"mediaType":"application/x-ndjson","bytes":20,"sha256":"\#(hash)"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(RecordingEnvelope.self, from: Data(#"{"recording":{"source":"pixel","version":2,\#(common),"derivedTracks":[]}}"#.utf8)))
        let v3 = try XCTUnwrap(JSONDecoder().decode(RecordingEnvelope.self, from: Data(#"{"recording":{"source":"pixel","version":3,"manifestSha256":"\#(hash)",\#(common),"derivedTracks":[]}}"#.utf8)).recording)
        XCTAssertFalse(v3.isValid(for: id, requestedSource: .pixel))
        XCTAssertEqual(v3.combinedPlaybackArtifacts.map(\.path), ["remote_original", "caller_original"])
        XCTAssertTrue(v3.compensatedPlaybackArtifacts.isEmpty)
    }

    func testS94PixelUplinkTrackParsesAndBecomesDefaultPair() throws {
        let id = "00000000-0000-4000-8000-000000000001", archive = "00000000-0000-4000-8000-000000000002"
        let hash = String(repeating: "a", count: 64)
        let tracks = #"[{"track":"remote_original","sourceRole":"original_capture","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0},{"track":"caller_original","sourceRole":"original_capture","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0}]"#
        let common = #""source":"pixel","version":2,"archiveId":"\#(archive)","callId":"\#(id)","archiveComplete":true,"captureComplete":true,"startedAt":"2026-09-09T00:00:00Z","endedAt":"2026-09-09T00:01:00Z","tracks":\#(tracks),"timeline":{"mediaType":"application/x-ndjson","bytes":20,"sha256":"\#(hash)"}"#
        let uplink = #"{"track":"caller_uplink","sourceRole":"uplink_capture","mediaType":"audio/wav","bytes":3044,"sha256":"\#(hash)","captureComplete":false,"gapCount":1,"droppedFrames":0}"#
        func decode(_ extra: String) throws -> RecordingManifest? {
            try JSONDecoder().decode(RecordingEnvelope.self, from: Data(#"{"recording":{\#(common)\#(extra)}}"#.utf8)).recording
        }

        let plain = try XCTUnwrap(decode(""))
        XCTAssertTrue(plain.isValid(for: id, requestedSource: .pixel))
        XCTAssertTrue(plain.uplinkArtifacts.isEmpty)
        XCTAssertTrue(plain.ownerJoinedPlaybackArtifacts.isEmpty)
        XCTAssertEqual(plain.defaultTogetherMode, .originals)

        let v4 = try XCTUnwrap(decode(#","archiveVersion":4,"uplinkTracks":[\#(uplink)]"#))
        XCTAssertTrue(v4.isValid(for: id, requestedSource: .pixel))
        // An incomplete uplink does not affect the descriptor's two-original-track completeness.
        XCTAssertEqual(v4.captureComplete, true)
        XCTAssertEqual(v4.ownerJoinedPlaybackArtifacts.map(\.path), ["remote_original", "caller_uplink"])
        XCTAssertEqual(v4.combinedPlaybackArtifacts.map(\.path), ["remote_original", "caller_original"])
        XCTAssertEqual(v4.defaultTogetherMode, .ownerJoined)

        XCTAssertThrowsError(try decode(#","uplinkTracks":[\#(uplink)]"#))
        XCTAssertThrowsError(try decode(#","archiveVersion":4"#))
        XCTAssertThrowsError(try decode(#","archiveVersion":4,"uplinkTracks":[]"#))
        XCTAssertThrowsError(try decode(#","archiveVersion":4,"uplinkTracks":[\#(uplink),\#(uplink)]"#))
        XCTAssertThrowsError(try decode(#","archiveVersion":4,"uplinkTracks":[\#(uplink.replacingOccurrences(of: "uplink_capture", with: "original_capture"))]"#))
    }

    func testS94TranscriptToleratesCallerUplinkAndUnknownTracks() throws {
        let json = #"{"transcript":{"id":"job-1","callId":"call-1","status":"succeeded","attempts":1,"nextAttemptAt":null,"error":null,"result":{"text":"内容","segments":[{"track":"remote_original","speaker":"remote","text":"客户讲话"},{"track":"caller_uplink","speaker":"vodog_user","text":"机主讲话","startMs":800},{"track":"future_track","speaker":"spk_9","text":"其他"}],"providers":[{"track":"caller_uplink","provider":"provider","model":null,"version":null}],"advertisingClassification":"none","includeInReports":true,"summary":null,"actionItems":[]},"createdAt":"2026-09-09T00:00:00Z","updatedAt":"2026-09-09T00:01:00Z","completedAt":"2026-09-09T00:01:00Z"}}"#
        let segments = try XCTUnwrap(JSONDecoder().decode(TranscriptEnvelope.self, from: Data(json.utf8)).transcript?.result?.segments)
        XCTAssertEqual(segments.map(\.track), ["remote_original", "caller_uplink", "future_track"])
        XCTAssertEqual(segments[1].trackTitle, "本机上行（含本机接入）")
        XCTAssertEqual(segments[1].speakerTitle, "本人")
        XCTAssertEqual(segments[2].trackTitle, "其他声轨")
        XCTAssertEqual(TranscriptText.blocks(from: segments)[1].trackTitle, "本机上行（含本机接入）")
    }

    func testDisabledPixelArchiveOffersMediaNodeWithoutRetryLoop() {
        let presentation = recordingErrorPresentation(
            APIError.server(503, "Pixel recording archive is not enabled", nil), source: .pixel
        )
        XCTAssertFalse(presentation.canRetry)
        XCTAssertTrue(presentation.message.contains("服务器录音"))
        XCTAssertTrue(recordingErrorPresentation(APIError.invalidResponse, source: .mediaNode).canRetry)
        XCTAssertEqual(recordingErrorPresentation(APIError.unauthorized, source: .pixel).canRetry, false)
        XCTAssertTrue(recordingErrorPresentation(APIError.server(404, "", nil), source: .pixel).message.contains("尚未上传"))
        XCTAssertFalse(recordingErrorPresentation(APIError.server(416, "", nil), source: .mediaNode).canRetry)
    }

    func testPixelManifestRejectsDuplicateTrackAndFabricatedCaptureCompleteness() throws {
        let id = "00000000-0000-4000-8000-000000000001", archive = "00000000-0000-4000-8000-000000000002"
        let hash = String(repeating: "a", count: 64)
        let track = #"{"track":"remote_original","mediaType":"audio/wav","bytes":2044,"sha256":"\#(hash)","captureComplete":true,"gapCount":0,"droppedFrames":0}"#
        let json = #"{"recording":{"source":"pixel","version":2,"archiveId":"\#(archive)","callId":"\#(id)","archiveComplete":true,"captureComplete":false,"startedAt":"2026-09-09T00:00:00Z","endedAt":"2026-09-09T00:01:00Z","tracks":[\#(track),\#(track)],"timeline":{"mediaType":"application/x-ndjson","bytes":20,"sha256":"\#(hash)"}}}"#
        let manifest = try XCTUnwrap(JSONDecoder().decode(RecordingEnvelope.self, from: Data(json.utf8)).recording)
        XCTAssertFalse(manifest.isValid(for: id, requestedSource: .pixel))
    }

    func testRecordingFileVerifierChecksManifestSizeAndSHA256() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "synthetic-opus", withExtension: "ogg"))
        let data = try Data(contentsOf: url)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let valid = RecordingArtifact(name: "remote_original.ogg", bytes: Int64(data.count), sha256: digest)
        let validResult = try await RecordingFileVerifier.verify(url, artifact: valid)
        XCTAssertTrue(validResult)
        let wrongHash = RecordingArtifact(name: valid.name, bytes: valid.bytes, sha256: String(repeating: "0", count: 64))
        let wrongHashResult = try await RecordingFileVerifier.verify(url, artifact: wrongHash)
        XCTAssertFalse(wrongHashResult)
        let wrongSize = RecordingArtifact(name: valid.name, bytes: valid.bytes + 1, sha256: digest)
        let wrongSizeResult = try await RecordingFileVerifier.verify(url, artifact: wrongSize)
        XCTAssertFalse(wrongSizeResult)
    }

    @MainActor
    func testRecordingPlaybackRejectsCallAudioAndIgnoresOldCompletion() {
        XCTAssertFalse(AppAudioOwnershipPolicy.canStartRecordingPlayback(mediaCallID: "call-1"))
        XCTAssertTrue(AppAudioOwnershipPolicy.canStartRecordingPlayback(mediaCallID: nil))
        let old = UUID(), current = UUID()
        XCTAssertFalse(RecordingPlaybackCompletionPolicy.shouldStop(
            observerOperationID: old, currentOperationID: current, observedItemIsCurrent: true
        ))
        XCTAssertFalse(RecordingPlaybackCompletionPolicy.shouldStop(
            observerOperationID: current, currentOperationID: current, observedItemIsCurrent: false
        ))
        XCTAssertTrue(RecordingPlaybackCompletionPolicy.shouldStop(
            observerOperationID: current, currentOperationID: current, observedItemIsCurrent: true
        ))
    }

    @MainActor
    func testAudioConfigurationFailureReleasesPlayerFileAndAudioSession() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "synthetic-opus", withExtension: "ogg"))
        let data = try Data(contentsOf: url)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        MockURLProtocol.contentType = "audio/ogg"
        MockURLProtocol.responseData = data
        MockURLProtocol.headerFields = [
            "Content-Length": "\(data.count)", "ETag": "\"\(digest)\"", "Accept-Ranges": "bytes",
        ]
        defer {
            MockURLProtocol.contentType = "application/json"
            MockURLProtocol.responseData = nil
            MockURLProtocol.headerFields = [:]
        }
        MockURLProtocol.handler = { _ in (200, "") }
        let session = SessionStore(networkSession: mockSession(), credentialStore: MemoryCredentialStore(nil))
        try session.acceptLogin(.init(token: "access", refreshToken: "refresh", expiresAt: nil,
            user: .init(id: "u1", username: "one@example.com", role: "user")))
        var deactivationCount = 0
        let controller = RecordingPlaybackController(
            configureAudio: { throw URLError(.cannotOpenFile) },
            deactivateAudio: { deactivationCount += 1 }
        )
        controller.start(
            track: .remoteOriginal,
            artifact: .init(name: "remote_original.ogg", bytes: Int64(data.count), sha256: digest),
            source: .mediaNode, callID: "00000000-0000-4000-8000-000000000001", session: session
        )
        for _ in 0..<200 {
            if case .failed = controller.state { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard case .failed(.remoteOriginal, _) = controller.state else {
            return XCTFail("Injected audio configuration failure must be visible")
        }
        XCTAssertEqual(deactivationCount, 1)
        XCTAssertFalse(controller.hasRetainedPlaybackResources)
    }

    func testRecordingDownloadUsesExplicitSourceAndFullValidatedResponse() async throws {
        MockURLProtocol.contentType = "audio/ogg"
        let hash = String(repeating: "a", count: 64)
        MockURLProtocol.headerFields = ["ETag": "\"\(hash)\"", "Accept-Ranges": "bytes", "Content-Length": "9"]
        defer { MockURLProtocol.contentType = "application/json"; MockURLProtocol.headerFields = [:] }
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/calls/call-1/recordings/remote_original")
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "media_node")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access")
            XCTAssertNil(request.value(forHTTPHeaderField: "Range"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "audio/ogg")
            return (200, "ogg-bytes")
        }
        let file = try await APIClient(token: "access", session: mockSession())
            .download("calls/call-1/recordings/remote_original")
        defer { try? FileManager.default.removeItem(at: file.url) }
        XCTAssertEqual(file.contentType, "audio/ogg")
        XCTAssertEqual(file.etag, "\"\(hash)\"")
        XCTAssertNil(file.contentDisposition)
        XCTAssertEqual(try Data(contentsOf: file.url), Data("ogg-bytes".utf8))
    }

    func testRecordingDownloadAttachmentAddsDispositionQuery() async throws {
        MockURLProtocol.contentType = "audio/ogg"
        let hash = String(repeating: "a", count: 64)
        let filename = "call-00000000-0000-4000-8000-000000000001-media_node-remote_original.ogg"
        MockURLProtocol.headerFields = [
            "ETag": "\"\(hash)\"", "Accept-Ranges": "bytes", "Content-Length": "9",
            "Content-Disposition": "attachment; filename=\"\(filename)\"",
        ]
        defer { MockURLProtocol.contentType = "application/json"; MockURLProtocol.headerFields = [:] }
        MockURLProtocol.handler = { request in
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(Set(items.map(\.name)), Set(["source", "disposition"]))
            XCTAssertEqual(items.first { $0.name == "source" }?.value, "media_node")
            XCTAssertEqual(items.first { $0.name == "disposition" }?.value, "attachment")
            XCTAssertNil(request.value(forHTTPHeaderField: "Range"))
            return (200, "ogg-bytes")
        }
        let file = try await APIClient(token: "access", session: mockSession())
            .download("calls/call-1/recordings/remote_original", disposition: "attachment")
        defer { try? FileManager.default.removeItem(at: file.url) }
        XCTAssertEqual(file.contentDisposition, "attachment; filename=\"\(filename)\"")
        XCTAssertEqual(
            RecordingAttachmentName.filename(
                callID: "00000000-0000-4000-8000-000000000001", source: .mediaNode,
                track: "remote_original", header: file.contentDisposition
            ),
            filename
        )
    }

    func testPixelWavPreflightValidatesRangeEtagAndMime() {
        let hash = String(repeating: "b", count: 64)
        let artifact = RecordingArtifact(name: "remote_original.wav", bytes: 2044, sha256: hash,
                                         track: .remoteOriginal, mediaType: "audio/wav", captureComplete: true)
        let valid = RecordingPreflightResponse(HTTPURLResponse(
            url: URL(string: "https://example.test")!, statusCode: 206, httpVersion: nil,
            headerFields: ["Content-Type": "audio/wav", "Content-Length": "1", "Content-Range": "bytes 0-0/2044",
                           "ETag": "\"\(hash)\"", "Accept-Ranges": "bytes"]
        )!)
        XCTAssertTrue(RecordingResponseValidator.validatePreflight(valid, artifact: artifact))
        let wrong = RecordingPreflightResponse(HTTPURLResponse(
            url: URL(string: "https://example.test")!, statusCode: 206, httpVersion: nil,
            headerFields: ["Content-Type": "audio/ogg", "Content-Length": "1", "Content-Range": "bytes 0-0/2044",
                           "ETag": "\"\(hash)\"", "Accept-Ranges": "bytes"]
        )!)
        XCTAssertFalse(RecordingResponseValidator.validatePreflight(wrong, artifact: artifact))
    }

    func testPixelWavPreflightSendsOneByteRangeAndExplicitSource() async throws {
        let hash = String(repeating: "b", count: 64)
        MockURLProtocol.contentType = "audio/wav"
        MockURLProtocol.headerFields = [
            "ETag": "\"\(hash)\"", "Accept-Ranges": "bytes",
            "Content-Length": "1", "Content-Range": "bytes 0-0/2044",
        ]
        defer { MockURLProtocol.contentType = "application/json"; MockURLProtocol.headerFields = [:] }
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "audio/wav")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), "bytes=0-0")
            XCTAssertNil(request.value(forHTTPHeaderField: "If-Range"))
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            XCTAssertEqual(components.queryItems, [URLQueryItem(name: "source", value: "pixel")])
            return (206, "x")
        }
        let response = try await APIClient(token: "access", session: mockSession())
            .recordingPreflight("calls/call-1/recordings/remote_original", source: .pixel)
        XCTAssertEqual(response.statusCode, 206)
        XCTAssertEqual(response.contentRange, "bytes 0-0/2044")
    }

    func testCollectionAndSIMContractDecode() throws {
        let json = #"{"items":[{"id":"00000000-0000-0000-0000-000000000001","gatewayId":"00000000-0000-0000-0000-000000000002","slotIndex":0,"label":"工作卡","phoneLabel":"SIM 1","version":3,"online":true,"settings":{"mode":"timeout_ai","timeoutSeconds":45,"version":3,"appliedVersion":2,"availableModes":["normal","ai","timeout_ai"],"aiUnavailableReason":null}}]}"#
        let result = try JSONDecoder().decode(ItemEnvelope<SIMChannel>.self, from: Data(json.utf8))
        XCTAssertEqual(result.items.first?.settings?.mode, "timeout_ai")
        XCTAssertEqual(result.items.first?.settings?.appliedVersion, 2)
        XCTAssertTrue(result.items.first?.settings?.isAvailable(.ai) == true)
    }

    func testLegacySIMSettingsFailClosedToNormalMode() throws {
        let json = #"{"mode":"normal","timeoutSeconds":45,"version":3,"appliedVersion":null}"#
        let settings = try JSONDecoder().decode(SIMSettings.self, from: Data(json.utf8))
        XCTAssertTrue(settings.isAvailable(.normal))
        XCTAssertFalse(settings.isAvailable(.ai))
        XCTAssertFalse(settings.isAvailable(.timeoutAI))
    }

    func testSettingsResponseKeepsPreviouslyAdvertisedCapabilitiesWhenPutOmitsThem() throws {
        let listed = try JSONDecoder().decode(SIMSettings.self, from: Data(#"{"mode":"ai","timeoutSeconds":45,"version":3,"appliedVersion":2,"availableModes":["normal","ai"],"aiUnavailableReason":null}"#.utf8))
        let updated = try JSONDecoder().decode(SIMSettings.self, from: Data(#"{"mode":"ai","timeoutSeconds":45,"version":4,"appliedVersion":2}"#.utf8))
            .mergingCapabilities(from: listed)
        XCTAssertEqual(updated.version, 4)
        XCTAssertTrue(updated.isAvailable(.ai))
        XCTAssertFalse(updated.isAvailable(.timeoutAI))
    }

    func testDeliveredOutgoingSMSExposesDirectionSIMAndReceiptState() throws {
        let json = #"{"id":"00000000-0000-4000-8000-000000000021","simId":"sim-1","direction":"outgoing","remoteNumber":"0101","body":"probe","state":"delivered","missingParts":false,"createdAt":"2026-09-09T12:34:09Z","sentAt":"2026-09-09T12:34:10Z","deliveredAt":"2026-09-09T12:34:11Z"}"#
        let sms = try JSONDecoder().decode(SMSMessage.self, from: Data(json.utf8))
        XCTAssertEqual(sms.simId, "sim-1")
        XCTAssertEqual(sms.directionTitle, "发出")
        XCTAssertEqual(sms.deliveryTitle, "已送达")
        XCTAssertEqual(sms.statusDate, sms.deliveredAt)
    }

    func testLoginContractDecode() throws {
        let json = #"{"token":"access","refreshToken":"refresh","expiresAt":"2026-09-09T00:00:00Z","user":{"id":"u1","username":"tester@example.com","role":"user"}}"#
        let result = try JSONDecoder().decode(LoginResponse.self, from: Data(json.utf8))
        XCTAssertEqual(result.token, "access")
        XCTAssertEqual(result.user.role, "user")
    }

    func testProductionAPIBaseURLAndKeychainNamespaceAreFixed() {
        XCTAssertEqual(AppRuntimeConfiguration.productionAPIBaseURL.absoluteString, "https://vodog.example.com/api/v1")
        XCTAssertEqual(AppRuntimeConfiguration.productionKeychainService, "org.vodog")
    }

    func testSimulatorBackendOverrideOnlyAcceptsTheS33LoopbackEndpoint() {
        let exact = ["VODOG_UI_TEST_API_BASE_URL": "http://127.0.0.1:16880/api/v1"]
        #if DEBUG && targetEnvironment(simulator)
        XCTAssertEqual(
            AppRuntimeConfiguration.simulatorUITestAPIBaseURL(environment: exact)?.absoluteString,
            "http://127.0.0.1:16880/api/v1"
        )
        XCTAssertEqual(
            AppRuntimeConfiguration.keychainService(environment: exact),
            AppRuntimeConfiguration.isolatedSimulatorKeychainService
        )
        #else
        XCTAssertNil(AppRuntimeConfiguration.simulatorUITestAPIBaseURL(environment: exact))
        XCTAssertEqual(
            AppRuntimeConfiguration.keychainService(environment: exact),
            AppRuntimeConfiguration.productionKeychainService
        )
        #endif

        for rejected in [
            "http://localhost:16880/api/v1",
            "http://127.0.0.1:16881/api/v1",
            "https://127.0.0.1:16880/api/v1",
            "http://127.0.0.1:16880/",
            "https://vodog.example.com/api/v1",
            "http://example.com:16880/api/v1",
        ] {
            let environment = ["VODOG_UI_TEST_API_BASE_URL": rejected]
            XCTAssertNil(AppRuntimeConfiguration.simulatorUITestAPIBaseURL(environment: environment), rejected)
            XCTAssertEqual(
                AppRuntimeConfiguration.keychainService(environment: environment),
                AppRuntimeConfiguration.productionKeychainService,
                rejected
            )
        }
    }

    func testLogoutRequestHasNoBodyOrJSONContentType() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/auth/logout")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.httpBody)
            XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))
            return (204, "")
        }
        let response: EmptyResponse = try await APIClient(token: "access", session: mockSession())
            .request("auth/logout", method: "POST")
        _ = response
    }

    func testMediaOptionsRequestSelectsOnlyOneTransport() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/calls/call-1/media/options")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try XCTUnwrap(requestBody(request))
            let value = try JSONDecoder().decode(MediaOptionsRequest.self, from: body)
            XCTAssertEqual(value.transport, .tls)
            XCTAssertEqual(value.networkGeneration, "network-1")
            return (200, #"{"iceServers":[{"urls":["turns:relay:16802?transport=tcp"],"username":"u","credential":"c"}],"iceTransportPolicy":"relay"}"#)
        }
        let response: MediaOptionsResponse = try await APIClient(token: "access", session: mockSession()).request(
            "calls/call-1/media/options", method: "POST",
            body: MediaOptionsRequest(transport: .tls, networkGeneration: "network-1")
        )
        XCTAssertNoThrow(try response.validatedRelayURL(for: .tls))
    }

    func testMediaOptionsAcceptExactlyOneUDPRelay() throws {
        let json = #"{"iceServers":[{"urls":["turn:relay.example.com:16801?transport=udp"],"username":"expires:user","credential":"signed"}],"iceTransportPolicy":"relay"}"#
        let options = try JSONDecoder().decode(MediaOptionsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(try options.validatedRelayURL(for: .udp).urls.count, 1)
        XCTAssertThrowsError(try options.validatedRelayURL(for: .tls))
    }

    func testMediaOptionsAcceptTLSAsSingleExplicitTransport() throws {
        let json = #"{"iceServers":[{"urls":["turns:relay.example.com:16802?transport=tcp"],"username":"expires:user","credential":"signed"}],"iceTransportPolicy":"relay"}"#
        let options = try JSONDecoder().decode(MediaOptionsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(try options.validatedRelayURL(for: .tls).urls.count, 1)
    }

    func testMediaOptionsRejectCandidatePoolThatCouldConsumeBothTransports() throws {
        let json = #"{"iceServers":[{"urls":["turn:relay:16801?transport=udp","turns:relay:16802?transport=tcp"],"username":"u","credential":"c"}],"iceTransportPolicy":"relay"}"#
        let options = try JSONDecoder().decode(MediaOptionsResponse.self, from: Data(json.utf8))
        XCTAssertThrowsError(try options.validatedRelayURL(for: .udp))
    }

    @MainActor
    func testMediaProbeUsesThreeEmptySingleGrantPostsThenSubmitsSamples() async throws {
        let generation = FixedMediaNetworkGeneration("network-1")
        let observed = ProbeContractServer(generation: generation, changeGenerationAfterProbes: false)
        MockURLProtocol.handler = observed.respond
        let store = SessionStore(networkSession: mockSession(), credentialStore: MemoryCredentialStore(nil))
        try store.acceptLogin(.init(token: "access", refreshToken: "refresh", expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")))
        let identity = try XCTUnwrap(store.sessionIdentity)
        let manager = MediaProbeManager(generationSource: generation, probeSession: mockSession())

        let preparedGeneration = try await manager.prepare(session: store, requiredSessionIdentity: identity)
        XCTAssertEqual(preparedGeneration, "network-1")
        XCTAssertEqual(observed.grants, ["Bearer g1", "Bearer g2", "Bearer g3"])
        XCTAssertTrue(observed.probesHadEmptyBodyAndNoContentType)
        XCTAssertEqual(observed.optionsGeneration, "network-1")
        XCTAssertEqual(observed.resultSamples.count, 3)
        XCTAssertTrue(observed.resultSamples.allSatisfy { $0.nodeId == "control-node" && $0.outcome == .ok && $0.httpsRttMs != nil })
        XCTAssertTrue(observed.submitted)
        XCTAssertEqual(observed.qualityOptionsGeneration, "network-1")
        XCTAssertEqual(observed.qualityResultsRequests, 0)
    }

    @MainActor
    func testMediaProbeDiscardsMeasurementsWhenNetworkGenerationChanges() async throws {
        let generation = FixedMediaNetworkGeneration("network-1")
        let observed = ProbeContractServer(generation: generation, changeGenerationAfterProbes: true)
        MockURLProtocol.handler = observed.respond
        let store = SessionStore(networkSession: mockSession(), credentialStore: MemoryCredentialStore(nil))
        try store.acceptLogin(.init(token: "access", refreshToken: "refresh", expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")))
        let manager = MediaProbeManager(generationSource: generation, probeSession: mockSession())
        do {
            _ = try await manager.prepare(session: store, requiredSessionIdentity: try XCTUnwrap(store.sessionIdentity))
            XCTFail("A changed network generation must discard stale measurements")
        } catch MediaProbeError.networkChanged {}
        XCTAssertFalse(observed.submitted)
    }

    func testVoIPPayloadRequiresVersionOneAndUUIDCallID() throws {
        let id = UUID().uuidString.lowercased()
        let payload = try XCTUnwrap(PushCallPayload(["version": 1, "event": "call.incoming", "callId": id, "remoteNumber": "+12025550120"]))
        XCTAssertEqual(payload.event, "call.incoming")
        XCTAssertEqual(payload.callId, id)
        XCTAssertNil(PushCallPayload(["version": 2, "event": "call.incoming", "callId": id]))
        XCTAssertNil(PushCallPayload(["version": 1, "event": "call.incoming", "callId": "not-a-uuid"]))
    }

    func testAPNsTokenHexEncodingStaysWithinContractLimit() {
        let token = Data((0..<32).map(UInt8.init)).hexEncodedString()
        XCTAssertEqual(token.count, 64)
        XCTAssertLessThanOrEqual(token.count, 512)
        XCTAssertTrue(token.allSatisfy(\.isHexDigit))
    }

    func testOfferedCallKeepsRingingOnlyWhileAuthoritySaysIncomingRinging() {
        XCTAssertEqual(OfferedCallReconciliation.decision(for: "incoming_ringing"), .keepRinging)
        for state in ["outgoing_pending", "connecting", "active", "ending", "ended", "failed", "unknown", nil] {
            XCTAssertEqual(OfferedCallReconciliation.decision(for: state), .endLocalOffer, "state=\(state ?? "nil")")
        }
    }

    func testOfferedCallAnsweredByAnotherClientEndsAsAnsweredElsewhere() {
        XCTAssertTrue(OfferedCallReconciliation.answeredElsewhere("connecting"))
        XCTAssertTrue(OfferedCallReconciliation.answeredElsewhere("active"))
        for state in ["incoming_ringing", "ending", "ended", "failed", "unknown", nil] {
            XCTAssertFalse(OfferedCallReconciliation.answeredElsewhere(state), "state=\(state ?? "nil")")
        }
    }

    func testCallDetailDecodesCurrentSessionOwnershipForClaimRecovery() throws {
        let json = #"{"call":{"id":"00000000-0000-4000-8000-000000000001","state":"connecting","claimedByCurrentSession":true}}"#
        let envelope = try JSONDecoder().decode(TestCallEnvelope.self, from: Data(json.utf8))
        XCTAssertTrue(ClaimedCallPolicy.isOwnedAndAnswerable(envelope.call))

        let missingOwnership = #"{"call":{"id":"00000000-0000-4000-8000-000000000001","state":"connecting"}}"#
        let unproven = try JSONDecoder().decode(TestCallEnvelope.self, from: Data(missingOwnership.utf8))
        XCTAssertFalse(ClaimedCallPolicy.isOwnedAndAnswerable(unproven.call))
    }

    func testClaimRecoveryRejectsCurrentSessionOwnershipOutsideConnectingOrActive() throws {
        for state in ["incoming_ringing", "ending", "ended", "failed", "unknown"] {
            let json = #"{"call":{"id":"00000000-0000-4000-8000-000000000001","state":"\#(state)","claimedByCurrentSession":true}}"#
            let call = try JSONDecoder().decode(TestCallEnvelope.self, from: Data(json.utf8)).call
            XCTAssertFalse(ClaimedCallPolicy.isOwnedAndAnswerable(call), "state=\(state)")
        }
    }

    func testReliableEndUsesSessionOwnerGuard() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/calls/call-1/end")
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try JSONDecoder().decode(
                SessionOwnedCallEndBody.self, from: try XCTUnwrap(requestBody(request))
            )
            XCTAssertEqual(body, SessionOwnedCallEndBody(onlyIfCurrentSessionOwner: true))
            return (200, #"{"call":{"id":"call-1","state":"ending","claimedByCurrentSession":true}}"#)
        }
        let _: TestCallEnvelope = try await APIClient(token: "access", session: mockSession()).request(
            "calls/call-1/end", method: "POST",
            body: SessionOwnedCallEndBody(onlyIfCurrentSessionOwner: true), timeoutInterval: 4
        )
    }

    func testRingingDeclineUsesAtomicRingingGuardOnly() throws {
        let data = try JSONEncoder().encode(ReliableCallEndConstraint.ringingUnclaimed.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Bool])
        XCTAssertEqual(object, ["onlyIfRinging": true])
        XCTAssertNil(object["onlyIfCurrentSessionOwner"])
    }

    func testOwnedEndGuardDoesNotBecomeRingingOnly() throws {
        let data = try JSONEncoder().encode(ReliableCallEndConstraint.currentSessionOwner.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Bool])
        XCTAssertEqual(object, ["onlyIfCurrentSessionOwner": true])
        XCTAssertNil(object["onlyIfRinging"])
    }

    func testIncomingEndPolicyKeepsDeclineSeparateFromOwnedHangup() {
        let current = UUID()
        XCTAssertEqual(
            IncomingCallEndPolicy.constraint(
                wasOffered: true, expectedOwnerIdentity: nil, currentSessionIdentity: current
            ),
            .ringingUnclaimed
        )
        XCTAssertEqual(
            IncomingCallEndPolicy.constraint(
                wasOffered: true, expectedOwnerIdentity: current, currentSessionIdentity: current
            ),
            .currentSessionOwner
        )
        XCTAssertNil(IncomingCallEndPolicy.constraint(
            wasOffered: true, expectedOwnerIdentity: UUID(), currentSessionIdentity: current
        ))
        XCTAssertNil(IncomingCallEndPolicy.constraint(
            wasOffered: false, expectedOwnerIdentity: nil, currentSessionIdentity: current
        ))
    }

    func testLogoutAndProviderResetDoNotEndOfferedOnlyCalls() {
        let current = UUID()
        let offered = "00000000-0000-4000-8000-000000000001"
        let owned = "00000000-0000-4000-8000-000000000002"
        let otherSession = "00000000-0000-4000-8000-000000000003"
        let calls = SessionCleanupEndPolicy.ownedCallIDs(
            candidates: [offered, owned, otherSession],
            ownedCallSessions: [owned: current, otherSession: UUID()],
            currentSessionIdentity: current
        )
        XCTAssertEqual(calls, [owned])
        XCTAssertFalse(calls.contains(offered), "An offered-only call must not trigger a network end on logout/reset")
    }

    func testReliableEndPolicyStopsOnlyAtReleasedStates() {
        for state in ["ended", "failed"] {
            XCTAssertTrue(ReliableCallEndPolicy.isReleased(state), "state=\(state)")
        }
        for state in ["ending", "unknown", "incoming_ringing", "outgoing_pending", "connecting", "active", nil] {
            XCTAssertFalse(ReliableCallEndPolicy.isReleased(state), "state=\(state ?? "nil")")
        }
    }

    /// A slow control service timed every attempt out inside ~7 s and the call stayed occupied; the schedule now
    /// keeps trying for about 90 s, with a request timeout longer than the observed server latency.
    func testReliableEndRetriesForAboutNinetySecondsWithGrowingBackoff() {
        let delays = ReliableCallEndPolicy.retryDelays
        XCTAssertEqual(delays.first, .zero, "The first attempt must be immediate")
        XCTAssertGreaterThanOrEqual(delays.count, 7)
        XCTAssertTrue(zip(delays, delays.dropFirst()).allSatisfy { pair in pair.0 <= pair.1 }, "Backoff must not shrink")
        XCTAssertGreaterThanOrEqual(ReliableCallEndPolicy.totalDelay, .seconds(60))
        XCTAssertLessThanOrEqual(ReliableCallEndPolicy.totalDelay, .seconds(90))
        XCTAssertGreaterThanOrEqual(ReliableCallEndPolicy.requestTimeout, 8)
    }

    func testReliableEndStops409WhenNothingLeftToEnd() {
        XCTAssertTrue(ReliableCallEndPolicy.shouldStopRetrying(APIError.server(404, "", "NOT_FOUND")))
        XCTAssertTrue(ReliableCallEndPolicy.shouldStopRetrying(APIError.server(409, "", "CALL_NOT_SESSION_OWNER")))
        XCTAssertTrue(ReliableCallEndPolicy.shouldStopRetrying(APIError.server(409, "", "CALL_NOT_RINGING")))
        XCTAssertFalse(ReliableCallEndPolicy.shouldStopRetrying(APIError.server(503, "", "GATEWAY_OFFLINE")))
        XCTAssertFalse(ReliableCallEndPolicy.shouldStopRetrying(APIError.server(409, "", nil)))
        XCTAssertTrue(ReliableCallEndPolicy.shouldStopRetrying(APIError.unauthorized))
    }

    func testOccupancyReleaseEndsLeftoverFailedOrIdleCallID() {
        let callID = "00000000-0000-4000-8000-000000000001"
        let identity = UUID()
        let owned = OccupancyReleasePolicy.ownedIDs(
            mediaCallID: callID, ownedCallSessions: [:], currentSessionIdentity: identity
        )
        XCTAssertEqual(owned, [callID])
        XCTAssertFalse(OccupancyReleasePolicy.isLive(activeCallIDs: [], media: .failed))
        XCTAssertFalse(OccupancyReleasePolicy.isLive(activeCallIDs: [], media: .idle))
        XCTAssertTrue(OccupancyReleasePolicy.shouldRelease(trigger: .background, isLive: false))
        XCTAssertTrue(OccupancyReleasePolicy.shouldRelease(trigger: .terminate, isLive: false))
        XCTAssertEqual(
            OccupancyReleasePolicy.ownedIDs(
                mediaCallID: callID, ownedCallSessions: [:], currentSessionIdentity: identity
            ).map { _ in ReliableCallEndConstraint.currentSessionOwner },
            [.currentSessionOwner]
        )
    }

    func testOccupancyReleaseKeepsLiveCallKitOrConnectingConnectedInBackground() {
        XCTAssertTrue(OccupancyReleasePolicy.isLive(activeCallIDs: ["call-kit"], media: .idle))
        XCTAssertTrue(OccupancyReleasePolicy.isLive(activeCallIDs: [], media: .connecting))
        XCTAssertTrue(OccupancyReleasePolicy.isLive(activeCallIDs: [], media: .connected))
        XCTAssertFalse(OccupancyReleasePolicy.shouldRelease(
            trigger: .background, isLive: true, media: .idle, hasCallKit: true
        ))
        XCTAssertTrue(OccupancyReleasePolicy.shouldRelease(
            trigger: .background, isLive: true, media: .connecting, hasCallKit: false
        ))
        XCTAssertFalse(OccupancyReleasePolicy.shouldRelease(
            trigger: .background, isLive: true, media: .connected, hasCallKit: false
        ))
        XCTAssertTrue(OccupancyReleasePolicy.shouldRelease(trigger: .terminate, isLive: true))
    }

    func testOccupancyReleaseDoesNotEndOfferedOnlyAndTerminateStillEndsOwnedOutbound() {
        let identity = UUID()
        XCTAssertTrue(
            OccupancyReleasePolicy.ownedIDs(
                mediaCallID: nil, ownedCallSessions: [:], currentSessionIdentity: identity
            ).isEmpty
        )
        let outbound = "00000000-0000-4000-8000-000000000009"
        XCTAssertEqual(
            OccupancyReleasePolicy.ownedIDs(
                mediaCallID: outbound, ownedCallSessions: [:], currentSessionIdentity: identity
            ),
            [outbound]
        )
        XCTAssertTrue(OccupancyReleasePolicy.shouldRelease(trigger: .terminate, isLive: true))
    }

    func testBlocklistPostOmitsUnsetSourceCallAndDeleteUsesIdPath() async throws {
        let created = expectation(description: "blocklist create")
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/blocklist")
            let object = try JSONSerialization.jsonObject(with: try XCTUnwrap(requestBody(request))) as? [String: Any]
            XCTAssertEqual(object?["remoteNumber"] as? String, "+12025550102")
            XCTAssertNil(object?["sourceCallId"])
            XCTAssertNil(object?["scope"], "an unstated scope stays off the wire (server default = call)")
            created.fulfill()
            return (201, #"{"item":{"id":"00000000-0000-4000-8000-000000000010","remoteNumber":"+12025550102","createdAt":"2026-09-09T00:00:00Z"}}"#)
        }
        let createdItem: BlocklistItemEnvelope = try await APIClient(token: "access", session: mockSession()).request(
            "blocklist", method: "POST",
            body: BlocklistCreateBody(remoteNumber: "+12025550102", sourceCallId: nil)
        )
        XCTAssertEqual(createdItem.item.id, "00000000-0000-4000-8000-000000000010")
        await fulfillment(of: [created], timeout: 1)

        let id = "00000000-0000-4000-8000-000000000010"
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/api/v1/blocklist/\(id)")
            XCTAssertNil(request.httpBody)
            return (204, "")
        }
        let _: EmptyResponse = try await APIClient(token: "access", session: mockSession())
            .request("blocklist/\(id)", method: "DELETE")
    }

    func testBlocklistPostIncludesSourceCallIdWhenPresent() async throws {
        MockURLProtocol.handler = { request in
            let body = try JSONDecoder().decode(BlocklistCreateBody.self, from: try XCTUnwrap(requestBody(request)))
            XCTAssertEqual(body.remoteNumber, "2025550102")
            XCTAssertEqual(body.sourceCallId, "00000000-0000-4000-8000-000000000001")
            return (200, #"{"item":{"id":"b1","remoteNumber":"2025550102","createdAt":"2026-09-09T00:00:00Z","sourceCallId":"00000000-0000-4000-8000-000000000001"}}"#)
        }
        let result: BlocklistItemEnvelope = try await APIClient(token: "access", session: mockSession()).request(
            "blocklist", method: "POST",
            body: BlocklistCreateBody(remoteNumber: "2025550102", sourceCallId: "00000000-0000-4000-8000-000000000001")
        )
        XCTAssertEqual(result.item.sourceCallId, "00000000-0000-4000-8000-000000000001")
    }

    func testS66BlocklistScopeOnCreateBodyAndListQuery() async throws {
        let encoder = JSONEncoder()
        let sms = try JSONSerialization.jsonObject(
            with: encoder.encode(BlocklistCreateBody(remoteNumber: "95559", sourceCallId: nil, scope: .sms))
        ) as? [String: Any]
        XCTAssertEqual(sms?["scope"] as? String, "sms")
        let call = try JSONSerialization.jsonObject(
            with: encoder.encode(BlocklistCreateBody(remoteNumber: "2025550102", sourceCallId: "c1", scope: .call))
        ) as? [String: Any]
        XCTAssertEqual(call?["scope"] as? String, "call")

        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/blocklist")
            XCTAssertEqual(request.url?.query, "scope=sms")
            return (200, #"{"items":[{"id":"b1","remoteNumber":"95559","createdAt":"t","scope":"sms"}]}"#)
        }
        let list: ItemEnvelope<BlocklistItem> = try await APIClient(token: "access", session: mockSession())
            .request("blocklist", queryItems: BlocklistScope.sms.queryItems)
        XCTAssertEqual(list.items.first?.scope, "sms")
    }

    func testPasskeyDeleteEncodesBase64URLIdAndEmpty204() async throws {
        let id = "abc-_def"
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/api/v1/passkeys/\(id)")
            return (204, "")
        }
        let _: EmptyResponse = try await APIClient(token: "access", session: mockSession())
            .request("passkeys/\(id)", method: "DELETE")
    }

    /// S30 §1.1: `DELETE /api/v1/calls/:id`, no body, no idempotency key, and a 204 with an empty payload that
    /// must still decode rather than fail the delete the user already watched happen.
    func testCallDeleteIsABodylessDeleteOnTheIdPathWithEmpty204() async throws {
        let id = "00000000-0000-4000-8000-000000000042"
        let sent = expectation(description: "call delete")
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/api/v1/calls/\(id)")
            XCTAssertNil(request.url?.query)
            XCTAssertNil(requestBody(request))
            XCTAssertNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access")
            sent.fulfill()
            return (204, "")
        }
        let _: EmptyResponse = try await APIClient(token: "access", session: mockSession())
            .request("calls/\(id)", method: "DELETE")
        await fulfillment(of: [sent], timeout: 1)
    }

    /// The 409 the in-use predicate answers keeps its code, which is what `RecordDeletePolicy` reads.
    func testCallDeleteSurfacesCallInUse409WithItsCode() async throws {
        MockURLProtocol.handler = { _ in
            (409, #"{"error":{"code":"CALL_IN_USE","message":"call is in use"}}"#)
        }
        do {
            let _: EmptyResponse = try await APIClient(token: "access", session: mockSession())
                .request("calls/00000000-0000-4000-8000-000000000042", method: "DELETE")
            XCTFail("A 409 must not decode as success")
        } catch let error as APIError {
            guard case let .server(status, _, code) = error else { return XCTFail("Unexpected \(error)") }
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "CALL_IN_USE")
            XCTAssertEqual(RecordDeletePolicy.errorMessage(error), RecordDeletePolicy.inUseMessage)
        }
    }

    /// S30 §1.2: `POST /api/v1/sms/delete {ids}` → `{deleted, skipped:[{id, reason}]}`.
    func testSMSDeletePostsTheIdListAndDecodesSkippedInFlight() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/sms/delete")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try JSONDecoder().decode(SMSDeleteBody.self, from: try XCTUnwrap(requestBody(request)))
            XCTAssertEqual(body.ids, ["m1", "m2", "m3"])
            let object = try JSONSerialization.jsonObject(with: try XCTUnwrap(requestBody(request))) as? [String: Any]
            XCTAssertEqual(object?.keys.sorted(), ["ids"])
            return (200, #"{"deleted":2,"skipped":[{"id":"m2","reason":"in_flight"}]}"#)
        }
        let result: SMSDeleteResponse = try await APIClient(token: "access", session: mockSession()).request(
            "sms/delete", method: "POST", body: SMSDeleteBody(ids: ["m1", "m2", "m3"])
        )
        XCTAssertEqual(result.deleted, 2)
        XCTAssertEqual(result.skipped, [SMSDeleteSkip(id: "m2", reason: "in_flight")])
        XCTAssertEqual(MessageSelectionPolicy.acceptedIDs(requested: ["m1", "m2", "m3"], skipped: result.skipped), ["m1", "m3"])

        // A server that answers a bare object must not fail a delete that already happened.
        MockURLProtocol.handler = { _ in (200, "{}") }
        let bare: SMSDeleteResponse = try await APIClient(token: "access", session: mockSession()).request(
            "sms/delete", method: "POST", body: SMSDeleteBody(ids: ["m1"])
        )
        XCTAssertEqual(bare, SMSDeleteResponse(deleted: 0, skipped: []))
    }

    /// S30 §1.3: `POST /api/v1/sms/threads/delete {simId, conversationAddress}`. The client sends the thread's
    /// `conversationAddress ?? remoteNumber`; the server normalises both sides.
    func testSMSThreadDeletePostsSimIdAndConversationAddressOnly() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/sms/threads/delete")
            let object = try JSONSerialization.jsonObject(with: try XCTUnwrap(requestBody(request))) as? [String: Any]
            XCTAssertEqual(object?["simId"] as? String, "sim-a")
            XCTAssertEqual(object?["conversationAddress"] as? String, "+12025550102")
            XCTAssertEqual(object?.keys.sorted(), ["conversationAddress", "simId"])
            return (200, #"{"deleted":4,"skipped":[]}"#)
        }
        let messages = try JSONDecoder().decode(
            ItemEnvelope<SMSMessage>.self,
            from: Data(#"{"items":[{"id":"m1","simId":"sim-a","remoteNumber":"2025550102","conversationAddress":"+12025550102","direction":"incoming","body":"x","createdAt":"2026-09-13T00:00:00Z"}]}"#.utf8)
        ).items
        let thread = try XCTUnwrap(MessageConversation.grouped(messages, selectedSIMID: "sim-a").first)
        let result: SMSDeleteResponse = try await APIClient(token: "access", session: mockSession()).request(
            "sms/threads/delete", method: "POST",
            body: SMSThreadDeleteBody(simId: thread.id.simID, conversationAddress: thread.threadAddress)
        )
        XCTAssertEqual(result.deleted, 4)
        XCTAssertTrue(result.skipped.isEmpty)
    }

    func testComposePrefillUsesInitialNumberOverDraft() {
        XCTAssertEqual(
            ComposeMessagePrefillPolicy.number(initialNumber: "2025550102", draftNumber: "10086"),
            "2025550102"
        )
        XCTAssertEqual(
            ComposeMessagePrefillPolicy.number(initialNumber: "", draftNumber: "10086"),
            ""
        )
        XCTAssertEqual(
            ComposeMessagePrefillPolicy.number(initialNumber: nil, draftNumber: "10086"),
            ""
        )
    }

    @MainActor
    func testRedialReusesOutboundIdempotencyFingerprint() {
        let suite = "VoDogTests.redial-fingerprint.\(UUID().uuidString)"
        let defaults = try! XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let store = OutboundCallIdempotencyStore(defaults: defaults, storageKey: "pending")
        let payload = OutboundCallPayload(simId: "sim-a", remoteNumber: "+12025550102")
        let first = store.key(accountID: "account-a", payload: payload)
        let redial = OutboundCallPayload(
            simId: "sim-a", remoteNumber: PhoneNumberText.normalized("+1 202-555-0102")
        )
        XCTAssertEqual(store.key(accountID: "account-a", payload: redial), first)
        XCTAssertNotEqual(store.key(accountID: "account-a", payload: .init(simId: "sim-b", remoteNumber: payload.remoteNumber)), first)
        defaults.removePersistentDomain(forName: suite)
    }

    func testProductionKeychainRoundTrip() throws {
        let credentials = StoredCredentials(token: "access", refreshToken: "refresh", expiresAt: "2026-09-09T01:00:00Z",
            user: .init(id: "u1", username: "tester@example.com", role: "user"))
        try Keychain.delete()
        try Keychain.save(credentials)
        XCTAssertEqual(try Keychain.load()?.refreshToken, "refresh")
        try Keychain.delete()
        XCTAssertNil(try Keychain.load())
    }

    @MainActor
    func testConcurrentUnauthorizedRequestsShareOneRefreshRotation() async throws {
        let credentials = MemoryCredentialStore(.init(token: "expired-access", refreshToken: String(repeating: "r", count: 24), expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")))
        let server = RefreshRaceServer()
        MockURLProtocol.handler = server.respond
        let store = SessionStore(networkSession: mockSession(), credentialStore: credentials)
        try store.acceptLogin(.init(token: "expired-access", refreshToken: String(repeating: "r", count: 24), expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")))
        let loginIdentity = try XCTUnwrap(store.sessionIdentity)
        async let first: MeResponse = store.request("auth/me")
        async let second: MeResponse = store.request("auth/me")
        let values = try await (first, second)
        XCTAssertEqual(values.0.user.id, "u1")
        XCTAssertEqual(values.1.user.id, "u1")
        XCTAssertEqual(server.refreshCount, 1)
        XCTAssertEqual(store.token, "new-access")
        XCTAssertEqual(store.sessionIdentity, loginIdentity, "Access-token refresh must preserve the login generation")
        XCTAssertEqual(try credentials.load()?.refreshToken, "new-refresh")
    }

    @MainActor
    func testRestoreKeepsCredentialsOnNetworkFailure() async throws {
        let credentials = MemoryCredentialStore(.init(token: "access", refreshToken: "refresh", expiresAt: nil,
            user: .init(id: "u1", username: "tester@example.com", role: "user")))
        MockURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        let store = SessionStore(networkSession: mockSession(), credentialStore: credentials)
        await store.restore()
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertNotNil(try credentials.load())
    }

    @MainActor
    func testRequestFromPreviousLoginCannotUseReplacementSession() async throws {
        let credentials = MemoryCredentialStore(nil)
        let requests = RequestCounter()
        MockURLProtocol.handler = requests.respond
        let store = SessionStore(networkSession: mockSession(), credentialStore: credentials)
        try store.acceptLogin(.init(token: "old-access", refreshToken: "old-refresh", expiresAt: nil,
            user: .init(id: "u1", username: "one@example.com", role: "user")))
        let oldIdentity = try XCTUnwrap(store.sessionIdentity)
        try store.acceptLogin(.init(token: "new-access", refreshToken: "new-refresh", expiresAt: nil,
            user: .init(id: "u1", username: "one@example.com", role: "user")))
        XCTAssertNotEqual(store.sessionIdentity, oldIdentity, "A fresh login must rotate generation even for the same account")

        do {
            let _: MeResponse = try await store.request("auth/me", requiredSessionIdentity: oldIdentity)
            XCTFail("A stale call operation must not run with replacement credentials")
        } catch SessionLifecycleError.staleSession {
            // Expected: rejected before URLSession sees the request.
        }
        do {
            _ = try await store.download("calls/call-1/recordings/remote_original", requiredSessionIdentity: oldIdentity)
            XCTFail("A stale recording operation must not download with replacement credentials")
        } catch SessionLifecycleError.staleSession {
            // Expected: rejected before URLSession sees the download request.
        }
        XCTAssertEqual(requests.count, 0)
    }

    @MainActor
    func testRecordingDownloadedAfterReloginIsDeletedAndRejected() async throws {
        let store = SessionStore(networkSession: mockSession(), credentialStore: MemoryCredentialStore(nil))
        try store.acceptLogin(.init(token: "old-access", refreshToken: "old-refresh", expiresAt: nil,
            user: .init(id: "u1", username: "one@example.com", role: "user")))
        let oldIdentity = try XCTUnwrap(store.sessionIdentity)
        let temporaryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("vodog-recording-\(UUID().uuidString).wav")
        try Data(repeating: 0, count: 44).write(to: temporaryURL)
        try store.acceptLogin(.init(token: "new-access", refreshToken: "new-refresh", expiresAt: nil,
            user: .init(id: "u1", username: "one@example.com", role: "user")))
        let completed = DownloadedFile(url: temporaryURL, contentType: "audio/wav", contentLength: 44,
                                       etag: nil, acceptRanges: nil, contentRange: nil, statusCode: 200,
                                       contentDisposition: nil)
        do { _ = try store.validateDownloadedFile(completed, requiredSessionIdentity: oldIdentity); XCTFail("A completed old-session download must be rejected") }
        catch SessionLifecycleError.staleSession { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporaryURL.path))
    }

    @MainActor
    func testSMSIdempotencyKeyPersistsPerAccountAndPayloadUntilConfirmed() throws {
        let suiteName = "VoDogTests.sms-idempotency.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let storageKey = "pending"
        let payload = SMSOutboundPayload(simId: "sim-1", remoteNumber: "+12025550120", body: "private body")

        let firstStore = SMSIdempotencyStore(defaults: defaults, storageKey: storageKey)
        let first = try firstStore.key(accountID: "account-a", payload: payload)
        let afterRestart = SMSIdempotencyStore(defaults: defaults, storageKey: storageKey)
        XCTAssertEqual(try afterRestart.key(accountID: "account-a", payload: payload), first)
        XCTAssertNotEqual(try afterRestart.key(accountID: "account-b", payload: payload), first)

        let persisted = try XCTUnwrap(defaults.data(forKey: storageKey))
        let persistedText = String(decoding: persisted, as: UTF8.self)
        XCTAssertFalse(persistedText.contains(payload.remoteNumber))
        XCTAssertFalse(persistedText.contains(payload.body))
        XCTAssertFalse(persistedText.contains("account-a"))

        afterRestart.markSucceeded(accountID: "account-a", payload: payload, idempotencyKey: first)
        let afterConfirmation = SMSIdempotencyStore(defaults: defaults, storageKey: storageKey)
        XCTAssertNotEqual(try afterConfirmation.key(accountID: "account-a", payload: payload), first)
    }

    // MARK: - S36

    /// C2: one tap is one request carrying exactly one digit — no accumulated buffer, no key sequence.
    func testInCallDTMFSendsOneDigitPerRequest() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/calls/call-1/dtmf")
            XCTAssertEqual(
                requestBody(request).map { String(decoding: $0, as: UTF8.self) }, ##"{"digits":"#"}"##
            )
            return (200, #"{"ok":true,"commandId":"11111111-1111-4111-8111-111111111111"}"#)
        }
        // Control answers `{ok, commandId}`; the client needs neither, so the reply stays untyped.
        let _: EmptyResponse = try await APIClient(token: "access", session: mockSession())
            .request("calls/call-1/dtmf", method: "POST", body: ["digits": "#"], timeoutInterval: 4)
    }

    /// C3: what a `diag/events` batch looks like on the wire, and that the ring cannot grow past its cap.
    func testDiagEventEncodesScalarFieldsAndDropsEverythingElse() throws {
        let event = DiagEvent(
            ts: "2026-09-17T10:00:00.000Z", level: "error", event: "media.failed",
            callId: "00000000-0000-4000-8000-000000000001",
            fields: ["seq": .int(3), "ms": .int(1200), "ok": .bool(false), "state": .string("failed")]
        )
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        XCTAssertEqual(
            String(decoding: try encoder.encode([event]), as: UTF8.self),
            #"[{"callId":"00000000-0000-4000-8000-000000000001","event":"media.failed","fields":{"ms":1200,"ok":false,"seq":3,"state":"failed"},"level":"error","ts":"2026-09-17T10:00:00.000Z"}]"#
        )
        XCTAssertEqual(DiagValue(true, limit: 8), .bool(true))
        XCTAssertEqual(DiagValue(7, limit: 8), .int(7))
        XCTAssertEqual(DiagValue("0123456789", limit: 8), .string("01234567"))
        XCTAssertEqual(DiagValue(["nested": 1, "drop": [1]], limit: 8), .object(["nested": .int(1)]))
        XCTAssertNil(DiagValue([1], limit: 8))
        let object = DiagValue.object(["rx": .object(["jitterMs": .double(1.5), "packetsLost": .int(2)])])
        XCTAssertEqual(try JSONDecoder().decode(DiagValue.self, from: JSONEncoder().encode(object)), object)
    }

    /// S36b D1: the device context and the per-flush snapshot, built from injected readings so the wire shape
    /// is pinned on any host. A reading the device could not take is an absent key, never a zero.
    func testDiagContextAndSnapshotCarryTheDeviceSituation() throws {
        let context = Diag.contextFields(
            osVersion: "17.5", deviceModel: "iPhone16,1", appVersion: "1.4.0", appBuild: "42",
            locale: "zh_CN", timeZone: "Asia/Shanghai", pushRegistered: true, micPermission: "granted",
            notificationPermission: "denied", installId: "00000000-0000-4000-8000-000000000023"
        )
        XCTAssertEqual(Diag.encode(context, limit: 200), [
            "platform": .string("ios"), "osVersion": .string("17.5"), "deviceModel": .string("iPhone16,1"),
            "appVersion": .string("1.4.0"), "appBuild": .string("42"), "locale": .string("zh_CN"),
            "timeZone": .string("Asia/Shanghai"), "pushRegistered": .bool(true),
            "micPermission": .string("granted"), "notificationPermission": .string("denied"),
            "installId": .string("00000000-0000-4000-8000-000000000023")
        ])

        var snapshot = DiagSnapshot()
        snapshot.batteryLevel = 12
        snapshot.batteryState = "unplugged"
        snapshot.lowPower = true
        snapshot.thermal = "serious"
        snapshot.networkType = "cellular"
        snapshot.expensive = true
        snapshot.radio = "LTE"
        snapshot.cellularData = "notRestricted"
        snapshot.outputs = "Speaker"
        snapshot.inputs = "MicrophoneBuiltIn"
        snapshot.ip = "pdp_ip0/ipv4"
        snapshot.nativeCalls = 1
        snapshot.nativeCallConnected = true
        snapshot.nativeCallOutgoing = false
        snapshot.appState = "bg"
        snapshot.inCall = true
        snapshot.mediaState = "connected(tls)"
        snapshot.memoryMB = 88
        snapshot.uptimeS = 610
        snapshot.seqDropped = 3
        XCTAssertEqual(Diag.encode(snapshot.fields, limit: 200), [
            "battery": .int(12), "batteryState": .string("unplugged"), "lowPower": .bool(true),
            "thermal": .string("serious"), "netType": .string("cellular"), "netExpensive": .bool(true),
            "netConstrained": .bool(false), "radio": .string("LTE"),
            "cellularData": .string("notRestricted"), "outputs": .string("Speaker"),
            "inputs": .string("MicrophoneBuiltIn"), "ip": .string("pdp_ip0/ipv4"), "nativeCalls": .int(1),
            "nativeCallConnected": .bool(true), "nativeCallOutgoing": .bool(false),
            "appState": .string("bg"), "inCall": .bool(true), "mediaState": .string("connected(tls)"),
            "memoryMB": .int(88), "uptimeS": .int(610), "seqDropped": .int(3)
        ])
        // Nothing readable: the optional collectors leave their fields out instead of reporting a zero.
        let blank = DiagSnapshot().fields
        for key in ["battery", "batteryState", "radio", "cellularData", "ip", "memoryMB", "outputs"] {
            XCTAssertNil(blank[key], key)
        }
    }

    /// S36b D1: a flush that fails spools the ring as JSON lines and the next one reads it back; a torn tail
    /// costs its own line and nothing else.
    func testDiagSpoolRoundTripsEventsAndSkipsTornLines() throws {
        let events = [
            DiagEvent(
                ts: "2026-09-17T10:00:00.000Z", level: "info", event: "client.snapshot", callId: nil,
                fields: ["seq": .int(1), "battery": .int(42), "lowPower": .bool(true),
                         "rtt": .double(3.5), "mediaState": .string("idle")]
            ),
            DiagEvent(
                ts: "2026-09-17T10:00:01.000Z", level: "error", event: "app.crash",
                callId: "00000000-0000-4000-8000-000000000001",
                fields: ["stack": .string("0 VoDog 0x0 | 1 UIKitCore 0x0")]
            )
        ]
        let spool = Diag.encodeSpool(events)
        XCTAssertEqual(spool.split(separator: 0x0a).count, 2)
        XCTAssertEqual(Diag.decodeSpool(spool), events)
        var torn = spool
        torn.append(contentsOf: Data(#"{"ts":"2026-09-17T10:00:02.000Z","le"#.utf8))
        XCTAssertEqual(Diag.decodeSpool(torn), events)
        XCTAssertEqual(Diag.decodeSpool(nil), [])
    }

    /// S36b D1: every batch names the platform and the install, so one device stays one timeline across logins.
    func testDiagBatchCarriesSourceAndInstallHeaders() async throws {
        let installId = "00000000-0000-4000-8000-000000000023"
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/diag/events")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Diag-Source"), "ios")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Diag-Install"), installId)
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Diag-Sent-At").flatMap { Int64($0) })
            return (200, #"{"accepted":1}"#)
        }
        let batch = [DiagEvent(
            ts: "2026-09-17T10:00:00.000Z", level: "info", event: "client.context", callId: nil,
            fields: ["seq": .int(1)]
        )]
        let _: EmptyResponse = try await APIClient(token: "access", session: mockSession()).request(
            "diag/events", method: "POST", body: batch, timeoutInterval: 8,
            headers: Diag.headers(installId: installId)
        )
        // No install id yet (the very first events of a fresh launch): the header is omitted, not empty.
        XCTAssertEqual(
            Diag.headers(installId: "", sentAtMs: 1_790_000_000_000),
            ["X-Diag-Source": "ios", "X-Diag-Sent-At": "1790000000000"]
        )
        // S75: stamped at send time, not at batch creation.
        let before = Int64(Date().timeIntervalSince1970 * 1000)
        let sentAt = Int64(Diag.headers(installId: installId)["X-Diag-Sent-At"] ?? "") ?? 0
        XCTAssertGreaterThanOrEqual(sentAt, before)
    }

    /// URLSession's -999 is a refresh loop replacing its own request, not a failure; real transport errors stay.
    func testCancelledRequestsAreNotLoggedAsAPIErrors() {
        XCTAssertFalse(Diag.shouldLogAPIFailure(path: "calls", error: URLError(.cancelled)))
        XCTAssertFalse(Diag.shouldLogAPIFailure(
            path: "calls", error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        ))
        XCTAssertFalse(Diag.shouldLogAPIFailure(path: "calls", error: CancellationError()))
        XCTAssertFalse(Diag.shouldLogAPIFailure(path: "diag/events", error: URLError(.timedOut)))
        XCTAssertTrue(Diag.shouldLogAPIFailure(path: "calls", error: URLError(.timedOut)))
        XCTAssertTrue(Diag.shouldLogAPIFailure(path: "calls", error: APIError.server(500, "", nil)))
    }

    /// S69: one api.error per (id-stripped route, code) per 60 s, the rest counted in `repeat`; stamped with the
    /// app version; always warn.
    func testAPIFailuresCoalesceWithinSixtySecondsPerRouteAndCode() {
        let marker = UUID().uuidString.lowercased()
        let path = "s69test-\(marker)/\(UUID().uuidString)/items"
        let start = Date()
        Diag.shared.logAPIFailure(path: path, error: URLError(.timedOut), ms: 812, now: start)
        Diag.shared.logAPIFailure(
            path: "s69test-\(marker)/\(UUID().uuidString)/items", error: URLError(.timedOut), now: start + 30
        )
        Diag.shared.logAPIFailure(path: path, error: APIError.server(502, "", nil), now: start + 31)
        Diag.shared.logAPIFailure(path: path, error: URLError(.timedOut), now: start + 61)
        let events = Diag.shared.bufferedEvents().filter {
            $0.event == "api.error" && ($0.fields["path"].map { "\($0)" } ?? "").contains(marker)
        }
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events[0].fields["repeat"], .int(2))
        XCTAssertEqual(events[0].fields["code"], .int(0))
        XCTAssertEqual(events[0].fields["errorType"], .string("timeout"))
        XCTAssertEqual(events[0].fields["ms"], .int(812))
        XCTAssertEqual(events[0].level, "warn")
        XCTAssertEqual(events[0].appVersion, Diag.appVersion)
        XCTAssertTrue(Diag.appVersion.hasSuffix(")"))
        XCTAssertEqual(events[1].fields["code"], .int(502))
        XCTAssertNil(events[1].fields["repeat"])
        XCTAssertNil(events[2].fields["repeat"])
    }

    /// S69: a repeat whose row already left the ring is carried onto the key's next row.
    func testCoalescerCarriesRepeatsWhoseRowWasAlreadyUploaded() {
        var coalescer = DiagCoalescer()
        let start = Date()
        XCTAssertNil(coalescer.openSeq(for: "k", now: start))
        XCTAssertEqual(coalescer.open("k", seq: 7, now: start), 1)
        XCTAssertEqual(coalescer.openSeq(for: "k", now: start + 59), 7)
        XCTAssertNil(coalescer.openSeq(for: "other", now: start + 1))
        coalescer.carry("k")
        coalescer.carry("k")
        XCTAssertNil(coalescer.openSeq(for: "k", now: start + 60))
        XCTAssertEqual(coalescer.open("k", seq: 9, now: start + 60), 3)
        XCTAssertEqual(coalescer.open("k", seq: 10, now: start + 200), 1)
    }

    func testDiagLevelRuleAndRouteTemplate() {
        XCTAssertEqual(Diag.level(for: "api.error"), "warn")
        XCTAssertEqual(Diag.level(for: "ui.error_shown"), "warn")
        XCTAssertEqual(Diag.level(for: "audio.session", fields: ["ok": .bool(false)]), "warn")
        XCTAssertEqual(Diag.level(for: "audio.session", fields: ["ok": .bool(true)]), "info")
        XCTAssertEqual(Diag.level(for: "media.failed", fields: ["ok": .bool(false)]), "error")
        XCTAssertEqual(Diag.level(for: "callkit.action_failed"), "error")
        XCTAssertEqual(Diag.level(for: "app.error"), "error")
        XCTAssertEqual(Diag.level(for: "media.summary"), "info")
        XCTAssertEqual(
            Diag.pathTemplate("calls/0B9E7C2A-1F55-4B8E-9C3D-5E2F1A6B7C8D/media/offer"), "calls/:id/media/offer"
        )
        XCTAssertEqual(Diag.pathTemplate("sms/12345?limit=5"), "sms/:id")
        XCTAssertEqual(Diag.pathTemplate("contacts/+12025550102"), "contacts/:id")
        XCTAssertEqual(Diag.pathTemplate("sms"), "sms")
        XCTAssertEqual(Diag.networkErrorType(URLError(.notConnectedToInternet) as NSError), "offline")
        XCTAssertEqual(Diag.networkErrorType(URLError(.cannotFindHost) as NSError), "dns")
        XCTAssertEqual(Diag.networkErrorType(URLError(.serverCertificateUntrusted) as NSError), "tls")
    }

    /// S69: push registration retries back off 5 s → 5 min instead of hammering every 5 s.
    @MainActor func testPushSyncRetryBacksOffExponentiallyToFiveMinutes() {
        XCTAssertEqual(
            (0...8).map { PushRegistrationManager.retryDelay(attempt: $0) },
            [5, 10, 20, 40, 80, 160, 300, 300, 300].map { Duration.seconds($0) }
        )
    }

    /// S69: Control's 200 `{enabled:false}` stops quality probing instead of failing the decode.
    func testQualityProbeOptionsDisabledReplyDecodes() throws {
        let reply = try JSONDecoder().decode(
            MediaQualityProbeOptionsReply.self, from: Data(#"{"enabled":false,"retryAfterMs":3600000}"#.utf8)
        )
        guard case .disabled(3_600_000) = reply else { return XCTFail("\(reply)") }
    }

    func testKilledMarkerOnlyForAnUncleanRecentRun() {
        XCTAssertEqual(Diag.killedLastAliveAgo(cleanShutdown: false, lastAlive: 1_000, now: 1_090), 90)
        XCTAssertNil(Diag.killedLastAliveAgo(cleanShutdown: true, lastAlive: 1_000, now: 1_090))
        XCTAssertNil(Diag.killedLastAliveAgo(cleanShutdown: false, lastAlive: nil, now: 1_090))
        XCTAssertNil(Diag.killedLastAliveAgo(cleanShutdown: false, lastAlive: 1_000, now: 1_000 + 86_400))
        XCTAssertNil(Diag.killedLastAliveAgo(cleanShutdown: false, lastAlive: 2_000, now: 1_000))
    }

    /// C4: an export asks for `format=mp3` and names the file `.mp3`; playback URLs keep the original container.
    func testMP3ExportRequestsTheFormatAndNamesTheFileMP3() async throws {
        let callID = "00000000-0000-4000-8000-000000000001"
        MockURLProtocol.handler = { request in
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(items.first { $0.name == "format" }?.value, "mp3")
            XCTAssertEqual(items.first { $0.name == "disposition" }?.value, "attachment")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "audio/mpeg")
            return (200, "mp3-bytes")
        }
        let file = try await APIClient(token: "access", session: mockSession()).download(
            "calls/\(callID)/recordings/remote_original", disposition: "attachment", format: "mp3"
        )
        defer { try? FileManager.default.removeItem(at: file.url) }
        XCTAssertEqual(file.url.pathExtension, "mp3")
        // Control's own header does not match the `call-…` shape, so the fallback is what names the file.
        XCTAssertEqual(
            RecordingAttachmentName.filename(
                callID: callID, source: .mediaNode, track: "remote_original",
                header: "attachment; filename=\"\(callID)-remote_original.mp3\"", format: "mp3"
            ),
            "call-\(callID)-media_node-remote_original.mp3"
        )
        // An `.ogg` name can never be handed back for an MP3 export, header or not.
        XCTAssertEqual(
            RecordingAttachmentName.filename(
                callID: callID, source: .mediaNode, track: "remote_original",
                header: "attachment; filename=\"call-\(callID)-media_node-remote_original.ogg\"", format: "mp3"
            ),
            "call-\(callID)-media_node-remote_original.mp3"
        )
    }

    /// C4: the paired download is the server-side `conversation` mix — an accepted track name, with a usable fallback.
    func testConversationMixIsAnAllowedTrackNameAndFallsBackToTheCallScopedName() throws {
        let callID = "00000000-0000-4000-8000-000000000001"
        // Control names the mix `<callId>-conversation.mp3`, which is not the `call-…` shape, so the fallback names it.
        XCTAssertEqual(
            RecordingAttachmentName.filename(
                callID: callID, source: .mediaNode, track: "conversation",
                header: "attachment; filename=\"\(callID)-conversation.mp3\"", format: "mp3"
            ),
            "call-\(callID)-media_node-conversation.mp3"
        )
        // A header already in the allowed shape is kept — `conversation` is now a recognised track.
        XCTAssertEqual(
            RecordingAttachmentName.filename(
                callID: callID, source: .pixel, track: "conversation",
                header: "attachment; filename=\"call-\(callID)-pixel-conversation.mp3\"", format: "mp3"
            ),
            "call-\(callID)-pixel-conversation.mp3"
        )
    }

    /// C5-b: which SIM a 拨打 from a contact or a record dials on, before the confirmation states it.
    func testConfirmedDialResolvesRequestedThenSelectedThenPreferredSIM() throws {
        let sims = try JSONDecoder().decode(
            ItemEnvelope<SIMChannel>.self,
            from: Data(#"{"items":[{"id":"off","online":false},{"id":"on","online":true},{"id":"other","online":true}]}"#.utf8)
        ).items
        XCTAssertEqual(SIMSelectionPolicy.dialSIM(requested: "other", current: "on", sims: sims), "other")
        // A record naming a SIM this account no longer has falls back to what the dialer already shows.
        XCTAssertEqual(SIMSelectionPolicy.dialSIM(requested: "gone", current: "on", sims: sims), "on")
        XCTAssertEqual(SIMSelectionPolicy.dialSIM(requested: nil, current: nil, sims: sims), "on")
        XCTAssertNil(SIMSelectionPolicy.dialSIM(requested: "any", current: nil, sims: []))
    }

    private func mockSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

}

private struct TestCallEnvelope: Decodable { let call: CallRecord }

private func requestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        guard count >= 0 else { return nil }
        if count == 0 { break }
        result.append(buffer, count: count)
    }
    return result
}

private final class MemoryLastLoginStore: LastLoginStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var value: LastLoginCredentials?
    init(_ value: LastLoginCredentials? = nil) { self.value = value }
    func save(_ value: LastLoginCredentials) throws { lock.withLock { self.value = value } }
    func load() throws -> LastLoginCredentials? { lock.withLock { value } }
    func delete() throws { lock.withLock { value = nil } }
}

private final class MemoryCredentialStore: CredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var value: StoredCredentials?
    init(_ value: StoredCredentials?) { self.value = value }
    func save(_ value: StoredCredentials) throws { lock.withLock { self.value = value } }
    func load() throws -> StoredCredentials? { lock.withLock { value } }
    func delete() throws { lock.withLock { value = nil } }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0
    var value: Int { lock.withLock { storage } }
    func increment() { lock.withLock { storage += 1 } }
    func reset() { lock.withLock { storage = 0 } }
}

private final class LockedBox<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value?
    var value: Value? { lock.withLock { storage } }
    func set(_ value: Value) { lock.withLock { storage = value } }
}

@MainActor
private final class ProbeLifecycleSpy: MediaProbeLifecycleManaging {
    private(set) var cancelCount = 0
    private(set) var invalidateCount = 0
    func cancelInFlight() { cancelCount += 1 }
    func invalidateEvidence() { invalidateCount += 1 }
}

private final class FixedMediaNetworkGeneration: MediaNetworkGenerationProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: String
    init(_ value: String) { storage = value }
    var value: String {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
    func currentGeneration() -> String { value }
}

private final class ProbeContractServer: @unchecked Sendable {
    private let lock = NSLock()
    private var storedGrants: [String] = []
    private var didSubmit = false
    private var validProbeShape = true
    private var storedOptionsGeneration: String?
    private var storedResultSamples: [MediaProbeSample] = []
    private var storedQualityOptionsGeneration: String?
    private var qualityResultsRequestCount = 0
    private let generation: FixedMediaNetworkGeneration
    private let changeGenerationAfterProbes: Bool

    init(generation: FixedMediaNetworkGeneration, changeGenerationAfterProbes: Bool) {
        self.generation = generation
        self.changeGenerationAfterProbes = changeGenerationAfterProbes
    }

    var grants: [String] { lock.withLock { storedGrants } }
    var submitted: Bool { lock.withLock { didSubmit } }
    var probesHadEmptyBodyAndNoContentType: Bool { lock.withLock { validProbeShape } }
    var optionsGeneration: String? { lock.withLock { storedOptionsGeneration } }
    var resultSamples: [MediaProbeSample] { lock.withLock { storedResultSamples } }
    var qualityOptionsGeneration: String? { lock.withLock { storedQualityOptionsGeneration } }
    var qualityResultsRequests: Int { lock.withLock { qualityResultsRequestCount } }

    func respond(_ request: URLRequest) throws -> (Int, String) {
        if request.url?.path.contains("/api/v1/push/registrations/") == true {
            return (200, #"{"registration":{"id":"push-1","installationId":"00000000-0000-4000-8000-000000000001","updatedAt":"2099-01-01T00:00:00Z","apnsEnabled":true,"voipEnabled":true}}"#)
        }
        if request.url?.host == "probe.example.com" {
            let authorization = request.value(forHTTPHeaderField: "Authorization") ?? ""
            let shouldRotate = lock.withLock { () -> Bool in
                validProbeShape = validProbeShape
                    && request.url?.absoluteString == "https://probe.example.com/probe"
                    && request.httpMethod == "POST"
                    && requestBody(request) == nil
                    && request.value(forHTTPHeaderField: "Content-Type") == nil
                storedGrants.append(authorization)
                return changeGenerationAfterProbes && storedGrants.count == 3
            }
            if shouldRotate { generation.value = "network-2" }
            return (200, #"{"ok":true,"nodeId":"control-node"}"#)
        }
        if request.url?.path == "/api/v1/media/probes/options" {
            let body = try JSONDecoder().decode(MediaProbeOptionsRequest.self, from: try requiredBody(request))
            lock.withLock { storedOptionsGeneration = body.networkGeneration }
            return (200, #"{"networkGeneration":"network-1","expiresAt":"2099-01-01T00:00:00.000Z","nodes":[{"nodeId":"control-node","probeUrl":"https://probe.example.com/probe","expiresAt":"2099-01-01T00:00:00.000Z","grants":["g1","g2","g3"]}]}"#)
        }
        if request.url?.path == "/api/v1/media/probes/results" {
            let body = try JSONDecoder().decode(MediaProbeResultsRequest.self, from: try requiredBody(request))
            lock.withLock { didSubmit = true; storedResultSamples = body.samples }
            return (200, #"{"accepted":3,"expiresAt":"2099-01-01T00:00:00.000Z"}"#)
        }
        if request.url?.path == "/api/v1/media/quality-probes/options" {
            let body = try JSONDecoder().decode(MediaProbeOptionsRequest.self, from: try requiredBody(request))
            lock.withLock { storedQualityOptionsGeneration = body.networkGeneration }
            return (503, #"{"error":{"message":"Relay quality probes are not configured"}}"#)
        }
        if request.url?.path == "/api/v1/media/quality-probes/results" {
            lock.withLock { qualityResultsRequestCount += 1 }
            return (500, "")
        }
        return (500, "")
    }

    private func requiredBody(_ request: URLRequest) throws -> Data {
        if let body = requestBody(request) { return body }
        throw URLError(.cannotParseResponse)
    }
}

private final class RefreshRaceServer: @unchecked Sendable {
    private let lock = NSLock()
    private var rotations = 0
    var refreshCount: Int { lock.withLock { rotations } }

    func respond(_ request: URLRequest) throws -> (Int, String) {
        if request.url?.path.hasSuffix("/auth/refresh") == true {
            lock.withLock { rotations += 1 }
            return (200, #"{"token":"new-access","refreshToken":"new-refresh","expiresAt":"2026-09-09T01:00:00Z"}"#)
        }
        if request.value(forHTTPHeaderField: "Authorization") == "Bearer expired-access" {
            return (401, #"{"error":{"code":"UNAUTHENTICATED","message":"expired","requestId":"r1"}}"#)
        }
        return (200, #"{"user":{"id":"u1","username":"tester@example.com","role":"user"}}"#)
    }
}

private final class RequestCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var requests = 0
    var count: Int { lock.withLock { requests } }
    func respond(_ request: URLRequest) throws -> (Int, String) {
        lock.withLock { requests += 1 }
        return (500, "")
    }
}

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, String))?
    nonisolated(unsafe) static var contentType = "application/json"
    nonisolated(unsafe) static var headerFields: [String: String] = [:]
    nonisolated(unsafe) static var responseData: Data?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let result = try Self.handler?(request) ?? (500, "")
            var headers = Self.headerFields; headers["Content-Type"] = Self.contentType
            let response = HTTPURLResponse(url: request.url!, statusCode: result.0, httpVersion: nil, headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Self.responseData ?? Data(result.1.utf8)); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class HangingURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onStart: (@Sendable () -> Void)?
    nonisolated(unsafe) static var onStop: (@Sendable () -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.onStart?() }
    override func stopLoading() { Self.onStop?() }
}

private final class DeferredURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (DeferredURLProtocol) -> Void)?
    nonisolated(unsafe) static var onStop: (@Sendable () -> Void)?
    static let stopCount = LockedCounter()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.handler?(self) }
    override func stopLoading() {
        if request.url?.path.contains("/media/probes/options") == true {
            Self.stopCount.increment()
            Self.onStop?()
        }
    }

    func respond(status: Int, body: String) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
