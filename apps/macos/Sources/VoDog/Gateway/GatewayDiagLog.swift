import Foundation
import os

// VoDog gateway diagnostics (S36/S36b/S52 parity with the Pixel gateway's GatewayDiag.kt).
// Every event goes to Apple's unified log and a rolling JSON-lines file; everything above `debug`
// also goes to a bounded on-disk queue that the agent uploads to `POST /api/v1/diag/events`.
// Thread-safe: media and recording code log from their own queues.

/// Message bodies never leave the device. S69 decision 6 (2026-09-26): phone numbers stay in full during
/// the trial (supersedes S52's last-4 masking); only the module IMEI is still masked to its last 4.
enum GatewayDiagPrivacy {
    static func mask(_ number: String) -> String {
        let digits = number.filter(\.isNumber)
        return digits.count <= 4 ? "***" : "***" + String(digits.suffix(4))
    }

    static func sanitize(_ fields: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in fields {
            let lower = key.lowercased()
            if ["body", "text", "content"].contains(lower) {
                result[key] = "[redacted]"
            } else if lower.contains("imei"), let text = value as? String {
                result[key] = mask(text)
            } else if let nested = value as? [String: Any] {
                result[key] = sanitize(nested)
            } else {
                result[key] = value
            }
        }
        return result
    }
}

/// `gateway.log` plus `gateway.log.1` … `.N-1`, each capped at `maxBytes`.
final class GatewayRollingLog {
    private let url: URL
    private let maxBytes: Int
    private let files: Int
    private var handle: FileHandle?
    private var size = 0

    init(url: URL, maxBytes: Int = 5 * 1_024 * 1_024, files: Int = 3) {
        self.url = url
        self.maxBytes = maxBytes
        self.files = max(1, files)
    }

    func append(_ line: String) {
        let data = Data((line + "\n").utf8)
        if handle == nil { open() }
        if size > 0, size + data.count > maxBytes { rotate() }
        handle?.write(data)
        size += data.count
    }

    private func open() {
        let manager = FileManager.default
        try? manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !manager.fileExists(atPath: url.path) { manager.createFile(atPath: url.path, contents: nil) }
        handle = try? FileHandle(forWritingTo: url)
        size = Int((try? handle?.seekToEnd()) ?? 0)
    }

    private func rotate() {
        try? handle?.close()
        handle = nil
        let manager = FileManager.default
        func rotated(_ index: Int) -> URL { URL(fileURLWithPath: url.path + ".\(index)") }
        try? manager.removeItem(at: rotated(files - 1))
        if files > 1 {
            for index in stride(from: files - 2, through: 1, by: -1) {
                try? manager.moveItem(at: rotated(index), to: rotated(index + 1))
            }
            try? manager.moveItem(at: url, to: rotated(1))
        } else {
            try? manager.removeItem(at: url)
        }
        open()
    }
}

/// Upload queue: append-only JSON lines on disk, oldest dropped past `limit` (reported as `diag.dropped`).
final class GatewayDiagQueue {
    private let url: URL
    private let limit: Int
    private(set) var items: [String]
    private(set) var dropped = 0

    init(url: URL, limit: Int = 2_000) {
        self.url = url
        self.limit = limit
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        items = text.split(separator: "\n").map(String.init)
        trim()
    }

    func append(_ line: String) {
        items.append(line)
        if items.count > limit {
            trim()
        } else {
            appendToFile(line)
        }
    }

    /// Next upload batch (`queued` of them from the queue); a pending drop count rides along as
    /// one extra `diag.dropped` row.
    func batch(max: Int = 200, droppedItem: (Int) -> String) -> (lines: [String], queued: Int) {
        var lines = Array(items.prefix(max))
        let queued = lines.count
        if dropped > 0 { lines.append(droppedItem(dropped)) }
        return (lines, queued)
    }

    /// The server accepted the first `count` queued items (and the drop report, if any).
    func commit(_ count: Int) {
        items.removeFirst(min(count, items.count))
        dropped = 0
        rewrite()
    }

    private func trim() {
        guard items.count > limit else { return }
        dropped += items.count - limit
        items.removeFirst(items.count - limit)
        rewrite()
    }

    private func appendToFile(_ line: String) {
        if let handle = try? FileHandle(forWritingTo: url) {
            _ = try? handle.seekToEnd()
            handle.write(Data((line + "\n").utf8))
            try? handle.close()
        } else {
            rewrite()
        }
    }

    private func rewrite() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let text = items.isEmpty ? "" : items.joined(separator: "\n") + "\n"
        try? Data(text.utf8).write(to: url, options: .atomic)
    }
}

final class GatewayDiagLog: @unchecked Sendable {
    static let shared = GatewayDiagLog(
        defaults: .standard,
        queueURL: AppDataDirectory.userApplicationSupport()
            .appendingPathComponent("gateway", isDirectory: true)
            .appendingPathComponent("diag-queue.jsonl"),
        logURL: FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/VoDog/gateway.log")
    )

