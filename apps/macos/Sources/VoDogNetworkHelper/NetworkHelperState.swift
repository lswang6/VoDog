import Darwin
import Foundation
import OSLog

private let helperStateLogger = Logger(
    subsystem: "org.vodog.macos.network.helper",
    category: "HelperState"
)

/// Guards the on-disk restore data against being read by a build that does not
/// understand it.
///
/// Adding an optional field needs no bump; `Codable` already tolerates that.
/// The version exists for the reverse direction: after a downgrade, an older
/// helper would otherwise interpret a newer file with the wrong semantics and
/// could restore the user's network service order incorrectly. Discarding the
/// restore data is always the safer failure.
enum NetworkHelperStateCompatibility {
    /// Bump only when an existing field changes meaning.
    static let currentVersion = 1

    static func canInterpret(version: Int?) -> Bool {
        (version ?? 0) <= currentVersion
    }
}

struct NetworkOrderSnapshot: Codable, Equatable {
    let setID: String
    let targetServiceID: String
    let original: [String]
    let promoted: [String]
}

struct NetworkServiceRecord: Codable, Equatable {
    let setID: String
    let serviceID: String
    let bsdName: String
}

struct NetworkConfigurationSnapshot: Codable, Equatable {
    let setID: String
    let original: [String]
    let applied: [String]
}

struct NetworkHelperState: Codable, Equatable {
    /// Absent in files written before versioning was introduced, which are read
    /// as version 0 and remain fully interpretable.
    var version: Int?
    var orderSnapshot: NetworkOrderSnapshot?
    var serviceRecord: NetworkServiceRecord?
    var configurationSnapshot: NetworkConfigurationSnapshot?
    /// Keyed by the USB location ID rendered as a string, because `Codable`
    /// encodes dictionaries with non-string keys as a flat array, which is far
    /// harder to inspect when diagnosing a machine from its state file.
    var serviceRecordsByLocation: [String: NetworkServiceRecord]?

    static let empty = NetworkHelperState(
        version: nil,
        orderSnapshot: nil,
        serviceRecord: nil,
        configurationSnapshot: nil,
        serviceRecordsByLocation: nil
    )
}

final class NetworkHelperStateStore {
    private let directoryURL = URL(
        fileURLWithPath: "/Library/Application Support/VoDog",
        isDirectory: true
    )
    private let legacyDirectoryURL = URL(
        fileURLWithPath: "/Library/Application Support/VoDogLegacy",
        isDirectory: true
    )
    private lazy var fileURL = directoryURL.appendingPathComponent("network-helper-state.json")
    private lazy var legacyFileURL =
        legacyDirectoryURL.appendingPathComponent("network-helper-state.json")

    func load() -> NetworkHelperState {
        let sourceURL = FileManager.default.fileExists(atPath: fileURL.path)
            ? fileURL
            : legacyFileURL
        guard let data = try? Data(contentsOf: sourceURL),
              let state = try? JSONDecoder().decode(NetworkHelperState.self, from: data) else {
            return .empty
        }
        guard NetworkHelperStateCompatibility.canInterpret(version: state.version) else {
            helperStateLogger.error(
                """
                Ignoring network helper state written by a newer build \
                version=\(state.version ?? 0) supported=\
                \(NetworkHelperStateCompatibility.currentVersion)
                """
            )
            return .empty
        }
        return state
    }

    func save(_ state: NetworkHelperState) throws {
        var state = state
        state.version = NetworkHelperStateCompatibility.currentVersion
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
        let data = try JSONEncoder().encode(state)
        try data.write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes(
            [
                .ownerAccountID: NSNumber(value: 0),
                .groupOwnerAccountID: NSNumber(value: 0),
                .posixPermissions: NSNumber(value: 0o600)
            ],
            ofItemAtPath: fileURL.path
        )
    }
}
