import CallKit
import Foundation
import Observation
@preconcurrency import PushKit
import UIKit

@MainActor
final class VoDogAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency PKPushRegistryDelegate {
    private var voipRegistry: PKPushRegistry?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        _ = IncomingCallManager.shared
        // S45: start the path monitor at launch, not at the first call. Its reading decides the candidate filter,
        // and a VoIP push can launch the app straight into a call — `.all` is the safe default it starts at, but
        // the Wi-Fi reading should be in before the media handshake asks for it.
        _ = MediaNetworkGenerationSource.shared
        application.registerForRemoteNotifications()
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
        NotificationCenter.default.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                IncomingCallManager.shared.releaseOccupancy(trigger: .terminate)
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushRegistrationManager.shared.updateAPNsToken(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushRegistrationManager.shared.registrationFailed(error) }
    }

    // S20 decision 6: the silent-notification handler existed only for a `call.ended` event. The control service
    // sends exactly one push event, `call.incoming`, over PushKit — so the branch could never run and is removed
    // rather than left as a claim the server does not honour.

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        Task { @MainActor in PushRegistrationManager.shared.updateVoIPToken(pushCredentials.token) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        Task { @MainActor in await PushRegistrationManager.shared.invalidateVoIPToken() }
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else { completion(); return }
        IncomingCallManager.shared.receiveVoIPPush(payload.dictionaryPayload, completion: completion)
    }
}

@MainActor @Observable
final class PushRegistrationManager {
    static let shared = PushRegistrationManager()

    private weak var session: SessionStore?
    private var apnsToken: String?
    private var voipToken: String?
    /// S36b D1: also the diagnostics `installId` — one identity per install across push and `diag_events`.
    let installationID: UUID
    private let defaults = UserDefaults.standard
    private(set) var serverRegistrationSucceeded = false
    private(set) var lastSyncError: String?
    private var retryTask: Task<Void, Never>?
    /// S69: consecutive failed syncs, driving the 5 s → 5 min backoff.
    private var retryAttempt = 0
    private var isSyncing = false
    private var needsSync = false

    var tokenStatus: String {
        switch (apnsToken != nil, voipToken != nil) {
        case (true, true): "系统推送令牌已获取"
        case (true, false), (false, true): "正在获取系统推送令牌"
        case (false, false): "等待系统推送令牌"
        }
    }

    var serverStatus: String {
        if serverRegistrationSucceeded { return "已就绪" }
        if lastSyncError != nil { return "暂不可用，请稍后重试" }
        return "正在设置"
    }

    private(set) var lastIncomingStatus: String

    func recordIncomingStatus(_ value: String) {
        lastIncomingStatus = value
        defaults.set(value, forKey: "push-last-incoming-status")
    }

    private init() {
        lastIncomingStatus = Self.userFacingIncomingStatus(
            UserDefaults.standard.string(forKey: "push-last-incoming-status")
        )
        if let value = UserDefaults.standard.string(forKey: "push-installation-id"), let id = UUID(uuidString: value) {
            installationID = id
        } else {
            let id = UUID()
            installationID = id
            UserDefaults.standard.set(id.uuidString.lowercased(), forKey: "push-installation-id")
        }
        apnsToken = defaults.string(forKey: "push-apns-token")
        voipToken = defaults.string(forKey: "push-voip-token")
    }

    private static func userFacingIncomingStatus(_ stored: String?) -> String {
        switch stored {
        case "VoIP push 已接收": "已收到来电通知"
        case "CallKit 已上报，等待权威对账": "来电已显示，正在确认状态"
        case "来电对账已超时，CallKit 已关闭": "来电状态确认超时，提示已关闭"
        case "权威状态已变化，CallKit 已关闭": "来电状态已变化，提示已关闭"
        case "登录已失效，CallKit 已关闭": "登录已失效，来电提示已关闭"
        case "权威记录不存在或已结束，CallKit 已关闭": "来电已结束，提示已关闭"
        case "权威对账遇到网络错误，保持来电并重试": "网络暂不可用，正在继续确认来电状态"
        case "尚未收到 VoIP 来电", nil: "尚未收到来电通知"
        default: stored ?? "尚未收到来电通知"
        }
    }

    func attach(session: SessionStore) {
        self.session = session
        guard session.isAuthenticated else { return }
        Task { await sync() }
    }

    func updateAPNsToken(_ data: Data) {
        apnsToken = data.hexEncodedString()
        defaults.set(apnsToken, forKey: "push-apns-token")
        Task { await sync() }
    }

