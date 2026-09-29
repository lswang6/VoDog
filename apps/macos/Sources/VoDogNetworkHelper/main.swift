import Darwin
import Foundation
import VoDogNetworkIPC
import OSLog
import Security
import SystemConfiguration

private let networkHelperLogger = Logger(
    subsystem: "org.vodog.macos.network.helper",
    category: "CellularNetwork"
)

private final class NetworkHelperService: NSObject, VoDogNetworkHelperProtocol {
    private let queue = DispatchQueue(label: "org.vodog.macos.network.helper.mutation")
    private let mutator = RootNetworkMutator()
    private let voWiFiHost = VoWiFiHostManager()

    func ping(reply: @escaping (Int, String) -> Void) {
        reply(VoDogNetworkIPC.protocolVersion, VoDogNetworkIPC.helperIdentity)
    }

    func applyCellularNetworkConfiguration(
        _ requestData: Data,
        reply: @escaping (Int, String) -> Void
    ) {
        queue.async { [mutator] in
            guard let request = try? JSONDecoder().decode(
                CellularNetworkConfigurationRequest.self,
                from: requestData
            ), request.isValid else {
                reply(VoDogNetworkResultCode.failure.rawValue, "蜂窝网络配置请求无效。")
                return
            }
            networkHelperLogger.info(
                "Apply configuration preferred=\(request.preferredLocationID ?? 0) standby=\(request.standbyLocationIDs.count) off=\(request.offLocationIDs.count)"
            )
            let result = mutator.applyCellularNetworkConfiguration(request)
            if result.succeeded {
                networkHelperLogger.notice(
                    "Configuration succeeded: \(result.message, privacy: .public)"
                )
            } else {
                networkHelperLogger.error(
                    "Configuration failed: \(result.message, privacy: .public)"
                )
            }
            reply(result.code.rawValue, result.message)
        }
    }

    func startVoWiFiHost(
        _ requestData: Data,
        reply: @escaping (Int, String, Data?) -> Void
    ) {
        queue.async { [voWiFiHost] in
            guard let request = try? JSONDecoder().decode(
                VoWiFiHostStartRequest.self,
                from: requestData
            ) else {
                reply(VoDogNetworkResultCode.failure.rawValue, "VoWiFi 启动请求无法解码。", nil)
                return
            }
            let result = voWiFiHost.start(request)
            reply(result.0.code.rawValue, result.0.message, result.1)
        }
    }

    func stopVoWiFiHost(
        _ requestData: Data,
        reply: @escaping (Int, String) -> Void
    ) {
        queue.async { [voWiFiHost] in
            guard let request = try? JSONDecoder().decode(
                VoWiFiHostStatusRequest.self,
                from: requestData
            ) else {
                reply(VoDogNetworkResultCode.failure.rawValue, "VoWiFi 停止请求无法解码。")
                return
            }
            let result = voWiFiHost.stop(request)
            reply(result.code.rawValue, result.message)
        }
    }

    func queryVoWiFiHost(
        _ requestData: Data,
        reply: @escaping (Int, String, Data?) -> Void
    ) {
        queue.async { [voWiFiHost] in
            guard let request = try? JSONDecoder().decode(
                VoWiFiHostStatusRequest.self,
                from: requestData
            ) else {
                reply(VoDogNetworkResultCode.failure.rawValue, "VoWiFi 状态请求无法解码。", nil)
                return
            }
            let result = voWiFiHost.query(request)
            reply(result.0.code.rawValue, result.0.message, result.1)
        }
    }
}

private final class NetworkHelperListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let service = NetworkHelperService()

    func listener(
        _ listener: NSXPCListener,
        shouldAcceptNewConnection connection: NSXPCConnection
    ) -> Bool {
        guard ClientValidator.isAllowed(connection) else {
            NSLog("VoDogNetworkHelper rejected XPC client pid=%d uid=%d",
                  connection.processIdentifier,
                  connection.effectiveUserIdentifier)
            return false
        }
        connection.exportedInterface = NSXPCInterface(with: VoDogNetworkHelperProtocol.self)
        connection.exportedObject = service
        connection.resume()
        return true
    }
}

private enum ClientValidator {
    private static let helperLeafCertificateData: Data? = {
        guard let helperCode = VoDogCodeSigningPolicy.currentProcessCode(),
              let requirement = VoDogCodeSigningPolicy.identifierRequirement(
                  VoDogCodeSigningPolicy.helperIdentifier
              ),
              SecCodeCheckValidity(helperCode, [], requirement) == errSecSuccess else {
            return nil
        }
        return VoDogCodeSigningPolicy.leafCertificateData(for: helperCode)
    }()

    static func isAllowed(_ connection: NSXPCConnection) -> Bool {
        let pid = connection.processIdentifier
        guard pid > 0,
              let consoleUID = consoleUserID(),
              consoleUID != 0,
              connection.effectiveUserIdentifier == consoleUID,
              let processPath = processExecutablePath(pid: pid),
              isAllowedExecutablePath(processPath),
              hasExpectedSigningIdentity(pid: pid, executablePath: processPath) else {
            return false
        }
        return true
    }

    private static func consoleUserID() -> uid_t? {
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard let name = SCDynamicStoreCopyConsoleUser(nil, &uid, &gid) as String?,
              name != "loginwindow",
              !name.isEmpty else {
            return nil
        }
        return uid
    }

    private static func processExecutablePath(pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN * 4))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(cString: buffer)
    }

    private static func isAllowedExecutablePath(_ path: String) -> Bool {
        let expectedPath = "/Applications/VoDog.app/Contents/MacOS/VoDog"
        let standardizedPath = URL(fileURLWithPath: path).standardizedFileURL.path
        return standardizedPath == expectedPath && canonical(standardizedPath) == expectedPath
    }

    private static func canonical(_ path: String) -> String {
        URL(fileURLWithPath: path)
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path
    }

    private static func hasExpectedSigningIdentity(
        pid: pid_t,
        executablePath: String
    ) -> Bool {
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
              let code else {
            return false
        }

        guard let requirement = VoDogCodeSigningPolicy.identifierRequirement(
            VoDogCodeSigningPolicy.appIdentifier
        ),
        SecCodeCheckValidity(code, [], requirement) == errSecSuccess,
        let helperLeafCertificateData,
        let clientLeafCertificateData = VoDogCodeSigningPolicy.leafCertificateData(for: code),
        clientLeafCertificateData == helperLeafCertificateData else {
            return false
        }

        var staticCode: SecStaticCode?
        var signedPath: CFURL?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
              let staticCode,
              SecCodeCopyPath(staticCode, [], &signedPath) == errSecSuccess,
              let signedPath else {
            return false
        }
        let executableURL = URL(fileURLWithPath: executablePath)
        let appBundleURL = executableURL
            .deletingLastPathComponent() // MacOS
            .deletingLastPathComponent() // Contents
            .deletingLastPathComponent() // VoDog.app
        let canonicalSignedPath = canonical((signedPath as URL).path)
        return canonicalSignedPath == canonical(executablePath) ||
            canonicalSignedPath == canonical(appBundleURL.path)
    }
}

guard geteuid() == 0 else {
    NSLog("VoDogNetworkHelper must run as root")
    exit(EXIT_FAILURE)
}

// Ensure state-file and atomic temporary-file creation are root-only by default.
_ = umask(S_IRWXG | S_IRWXO)

private let delegate = NetworkHelperListenerDelegate()
let listener = NSXPCListener(machServiceName: VoDogNetworkIPC.helperLabel)
listener.delegate = delegate
listener.resume()
RunLoop.current.run()
