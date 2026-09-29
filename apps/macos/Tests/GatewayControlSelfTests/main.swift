import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    if !condition() {
        FileHandle.standardError.write(Data("GatewayControlSelfTests failed (line \(line)): \(message)\n".utf8))
        exit(1)
    }
}

let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("celldock-gateway-selftest-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: directory) }
let ledgerURL = directory.appendingPathComponent("commands.json")

// Ledger: started-before-execute, ambiguous after restart, contiguous reportedSequence.
do {
    let ledger = GatewayCommandLedger(url: ledgerURL, generation: 3)
    ledger.begin(id: "a", sequence: 1, kind: "apply_sim_settings")
    ledger.finish(id: "a", sequence: 1, kind: "apply_sim_settings",
                  ack: GatewayCommandLedger.ackBody(generation: 3, status: "acked", result: ["simId": "s"]))
    ledger.markDelivered("a")
    check(ledger.reportedSequence == 1, "delivered ack advances reportedSequence")

    ledger.begin(id: "dial", sequence: 3, kind: "dial", deviceCallId: "dji4g-00000001-1")
    ledger.begin(id: "sms", sequence: 4, kind: "send_sms")
    ledger.begin(id: "ans", sequence: 5, kind: "answer")
    check(ledger.reportedSequence == 1, "started commands do not advance reportedSequence")
    check(ledger.pendingAcks.isEmpty, "started commands have no ACK yet")
}
do {
    // Simulated crash: reopen the same file.
    let ledger = GatewayCommandLedger(url: ledgerURL, generation: 3)
    let dial = ledger.entry("dial")
    check(dial?.state == .done, "started dial becomes done after restart")
    let body = GatewayJSON.object(dial?.ack ?? "")
    let result = body["result"] as? [String: Any]
    check(body["status"] as? String == "rejected", "ambiguous dial is rejected")
    check(result?["reason"] as? String == "ambiguous_after_restart", "ambiguous reason")
    check(result?["phase"] as? String == "unknown", "ambiguous phase is unknown")
    check(body["telecomState"] as? String == "UNKNOWN", "dial ambiguity carries telecomState UNKNOWN")
    check(GatewayJSON.object(ledger.entry("sms")?.ack ?? "")["telecomState"] == nil, "sms ambiguity has no telecomState")
    check(ledger.entry("ans") == nil, "started answer is dropped so a redelivery can re-run it")
    check(ledger.pendingAcks.map(\.id) == ["dial", "sms"], "ambiguous ACKs are pending in sequence order")
    let original = ledger.entry("dial")?.ack
    ledger.markDelivered("dial")
    check(ledger.reportedSequence == 3, "gap at 2 (never delivered) does not block, sms at 4 does")
    ledger.markDelivered("sms")
    check(ledger.reportedSequence == 4, "contiguous delivered ACKs advance")
    check(ledger.entry("dial")?.ack == original, "persisted ACK body is not rewritten")
}
do {
    let ledger = GatewayCommandLedger(url: ledgerURL, generation: 4)
    check(ledger.entries.isEmpty && ledger.reportedSequence == 0, "new generation starts a fresh ledger")
}

// Outbox: FIFO head, backoff, dedupe by context, persistence.
do {
    let url = directory.appendingPathComponent("outbox.json")
    let outbox = GatewayOutbox(url: url)
    outbox.enqueue(GatewayOutboxItem(eventId: "e1", path: "/gateway/calls/incoming", body: "{}", kind: "call.incoming", context: "msg-1"))
    outbox.enqueue(GatewayOutboxItem(eventId: "e2", path: "/gateway/calls/x/events", body: "{}", kind: "call.state"))
    let now = Date()
    check(outbox.head(now: now)?.eventId == "e1", "outbox is FIFO")
    outbox.deferItem("e1", now: now)
    check(outbox.head(now: now) == nil, "deferred head blocks the queue (ordering)")
    check(outbox.head(now: now.addingTimeInterval(3))?.eventId == "e1", "head retries after backoff")
    check(GatewayOutbox(url: url).items.first?.context == "msg-1", "outbox persists context")
    outbox.remove("e1")
    check(GatewayOutbox(url: url).head(now: now)?.eventId == "e2", "removal persists")
}

// Blocklist matching.
do {
    check(GatewayBlocklist.matches("13800138000", listed: ["+86 138-0013-8000"], countryIso: "CN"), "E.164 listed matches national remote")
    check(GatewayBlocklist.matches("+8613800138000", listed: ["13800138000"], countryIso: "CN"), "national listed matches E.164 remote")
    check(GatewayBlocklist.matches("008613800138000", listed: ["13800138000"], countryIso: "CN"), "00 prefix folded")
    check(GatewayBlocklist.matches("01012345678", listed: ["+861012345678"], countryIso: "CN"), "trunk 0 folded")
    check(!GatewayBlocklist.matches("13800138001", listed: ["13800138000"], countryIso: "CN"), "different number does not match")
    check(!GatewayBlocklist.matches("112", listed: ["112"], countryIso: "CN"), "emergency never blocked")
    check(!GatewayBlocklist.matches(nil, listed: ["13800138000"], countryIso: "CN"), "unknown caller fails open")
    check(GatewayBlocklist.matches("10086", listed: ["10086"], countryIso: nil), "digit equality without country")
    check(GatewayBlocklist.shouldReplace(current: nil, next: 0), "first snapshot replaces")
    check(!GatewayBlocklist.shouldReplace(current: 5, next: 5), "same version is a no-op")
    check(!GatewayBlocklist.shouldReplace(current: 5, next: 4), "lower version ignored")
    check(GatewayBlocklist.shouldReplace(current: 5, next: 6), "higher version replaces")
    // S66: call and SMS lists are separate.
    let items: [[String: Any]] = [
        ["simId": "sim-a", "numbers": ["+862195559", "13800138000"], "smsNumbers": ["10690000"]],
        ["simId": "sim-b", "numbers": ["13900139000"], "smsNumbers": ["13900139000"]],
    ]
    let lists = GatewayBlocklist.lists(items, simId: "sim-a")
    check(lists.call == ["+862195559", "13800138000"] && lists.sms == ["10690000"], "lists split per SIM")
    check(GatewayBlocklist.matches("13800138000", listed: lists.call, countryIso: "CN") &&
          !GatewayBlocklist.matches("13800138000", listed: lists.sms, countryIso: "CN"), "call-only number does not block SMS")
    check(GatewayBlocklist.matches("10690000", listed: lists.sms, countryIso: "CN") &&
          !GatewayBlocklist.matches("10690000", listed: lists.call, countryIso: "CN"), "SMS-only number does not block calls")
    let legacy = GatewayBlocklist.lists([["simId": "sim-a", "numbers": ["13800138000"]]], simId: "sim-a")
    check(legacy.call == ["13800138000"] && legacy.sms.isEmpty, "absent smsNumbers → empty SMS list")
    check(GatewayBlocklist.lists(items, simId: nil) == ([], []), "no SIM → empty lists")
}

// Rules, CLCC → snapshot mapping, identities.
do {
    check(GatewayRules.isValidSMSDestination("+8613800138000"), "E.164 destination valid")
    check(GatewayRules.isValidSMSDestination("10086") && GatewayRules.isValidSMSDestination("1001298"), "service numbers valid")
    check(!GatewayRules.isValidSMSDestination("12") && !GatewayRules.isValidSMSDestination("+0123456") &&
          !GatewayRules.isValidSMSDestination("138 0013"), "invalid destinations rejected")
    check(GatewayRules.isValidDTMF("12*#") && !GatewayRules.isValidDTMF("") && !GatewayRules.isValidDTMF("1a"), "dtmf digits")
    let fingerprint = GatewayRules.iccidFingerprint("89860000000000000001")
    check(fingerprint.count == 32 && fingerprint == fingerprint.lowercased() &&
          fingerprint == GatewayRules.iccidFingerprint("89860000000000000001"), "iccid fingerprint is stable 32-hex")
    check(GatewayRules.iccidFingerprint("89860321234567890123") == "99730339b1c3bf294190599953620ef3",
          "S65 shared iccid fingerprint vector")
    check(GatewayRules.syncPhoneNumber("+86 138-0013-8000") == "+8613800138000" &&
          GatewayRules.syncPhoneNumber("10086") == "10086", "sync phone number normalized")
    check(GatewayRules.syncPhoneNumber(nil) == nil && GatewayRules.syncPhoneNumber("12") == nil &&
          GatewayRules.syncPhoneNumber("+86(138)") == nil && GatewayRules.syncPhoneNumber("") == nil,
          "invalid sync phone number omitted")
    check(GatewayRules.deviceCallId(locationID: 0x01100000, firstSeenMillis: 1_700_000_000_123) ==
          "dji4g-01100000-1700000000123", "deviceCallId format")
    check(GatewayRules.countryIso(imsi: "460011234567890") == "CN" && GatewayRules.countryIso(imsi: nil) == nil, "country iso")
    let calls = CallATParser.parseCLCCResponse("+CLCC: 1,1,4,0,0,\"13800138000\",129\r\nOK")
    check(calls.count == 1 && calls[0].status == .incoming, "CLCC incoming parsed")
    check(GatewayRules.snapshotState(.incoming) == "ringing", "incoming → ringing")
    check(GatewayRules.snapshotState(.alerting) == "dialing" && GatewayRules.snapshotState(.dialing) == "dialing", "alerting → dialing")
    check(GatewayRules.snapshotState(.active) == "active", "active → active")
    check(GatewayRules.snapshotState(.idle) == nil && GatewayRules.snapshotState(.ending) == nil, "no call → not reported")
    check(GatewayRules.isUUID("7c0a8f0e-2f52-4a55-9a52-0f0a5f1b2c3d") && !GatewayRules.isUUID("dji4g-1"), "uuid check")
    check(GatewayJSON.date(GatewayJSON.iso(Date(timeIntervalSince1970: 1)))?.timeIntervalSince1970 == 1, "iso round trip")
}

// S56 early media: heartbeat flag, remote-dial-only early UAC, options without capture.
do {
    check(GatewayRules.earlyMedia(["earlyMedia": true]), "heartbeat earlyMedia true")
    check(!GatewayRules.earlyMedia([:]) && !GatewayRules.earlyMedia(["earlyMedia": false]) &&
          !GatewayRules.earlyMedia(["earlyMedia": "true"]), "absent / false / non-bool earlyMedia ⇒ false")
    check(ModemCallStatus.alerting.allowsEarlyUAC(direction: .outgoing, earlyMedia: true) &&
          ModemCallStatus.dialing.allowsEarlyUAC(direction: .outgoing, earlyMedia: true), "remote dial starts UAC dialing/alerting")
    check(!ModemCallStatus.alerting.allowsEarlyUAC(direction: .outgoing, earlyMedia: false), "earlyMedia off (or local dial) stays active-only")
    check(!ModemCallStatus.incoming.allowsEarlyUAC(direction: .incoming, earlyMedia: true) &&
          !ModemCallStatus.waiting.allowsEarlyUAC(direction: .incoming, earlyMedia: true), "incoming never early")
    check(!ModemCallStatus.active.allowsEarlyUAC(direction: .outgoing, earlyMedia: true) &&
          !ModemCallStatus.held.allowsEarlyUAC(direction: .outgoing, earlyMedia: true), "active/held are not early")
    let capture = GatewayCapture(deviceCallId: "dji4g-1", telecomCreationTimeMillis: 1_700_000_000_123)
    let early = GatewayRules.mediaOptionsBody(transport: "udp", capture: nil)
    check(early.count == 1 && early["transport"] as? String == "udp" && early["capture"] == nil, "early options omit capture")
    let armed = GatewayRules.mediaOptionsBody(transport: "tls", capture: capture)
    let body = armed["capture"] as? [String: Any]
    check(armed["transport"] as? String == "tls" && body?["deviceCallId"] as? String == "dji4g-1" &&
          body?["telecomCreationTimeMillis"] as? Int64 == 1_700_000_000_123 && body?.count == 2, "armed options carry capture")
    check(GatewayJSON.string(GatewayRules.captureBody(capture)) == GatewayJSON.string(body ?? [:]), "capture-binding body == options capture")
}

// Diagnostics: masking, rolling file rotation, bounded upload queue, debug stays local.
do {
    check(GatewayDiagPrivacy.mask("+86 138-0013-8000") == "***8000", "mask keeps only the last 4 digits (IMEI)")
    check(GatewayDiagPrivacy.mask("110") == "***", "short numbers fully masked")
    let clean = GatewayDiagPrivacy.sanitize(["remoteNumber": "13800138000", "body": "hello", "smsId": "x",
                                             "nested": ["sender": "10086123"], "parts": 2])
    check(clean["remoteNumber"] as? String == "13800138000" && clean["body"] as? String == "[redacted]",
          "S69 decision 6: full number kept, body redacted")
    check((clean["nested"] as? [String: Any])?["sender"] as? String == "10086123", "nested number kept")
    check(clean["smsId"] as? String == "x" && clean["parts"] as? Int == 2, "other fields untouched")

    let logURL = directory.appendingPathComponent("logs/gateway.log")
    let rolling = GatewayRollingLog(url: logURL, maxBytes: 100, files: 3)
    for index in 0..<20 { rolling.append(String(repeating: "\(index % 10)", count: 30)) }
    let manager = FileManager.default
    check(manager.fileExists(atPath: logURL.path) && manager.fileExists(atPath: logURL.path + ".1") &&
          manager.fileExists(atPath: logURL.path + ".2"), "rotation keeps 3 files")
    check(!manager.fileExists(atPath: logURL.path + ".3"), "rotation never exceeds 3 files")
    let sizes = [logURL.path, logURL.path + ".1", logURL.path + ".2"].map {
        ((try? manager.attributesOfItem(atPath: $0))?[.size] as? Int) ?? 0
    }
    check(sizes.allSatisfy { $0 <= 100 }, "each file stays under the cap")
    check((try? String(contentsOf: logURL, encoding: .utf8))?.hasSuffix(String(repeating: "9", count: 30) + "\n") == true,
          "newest line is in the live file")

    let queueURL = directory.appendingPathComponent("diag-queue.jsonl")
    let queue = GatewayDiagQueue(url: queueURL, limit: 5)
    for index in 0..<8 { queue.append("{\"n\":\(index)}") }
    check(queue.items.count == 5 && queue.items.first == "{\"n\":3}" && queue.dropped == 3, "oldest dropped past the bound")
    check(GatewayDiagQueue(url: queueURL, limit: 5).items == queue.items, "queue persists across restarts")
    let batch = queue.batch(max: 2) { "dropped:\($0)" }
    check(batch.lines == ["{\"n\":3}", "{\"n\":4}", "dropped:3"] && batch.queued == 2, "batch carries the drop report")
    queue.commit(batch.queued)
    check(queue.items.count == 3 && queue.dropped == 0, "commit removes only uploaded rows")
    check(GatewayDiagQueue(url: queueURL, limit: 5).items.first == "{\"n\":5}", "commit persists")

    let suite = "celldock-gateway-selftest-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let log = GatewayDiagLog(defaults: defaults, queueURL: directory.appendingPathComponent("q2.jsonl"),
                             logURL: directory.appendingPathComponent("logs2/gateway.log"), queueLimit: 10)
    log.record("heartbeat.rtt", level: "debug", fields: ["ms": 10])
    log.record("sms.received", fields: ["sender": "13800138000"])
    let uploaded = log.nextBatch()
    check(uploaded.queued == 1 && uploaded.lines[0].contains("sms.received") && uploaded.lines[0].contains("13800138000"),
          "debug stays local; uploads keep full numbers (S69 decision 6)")
    let fileText = (try? String(contentsOf: directory.appendingPathComponent("logs2/gateway.log"), encoding: .utf8)) ?? ""
    check(fileText.contains("heartbeat.rtt") && fileText.contains("sms.received"), "local file has every level")
    let again = GatewayDiagLog(defaults: defaults, queueURL: directory.appendingPathComponent("q2.jsonl"),
                               logURL: directory.appendingPathComponent("logs2/gateway.log"))
    check(again.installId == log.installId && again.pendingCount == 1, "install id and queue survive restart")
    again.record("x.y")
    check(again.nextBatch().lines.last?.contains("\"seq\":3") == true, "seq is monotonic per install")
    check(again.nextBatch().lines.allSatisfy { $0.contains("\"appVersion\":") }, "S69: every row carries appVersion")

    // S69 gateway.error identity: HTTP by status, everything else by NSError domain/code (no description).
    let http = GatewayDiagLog.errorIdentity(GatewayHTTPError(status: 503, code: "X", body: Data()))
    check(http.domain == "http" && http.code == 503 && http.serverCode == "X", "http error identity")
    let url = GatewayDiagLog.errorIdentity(URLError(.timedOut))
    check(url.domain == NSURLErrorDomain && url.code == NSURLErrorTimedOut && url.serverCode == nil, "URLError identity")
    let fields = GatewayDiagLog.errorFields(NSError(domain: "X", code: 7, userInfo: [NSLocalizedDescriptionKey: "bad <Obj: 0x600001234abc>"]))
    check(fields["domain"] as? String == "X" && fields["code"] as? Int == 7
          && (fields["message"] as? String)?.contains("0x6000") == false, "errorFields strips pointer addresses")
}