    func updateVoIPToken(_ data: Data) {
        Diag.shared.log("push.voip_token", ["action": voipToken == nil ? "registered" : "updated"])
        voipToken = data.hexEncodedString()
        defaults.set(voipToken, forKey: "push-voip-token")
        Task { await sync() }
    }

    func registrationFailed(_ error: Error) {
        // Registration will be retried by the OS. No token is logged; S69 records the error's domain and code.
        serverRegistrationSucceeded = false
        let nsError = error as NSError
        Diag.shared.log("push.apns_failed", ["code": nsError.code, "domain": nsError.domain])
    }

    func invalidateVoIPToken() async {
        Diag.shared.log("push.voip_token", ["action": "invalidated"])
        voipToken = nil
        defaults.removeObject(forKey: "push-voip-token")
        guard let session, session.isAuthenticated else { return }
        await unregister(session: session)
        await sync()
    }

    func sync() async {
        guard let session, session.isAuthenticated, let identity = session.sessionIdentity,
              apnsToken != nil || voipToken != nil else { return }
        guard !isSyncing else { needsSync = true; return }
        isSyncing = true
        defer {
            isSyncing = false
            if needsSync {
                needsSync = false
                Task { await sync() }
            }
        }
        let body = RegistrationBody(
            platform: "ios", bundleId: Bundle.main.bundleIdentifier ?? "org.vodog",
            environment: Self.environment, deviceName: UIDevice.current.name,
            apnsToken: apnsToken, voipToken: voipToken,
            badge: .init(BadgePreferences.push(BadgePreferences.current()))
        )
        do {
            let _: RegistrationEnvelope = try await session.request(
                "push/registrations/\(installationID.uuidString.lowercased())", method: "PUT", body: body,
                requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            serverRegistrationSucceeded = true
            lastSyncError = nil
            retryAttempt = 0
            retryTask?.cancel()
            retryTask = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            serverRegistrationSucceeded = false
            lastSyncError = error.localizedDescription
            scheduleRetry()
        }
    }

    func unregister(session: SessionStore) async {
        retryTask?.cancel()
        retryTask = nil
        retryAttempt = 0
        guard session.isAuthenticated, let sessionIdentity = session.sessionIdentity else { return }
        let _: EmptyResponse? = try? await session.request(
            "push/registrations/\(installationID.uuidString.lowercased())", method: "DELETE",
            timeoutInterval: 5, requiredSessionIdentity: sessionIdentity
        )
        serverRegistrationSucceeded = false
        lastSyncError = nil
    }

    private static var environment: String {
        #if DEBUG
        "development"
        #else
        "production"
        #endif
    }

    /// S69: 5 s, 10 s, 20 s … capped at 5 min, so a Control outage is not hammered every 5 s.
    static func retryDelay(attempt: Int) -> Duration {
        .seconds(min(5 * (1 << min(max(attempt, 0), 6)), 300))
    }

    private func scheduleRetry() {
        guard retryTask == nil else { return }
        let delay = Self.retryDelay(attempt: retryAttempt)
        retryAttempt += 1
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            retryTask = nil
            await sync()
        }
    }

    private struct RegistrationBody: Encodable, Sendable {
        let platform, bundleId, environment, deviceName: String
        let apnsToken, voipToken: String?
        /// S67: which counts Control may push as `aps.badge`.
        let badge: Badge
        struct Badge: Encodable, Sendable {
            let calls, sms: Bool
            init(_ value: (calls: Bool, sms: Bool)) { calls = value.calls; sms = value.sms }
        }
    }
    private struct RegistrationEnvelope: Decodable, Sendable {
        let registration: Registration
        struct Registration: Decodable, Sendable {
            let id, installationId, updatedAt: String
            let apnsEnabled, voipEnabled: Bool
        }
    }
}

@MainActor
final class IncomingCallManager {
    static let shared = IncomingCallManager()
    private static let reconciliationInterval: Duration = .seconds(2)
    private static let maximumReconciliationAttempts = 60
    /// S41 decision 3: how often an answered call asks Control whether the far side is still there.
    private static let remoteEndWatchInterval: Duration = .seconds(3)
    /// S42 decision 5: a push can cold-launch the app, so the busy report waits for the session to be restored
    /// instead of dropping — about ten seconds in total, well inside the life of the CallKit offer.
    private static let ownerBusyAttempts = 5
    private static let ownerBusyRetryInterval: Duration = .seconds(2)
    private weak var session: SessionStore?
    /// Retained for the app's life so one telephony connection serves every push, rather than one per push on
    /// the path that can least afford the work.
    private let callObserver = CXCallObserver()
    private var offeredCalls = Set<String>()
    private var ownedCallSessions: [String: UUID] = [:]
    private var reconciliationTasks: [String: Task<Void, Never>] = [:]

