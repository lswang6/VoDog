import XCTest
@testable import VoDog

/// S20 decisions 1, 5, 6 and 8 for the iOS client.
final class S20ClientPolicyTests: XCTestCase {
    private func decodeCalls(_ json: String) throws -> [CallRecord] {
        try JSONDecoder().decode(ItemEnvelope<CallRecord>.self, from: Data(json.utf8)).items
    }

    private func decodeCall(_ json: String) throws -> CallRecord {
        try JSONDecoder().decode(CallRecord.self, from: Data(json.utf8))
    }

    // MARK: - D1 Opus offer fmtp

    func testOpusRewriteReplacesTheWholeFmtpLineIncludingDtx() {
        let sdp = [
            "v=0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
            "a=rtpmap:111 opus/48000/2",
            "a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=16000",
            "a=rtcp-fb:111 transport-cc",
        ].joined(separator: "\r\n")
        let rewritten = OpusOfferPolicy.rewrite(sdp: sdp)
        XCTAssertTrue(rewritten.contains("a=fmtp:111 \(OpusOfferPolicy.fmtpParameters)\r\n"))
        XCTAssertFalse(rewritten.contains("usedtx"))
        XCTAssertFalse(rewritten.contains("maxaveragebitrate=16000"))
        // Exactly one fmtp line for the payload: replaced, not appended to.
        XCTAssertEqual(rewritten.components(separatedBy: "a=fmtp:111").count - 1, 1)
    }

    func testOpusRewriteInsertsFmtpDirectlyAfterRtpmapWhenAbsent() {
        let sdp = [
            "v=0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111",
            "a=rtpmap:111 opus/48000/2",
            "a=rtcp-fb:111 nack",
        ].joined(separator: "\r\n")
        let lines = OpusOfferPolicy.rewrite(sdp: sdp).components(separatedBy: "\r\n")
        XCTAssertEqual(lines, [
            "v=0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111",
            "a=rtpmap:111 opus/48000/2",
            "a=fmtp:111 \(OpusOfferPolicy.fmtpParameters)",
            "a=rtcp-fb:111 nack",
        ])
    }

    func testOpusRewriteLeavesOtherPayloadsAndLineOrderUntouched() {
        let original = [
            "v=0",
            "o=- 1 2 IN IP4 127.0.0.1",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111 8 126",
            "a=rtpmap:111 OPUS/48000/2",
            "a=fmtp:111 usedtx=1",
            "a=rtpmap:8 PCMA/8000",
            "a=rtpmap:126 telephone-event/8000",
            "a=fmtp:126 0-16",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
            "a=sctp-port:5000",
        ].joined(separator: "\r\n")
        let rewritten = OpusOfferPolicy.rewrite(sdp: original).components(separatedBy: "\r\n")
        XCTAssertEqual(rewritten, [
            "v=0",
            "o=- 1 2 IN IP4 127.0.0.1",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111 8 126",
            // The encoding name is matched case-insensitively, as RFC 4566 allows.
            "a=rtpmap:111 OPUS/48000/2",
            "a=fmtp:111 \(OpusOfferPolicy.fmtpParameters)",
            "a=rtpmap:8 PCMA/8000",
            "a=rtpmap:126 telephone-event/8000",
            "a=fmtp:126 0-16",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
            "a=sctp-port:5000",
        ])
    }

    func testOpusRewriteIsANoOpWithoutOpusAndKeepsBareLineFeeds() {
        let sdp = "v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=sctp-port:5000\n"
        XCTAssertEqual(OpusOfferPolicy.rewrite(sdp: sdp), sdp)

        let lf = "v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\na=rtpmap:111 opus/48000/2\n"
        XCTAssertEqual(
            OpusOfferPolicy.rewrite(sdp: lf),
            "v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\na=rtpmap:111 opus/48000/2\n"
                + "a=fmtp:111 \(OpusOfferPolicy.fmtpParameters)\n"
        )
    }

