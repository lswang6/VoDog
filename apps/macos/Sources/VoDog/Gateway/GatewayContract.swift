import Foundation

/// Configure before launch; changing the server requires a fresh sign-in/pairing.
enum VoDogServer {
    static func validatedURL(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value),
              url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        return url
    }
    static var baseURL: URL {
        validatedURL(ProcessInfo.processInfo.environment["VODOG_BASE_URL"])
            ?? validatedURL(UserDefaults.standard.string(forKey: "VoDogBaseURL"))
            ?? URL(string: "https://vodog.example.invalid")!
    }
}

// VoDog gateway (spec: vodog docs/specs/S53-dji4g-celldock-gateway.md).
// Shared seam between the control agent (GatewayAgent*, owner A) and the media/recording side
// (GatewayMedia*, GatewayRecording*, owner B). Change a signature here only with both sides.

struct GatewayCredentials: Codable, Equatable {
    var baseURL: URL
    var deviceToken: String
    var gatewayId: String
    var deviceEpoch: Int
}

struct GatewayCapture: Codable, Equatable {
    var deviceCallId: String
    var telecomCreationTimeMillis: Int64
}

/// Structured diagnostic sink (`POST /api/v1/diag/events`); implemented by the agent.
typealias GatewayDiag = (_ event: String, _ level: String, _ callId: String?, _ fields: [String: Any]) -> Void

struct GatewayHTTPError: Error, CustomStringConvertible {
    var status: Int
    var code: String?
    var body: Data
    var description: String { "HTTP \(status) \(code ?? "")" }
}

// MARK: - Transport failures

/// Transport failures after which pooled connections are dropped and the user sees a short message.
enum GatewayNetworkIssue: String {
    case timeout, connectionLost, cannotConnect, offline, tls

    init?(_ error: Error) {
        guard let error = error as? URLError else { return nil }
        switch error.code {
        case .timedOut: self = .timeout
        case .networkConnectionLost: self = .connectionLost
        case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed: self = .cannotConnect
        case .notConnectedToInternet: self = .offline
        case .secureConnectionFailed: self = .tls
        default: return nil
        }
    }
}

/// Minimal authenticated client for `/api/v1/...`. Non-2xx throws `GatewayHTTPError`.
/// Owns a private control-plane session: after a transport failure the pooled connections are
/// dropped so the next request opens a fresh TCP/TLS connection instead of reusing a stalled one.
final class GatewayHTTP {
    let credentials: GatewayCredentials
    private let lock = NSLock()
    private var currentSession: URLSession

    init(credentials: GatewayCredentials) {
        self.credentials = credentials
        currentSession = Self.makeSession()
    }

    deinit { currentSession.finishTasksAndInvalidate() }

    var session: URLSession { lock.withLock { currentSession } }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }

    /// New requests get a fresh session; requests already in flight on the old one (media offer,
    /// doorbell) are allowed to finish rather than being cancelled.
    func resetConnections() {
        let old = lock.withLock { () -> URLSession in
            let old = currentSession
            currentSession = Self.makeSession()
            return old
        }
        old.finishTasksAndInvalidate()
    }

    func send(_ method: String, _ path: String, body: Data? = nil,
              contentType: String = "application/json", timeout: TimeInterval = 20) async throws -> Data {
        var request = URLRequest(url: credentials.baseURL.appendingPathComponent("api/v1" + path), timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("Bearer \(credentials.deviceToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            if GatewayNetworkIssue(error) != nil { resetConnections() }
            throw error
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let code = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
                .flatMap { $0["error"] as? [String: Any] }?["code"] as? String
            throw GatewayHTTPError(status: status, code: code, body: data)
        }
        return data
    }

    func json(_ method: String, _ path: String, _ body: [String: Any]? = nil, timeout: TimeInterval = 20) async throws -> [String: Any] {
        let data = try await send(method, path, body: try body.map { try JSONSerialization.data(withJSONObject: $0) }, timeout: timeout)
        return data.isEmpty ? [:] : ((try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
    }
}

// Owner B: GatewayMediaSession lives in GatewayMedia.swift, GatewayRecordingArchive in
// GatewayRecording.swift (public surface unchanged).