    private init() {
        CallCoordinator.shared.onAnswer = { [weak self] callID in
            await self?.answer(callID: callID) ?? false
        }
        CallCoordinator.shared.onEnd = { [weak self] callID in
            await self?.end(callID: callID)
        }
        CallCoordinator.shared.onReset = { [weak self] callIDs in
            await self?.reset(callIDs: callIDs)
        }
    }

    func attach(session: SessionStore) { self.session = session }

    func sessionDidLogout() {
        offeredCalls.removeAll()
        ownedCallSessions.removeAll()
        reconciliationTasks.values.forEach { $0.cancel() }
        reconciliationTasks.removeAll()
        CallCoordinator.shared.endAllCalls()
    }

    func prepareForLogout(session: SessionStore, sessionIdentity: UUID) async {
        let candidates = Set(offeredCalls)
            .union(CallCoordinator.shared.activeCallIDs)
            .union(ownedCallSessions.keys)
        let ownedCallIDs = SessionCleanupEndPolicy.ownedCallIDs(
            candidates: candidates,
            ownedCallSessions: ownedCallSessions,
            currentSessionIdentity: sessionIdentity
        ).union(CallMediaSession.shared.callID.map { [$0.lowercased()] } ?? [])
        ownedCallIDs.forEach {
            ReliableCallEndQueue.shared.enqueue(callID: $0, session: session, sessionIdentity: sessionIdentity)
        }
        await ReliableCallEndQueue.shared.flush(sessionIdentity: sessionIdentity)
    }

    func receiveVoIPPush(_ userInfo: [AnyHashable: Any], completion: @escaping () -> Void) {
        // S36 C3: the push arrival is the clock every incoming-call complaint is measured from.
        let receivedAt = ContinuousClock.now
        let completion = SendableCallback(completion)
        guard let payload = PushCallPayload(userInfo), payload.event == "call.incoming" else {
            Diag.shared.log("push.voip", ["parsed": false])
            completion.call()
            return
        }
        // S42 decision 5: read the native calls before the CallKit report, so this call's own leg is not in the
        // list yet. The report below still happens, unconditionally — PushKit requires it even when the user
        // cannot possibly answer.
        let deviceBusy = OwnerBusyPolicy.isBusy(
            calls: callObserver.calls.map {
                OwnerBusyPolicy.CallState(
                    uuid: $0.uuid, hasEnded: $0.hasEnded, hasConnected: $0.hasConnected,
                    isOutgoing: $0.isOutgoing, isOnHold: $0.isOnHold
                )
            },
            incomingCallUUID: UUID(uuidString: payload.callId)
        )
        Diag.shared.log("push.voip", [
            "parsed": true, "hasNumber": payload.remoteNumber?.isEmpty == false,
            "hasName": payload.contactName?.isEmpty == false, "hasSimLabel": payload.simLabel != nil,
            "deviceBusy": deviceBusy
        ], callId: payload.callId)
        PushRegistrationManager.shared.recordIncomingStatus("已收到来电通知")
        // S72 B3：内部来电的另一条腿往往就是本机正在拨的那通，不能拿它报忙线。
        if deviceBusy && !payload.isInternal { reportOwnerBusy(callID: payload.callId.lowercased()) }
        CallCoordinator.shared.reportIncomingCall(
            id: payload.callId, handle: payload.remoteNumber ?? "未知号码", contactName: payload.callerDisplayName
        ) { [weak self] error in
            Task { @MainActor in
                let vibrate = IncomingCallReportPolicy.shouldVibrate(
                    reportSucceeded: error == nil, deviceBusy: deviceBusy
                )
                Diag.shared.log("callkit.reported", [
                    "ms": Diag.ms(since: receivedAt), "ok": error == nil,
                    "message": error?.localizedDescription ?? "", "vibrate": vibrate
                ], callId: payload.callId)
                // S44: every `IncomingRingtonePlayer.shared.stop()` — answer, decline, remote cancel, reset,
                // timeout, media start — already ends this too.
                if vibrate { IncomingRingtonePlayer.shared.startVibration() }
                if error == nil {
                    PushRegistrationManager.shared.recordIncomingStatus("来电已显示，正在确认状态")
                    self?.offeredCalls.insert(payload.callId.lowercased())
                    self?.startReconciliation(callID: payload.callId.lowercased())
                    if IncomingCallReportPolicy.shouldPlayLocalRingtone(applicationState: UIApplication.shared.applicationState) {
                        IncomingRingtonePlayer.shared.start()
                    }
                }
                completion.call()
            }
        }
    }

