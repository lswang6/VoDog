import AVFoundation
import CallKit
import CoreTelephony
import Foundation
import Network
import UIKit
import UserNotifications

/// S36 C3: structured client diagnostics.
///
/// Every interesting moment — a dial, a media handshake step, an audio route change, an API failure — becomes
/// one small JSON object in a bounded in-memory ring. The ring is POSTed to `diag/events` every 60 s, as soon
/// as it holds 50 events, and when the app goes to the background; a failed POST is retried exactly once.
///
/// S36b D1: a batch that still fails is no longer thrown away — it is spooled to a JSON-lines file in
/// Application Support (newest 2000 events) and uploaded before anything else on the next flush or launch, so
/// the events that explain a failure survive the failure. Each flush also carries `client.snapshot` (the
/// device's battery/thermal/network/audio situation) and re-emits `client.context` whenever a value in it
/// changed, which is what lets an AI read one install's timeline without asking the user anything.
///
/// `log` is deliberately not actor-isolated: it is called from WebRTC's `nonisolated` delegates, from a
/// notification queue, from `NWPathMonitor`'s queue and from the uncaught-exception handler on the crashing
/// thread. Only the upload and the collectors hop to the main actor, where `SessionStore` and UIKit live.
final class Diag: @unchecked Sendable {
    static let shared = Diag()
    /// The `X-Diag-Source` value Control authorises; `device` and `userId` come from the session, never from here.
    static let source = "ios"
    private static let ringLimit = 500
    private static let spoolLimit = 2000
    private static let flushThreshold = 50
    private static let batchLimit = 200
    private static let flushInterval: Duration = .seconds(60)
    private static let fieldLimit = 200
    private static let fieldCount = 32
    /// A crash's stack is the one field worth more than a phone number's worth of characters — and still
    /// small enough that the whole event fits the 4 KiB `fields` budget Control enforces.
    private static let crashFieldLimit = 2_500
    /// D1: at most one snapshot a minute while foreground; entering the background always takes one.
    private static let snapshotInterval: TimeInterval = 55

    private let lock = NSLock()
    private var ring: [DiagEvent] = []
    /// Events recovered from the spool. Kept apart from `ring` so a live event can never trim a persisted one.
    private var backlog: [DiagEvent] = []
    private var sequence = 0
    /// Events the ring dropped since the last snapshot reported it — D1's `seqDropped`.
    private var dropped = 0
    private var session: SessionStore?
    private var flushing = false
    private var monitor: NWPathMonitor?
    private var flushTask: Task<Void, Never>?
    private var installId = ""
    private var lastContext: [String: DiagValue]?
    private var lastSnapshotAt: Date?
    private var lastThermal: ProcessInfo.ThermalState?
    private var batteryLowLogged = false
    private var devicesStarted = false
    private var callObserver: CXCallObserver?
    private var cellularData: CTCellularData?
    private var telephony: CTTelephonyNetworkInfo?
    /// The last network summary, attached to every event so the reader never has to correlate timestamps to
    /// know whether a failing handshake was on Wi-Fi or cellular.
    private var networkLabel: String?
    private let timestamps = ISO8601DateFormatter()
    private let launchedAt = Date()
    private var coalescer = DiagCoalescer()