// Module identity, legacy migration and newer-epoch-wins credential selection.
do {
    let imei = "861234567890123"
    let key = GatewayModuleIdentity.storageKey(imei: imei)
    check(key.count == 16 && key == GatewayModuleIdentity.storageKey(imei: imei) && !key.contains("0123"),
          "storage key is a stable 16-hex hash, not the IMEI")
    check(GatewayModuleIdentity.storageKey(imei: "861234567890124") != key, "different modules get different keys")
    check(GatewayModuleIdentity.account(imei: imei) == "credentials." + key, "keychain account per module")
    check(GatewayModuleIdentity.displayKey(imei: imei) == "imei:890123", "display key shows last 6")
    check(GatewayModuleIdentity.diagKey(imei: imei) == "imei:***0123", "diag key shows last 4")
    check(GatewayDiagPrivacy.sanitize(["imei": imei])["imei"] as? String == "***0123", "diag masks a raw imei field")

    let base = URL(string: "https://vodog.example")!
    let a3 = GatewayCredentials(baseURL: base, deviceToken: "tA3", gatewayId: "gA", deviceEpoch: 3)
    let a4 = GatewayCredentials(baseURL: base, deviceToken: "tA4", gatewayId: "gA", deviceEpoch: 4)
    let a3b = GatewayCredentials(baseURL: base, deviceToken: "tA3b", gatewayId: "gA", deviceEpoch: 3)
    let b1 = GatewayCredentials(baseURL: base, deviceToken: "tB1", gatewayId: "gB", deviceEpoch: 1)
    typealias R = GatewayCredentialResolution

    let unpaired = R.resolve(stored: nil, legacy: nil, module: nil)
    check(unpaired.credentials == nil && !unpaired.saveToKeychain && !unpaired.pushToModule, "nothing to resolve")

    let migrated = R.resolve(stored: nil, legacy: a3, module: nil)
    check(migrated.credentials == a3 && migrated.source == "legacy" && migrated.saveToKeychain &&
          migrated.deleteLegacy && migrated.pushToModule, "legacy item moves to the first module without credentials")
    let moduleHasOwn = R.resolve(stored: nil, legacy: a3, module: b1)
    check(moduleHasOwn.credentials == b1 && moduleHasOwn.source == "module" && !moduleHasOwn.deleteLegacy &&
          moduleHasOwn.saveToKeychain && !moduleHasOwn.pushToModule, "a module with its own copy never claims the legacy item")
    let alreadyStored = R.resolve(stored: a3, legacy: b1, module: nil)
    check(alreadyStored.credentials == a3 && !alreadyStored.deleteLegacy && alreadyStored.pushToModule,
          "stored credentials win over legacy and are written to the module")

    let newerOnModule = R.resolve(stored: a3, legacy: nil, module: a4)
    check(newerOnModule.credentials == a4 && newerOnModule.source == "module" && newerOnModule.saveToKeychain &&
          !newerOnModule.pushToModule, "higher epoch on the module is imported")
    let newerHere = R.resolve(stored: a4, legacy: nil, module: a3)
    check(newerHere.credentials == a4 && newerHere.source == "keychain" && !newerHere.saveToKeychain &&
          newerHere.pushToModule, "higher epoch on this Mac is pushed to the module")
    let otherGateway = R.resolve(stored: a4, legacy: nil, module: b1)
    check(otherGateway.credentials == b1 && otherGateway.source == "module", "module paired to another gateway wins")
    let sameEpochOtherToken = R.resolve(stored: a3, legacy: nil, module: a3b)
    check(sameEpochOtherToken.credentials == a3b && sameEpochOtherToken.saveToKeychain, "same epoch, different token: module wins")
    let inSync = R.resolve(stored: a4, legacy: nil, module: a4)
    check(inSync.credentials == a4 && !inSync.saveToKeychain && !inSync.pushToModule, "in sync: nothing to do")
    let moveToNewMac = R.resolve(stored: nil, legacy: nil, module: a4)
    check(moveToNewMac.credentials == a4 && moveToNewMac.source == "module" && moveToNewMac.saveToKeychain,
          "a new Mac imports the module copy without pairing")
}

