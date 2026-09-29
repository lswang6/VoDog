import AVFoundation
import Combine
import Foundation

enum AlertSoundKind: String, CaseIterable, Identifiable {
    case message
    case incomingCall

    var id: Self { self }

    var title: String {
        switch self {
        case .message: return L10n.tr("短信提示音")
        case .incomingCall: return L10n.tr("来电铃声")
        }
    }

    fileprivate var bundledResourceName: String {
        switch self {
        case .message: return "bleeps"
        case .incomingCall: return "ring"
        }
    }

    fileprivate var bundledResourceExtension: String {
        switch self {
        case .message: return "wav"
        case .incomingCall: return "mp3"
        }
    }

    fileprivate var customFileKey: String {
        "VoDog.AlertSound.\(rawValue).customFile.v1"
    }

    fileprivate var customDisplayNameKey: String {
        "VoDog.AlertSound.\(rawValue).displayName.v1"
    }
}

enum AlertSoundServiceError: LocalizedError {
    case bundledSoundMissing(String)
    case invalidAudio

    var errorDescription: String? {
        switch self {
        case let .bundledSoundMissing(fileName):
            return L10n.tr("应用内置声音 %@ 不存在，请重新安装 VoDog。", fileName)
        case .invalidAudio:
            return L10n.tr("无法读取该音频文件，请选择 macOS 支持的音频格式。")
        }
    }
}

@MainActor
final class AlertSoundService: ObservableObject {
    static let shared = AlertSoundService()

    @Published private(set) var configurationRevision = 0
    @Published private(set) var previewingKind: AlertSoundKind?

    private let defaults = UserDefaults.standard
    private let fileManager = FileManager.default
    private var messagePlayer: AVAudioPlayer?
    private var ringtonePlayer: AVAudioPlayer?
    private var previewPlayer: AVAudioPlayer?
    private var previewStopTask: Task<Void, Never>?
    private var previewGeneration = UUID()

    private init() {}

    func displayName(for kind: AlertSoundKind) -> String {
        _ = configurationRevision
        if customSoundURL(for: kind) != nil {
            return defaults.string(forKey: kind.customDisplayNameKey) ?? L10n.tr("自定义音频")
        }
        let fileName = "\(kind.bundledResourceName).\(kind.bundledResourceExtension)"
        return L10n.tr("默认（%@）", fileName)
    }

    func isUsingDefault(_ kind: AlertSoundKind) -> Bool {
        _ = configurationRevision
        return customSoundURL(for: kind) == nil
    }

    func playMessageAlert() {
        guard let url = soundURL(for: .message) else { return }
        messagePlayer?.stop()
        messagePlayer = makePlayer(url: url, numberOfLoops: 0)
        messagePlayer?.play()
    }

    func startIncomingRingtone() {
        guard ringtonePlayer?.isPlaying != true,
              let url = soundURL(for: .incomingCall) else { return }
        ringtonePlayer = makePlayer(url: url, numberOfLoops: -1)
        ringtonePlayer?.play()
    }

    func stopIncomingRingtone() {
        ringtonePlayer?.stop()
        ringtonePlayer = nil
    }

    func stopAll() {
        messagePlayer?.stop()
        messagePlayer = nil
        stopIncomingRingtone()
        stopPreview()
    }

    func togglePreview(for kind: AlertSoundKind) throws {
        if previewingKind == kind {
            stopPreview()
            return
        }

        stopPreview()
        guard let url = soundURL(for: kind) else {
            throw AlertSoundServiceError.bundledSoundMissing(
                "\(kind.bundledResourceName).\(kind.bundledResourceExtension)"
            )
        }
        guard let player = makePlayer(url: url, numberOfLoops: 0) else {
            throw AlertSoundServiceError.invalidAudio
        }

        previewPlayer = player
        previewingKind = kind
        previewGeneration = UUID()
        let generation = previewGeneration
        player.play()

        let previewDuration = min(max(player.duration, 0.25), 8)
        previewStopTask = Task { @MainActor [weak self] in
            try? await Task.sleep(
                nanoseconds: UInt64(previewDuration * 1_000_000_000)
            )
            guard !Task.isCancelled,
                  let self,
                  self.previewGeneration == generation else { return }
            self.stopPreview()
        }
    }