    /// S69: stamped on every event when it is recorded, so a spooled event keeps the build that produced it.
    static let appVersion: String = {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short)(\(build))"
    }()

    nonisolated(unsafe) private static var previousExceptionHandler: (@convention(c) (NSException) -> Void)?
    nonisolated(unsafe) private static var crashHandlerInstalled = false

    private init() {
        timestamps.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }

    /// Wired once, next to the other singletons, when the session becomes usable.
    @MainActor func attach(session: SessionStore) {
        lock.withLock { self.session = session }
        startNetworkMonitor()
        startFlushLoop()
        startDeviceMonitors()
        Task { await refreshContext() }
    }

    func log(_ event: String, _ fields: [String: Any] = [:], callId: String? = nil) {
        append(event, fields, callId: callId, limit: Self.fieldLimit)
    }

    /// `coalesceKey`: S69 — a repeat of the key within 60 s bumps `repeat` on the row still in the ring
    /// instead of adding a row (see `DiagCoalescer`).
    private func append(
        _ event: String, _ fields: [String: Any], callId: String?, limit: Int,
        coalesceKey: String? = nil, now: Date = Date()
    ) {
        var encoded = Self.encode(fields, limit: limit)
        let shouldFlush: Bool = lock.withLock {
            if let coalesceKey, let seq = coalescer.openSeq(for: coalesceKey, now: now) {
                if let index = ring.lastIndex(where: { $0.fields["seq"] == .int(seq) }) {
                    let count = if case let .int(value)? = ring[index].fields["repeat"] { value } else { 1 }
                    ring[index].fields["repeat"] = .int(count + 1)
                } else {
                    coalescer.carry(coalesceKey)
                }
                return false
            }
            sequence += 1
            encoded["seq"] = .int(sequence)
            if let coalesceKey {
                let count = coalescer.open(coalesceKey, seq: sequence, now: now)
                if count > 1 { encoded["repeat"] = .int(count) }
            }
            if let networkLabel { encoded["network"] = .string(networkLabel) }
            ring.append(DiagEvent(
                ts: timestamps.string(from: now), level: Self.level(for: event, fields: encoded), event: event,
                callId: callId?.lowercased(), fields: encoded, appVersion: Self.appVersion
            ))
            if ring.count > Self.ringLimit {
                let over = ring.count - Self.ringLimit
                ring.removeFirst(over)
                dropped += over
            }
            return ring.count >= Self.flushThreshold && !flushing
        }
        if shouldFlush { flush() }
    }

    func flush() {
        Task { @MainActor in await self.upload() }
    }

    /// An event names its own severity so `log` keeps one argument list. S69: `api.error` is always warn (error is
    /// kept for what already hurt a call or data), and any event carrying `ok:false` is at least warn.
    static func level(for event: String, fields: [String: DiagValue] = [:]) -> String {
        let base = switch event {
        case "app.crash", "callkit.action_failed", "media.grace_expired": "error"
        case "api.error", "ui.error_shown", "diag.dropped", "battery.low", "callkit.reset", "audio.unit_failed",
             "push.apns_failed": "warn"
        default: event.hasSuffix(".failed") || event.hasSuffix(".error") ? "error" : "info"
        }
        return base == "info" && fields["ok"] == .bool(false) ? "warn" : base
    }

    /// Milliseconds since a monotonic mark — the one elapsed-time helper for the whole app.
    static func ms(since start: ContinuousClock.Instant) -> Int {
        let elapsed = start.duration(to: .now).components
        return Int(elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000)
    }

    /// `[String: Any]` is what a call site can write; this is where it becomes something encodable.
    static func encode(_ fields: [String: Any], limit: Int) -> [String: DiagValue] {
        var encoded: [String: DiagValue] = [:]
        for (key, value) in fields.prefix(Self.fieldCount) {
            if let value = DiagValue(value, limit: limit) { encoded[key] = value }
        }
        return encoded
    }

    // MARK: - Errors

    /// S36b D1: the one place a caught error becomes an event. `api.error` keeps its own name because the web
    /// and Android clients emit the same one; every other caught error is `app.error`.
    func logError(site: String, error: Error, fields: [String: Any] = [:], callId: String? = nil) {
        record(event: "app.error", site: site, error: error, fields: fields, callId: callId)
    }

    /// Never logs the body or the URL's query — a path and a code are what a failure is read by. S69: one row per
    /// (id-stripped route, code) per 60 s, the rest counted in `repeat`.
    func logAPIFailure(path: String, error: Error, ms: Int? = nil, now: Date = Date()) {
        guard Self.shouldLogAPIFailure(path: path, error: error) else { return }
        var fields = Self.apiFailureFields(path: path, error: error)
        if let ms { fields["ms"] = ms }
        append(
            "api.error", fields, callId: nil, limit: Self.fieldLimit,
            coalesceKey: "api \(Self.pathTemplate(path)) \(fields["code"] as? Int ?? 0)", now: now
        )
    }

    /// S69 shared contract: an HTTP failure is `{code:<status>, serverCode}`; a transport failure is `{code:0,
    /// errorType}` (the URLError code stays as `urlCode`).
    static func apiFailureFields(path: String, error: Error) -> [String: Any] {
        var out: [String: Any] = ["path": path, "where": "api", "message": error.localizedDescription]
        if let apiError = error as? APIError {
            out["code"] = apiError.diagCode
            if let serverCode = apiError.serverCode { out["serverCode"] = serverCode }
            return out
        }
        let nsError = error as NSError
        out["code"] = 0
        out["errorType"] = networkErrorType(nsError)
        if nsError.domain == NSURLErrorDomain { out["urlCode"] = nsError.code }
        return out
    }

    static func networkErrorType(_ error: NSError) -> String {
        guard error.domain == NSURLErrorDomain else { return "other" }
        switch error.code {
        case NSURLErrorTimedOut: return "timeout"
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorDataNotAllowed,
             NSURLErrorInternationalRoamingOff, NSURLErrorCallIsActive: return "offline"
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return "dns"
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted,
             NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateNotYetValid,
             NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorClientCertificateRejected,
             NSURLErrorClientCertificateRequired: return "tls"
        default: return "other"
        }
    }

    /// `calls/<uuid>/media/offer` → `calls/:id/media/offer`: the merge key must not split one failing route by id.
    static func pathTemplate(_ path: String) -> String {
        let bare = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        return bare.split(separator: "/", omittingEmptySubsequences: false).map { segment -> String in
            let isNumber = segment.contains(where: \.isNumber) && segment.allSatisfy { $0.isNumber || $0 == "+" }
            let isHex = segment.count >= 16 && segment.allSatisfy(\.isHexDigit)
            return UUID(uuidString: String(segment)) != nil || isNumber || isHex ? ":id" : String(segment)
        }.joined(separator: "/")
    }

    /// S69: a user-visible error banner appeared. Same (screen, message) within 60 s is one row with `repeat`.
    func logErrorShown(screen: String, site: String, message: String, code: Int? = nil) {
        var fields: [String: Any] = ["screen": screen, "site": site, "message": message]
        if let code { fields["code"] = code }
        append(
            "ui.error_shown", fields, callId: nil, limit: Self.fieldLimit, coalesceKey: "ui \(screen) \(message)"
        )
    }

    /// Test-only readback of the live ring.
    func bufferedEvents() -> [DiagEvent] { lock.withLock { ring } }

    /// A cancelled request (task cancellation, a stale session, or URLSession's -999 when a refresh loop replaces
    /// its own in-flight request) is the app changing its mind, not a failure.
    static func shouldLogAPIFailure(path: String, error: Error) -> Bool {
        guard !path.hasPrefix("diag/") else { return false }
        if error is CancellationError || error is SessionLifecycleError { return false }
        let nsError = error as NSError
        return !(nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled)
    }

    private func record(event: String, site: String, error: Error, fields: [String: Any], callId: String? = nil) {
        var out = fields
        out["where"] = site
        out["message"] = error.localizedDescription
        switch error {
        case APIError.unauthorized: out["code"] = 401
        case let APIError.server(status, _, code):
            out["code"] = status
            if let code { out["serverCode"] = code }
        default:
            out["code"] = (error as NSError).code
        }
        log(event, out, callId: callId)
    }

    // MARK: - Upload

    /// S36b D1: Control identifies the install by header, so one device stays one timeline across logins.
    /// S75: `X-Diag-Sent-At` is the device clock at the moment of sending (spool replays included), so Control can
    /// store a per-batch clock offset. The default argument is evaluated per call, i.e. per POST attempt.
    static func headers(
        installId: String, sentAtMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> [String: String] {
        var headers = ["X-Diag-Source": source, "X-Diag-Sent-At": String(sentAtMs)]
        if !installId.isEmpty { headers["X-Diag-Install"] = installId }
        return headers
    }

    @MainActor private func upload() async {
        let claimed: SessionStore? = lock.withLock {
            guard !flushing, let session else { return nil }
            flushing = true
            return session
        }
        guard let session = claimed else { return }
        defer { lock.withLock { flushing = false } }
        await captureSnapshot()
        // Not logged in: there is nobody to attribute the events to. They stay in the (bounded) ring and go
        // out after the next login rather than being thrown away here. The spool stays on disk untouched.
        guard session.isAuthenticated, let identity = session.sessionIdentity else { return }
        loadSpoolIfNeeded()
        let installId = lock.withLock { self.installId }
        while true {
            // The spool is always drained before live events: it holds what a previous failure could not hand over.
            let (batch, fromBacklog): ([DiagEvent], Bool) = lock.withLock {
                backlog.isEmpty
                    ? (Array(ring.prefix(Self.batchLimit)), false)
                    : (Array(backlog.prefix(Self.batchLimit)), true)
            }
            guard !batch.isEmpty else { return }
            var sent = await post(batch, session: session, identity: identity, installId: installId)
            if !sent { sent = await post(batch, session: session, identity: identity, installId: installId) }
            guard sent else { spoolRemaining(); return }
            lock.withLock {
                if fromBacklog { backlog.removeFirst(min(batch.count, backlog.count)) }
                else { ring.removeFirst(min(batch.count, ring.count)) }
            }
        }
    }

    @MainActor private func post(
        _ batch: [DiagEvent], session: SessionStore, identity: UUID, installId: String
    ) async -> Bool {
        do {
            let _: EmptyResponse = try await session.request(
                "diag/events", method: "POST", body: batch, timeoutInterval: 8,
                requiredSessionIdentity: identity, headers: Self.headers(installId: installId)
            )
            return true
        } catch {
            return false
        }
    }

    @MainActor private func startFlushLoop() {
        guard lock.withLock({ flushTask == nil }) else { return }
        let task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.flushInterval)
                guard let self else { return }
                UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastAliveKey)
                await upload()
            }
        }
        lock.withLock { flushTask = task }
    }

    // MARK: - Durability

    private static var spoolURL: URL? {
        let directory = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        return directory?.appendingPathComponent("diag-spool.jsonl")
    }

    /// One event per line: a torn tail costs that line, never the file.
    static func encodeSpool(_ events: [DiagEvent]) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        var out = Data()
        for event in events {
            guard let line = try? encoder.encode(event) else { continue }
            out.append(line)
            out.append(0x0a)
        }
        return out
    }

    static func decodeSpool(_ data: Data?) -> [DiagEvent] {
        guard let data, !data.isEmpty else { return [] }
        let decoder = JSONDecoder()
        return data.split(separator: 0x0a).compactMap { try? decoder.decode(DiagEvent.self, from: Data($0)) }
    }

    /// Merges into whatever is already spooled and keeps the newest `spoolLimit`; returns what the cap dropped.
    @discardableResult private func writeSpool(_ events: [DiagEvent]) -> Int {
        guard !events.isEmpty, let url = Self.spoolURL else { return 0 }
        var all = Self.decodeSpool(try? Data(contentsOf: url))
        all.append(contentsOf: events)
        var dropped = 0
        if all.count > Self.spoolLimit {
            dropped = all.count - Self.spoolLimit
            all.removeFirst(dropped)
        }
        do { try Self.encodeSpool(all).write(to: url, options: .atomic) } catch {
            logError(site: "diag.spool", error: error, fields: ["count": events.count])
            return 0
        }
        return dropped
    }

    private func spoolRemaining() {
        let pending: [DiagEvent] = lock.withLock {
            let all = backlog + ring
            backlog = []
            ring = []
            return all
        }
        let dropped = writeSpool(pending)
        if dropped > 0 { log("diag.dropped", ["count": dropped, "cap": Self.spoolLimit]) }
    }

    private func loadSpoolIfNeeded() {
        guard lock.withLock({ backlog.isEmpty }), let url = Self.spoolURL,
              FileManager.default.fileExists(atPath: url.path) else { return }
        let events = Self.decodeSpool(try? Data(contentsOf: url))
        try? FileManager.default.removeItem(at: url)
        guard !events.isEmpty else { return }
        lock.withLock { backlog = events }
    }

    /// Only Objective-C exceptions reach this: a Swift trap (force-unwrap, bounds, `fatalError`) raises a
    /// signal, and a signal handler is out of scope. Everything here is lock-only and synchronous because it
    /// runs on the crashing thread — no session, no UIKit, no `await`.
    private static func installCrashHandler() {
        guard !crashHandlerInstalled else { return }
        crashHandlerInstalled = true
        previousExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { exception in
            Diag.shared.recordCrash(exception)
            Diag.previousExceptionHandler?(exception)
        }
    }

    private func recordCrash(_ exception: NSException) {
        append(
            "app.crash",
            [
                "name": exception.name.rawValue,
                "message": String((exception.reason ?? "").prefix(500)),
                "stack": exception.callStackSymbols.prefix(12).joined(separator: " | ")
            ],
            callId: nil, limit: Self.crashFieldLimit
        )
        let pending: [DiagEvent] = lock.withLock {
            let all = backlog + ring
            backlog = []
            ring = []
            return all
        }
        writeSpool(pending)
    }

    // MARK: - Context and snapshot

    /// Re-emitted whenever any value changed, so a permission the user revoked mid-session is in the timeline.
    @MainActor private func refreshContext() async {
        let fields = Self.contextFields(
            osVersion: UIDevice.current.systemVersion,
            deviceModel: Self.deviceModel,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            appBuild: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
            locale: Locale.current.identifier,
            timeZone: TimeZone.current.identifier,
            pushRegistered: PushRegistrationManager.shared.serverRegistrationSucceeded,
            micPermission: Self.microphonePermission(),
            notificationPermission: await Self.notificationPermission(),
            installId: lock.withLock { installId }
        )
        let encoded = Self.encode(fields, limit: Self.fieldLimit)
        let changed: Bool = lock.withLock {
            guard lastContext != encoded else { return false }
            lastContext = encoded
            return true
        }
        guard changed else { return }
        log("client.context", fields)
    }

    /// Split from the collectors so a test pins the wire shape without a device.
    static func contextFields(
        osVersion: String, deviceModel: String, appVersion: String, appBuild: String, locale: String,
        timeZone: String, pushRegistered: Bool, micPermission: String, notificationPermission: String,
        installId: String
    ) -> [String: Any] {
        [
            "platform": source, "osVersion": osVersion, "deviceModel": deviceModel, "appVersion": appVersion,
            "appBuild": appBuild, "locale": locale, "timeZone": timeZone, "pushRegistered": pushRegistered,
            "micPermission": micPermission, "notificationPermission": notificationPermission,
            "installId": installId
        ]
    }

    @MainActor private func captureSnapshot() async {
        let state = UIApplication.shared.applicationState
        let due: Bool = lock.withLock {
            guard let last = lastSnapshotAt else { return true }
            return state == .background || Date().timeIntervalSince(last) >= Self.snapshotInterval
        }
        guard due else { return }
        lock.withLock { lastSnapshotAt = Date() }
        await refreshContext()
        let media = CallMediaSession.shared
        log("client.snapshot", snapshot(appState: state).fields, callId: media.callID)
    }

    /// Every reading is optional: a collector that fails omits its field instead of failing the snapshot.
    @MainActor private func snapshot(appState: UIApplication.State) -> DiagSnapshot {
        var snapshot = DiagSnapshot()
        let (path, telephony, cellular, observer) = lock.withLock {
            (monitor?.currentPath, self.telephony, cellularData, callObserver)
        }
        let device = UIDevice.current
        if device.isBatteryMonitoringEnabled, device.batteryLevel >= 0 {
            snapshot.batteryLevel = Int((device.batteryLevel * 100).rounded())
            snapshot.batteryState = Self.label(of: device.batteryState)
        }
        snapshot.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        snapshot.thermal = Self.label(of: ProcessInfo.processInfo.thermalState)
        if let path {
            snapshot.networkType = Self.summary(of: path).type
            snapshot.expensive = path.isExpensive
            snapshot.constrained = path.isConstrained
        }
        // CTCarrier is deprecated and answers "--" to every app since iOS 16, and bars/dBm have no public API,
        // so the radio generation is all the cellular detail an app can honestly report.
        if let radio = telephony?.serviceCurrentRadioAccessTechnology?.values.first {
            snapshot.radio = radio.replacingOccurrences(of: "CTRadioAccessTechnology", with: "")
        }
        if let cellular { snapshot.cellularData = Self.label(of: cellular.restrictedState) }
        let route = AVAudioSession.sharedInstance().currentRoute
        snapshot.outputs = route.outputs.map(\.portType.rawValue).joined(separator: ",")
        snapshot.inputs = route.inputs.map(\.portType.rawValue).joined(separator: ",")
        snapshot.ip = Self.primaryInterface()
        if let calls = observer?.calls.filter({ !$0.hasEnded }), !calls.isEmpty {
            snapshot.nativeCalls = calls.count
            snapshot.nativeCallConnected = calls.contains { $0.hasConnected }
            snapshot.nativeCallOutgoing = calls.contains { $0.isOutgoing }
        }
        snapshot.appState = switch appState {
        case .background: "bg"
        case .active: "fg"
        default: "inactive"
        }
        let media = CallMediaSession.shared
        snapshot.inCall = media.callID != nil
        snapshot.mediaState = media.state.logLabel
        snapshot.memoryMB = Self.residentMemoryMB()
        snapshot.uptimeS = Int(Date().timeIntervalSince(launchedAt))
        snapshot.seqDropped = lock.withLock {
            let value = dropped
            dropped = 0
            return value
        }
        return snapshot
    }

    private static func microphonePermission() -> String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: "granted"
        case .denied: "denied"
        case .undetermined: "undetermined"
        @unknown default: "unknown"
        }
    }

    private static func notificationPermission() async -> String {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized: "authorized"
        case .provisional: "provisional"
        case .ephemeral: "ephemeral"
        case .denied: "denied"
        case .notDetermined: "notDetermined"
        @unknown default: "unknown"
        }
    }

    private static let deviceModel: String = {
        var system = utsname()
        uname(&system)
        let size = MemoryLayout.size(ofValue: system.machine)
        return withUnsafePointer(to: &system.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: size) { String(cString: $0) }
        }
    }()

    private static func residentMemoryMB() -> Int? {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return Int(info.resident_size / (1024 * 1024))
    }

    /// The interface name and family only — never an address. `pdp_ip0` vs `en0` is what the timeline needs.
    private static func primaryInterface() -> String? {
        var addresses: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addresses) == 0, let first = addresses else { return nil }
        defer { freeifaddrs(addresses) }
        var fallback: String?
        // `Swift.` because this type has a `sequence` of its own.
        for entry in Swift.sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(truncatingIfNeeded: entry.pointee.ifa_flags)
            guard flags & IFF_UP == IFF_UP, flags & IFF_LOOPBACK == 0, let address = entry.pointee.ifa_addr
            else { continue }
            let family = address.pointee.sa_family
            guard family == UInt8(AF_INET) || family == UInt8(AF_INET6) else { continue }
            let name = String(cString: entry.pointee.ifa_name)
            if family == UInt8(AF_INET) { return "\(name)/ipv4" }
            if fallback == nil { fallback = "\(name)/ipv6" }
        }
        return fallback
    }

    private static func label(of state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    private static func label(of state: UIDevice.BatteryState) -> String {
        switch state {
        case .charging: "charging"
        case .full: "full"
        case .unplugged: "unplugged"
        default: "unknown"
        }
    }

    private static func label(of state: CTCellularDataRestrictedState) -> String {
        switch state {
        case .restricted: "restricted"
        case .notRestricted: "notRestricted"
        default: "unknown"
        }
    }

    // MARK: - Device monitors

    @MainActor private func startDeviceMonitors() {
        guard lock.withLock({ !devicesStarted }) else { return }
        lock.withLock { devicesStarted = true }
        let id = PushRegistrationManager.shared.installationID.uuidString.lowercased()
        let observer = CXCallObserver()
        let cellular = CTCellularData()
        let telephony = CTTelephonyNetworkInfo()
        lock.withLock {
            installId = id
            callObserver = observer
            cellularData = cellular
            self.telephony = telephony
            lastThermal = ProcessInfo.processInfo.thermalState
        }
        UIDevice.current.isBatteryMonitoringEnabled = true
        Self.installCrashHandler()
        noteLaunchLiveness()
        for (name, clean) in [
            (UIApplication.didEnterBackgroundNotification, true), (UIApplication.willTerminateNotification, true),
            (UIApplication.willEnterForegroundNotification, false)
        ] {
            _ = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                UserDefaults.standard.set(clean, forKey: Self.cleanShutdownKey)
            }
        }
        _ = NotificationCenter.default.addObserver(
            forName: UIDevice.batteryLevelDidChangeNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { Diag.shared.noteBattery(level: UIDevice.current.batteryLevel) }
        }
        _ = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
        ) { _ in
            Diag.shared.noteThermal(ProcessInfo.processInfo.thermalState)
        }
    }

    // MARK: - Kill marker
    // `lastAlive` ticks with the flush loop; leaving the foreground or terminating marks the run clean. A launch that
    // finds neither means the previous process died in the foreground (jetsam, watchdog, debugger) without a crash
    // report. ponytail: a kill while backgrounded mid-call reads as clean; tick `cleanShutdown=false` during calls
    // if that case matters.
    static let lastAliveKey = "diag.lastAlive"
    static let cleanShutdownKey = "diag.cleanShutdown"

    /// Seconds since the previous run was last seen alive, when that run ended uncleanly within the last 24 h.
    static func killedLastAliveAgo(cleanShutdown: Bool, lastAlive: Double?, now: Double) -> Int? {
        guard !cleanShutdown, let lastAlive else { return nil }
        let ago = now - lastAlive
        return ago >= 0 && ago < 86_400 ? Int(ago) : nil
    }

    private func noteLaunchLiveness() {
        let defaults = UserDefaults.standard
        let now = Date().timeIntervalSince1970
        if let ago = Self.killedLastAliveAgo(
            cleanShutdown: defaults.bool(forKey: Self.cleanShutdownKey),
            lastAlive: defaults.object(forKey: Self.lastAliveKey) as? Double, now: now
        ) {
            log("app.killed", ["lastAliveAgoS": ago])
        }
        defaults.set(false, forKey: Self.cleanShutdownKey)
        defaults.set(now, forKey: Self.lastAliveKey)
    }

    /// Below 15 % once per crossing; the phone has to climb back to 20 % before it can report low again.
    private func noteBattery(level: Float) {
        guard level >= 0 else { return }
        let percent = Int((level * 100).rounded())
        let crossed: Bool = lock.withLock {
            if percent >= 20 { batteryLowLogged = false }
            guard percent < 15, !batteryLowLogged else { return false }
            batteryLowLogged = true
            return true
        }
        if crossed { log("battery.low", ["battery": percent]) }
    }

    private func noteThermal(_ state: ProcessInfo.ThermalState) {
        let changed: Bool = lock.withLock {
            guard lastThermal != state else { return false }
            lastThermal = state
            return true
        }
        if changed { log("thermal.state", ["thermal": Self.label(of: state)]) }
    }

    // MARK: - Network path

    private func startNetworkMonitor() {
        guard lock.withLock({ monitor == nil }) else { return }
        let monitor = NWPathMonitor()
        lock.withLock { self.monitor = monitor }
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let summary = Self.summary(of: path)
            let changed: Bool = lock.withLock {
                guard networkLabel != summary.label else { return false }
                networkLabel = summary.label
                return true
            }
            guard changed else { return }
            log("network.path", summary.fields)
        }
        monitor.start(queue: DispatchQueue(label: "org.vodog.diag"))
    }

    /// `interfaces` is what confirmed S45: on a cellular-only path, `candidateNetworkPolicy = .lowCost` made
    /// libwebrtc prefer the phone's ever-present IMS tunnels over the one interface that works, and the call
    /// gathered no relay candidate at all. The filter is now conditional on this reading; `type` here and
    /// `netPolicy` on `media.relay_candidates` are the pair to read together.
    private static func summary(of path: NWPath) -> (label: String, type: String, fields: [String: Any]) {
        let type: String = if path.usesInterfaceType(.wifi) { "wifi" }
            else if path.usesInterfaceType(.cellular) { "cellular" }
            else if path.usesInterfaceType(.wiredEthernet) { "wired" }
            else { "other" }
        let interfaces = path.availableInterfaces
            .map { "\($0.name)/\(name(of: $0.type))" }
            .joined(separator: ",")
        let status = path.status == .satisfied ? "satisfied" : "\(path.status)"
        return (
            "\(status):\(type)",
            type,
            [
                "status": status, "type": type, "interfaces": interfaces,
                "isExpensive": path.isExpensive, "isConstrained": path.isConstrained
            ]
        )
    }

    private static func name(of type: NWInterface.InterfaceType) -> String {
        switch type {
        case .wifi: "wifi"
        case .cellular: "cellular"
        case .wiredEthernet: "wired"
        case .loopback: "loopback"
        case .other: "other"
        @unknown default: "unknown"
        }
    }
}

