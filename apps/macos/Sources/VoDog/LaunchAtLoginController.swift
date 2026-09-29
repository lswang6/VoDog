import Foundation

enum LaunchAtLoginStatus: Equatable {
    case disabled
    case enabled
    case unavailable

    var isRegistered: Bool {
        self == .enabled
    }
}

enum LaunchAtLoginControllerError: LocalizedError {
    case unavailable
    case launchctl(String)
    case stillLoaded

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return L10n.tr("当前应用位置或用户会话不支持登录启动。")
        case let .launchctl(message):
            return message.isEmpty ? L10n.tr("launchctl 未能更新登录启动服务。") : message
        case .stillLoaded:
            return L10n.tr("登录启动服务仍处于加载状态。")
        }
    }
}

struct LaunchAtLoginController {
    static let label = "org.vodog.macos.launch-at-login"
    private static let legacyLabel = "org.vodog.macos.legacy.launch-at-login"
    /// Passed by the LaunchAgent so a login launch stays in the menu bar instead of opening a window.
    static let launchArgument = "--launched-at-login"

    static var launchedAtLogin: Bool { CommandLine.arguments.contains(launchArgument) }

    private let fileManager = FileManager.default

    private var userID: uid_t {
        getuid()
    }

    private var launchAgentsDirectory: URL {
        fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }

    private var propertyListURL: URL {
        launchAgentsDirectory.appendingPathComponent("\(Self.label).plist")
    }

    private var applicationURL: URL {
        Bundle.main.bundleURL.standardizedFileURL
    }

    private var domainTarget: String {
        "gui/\(userID)"
    }

    private var serviceTarget: String {
        "\(domainTarget)/\(Self.label)"
    }

    var status: LaunchAtLoginStatus {
        guard isAvailable else { return .unavailable }
        guard configurationMatchesCurrentApplication, isLoaded else { return .disabled }
        return .enabled
    }

    func migrateLegacyRegistrationIfNeeded() throws {
        // Agents written before `launchArgument` existed: rewrite them so login launches stay quiet.
        if isAvailable, installedProgramArguments == Array(Self.programArguments(appBundlePath: applicationURL.path).dropLast(2)) {
            try? installAndBootstrap()
        }
        let legacyPropertyListURL = launchAgentsDirectory
            .appendingPathComponent("\(Self.legacyLabel).plist")
        guard fileManager.fileExists(atPath: legacyPropertyListURL.path) else { return }

        let legacyServiceTarget = "\(domainTarget)/\(Self.legacyLabel)"
        _ = runLaunchctl(["bootout", legacyServiceTarget])
        try fileManager.removeItem(at: legacyPropertyListURL)
        if status != .enabled {
            try installAndBootstrap()
        }
    }

    /// Fresh installs start registered, once; later launches never override the user's choice.
    func enableByDefaultIfNeeded(isFreshInstall: Bool, defaults: UserDefaults = .standard) {
        let key = "LaunchAtLoginDefaultApplied.v1"
        guard !defaults.bool(forKey: key) else { return }
        // A translocated or non-bundle first run keeps the one-shot for the next launch.
        if isFreshInstall {
            guard !applicationURL.path.contains("/AppTranslocation/"), (try? setEnabled(true)) != nil else { return }
        }
        defaults.set(true, forKey: key)
    }

    func setEnabled(_ enabled: Bool) throws {
        guard isAvailable else { throw LaunchAtLoginControllerError.unavailable }
        if enabled {
            guard status != .enabled else { return }
            try installAndBootstrap()
        } else {
            try removeAndBootout()
        }
    }

    static func propertyList(appBundlePath: String) -> [String: Any] {
        [
            "Label": label,
            "ProgramArguments": programArguments(appBundlePath: appBundlePath),
            "RunAtLoad": true,
            "LimitLoadToSessionType": "Aqua",
            "ProcessType": "Interactive",
            "ThrottleInterval": 10,
        ]
    }

    static func programArguments(appBundlePath: String) -> [String] {
        ["/usr/bin/open", "-g", appBundlePath, "--args", launchArgument]
    }

    private var installedProgramArguments: [String]? {
        guard let data = try? Data(contentsOf: propertyListURL),
              let propertyList = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return propertyList["ProgramArguments"] as? [String]
    }

    private var isAvailable: Bool {
        applicationURL.pathExtension.lowercased() == "app" &&
            fileManager.isExecutableFile(atPath: "/bin/launchctl") &&
            fileManager.isExecutableFile(atPath: "/usr/bin/open")
    }

    private var configurationMatchesCurrentApplication: Bool {
        guard let data = try? Data(contentsOf: propertyListURL),
              let object = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let propertyList = object as? [String: Any],
              propertyList["Label"] as? String == Self.label,
              propertyList["ProgramArguments"] as? [String] == Self.programArguments(appBundlePath: applicationURL.path),
              propertyList["RunAtLoad"] as? Bool == true else {
            return false
        }
        return true
    }

    private var isLoaded: Bool {
        runLaunchctl(["print", serviceTarget]).status == 0
    }

    private func installAndBootstrap() throws {
        if isLoaded {
            let bootout = runLaunchctl(["bootout", serviceTarget])
            guard bootout.status == 0 else {
                throw LaunchAtLoginControllerError.launchctl(bootout.output)
            }
        }

        try fileManager.createDirectory(
            at: launchAgentsDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o755]
        )
        let data = try PropertyListSerialization.data(
            fromPropertyList: Self.propertyList(appBundlePath: applicationURL.path),
            format: .xml,
            options: 0
        )
        try data.write(to: propertyListURL, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: propertyListURL.path)

        _ = runLaunchctl(["enable", serviceTarget])
        let bootstrap = runLaunchctl(["bootstrap", domainTarget, propertyListURL.path])
        guard bootstrap.status == 0, isLoaded else {
            try? fileManager.removeItem(at: propertyListURL)
            throw LaunchAtLoginControllerError.launchctl(bootstrap.output)
        }
    }

    private func removeAndBootout() throws {
        if isLoaded {
            let bootout = runLaunchctl(["bootout", serviceTarget])
            guard bootout.status == 0 else {
                throw LaunchAtLoginControllerError.launchctl(bootout.output)
            }
        }
        if fileManager.fileExists(atPath: propertyListURL.path) {
            try fileManager.removeItem(at: propertyListURL)
        }
        guard !isLoaded else {
            throw LaunchAtLoginControllerError.stillLoaded
        }
    }

    private func runLaunchctl(_ arguments: [String]) -> CommandResult {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return CommandResult(status: process.terminationStatus, output: output)
        } catch {
            return CommandResult(status: -1, output: error.localizedDescription)
        }
    }

    private struct CommandResult {
        let status: Int32
        let output: String
    }
}
