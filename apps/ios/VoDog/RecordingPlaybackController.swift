import AVFoundation
import CryptoKit
import Foundation
import Observation

@MainActor @Observable
final class RecordingPlaybackController {
    static let shared = RecordingPlaybackController()

    enum TogetherMode: Equatable {
        case originals
        case compensated
    }

    enum State: Equatable {
        case idle
        case loading(RecordingTrack)
        case playing(RecordingTrack)
        case failed(RecordingTrack, String)
        case loadingTogether(TogetherMode)
        case playingTogether(TogetherMode)
        case failedTogether(TogetherMode, String)
    }

    private(set) var state: State = .idle
    private(set) var currentTime: TimeInterval = 0
    private(set) var duration: TimeInterval = 0
    private(set) var isPaused = false
    private var player: AVPlayer?
    private var pairedPlayer: AVPlayer?
    private var workTask: Task<Void, Never>?
    private var localURL: URL?
    private var pairedLocalURL: URL?
    private var completionObserver: NSObjectProtocol?
    private var timeObserver: Any?
    private var operationID = UUID()
    private var ownsAudioSessionActivation = false
    private let configureAudio: @MainActor () throws -> Void
    private let deactivateAudio: @MainActor () -> Void
    private let playbackCache: RecordingPlaybackCache

    init(
        configureAudio: @escaping @MainActor () throws -> Void = RecordingPlaybackController.configureSystemAudioSession,
        deactivateAudio: @escaping @MainActor () -> Void = RecordingPlaybackController.deactivateSystemAudioSession,
        playbackCache: RecordingPlaybackCache = .shared
    ) {
        self.configureAudio = configureAudio
        self.deactivateAudio = deactivateAudio
        self.playbackCache = playbackCache
    }

    internal var hasRetainedPlaybackResources: Bool {
        player != nil || pairedPlayer != nil || completionObserver != nil || localURL != nil || pairedLocalURL != nil || ownsAudioSessionActivation
    }

    func start(track: RecordingTrack, artifact: RecordingArtifact, source: RecordingSource,
               callID: String, session: SessionStore) {
        stop()
        guard artifact.bytes > 0 else {
            state = .failed(track, "该轨道没有可播放内容")
            return
        }
        guard AppAudioOwnershipPolicy.canStartRecordingPlayback(mediaCallID: CallMediaSession.shared.callID) else {
            state = .failed(track, "通话音频使用中，请先结束通话音频")
            return
        }
        guard let sessionIdentity = session.sessionIdentity,
              session.isCurrentSession(sessionIdentity) else {
            state = .failed(track, "登录会话已更改")
            return
        }
        state = .loading(track)
        seedDuration(artifact.durationMs)
        let id = UUID()
        operationID = id
        workTask = Task { [weak self] in
            guard let self else { return }
            var downloadedURL: URL?
            do {
                let playURL: URL
                if let cached = playbackCache.existingURL(sha256: artifact.sha256, bytes: artifact.bytes, source: source) {
                    playURL = cached
                } else {
                    if source == .pixel {
                        let preflight = try await session.recordingPreflight(
                            "calls/\(callID)/recordings/\(track.rawValue)", source: source,
                            requiredSessionIdentity: sessionIdentity
                        )
                        guard operationID == id, session.isCurrentSession(sessionIdentity),
                              RecordingResponseValidator.validatePreflight(preflight, artifact: artifact) else {
                            throw RecordingPlaybackError.contractMismatch
                        }
                    }
                    let download = try await session.download(
                        "calls/\(callID)/recordings/\(track.rawValue)",
                        source: source,
                        requiredSessionIdentity: sessionIdentity
                    )
                    downloadedURL = download.url
                    guard operationID == id, session.isCurrentSession(sessionIdentity) else {
                        try? FileManager.default.removeItem(at: download.url)
                        return
                    }
                    localURL = download.url
                    try Task.checkCancellation()
                    guard RecordingResponseValidator.validateDownload(download, artifact: artifact) else {
                        throw RecordingPlaybackError.contractMismatch
                    }
                    let verified = try await RecordingFileVerifier.verify(download.url, artifact: artifact)
                    try Task.checkCancellation()
                    guard verified else { throw RecordingPlaybackError.integrityMismatch }
                    playURL = (try? playbackCache.store(download.url, sha256: artifact.sha256, source: source)) ?? download.url
                }
                localURL = playURL
                let asset = AVURLAsset(url: playURL)
                let playable = try await asset.load(.isPlayable)
                guard playable, !(try await asset.loadTracks(withMediaType: .audio)).isEmpty else {
                    throw RecordingPlaybackError.unsupportedAudio
                }
                try Task.checkCancellation()
                guard operationID == id, session.isCurrentSession(sessionIdentity) else { return }
                let item = AVPlayerItem(asset: asset)
                let newPlayer = AVPlayer(playerItem: item)
                player = newPlayer
                do {
                    try configureAudio()
                    ownsAudioSessionActivation = true
                } catch {
                    // setCategory may have succeeded before setActive failed. Always attempt the
                    // inverse here even though ownership was not fully established.
                    deactivateAudio()
                    throw error
                }
                installTimeObserver(on: newPlayer)
                completionObserver = NotificationCenter.default.addObserver(
                    forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
                ) { [weak self, weak item] _ in Task { @MainActor in
                    guard let self, let item,
                          RecordingPlaybackCompletionPolicy.shouldStop(
                            observerOperationID: id, currentOperationID: self.operationID,
                            observedItemIsCurrent: self.player?.currentItem === item
                          ) else { return }
                    self.stop()
                } }
                newPlayer.play()
                isPaused = false
                state = .playing(track)
            } catch is CancellationError {
                if operationID == id { stop() }
                else if let downloadedURL { try? FileManager.default.removeItem(at: downloadedURL) }
            } catch {
                if operationID == id {
                    releasePlaybackResources()
                    removeLocalFile()
                    state = .failed(track, error.localizedDescription)
                } else if let downloadedURL {
                    try? FileManager.default.removeItem(at: downloadedURL)
                }
            }
        }
    }