    /// S42 decision 5: best effort and silent — the push path must not fail, slow down or show anything because
    /// of this, and Control decides on its own whether the AI answers. `reconcileOnce`'s note applies here too:
    /// a push may have cold-launched the app with Keychain restoration still pending, so an unusable session is
    /// retried rather than treated as an answer. An older Control 404s the route; that is an answer, and
    /// `session.request` has already recorded the status.
    private func reportOwnerBusy(callID: String) {
        Task { @MainActor [weak self] in
            for attempt in 0..<Self.ownerBusyAttempts {
                if attempt > 0 { try? await Task.sleep(for: Self.ownerBusyRetryInterval) }
                guard let self, !Task.isCancelled else { return }
                // The offer is only inserted once CallKit reports back, so the first attempt cannot check it.
                guard attempt == 0 || offeredCalls.contains(callID) else { return }
                guard let session, session.isAuthenticated, let identity = session.sessionIdentity else { continue }
                do {
                    let response: OwnerBusyResponse = try await session.request(
                        "calls/\(callID)/owner-busy", method: "POST", body: [String: String](),
                        timeoutInterval: 5, requiredSessionIdentity: identity
                    )
                    logOwnerBusy(callID: callID, aiScheduled: response.aiScheduled, attempts: attempt + 1)
                } catch is APIError {
                    logOwnerBusy(callID: callID, aiScheduled: nil, attempts: attempt + 1)
                } catch SessionLifecycleError.staleSession {
                    return
                } catch {
                    // A transport failure never reached Control, so it is worth another attempt.
                    continue
                }
                return
            }
            self?.logOwnerBusy(callID: callID, reported: false, aiScheduled: nil, attempts: Self.ownerBusyAttempts)
        }
    }

    private func logOwnerBusy(callID: String, reported: Bool = true, aiScheduled: Bool?, attempts: Int) {
        Diag.shared.log("call.owner_busy", [
            // A boolean when Control said, the string when it never answered or answered without the field.
            "reported": reported, "aiScheduled": aiScheduled.map { $0 as Any } ?? "unknown", "attempts": attempts
        ], callId: callID)
    }

    func releaseOccupancy(trigger: OccupancyReleasePolicy.Trigger) {
        let media = CallMediaSession.shared
        let mediaLiveness = OccupancyReleasePolicy.mediaLiveness(media.state)
        let callKitIDs = CallCoordinator.shared.activeCallIDs
        let live = OccupancyReleasePolicy.isLive(
            activeCallIDs: callKitIDs,
            media: mediaLiveness
        )
        guard OccupancyReleasePolicy.shouldRelease(
            trigger: trigger,
            isLive: live,
            media: mediaLiveness,
            hasCallKit: !callKitIDs.isEmpty
        ) else { return }
        if let session, let identity = session.sessionIdentity, session.isCurrentSession(identity) {
            OccupancyReleasePolicy.ownedIDs(
                mediaCallID: media.callID,
                ownedCallSessions: ownedCallSessions,
                currentSessionIdentity: identity
            ).forEach {
                ReliableCallEndQueue.shared.enqueue(
                    callID: $0, session: session, sessionIdentity: identity, constraint: .currentSessionOwner
                )
            }
        }
        media.stop()
    }

    /// S20 decision 6: an outbound call is owned the moment `POST /calls/outbound` returns its id — not after the
    /// list refresh, and not after media starts. Being killed inside that window used to leave the gateway
    /// occupied until the five-minute evidence-less reclaim.
    func registerOwnedCall(id: String, sessionIdentity: UUID) {
        let id = id.lowercased()
        guard !id.isEmpty else { return }
        ownedCallSessions[id] = sessionIdentity
    }

    /// S41 decision 3: the far side already hung up, so nothing is owed the server — this only takes the local
    /// side down (CallKit, media, ownership) and must never enqueue an `/end` for an already-released call.
    func endRemotelyEndedCalls(_ callIDs: [String], reason: String, state: String? = nil) {
        for callID in callIDs.map({ $0.lowercased() })
        where CallCoordinator.shared.activeCallIDs.contains(callID) {
            Diag.shared.log("callkit.remote_end", ["reason": reason, "state": state ?? ""], callId: callID)
            stopReconciling(callID: callID)
            ownedCallSessions.removeValue(forKey: callID)
            if CallMediaSession.shared.callID?.lowercased() == callID { CallMediaSession.shared.stop() }
            CallCoordinator.shared.endCall(id: callID)
        }
    }

