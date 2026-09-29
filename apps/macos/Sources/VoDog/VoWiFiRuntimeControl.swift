import Foundation

/// Everything VoDog hands to the module-side `vowifi-go` control host for
/// one session. It is deliberately small: the runtime resolves the carrier
/// profile, ePDG and IMS identity from the SIM itself.
struct VoWiFiSessionRequest: Equatable, Sendable {
    /// Correlation token echoed back by `status`, so a runtime left over from a
    /// previous VoDog launch can be detected instead of trusted.
    let sessionID: String
    /// `socks5://user:password@host:port` reachable from the module over ECM.
    let proxyURL: String

    var configurationPayload: String {
        """
        protocol=\(VoWiFiControlProtocol.version)
        session=\(sessionID)
        dataplane_mode=\(VoWiFiControlProtocol.requiredDataplaneMode)
        proxy=\(proxyURL)
        """
    }
}

enum VoWiFiControlError: LocalizedError, Equatable {
    case unsafeConfiguration

    var errorDescription: String? {
        switch self {
        case .unsafeConfiguration:
            return L10n.tr("VoWiFi 会话配置包含无法安全传输的字符。")
        }
    }
}

/// Builds the shell programs run on the module over ADB. Kept free of any
/// transport dependency so the exact command text stays unit-testable.
enum VoWiFiRuntimeControl {
    /// Only the software runtime is supported. Vendor IWLAN and Android
    /// Telephony backends were removed: neither can be pointed at a SOCKS5
    /// egress, which is the only transport this feature offers.
    static let controlHostCandidates = [
        "/usr/libexec/celldock-vowifi-go",
        "/usr/bin/celldock-vowifi-go",
        "/data/vendor/celldock/vowifi-go-control"
    ]

    private static var hostLookup: String {
        controlHostCandidates
            .map { "if test -z \"$tool\" && test -x '\($0)'; then tool='\($0)'; fi" }
            .joined(separator: "; ")
    }

    /// Emits a protocol-3 `status` block. A missing control host is reported as
    /// a normal unsupported result rather than a command failure, so the UI can
    /// explain the situation instead of showing a shell error.
    static var statusCommand: String {
        """
        tool=''; \(hostLookup); \
        if test -z "$tool"; then \
          printf 'protocol=%s\\nsupported=0\\nrunning=0\\nreason=control-host-missing\\n' \
            '\(VoWiFiControlProtocol.version)'; exit 0; \
        fi; \
        output="$("$tool" status 2>&1)"; code=$?; \
        test "$code" -eq 0 || { printf '%s\\n' "$output"; exit "$code"; }; \
        printf '%s\\n' "$output"
        """
    }

    static var stopCommand: String {
        """
        tool=''; \(hostLookup); \
        test -n "$tool" || { echo 'control-host-missing'; exit 40; }; \
        "$tool" stop
        """
    }

    /// The session configuration — including the relay password — is delivered
    /// on stdin. Passing it as an argument would publish the credential in the
    /// long-lived runtime's `/proc/<pid>/cmdline` for the life of the tunnel.
    static func startCommand(_ request: VoWiFiSessionRequest) throws -> String {
        let payload = request.configurationPayload
        let delimiter = "VODOG_VOWIFI_\(sanitizedToken(request.sessionID))"
        guard isSafe(payload, delimiter: delimiter) else {
            throw VoWiFiControlError.unsafeConfiguration
        }
        return """
        tool=''; \(hostLookup); \
        test -n "$tool" || { echo 'control-host-missing'; exit 40; }; \
        "$tool" start <<'\(delimiter)'
        \(payload)
        \(delimiter)
        """
    }

    /// A session token is only ever compared and echoed, so restrict it to
    /// characters that cannot alter the surrounding shell program.
    static func newSessionID() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    private static func sanitizedToken(_ value: String) -> String {
        let allowed = value.filter { $0.isLetter || $0.isNumber }
        return allowed.isEmpty ? "SESSION" : String(allowed.prefix(24)).uppercased()
    }

    private static func isSafe(_ payload: String, delimiter: String) -> Bool {
        guard !payload.contains("\r"), payload.unicodeScalars.allSatisfy({ $0 != "\0" }) else {
            return false
        }
        return !payload.split(whereSeparator: \.isNewline).contains { $0 == Substring(delimiter) }
    }
}
