import Foundation

enum FailureReasonDisplayPolicy {
    static let hiddenReclaimCodes: Set<String> = [
        "device_snapshot_confirmed_absent",
        "device_snapshot_stale_lock_reclaimed",
        "device_snapshot_confirmed_never_started",
    ]

    static func visibleReason(
        failureReason: String?,
        state: String?,
        answeredAt: String?,
        recordingStatus: String?,
        transcript: String? = nil
    ) -> String? {
        guard let failureReason, !failureReason.isEmpty else { return nil }
        if hiddenReclaimCodes.contains(failureReason) { return nil }
        if isConnected(answeredAt: answeredAt, recordingStatus: recordingStatus, transcript: transcript) {
            return nil
        }
        let neverConnected = answeredAt == nil || answeredAt?.isEmpty == true
        let failed = state == "failed" || neverConnected
        guard failed else { return nil }
        // S38：合同点名的代码印中文，其他代码仍按原样露出来，免得新服务端的原因被悄悄吞掉。
        return reasonTitles[failureReason] ?? failureReason
    }

    static let reasonTitles: [String: String] = ["busy_auto_rejected": "忙线自动拒接"]

    static func visibleReason(for call: CallRecord) -> String? {
        visibleReason(
            failureReason: call.failureReason,
            state: call.state,
            answeredAt: call.answeredAt,
            recordingStatus: call.recordingStatus,
            transcript: call.transcript
        )
    }

    private static func isConnected(answeredAt: String?, recordingStatus: String?, transcript: String?) -> Bool {
        if let answeredAt, !answeredAt.isEmpty { return true }
        if let recordingStatus, !recordingStatus.isEmpty, recordingStatus != "none" { return true }
        if let transcript, !transcript.isEmpty { return true }
        return false
    }
}