    func startTogether(mode: TogetherMode, artifacts: [PlaybackArtifact], source: RecordingSource,
                       callID: String, session: SessionStore) {
        stop()
        let paths = Set(artifacts.map(\.path))
        let originalPair = Set([RecordingTrack.remoteOriginal.rawValue, RecordingTrack.callerOriginal.rawValue])
        let compensatedPair = Set([RecordingTrack.remoteOriginal.rawValue, "caller_playout"])
        let expectedPair = mode == .originals ? originalPair : compensatedPair
        guard artifacts.count == 2, paths == expectedPair,
              artifacts.allSatisfy({ $0.bytes > 0 }) else {
            state = .failedTogether(mode, "双方声轨尚未齐全，请分别播放可用原声")
            return
        }
        guard AppAudioOwnershipPolicy.canStartRecordingPlayback(mediaCallID: CallMediaSession.shared.callID) else {
            state = .failedTogether(mode, "通话音频使用中，请先结束通话音频")
            return
        }
        guard let sessionIdentity = session.sessionIdentity,
              session.isCurrentSession(sessionIdentity) else {
            state = .failedTogether(mode, "登录会话已更改")
            return
        }
        state = .loadingTogether(mode)
        seedDuration(artifacts.compactMap(\.durationMs).max())
        let id = UUID()
        operationID = id
        workTask = Task { [weak self] in
            guard let self else { return }
            var downloadedURLs: [URL] = []
            do {
                var playURLs: [URL] = []
                for artifact in artifacts.sorted(by: { $0.path < $1.path }) {
                    let playURL: URL
                    if let cached = playbackCache.existingURL(sha256: artifact.sha256, bytes: artifact.bytes, source: source) {
                        playURL = cached
                    } else {
                        if source == .pixel {
                            let preflight = try await session.recordingPreflight(
                                "calls/\(callID)/recordings/\(artifact.path)", source: source,
                                requiredSessionIdentity: sessionIdentity
                            )
                            guard operationID == id, session.isCurrentSession(sessionIdentity),
                                  RecordingResponseValidator.validatePreflight(preflight, artifact: artifact) else {
                                throw RecordingPlaybackError.contractMismatch
                            }
                        }
                        let download = try await session.download(
                            "calls/\(callID)/recordings/\(artifact.path)", source: source,
                            requiredSessionIdentity: sessionIdentity
                        )
                        downloadedURLs.append(download.url)
                        guard operationID == id, session.isCurrentSession(sessionIdentity),
                              RecordingResponseValidator.validateDownload(download, artifact: artifact),
                              try await RecordingFileVerifier.verify(download.url, artifact: artifact) else {
                            throw RecordingPlaybackError.integrityMismatch
                        }
                        playURL = (try? playbackCache.store(download.url, sha256: artifact.sha256, source: source)) ?? download.url
                    }
                    let asset = AVURLAsset(url: playURL)
                    guard try await asset.load(.isPlayable),
                          !(try await asset.loadTracks(withMediaType: .audio)).isEmpty else {
                        throw RecordingPlaybackError.unsupportedAudio
                    }
                    playURLs.append(playURL)
                }
                try Task.checkCancellation()
                guard operationID == id, session.isCurrentSession(sessionIdentity), playURLs.count == 2 else { return }
                localURL = playURLs[0]
                pairedLocalURL = playURLs[1]
                let first = AVPlayer(url: playURLs[0])
                let second = AVPlayer(url: playURLs[1])
                player = first
                pairedPlayer = second
                do {
                    try configureAudio()
                    ownsAudioSessionActivation = true
                } catch {
                    deactivateAudio()
                    throw error
                }
                installTimeObserver(on: first)
                completionObserver = NotificationCenter.default.addObserver(
                    forName: .AVPlayerItemDidPlayToEndTime, object: first.currentItem, queue: .main
                ) { [weak self] _ in Task { @MainActor in
                    guard let self, self.operationID == id else { return }
                    self.stop()
                } }
                first.play()
                second.play()
                isPaused = false
                state = .playingTogether(mode)
            } catch is CancellationError {
                if operationID == id { stop() }
                else { downloadedURLs.forEach { try? FileManager.default.removeItem(at: $0) } }
            } catch {
                if operationID == id {
                    releasePlaybackResources()
                    removeLocalFile()
                    state = .failedTogether(mode, error.localizedDescription)
                } else {
                    downloadedURLs.forEach { try? FileManager.default.removeItem(at: $0) }
                }
            }
        }
    }

