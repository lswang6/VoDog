import AppKit
import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// 单一播放器：先用 `account.data` 把整轨下载到临时文件再交给 AVPlayer。
/// ponytail: 整轨下载而非流式；15 分钟令牌 + AVPlayer 的 Range 续传才是不可靠的那条路。
/// 录音很大、首播太慢时再改为 AVURLAsset + `AVURLAssetHTTPHeaderFieldsKey`（authorizedRequest 已备好）。
@MainActor
final class VoDogRecordingPlayer: ObservableObject {
    struct Key: Equatable { var callId: String; var track: String; var source: String }

    @Published private(set) var current: Key?
    @Published private(set) var loading = false
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0
    @Published var error: String?

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var fileURL: URL?
    private var loadTask: Task<Void, Never>?

    func isCurrent(_ key: Key) -> Bool { current == key }

    func toggle(_ key: Key, account: VoDogAccount) {
        switch CCPlaybackPolicy.action(isCurrent: current == key, hasPlayer: player != nil, isPlaying: isPlaying) {
        case .pause: pause()
        case .resume: resume()
        case .restart: play(key, account: account)
        }
    }

    func play(_ key: Key, account: VoDogAccount) {
        stop()
        current = key
        loading = true
        error = nil
        let started = Date()
        loadTask = Task { [weak self] in
            var bytes = 0
            var result = "ok"
            defer {
                account.diag("records.play", callId: key.callId, fields: [
                    "track": key.track, "source": key.source, "result": result,
                    "ms": Int(Date().timeIntervalSince(started) * 1_000), "bytes": bytes,
                ])
            }
            do {
                // 整段加载（下载 + 可播检查 + mp3 回退）受 30 s 看门狗约束：蜂窝网络卡住时给出错误而不是无限转圈。
                let fetch: @Sendable (Bool) async throws -> Data = { mp3 in
                    try await Self.fetch(key, mp3: mp3, account: account)
                }
                let (url, size) = try await CCAsync.withTimeout(CCPlaybackPolicy.loadTimeoutSeconds) {
                    try await Self.load(key, fetch: fetch)
                }
                bytes = size
                guard let self, !Task.isCancelled, self.current == key else {
                    result = "cancelled"; try? FileManager.default.removeItem(at: url); return
                }
                self.start(url)
            } catch {
                if error is CancellationError || Task.isCancelled { result = "cancelled"; return }
                result = error is CCTimeoutError ? "timeout" : "error"
                guard let self, self.current == key else { return }
                self.loading = false
                self.error = error is CCTimeoutError ? VoDogErrorText.shown(L10n.tr("加载超时，请重试"), error: error)
                    : VoDogRecordsError.message(error)
            }
        }
    }

    func pause() { player?.pause(); isPlaying = false }
    func resume() { player?.play(); isPlaying = player != nil }

    func seek(to seconds: Double) {
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
        currentTime = seconds
    }

    func stop() {
        loadTask?.cancel(); loadTask = nil
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        timeObserver = nil; endObserver = nil
        player?.pause(); player = nil
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil
        current = nil; loading = false; isPlaying = false; currentTime = 0; duration = 0
    }

    private func start(_ url: URL) {
        fileURL = url
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.player = player
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.currentTime = time.seconds.isFinite ? time.seconds : 0
                let total = item.duration.seconds
                if total.isFinite, total > 0 { self.duration = total }
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.isPlaying = false
                self?.player?.seek(to: .zero)
                self?.currentTime = 0
            }
        }
        loading = false
        player.play()
        isPlaying = true
    }

    @MainActor
    private static func fetch(_ key: Key, mp3: Bool, account: VoDogAccount) async throws -> Data {
        var query = ["source": key.source]
        if mp3 { query["format"] = "mp3" }
        return try await account.data("GET", "/calls/\(key.callId)/recordings/\(key.track)", query: query)
    }

    /// 下载到临时文件；原格式不可播时退到服务器转码的 mp3（`conversation` 本来就是 mp3）。
    nonisolated static func load(_ key: Key, fetch: @Sendable (Bool) async throws -> Data) async throws -> (URL, Int) {
        let mp3First = key.track == "conversation"
        var data = try await fetch(mp3First)
        var url = try write(data, ext: mp3First ? "mp3" : (key.source == "pixel" ? "wav" : "ogg"))
        if !mp3First, !(try await AVURLAsset(url: url).load(.isPlayable)) {
            try? FileManager.default.removeItem(at: url)
            data = try await fetch(true)
            url = try write(data, ext: "mp3")
        }
        return (url, data.count)
    }

    nonisolated private static func write(_ data: Data, ext: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vodog-\(UUID().uuidString).\(ext)")
        try data.write(to: url, options: .atomic)
        return url
    }
}

enum VoDogRecordsError {
    /// 统一错误文案（已本地化）；同时记 S69 `ui.error_shown`。
    static func message(_ error: Error, file: String = #fileID, site: String = #function) -> String {
        let text = text(for: error)
        VoDogErrorText.reportShown(text, error, file: file, site: site)
        return text
    }

    private static func text(for error: Error) -> String {
        if let api = error as? VoDogAPIError {
            switch (api.status, api.code) {
            case (409, "CALL_IN_USE"): return L10n.tr("通话仍在进行或处理中，稍后再删除。")
            case (404, _): return L10n.tr("这条记录已不存在或尚未生成。")
            case (503, "PIXEL_ARCHIVE_DISABLED"): return L10n.tr("设备原始归档尚未开启。")
            case (501, _): return L10n.tr("服务器暂不支持导出 MP3。")
            case (0, "NOT_IMPLEMENTED"): return L10n.tr("VoDog 账号尚未就绪。")
            default:
                return L10n.tr("请求失败（%@）", "\(api.status) \(api.code ?? "")".trimmingCharacters(in: .whitespaces))
            }
        }
        if error is URLError { return L10n.tr("网络暂时不可用，请检查网络后重试。") }
        return error.localizedDescription
    }
}

enum VoDogRecordingExport {
    /// NSSavePanel → mp3 导出（`track=conversation` 为双方混音）。
    @MainActor
    static func export(callId: String, track: String, source: String, account: VoDogAccount) async throws -> Bool {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(callId)-\(track).mp3"
        panel.allowedContentTypes = [.mp3]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        let data = try await account.data(
            "GET", "/calls/\(callId)/recordings/\(track)",
            query: ["source": source, "format": "mp3", "disposition": "attachment"]
        )
        try data.write(to: url, options: .atomic)
        return true
    }
}
