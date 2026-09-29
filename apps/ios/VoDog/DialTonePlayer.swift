import AudioToolbox
import AVFoundation

/// Short DTMF feedback tone for dial-pad presses.
///
/// Tones are synthesised locally, so no audio asset ships with the app. `+` is not a DTMF digit and stays silent,
/// which matches the iPhone phone app. Playback is best-effort: when the audio session is busy with a call the tone
/// is simply skipped instead of interrupting the call.
/// All mutable state is guarded by `lock`, so the shared instance is safe to use from any thread.
final class DialTonePlayer: @unchecked Sendable {
    static let shared = DialTonePlayer()

    static let toneDuration: TimeInterval = 0.12
    static let sampleRate: Double = 16_000
    private static let fadeSeconds: Double = 0.006
    private static let amplitude: Double = 0.25

    /// Standard DTMF keypad frequency pairs (low group, high group). `+` has no pair.
    static func dtmfFrequencies(for key: String) -> (low: Double, high: Double)? {
        switch key {
        case "1": (697, 1209)
        case "2": (697, 1336)
        case "3": (697, 1477)
        case "4": (770, 1209)
        case "5": (770, 1336)
        case "6": (770, 1477)
        case "7": (852, 1209)
        case "8": (852, 1336)
        case "9": (852, 1477)
        case "*": (941, 1209)
        case "0": (941, 1336)
        case "#": (941, 1477)
        default: nil
        }
    }

    private let lock = NSLock()
    private var players: [String: AVAudioPlayer] = [:]

    /// Plays the DTMF pair for `key`; returns false when the key has no tone or audio could not start.
    @discardableResult
    /// S36 C2: `preservingSession` is the in-call keypad. Re-declaring `.ambient` while the call owns
    /// playAndRecord/voiceChat restarts the voice-processing I/O unit and drops the WebRTC call — the rule
    /// `PhoneAudioRoutePolicy` states. Every other caller still claims `.ambient` on each tap, because the
    /// call session's category outlives the call (`cleanupTransport` only deactivates it) and the pre-call
    /// dialpad would otherwise route its tone to the receiver and open the microphone.
    func play(_ key: String, preservingSession: Bool = false) -> Bool {
        if !preservingSession {
            try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
        }
        guard let data = Self.waveData(for: key), let player = player(for: key, data: data) else { return false }
        lock.lock()
        player.currentTime = 0
        let started = player.play()
        lock.unlock()
        return started
    }

    func stop() {
        lock.lock()
        players.values.forEach { $0.stop() }
        lock.unlock()
    }

    private func player(for key: String, data: Data) -> AVAudioPlayer? {
        lock.lock()
        defer { lock.unlock() }
        if let existing = players[key] { return existing }
        guard let player = try? AVAudioPlayer(data: data) else { return nil }
        player.volume = 0.55
        player.prepareToPlay()
        players[key] = player
        return player
    }

    /// Builds a mono 16-bit PCM WAV holding the DTMF pair for `key`, or nil when the key has no tone.
    static func waveData(for key: String) -> Data? {
        guard let frequencies = dtmfFrequencies(for: key) else { return nil }
        let frameCount = Int((toneDuration * sampleRate).rounded())
        guard frameCount > 0 else { return nil }
        var samples = Data(capacity: frameCount * 2)
        let fadeFrames = max(1, Int(fadeSeconds * sampleRate))
        for frame in 0..<frameCount {
            let time = Double(frame) / sampleRate
            let envelope = min(1, Double(frame) / Double(fadeFrames), Double(frameCount - frame) / Double(fadeFrames))
            let value = (sin(2 * .pi * frequencies.low * time) + sin(2 * .pi * frequencies.high * time)) / 2
            let scaled = Int16((value * amplitude * envelope * Double(Int16.max)).rounded())
            withUnsafeBytes(of: scaled.littleEndian) { samples.append(contentsOf: $0) }
        }
        return wavContainer(pcm: samples, sampleRate: sampleRate, channels: 1, bitsPerSample: 16)
    }

