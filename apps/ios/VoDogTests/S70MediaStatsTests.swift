import XCTest
@testable import VoDog

/// S70: `media.summary` rx/tx counters from the audio inbound-rtp / outbound-rtp stats.
final class S70MediaStatsTests: XCTestCase {
    func testMapsAudioInboundAndOutboundAndIgnoresVideo() {
        let fields = MediaRtpStats.fields([
            (type: "inbound-rtp", values: [
                "kind": "video" as NSString, "packetsReceived": NSNumber(value: 999)
            ]),
            (type: "inbound-rtp", values: [
                "kind": "audio" as NSString, "packetsReceived": NSNumber(value: 1500), "packetsLost": NSNumber(value: 12),
                "jitter": NSNumber(value: 0.01234), "concealedSamples": NSNumber(value: 4800),
                "silentConcealedSamples": NSNumber(value: 4000),
                "totalSamplesReceived": NSNumber(value: 1_440_000), "concealmentEvents": NSNumber(value: 7),
                "jitterBufferDelay": NSNumber(value: 90_000.0), "jitterBufferEmittedCount": NSNumber(value: 1_440_000),
                "jitterBufferTargetDelay": NSNumber(value: 57_600.0),
                "insertedSamplesForDeceleration": NSNumber(value: 320), "removedSamplesForAcceleration": NSNumber(value: 160)
            ]),
            (type: "outbound-rtp", values: [
                "mediaType": "audio" as NSString, "packetsSent": NSNumber(value: 1490), "bytesSent": NSNumber(value: 123_456)
            ]),
            (type: "candidate-pair", values: ["bytesSent": NSNumber(value: 5)])
        ])
        let rx = fields["rx"] as? [String: Any]
        XCTAssertEqual(rx?["packetsReceived"] as? Int, 1500)
        XCTAssertEqual(rx?["packetsLost"] as? Int, 12)
        XCTAssertEqual(rx?["jitterMs"] as? Double, 12.3)
        XCTAssertEqual(rx?["jitterBufferMs"] as? Double, 62.5)
        XCTAssertEqual(rx?["jitterBufferTargetMs"] as? Double, 40)
        XCTAssertEqual(rx?["concealedSamples"] as? Int, 4800)
        XCTAssertEqual(rx?["silentConcealedSamples"] as? Int, 4000)
        XCTAssertEqual(rx?["totalSamplesReceived"] as? Int, 1_440_000)
        XCTAssertEqual(rx?["concealmentEvents"] as? Int, 7)
        XCTAssertEqual(rx?["insertedSamplesForDeceleration"] as? Int, 320)
        XCTAssertEqual(rx?["removedSamplesForAcceleration"] as? Int, 160)
        XCTAssertEqual(rx?.count, 11)
        let tx = fields["tx"] as? [String: Any]
        XCTAssertEqual(tx?["packetsSent"] as? Int, 1490)
        XCTAssertEqual(tx?["bytesSent"] as? Int, 123_456)
        XCTAssertEqual(tx?.count, 2)
        // The Diag encoder carries both as objects.
        let encoded = Diag.encode(fields, limit: 200)
        XCTAssertEqual(encoded["tx"], .object(["packetsSent": .int(1490), "bytesSent": .int(123_456)]))
    }

    func testOmitsJitterBufferWithoutEmittedSamplesAndEmptyReport() {
        let fields = MediaRtpStats.fields([
            (type: "inbound-rtp", values: [
                "kind": "audio" as NSString, "jitterBufferDelay": NSNumber(value: 0), "jitterBufferEmittedCount": NSNumber(value: 0)
            ])
        ])
        XCTAssertNil(fields["rx"])
        XCTAssertNil(fields["tx"])
        XCTAssertTrue(MediaRtpStats.fields([]).isEmpty)
    }

    func testWindowDeltasSincePreviousRowOfSamePeerAndResetOnNewPeer() {
        func report(_ delay: Double, _ target: Double, _ emitted: Double, _ events: Int, _ removed: Int, _ packets: Int)
            -> [(type: String, values: [String: Any])] {
            [(type: "inbound-rtp", values: [
                "kind": "audio" as NSString, "jitterBufferDelay": NSNumber(value: delay),
                "jitterBufferTargetDelay": NSNumber(value: target), "jitterBufferEmittedCount": NSNumber(value: emitted),
                "concealmentEvents": NSNumber(value: events), "removedSamplesForAcceleration": NSNumber(value: removed),
                "packetsReceived": NSNumber(value: packets)
            ])]
        }
        let window = MediaRtpWindow()
        let peerA = NSObject(), peerB = NSObject()
        XCTAssertTrue(window.fields(report(90_000, 57_600, 1_440_000, 7, 160, 1500), peerID: ObjectIdentifier(peerA)).isEmpty)
        // +48 000 samples emitted (1 s) with 4 800 sample-seconds of delay = 100 ms; target 2 400 = 50 ms.
        let second = window.fields(report(94_800, 60_000, 1_488_000, 9, 1_120, 1550), peerID: ObjectIdentifier(peerA))
        XCTAssertEqual(second["jitterBufferWinMs"] as? Double, 100)
        XCTAssertEqual(second["jitterBufferTargetWinMs"] as? Double, 50)
        XCTAssertEqual(second["concealmentEventsWin"] as? Int, 2)
        XCTAssertEqual(second["removedSamplesForAccelerationWin"] as? Int, 960)
        XCTAssertEqual(second["packetsReceivedWin"] as? Int, 50)
        XCTAssertEqual(second.count, 5)
        // A new PC (rejoin) restarts its counters; the first row of it has no window.
        XCTAssertTrue(window.fields(report(100, 50, 4_800, 0, 0, 50), peerID: ObjectIdentifier(peerB)).isEmpty)
        let rejoined = window.fields(report(1_060, 530, 52_800, 1, 10, 100), peerID: ObjectIdentifier(peerB))
        XCTAssertEqual(rejoined["jitterBufferWinMs"] as? Double, 20)
        XCTAssertEqual(rejoined["packetsReceivedWin"] as? Int, 50)
        // No emitted samples in the interval: counts only, no buffer averages.
        let idle = window.fields(report(1_060, 530, 52_800, 1, 10, 100), peerID: ObjectIdentifier(peerB))
        XCTAssertNil(idle["jitterBufferWinMs"])
        XCTAssertEqual(idle["packetsReceivedWin"] as? Int, 0)
        withExtendedLifetime((peerA, peerB)) {}
    }

    func testCallPeerUsesFastAccelerate() {
        XCTAssertTrue(MediaReceivePolicy.audioJitterBufferFastAccelerate)
    }

    /// Cellular bursts after 1–2 s stalls left the buffer ~1 s deep for the rest of the call; cap at ~500 ms.
    func testCallPeerCapsJitterBufferAt25Packets() {
        XCTAssertEqual(MediaReceivePolicy.audioJitterBufferMaxPackets, 25)
    }
}