/// S36b D1: one `client.snapshot`'s payload. A `nil` is a reading this device could not take — the field is
/// then absent rather than zero, so a reader never mistakes "unknown" for a measurement.
struct DiagSnapshot {
    var batteryLevel: Int?
    var batteryState: String?
    var lowPower = false
    var thermal = "nominal"
    var networkType = "none"
    var expensive = false
    var constrained = false
    var radio: String?
    var cellularData: String?
    var outputs: String?
    var inputs: String?
    var ip: String?
    var nativeCalls = 0
    var nativeCallConnected: Bool?
    var nativeCallOutgoing: Bool?
    var appState = "fg"
    var inCall = false
    var mediaState = "idle"
    var memoryMB: Int?
    var uptimeS = 0
    var seqDropped = 0

    var fields: [String: Any] {
        var out: [String: Any] = [
            "lowPower": lowPower, "thermal": thermal, "netType": networkType, "netExpensive": expensive,
            "netConstrained": constrained, "appState": appState, "inCall": inCall,
            "mediaState": mediaState, "uptimeS": uptimeS, "seqDropped": seqDropped,
            "nativeCalls": nativeCalls
        ]
        if let batteryLevel { out["battery"] = batteryLevel }
        if let batteryState { out["batteryState"] = batteryState }
        if let radio { out["radio"] = radio }
        if let cellularData { out["cellularData"] = cellularData }
        if let outputs, !outputs.isEmpty { out["outputs"] = outputs }
        if let inputs, !inputs.isEmpty { out["inputs"] = inputs }
        if let ip { out["ip"] = ip }
        if let nativeCallConnected { out["nativeCallConnected"] = nativeCallConnected }
        if let nativeCallOutgoing { out["nativeCallOutgoing"] = nativeCallOutgoing }
        if let memoryMB { out["memoryMB"] = memoryMB }
        return out
    }
}