    /// The ids this session would release on terminate. Exposed for the ownership tests.
    func ownedCallIDs(forSessionIdentity identity: UUID) -> Set<String> {
        OccupancyReleasePolicy.ownedIDs(
            mediaCallID: CallMediaSession.shared.callID,
            ownedCallSessions: ownedCallSessions,
            currentSessionIdentity: identity
        )
    }

    private func answer(callID: String) async -> Bool {
        var blocker = answerBlocker(callID: callID)
        if let initial = blocker {
            Diag.shared.log("call.answer.blocked", ["reason": initial], callId: callID)
            // A push can cold-launch the app into the answer while Keychain restoration and `attach` are still
            // running as separate tasks; give the session a few seconds, as `reportOwnerBusy` does.
            for _ in 0..<ClaimedCallPolicy.sessionWaitAttempts
            where ClaimedCallPolicy.shouldWaitForSession(blocker: blocker) && !Task.isCancelled {
                try? await Task.sleep(for: ClaimedCallPolicy.sessionWaitInterval)
                blocker = answerBlocker(callID: callID)
            }
        }
        guard blocker == nil, let session, let sessionIdentity = session.sessionIdentity else {
            Diag.shared.log("call.answer.failed", ["reason": blocker ?? "not_authenticated"], callId: callID)
            CallCoordinator.shared.endCall(id: callID)
            return false
        }
        do {
            let response = try await claim(callID: callID, session: session, sessionIdentity: sessionIdentity, timeout: 3)
            return resolveClaimedCall(response.call, callID: callID, session: session, sessionIdentity: sessionIdentity)
        } catch let APIError.server(_, _, code) where code == "OWN_OUTGOING_CALL" {
            // S72 B4：这是本会话自己拨出的内部通话的被叫腿。只收起本机 CallKit，不能发 end——那会挂掉自己的通话。
            Diag.shared.log("call.answer.failed", ["reason": "own_outgoing_call"], callId: callID)
            stopReconciling(callID: callID)
            CallCoordinator.shared.endCall(id: callID, reason: .answeredElsewhere)
            return false
        } catch let APIError.server(status, message, code) {
            failAnswer(
                callID: callID, session: session, sessionIdentity: sessionIdentity,
                error: APIError.server(status, message, code)
            )
            return false
        } catch APIError.unauthorized {
            failAnswer(callID: callID, session: session, sessionIdentity: sessionIdentity, error: APIError.unauthorized)
            return false
        } catch SessionLifecycleError.staleSession {
            failAnswer(
                callID: callID, session: session, sessionIdentity: sessionIdentity,
                error: SessionLifecycleError.staleSession
            )
            return false
        } catch {
            // A lost response is ambiguous. The backend makes same-session claim replay idempotent.
            if let replay = try? await claim(callID: callID, session: session, sessionIdentity: sessionIdentity, timeout: 2) {
                return resolveClaimedCall(replay.call, callID: callID, session: session, sessionIdentity: sessionIdentity)
            }
            if let detail: CallEnvelope = try? await session.request(
                "calls/\(callID)", timeoutInterval: 2, requiredSessionIdentity: sessionIdentity
            ), detail.call.claimedByCurrentSession == true,
               ["connecting", "active"].contains(detail.call.state ?? "") {
                return resolveClaimedCall(detail.call, callID: callID, session: session, sessionIdentity: sessionIdentity)
            }
            failAnswer(callID: callID, session: session, sessionIdentity: sessionIdentity, error: error)
            return false
        }
    }

    private func answerBlocker(callID: String) -> String? {
        ClaimedCallPolicy.answerBlocker(
            offered: offeredCalls.contains(callID),
            authenticated: session?.isAuthenticated == true && session?.sessionIdentity != nil
        )
    }

    private func resolveClaimedCall(
        _ call: CallRecord, callID: String, session: SessionStore, sessionIdentity: UUID
    ) -> Bool {
        guard beginClaimedCall(call, session: session, sessionIdentity: sessionIdentity) else {
            failAnswer(callID: callID, session: session, sessionIdentity: sessionIdentity, error: nil)
            return false
        }
        return true
    }

    private func claim(callID: String, session: SessionStore, sessionIdentity: UUID, timeout: TimeInterval) async throws -> CallEnvelope {
        try await session.request(
            "calls/\(callID)/claim", method: "POST",
            body: ClaimBody(platform: "ios", deviceName: UIDevice.current.name),
            timeoutInterval: timeout, requiredSessionIdentity: sessionIdentity
        )
    }

