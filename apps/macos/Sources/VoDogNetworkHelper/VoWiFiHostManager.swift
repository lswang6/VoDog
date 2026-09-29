import Darwin
import Foundation
import VoDogNetworkIPC

final class VoWiFiHostManager {
    private struct RuntimeConfiguration: Encodable {
        let sessionID: String
        let simBridgeHost: String
        let simBridgeToken: String
        let outerInterface: String
        let outerGateway: String?
        let outerLocalIP: String?
        let proxyURL: String?
        let statusPath: String
        let tunMTU: Int

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case simBridgeHost = "sim_bridge_host"
            case simBridgeToken = "sim_bridge_token"
            case outerInterface = "outer_interface"
            case outerGateway = "outer_gateway"
            case outerLocalIP = "outer_local_ip"
            case proxyURL = "proxy_url"
            case statusPath = "status_path"
            case tunMTU = "tun_mtu"
        }
    }

    private struct ManagedRuntime {
        let process: Process
        let logHandle: FileHandle
        let configurationPath: String
        let statusPath: String
    }

    private let runtimePath = "/Library/PrivilegedHelperTools/VoDogVoWiFiRuntime"
    private let stateDirectory = "/var/run/vodog-vowifi"
    private var runtimes: [String: ManagedRuntime] = [:]

    func start(_ request: VoWiFiHostStartRequest) -> (HelperActionResult, Data?) {
        guard geteuid() == 0 else {
            return (.failure("VoWiFi helper 没有 root 权限。"), nil)
        }
        guard validate(request) else {
            return (.failure("VoWiFi 启动请求无效。"), nil)
        }
        guard FileManager.default.isExecutableFile(atPath: runtimePath) else {
            return (.failure("未安装 VoDogVoWiFiRuntime。"), nil)
        }
        _ = stop(VoWiFiHostStatusRequest(runtimeKey: request.runtimeKey))
        do {
            try FileManager.default.createDirectory(
                atPath: stateDirectory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let base = "\(stateDirectory)/\(request.runtimeKey)"
            let configPath = base + ".json"
            let statusPath = base + ".status.json"
            let logPath = base + ".log"
            let configuration = RuntimeConfiguration(
                sessionID: request.sessionID,
                simBridgeHost: request.simBridgeHost,
                simBridgeToken: request.simBridgeToken,
                outerInterface: request.outerInterface,
                outerGateway: request.outerGateway,
                outerLocalIP: request.outerLocalIP,
                proxyURL: request.proxyURL,
                statusPath: statusPath,
                tunMTU: request.tunMTU
            )
            let data = try JSONEncoder().encode(configuration)
            try data.write(to: URL(fileURLWithPath: configPath), options: .atomic)
            _ = chmod(configPath, S_IRUSR | S_IWUSR)
            try? FileManager.default.removeItem(atPath: statusPath)
            FileManager.default.createFile(atPath: logPath, contents: nil)
            _ = chmod(logPath, S_IRUSR | S_IWUSR)
            let logHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: logPath))
            try logHandle.truncate(atOffset: 0)

            let process = Process()
            process.executableURL = URL(fileURLWithPath: runtimePath)
            process.arguments = ["run", configPath]
            process.standardOutput = logHandle
            process.standardError = logHandle
            process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
            try process.run()
            runtimes[request.runtimeKey] = ManagedRuntime(
                process: process,
                logHandle: logHandle,
                configurationPath: configPath,
                statusPath: statusPath
            )
            process.terminationHandler = { [weak self] terminated in
                // The service serializes all public calls on its mutation queue;
                // only close the independent log handle here. Dictionary cleanup
                // happens on the next status/start/stop operation.
                try? logHandle.close()
                if terminated.terminationStatus != 0 {
                    NSLog("VoDogVoWiFiRuntime exited status=%d", terminated.terminationStatus)
                }
                _ = self
            }
            return (.success("VoWiFi runtime 已启动。"), readStatus(at: statusPath))
        } catch {
            return (.failure("无法启动 VoWiFi runtime：\(error.localizedDescription)"), nil)
        }
    }

    func stop(_ request: VoWiFiHostStatusRequest) -> HelperActionResult {
        guard validate(runtimeKey: request.runtimeKey) else {
            return .failure("VoWiFi runtime key 无效。")
        }
        guard let runtime = runtimes.removeValue(forKey: request.runtimeKey) else {
            removeStateFiles(for: request.runtimeKey)
            return .success("VoWiFi runtime 已停止。")
        }
        if runtime.process.isRunning {
            runtime.process.terminate()
            let deadline = Date().addingTimeInterval(8)
            while runtime.process.isRunning, Date() < deadline {
                usleep(50_000)
            }
            if runtime.process.isRunning {
                kill(runtime.process.processIdentifier, SIGKILL)
            }
        }
        try? runtime.logHandle.close()
        removeStateFiles(for: request.runtimeKey)
        return .success("VoWiFi runtime 已停止。")
    }

    func query(_ request: VoWiFiHostStatusRequest) -> (HelperActionResult, Data?) {
        guard validate(runtimeKey: request.runtimeKey) else {
            return (.failure("VoWiFi runtime key 无效。"), nil)
        }
        let path = runtimes[request.runtimeKey]?.statusPath ??
            "\(stateDirectory)/\(request.runtimeKey).status.json"
        if let runtime = runtimes[request.runtimeKey], !runtime.process.isRunning {
            runtimes[request.runtimeKey] = nil
        }
        guard let data = readStatus(at: path) else {
            return (.success("VoWiFi runtime 未运行。"), nil)
        }
        return (.success("VoWiFi runtime 状态已读取。"), data)
    }

    private func readStatus(at path: String) -> Data? {
        try? Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe)
    }

    private func removeStateFiles(for runtimeKey: String) {
        let base = "\(stateDirectory)/\(runtimeKey)"
        for suffix in [".json", ".status.json"] {
            try? FileManager.default.removeItem(atPath: base + suffix)
        }
    }

    private func validate(_ request: VoWiFiHostStartRequest) -> Bool {
        guard validate(runtimeKey: request.runtimeKey),
              isLowercaseHex(request.sessionID, range: 16 ... 64),
              isLowercaseHex(request.simBridgeToken, range: 32 ... 64),
              request.simBridgeHost.range(
                of: #"^127\.0\.0\.1:[0-9]{1,5}$"#,
                options: .regularExpression
              ) != nil,
              request.outerInterface.range(
                of: #"^(?:en|bridge)[0-9]{1,3}$"#,
                options: .regularExpression
              ) != nil,
              (1_200 ... 1_500).contains(request.tunMTU) else {
            return false
        }
        if let gateway = request.outerGateway, !gateway.isEmpty,
           !isIPAddress(gateway) { return false }
        if let localIP = request.outerLocalIP, !localIP.isEmpty,
           !isIPAddress(localIP) { return false }
        if let proxy = request.proxyURL, !proxy.isEmpty {
            guard let components = URLComponents(string: proxy),
                  components.scheme?.lowercased() == "socks5",
                  components.host != nil,
                  components.port.map({ (1 ... 65_535).contains($0) }) == true else {
                return false
            }
        }
        return true
    }

    private func validate(runtimeKey: String) -> Bool {
        runtimeKey.range(of: #"^[a-z0-9]{8,80}$"#, options: .regularExpression) != nil
    }

    private func isLowercaseHex(_ value: String, range: ClosedRange<Int>) -> Bool {
        range.contains(value.count) &&
            value.range(of: #"^[0-9a-f]+$"#, options: .regularExpression) != nil
    }

    private func isIPAddress(_ value: String) -> Bool {
        var ipv4 = in_addr()
        var ipv6 = in6_addr()
        return value.withCString {
            inet_pton(AF_INET, $0, &ipv4) == 1 || inet_pton(AF_INET6, $0, &ipv6) == 1
        }
    }
}
