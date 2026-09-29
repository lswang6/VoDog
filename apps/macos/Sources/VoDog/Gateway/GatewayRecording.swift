import CryptoKit
import Foundation
import zlib

// P3 recording archive (spec S53 「录音归档」). Local files and field names follow the Pixel
// gateway exactly (apps/android/gateway LocalCallRecorder.kt / GatewayRecordingArchive.kt), the
// upload manifest follows services/control/src/recording-archive.ts, and the WAV/timeline shapes
// are what services/recording-archive-validator accepts.

enum GatewayArchivePaths {
    static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("VoDog/gateway/archive", isDirectory: true)
    }
}

/// Crash-tolerant 16 kHz mono PCM16 WAV + timeline writer for one call. Not thread-safe; the
/// media session serializes access under its own lock.
final class GatewayCallRecorder {
    static let sampleRate = 16_000
    static let headerBytes = 44
    private static let bytesPerSecond = Int64(sampleRate * 2)
    private static let frameToleranceUs: Int64 = 2_000

    private final class Track {
        let stem: String
        let handle: FileHandle
        var pcmBytes: Int64 = 0
        var gapCount: Int64 = 0
        var droppedFrames: Int64 = 0
        var recoveryFrames: Int64 = 0
        var nextTimestampUs: Int64?

        init(directory: URL, stem: String) throws {
            self.stem = stem
            let url = directory.appendingPathComponent("\(stem).wav.part")
            FileManager.default.createFile(atPath: url.path, contents: Data(count: GatewayCallRecorder.headerBytes))
            handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
        }
    }

    let callId: String
    let directory: URL
    private let timeline: FileHandle
    private let remote: Track
    private let caller: Track
    private var playout: Track?
    private let startedAt = Date()
    private var closed = false

