import Foundation
import Security

public enum VoDogCodeSigningPolicy {
    public static let appIdentifier = "org.vodog.macos"
    public static let helperIdentifier = "org.vodog.macos.network.helper"

    public static func identifierRequirement(_ identifier: String) -> SecRequirement? {
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(
            "identifier \"\(identifier)\"" as CFString,
            [],
            &requirement
        ) == errSecSuccess else {
            return nil
        }
        return requirement
    }

    public static func currentProcessCode() -> SecCode? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess else { return nil }
        return code
    }

    public static func staticCode(for code: SecCode) -> SecStaticCode? {
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess else {
            return nil
        }
        return staticCode
    }

    public static func leafCertificateData(for code: SecCode) -> Data? {
        guard let staticCode = staticCode(for: code) else { return nil }
        return leafCertificateData(for: staticCode)
    }

    public static func leafCertificateData(for code: SecStaticCode) -> Data? {
        var signingInformation: CFDictionary?
        guard SecCodeCopySigningInformation(
            code,
            SecCSFlags(rawValue: kSecCSSigningInformation),
            &signingInformation
        ) == errSecSuccess,
        let information = signingInformation as? [String: Any],
        let certificates = information[kSecCodeInfoCertificates as String] as? [SecCertificate],
        let leafCertificate = certificates.first else {
            return nil
        }
        return SecCertificateCopyData(leafCertificate) as Data
    }
}
