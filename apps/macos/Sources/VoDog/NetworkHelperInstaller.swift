import CryptoKit
import Foundation
import VoDogNetworkIPC
import Security

enum NetworkHelperInstallationError: LocalizedError {
    case invalidAppLocation
    case missingBundledFile(String)
    case invalidBundledHelper
    case cancelled
    case launchFailed(String)
    case installationFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidAppLocation:
            return L10n.tr("VoDog 必须位于“应用程序”文件夹中，才能安全安装网络 helper。")
        case let .missingBundledFile(name):
            return L10n.tr("当前 VoDog 安装包缺少 %@，请重新安装最新版。", name)
        case .invalidBundledHelper:
            return L10n.tr("安装包内的网络 helper 签名校验失败，未请求管理员权限。")
        case .cancelled:
            return L10n.tr("你取消了网络 helper 的首次安装。")
        case let .launchFailed(message):
            return L10n.tr("无法启动 helper 安装程序：%@", message)
        case let .installationFailed(message):
            return L10n.tr("网络 helper 安装失败：%@", message)
        }
    }
}

struct NetworkHelperInstaller {
    private struct ValidatedBundle {
        let certificateSHA1: String
        let helperSHA256: String
        let voWiFiRuntimeSHA256: String
        let plistSHA256: String
    }

    private let fileManager = FileManager.default

