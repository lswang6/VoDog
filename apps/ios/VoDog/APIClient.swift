import Foundation

enum APIError: LocalizedError {
    case invalidResponse, unauthorized, server(Int, String, String?)
    var errorDescription: String? {
        switch self {
        case .invalidResponse: "服务器响应无效"
        case .unauthorized: "登录已失效"
        case let .server(status, message, code):
            Self.codeTitles[code ?? ""] ?? (message.isEmpty ? "请求失败（\(status)）" : message)
        }
    }

    /// S72：这两个 409 固定写中文，不看服务端 message。
    static let codeTitles: [String: String] = [
        "SAME_DEVICE_INTERNAL": "同一设备上的两张卡不能互打",
        "OWN_OUTGOING_CALL": "这是你正在拨出的通话",
    ]

    /// Dial path: Control's validation / fallback messages are English ("Request validation failed"); show Chinese.
    static func dialMessage(for error: Error) -> String {
        guard case let .server(status, _, code)? = error as? APIError else { return error.localizedDescription }
        if code == "INVALID_REQUEST" { return "号码格式不正确，无法拨打" }
        let text = error.localizedDescription
        return text.contains(where: { ("\u{4E00}"..."\u{9FFF}").contains($0) }) ? text : "拨打失败（\(code ?? String(status))）"
    }

    var serverCode: String? {
        if case let .server(_, _, code) = self { return code }
        return nil
    }

    /// S36 C3: the HTTP status a diagnostic records; `0` for a response that never parsed.
    var diagCode: Int {
        switch self {
        case .invalidResponse: 0
        case .unauthorized: 401
        case let .server(status, _, _): status
        }
    }
}

struct APIClient: Sendable {
    static var baseURL: URL { AppRuntimeConfiguration.apiBaseURL }
    let token: String?
    var session: URLSession = .shared

    func request<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ path: String, method: String = "GET", body: Body? = Optional<String>.none,
        idempotencyKey: String? = nil, timeoutInterval: TimeInterval? = nil,
        queryItems: [URLQueryItem] = [], headers: [String: String] = [:]
    ) async throws -> Response {
        let url = try Self.url(path, queryItems: queryItems)
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let timeoutInterval { request.timeoutInterval = timeoutInterval }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        // S36 C3: `X-Diag-Source` is the only caller today; auth still decides who the events belong to.
        for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw APIError.server(http.statusCode, envelope?.error.message ?? "", envelope?.error.code)
        }
        if data.isEmpty, Response.self == EmptyResponse.self { return EmptyResponse() as! Response }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    func recordingPreflight(_ path: String, source: RecordingSource) async throws -> RecordingPreflightResponse {
        var request = URLRequest(url: try Self.url(path, queryItems: [.init(name: "source", value: source.rawValue)]))
        request.httpMethod = "GET"
        request.setValue(source == .pixel ? "audio/wav" : "audio/ogg", forHTTPHeaderField: "Accept")
        request.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let http = try await RecordingHeaderProbe.run(request: request, configuration: session.configuration)
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 || http.statusCode == 206 else { throw APIError.server(http.statusCode, "", nil) }
        return RecordingPreflightResponse(http)
    }

    /// S36 C4: `format` asks the server to transcode (only `mp3` today). Playback never passes it, so in-app
    /// URLs stay on the original container.
    func download(_ path: String, source: RecordingSource = .mediaNode, disposition: String? = nil,
                  format: String? = nil) async throws -> DownloadedFile {
        var items = [URLQueryItem(name: "source", value: source.rawValue)]
        if let disposition { items.append(URLQueryItem(name: "disposition", value: disposition)) }
        if let format { items.append(URLQueryItem(name: "format", value: format)) }
        var request = URLRequest(url: try Self.url(path, queryItems: items))
        request.httpMethod = "GET"
        request.setValue(RecordingAttachmentName.mediaType(source: source, format: format), forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (temporaryURL, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse else {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw APIError.invalidResponse
        }
        if http.statusCode == 401 { try? FileManager.default.removeItem(at: temporaryURL); throw APIError.unauthorized }
        guard http.statusCode == 200 else {
            let message = boundedErrorMessage(at: temporaryURL)
            try? FileManager.default.removeItem(at: temporaryURL)
            throw APIError.server(http.statusCode, message, nil)
        }
        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first.map(String.init)
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "vodog-recording-\(UUID().uuidString).\(RecordingAttachmentName.fileExtension(source: source, format: format))"
            )
        do { try FileManager.default.moveItem(at: temporaryURL, to: destination) }
        catch { try? FileManager.default.removeItem(at: temporaryURL); throw error }
        return DownloadedFile(
            url: destination, contentType: contentType, contentLength: http.expectedContentLength,
            etag: http.value(forHTTPHeaderField: "ETag"), acceptRanges: http.value(forHTTPHeaderField: "Accept-Ranges"),
            contentRange: http.value(forHTTPHeaderField: "Content-Range"), statusCode: http.statusCode,
            contentDisposition: http.value(forHTTPHeaderField: "Content-Disposition")
        )
    }

    /// URLComponents leaves "+" bare and Fastify decodes it as a space (S89 cursor "+08:00", "+86" lookups).
    static func url(_ path: String, queryItems: [URLQueryItem], base: URL = baseURL) throws -> URL {
        var components = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)
        if !queryItems.isEmpty {
            components?.queryItems = queryItems
            let encoded = components?.percentEncodedQuery
            components?.percentEncodedQuery = encoded?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let result = components?.url else { throw APIError.invalidResponse }
        return result
    }

    private func boundedErrorMessage(at url: URL) -> String {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber,
              size.intValue <= 64 * 1024, let data = try? Data(contentsOf: url) else { return "" }
        return (try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error.message) ?? ""
    }

    private struct ErrorEnvelope: Decodable { let error: ErrorBody }
    private struct ErrorBody: Decodable {
        let code: String?
        let message: String
        enum CodingKeys: String, CodingKey { case code, message }
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            code = try container.decodeIfPresent(String.self, forKey: .code)
            message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
        }
    }
}