// Transport failure categories and settings-card messages.
do {
    check(GatewayNetworkIssue(URLError(.timedOut)) == .timeout, "timeout")
    check(GatewayNetworkIssue(URLError(.networkConnectionLost)) == .connectionLost, "connection lost")
    check(GatewayNetworkIssue(URLError(.cannotConnectToHost)) == .cannotConnect, "cannot connect")
    check(GatewayNetworkIssue(URLError(.notConnectedToInternet)) == .offline, "offline")
    check(GatewayNetworkIssue(URLError(.secureConnectionFailed)) == .tls, "tls")
    check(GatewayNetworkIssue(URLError(.cancelled)) == nil, "cancellation does not reset connections")
    check(GatewayNetworkIssue(GatewayHTTPError(status: 503, code: nil, body: Data())) == nil, "HTTP errors are not transport issues")
    let messages = [URLError(.timedOut), URLError(.networkConnectionLost), URLError(.cannotConnectToHost),
                    URLError(.notConnectedToInternet), URLError(.secureConnectionFailed)]
        .map { GatewayNetworkIssue.userMessage(for: $0) }
    check(Set(messages).count == 5 && messages.allSatisfy { !$0.contains("NSURLError") && !$0.contains("-100") },
          "each category has its own short message, never the raw error")
    check(GatewayNetworkIssue.userMessage(for: GatewayHTTPError(status: 502, code: nil, body: Data())) ==
          GatewayNetworkIssue.userMessage(for: GatewayHTTPError(status: 503, code: nil, body: Data())), "5xx share one message")
    check(GatewayNetworkIssue.userMessage(for: GatewayHTTPError(status: 401, code: nil, body: Data())) !=
          GatewayNetworkIssue.userMessage(for: NSError(domain: "x", code: 1)), "401 and unknown errors differ")
}

