import AVFoundation
@preconcurrency import CallKit
import Foundation

final class CallCoordinator: NSObject, CXProviderDelegate, @unchecked Sendable {
    static let shared = CallCoordinator()
    private let provider: CXProvider
    private let callController = CXCallController()
    private let callLock = NSLock()
    private var trackedCallIDs = Set<String>()
    private var answerTasks: [UUID: Task<Void, Never>] = [:]
    /// S69: calls whose CXAnswerCallAction was fulfilled, for `callkit.end_action.answered`. Delegate queue only.
    private var answeredCalls = Set<UUID>()
    var onAnswer: (@MainActor @Sendable (String) async -> Bool)?
    var onEnd: (@MainActor @Sendable (String) async -> Void)?
    var onReset: (@MainActor @Sendable ([String]) async -> Void)?

    override private init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.phoneNumber, .generic]
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    func reportIncomingCall(
        id: String, handle: String, contactName: String? = nil,
        completion: @escaping @Sendable (Error?) -> Void
    ) {
        guard let uuid = UUID(uuidString: id) else { completion(APIError.invalidResponse); return }
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .phoneNumber, value: handle)
        // S21 §A: the system call UI shows the contact name above the number when Control matched one.
        if let contactName, !contactName.isEmpty { update.localizedCallerName = contactName }
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if error == nil, let self { self.callLock.withLock { _ = self.trackedCallIDs.insert(id.lowercased()) } }
            completion(error)
        }
    }

    /// S36 C1: the reconciliation poll knows the authoritative number and name even when the push carried
    /// neither (an older Control). Refreshing the CallKit screen in place is what makes them appear; an empty
    /// field is skipped so a blank never overwrites what the push already showed.
    func updateCall(id: String, handle: String?, contactName: String?) {
        let handle = handle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let contactName = contactName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let uuid = UUID(uuidString: id), !handle.isEmpty || !contactName.isEmpty else { return }
        let update = CXCallUpdate()
        if !handle.isEmpty { update.remoteHandle = CXHandle(type: .phoneNumber, value: handle) }
        if !contactName.isEmpty { update.localizedCallerName = contactName }
        provider.reportCall(with: uuid, updated: update)
    }

    func endCall(id: String, reason: CXCallEndedReason = .remoteEnded) {
        guard let uuid = UUID(uuidString: id) else { return }
        callLock.withLock { _ = trackedCallIDs.remove(id.lowercased()) }
        IncomingRingtonePlayer.shared.stop()
        provider.reportCall(with: uuid, endedAt: nil, reason: reason)
    }
    func endAllCalls() {
        let ids = callLock.withLock { let value = trackedCallIDs; trackedCallIDs.removeAll(); return value }
        Diag.shared.log("callkit.end_all", ["count": ids.count])
        IncomingRingtonePlayer.shared.stop()
        ids.compactMap(UUID.init(uuidString:)).forEach {
            provider.reportCall(with: $0, endedAt: nil, reason: .failed)
        }
    }

    var activeCallIDs: [String] { callLock.withLock { Array(trackedCallIDs) } }

    /// In-app mute for a CallKit call goes through a `CXSetMutedCallAction`, so the system call screen and the
    /// app stay in sync; the provider handler applies it. Other calls mute the track directly.
    @MainActor
    func setMuted(_ muted: Bool, media: CallMediaSession) {
        let tracked = media.callID.map { id in callLock.withLock { trackedCallIDs.contains(id.lowercased()) } } ?? false
        guard CallKitMutePolicy.routesThroughCallKit(managedByCallKit: media.isManagedByCallKit, tracked: tracked),
              let id = media.callID, let uuid = UUID(uuidString: id) else {
            media.setMuted(muted)
            return
        }
        callController.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { error in
            guard let error else { return }
            Task { @MainActor in
                Diag.shared.log("callkit.mute_request_failed", ["muted": muted, "error": "\(error)"], callId: id)
                if media.callID == id { media.setMuted(muted) }
            }
        }
    }

    func providerDidReset(_ provider: CXProvider) {
        let ids = callLock.withLock { let value = Array(trackedCallIDs); trackedCallIDs.removeAll(); return value }
        answerTasks.values.forEach { $0.cancel() }; answerTasks.removeAll()
        answeredCalls.removeAll()
        IncomingRingtonePlayer.shared.stop()
        Task { @MainActor in
            Diag.shared.log("callkit.reset", [
                "trackedCount": ids.count, "hadMedia": CallMediaSession.shared.callID != nil
            ])
            CallMediaSession.shared.stop()
        }
        Task { @MainActor [onReset] in await onReset?(ids) }
    }
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        IncomingRingtonePlayer.shared.stop()
        let callID = action.callUUID.uuidString.lowercased()
        answerTasks[action.callUUID]?.cancel()
        answerTasks[action.callUUID] = Task { @MainActor [weak self, onAnswer] in
            await CallMediaSession.shared.prepareCallKitAnswerAudio()
            guard !Task.isCancelled else { return }
            action.fulfill()
            self?.answeredCalls.insert(action.callUUID)
            let succeeded = await onAnswer?(callID) == true
            guard !Task.isCancelled else { return }
            if !succeeded { CallCoordinator.shared.endCall(id: callID) }
            self?.answerTasks.removeValue(forKey: action.callUUID)
        }
    }
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        IncomingRingtonePlayer.shared.stop()
        action.fulfill()
        let callID = action.callUUID.uuidString.lowercased()
        answerTasks.removeValue(forKey: action.callUUID)?.cancel()
        let answered = answeredCalls.remove(action.callUUID) != nil
        Diag.shared.log("callkit.end_action", ["answered": answered], callId: callID)
        callLock.withLock { _ = trackedCallIDs.remove(callID) }
        Task { @MainActor [onEnd] in await onEnd?(callID) }
    }
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let callID = action.callUUID.uuidString.lowercased()
        MainActor.assumeIsolated {
            let media = CallMediaSession.shared
            let applied = media.callID?.lowercased() == callID && media.setMuted(action.isMuted)
            Diag.shared.log("callkit.mute", ["muted": action.isMuted, "applied": applied], callId: callID)
            if applied { action.fulfill() } else { action.fail() }
        }
    }
    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        action.fail()
        Diag.shared.log(
            "callkit.action_failed", ["action": String(describing: type(of: action))],
            callId: (action as? CXCallAction)?.callUUID.uuidString
        )
        IncomingRingtonePlayer.shared.stop()
        guard let answer = action as? CXAnswerCallAction else { return }
        answerTasks.removeValue(forKey: answer.callUUID)?.cancel()
        let callID = answer.callUUID.uuidString.lowercased()
        Task { @MainActor [onEnd] in await onEnd?(callID) }
    }
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            CallMediaSession.shared.callKitDidActivate(audioSession)
        }
    }
    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            CallMediaSession.shared.callKitDidDeactivate(audioSession)
        }
    }
}

enum CallKitMutePolicy {
    /// Only a call CallKit still tracks has a system mute button to keep in sync.
    static func routesThroughCallKit(managedByCallKit: Bool, tracked: Bool) -> Bool { managedByCallKit && tracked }
}