    func testOpusContractPinsTheBitrateConstantAndOmitsDtx() {
        XCTAssertEqual(OpusOfferPolicy.maxAverageBitrate, 32_000)
        XCTAssertEqual(
            OpusOfferPolicy.fmtpParameters,
            "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;"
                + "maxplaybackrate=16000;sprop-maxcapturerate=16000"
        )
        XCTAssertEqual(OpusOfferPolicy.widebandParameters, "maxplaybackrate=16000;sprop-maxcapturerate=16000")
        XCTAssertFalse(OpusOfferPolicy.fmtpParameters.contains("usedtx"))
    }

    // MARK: - D5 refresh cadence

    func testRefreshIsResponsiveOnlyForOwnNonActiveTransitionalCalls() throws {
        let idle = try decodeCalls(#"""
        {"items":[
          {"id":"mine","state":"active","claimedByCurrentSession":true},
          {"id":"ended","state":"ended","claimedByCurrentSession":true},
          {"id":"others","state":"connecting","claimedByCurrentSession":false}
        ]}
        """#)
        XCTAssertEqual(
            CallRefreshCadencePolicy.interval(calls: idle, currentMediaCallID: "mine"),
            CallRefreshCadencePolicy.steady
        )
        XCTAssertEqual(CallRefreshCadencePolicy.steady, .seconds(5))

        for state in ["outgoing_pending", "connecting", "ending"] {
            let calls = try decodeCalls(
                #"{"items":[{"id":"mine","state":"\#(state)","claimedByCurrentSession":true}]}"#
            )
            XCTAssertEqual(
                CallRefreshCadencePolicy.interval(calls: calls, currentMediaCallID: nil),
                CallRefreshCadencePolicy.responsive,
                "\(state) should shorten the loop"
            )
        }
        XCTAssertEqual(CallRefreshCadencePolicy.responsive, .seconds(2))
    }

    func testRefreshTreatsRingingAsOwnAndConnectingMediaAsResponsive() throws {
        let ringing = try decodeCalls(
            #"{"items":[{"id":"ring","state":"incoming_ringing","claimedByCurrentSession":false}]}"#
        )
        XCTAssertEqual(
            CallRefreshCadencePolicy.interval(calls: ringing, currentMediaCallID: nil),
            CallRefreshCadencePolicy.responsive
        )

        // The list can already read `active` while this device is still bringing audio up.
        let active = try decodeCalls(
            #"{"items":[{"id":"mine","state":"active","claimedByCurrentSession":true}]}"#
        )
        XCTAssertEqual(
            CallRefreshCadencePolicy.interval(
                calls: active, currentMediaCallID: "mine", mediaIsConnecting: true
            ),
            CallRefreshCadencePolicy.responsive
        )
        XCTAssertEqual(
            CallRefreshCadencePolicy.interval(calls: [], currentMediaCallID: nil, mediaIsConnecting: true),
            CallRefreshCadencePolicy.steady,
            "No call means nothing to poll faster for"
        )
    }

    // MARK: - D6 occupancy DTO

    func testOccupancyIsOptionalAndDecodesDefensively() throws {
        let legacy = try decodeCall(#"{"id":"a","state":"active"}"#)
        XCTAssertNil(legacy.occupancy)

        let full = try decodeCall(#"""
        {"id":"b","state":"active","occupancy":{
          "holdsLock":true,"lockedSince":"2026-09-11T12:00:00.000Z","occupantPlatform":"android",
          "occupantDevice":"Pixel 7 Pro","isCurrentSession":false,"canRelease":true}}
        """#)
        XCTAssertEqual(full.occupancy, CallOccupancy(
            holdsLock: true, lockedSince: "2026-09-11T12:00:00.000Z", occupantPlatform: "android",
            occupantDevice: "Pixel 7 Pro", isCurrentSession: false, canRelease: true
        ))

        // A partial object must not fail the whole /calls response.
        let partial = try decodeCall(#"{"id":"c","state":"active","occupancy":{"holdsLock":true}}"#)
        XCTAssertEqual(partial.occupancy?.holdsLock, true)
        XCTAssertNil(partial.occupancy?.lockedSince)
        XCTAssertEqual(partial.occupancy?.canRelease, false)
        XCTAssertEqual(partial.occupancy?.isCurrentSession, false)
    }

    private static let busySIMs = #"""
    {"items":[
      {"id":"sim-a1","gatewayId":"gw-a","online":true,"telephonyReady":true,"mediaReady":true},
      {"id":"sim-a2","gatewayId":"gw-a","online":true,"telephonyReady":true,"mediaReady":true},
      {"id":"sim-b1","gatewayId":"gw-b","online":true,"telephonyReady":true,"mediaReady":true}
    ]}
    """#

    func testGatewayBusyPrefersStatedOccupancyOverTheActiveCallDerivation() throws {
        let sims = try JSONDecoder().decode(ItemEnvelope<SIMChannel>.self, from: Data(Self.busySIMs.utf8)).items

        // Stated and released: non-terminal, but the gateway lock is gone, so the device is free.
        let released = try decodeCalls(#"""
        {"items":[{"id":"c1","simId":"sim-a1","state":"ending","occupancy":{"holdsLock":false}}]}
        """#)
        XCTAssertFalse(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-a1", sims: sims, calls: released))
        XCTAssertFalse(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-a2", sims: sims, calls: released))
        XCTAssertFalse(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-b1", sims: sims, calls: released))

        let held = try decodeCalls(#"""
        {"items":[{"id":"c1","simId":"sim-a1","state":"active","occupancy":{"holdsLock":true}}]}
        """#)
        XCTAssertTrue(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-a1", sims: sims, calls: held))
        XCTAssertTrue(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-a2", sims: sims, calls: held))
        XCTAssertFalse(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-b1", sims: sims, calls: held))

        // No `occupancy` at all: the pre-S20 derivation still decides.
        let legacy = try decodeCalls(#"{"items":[{"id":"c1","simId":"sim-a1","state":"active"}]}"#)
        XCTAssertTrue(CallAvailabilityPolicy.gatewayIsBusy(simID: "sim-a2", sims: sims, calls: legacy))
        XCTAssertTrue(CallAvailabilityPolicy.gatewayIsBusy(simID: "unknown-sim", sims: sims, calls: []))
    }

    func testOccupancyStripStatesOccupantAndLockTime() throws {
        let sims = try JSONDecoder().decode(ItemEnvelope<SIMChannel>.self, from: Data(Self.busySIMs.utf8)).items
        let calls = try decodeCalls(#"""
        {"items":[{"id":"c1","simId":"sim-a2","state":"active","startedAt":"2026-09-11T11:00:00.000Z",
          "occupancy":{"holdsLock":true,"lockedSince":"2026-09-11T12:34:00.000Z","occupantPlatform":"ios",
          "isCurrentSession":false,"canRelease":true}}]}
        """#)
        let call = try XCTUnwrap(
            SIMOccupancyDisplayPolicy.occupyingCall(simID: "sim-a1", sims: sims, calls: calls)
        )
        let zone = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        // The Chinese occupant wording is the same mapping the Android client uses.
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(call), "iPhone 端")
        XCTAssertEqual(
            SIMOccupancyDisplayPolicy.summary(call, timeZone: zone),
            "通话中 · 由 iPhone 端 接听 · 自 2026-09-11 20:34"
        )
        XCTAssertTrue(SIMOccupancyDisplayPolicy.canRelease(call))
    }

    func testOccupancyStripFallsBackToStartedAtAndNamesTheDevice() throws {
        let call = try decodeCall(#"""
        {"id":"c1","simId":"sim-a1","state":"active","startedAt":"2026-09-11T12:00:00.000Z",
         "occupancy":{"holdsLock":true,"occupantPlatform":"android","occupantDevice":"Pixel 7 Pro",
         "isCurrentSession":false,"canRelease":true}}
        """#)
        let zone = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        XCTAssertEqual(
            SIMOccupancyDisplayPolicy.summary(call, timeZone: zone),
            "通话中 · 由 Pixel 7 Pro 接听 · 自 2026-09-11 20:00"
        )

        let web = try decodeCall(#"{"id":"c2","state":"active","occupancy":{"holdsLock":true,"occupantPlatform":"web"}}"#)
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(web), "网页端")
        let ai = try decodeCall(#"{"id":"c3","state":"active","occupancy":{"holdsLock":true,"occupantPlatform":"ai"}}"#)
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(ai), "AI 接听")
        let unknown = try decodeCall(#"{"id":"c4","state":"active","occupancy":{"holdsLock":true}}"#)
        XCTAssertEqual(SIMOccupancyDisplayPolicy.occupantTitle(unknown), "其他设备")
    }

    private func encodedBody(_ body: GuardedCallEndBody) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try XCTUnwrap(String(data: encoder.encode(body), encoding: .utf8))
    }

    func testReleaseIsOfferedOnlyForAnotherSessionAndNeverSendsTheSessionOwnerGuard() throws {
        let mine = try decodeCall(
            #"{"id":"c1","state":"active","occupancy":{"holdsLock":true,"isCurrentSession":true,"canRelease":true}}"#
        )
        XCTAssertFalse(SIMOccupancyDisplayPolicy.canRelease(mine), "Ending your own call is the in-call control")

        let notOwner = try decodeCall(
            #"{"id":"c2","state":"active","occupancy":{"holdsLock":true,"isCurrentSession":false,"canRelease":false}}"#
        )
        XCTAssertFalse(SIMOccupancyDisplayPolicy.canRelease(notOwner))

        let legacy = try decodeCall(#"{"id":"c3","state":"active"}"#)
        XCTAssertFalse(SIMOccupancyDisplayPolicy.canRelease(legacy))

        let other = try decodeCall(
            #"{"id":"c4","state":"active","occupancy":{"holdsLock":true,"isCurrentSession":false,"canRelease":true}}"#
        )
        XCTAssertTrue(SIMOccupancyDisplayPolicy.canRelease(other))

        // The server authorizes by snapshot owner; sending onlyIfCurrentSessionOwner would make it answer 409,
        // so a non-ringing release sends an empty object.
        let body = OccupancyReleaseActionPolicy.body(for: other)
        XCTAssertNil(body.onlyIfCurrentSessionOwner)
        XCTAssertNil(body.onlyIfRinging)
        XCTAssertEqual(try encodedBody(body), "{}")

        // That unguarded body is exactly why the release must not be retried: every constraint the retrying
        // `ReliableCallEndQueue` can send carries a guard, and the release is issued once, off that queue.
        for constraint in [ReliableCallEndConstraint.ringingUnclaimed, .currentSessionOwner] {
            let queued = constraint.body
            XCTAssertTrue(
                queued.onlyIfRinging != nil || queued.onlyIfCurrentSessionOwner != nil,
                "The retrying queue must never be able to send an unguarded end"
            )
            XCTAssertNotEqual(try encodedBody(queued), "{}")
        }
    }

    func testReleasingARingingCallIsWordedAndConstrainedAsADecline() throws {
        let ringing = try decodeCall(
            #"{"id":"c1","state":"incoming_ringing","occupancy":{"holdsLock":true,"isCurrentSession":false,"canRelease":true}}"#
        )
        // 拒接 is only meaningful while nobody has answered, so this one request does keep a guard.
        let ringingBody = OccupancyReleaseActionPolicy.body(for: ringing)
        XCTAssertEqual(ringingBody.onlyIfRinging, true)
        XCTAssertNil(ringingBody.onlyIfCurrentSessionOwner)
        XCTAssertEqual(try encodedBody(ringingBody), #"{"onlyIfRinging":true}"#)
        XCTAssertEqual(SIMOccupancyDisplayPolicy.confirmActionTitle(ringing), "拒接")
        XCTAssertEqual(SIMOccupancyDisplayPolicy.confirmTitle(ringing), "拒接这通来电？")
        XCTAssertFalse(SIMOccupancyDisplayPolicy.confirmMessage(ringing).contains("挂断"))

        let active = try decodeCall(
            #"{"id":"c2","state":"active","occupancy":{"holdsLock":true,"isCurrentSession":false,"canRelease":true}}"#
        )
        XCTAssertEqual(SIMOccupancyDisplayPolicy.confirmActionTitle(active), "结束通话")
        XCTAssertEqual(SIMOccupancyDisplayPolicy.confirmMessage(active), "将挂断本账号在另一台设备上的通话。")
    }

    /// S20 decision 6: the outbound id must be owned before `load()` and `startMedia()` are even reached.
    @MainActor
    func testOutboundCallIsOwnedAsSoonAsTheServerReturnsItsID() {
        let manager = IncomingCallManager.shared
        let identity = UUID()
        let callID = UUID().uuidString
        XCTAssertFalse(manager.ownedCallIDs(forSessionIdentity: identity).contains(callID.lowercased()))

        manager.registerOwnedCall(id: callID, sessionIdentity: identity)

        // No load(), no startMedia(): the id is already releasable on terminate.
        XCTAssertTrue(manager.ownedCallIDs(forSessionIdentity: identity).contains(callID.lowercased()))
        XCTAssertFalse(manager.ownedCallIDs(forSessionIdentity: UUID()).contains(callID.lowercased()))
        manager.registerOwnedCall(id: "", sessionIdentity: identity)
        XCTAssertFalse(manager.ownedCallIDs(forSessionIdentity: identity).contains(""))
    }

    // MARK: - D8 interface

    func testCallStateTitlesAreChineseForEveryServerState() {
        XCTAssertEqual(callStateTitle("incoming_ringing"), "来电响铃")
        XCTAssertEqual(callStateTitle("outgoing_pending"), "等待拨号")
        XCTAssertEqual(callStateTitle("connecting"), "连接中")
        XCTAssertEqual(callStateTitle("active"), "通话中")
        XCTAssertEqual(callStateTitle("ending"), "正在结束")
        XCTAssertEqual(callStateTitle("ended"), "已结束")
        XCTAssertEqual(callStateTitle("failed"), "失败")
        XCTAssertEqual(callStateTitle(nil), "状态待确认")
        XCTAssertEqual(callStateTitle("unknown"), "状态待确认")
        XCTAssertEqual(callPlatformTitle("ios"), "iPhone 端")
        XCTAssertNil(callPlatformTitle("desktop"))
    }

    func testGraceCountdownReportsWholeRemainingSeconds() {
        let start = Date(timeIntervalSince1970: 1_000)
        let deadline = MediaGracePolicy.deadline(from: start)
        XCTAssertEqual(deadline.timeIntervalSince(start), 30)
        XCTAssertEqual(MediaGracePolicy.remainingSeconds(deadline: deadline, now: start), 30)
        XCTAssertEqual(
            MediaGracePolicy.remainingSeconds(deadline: deadline, now: start.addingTimeInterval(29.2)), 1
        )
        XCTAssertEqual(
            MediaGracePolicy.remainingSeconds(deadline: deadline, now: start.addingTimeInterval(45)), 0,
            "An expired deadline never counts backwards"
        )
        XCTAssertEqual(MediaGracePolicy.remainingDescription(deadline: deadline, now: start), "剩余 30 秒")
    }

    func testSMSPickerBouncesASIMThatCannotSend() throws {
        let sims = try JSONDecoder().decode(ItemEnvelope<SIMChannel>.self, from: Data(#"""
        {"items":[
          {"id":"ok","online":true,"smsReady":true},
          {"id":"offline","online":false,"smsReady":true},
          {"id":"noSMS","online":true,"smsReady":false}
        ]}
        """#.utf8)).items

        XCTAssertEqual(SIMPickerFallbackPolicy.resolveSMS(selected: "ok", previous: "ok", sims: sims), "ok")
        XCTAssertEqual(SIMPickerFallbackPolicy.resolveSMS(selected: "offline", previous: "ok", sims: sims), "ok")
        XCTAssertEqual(SIMPickerFallbackPolicy.resolveSMS(selected: "noSMS", previous: "ok", sims: sims), "ok")
        XCTAssertTrue(SIMPickerFallbackPolicy.rejected(selected: "noSMS", previous: "ok", sims: sims))
        XCTAssertFalse(SIMPickerFallbackPolicy.rejected(selected: "ok", previous: "ok", sims: sims))
        // With nothing usable to fall back to there is no bounce to make, so the selection is left alone.
        let unusable = Array(sims.dropFirst())
        XCTAssertEqual(
            SIMPickerFallbackPolicy.resolveSMS(selected: "offline", previous: "noSMS", sims: unusable), "noSMS"
        )
        XCTAssertFalse(SIMPickerFallbackPolicy.rejected(selected: "offline", previous: nil, sims: unusable))
    }
}