struct DiagEvent: Codable, Equatable, Sendable {
    let ts: String
    let level: String
    let event: String
    let callId: String?
    var fields: [String: DiagValue]
    /// S69: top-level `<CFBundleShortVersionString>(<CFBundleVersion>)`; Control files it as `app_version`.
    var appVersion: String? = nil
}

/// S69: `api.error` / `ui.error_shown` fold repeats of one key within 60 s into the row still in the ring —
/// `repeat` counts every occurrence, the first included, as Web does. A repeat whose row already left the ring
/// (uploaded or spooled) is carried onto the key's next row, so no occurrence is lost from the count.
struct DiagCoalescer {
    static let window: TimeInterval = 60
    private var opened: [String: (start: Date, seq: Int)] = [:]
    private var carried: [String: Int] = [:]

    /// The `seq` of the open row a repeat belongs to, or nil when this occurrence starts a new row.
    func openSeq(for key: String, now: Date) -> Int? {
        guard let entry = opened[key], now.timeIntervalSince(entry.start) < Self.window else { return nil }
        return entry.seq
    }

    mutating func carry(_ key: String) { carried[key, default: 0] += 1 }

    /// Starts a new row for `key` and returns its initial `repeat`.
    mutating func open(_ key: String, seq: Int, now: Date) -> Int {
        opened = opened.filter { now.timeIntervalSince($0.value.start) < Self.window }
        opened[key] = (now, seq)
        return 1 + (carried.removeValue(forKey: key) ?? 0)
    }
}

/// `[String: Any]` cannot be encoded, and a diagnostic field is only ever a scalar. Anything else is dropped
/// rather than stringified, so a stray object can never inflate the 4 KiB budget Control enforces.
enum DiagValue: Codable, Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    /// S70: `media.summary` carries `rx{…}`/`tx{…}` objects, as the web client does.
    case object([String: DiagValue])

    init?(_ value: Any, limit: Int) {
        switch value {
        case let value as String: self = .string(String(value.prefix(limit)))
        case let value as Bool: self = .bool(value)
        case let value as Int: self = .int(value)
        case let value as Double: self = .double(value)
        case let value as any BinaryInteger: self = .int(Int(truncatingIfNeeded: value))
        case let value as [String: Any]:
            self = .object(value.compactMapValues { DiagValue($0, limit: limit) })
        default: return nil
        }
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Int.self) { self = .int(value) }
        else if let value = try? container.decode(Double.self) { self = .double(value) }
        else if let value = try? container.decode([String: DiagValue].self) { self = .object(value) }
        else { self = .string(try container.decode(String.self)) }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .int(value): try container.encode(value)
        case let .double(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}