    let installId: String
    /// S69 top-level `appVersion` on every row, stamped when recorded: `CFBundleShortVersionString(CFBundleVersion)`.
    static let appVersion: String = {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?")(\(info?["CFBundleVersion"] as? String ?? "?"))"
    }()

    /// S69 `gateway.error` identity: HTTP failures by status, everything else by NSError domain/code
    /// (never `"\(error)"`, whose NSError form carries pointer addresses).
    static func errorIdentity(_ error: Error) -> (domain: String, code: Int, serverCode: String?) {
        if let http = error as? GatewayHTTPError { return ("http", http.status, http.code) }
        let ns = error as NSError
        return (ns.domain, ns.code, nil)
    }

    /// Diag fields for a caught error: `{domain, code, serverCode?, message}`, message short and with any
    /// `0x…` pointer address removed (bridged NSError descriptions carry them).
    /// S69: a short, aggregatable reason (`<domain>_<code>`) for fields that must stay one string.
    static func errorReason(_ error: Error) -> String {
        let identity = errorIdentity(error)
        return "\(identity.domain)_\(identity.code)"
    }

    static func errorFields(_ error: Error) -> [String: Any] {
        let identity = errorIdentity(error)
        let text = error.localizedDescription.replacingOccurrences(of: "0x[0-9a-fA-F]+", with: "0x…",
                                                                   options: .regularExpression)
        var fields: [String: Any] = ["domain": identity.domain, "code": identity.code, "message": String(text.prefix(120))]
        if let serverCode = identity.serverCode { fields["serverCode"] = serverCode }
        return fields
    }

    private let defaults: UserDefaults
    private let lock = NSLock()
    private let queue: GatewayDiagQueue
    private let file: GatewayRollingLog
    private var seq: Int
    private var loggers: [String: Logger] = [:]
    private static let installKey = "VoDogGateway.diagInstallId.v1"
    private static let seqKey = "VoDogGateway.diagSeq.v1"

    init(defaults: UserDefaults, queueURL: URL, logURL: URL, queueLimit: Int = 2_000,
         logMaxBytes: Int = 5 * 1_024 * 1_024) {
        self.defaults = defaults
        if let existing = defaults.string(forKey: Self.installKey) {
            installId = existing
        } else {
            installId = UUID().uuidString.lowercased()
            defaults.set(installId, forKey: Self.installKey)
        }
        seq = defaults.integer(forKey: Self.seqKey)
        queue = GatewayDiagQueue(url: queueURL, limit: queueLimit)
        file = GatewayRollingLog(url: logURL, maxBytes: logMaxBytes)
    }

    var pendingCount: Int { lock.withLock { queue.items.count } }

    /// `debug` stays on this Mac (unified log + file); everything else is also queued for upload.
    func record(_ event: String, level: String = "info", callId: String? = nil, fields: [String: Any] = [:]) {
        lock.withLock {
            seq += 1
            defaults.set(seq, forKey: Self.seqKey)
            var clean = GatewayDiagPrivacy.sanitize(fields)
            clean["seq"] = seq
            var item: [String: Any] = ["ts": GatewayJSON.iso(Date()), "level": level, "event": String(event.prefix(120)),
                                       "fields": clean, "appVersion": Self.appVersion]
            if let callId, UUID(uuidString: callId) != nil { item["callId"] = callId }
            // JSONSerialization raises (not throws) on non-JSON values; never let a bad field crash the app.
            if !JSONSerialization.isValidJSONObject(item) {
                item["fields"] = ["seq": seq, "invalid": true]
            } else if GatewayJSON.string(clean).utf8.count > 4_000 {
                // Control drops rows whose fields exceed 4096 bytes; keep the row, lose the detail.
                item["fields"] = ["seq": seq, "truncated": true]
            }
            let line = GatewayJSON.string(item)
            logger(for: event).log(level: Self.osLevel(level), "\(event, privacy: .public) \(line, privacy: .public)")
            file.append(line)
            if level != "debug" { queue.append(line) }
        }
    }

    /// Local-only error trail (unified log + file), never uploaded.
    func local(_ event: String, _ message: String) {
        record(event, level: "debug", fields: ["message": message])
    }

    func nextBatch() -> (lines: [String], queued: Int) {
        lock.withLock {
            queue.batch { count in
                seq += 1
                defaults.set(seq, forKey: Self.seqKey)
                return GatewayJSON.string(["ts": GatewayJSON.iso(Date()), "level": "warn", "event": "diag.dropped",
                                           "fields": ["count": count, "seq": seq], "appVersion": Self.appVersion])
            }
        }
    }

    func commit(_ count: Int) {
        lock.withLock { queue.commit(count) }
    }

    private func logger(for event: String) -> Logger {
        let category = String(event.split(separator: ".").first ?? "gateway")
        if let logger = loggers[category] { return logger }
        let logger = Logger(subsystem: "org.vodog.macos.gateway", category: category)
        loggers[category] = logger
        return logger
    }

    private static func osLevel(_ level: String) -> OSLogType {
        switch level {
        case "debug": return .debug
        case "warn": return .default
        case "error": return .error
        default: return .info
        }
    }
}
