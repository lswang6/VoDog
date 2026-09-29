import Foundation
import VoDogNetworkIPC

final class NetworkHelperClient {
    private enum PingResult {
        case ready
        case unavailable(String)
        case incompatible(Int)
        case outdated
    }

    private let queue = DispatchQueue(label: "org.vodog.macos.network.helper.client")
    private let installer = NetworkHelperInstaller()

    func startVoWiFiHost(
        _ request: VoWiFiHostStartRequest,
        completion: @escaping (Result<Data?, Error>) -> Void
    ) {
        queue.async { [weak self] in
            self?.ensureReady { result in
                switch result {
                case .success:
                    self?.invokeVoWiFiStart(request, completion: completion)
                case let .failure(error):
                    completion(.failure(error))
                }
            }
        }
    }

    func stopVoWiFiHost(
        runtimeKey: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        queue.async { [weak self] in
            self?.ensureReady { result in
                switch result {
                case .success:
                    self?.invokeVoWiFiStop(runtimeKey: runtimeKey, completion: completion)
                case let .failure(error):
                    completion(.failure(error))
                }
            }
        }
    }

    func queryVoWiFiHost(
        runtimeKey: String,
        completion: @escaping (Result<Data?, Error>) -> Void
    ) {
        queue.async { [weak self] in
            self?.ensureReady { result in
                switch result {
                case .success:
                    self?.invokeVoWiFiQuery(runtimeKey: runtimeKey, completion: completion)
                case let .failure(error):
                    completion(.failure(error))
                }
            }
        }
    }

    func applyCellularNetworkConfiguration(
        _ request: CellularNetworkConfigurationRequest,
        completion: @escaping (CellularNetworkActionResult) -> Void
    ) {
        queue.async { [weak self] in
            self?.ensureHelperThenApply(
                request,
                completion: completion
            )
        }
    }

    private func ensureHelperThenApply(
        _ request: CellularNetworkConfigurationRequest,
        completion: @escaping (CellularNetworkActionResult) -> Void
    ) {
        ping { [weak self] result in
            guard let self else { return }
            switch result {
            case .ready:
                self.invokeApply(request, completion: completion)
            case .unavailable, .incompatible, .outdated:
                switch self.installer.install() {
                case .success:
                    self.waitForInstalledHelper(
                        request: request,
                        attemptsRemaining: 12,
                        completion: completion
                    )
                case let .failure(error):
                    completion(.failure(error.localizedDescription, reason: .other))
                }
            }
        }
    }

    private func waitForInstalledHelper(
        request: CellularNetworkConfigurationRequest,
        attemptsRemaining: Int,
        completion: @escaping (CellularNetworkActionResult) -> Void
    ) {
        ping { [weak self] result in
            guard let self else { return }
            switch result {
            case .ready:
                self.invokeApply(request, completion: completion)
            case let .incompatible(version):
                completion(.failure(
                    L10n.tr(
                        "已安装的网络 helper 协议版本为 %lld，但 VoDog 需要 %lld。请重新安装最新版。",
                        Int64(version),
                        Int64(VoDogNetworkIPC.protocolVersion)
                    ),
                    reason: .other
                ))
            case .outdated:
                completion(.failure(
                    L10n.tr("网络 helper 已安装，但版本仍不是当前版本。请重新安装最新版。"),
                    reason: .other
                ))
            case let .unavailable(message):
                guard attemptsRemaining > 1 else {
                    completion(.failure(
                        L10n.tr("网络 helper 已安装，但未能启动：%@", message),
                        reason: .other
                    ))
                    return
                }
                self.queue.asyncAfter(deadline: .now() + .milliseconds(250)) {
                    self.waitForInstalledHelper(
                        request: request,
                        attemptsRemaining: attemptsRemaining - 1,
                        completion: completion
                    )
                }
            }
        }
    }

