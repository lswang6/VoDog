import Foundation

enum AppIdentityMigration {
    private static let legacyBundleIdentifier = "org.vodog.macos.legacy"
    private static let migrationMarker = "VoDogIdentityMigration.v1"
    private static let namingMigrationMarker = "VoDogNamingMigration.v1"

    static func migratePreferencesIfNeeded(
        defaults: UserDefaults = .standard
    ) {
        if !defaults.bool(forKey: migrationMarker) {
            if let legacy = defaults.persistentDomain(forName: legacyBundleIdentifier) {
                for (key, value) in legacy where defaults.object(forKey: key) == nil {
                    defaults.set(value, forKey: key)
                }
            }
            defaults.set(true, forKey: migrationMarker)
        }

        if !defaults.bool(forKey: namingMigrationMarker) {
            for (key, value) in defaults.dictionaryRepresentation() where key.contains("VoDogLegacy") {
                let migratedKey = key.replacingOccurrences(of: "VoDogLegacy", with: "VoDog")
                if defaults.object(forKey: migratedKey) == nil {
                    defaults.set(value, forKey: migratedKey)
                }
            }
            defaults.set(true, forKey: namingMigrationMarker)
        }
    }
}

enum AppDataDirectory {
    static func userApplicationSupport(
        fileManager: FileManager = .default
    ) -> URL {
        let root = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        let current = root.appendingPathComponent("VoDog", isDirectory: true)
        let legacy = root.appendingPathComponent("VoDogLegacy", isDirectory: true)

        if !fileManager.fileExists(atPath: current.path),
           fileManager.fileExists(atPath: legacy.path) {
            try? fileManager.moveItem(at: legacy, to: current)
        }
        if fileManager.fileExists(atPath: current.path) {
            return current
        }

        try? fileManager.createDirectory(
            at: current,
            withIntermediateDirectories: true
        )
        return fileManager.fileExists(atPath: current.path) ? current : legacy
    }
}