// S54: two gateways on one Mac keep separate ledgers, outboxes and command sequences.
do {
    let gatewayA = "11111111-1111-4111-8111-111111111111", gatewayB = "22222222-2222-4222-8222-222222222222"
    check(GatewayStorePaths.ledger(directory, gatewayId: gatewayA) != GatewayStorePaths.ledger(directory, gatewayId: gatewayB) &&
          GatewayStorePaths.outbox(directory, gatewayId: gatewayA) != GatewayStorePaths.outbox(directory, gatewayId: gatewayB),
          "per-gateway store paths")
    // Same epoch number on both gateways: nothing may leak across.
    let ledgerA = GatewayCommandLedger(url: GatewayStorePaths.ledger(directory, gatewayId: gatewayA), generation: 2)
    let ledgerB = GatewayCommandLedger(url: GatewayStorePaths.ledger(directory, gatewayId: gatewayB), generation: 2)
    ledgerA.finish(id: "cmdA", sequence: 7, kind: "dtmf", ack: GatewayCommandLedger.ackBody(generation: 2, status: "acked", result: [:]))
    ledgerA.markDelivered("cmdA")
    ledgerB.begin(id: "cmdB", sequence: 3, kind: "dial")
    check(ledgerA.reportedSequence == 7 && ledgerB.reportedSequence == 0, "reportedSequence is per gateway")
    check(ledgerB.entry("cmdA") == nil && ledgerA.entry("cmdB") == nil, "command ids never cross gateways")
    let reopenedB = GatewayCommandLedger(url: GatewayStorePaths.ledger(directory, gatewayId: gatewayB), generation: 2)
    check(reopenedB.entry("cmdB")?.state == .done && GatewayCommandLedger(url: GatewayStorePaths.ledger(directory, gatewayId: gatewayA),
          generation: 2).entry("cmdA")?.ackDelivered == true, "restart ambiguity handled per gateway")
    let outboxA = GatewayOutbox(url: GatewayStorePaths.outbox(directory, gatewayId: gatewayA))
    let outboxB = GatewayOutbox(url: GatewayStorePaths.outbox(directory, gatewayId: gatewayB))
    outboxA.enqueue(GatewayOutboxItem(eventId: "eA", path: "/gateway/calls/incoming", body: "{}", kind: "call.incoming"))
    check(outboxB.head() == nil && GatewayOutbox(url: GatewayStorePaths.outbox(directory, gatewayId: gatewayB)).items.isEmpty,
          "outbox events never cross gateways")
}

