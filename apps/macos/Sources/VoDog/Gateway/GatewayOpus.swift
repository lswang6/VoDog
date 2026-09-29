import COpus
import Foundation

/// S70: libopus 1.6.1 (Sources/COpus) at the modem's native 8 kHz — no resampling on the
/// network path. Uplink: VOIP, SIGNAL_VOICE, 20 ms, 20 kbps, in-band FEC, 12 % expected loss,
/// complexity 10. S70 asked for 16 kbps, but libopus 1.6.1 `decide_fec` then never codes LBRR at
/// NB (loss-adjusted equivalent rate ≈ 13.7 kbps < NB threshold 14.7 kbps); 18 kbps is the
/// lowest rate that does, 20 kbps (= Pixel) leaves margin (Tests/GatewayMediaSelfTests checks LBRR is present). Downlink: decodes straight to 8 kHz; PLC = decode(NULL), FEC = decode(next,
/// fec=1). Decoder complexity 5 = libopus deep PLC (S70f, same as the Pixel gateway; LPCNet runs at
/// 16 kHz internally, only for CELT and WB SILK — NB SILK keeps classic PLC). The decoder is never reset (the S59d AVAudioConverter workaround is gone).
final class GatewayOpusCodec {
    static let sampleRate: Int32 = 8_000
    static let frameSamples = 160
    static let bitRate: Int32 = 20_000
    static let lossPercent: Int32 = 12
    static let complexity: Int32 = 10
    static let decoderComplexity: Int32 = 5
    private static let maxDecodeSamples = 480 // 60 ms at 8 kHz

    private let encoder: OpaquePointer
    private let decoder: OpaquePointer
    /// FEC decodes whose successor really carried LBRR (the rest were concealment).
    private(set) var fecRecovered = 0

    /// `decoderComplexity` < 5 = classic PLC (self-test baseline only).
    init?(decoderComplexity: Int32 = GatewayOpusCodec.decoderComplexity) {
        var error: Int32 = 0
        guard let encoder = celldock_opus_encoder_create(Self.bitRate, Self.lossPercent, Self.complexity, &error) else { return nil }
        guard let decoder = celldock_opus_decoder_create(Self.sampleRate, decoderComplexity, &error) else {
            opus_encoder_destroy(encoder)
            return nil
        }
        self.encoder = encoder
        self.decoder = decoder
    }

    deinit {
        opus_encoder_destroy(encoder)
        opus_decoder_destroy(decoder)
    }

    var decoderComplexity: Int { Int(celldock_opus_decoder_complexity(decoder)) }

    func encoderSetting(_ what: Int32) -> Int { Int(celldock_opus_encoder_get(encoder, what)) }

    /// One 160-sample (20 ms, 8 kHz) frame → one Opus packet.
    func encode(_ pcm: [Int16]) -> Data? {
        precondition(pcm.count == Self.frameSamples)
        var out = [UInt8](repeating: 0, count: 1_275)
        let n = opus_encode(encoder, pcm, Int32(pcm.count), &out, Int32(out.count))
        return n > 0 ? Data(out.prefix(Int(n))) : nil
    }

    func decode(_ source: GatewayPlayout.Source) -> [Int16] {
        switch source {
        case let .packet(packet):
            let pcm = run(packet.opus, samples: Self.maxDecodeSamples, fec: false)
            return pcm.isEmpty ? run(nil, samples: Int(packet.durationMs) * 8, fec: false) : pcm
        case let .fec(next, durationMs):
            if Self.hasLbrr(next.opus) { fecRecovered += 1 }
            return run(next.opus, samples: durationMs * 8, fec: true)
        case let .plc(durationMs):
            return run(nil, samples: durationMs * 8, fec: false)
        }
    }

    private func run(_ opus: Data?, samples: Int, fec: Bool) -> [Int16] {
        var pcm = [Int16](repeating: 0, count: samples)
        let n: Int32
        if let opus {
            n = opus.withUnsafeBytes { raw in
                opus_decode(decoder, raw.bindMemory(to: UInt8.self).baseAddress, Int32(opus.count), &pcm, Int32(samples), fec ? 1 : 0)
            }
        } else {
            n = opus_decode(decoder, nil, 0, &pcm, Int32(samples), 0)
        }
        // A failed concealment still has to fill its slot; a failed packet decode returns empty.
        guard n > 0 else { return opus == nil || fec ? pcm : [] }
        return Array(pcm.prefix(Int(n)))
    }

    static func hasLbrr(_ opus: Data) -> Bool {
        opus.withUnsafeBytes { opus_packet_has_lbrr($0.bindMemory(to: UInt8.self).baseAddress, Int32(opus.count)) } == 1
    }

    /// Index into [nb, mb, wb, swb, fb]; nil if the TOC is invalid.
    static func bandwidthIndex(_ opus: Data) -> Int? {
        guard let toc = opus.first else { return nil }
        let bw = withUnsafePointer(to: toc) { opus_packet_get_bandwidth($0) }
        let index = Int(bw - OPUS_BANDWIDTH_NARROWBAND)
        return (0 ..< 5).contains(index) ? index : nil
    }
}
