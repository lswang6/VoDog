import Foundation

enum PhoneNumberNormalizer {
    static func normalized(_ value: String) -> String {
        var result = ""
        for character in value {
            if character == "+", result.isEmpty {
                result.append(character)
            } else if let digit = character.wholeNumberValue, (0 ... 9).contains(digit) {
                result.append(String(digit))
            }
        }
        if result.hasPrefix("+86"), result.dropFirst(3).count == 11 {
            result.removeFirst(3)
        } else if result.hasPrefix("0086"), result.dropFirst(4).count == 11 {
            result.removeFirst(4)
        } else if result.hasPrefix("86"), result.dropFirst(2).count == 11 {
            result.removeFirst(2)
        }
        return result
    }

    static func conversationID(for address: String) -> String {
        let normalized = normalized(address)
        if !normalized.isEmpty {
            return normalized
        }
        return address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