    func pause() {
        guard isLivePlayback else { return }
        player?.pause()
        pairedPlayer?.pause()
        isPaused = true
    }

    func resume() {
        guard isLivePlayback else { return }
        player?.play()
        pairedPlayer?.play()
        isPaused = false
    }

    func seek(to seconds: TimeInterval) {
        guard isLivePlayback, seconds.isFinite else { return }
        let clamped = max(0, duration > 0 ? min(seconds, duration) : seconds)
        let time = CMTime(seconds: clamped, preferredTimescale: 600)
        player?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
        pairedPlayer?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
        currentTime = clamped
    }

    func stop() {
        operationID = UUID()
        workTask?.cancel()
        workTask = nil
        releasePlaybackResources()
        removeLocalFile()
        currentTime = 0
        duration = 0
        isPaused = false
        state = .idle
    }

    private var isLivePlayback: Bool {
        switch state {
        case .playing, .playingTogether: true
        default: false
        }
    }

    private func seedDuration(_ milliseconds: Int64?) {
        currentTime = 0
        isPaused = false
        if let milliseconds, milliseconds >= 0 {
            duration = Double(milliseconds) / 1_000
        } else {
            duration = 0
        }
    }

    private func installTimeObserver(on player: AVPlayer) {
        removeTimeObserver()
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 4), queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                self?.handleTime(time)
            }
        }
    }

    private func handleTime(_ time: CMTime) {
        let seconds = time.seconds
        if seconds.isFinite { currentTime = max(0, seconds) }
        let itemDuration = player?.currentItem?.duration.seconds ?? .nan
        if itemDuration.isFinite, itemDuration > 0, duration <= 0 {
            duration = itemDuration
        }
    }

    private func removeTimeObserver() {
        if let timeObserver {
            player?.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }
    }

    private func releasePlaybackResources() {
        player?.pause()
        pairedPlayer?.pause()
        removeTimeObserver()
        player?.replaceCurrentItem(with: nil)
        player = nil
        pairedPlayer?.replaceCurrentItem(with: nil)
        pairedPlayer = nil
        if let completionObserver { NotificationCenter.default.removeObserver(completionObserver) }
        completionObserver = nil
        if ownsAudioSessionActivation {
            deactivateAudio()
            ownsAudioSessionActivation = false
        }
    }

    static func configureSystemAudioSession() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .spokenAudio)
        try audio.setActive(true)
    }

    static func deactivateSystemAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func removeLocalFile() {
        if let localURL, !playbackCache.contains(localURL) {
            try? FileManager.default.removeItem(at: localURL)
        }
        if let pairedLocalURL, !playbackCache.contains(pairedLocalURL) {
            try? FileManager.default.removeItem(at: pairedLocalURL)
        }
        localURL = nil
        pairedLocalURL = nil
    }

}