enum AppRuntimeConfiguration {
    static let productionAPIBaseURL = URL(string: "https://\(Bundle.main.object(forInfoDictionaryKey: "VoDogDomain") as? String ?? "vodog.example.com")/api/v1")!
    static let productionKeychainService = "org.vodog"
    static let isolatedSimulatorKeychainService = "org.vodog.s33-local-ui"

    /// S33's real-backend UI suite is allowed to target one isolated loopback service. The compiler removes this
    /// branch from device and Release builds, and strict equality keeps an injected value from becoming an
    /// arbitrary clear-text endpoint.
    static func simulatorUITestAPIBaseURL(environment: [String: String]) -> URL? {
        #if DEBUG && targetEnvironment(simulator)
        guard environment["VODOG_UI_TEST_API_BASE_URL"] == "http://127.0.0.1:16880/api/v1" else { return nil }
        return URL(string: "http://127.0.0.1:16880/api/v1")
        #else
        return nil
        #endif
    }

    static var isolatedSimulatorUITestEnabled: Bool {
        simulatorUITestAPIBaseURL(environment: ProcessInfo.processInfo.environment) != nil
    }

    static var apiBaseURL: URL {
        simulatorUITestAPIBaseURL(environment: ProcessInfo.processInfo.environment) ?? productionAPIBaseURL
    }

    static var keychainService: String {
        keychainService(environment: ProcessInfo.processInfo.environment)
    }

    static func keychainService(environment: [String: String]) -> String {
        simulatorUITestAPIBaseURL(environment: environment) == nil
            ? productionKeychainService : isolatedSimulatorKeychainService
    }
}

struct DownloadedFile: Sendable {
    let url: URL
    let contentType: String?
    let contentLength: Int64
    let etag: String?
    let acceptRanges: String?
    let contentRange: String?
    let statusCode: Int
    let contentDisposition: String?
}

struct RecordingPreflightResponse: Sendable {
    let statusCode: Int; let contentType: String?; let contentLength: Int64
    let etag: String?; let acceptRanges: String?; let contentRange: String?
    init(_ response: HTTPURLResponse) {
        statusCode = response.statusCode
        contentType = response.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first.map(String.init)
        contentLength = response.expectedContentLength
        etag = response.value(forHTTPHeaderField: "ETag")
        acceptRanges = response.value(forHTTPHeaderField: "Accept-Ranges")
        contentRange = response.value(forHTTPHeaderField: "Content-Range")
    }
}

enum RecordingResponseValidator {
    static func validatePreflight(_ response: RecordingPreflightResponse, artifact: RecordingArtifact) -> Bool {
        validatePreflight(response, artifact: artifact.playbackArtifact)
    }
    static func validatePreflight(_ response: RecordingPreflightResponse, artifact: PlaybackArtifact) -> Bool {
        guard response.contentType == artifact.mediaType, response.etag == "\"\(artifact.sha256)\"",
              response.acceptRanges?.lowercased() == "bytes" else { return false }
        if response.statusCode == 206 {
            return response.contentLength == 1 && response.contentRange == "bytes 0-0/\(artifact.bytes)"
        }
        return response.statusCode == 200 && response.contentLength == artifact.bytes
    }
    static func validateDownload(_ file: DownloadedFile, artifact: RecordingArtifact) -> Bool {
        validateDownload(file, artifact: artifact.playbackArtifact)
    }
    static func validateDownload(_ file: DownloadedFile, artifact: PlaybackArtifact) -> Bool {
        file.statusCode == 200 && file.contentType == artifact.mediaType && file.contentLength == artifact.bytes
            && file.etag == "\"\(artifact.sha256)\"" && file.acceptRanges?.lowercased() == "bytes"
            && file.contentRange == nil
    }
}

private final class RecordingHeaderProbe: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<HTTPURLResponse, Error>?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var finished = false

    static func run(request: URLRequest, configuration: URLSessionConfiguration) async throws -> HTTPURLResponse {
        let probe = RecordingHeaderProbe()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in probe.start(request, configuration, continuation) }
        } onCancel: { probe.cancel() }
    }

    private func start(_ request: URLRequest, _ configuration: URLSessionConfiguration,
                       _ continuation: CheckedContinuation<HTTPURLResponse, Error>) {
        lock.lock()
        guard !finished else { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
        self.continuation = continuation
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        task = session.dataTask(with: request)
        let task = self.task
        lock.unlock()
        task?.resume()
    }

    private func cancel() {
        lock.lock(); let task = task; lock.unlock()
        task?.cancel()
        finish(.failure(CancellationError()))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler(.cancel)
        guard let http = response as? HTTPURLResponse else { finish(.failure(APIError.invalidResponse)); return }
        finish(.success(http))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)) }
    }

    private func finish(_ result: Result<HTTPURLResponse, Error>) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true; let continuation = continuation; self.continuation = nil
        let session = session; self.session = nil; task = nil
        lock.unlock()
        session?.finishTasksAndInvalidate()
        continuation?.resume(with: result)
    }
}

private extension URL {
    func appending(path: String) -> URL {
        path.split(separator: "/").reduce(self) { $0.appendingPathComponent(String($1)) }
    }
}