    private func beginClaimedCall(_ call: CallRecord, session: SessionStore, sessionIdentity: UUID) -> Bool {
        guard ClaimedCallPolicy.isOwnedAndAnswerable(call),
              session.isCurrentSession(sessionIdentity) else { return false }
        ownedCallSessions[call.id.lowercased()] = sessionIdentity
        stopReconciling(callID: call.id.lowercased())
        startRemoteEndWatch(callID: call.id.lowercased())
        Task { @MainActor [self, session] in
            await CallMediaSession.shared.start(
                callID: call.id, session: session, transport: .udp,
                managedByCallKit: true, automaticallyRetryTLS: true
            ) { [weak self, weak session] failedCallID in
                self?.ownedCallSessions.removeValue(forKey: failedCallID.lowercased())
                guard let session, session.isCurrentSession(sessionIdentity) else { return }
                ReliableCallEndQueue.shared.enqueue(
                    callID: failedCallID, session: session, sessionIdentity: sessionIdentity
                )
                CallCoordinator.shared.endCall(id: failedCallID)
            }
        }
        return true
    }

    /// `error` is nil only when Control answered but the claim did not prove this session owns a live call.
    private func failAnswer(callID: String, session: SessionStore, sessionIdentity: UUID, error: Error?) {
        if let error {
            Diag.shared.logError(site: "call.answer", error: error, callId: callID)
        } else {
            Diag.shared.log("call.answer.failed", ["reason": "not_answerable"], callId: callID)
        }
        stopReconciling(callID: callID)
        ownedCallSessions.removeValue(forKey: callID)
        if CallMediaSession.shared.callID?.lowercased() == callID.lowercased() {
            CallMediaSession.shared.stop()
        }
        ReliableCallEndQueue.shared.enqueue(callID: callID, session: session, sessionIdentity: sessionIdentity)
        CallCoordinator.shared.endCall(id: callID)
    }

    private func startReconciliation(callID: String) {
        reconciliationTasks[callID]?.cancel()
        reconciliationTasks[callID] = Task { @MainActor [weak self] in
            guard let self else { return }
            for attempt in 0..<Self.maximumReconciliationAttempts {
                guard !Task.isCancelled, offeredCalls.contains(callID) else { break }
                if attempt > 0 { try? await Task.sleep(for: Self.reconciliationInterval) }
                guard !Task.isCancelled, offeredCalls.contains(callID) else { break }
                await reconcileOnce(callID: callID)
            }
            guard !Task.isCancelled, offeredCalls.contains(callID) else { return }
            stopReconciling(callID: callID)
            CallCoordinator.shared.endCall(id: callID)
            PushRegistrationManager.shared.recordIncomingStatus("来电状态确认超时，提示已关闭")
        }
    }