struct RecordingPlaybackCache: Sendable {
    static let shared = RecordingPlaybackCache()
    let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("vodog-sha-cache", isDirectory: true)
    }

    func existingURL(sha256: String, bytes: Int64, source: RecordingSource) -> URL? {
        guard isCacheKey(sha256) else { return nil }
        let url = fileURL(sha256: sha256, source: source)
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber,
              size.int64Value == bytes else { return nil }
        return url
    }

    func store(_ url: URL, sha256: String, source: RecordingSource) throws -> URL {
        guard isCacheKey(sha256) else { return url }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let dest = fileURL(sha256: sha256, source: source)
        if dest.standardizedFileURL == url.standardizedFileURL { return dest }
        if FileManager.default.fileExists(atPath: dest.path) {
            try FileManager.default.removeItem(at: dest)
        }
        try FileManager.default.moveItem(at: url, to: dest)
        return dest
    }

    func contains(_ url: URL) -> Bool {
        let path = url.standardizedFileURL.path
        let root = directory.standardizedFileURL.path
        return path == root || path.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }

    private func fileURL(sha256: String, source: RecordingSource) -> URL {
        directory.appendingPathComponent("\(sha256).\(source == .pixel ? "wav" : "ogg")")
    }

    private func isCacheKey(_ sha256: String) -> Bool {
        sha256.count == 64 && sha256.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}

enum AppAudioOwnershipPolicy {
    static func canStartRecordingPlayback(mediaCallID: String?) -> Bool { mediaCallID == nil }
}

enum RecordingPlaybackCompletionPolicy {
    static func shouldStop(observerOperationID: UUID, currentOperationID: UUID, observedItemIsCurrent: Bool) -> Bool {
        observerOperationID == currentOperationID && observedItemIsCurrent
    }
}

enum RecordingFileVerifier {
    nonisolated static func verify(_ url: URL, artifact: RecordingArtifact) async throws -> Bool {
        try await verify(url, artifact: artifact.playbackArtifact)
    }
    nonisolated static func verify(_ url: URL, artifact: PlaybackArtifact) async throws -> Bool {
        try await Task.detached(priority: .utility) {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard (attributes[.size] as? NSNumber)?.int64Value == artifact.bytes else { return false }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hash = SHA256()
            while let chunk = try handle.read(upToCount: 256 * 1024), !chunk.isEmpty {
                hash.update(data: chunk)
            }
            return hash.finalize().map { String(format: "%02x", $0) }.joined() == artifact.sha256.lowercased()
        }.value
    }
}

private enum RecordingPlaybackError: LocalizedError {
    case contractMismatch, integrityMismatch, unsupportedAudio
    var errorDescription: String? {
        switch self {
        case .contractMismatch: "录音响应类型或大小与清单不一致"
        case .integrityMismatch: "录音完整性校验失败"
        case .unsupportedAudio: "当前系统无法解码此原始录音"
        }
    }
}