    /// Minimal RIFF/WAVE container around little-endian PCM frames.
    static func wavContainer(pcm: Data, sampleRate: Double, channels: Int, bitsPerSample: Int) -> Data {
        var data = Data()
        let byteRate = Int(sampleRate) * channels * bitsPerSample / 8
        let blockAlign = channels * bitsPerSample / 8
        func append(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func append(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + pcm.count))
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        append(UInt32(16))
        append(UInt16(1))
        append(UInt16(channels))
        append(UInt32(sampleRate))
        append(UInt32(byteRate))
        append(UInt16(blockAlign))
        append(UInt16(bitsPerSample))
        data.append(contentsOf: Array("data".utf8))
        append(UInt32(pcm.count))
        data.append(pcm)
        return data
    }
}

/// Local incoming ringtone for the foreground-active app. CallKit plays its own sound when the app is not active.
final class IncomingRingtonePlayer: @unchecked Sendable {
    static let shared = IncomingRingtonePlayer()

    /// S44: how often the phone buzzes while an offer stands, and how long it may go on if nothing stops it.
    private static let vibrationInterval: DispatchTimeInterval = .milliseconds(1_800)
    private static let vibrationLimit: TimeInterval = 60

    private let lock = NSLock()
    private var player: AVAudioPlayer?
    private var vibration: DispatchSourceTimer?

    func start() {
        lock.lock()
        if player?.isPlaying == true {
            lock.unlock()
            return
        }
        let existing = player
        lock.unlock()
        let ready = existing ?? makePlayer()
        lock.lock()
        player = ready
        ready?.currentTime = 0
        ready?.play()
        lock.unlock()
    }

    /// S44: CallKit rings this iPhone but never vibrates it, even with 「触感反馈」设为始终播放, so the app buzzes
    /// on its own until something stops the offer. `AudioServicesPlaySystemSound` touches no audio session, so
    /// unlike `makePlayer` below it cannot steal CallKit's ringtone, and it still fires while the app sits in the
    /// background behind the call screen. Idempotent: a second push for the same ring keeps the first timer —
    /// one timer serves the app, so a stop for one offer also silences a second offer ringing behind it.
    ///
    /// ponytail: fixed cadence, one shared timer, no user setting; add a Settings toggle if anyone wants it off.
    func startVibration() {
        lock.lock()
        if vibration != nil {
            lock.unlock()
            return
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        vibration = timer
        lock.unlock()
        // A ring nobody stops is a phone buzzing in a pocket forever — the cap ends it without a second timer.
        let deadline = Date().addingTimeInterval(Self.vibrationLimit)
        timer.schedule(deadline: .now(), repeating: Self.vibrationInterval)
        timer.setEventHandler { [weak self] in
            guard Date() < deadline else {
                self?.stopVibration()
                return
            }
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }
        timer.resume()
    }

    func stop() {
        lock.lock()
        player?.stop()
        player?.currentTime = 0
        lock.unlock()
        stopVibration()
    }

    private func stopVibration() {
        lock.lock()
        let timer = vibration
        vibration = nil
        lock.unlock()
        timer?.cancel()
    }

    private func makePlayer() -> AVAudioPlayer? {
        // Do not retarget the shared AVAudioSession — that steals CallKit's ringtone
        // ("iOS Voice") and leaves the later WebRTC session silent.
        guard let data = Self.waveData(), let player = try? AVAudioPlayer(data: data) else { return nil }
        player.numberOfLoops = -1
        player.volume = 0.7
        player.prepareToPlay()
        return player
    }

    private static func waveData() -> Data? {
        let sampleRate = 16_000.0
        let onSeconds = 0.4
        let offSeconds = 0.2
        let cycles = 2
        let onFrames = Int((onSeconds * sampleRate).rounded())
        let offFrames = Int((offSeconds * sampleRate).rounded())
        var samples = Data()
        for _ in 0..<cycles {
            for frame in 0..<onFrames {
                let time = Double(frame) / sampleRate
                let value = (sin(2 * .pi * 440 * time) + sin(2 * .pi * 480 * time)) / 2
                let scaled = Int16((value * 0.22 * Double(Int16.max)).rounded())
                withUnsafeBytes(of: scaled.littleEndian) { samples.append(contentsOf: $0) }
            }
            samples.append(Data(count: offFrames * 2))
        }
        return DialTonePlayer.wavContainer(pcm: samples, sampleRate: sampleRate, channels: 1, bitsPerSample: 16)
    }
}