    /// `binding` is the full `captureBinding` object from `media/options`; persisted as capture.json.
    init(root: URL = GatewayArchivePaths.root, callId: String, binding: [String: Any]) throws {
        guard UUID(uuidString: callId)?.uuidString.lowercased() == callId,
              binding["callId"] as? String == callId,
              binding["id"] is String, binding["captureGeneration"] is Int else {
            throw GatewayArchiveError.invalid("capture_binding")
        }
        self.callId = callId
        directory = root.appendingPathComponent(callId, isDirectory: true)
        let fm = FileManager.default
        if fm.fileExists(atPath: directory.path) {
            // A retried media leg for the same call reuses nothing: one recording per call.
            throw GatewayArchiveError.invalid("recording_exists")
        }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try canonicalJSON(binding).write(to: directory.appendingPathComponent("capture.json"), options: .atomic)
        remote = try Track(directory: directory, stem: "remote_original")
        caller = try Track(directory: directory, stem: "caller_original")
        let timelineURL = directory.appendingPathComponent("timeline.jsonl.part")
        fm.createFile(atPath: timelineURL.path, contents: nil)
        timeline = try FileHandle(forWritingTo: timelineURL)
        line(#"{"event":"start","timestampUs":0}"#)
    }

    /// Original tracks: `remote_original` (cellular party) or `caller_original` (decoded user audio).
    func append(_ stem: String, _ pcm: [Int16], timestampUs: Int64, sourceTimestampUs: Int64?) {
        guard !closed, !pcm.isEmpty, let track = stem == remote.stem ? remote : stem == caller.stem ? caller : nil else { return }
        let offset = write(track, pcm, timestampUs: timestampUs)
        line(#"{"event":"frame","track":"\#(stem)","timestampUs":\#(timestampUs),"sourceTimestampUs":\#(sourceTimestampUs.map(String.init) ?? "null"),"fileOffset":\#(offset),"sampleCount":\#(pcm.count)}"#)
    }

    /// Derived `caller_playout`: what was written to the modem, PLC frames labelled.
    func appendPlayout(_ pcm: [Int16], timestampUs: Int64, sourceTimestampUs: Int64?, recoveryKind: String?) {
        guard !closed, !pcm.isEmpty else { return }
        guard let track = playout ?? (try? Track(directory: directory, stem: "caller_playout")) else { return }
        playout = track
        let offset = write(track, pcm, timestampUs: timestampUs)
        if recoveryKind != nil { track.recoveryFrames += 1 }
        let recovery = recoveryKind.map { #","recoveryKind":"\#($0)""# } ?? ""
        line(#"{"event":"playout_frame","track":"caller_playout","timestampUs":\#(timestampUs),"sourceTimestampUs":\#(sourceTimestampUs.map(String.init) ?? "null"),"fileOffset":\#(offset),"sampleCount":\#(pcm.count)\#(recovery)}"#)
    }

    func markDropped(_ stem: String, timestampUs: Int64, frames: Int64) {
        guard !closed, frames > 0, let track = stem == remote.stem ? remote : stem == caller.stem ? caller : nil else { return }
        track.droppedFrames += frames
        track.gapCount += 1
        line(#"{"event":"gap","track":"\#(stem)","timestampUs":\#(timestampUs),"reason":"local_queue_drop","frames":\#(frames)}"#)
    }

    private func write(_ track: Track, _ pcm: [Int16], timestampUs: Int64) -> Int64 {
        if let expected = track.nextTimestampUs, timestampUs > expected + Self.frameToleranceUs {
            track.gapCount += 1
            line(#"{"event":"gap","track":"\#(track.stem)","timestampUs":\#(expected),"durationUs":\#(timestampUs - expected)}"#)
        }
        let offset = Int64(Self.headerBytes) + track.pcmBytes
        let bytes = pcm.withUnsafeBufferPointer { Data(buffer: $0) } // host order is little-endian on Apple silicon/Intel
        track.handle.write(bytes)
        track.pcmBytes += Int64(bytes.count)
        track.nextTimestampUs = timestampUs + Int64(bytes.count) * 1_000_000 / Self.bytesPerSecond
        return offset
    }

    private func line(_ text: String) {
        timeline.write(Data((text + "\n").utf8))
    }

    /// Seals every file and writes manifest.json (Android LocalRecordingManifest shape).
    /// `terminalState`: ended | failed | incomplete. `mediaFatal` marks captures incomplete.
    func finish(terminalState: String, mediaFatal: Bool, stats: [String: Int]) throws {
        guard !closed else { return }
        closed = true
        line(#"{"event":"stop","state":"\#(terminalState)"}"#)
        try timeline.synchronize()
        try timeline.close()
        try Self.rename(directory, "timeline.jsonl.part", "timeline.jsonl")
        func seal(_ track: Track) throws -> [String: Any] {
            try Self.writeHeader(track.handle, pcmBytes: track.pcmBytes)
            try track.handle.synchronize()
            try track.handle.close()
            try Self.rename(directory, "\(track.stem).wav.part", "\(track.stem).wav")
            let url = directory.appendingPathComponent("\(track.stem).wav")
            return ["file": "\(track.stem).wav", "bytes": Int(track.pcmBytes) + Self.headerBytes,
                    "sha256": try sha256Hex(url), "pcmBytes": Int(track.pcmBytes), "gapCount": Int(track.gapCount)]
        }
        var tracks: [String: Any] = [:]
        for track in [remote, caller] {
            var value = try seal(track)
            value["droppedFrames"] = Int(track.droppedFrames)
            value["captureComplete"] = track.pcmBytes > 0 && track.gapCount == 0 && track.droppedFrames == 0 && !mediaFatal
            tracks[track.stem] = value
        }
        var manifest: [String: Any] = [
            "version": 2, "callId": callId, "terminalState": terminalState,
            "startedAt": isoMillis(startedAt), "endedAt": isoMillis(Date()), "tracks": tracks,
            "sessionStats": stats,
            "captureBinding": try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("capture.json"))),
        ]
        if let playout {
            var value = try seal(playout)
            value["recoveryFrames"] = Int(playout.recoveryFrames)
            value["playoutComplete"] = playout.pcmBytes > 0 && playout.gapCount == 0
            manifest["derivedTracks"] = ["caller_playout": value]
            manifest["version"] = 3
        }
        let timelineURL = directory.appendingPathComponent("timeline.jsonl")
        manifest["timeline"] = ["file": "timeline.jsonl", "bytes": try fileSize(timelineURL), "sha256": try sha256Hex(timelineURL)]
        try canonicalJSON(manifest).write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
    }

    static func writeHeader(_ handle: FileHandle, pcmBytes: Int64) throws {
        var h = Data()
        func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { h.append(contentsOf: $0) } }
        func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { h.append(contentsOf: $0) } }
        h.append(contentsOf: Array("RIFF".utf8)); le32(UInt32(pcmBytes + 36)); h.append(contentsOf: Array("WAVEfmt ".utf8))
        le32(16); le16(1); le16(1); le32(UInt32(sampleRate)); le32(UInt32(sampleRate * 2)); le16(2); le16(16)
        h.append(contentsOf: Array("data".utf8)); le32(UInt32(pcmBytes))
        try handle.seek(toOffset: 0)
        handle.write(h)
    }

    /// Seals a directory whose writer died with the process: WAV headers from file lengths, the
    /// timeline cut at its last complete line, terminalState `recovered_incomplete`.
    static func recoverIncomplete(_ directory: URL) throws {
        let fm = FileManager.default
        let callId = directory.lastPathComponent
        var tracks: [String: Any] = [:]
        var derived: [String: Any] = [:]
        for stem in ["remote_original", "caller_original", "caller_playout"] {
            let part = directory.appendingPathComponent("\(stem).wav.part")
            let wav = directory.appendingPathComponent("\(stem).wav")
            if fm.fileExists(atPath: part.path) {
                let handle = try FileHandle(forUpdating: part)
                let size = max(Int64(headerBytes), Int64(try handle.seekToEnd()))
                let pcm = (size - Int64(headerBytes)) & ~1
                try handle.truncate(atOffset: UInt64(pcm) + UInt64(headerBytes))
                try writeHeader(handle, pcmBytes: pcm)
                try handle.synchronize()
                try handle.close()
                try rename(directory, part.lastPathComponent, wav.lastPathComponent)
            }
            guard fm.fileExists(atPath: wav.path) else {
                if stem == "caller_playout" { continue }
                throw GatewayArchiveError.invalid("recovery_missing_track")
            }
            let bytes = try fileSize(wav)
            var value: [String: Any] = ["file": "\(stem).wav", "bytes": bytes, "sha256": try sha256Hex(wav),
                                        "pcmBytes": bytes - headerBytes, "gapCount": 1]
            if stem == "caller_playout" {
                value["recoveryFrames"] = 0
                value["playoutComplete"] = false
                derived[stem] = value
            } else {
                value["droppedFrames"] = 0
                value["captureComplete"] = false
                tracks[stem] = value
            }
        }
        let timeline = directory.appendingPathComponent("timeline.jsonl")
        let timelinePart = directory.appendingPathComponent("timeline.jsonl.part")
        if fm.fileExists(atPath: timelinePart.path) {
            var data = try Data(contentsOf: timelinePart)
            if let last = data.lastIndex(of: 0x0A) { data = data.prefix(through: last) } else { data = Data() }
            data.append(Data(#"{"event":"stop","state":"recovered_incomplete"}"#.utf8 + [0x0A]))
            try data.write(to: timeline, options: .atomic)
            try fm.removeItem(at: timelinePart)
        } else if !fm.fileExists(atPath: timeline.path) {
            try Data(#"{"event":"recovered_incomplete"}"#.utf8 + [0x0A]).write(to: timeline, options: .atomic)
        }
        let started = (try? fm.attributesOfItem(atPath: directory.path)[.creationDate] as? Date) ?? Date()
        var manifest: [String: Any] = [
            "version": derived.isEmpty ? 2 : 3, "callId": callId, "terminalState": "recovered_incomplete",
            "startedAt": isoMillis(started), "endedAt": isoMillis(Date()), "tracks": tracks, "sessionStats": [String: Int](),
            "captureBinding": try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("capture.json"))),
            "timeline": ["file": "timeline.jsonl", "bytes": try fileSize(timeline), "sha256": try sha256Hex(timeline)],
        ]
        if !derived.isEmpty { manifest["derivedTracks"] = derived }
        try canonicalJSON(manifest).write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
    }

    private static func rename(_ directory: URL, _ from: String, _ to: String) throws {
        let target = directory.appendingPathComponent(to)
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: directory.appendingPathComponent(from), to: target)
    }
}

enum GatewayArchiveError: Error, CustomStringConvertible {
    case invalid(String)
    var description: String { if case let .invalid(code) = self { return code }; return "" }
}

// MARK: - Shared helpers

/// Control's `JSON.stringify(canonical(value))`: compact, keys sorted by UTF-16 code unit
/// (JSONSerialization's `.sortedKeys` is not: it orders `a` before `B`), `/` unescaped,
/// integers only.
func canonicalJSON(_ value: Any) throws -> Data {
    func encode(_ value: Any) throws -> String {
        switch value {
        case let object as [String: Any]:
            let keys = object.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            return "{" + (try keys.map { "\(try encode($0)):\(try encode(object[$0]!))" }).joined(separator: ",") + "}"
        case let array as [Any]:
            return "[" + (try array.map(encode)).joined(separator: ",") + "]"
        case let string as String:
            return String(decoding: try JSONSerialization.data(withJSONObject: string, options: [.fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
        case is NSNull:
            return "null"
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            guard !CFNumberIsFloatType(number), abs(number.int64Value) <= 9_007_199_254_740_991 else {
                throw GatewayArchiveError.invalid("canonical_number")
            }
            return String(number.int64Value)
        default:
            throw GatewayArchiveError.invalid("canonical_type")
        }
    }
    return Data(try encode(value).utf8)
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func sha256Hex(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty { hasher.update(data: chunk) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private func fileSize(_ url: URL) throws -> Int {
    (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
}

/// `Date.toISOString()` form (UTC, milliseconds) — Control normalizes to this before fingerprinting.
func isoMillis(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter.string(from: date)
}

/// RFC 1952 single member with a fixed header (no mtime/name, OS=255), raw deflate level 6,
/// CRC32 + ISIZE: the same bytes every time for the same input and zlib.
enum GatewayDeterministicGzip {
    static func compress(_ source: URL, to destination: URL) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let part = destination.appendingPathExtension("part")
        FileManager.default.createFile(atPath: part.path, contents: nil)
        let output = try FileHandle(forWritingTo: part)
        defer { try? output.close() }
        output.write(Data([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]))

        var stream = z_stream()
        guard deflateInit2_(&stream, 6, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY, zlibVersion(), Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
            throw GatewayArchiveError.invalid("gzip_init")
        }
        defer { deflateEnd(&stream) }
        var crc = crc32(0, nil, 0)
        var total: UInt64 = 0
        var out = [UInt8](repeating: 0, count: 64 * 1024)
        var finished = false
        while !finished {
            var chunk = try input.read(upToCount: 64 * 1024) ?? Data()
            let flush = chunk.isEmpty ? Z_FINISH : Z_NO_FLUSH
            total += UInt64(chunk.count)
            let count = chunk.count
            try chunk.withUnsafeMutableBytes { raw in
                let base = raw.bindMemory(to: Bytef.self).baseAddress
                if count > 0 { crc = crc32(crc, base, uInt(count)) }
                stream.next_in = base
                stream.avail_in = uInt(count)
                repeat {
                    let produced: Int = try out.withUnsafeMutableBufferPointer { buffer in
                        stream.next_out = buffer.baseAddress
                        stream.avail_out = uInt(buffer.count)
                        let status = deflate(&stream, flush)
                        guard status == Z_OK || status == Z_STREAM_END || status == Z_BUF_ERROR else {
                            throw GatewayArchiveError.invalid("gzip_deflate")
                        }
                        if status == Z_STREAM_END { finished = true }
                        return buffer.count - Int(stream.avail_out)
                    }
                    if produced > 0 { output.write(Data(out[0 ..< produced])) }
                } while stream.avail_out == 0 || (flush == Z_FINISH && !finished)
            }
        }
        var trailer = Data()
        withUnsafeBytes(of: UInt32(crc).littleEndian) { trailer.append(contentsOf: $0) }
        withUnsafeBytes(of: UInt32(truncatingIfNeeded: total).littleEndian) { trailer.append(contentsOf: $0) }
        output.write(trailer)
        try output.synchronize()
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: part, to: destination)
    }
}

// MARK: - Upload queue

/// P3: durable archive upload queue for finished calls (resumes across restarts).
/// Every enqueue scans the whole archive root, so older unfinished calls resume too.
/// Per call directory: capture.json + manifest.json (recorder) → *.gz + manifest.upload.json +
/// archive-upload.json (journal) → create/status → 1 MiB chunk PUTs → finalize → delete directory.
/// A verified 410 CALL_DELETED proof also deletes the directory (S39 §决策3).
enum GatewayRecordingArchive {
    static let chunkBytes = 1024 * 1024
    private static let lock = NSLock()
    /// S54: one Mac can run several gateways; every call directory records its gateway
    /// (`gateway-id`) and is uploaded with that gateway's own device token.
    private static var https: [String: GatewayHTTP] = [:]
    private static var diag: GatewayDiag?
    private static var worker: Task<Void, Never>?
    private static var wake = false
    /// Directories whose recorder is still writing (never recovered or uploaded).
    private static var active: Set<String> = []
    /// In-memory retry backoff, touched only by the single worker task; a restart retries at once.
    private static var backoff: [String: (attempt: Int, next: Date)] = [:]

    static func enqueueUpload(callId: String, http: GatewayHTTP, diag: @escaping GatewayDiag) {
        recordGateway(callId, http.credentials.gatewayId)
        register(http, diag: diag)
        lock.withLock {
            self.diag = diag
            active.remove(callId)
            wake = true
            if worker == nil { worker = Task.detached(priority: .utility) { await run() } }
        }
    }

    /// Each running gateway registers its client so leftover calls of that gateway resume after a restart.
    static func register(_ http: GatewayHTTP, diag: @escaping GatewayDiag) {
        lock.withLock {
            https[http.credentials.gatewayId] = http
            self.diag = diag
            wake = true
            if worker == nil { worker = Task.detached(priority: .utility) { await run() } }
        }
    }

    static func markActive(_ callId: String, gatewayId: String) {
        lock.withLock { _ = active.insert(callId) }
        recordGateway(callId, gatewayId)
    }

    private static func recordGateway(_ callId: String, _ gatewayId: String) {
        let directory = GatewayArchivePaths.root.appendingPathComponent(callId, isDirectory: true)
        let file = directory.appendingPathComponent("gateway-id")
        guard !FileManager.default.fileExists(atPath: file.path) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? Data(gatewayId.utf8).write(to: file, options: .atomic)
    }

    /// The call's own gateway; a pre-S54 directory without the file belongs to the only gateway
    /// that existed then, so it goes with the sole registered client (else waits).
    private static func client(for directory: URL, among https: [String: GatewayHTTP]) -> GatewayHTTP? {
        if let id = try? String(contentsOf: directory.appendingPathComponent("gateway-id"), encoding: .utf8) {
            return https[id.trimmingCharacters(in: .whitespacesAndNewlines)]
        }
        return https.count == 1 ? https.first?.value : nil
    }

    private static func run() async {
        while true {
            guard let (https, diag, busy) = lock.withLock({ () -> ([String: GatewayHTTP], GatewayDiag, Set<String>)? in
                wake = false
                guard !https.isEmpty, let diag else { return nil }
                return (https, diag, active)
            }) else { break }
            let retryAt = await pass(https: https, diag: diag, skipping: busy)
            let idle = lock.withLock { () -> Bool in
                if !wake && retryAt == nil { worker = nil; return true }
                return false
            }
            if idle { return }
            while let retryAt, Date() < retryAt, !lock.withLock({ wake }) {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        lock.withLock { worker = nil }
    }

    /// One sweep; returns the earliest time a backed-off call should be retried.
    private static func pass(https: [String: GatewayHTTP], diag: GatewayDiag, skipping busy: Set<String>) async -> Date? {
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: GatewayArchivePaths.root.path)) ?? []
        var retryAt: Date?
        for callId in names.sorted() where UUID(uuidString: callId)?.uuidString.lowercased() == callId && !busy.contains(callId) {
            let directory = GatewayArchivePaths.root.appendingPathComponent(callId, isDirectory: true)
            if let next = backoff[callId]?.next, next > Date() {
                retryAt = min(retryAt ?? next, next)
                continue
            }
            if Journal.read(directory)?.state == "blocked" { continue }
            // Not this Mac's gateway right now (module moved or not attached): leave it for later.
            guard let http = client(for: directory, among: https) else { continue }
            do {
                try await process(directory: directory, callId: callId, http: http, diag: diag)
                backoff[callId] = nil
            } catch {
                let (status, code) = (error as? GatewayHTTPError).map { ($0.status, $0.code ?? "HTTP_\($0.status)") } ?? (0, GatewayDiagLog.errorReason(error))
                if status == 422, var journal = Journal.read(directory) {
                    // Rejected by the validator or schema: retrying the frozen bytes cannot help.
                    journal.state = "blocked"
                    try? journal.write(directory)
                } else {
                    // 409 CALL_NOT_TERMINAL right after hangup, 5xx, network: 2^n s, capped at 1 h.
                    let attempt = min((backoff[callId]?.attempt ?? 0) + 1, 12)
                    let next = Date().addingTimeInterval(TimeInterval(min(1 << attempt, 3600)))
                    backoff[callId] = (attempt, next)
                    retryAt = min(retryAt ?? next, next)
                }
                diag("recording.archive_retry", status == 422 ? "error" : "warn", callId,
                     ["status": status, "code": String(code.prefix(80))])
            }
        }
        return retryAt
    }

    private static func process(directory: URL, callId: String, http: GatewayHTTP, diag: GatewayDiag) async throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: directory.appendingPathComponent("capture.json").path) else { return }
        if !fm.fileExists(atPath: directory.appendingPathComponent("manifest.json").path) {
            try GatewayCallRecorder.recoverIncomplete(directory)
            diag("recording.recovered_incomplete", "warn", callId, [:])
        }
        let capture = try jsonObject(Data(contentsOf: directory.appendingPathComponent("capture.json")))
        guard let generation = capture["captureGeneration"] as? Int else { throw GatewayArchiveError.invalid("capture_generation") }
        var journal = try Journal.read(directory) ?? prepare(directory: directory, capture: capture)
        let manifest = try Data(contentsOf: directory.appendingPathComponent("manifest.upload.json"))

        let response: [String: Any]
        do {
            if let uploadId = journal.uploadId {
                response = try await request(http, "GET", "/gateway/recording-archives/\(uploadId)",
                                             query: ["callId": callId, "generation": String(generation)])
            } else {
                response = try await request(http, "POST", "/gateway/calls/\(callId)/recording-archives",
                                             body: manifest, contentType: "application/json")
            }
        } catch let error as GatewayHTTPError where error.status == 410 && error.code == "CALL_DELETED" {
            try requireDeletionProof(error.body, callId: callId, generation: generation)
            try purge(directory)
            diag("recording.deleted_cleanup", "info", callId, [:])
            return
        }
        guard let upload = response["upload"] as? [String: Any], let uploadId = upload["id"] as? String,
              let objects = upload["objects"] as? [[String: Any]] else {
            throw GatewayArchiveError.invalid("upload_response")
        }
        guard upload["manifestSha256"] as? String == journal.manifestSha256 else {
            // Frozen bytes can never match on retry: park it for inspection.
            throw GatewayHTTPError(status: 422, code: "manifest_fingerprint_mismatch", body: Data())
        }
        journal.uploadId = uploadId
        for object in objects {
            guard let name = object["name"] as? String, let index = journal.objects.firstIndex(where: { $0.name == name }),
                  object["expectedBytes"] as? Int == journal.objects[index].compressedBytes,
                  let committed = object["committedOffset"] as? Int else { throw GatewayArchiveError.invalid("upload_objects") }
            journal.objects[index].committedOffset = committed
        }
        try journal.write(directory)
        switch upload["state"] as? String {
        case "complete":
            try purge(directory)
            return
        case "rejected":
            throw GatewayHTTPError(status: 422, code: "archive_rejected", body: Data())
        default: break
        }

        for index in journal.objects.indices {
            let object = journal.objects[index]
            let file = try FileHandle(forReadingFrom: directory.appendingPathComponent(object.name))
            defer { try? file.close() }
            var offset = object.committedOffset
            while offset < object.compressedBytes {
                try file.seek(toOffset: UInt64(offset))
                let chunk = try file.read(upToCount: min(chunkBytes, object.compressedBytes - offset)) ?? Data()
                guard !chunk.isEmpty else { throw GatewayArchiveError.invalid("short_read") }
                let digest = Data(SHA256.hash(data: chunk)).base64EncodedString()
                let put = try await request(http, "PUT", "/gateway/recording-archives/\(uploadId)/objects/\(object.name)",
                                            body: chunk, contentType: "application/octet-stream",
                                            headers: ["Content-Range": "bytes \(offset)-\(offset + chunk.count - 1)/\(object.compressedBytes)",
                                                      "Digest": "sha-256=\(digest)"])
                guard let value = put["object"] as? [String: Any], value["name"] as? String == object.name,
                      let committed = value["committedOffset"] as? Int, committed >= offset + chunk.count,
                      committed <= object.compressedBytes else { throw GatewayArchiveError.invalid("put_response") }
                offset = committed
                journal.objects[index].committedOffset = committed
                try journal.write(directory)
            }
        }
        let finalized = try await request(http, "POST", "/gateway/recording-archives/\(uploadId)/finalize")
        guard let archive = finalized["archive"] as? [String: Any], archive["state"] as? String == "complete",
              archive["manifestSha256"] as? String == journal.manifestSha256 else {
            throw GatewayArchiveError.invalid("finalize_response")
        }
        try purge(directory)
        diag("recording.archived", "info", callId, ["objects": journal.objects.count])
    }

    /// Compresses once, freezes the upload manifest + journal. Never recompresses afterwards.
    static func prepare(directory: URL, capture: [String: Any]) throws -> Journal {
        let local = try jsonObject(Data(contentsOf: directory.appendingPathComponent("manifest.json")))
        let version = local["version"] as? Int ?? 2
        guard let tracks = local["tracks"] as? [String: Any], let timeline = local["timeline"] as? [String: Any],
              let startedAt = local["startedAt"] as? String, let endedAt = local["endedAt"] as? String,
              var terminal = local["terminalState"] as? String else { throw GatewayArchiveError.invalid("local_manifest") }
        if terminal == "completed" { terminal = "ended" }
        var objects: [Journal.Object] = []
        func compress(_ file: String) throws -> Journal.Object {
            let source = directory.appendingPathComponent(file)
            let target = directory.appendingPathComponent(file + ".gz")
            try GatewayDeterministicGzip.compress(source, to: target)
            let object = Journal.Object(name: file + ".gz", compressedBytes: try fileSize(target), compressedSha256: try sha256Hex(target),
                                        originalBytes: try fileSize(source), originalSha256: try sha256Hex(source), committedOffset: 0)
            objects.append(object)
            return object
        }
        let pcm: [String: Any] = ["sampleRate": 16000, "channels": 1, "bitsPerSample": 16, "encoding": "pcm_s16le"]
        func sizes(_ o: Journal.Object) -> [String: Any] {
            ["objectName": o.name, "compressedBytes": o.compressedBytes, "compressedSha256": o.compressedSha256,
             "originalBytes": o.originalBytes, "originalSha256": o.originalSha256]
        }
        var trackEntries: [[String: Any]] = []
        for stem in ["remote_original", "caller_original"] {
            guard let track = tracks[stem] as? [String: Any] else { throw GatewayArchiveError.invalid("local_track") }
            var entry = sizes(try compress("\(stem).wav"))
            entry["track"] = stem
            entry["mediaType"] = "audio/wav"
            entry["pcm"] = pcm
            for key in ["pcmBytes", "gapCount", "droppedFrames"] { entry[key] = track[key] as? Int ?? 0 }
            entry["captureComplete"] = track["captureComplete"] as? Bool ?? false
            trackEntries.append(entry)
        }
        var upload: [String: Any] = [
            "version": version,
            "captureBinding": ["id": capture["id"] ?? "", "deviceCallId": capture["deviceCallId"] ?? "",
                               "telecomCreationTimeMillis": capture["telecomCreationTimeMillis"] ?? 0,
                               "captureGeneration": capture["captureGeneration"] ?? 0],
            "startedAt": startedAt, "endedAt": endedAt, "terminalState": terminal, "tracks": trackEntries,
        ]
        if version == 3 {
            guard let playout = (local["derivedTracks"] as? [String: Any])?["caller_playout"] as? [String: Any] else {
                throw GatewayArchiveError.invalid("local_derived")
            }
            var entry = sizes(try compress("caller_playout.wav"))
            entry["track"] = "caller_playout"
            entry["sourceRole"] = "derived_playout"
            entry["mediaType"] = "audio/wav"
            entry["pcm"] = pcm
            for key in ["pcmBytes", "gapCount", "recoveryFrames"] { entry[key] = playout[key] as? Int ?? 0 }
            entry["playoutComplete"] = playout["playoutComplete"] as? Bool ?? false
            upload["derivedTracks"] = [entry]
        }
        guard timeline["file"] as? String == "timeline.jsonl" else { throw GatewayArchiveError.invalid("local_timeline") }
        var timelineEntry = sizes(try compress("timeline.jsonl"))
        timelineEntry["mediaType"] = "application/x-ndjson"
        upload["timeline"] = timelineEntry
        // Control defaults sessionStats to {} before fingerprinting, so it is always sent.
        let stats = local["sessionStats"] as? [String: Any] ?? [:]
        upload["sessionStats"] = stats.filter {
            ["networkSendDrops", "remotePacketDrops", "injectionDrops", "transportMissingPackets"].contains($0.key)
        }
        let bytes = try canonicalJSON(upload)
        try bytes.write(to: directory.appendingPathComponent("manifest.upload.json"), options: .atomic)
        let journal = Journal(manifestSha256: sha256Hex(bytes), objects: objects)
        try journal.write(directory)
        return journal
    }

    /// Exact S39 shape: {error:{code,message,requestId,details:{deletion:{callId,gatewayGeneration,archive}}}}.
    private static func requireDeletionProof(_ body: Data, callId: String, generation: Int) throws {
        let error = try jsonObject(body)["error"] as? [String: Any]
        let deletion = (error?["details"] as? [String: Any])?["deletion"] as? [String: Any]
        guard error?["code"] as? String == "CALL_DELETED", deletion?["callId"] as? String == callId,
              deletion?["gatewayGeneration"] as? Int == generation, deletion?["archive"] is [String: Any] else {
            throw GatewayArchiveError.invalid("deletion_proof")
        }
    }

    private static func purge(_ directory: URL) throws {
        let staging = directory.deletingLastPathComponent().appendingPathComponent(".archive-cleanup-" + directory.lastPathComponent)
        try? FileManager.default.removeItem(at: staging)
        try FileManager.default.moveItem(at: directory, to: staging)
        try FileManager.default.removeItem(at: staging)
    }

    /// `GatewayHTTP.send` cannot carry Content-Range/Digest or a query, so archive calls build
    /// their own request from the same credentials. No Content-Type on an empty body (Fastify
    /// rejects an empty application/json body).
    private static func request(_ http: GatewayHTTP, _ method: String, _ path: String, query: [String: String] = [:],
                                body: Data? = nil, contentType: String? = nil, headers: [String: String] = [:]) async throws -> [String: Any] {
        var components = URLComponents(url: http.credentials.baseURL.appendingPathComponent("api/v1" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!, timeoutInterval: 60)
        request.httpMethod = method
        request.setValue("Bearer \(http.credentials.deviceToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
        request.httpBody = body ?? (method == "POST" ? Data() : nil)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            let code = ((try? jsonObject(data))?["error"] as? [String: Any])?["code"] as? String
            throw GatewayHTTPError(status: status, code: code, body: data)
        }
        return try jsonObject(data)
    }

    private static func jsonObject(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GatewayArchiveError.invalid("json")
        }
        return value
    }

    struct Journal: Codable {
        struct Object: Codable {
            var name: String
            var compressedBytes: Int
            var compressedSha256: String
            var originalBytes: Int
            var originalSha256: String
            var committedOffset: Int
        }

        var uploadId: String?
        var manifestSha256: String
        var objects: [Object]
        var state = "uploading"

        static func read(_ directory: URL) -> Journal? {
            (try? Data(contentsOf: directory.appendingPathComponent("archive-upload.json")))
                .flatMap { try? JSONDecoder().decode(Journal.self, from: $0) }
        }

        func write(_ directory: URL) throws {
            try JSONEncoder().encode(self).write(to: directory.appendingPathComponent("archive-upload.json"), options: .atomic)
        }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