// S54: provisioning step machine.
do {
    var state = GatewayProvisionState()
    check(state.step == .createGateway && !state.isFinished && !state.isFailed, "starts at createGateway")
    state.succeed(.pairingCode)
    check(state.step == .createGateway, "succeeding a step that is not current is ignored")
    state.gatewayId = "g"
    state.succeed(.createGateway)
    check(state.step == .pairingCode, "createGateway → pairingCode")
    state.pairingCode = "code"
    state.succeed(.pairingCode)
    state.fail(.pair, code: "PAIRING_CODE_INVALID")
    check(state.step == .pairingCode && state.pairingCode == nil && state.failure == "PAIRING_CODE_INVALID" && state.gatewayId == "g",
          "a stale pairing code retries from a fresh code, never a second gateway row")
    state.succeed(.pairingCode)
    check(state.step == .pair && state.failure == nil, "retry clears the failure")
    state.fail(.pair, code: "NETWORK_timeout")
    check(state.step == .pair && state.isFailed, "other pair failures retry the same step")
    state.succeed(.pair); state.succeed(.waitSIM)
    check(state.step == .assignOwner, "pair → waitSIM → assignOwner")
    let started = Date()
    check(GatewayProvisionState.ownerRetryable(code: "SIM_ABSENT", firstTriedAt: started, now: started.addingTimeInterval(10)) &&
          GatewayProvisionState.ownerRetryable(code: "GATEWAY_BUSY", firstTriedAt: started, now: started.addingTimeInterval(50)),
          "SIM_ABSENT / GATEWAY_BUSY retried within a minute")
    check(!GatewayProvisionState.ownerRetryable(code: "SIM_ABSENT", firstTriedAt: started, now: started.addingTimeInterval(61)) &&
          !GatewayProvisionState.ownerRetryable(code: "FORBIDDEN", firstTriedAt: started, now: started),
          "gives up after a minute or on other errors")
    state.succeed(.assignOwner); state.succeed(.labelSIM)
    check(state.isFinished, "labelSIM → done")
    let encoded = try? JSONEncoder().encode(state)
    check(encoded.flatMap { try? JSONDecoder().decode(GatewayProvisionState.self, from: $0) } == state, "state persists")
    check(GatewayProvisionState.gatewayName(imei: "861234567890123") == "DJI 4G 890123", "gateway name uses the last 6 digits")
}