    /// S41 decision 3: after the answer nothing else watches the call. `CallsView.load`'s poll is view-scoped —
    /// a call answered from the lock screen (VoIP push launches the app into the background, no scene rendered)
    /// or answered on another tab never runs it — so the watch lives here, where it is alive for exactly as long
    /// as CallKit holds the call. It shares `reconciliationTasks`, so a local end, a provider reset and a logout
    /// already cancel it.
    private func startRemoteEndWatch(callID: String) {
        reconciliationTasks[callID]?.cancel()
        reconciliationTasks[callID] = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.remoteEndWatchInterval)
                guard !Task.isCancelled, let self else { return }
                if await self.checkRemoteEnd(callID: callID, reason: "watch") { return }
            }
        }
    }

    /// S70d: the media path dropping (ICE `disconnected`/`failed`/`closed`) is the earliest hint the far side hung
    /// up — without this, CallKit waited up to the next 3 s watch tick or list poll while NetEQ concealed silence.
    /// One authoritative check right away; it ends the call only if Control says the call is terminal, so a
    /// transient disconnect still rides the S40 grace.
    func checkRemoteEndNow(callID: String) {
        let callID = callID.lowercased()
        guard CallCoordinator.shared.activeCallIDs.contains(callID) else { return }
        Task { @MainActor [weak self] in _ = await self?.checkRemoteEnd(callID: callID, reason: "ice") }
    }

    /// One `GET calls/<id>`; returns true when watching this call is over (ended here, gone, or stale session).
    private func checkRemoteEnd(callID: String, reason: String) async -> Bool {
        guard CallCoordinator.shared.activeCallIDs.contains(callID) else { return true }
        guard let session, session.isAuthenticated, let identity = session.sessionIdentity else { return false }
        let state: String?
        do {
            let response: CallEnvelope = try await session.request(
                "calls/\(callID)", requiredSessionIdentity: identity
            )
            state = response.call.state
        } catch SessionLifecycleError.staleSession {
            return true
        } catch APIError.server(404, _, _) {
            // Unlike the list poll, absence is authoritative for a call this session already claimed.
            state = "ended"
        } catch {
            // A transport failure is not authoritative call termination.
            return false
        }
        guard session.isCurrentSession(identity), CallKitRemoteEndPolicy.isFinished(state) else { return false }
        endRemotelyEndedCalls([callID], reason: reason, state: state)
        return true
    }

    private func reconcileOnce(callID: String) async {
        // App startup may attach this manager before Keychain restoration completes.
        guard let session, session.isAuthenticated, let identity = session.sessionIdentity else { return }
        do {
            let response: CallEnvelope = try await session.request(
                "calls/\(callID)", requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity), offeredCalls.contains(callID) else { return }
            if OfferedCallReconciliation.decision(for: response.call.state) == .endLocalOffer {
                stopReconciling(callID: callID)
                CallCoordinator.shared.endCall(
                    id: callID, reason: OfferedCallReconciliation.answeredElsewhere(response.call.state) ? .answeredElsewhere : .remoteEnded
                )
                PushRegistrationManager.shared.recordIncomingStatus("来电状态已变化，提示已关闭")
            } else {
                // S36 C1: while it still rings, push the authoritative number/name onto the CallKit screen —
                // the push itself may have carried neither.
                let call = response.call
                CallCoordinator.shared.updateCall(
                    id: callID, handle: call.remoteNumber,
                    contactName: IncomingCallerName.text(
                        contactName: call.contactName, remoteNumber: call.remoteNumber, isInternal: call.isInternal,
                        peerSimLabel: call.peerSimLabel, simLabel: call.simLabel
                    )
                )
            }
        } catch SessionLifecycleError.staleSession {
            return
        } catch APIError.unauthorized {
            guard session.isCurrentSession(identity) else { return }
            stopReconciling(callID: callID)
            CallCoordinator.shared.endCall(id: callID)
            PushRegistrationManager.shared.recordIncomingStatus("登录已失效，来电提示已关闭")
        } catch APIError.server(404, _, _) {
            guard session.isCurrentSession(identity) else { return }
            stopReconciling(callID: callID)
            CallCoordinator.shared.endCall(id: callID)
            PushRegistrationManager.shared.recordIncomingStatus("来电已结束，提示已关闭")
        } catch {
            // A transport failure is not authoritative call termination.
            PushRegistrationManager.shared.recordIncomingStatus("网络暂不可用，正在继续确认来电状态")
        }
    }

    private func stopReconciling(callID: String) {
        offeredCalls.remove(callID)
        reconciliationTasks.removeValue(forKey: callID)?.cancel()
    }

    private func end(callID: String) async {
        let wasOffered = offeredCalls.contains(callID)
        stopReconciling(callID: callID)
        if CallMediaSession.shared.callID?.lowercased() == callID { CallMediaSession.shared.stop() }
        let expectedIdentity = ownedCallSessions.removeValue(forKey: callID)
        guard let session, let sessionIdentity = session.sessionIdentity,
              session.isCurrentSession(sessionIdentity) else { return }
        guard let constraint = IncomingCallEndPolicy.constraint(
            wasOffered: wasOffered,
            expectedOwnerIdentity: expectedIdentity,
            currentSessionIdentity: sessionIdentity
        ) else { return }
        ReliableCallEndQueue.shared.enqueue(
            callID: callID, session: session, sessionIdentity: sessionIdentity,
            constraint: constraint
        )
    }

    private func reset(callIDs: [String]) async {
        let ids = Set(callIDs.map { $0.lowercased() }).union(offeredCalls)
        let owned = ownedCallSessions
        reconciliationTasks.values.forEach { $0.cancel() }
        reconciliationTasks.removeAll(); offeredCalls.removeAll(); ownedCallSessions.removeAll()
        CallMediaSession.shared.stop()
        guard let session, let sessionIdentity = session.sessionIdentity,
              session.isCurrentSession(sessionIdentity) else { return }
        SessionCleanupEndPolicy.ownedCallIDs(
            candidates: ids,
            ownedCallSessions: owned,
            currentSessionIdentity: sessionIdentity
        ).forEach {
            ReliableCallEndQueue.shared.enqueue(callID: $0, session: session, sessionIdentity: sessionIdentity)
        }
    }

    private struct ClaimBody: Encodable, Sendable { let platform, deviceName: String }
    private struct CallEnvelope: Decodable, Sendable { let call: CallRecord }
    /// Optional so a Control that answers the route without the field is still an answer, not a decode failure.
    private struct OwnerBusyResponse: Decodable, Sendable { let aiScheduled: Bool? }
}

