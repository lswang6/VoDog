import Foundation
import Network

struct VoWiFiATResult: Sendable {
    let output: String
    let error: String?

    var isSuccess: Bool { error == nil }
}

private struct VoWiFiSIMBridgeRequest: Decodable {
    let token: String
    let command: String
    let timeoutMS: Int

    enum CodingKeys: String, CodingKey {
        case token, command
        case timeoutMS = "timeout_ms"
    }
}

private struct VoWiFiSIMBridgeResponse: Encodable {
    let ok: Bool
    let output: String
    let error: String?
}

enum VoWiFiSIMBridgeError: LocalizedError {
    case listener(String)
    case notReady

    var errorDescription: String? {
        switch self {
        case let .listener(message):
            return L10n.tr("无法启动 VoWiFi SIM 鉴权桥：%@", message)
        case .notReady:
            return L10n.tr("VoWiFi SIM 鉴权桥尚未就绪。")
        }
    }
}

/// A loopback-only, capability-scoped bridge between the privileged Go runtime
/// and the single AT transport already owned by VoDog. Every request carries
/// an unguessable session token and is restricted to identity/APDU commands;
/// the runtime can never dial, reset the modem, or alter radio configuration.
final class VoWiFiSIMBridge {
    typealias Executor = (
        _ command: String,
        _ timeoutMilliseconds: Int,
        _ completion: @escaping (VoWiFiATResult) -> Void
    ) -> Void

    let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    private(set) var host: String?

    private let queue: DispatchQueue
    private let executor: Executor
    private var listener: NWListener?

    init(moduleID: CellularModuleID, executor: @escaping Executor) {
        queue = DispatchQueue(label: "org.vodog.vowifi.sim-bridge.\(moduleID.rawValue)")
        self.executor = executor
    }

    func start(completion: @escaping (Result<String, Error>) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.listener == nil else {
                if let host = self.host {
                    DispatchQueue.main.async { completion(.success(host)) }
                } else {
                    DispatchQueue.main.async { completion(.failure(VoWiFiSIMBridgeError.notReady)) }
                }
                return
            }
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(
                    host: .ipv4(.loopback),
                    port: .any
                )
                let listener = try NWListener(using: parameters)
                self.listener = listener
                var completed = false
                listener.stateUpdateHandler = { [weak self, weak listener] state in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        guard !completed, let port = listener?.port else { return }
                        completed = true
                        let host = "127.0.0.1:\(port.rawValue)"
                        self.host = host
                        DispatchQueue.main.async { completion(.success(host)) }
                    case let .failed(error):
                        self.listener = nil
                        self.host = nil
                        guard !completed else { return }
                        completed = true
                        DispatchQueue.main.async {
                            completion(.failure(VoWiFiSIMBridgeError.listener(error.localizedDescription)))
                        }
                    default:
                        break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    self?.accept(connection)
                }
                listener.start(queue: self.queue)
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    func stop() {
        queue.async { [weak self] in
            self?.listener?.cancel()
            self?.listener = nil
            self?.host = nil
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.stateUpdateHandler = { state in
            if case .failed = state { connection.cancel() }
        }
        connection.start(queue: queue)
        receive(on: connection, accumulated: Data())
    }

    private func receive(on connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8 * 1_024) {
            [weak self] data, _, isComplete, error in
            guard let self else {
                connection.cancel()
                return
            }
            var requestData = accumulated
            if let data { requestData.append(data) }
            guard requestData.count <= 8 * 1_024 else {
                self.respond(.init(ok: false, output: "", error: "request-too-large"), on: connection)
                return
            }
            if error != nil {
                connection.cancel()
                return
            }
            if !isComplete, !requestData.contains(0x0A) {
                self.receive(on: connection, accumulated: requestData)
                return
            }
            guard let request = try? JSONDecoder().decode(
                VoWiFiSIMBridgeRequest.self,
                from: requestData
            ), request.token == self.token else {
                self.respond(.init(ok: false, output: "", error: "unauthorized"), on: connection)
                return
            }
            guard Self.isAllowed(command: request.command) else {
                self.respond(.init(ok: false, output: "", error: "command-not-allowed"), on: connection)
                return
            }
            let timeout = min(max(request.timeoutMS, 1_000), 20_000)
            self.executor(request.command, timeout) { [weak self] result in
                self?.queue.async {
                    self?.respond(.init(
                        ok: result.isSuccess,
                        output: result.output,
                        error: result.error
                    ), on: connection)
                }
            }
        }
    }

    private func respond(_ response: VoWiFiSIMBridgeResponse, on connection: NWConnection) {
        guard var data = try? JSONEncoder().encode(response) else {
            connection.cancel()
            return
        }
        data.append(0x0A)
        connection.send(content: data, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    static func isAllowed(command rawCommand: String) -> Bool {
        guard let command = try? ATConsoleCommandValidator.validate(rawCommand) else {
            return false
        }
        let compact = command
            .uppercased()
            .replacingOccurrences(of: " ", with: "")
        if ["AT+CIMI", "AT+CGSN", "AT+CGSN=1", "AT+GSN", "AT+CPIN?"].contains(compact) {
            return true
        }
        let patterns = [
            #"^AT\+CCHO=\"[0-9A-F]+\"$"#,
            #"^AT\+CCHC=[0-9]+$"#,
            #"^AT\+CGLA=[0-9]+,[0-9]+,\"[0-9A-F]+\"$"#,
            #"^AT\+CSIM=[0-9]+,\"[0-9A-F]+\"$"#,
            #"^AT\+CRSM=[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+(?:,\"[0-9A-F]*\")?(?:,\"[0-9A-F]*\")?$"#
        ]
        return patterns.contains { compact.range(of: $0, options: .regularExpression) != nil }
    }
}
