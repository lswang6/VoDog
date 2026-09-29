import Foundation

// GatewayRecording.swift's upload path logs through GatewayDiagLog, whose file pulls in the app
// (AppDataDirectory, GatewayJSON). The self-tests never upload, so a stand-in is enough.
enum GatewayDiagLog {
    static func errorReason(_ error: Error) -> String { "\(error)" }
}
