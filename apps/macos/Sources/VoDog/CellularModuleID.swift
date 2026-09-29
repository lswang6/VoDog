import Foundation

struct CellularModuleID: RawRepresentable, Hashable, Codable, Identifiable {
    let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    var id: String { rawValue }

    static let compatibilityPrimary = CellularModuleID(rawValue: "primary")
}
