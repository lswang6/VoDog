import AVFoundation
import Foundation

struct CallRecordingWaveformData: Equatable {
    let remote: [Float]
    let local: [Float]
}

final class CallRecordingWaveformLoader: @unchecked Sendable {
    static let shared = CallRecordingWaveformLoader()

    private final class WaveformBox: NSObject {
        let waveform: CallRecordingWaveformData

        init(_ waveform: CallRecordingWaveformData) {
            self.waveform = waveform
        }
    }

    private let cache = NSCache<NSString, WaveformBox>()
    private init() {
        cache.countLimit = 48
    }

    func load(
        url: URL,
        sampleCount: Int = 420,
        completion: @escaping (Result<CallRecordingWaveformData, Error>) -> Void
    ) {
        let resolvedSampleCount = min(max(sampleCount, 120), 1_000)
        let key = cacheKey(url: url, sampleCount: resolvedSampleCount)
        if let cached = cache.object(forKey: key as NSString) {
            completion(.success(cached.waveform))
            return
        }

        Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            let result: Result<CallRecordingWaveformData, Error>
            do {
                result = .success(
                    try Self.extractWaveform(url: url, sampleCount: resolvedSampleCount)
                )
            } catch {
                result = .failure(error)
            }
            if case let .success(waveform) = result {
                self.cache.setObject(WaveformBox(waveform), forKey: key as NSString)
            }
            await MainActor.run {
                completion(result)
            }
        }
    }

    private func cacheKey(url: URL, sampleCount: Int) -> String {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let modifiedAt = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
        return "\(url.path)|\(modifiedAt)|\(size)|\(sampleCount)"
    }

    private static func extractWaveform(
        url: URL,
        sampleCount: Int
    ) throws -> CallRecordingWaveformData {
        let audioFile = try AVAudioFile(forReading: url)
        let format = audioFile.processingFormat
        guard audioFile.length > 0,
              format.channelCount > 0,
              format.commonFormat == .pcmFormatFloat32 else {
            throw WaveformError.missingAudioTrack
        }
        var remote = [Float](repeating: 0, count: sampleCount)
        var local = [Float](repeating: 0, count: sampleCount)
        let totalFrames = max(audioFile.length, 1)
        let frameCapacity: AVAudioFrameCount = 8_192
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: frameCapacity
        ) else {
            throw WaveformError.unreadableAudio
        }

        while audioFile.framePosition < audioFile.length {
            let startFrame = audioFile.framePosition
            try audioFile.read(into: buffer, frameCount: frameCapacity)
            let frameCount = Int(buffer.frameLength)
            guard frameCount > 0, let channels = buffer.floatChannelData else { break }
            for frame in 0 ..< frameCount {
                let absoluteFrame = startFrame + Int64(frame)
                let bin = min(
                    sampleCount - 1,
                    Int((Double(absoluteFrame) / Double(totalFrames)) * Double(sampleCount))
                )
                let remoteValue = abs(channels[0][frame])
                let localValue = format.channelCount > 1
                    ? abs(channels[1][frame])
                    : remoteValue
                if remoteValue.isFinite {
                    remote[bin] = max(remote[bin], remoteValue)
                }
                if localValue.isFinite {
                    local[bin] = max(local[bin], localValue)
                }
            }
        }

        let peak = max(remote.max() ?? 0, local.max() ?? 0)
        guard peak > 0 else {
            return CallRecordingWaveformData(remote: remote, local: local)
        }
        let normalize: (Float) -> Float = { value in
            sqrt(min(max(value / peak, 0), 1))
        }
        return CallRecordingWaveformData(
            remote: remote.map(normalize),
            local: local.map(normalize)
        )
    }

    private enum WaveformError: LocalizedError {
        case missingAudioTrack
        case unreadableAudio

        var errorDescription: String? {
            switch self {
            case .missingAudioTrack: return L10n.tr("录音文件中没有可读取的音轨。")
            case .unreadableAudio: return L10n.tr("无法读取录音声纹。")
            }
        }
    }
}