    func installCustomSound(from sourceURL: URL, for kind: AlertSoundKind) throws {
        let accessedSecurityScope = sourceURL.startAccessingSecurityScopedResource()
        defer {
            if accessedSecurityScope {
                sourceURL.stopAccessingSecurityScopedResource()
            }
        }

        guard let validationPlayer = try? AVAudioPlayer(contentsOf: sourceURL),
              validationPlayer.duration.isFinite,
              validationPlayer.duration > 0 else {
            throw AlertSoundServiceError.invalidAudio
        }

        let directory = customSoundsDirectory
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let fileExtension = sourceURL.pathExtension.isEmpty
            ? "audio"
            : sourceURL.pathExtension.lowercased()
        let destination = directory.appendingPathComponent(
            "\(kind.rawValue)-\(UUID().uuidString).\(fileExtension)",
            isDirectory: false
        )
        try fileManager.copyItem(at: sourceURL, to: destination)

        guard let copiedPlayer = try? AVAudioPlayer(contentsOf: destination),
              copiedPlayer.duration.isFinite,
              copiedPlayer.duration > 0 else {
            try? fileManager.removeItem(at: destination)
            throw AlertSoundServiceError.invalidAudio
        }

        let previousURL = customSoundURL(for: kind)
        let wasRinging = kind == .incomingCall && ringtonePlayer?.isPlaying == true
        stopPreview()
        if kind == .incomingCall {
            stopIncomingRingtone()
        }
        defaults.set(destination.lastPathComponent, forKey: kind.customFileKey)
        defaults.set(sourceURL.lastPathComponent, forKey: kind.customDisplayNameKey)
        configurationRevision &+= 1

        if let previousURL, previousURL != destination {
            try? fileManager.removeItem(at: previousURL)
        }
        if wasRinging {
            startIncomingRingtone()
        }
    }

    func restoreDefault(for kind: AlertSoundKind) {
        let previousURL = customSoundURL(for: kind)
        let wasRinging = kind == .incomingCall && ringtonePlayer?.isPlaying == true
        stopPreview()
        if kind == .incomingCall {
            stopIncomingRingtone()
        }
        defaults.removeObject(forKey: kind.customFileKey)
        defaults.removeObject(forKey: kind.customDisplayNameKey)
        configurationRevision &+= 1
        if let previousURL {
            try? fileManager.removeItem(at: previousURL)
        }
        if wasRinging {
            startIncomingRingtone()
        }
    }

    private func stopPreview() {
        previewStopTask?.cancel()
        previewStopTask = nil
        previewPlayer?.stop()
        previewPlayer = nil
        previewingKind = nil
        previewGeneration = UUID()
    }

    private func makePlayer(url: URL, numberOfLoops: Int) -> AVAudioPlayer? {
        guard let player = try? AVAudioPlayer(contentsOf: url) else { return nil }
        player.numberOfLoops = numberOfLoops
        player.volume = 1
        guard player.prepareToPlay() else { return nil }
        return player
    }

    private func soundURL(for kind: AlertSoundKind) -> URL? {
        customSoundURL(for: kind) ?? Bundle.main.url(
            forResource: kind.bundledResourceName,
            withExtension: kind.bundledResourceExtension,
            subdirectory: "Sounds"
        )
    }

    private func customSoundURL(for kind: AlertSoundKind) -> URL? {
        guard let fileName = defaults.string(forKey: kind.customFileKey),
              !fileName.isEmpty else { return nil }
        let url = customSoundsDirectory.appendingPathComponent(fileName)
        return fileManager.fileExists(atPath: url.path) ? url : nil
    }

    private var customSoundsDirectory: URL {
        let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? fileManager.homeDirectoryForCurrentUser
        return applicationSupport
            .appendingPathComponent("VoDog", isDirectory: true)
            .appendingPathComponent("Sounds", isDirectory: true)
    }
}
