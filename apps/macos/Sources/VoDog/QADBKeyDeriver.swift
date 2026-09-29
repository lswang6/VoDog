import CryptoKit
import Foundation

enum QADBKeyDeriver {
    private static let password = Array("SH_adb_quectel".utf8)
    private static let magic = Array("$1$".utf8)
    private static let cryptAlphabet = Array("./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)

    static func response(for challenge: String) -> String? {
        let challengeBytes = Array(challenge.utf8)
        guard challengeBytes.count == 8,
              challengeBytes.allSatisfy({ (UInt8(ascii: "0") ... UInt8(ascii: "9")).contains($0) }) else {
            return nil
        }

        let hash = md5Crypt(password: password, salt: challengeBytes)
        guard hash.count >= 15 else { return nil }
        return String(decoding: hash.prefix(15), as: UTF8.self)
    }

    private static func md5Crypt(password: [UInt8], salt: [UInt8]) -> [UInt8] {
        var initial = password + magic + salt
        let alternate = md5(password + salt + password)

        var remaining = password.count
        while remaining > 0 {
            let count = min(remaining, alternate.count)
            initial += alternate.prefix(count)
            remaining -= count
        }

        var bitLength = password.count
        while bitLength > 0 {
            initial.append(bitLength & 1 == 1 ? 0 : password[0])
            bitLength >>= 1
        }

        var digest = md5(initial)
        for round in 0 ..< 1_000 {
            var input: [UInt8] = []
            input += round & 1 == 1 ? password : digest
            if round % 3 != 0 { input += salt }
            if round % 7 != 0 { input += password }
            input += round & 1 == 1 ? digest : password
            digest = md5(input)
        }

        var encoded: [UInt8] = []
        appendCryptBase64(digest[0], digest[6], digest[12], count: 4, to: &encoded)
        appendCryptBase64(digest[1], digest[7], digest[13], count: 4, to: &encoded)
        appendCryptBase64(digest[2], digest[8], digest[14], count: 4, to: &encoded)
        appendCryptBase64(digest[3], digest[9], digest[15], count: 4, to: &encoded)
        appendCryptBase64(digest[4], digest[10], digest[5], count: 4, to: &encoded)
        appendCryptBase64(0, 0, digest[11], count: 2, to: &encoded)
        return encoded
    }

    private static func md5(_ input: [UInt8]) -> [UInt8] {
        Array(Insecure.MD5.hash(data: Data(input)))
    }

    private static func appendCryptBase64(
        _ high: UInt8,
        _ middle: UInt8,
        _ low: UInt8,
        count: Int,
        to output: inout [UInt8]
    ) {
        var value = (UInt32(high) << 16) | (UInt32(middle) << 8) | UInt32(low)
        for _ in 0 ..< count {
            output.append(cryptAlphabet[Int(value & 0x3F)])
            value >>= 6
        }
    }
}