    func install() -> Result<Void, NetworkHelperInstallationError> {
        guard isRunningFromAllowedAppLocation else {
            return .failure(.invalidAppLocation)
        }

        let helperSource = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Library/PrivilegedHelperTools")
            .appendingPathComponent(VoDogNetworkIPC.helperExecutableName)
        let plistSource = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Library/LaunchDaemons")
            .appendingPathComponent(VoDogNetworkIPC.launchDaemonPlistName)
        let voWiFiRuntimeSource = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Library/PrivilegedHelperTools")
            .appendingPathComponent(VoDogNetworkIPC.voWiFiRuntimeExecutableName)

        guard fileManager.isExecutableFile(atPath: helperSource.path) else {
            return .failure(.missingBundledFile(VoDogNetworkIPC.helperExecutableName))
        }
        guard fileManager.fileExists(atPath: plistSource.path) else {
            return .failure(.missingBundledFile(VoDogNetworkIPC.launchDaemonPlistName))
        }
        guard fileManager.isExecutableFile(atPath: voWiFiRuntimeSource.path) else {
            return .failure(.missingBundledFile(VoDogNetworkIPC.voWiFiRuntimeExecutableName))
        }
        guard let validatedBundle = validateBundledFiles(
            helperURL: helperSource,
            voWiFiRuntimeURL: voWiFiRuntimeSource,
            plistURL: plistSource
        ) else {
            return .failure(.invalidBundledHelper)
        }

        let helperDestination = "/Library/PrivilegedHelperTools/\(VoDogNetworkIPC.helperExecutableName)"
        let plistDestination = "/Library/LaunchDaemons/\(VoDogNetworkIPC.launchDaemonPlistName)"
        let voWiFiRuntimeDestination = "/Library/PrivilegedHelperTools/\(VoDogNetworkIPC.voWiFiRuntimeExecutableName)"
        let installationID = UUID().uuidString.lowercased()
        let helperTemporary = "/Library/PrivilegedHelperTools/.VoDogNetworkHelper.\(installationID)"
        let plistTemporary = "/Library/LaunchDaemons/.\(VoDogNetworkIPC.launchDaemonPlistName).\(installationID)"
        let voWiFiRuntimeTemporary = "/Library/PrivilegedHelperTools/.VoDogVoWiFiRuntime.\(installationID)"
        let serviceTarget = "system/\(VoDogNetworkIPC.helperLabel)"
        let legacyBrandedServiceTarget = "system/app.mavo.celldock.network.helper"
        let legacyOriginalServiceTarget = "system/org.vodog.macos.legacy.network-helper"
        let legacyOriginalHelperDestination = "/Library/PrivilegedHelperTools/MaVoNetworkHelper"
        let legacyBrandedPlistDestination =
            "/Library/LaunchDaemons/app.mavo.celldock.network.helper.plist"
        let legacyOriginalPlistDestination =
            "/Library/LaunchDaemons/org.vodog.macos.legacy.network-helper.plist"
        let helperRequirement = "=identifier \"\(VoDogCodeSigningPolicy.helperIdentifier)\" " +
            "and certificate leaf = H\"\(validatedBundle.certificateSHA1)\""
        let runtimeRequirement = "=identifier \"org.vodog.macos.vowifi.runtime\" " +
            "and certificate leaf = H\"\(validatedBundle.certificateSHA1)\""
        let cleanupCommand = "/bin/rm -f \(shellQuote(helperTemporary)) " +
            "\(shellQuote(voWiFiRuntimeTemporary)) \(shellQuote(plistTemporary))"
        let commands = [
            "set -e",
            "trap \(shellQuote(cleanupCommand)) EXIT HUP INT TERM",
            "/usr/bin/install -d -o root -g wheel -m 0755 /Library/PrivilegedHelperTools",
            "/usr/bin/install -d -o root -g wheel -m 0755 /Library/LaunchDaemons",
            "/usr/bin/install -o root -g wheel -m 0755 \(shellQuote(helperSource.path)) \(shellQuote(helperTemporary))",
            "/usr/bin/install -o root -g wheel -m 0755 \(shellQuote(voWiFiRuntimeSource.path)) \(shellQuote(voWiFiRuntimeTemporary))",
            "/usr/bin/install -o root -g wheel -m 0644 \(shellQuote(plistSource.path)) \(shellQuote(plistTemporary))",
            digestCheckCommand(
                expectedSHA256: validatedBundle.helperSHA256,
                path: helperTemporary
            ),
            digestCheckCommand(
                expectedSHA256: validatedBundle.voWiFiRuntimeSHA256,
                path: voWiFiRuntimeTemporary
            ),
            digestCheckCommand(
                expectedSHA256: validatedBundle.plistSHA256,
                path: plistTemporary
            ),
            "/usr/bin/codesign --verify --strict --test-requirement " +
                "\(shellQuote(helperRequirement)) \(shellQuote(helperTemporary))",
            "/usr/bin/codesign --verify --strict --test-requirement " +
                "\(shellQuote(runtimeRequirement)) \(shellQuote(voWiFiRuntimeTemporary))",
            "/usr/bin/plutil -lint \(shellQuote(plistTemporary)) >/dev/null",
            "/bin/launchctl bootout \(shellQuote(serviceTarget)) >/dev/null 2>&1 || true",
            "/bin/launchctl bootout \(shellQuote(legacyBrandedServiceTarget)) >/dev/null 2>&1 || true",
            "/bin/launchctl bootout \(shellQuote(legacyOriginalServiceTarget)) >/dev/null 2>&1 || true",
            "/bin/rm -f \(shellQuote(legacyOriginalHelperDestination)) " +
                "\(shellQuote(legacyBrandedPlistDestination)) " +
                "\(shellQuote(legacyOriginalPlistDestination))",
            "/bin/mv -f \(shellQuote(helperTemporary)) \(shellQuote(helperDestination))",
            "/bin/mv -f \(shellQuote(voWiFiRuntimeTemporary)) \(shellQuote(voWiFiRuntimeDestination))",
            "/bin/mv -f \(shellQuote(plistTemporary)) \(shellQuote(plistDestination))",
            "/usr/sbin/chown root:wheel \(shellQuote(helperDestination)) \(shellQuote(voWiFiRuntimeDestination)) \(shellQuote(plistDestination))",
            "/bin/chmod 0755 \(shellQuote(helperDestination)) \(shellQuote(voWiFiRuntimeDestination))",
            "/bin/chmod 0644 \(shellQuote(plistDestination))",
            // Archive extractors can recursively quarantine every file in the app bundle.
            // `install` preserves that xattr, and launchd then refuses to trust the copied
            // LaunchDaemon with error 155. Remove only quarantine from the two validated,
            // fixed destinations before asking launchd to import the service.
            "/usr/bin/xattr -d com.apple.quarantine \(shellQuote(helperDestination)) >/dev/null 2>&1 || true",
            "/usr/bin/xattr -d com.apple.quarantine \(shellQuote(voWiFiRuntimeDestination)) >/dev/null 2>&1 || true",
            "/usr/bin/xattr -d com.apple.quarantine \(shellQuote(plistDestination)) >/dev/null 2>&1 || true",
            digestCheckCommand(
                expectedSHA256: validatedBundle.helperSHA256,
                path: helperDestination
            ),
            digestCheckCommand(
                expectedSHA256: validatedBundle.voWiFiRuntimeSHA256,
                path: voWiFiRuntimeDestination
            ),
            digestCheckCommand(
                expectedSHA256: validatedBundle.plistSHA256,
                path: plistDestination
            ),
            "/usr/bin/codesign --verify --strict --test-requirement " +
                "\(shellQuote(helperRequirement)) \(shellQuote(helperDestination))",
            "/usr/bin/codesign --verify --strict --test-requirement " +
                "\(shellQuote(runtimeRequirement)) \(shellQuote(voWiFiRuntimeDestination))",
            "/bin/launchctl bootstrap system \(shellQuote(plistDestination))",
            "/bin/launchctl kickstart -k \(shellQuote(serviceTarget))"
        ]
        let shellCommand = commands.joined(separator: "; ")
        let script = "do shell script \(appleScriptLiteral(shellCommand)) " +
            "with administrator privileges with prompt " +
            appleScriptLiteral(L10n.tr("VoDog 需要安装一次网络 helper。以后切换蜂窝网络将不再要求密码。"))

        let process = Process()
        let standardError = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        process.standardOutput = Pipe()
        process.standardError = standardError

        do {
            try process.run()
        } catch {
            return .failure(.launchFailed(error.localizedDescription))
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = standardError.fileHandleForReading.readDataToEndOfFile()
            let detail = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? L10n.tr("未知错误")
            if detail.localizedCaseInsensitiveContains("cancel") || detail.contains("-128") {
                return .failure(.cancelled)
            }
            return .failure(.installationFailed(detail.isEmpty ? L10n.tr("未知错误") : detail))
        }
        return .success(())
    }