// Remote-bridged calls hide the local call UI; unowned / local_only / S58 local dials keep it.
do {
    let bridges = GatewayRules.bridgesRemoteCall
    check(bridges(true, true, false), "answered by Web/app/AI → remote")
    check(bridges(true, false, true), "remote dial → remote")
    check(!bridges(true, false, false), "ringing or S58 local dial → local bar")
    check(!bridges(false, true, false) && !bridges(false, false, true), "unowned SIM / local_only (handlesCalls false) → local bar")
}

// S72 D2: module local ring gate.
do {
    let rings = GatewayRules.ringsModuleLocally
    check(rings(false, false, true) && rings(false, true, true), "unowned SIM / local_only always rings locally")
    check(rings(true, false, false), "gateway-owned, human mode, no client session → module rings")
    check(!rings(true, false, true), "gateway-owned with a VoDog session → client panel rings instead")
    check(!rings(true, true, false), "AI / busy / internal → silent")
    let silences = GatewayRules.silencesLocalRing
    check(silences("rejected_busy", nil) && silences("dropped_blocked", nil), "busy reject / blocked silence")
    check(silences("offer_to_owner", ["answerMode": "ai", "aiHandling": false]), "AI mode silences before the run starts")
    check(!silences("offer_to_owner", ["answerMode": "timeout_ai"]), "timeout AI rings like normal")
    check(silences("offer_to_owner", ["answerMode": "normal", "internal": true]), "internal peer leg is silent")
    check(silences("offer_to_owner", ["conflictDisposition": "ai_answered"]), "busy AI is silent")
    check(!silences("local_only", nil) && !silences(nil, ["answerMode": "normal"]), "local_only / human mode ring")
}

// Hangup mapping: positive match only (a pre-ACK dial hangup carries deviceCallId null).
do {
    func matches(_ callId: String?, _ payloadDevice: String?, _ server: String?, _ device: String) -> Bool {
        GatewayRules.hangupMatches(commandCallId: callId, payloadDeviceCallId: payloadDevice,
                                   serverCallId: server, deviceCallId: device)
    }
    check(matches("x", nil, "x", "d1"), "bound remote dial matches by server id")
    check(matches("x", "d1", nil, "d1"), "unbound incoming matches by device id")
    check(!matches("x", nil, "y", "d1"), "hangup for an unplaced dial never hits another call")
    check(!matches("x", nil, nil, "d1"), "no ids to compare is no match")
    check(!matches(nil, nil, nil, "d1"), "nil callId never matches a nil server id")
}

print("GatewayControlSelfTests passed")

check(VoDogServer.validatedURL("https://vodog.example.invalid") != nil, "configured HTTPS origin")
for invalid in ["http://example.invalid", "https://user:password@example.invalid", "https://example.invalid/path", "https://example.invalid?token=x", "https://example.invalid#fragment", "https://"] {
    check(VoDogServer.validatedURL(invalid) == nil, "reject invalid server origin")
}
