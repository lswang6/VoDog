import Foundation

/// S20 decision 1: one Opus `a=fmtp` contract across web, Android and iOS.
///
/// The offer libwebrtc produces on iOS carries no `maxaveragebitrate`, which makes it fall back to the fullband mono
/// default — the same 32 kbps this policy pins explicitly, so iOS does not change rate, it only stops depending on a
/// default. `usedtx` is deliberately absent: DTX silence gaps exceed the 200 ms resync threshold of the Pixel playout
/// buffer and force a decoder reset roughly every 400 ms of silence.
///
/// The bitrate lives in its own constant so it can be rolled back independently of the DTX removal (invariant 5).
enum OpusOfferPolicy {
    /// Bytes per second are the server's unit; this is bits per second, matching the `maxaveragebitrate` fmtp key.
    static let maxAverageBitrate = 32_000

    /// S70: both gateways decode at <= 16 kHz, so every bit spent above wideband is wasted. Its own constant so it
    /// can be rolled back independently (S20 invariant 5).
    static let widebandParameters = "maxplaybackrate=16000;sprop-maxcapturerate=16000"

    /// The whole parameter string. The rewrite replaces an existing `a=fmtp` line wholesale rather than appending,
    /// so a browser or platform that already emitted `usedtx=1` or a lower bitrate cannot survive the rewrite.
    static let fmtpParameters =
        "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=\(maxAverageBitrate);\(widebandParameters)"

    /// Returns `sdp` with every Opus payload type carrying exactly `fmtpParameters`.
    ///
    /// Lines that are not Opus `a=fmtp` lines are returned byte-identical and in their original order; a missing
    /// `a=fmtp` is inserted directly after its `a=rtpmap` line. CRLF and LF endings are both preserved per line.
    static func rewrite(sdp: String) -> String {
        let lines = sdp.components(separatedBy: "\n")
        var opusPayloads: Set<String> = []
        var payloadsWithFmtp: Set<String> = []
        for line in lines {
            let body = stripCarriageReturn(line)
            if let payload = opusPayloadType(rtpmap: body) { opusPayloads.insert(payload) }
            if let payload = payloadType(fmtp: body) { payloadsWithFmtp.insert(payload) }
        }
        guard !opusPayloads.isEmpty else { return sdp }

        var rewritten: [String] = []
        rewritten.reserveCapacity(lines.count + opusPayloads.count)
        for line in lines {
            let carriage = line.hasSuffix("\r")
            let body = stripCarriageReturn(line)
            if let payload = payloadType(fmtp: body), opusPayloads.contains(payload) {
                rewritten.append(terminate("a=fmtp:\(payload) \(fmtpParameters)", carriage: carriage))
                continue
            }
            rewritten.append(line)
            if let payload = opusPayloadType(rtpmap: body), !payloadsWithFmtp.contains(payload) {
                rewritten.append(terminate("a=fmtp:\(payload) \(fmtpParameters)", carriage: carriage))
            }
        }
        return rewritten.joined(separator: "\n")
    }

    private static func stripCarriageReturn(_ line: String) -> String {
        line.hasSuffix("\r") ? String(line.dropLast()) : line
    }

    private static func terminate(_ line: String, carriage: Bool) -> String {
        carriage ? line + "\r" : line
    }

    /// `a=rtpmap:<payload> opus/48000/2` — the encoding name is compared case-insensitively, as RFC 4566 allows.
    private static func opusPayloadType(rtpmap body: String) -> String? {
        guard body.hasPrefix("a=rtpmap:") else { return nil }
        let rest = body.dropFirst("a=rtpmap:".count)
        guard let space = rest.firstIndex(of: " ") else { return nil }
        let payload = String(rest[rest.startIndex..<space])
        guard isNumericPayload(payload) else { return nil }
        let encoding = rest[rest.index(after: space)...]
        let name = encoding.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        guard name.lowercased() == "opus" else { return nil }
        return payload
    }

    /// `a=fmtp:<payload> <parameters>` — the payload type only, without deciding whether it is Opus.
    private static func payloadType(fmtp body: String) -> String? {
        guard body.hasPrefix("a=fmtp:") else { return nil }
        let rest = body.dropFirst("a=fmtp:".count)
        let payload = String(rest.prefix(while: { $0 != " " }))
        guard isNumericPayload(payload) else { return nil }
        return payload
    }

    private static func isNumericPayload(_ value: String) -> Bool {
        !value.isEmpty && value.allSatisfy(\.isNumber)
    }
}