    private var isRunningFromAllowedAppLocation: Bool {
        let expectedPath = "/Applications/VoDog.app"
        let standardizedPath = Bundle.main.bundleURL.standardizedFileURL.path
        return standardizedPath == expectedPath && canonical(standardizedPath) == expectedPath
    }

    private func validateBundledFiles(
        helperURL: URL,
        voWiFiRuntimeURL: URL,
        plistURL: URL
    ) -> ValidatedBundle? {
        guard let plistData = try? Data(contentsOf: plistURL),
              validateLaunchDaemonPlist(plistData),
              let helperData = try? Data(contentsOf: helperURL, options: .mappedIfSafe),
              let voWiFiRuntimeData = try? Data(contentsOf: voWiFiRuntimeURL, options: .mappedIfSafe) else {
            return nil
        }

        var staticCode: SecStaticCode?
        var runtimeStaticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(helperURL as CFURL, [], &staticCode) == errSecSuccess,
              let staticCode,
              SecStaticCodeCreateWithPath(voWiFiRuntimeURL as CFURL, [], &runtimeStaticCode) == errSecSuccess,
              let runtimeStaticCode,
              let helperRequirement = VoDogCodeSigningPolicy.identifierRequirement(
                  VoDogCodeSigningPolicy.helperIdentifier
              ),
              SecStaticCodeCheckValidity(staticCode, [], helperRequirement) == errSecSuccess,
              let runtimeRequirement = VoDogCodeSigningPolicy.identifierRequirement(
                  "org.vodog.macos.vowifi.runtime"
              ),
              SecStaticCodeCheckValidity(runtimeStaticCode, [], runtimeRequirement) == errSecSuccess,
              let appCode = VoDogCodeSigningPolicy.currentProcessCode(),
              let appRequirement = VoDogCodeSigningPolicy.identifierRequirement(
                  VoDogCodeSigningPolicy.appIdentifier
              ),
              SecCodeCheckValidity(appCode, [], appRequirement) == errSecSuccess,
              let helperCertificate = VoDogCodeSigningPolicy.leafCertificateData(
                  for: staticCode
              ),
              let runtimeCertificate = VoDogCodeSigningPolicy.leafCertificateData(
                  for: runtimeStaticCode
              ),
              let appCertificate = VoDogCodeSigningPolicy.leafCertificateData(for: appCode) else {
            return nil
        }
        guard helperCertificate == appCertificate,
              runtimeCertificate == appCertificate else { return nil }

        return ValidatedBundle(
            certificateSHA1: Insecure.SHA1.hash(data: appCertificate)
                .map { String(format: "%02X", $0) }
                .joined(),
            helperSHA256: SHA256.hash(data: helperData)
                .map { String(format: "%02x", $0) }
                .joined(),
            voWiFiRuntimeSHA256: SHA256.hash(data: voWiFiRuntimeData)
                .map { String(format: "%02x", $0) }
                .joined(),
            plistSHA256: SHA256.hash(data: plistData)
                .map { String(format: "%02x", $0) }
                .joined()
        )
    }

    private func validateLaunchDaemonPlist(_ data: Data) -> Bool {
        guard let object = try? PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil
        ),
        let plist = object as? [String: Any],
        Set(plist.keys) == Set([
            "Label",
            "MachServices",
            "ProcessType",
            "ProgramArguments",
            "ThrottleInterval"
        ]),
        plist["Label"] as? String == VoDogNetworkIPC.helperLabel,
        plist["ProcessType"] as? String == "Interactive",
        plist["ProgramArguments"] as? [String] == [
            "/Library/PrivilegedHelperTools/\(VoDogNetworkIPC.helperExecutableName)"
        ],
        plist["ThrottleInterval"] as? Int == 5,
        let machServices = plist["MachServices"] as? [String: Any],
        machServices.count == 1,
        machServices[VoDogNetworkIPC.helperLabel] as? Bool == true else {
            return false
        }
        return true
    }

    private func digestCheckCommand(expectedSHA256: String, path: String) -> String {
        let checkLine = "\(expectedSHA256)  \(path)"
        return "/bin/echo \(shellQuote(checkLine)) | " +
            "/usr/bin/shasum -a 256 -c - >/dev/null"
    }

    private func canonical(_ path: String) -> String {
        URL(fileURLWithPath: path)
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    private func appleScriptLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }
}