enum OfferedCallReconciliation {
    enum Decision: Equatable { case keepRinging, endLocalOffer }

    static func decision(for authoritativeState: String?) -> Decision {
        authoritativeState == "incoming_ringing" ? .keepRinging : .endLocalOffer
    }

    /// An offered call that moved on to connecting/active was answered by another client (not this
    /// device, which would have claimed it): CallKit then files it as answered elsewhere, not missed.
    static func answeredElsewhere(_ authoritativeState: String?) -> Bool {
        authoritativeState == "connecting" || authoritativeState == "active"
    }
}

enum IncomingCallEndPolicy {
    static func constraint(
        wasOffered: Bool,
        expectedOwnerIdentity: UUID?,
        currentSessionIdentity: UUID
    ) -> ReliableCallEndConstraint? {
        if let expectedOwnerIdentity {
            return expectedOwnerIdentity == currentSessionIdentity ? .currentSessionOwner : nil
        }
        return wasOffered ? .ringingUnclaimed : nil
    }
}

enum SessionCleanupEndPolicy {
    static func ownedCallIDs(
        candidates: Set<String>,
        ownedCallSessions: [String: UUID],
        currentSessionIdentity: UUID
    ) -> Set<String> {
        Set(candidates.filter { ownedCallSessions[$0] == currentSessionIdentity })
    }
}

private final class SendableCallback: @unchecked Sendable {
    private let callback: () -> Void
    init(_ callback: @escaping () -> Void) { self.callback = callback }
    func call() { callback() }
}

struct PushCallPayload: Sendable {
    let event: String
    let callId: String
    let remoteNumber: String?
    /// S21 §A: the APNs VoIP payload carries the matched contact name when Control knows one. Absent on an
    /// older Control and for an unmatched number, in which case CallKit keeps showing the number alone.
    let contactName: String?
    /// S72：内部来电（同一 owner 的托管卡互打）。pre-S72 Control 不发 → false。
    let isInternal: Bool
    let peerSimLabel: String?
    /// S81：被叫 SIM 的显示名。pre-S81 Control 不发 → nil，来电名保持旧样子。
    let simLabel: String?

    var callerDisplayName: String? {
        IncomingCallerName.text(
            contactName: contactName, remoteNumber: remoteNumber, isInternal: isInternal,
            peerSimLabel: peerSimLabel, simLabel: simLabel
        )
    }

    init?(_ value: [AnyHashable: Any]) {
        guard (value["version"] as? NSNumber)?.intValue == 1,
              let event = value["event"] as? String,
              let callId = value["callId"] as? String,
              UUID(uuidString: callId) != nil else { return nil }
        self.event = event
        self.callId = callId.lowercased()
        remoteNumber = value["remoteNumber"] as? String
        contactName = (value["contactName"] as? String)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : String($0.prefix(120)) }
        isInternal = (value["internal"] as? NSNumber)?.boolValue ?? false
        peerSimLabel = (value["peerSimLabel"] as? String)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : String($0.prefix(60)) }
        simLabel = (value["simLabel"] as? String)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : String($0.prefix(60)) }
    }
}

/// CallKit 上的来电名，推送首报与 S36 C1 对账共用，响铃中文字不回退。内部来电写「{主叫卡}（内部）」，否则是
/// 联系人名；S81 有被叫卡名时再接「 → {被叫卡}」，此时主叫缺名就用号码、再缺用「未知号码」。无被叫卡名 = 旧行为。
enum IncomingCallerName {
    static func text(
        contactName: String?, remoteNumber: String?, isInternal: Bool, peerSimLabel: String?, simLabel: String?
    ) -> String? {
        func clean(_ value: String?) -> String? {
            value.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        }
        let base = isInternal ? "\(clean(peerSimLabel) ?? "内部来电")（内部）" : clean(contactName)
        guard let simLabel = clean(simLabel) else { return base }
        if isInternal { return "\(base ?? "")→ \(simLabel)" }
        return "\(base ?? clean(remoteNumber) ?? "未知号码") → \(simLabel)"
    }
}

extension Data {
    func hexEncodedString() -> String { map { String(format: "%02x", $0) }.joined() }
}