    private func ping(completion: @escaping (PingResult) -> Void) {
        let connection = makeConnection()
        let gate = OneShot<PingResult> { [queue] result in
            connection.invalidate()
            queue.async { completion(result) }
        }
        connection.resume()
        queue.asyncAfter(deadline: .now() + .seconds(4)) {
            gate.resolve(.unavailable(L10n.tr("连接超时")))
        }
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
            gate.resolve(.unavailable(error.localizedDescription))
        }) as? VoDogNetworkHelperProtocol else {
            gate.resolve(.unavailable(L10n.tr("无法建立 XPC 代理")))
            return
        }
        proxy.ping { version, identity in
            if version != VoDogNetworkIPC.protocolVersion {
                gate.resolve(.incompatible(version))
            } else if identity != VoDogNetworkIPC.helperIdentity {
                gate.resolve(.outdated)
            } else {
                gate.resolve(.ready)
            }
        }
    }

    private func invokeApply(
        _ request: CellularNetworkConfigurationRequest,
        completion: @escaping (CellularNetworkActionResult) -> Void
    ) {
        let connection = makeConnection()
        let gate = OneShot<CellularNetworkActionResult> { [queue] result in
            connection.invalidate()
            queue.async { completion(result) }
        }
        connection.resume()
        // Budget per newly enabled module: up to 30s waiting for the ECM carrier
        // plus up to 20s for configd's DHCP attempt and one verified client
        // reset. Cold-starting two modules at once is the worst case, so this is
        // a safety net for a wedged helper rather than an expected wait.
        queue.asyncAfter(deadline: .now() + .seconds(120)) {
            gate.resolve(.failure(
                L10n.tr("网络 helper 操作超时；未继续重试，以免重复修改。"),
                reason: .other
            ))
        }
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
            gate.resolve(.failure(
                L10n.error("网络 helper 连接中断：%@", underlying: error),
                reason: .other
            ))
        }) as? VoDogNetworkHelperProtocol else {
            gate.resolve(.failure(L10n.tr("无法建立网络 helper XPC 代理。"), reason: .other))
            return
        }
        guard let requestData = try? JSONEncoder().encode(request) else {
            gate.resolve(.failure(L10n.tr("无法编码蜂窝网络配置。"), reason: .other))
            return
        }
        proxy.applyCellularNetworkConfiguration(requestData) { rawCode, message in
            switch VoDogNetworkResultCode(rawValue: rawCode) {
            case .success:
                gate.resolve(.success(message))
            case .linkInactive:
                gate.resolve(.failure(message, reason: .linkInactive))
            case .dhcpTimeout:
                gate.resolve(.failure(message, reason: .dhcpTimeout))
            case .failure, nil:
                gate.resolve(.failure(message, reason: .other))
            }
        }
    }

    private func makeConnection() -> NSXPCConnection {
        let connection = NSXPCConnection(
            machServiceName: VoDogNetworkIPC.helperLabel,
            options: .privileged
        )
        connection.remoteObjectInterface = NSXPCInterface(with: VoDogNetworkHelperProtocol.self)
        return connection
    }

    private func ensureReady(completion: @escaping (Result<Void, Error>) -> Void) {
        ping { [weak self] result in
            guard let self else { return }
            switch result {
            case .ready:
                completion(.success(()))
            case .unavailable, .incompatible, .outdated:
                switch self.installer.install() {
                case .success:
                    self.waitUntilReady(attemptsRemaining: 12, completion: completion)
                case let .failure(error):
                    completion(.failure(error))
                }
            }
        }
    }

    private func waitUntilReady(
        attemptsRemaining: Int,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        ping { [weak self] result in
            guard let self else { return }
            switch result {
            case .ready:
                completion(.success(()))
            case let .unavailable(message):
                guard attemptsRemaining > 1 else {
                    completion(.failure(VoWiFiHostClientError.helperUnavailable(message)))
                    return
                }
                self.queue.asyncAfter(deadline: .now() + .milliseconds(250)) {
                    self.waitUntilReady(
                        attemptsRemaining: attemptsRemaining - 1,
                        completion: completion
                    )
                }
            case .incompatible, .outdated:
                completion(.failure(VoWiFiHostClientError.helperUnavailable(
                    L10n.tr("网络 helper 版本不兼容。")
                )))
            }
        }
    }

    private func invokeVoWiFiStart(
        _ request: VoWiFiHostStartRequest,
        completion: @escaping (Result<Data?, Error>) -> Void
    ) {
        invokeVoWiFiData(method: .start, request: request, completion: completion)
    }

    private func invokeVoWiFiQuery(
        runtimeKey: String,
        completion: @escaping (Result<Data?, Error>) -> Void
    ) {
        invokeVoWiFiData(
            method: .query,
            request: VoWiFiHostStatusRequest(runtimeKey: runtimeKey),
            completion: completion
        )
    }

    private enum VoWiFiDataMethod { case start, query }

    private func invokeVoWiFiData<Request: Encodable>(
        method: VoWiFiDataMethod,
        request: Request,
        completion: @escaping (Result<Data?, Error>) -> Void
    ) {
        guard let data = try? JSONEncoder().encode(request) else {
            completion(.failure(VoWiFiHostClientError.invalidRequest))
            return
        }
        let connection = makeConnection()
        let gate = OneShot<Result<Data?, Error>> { [queue] result in
            connection.invalidate()
            queue.async { completion(result) }
        }
        connection.resume()
        queue.asyncAfter(deadline: .now() + .seconds(20)) {
            gate.resolve(.failure(VoWiFiHostClientError.timeout))
        }
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
            gate.resolve(.failure(error))
        }) as? VoDogNetworkHelperProtocol else {
            gate.resolve(.failure(VoWiFiHostClientError.helperUnavailable(
                L10n.tr("无法建立网络 helper XPC 代理。")
            )))
            return
        }
        let reply: (Int, String, Data?) -> Void = { code, message, response in
            if VoDogNetworkResultCode(rawValue: code) == .success {
                gate.resolve(.success(response))
            } else {
                gate.resolve(.failure(VoWiFiHostClientError.helperFailure(message)))
            }
        }
        switch method {
        case .start: proxy.startVoWiFiHost(data, reply: reply)
        case .query: proxy.queryVoWiFiHost(data, reply: reply)
        }
    }

    private func invokeVoWiFiStop(
        runtimeKey: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        guard let data = try? JSONEncoder().encode(
            VoWiFiHostStatusRequest(runtimeKey: runtimeKey)
        ) else {
            completion(.failure(VoWiFiHostClientError.invalidRequest))
            return
        }
        let connection = makeConnection()
        let gate = OneShot<Result<Void, Error>> { [queue] result in
            connection.invalidate()
            queue.async { completion(result) }
        }
        connection.resume()
        queue.asyncAfter(deadline: .now() + .seconds(15)) {
            gate.resolve(.failure(VoWiFiHostClientError.timeout))
        }
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
            gate.resolve(.failure(error))
        }) as? VoDogNetworkHelperProtocol else {
            gate.resolve(.failure(VoWiFiHostClientError.helperUnavailable(
                L10n.tr("无法建立网络 helper XPC 代理。")
            )))
            return
        }
        proxy.stopVoWiFiHost(data) { code, message in
            if VoDogNetworkResultCode(rawValue: code) == .success {
                gate.resolve(.success(()))
            } else {
                gate.resolve(.failure(VoWiFiHostClientError.helperFailure(message)))
            }
        }
    }
}

private enum VoWiFiHostClientError: LocalizedError {
    case invalidRequest
    case timeout
    case helperUnavailable(String)
    case helperFailure(String)

    var errorDescription: String? {
        switch self {
        case .invalidRequest: return L10n.tr("无法编码 VoWiFi 请求。")
        case .timeout: return L10n.tr("VoWiFi helper 操作超时。")
        case let .helperUnavailable(message), let .helperFailure(message): return message
        }
    }
}

private final class OneShot<Value> {
    private let lock = NSLock()
    private var action: ((Value) -> Void)?

    init(_ action: @escaping (Value) -> Void) {
        self.action = action
    }

    func resolve(_ value: Value) {
        let callback: ((Value) -> Void)? = lock.withLock {
            defer { action = nil }
            return action
        }
        callback?(value)
    }
}
