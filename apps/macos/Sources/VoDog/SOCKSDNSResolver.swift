import Darwin
import Foundation

enum SOCKSDNSRecordType: UInt16, Sendable {
    case a = 1
    case aaaa = 28
}

enum SOCKSDNSError: Error, Equatable {
    case invalidName
    case truncated
    case invalidResponse
    case nameError
    case noAddresses
    case noNameServer
    case timedOut
}

struct SOCKSDecodedDNSResponse: Equatable {
    let addresses: [SOCKSAddress]
    let minimumTTL: UInt32
}

enum SOCKSDNSCodec {
    static func encodeQuery(name: String, type: SOCKSDNSRecordType, id: UInt16) throws -> Data {
        var bytes: [UInt8] = [
            UInt8(id >> 8), UInt8(id & 0xff), 0x01, 0x00,
            0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        guard !labels.isEmpty else { throw SOCKSDNSError.invalidName }
        for label in labels {
            let encoded = Array(label.utf8)
            guard !encoded.isEmpty, encoded.count <= 63 else { throw SOCKSDNSError.invalidName }
            bytes.append(UInt8(encoded.count))
            bytes.append(contentsOf: encoded)
        }
        guard bytes.count <= 266 else { throw SOCKSDNSError.invalidName }
        bytes.append(0)
        bytes.append(UInt8(type.rawValue >> 8))
        bytes.append(UInt8(type.rawValue & 0xff))
        bytes.append(contentsOf: [0x00, 0x01])
        return Data(bytes)
    }

    static func decodeResponse(
        _ data: Data,
        expectedID: UInt16,
        type: SOCKSDNSRecordType
    ) throws -> [SOCKSAddress] {
        try decodeResponseWithTTL(data, expectedID: expectedID, type: type).addresses
    }

    static func decodeResponseWithTTL(
        _ data: Data,
        expectedID: UInt16,
        type: SOCKSDNSRecordType
    ) throws -> SOCKSDecodedDNSResponse {
        let bytes = Array(data)
        guard bytes.count >= 12 else { throw SOCKSDNSError.truncated }
        guard read16(bytes, 0) == expectedID, bytes[2] & 0x80 != 0 else {
            throw SOCKSDNSError.invalidResponse
        }
        let responseCode = bytes[3] & 0x0f
        if responseCode == 3 { throw SOCKSDNSError.nameError }
        guard responseCode == 0 else { throw SOCKSDNSError.invalidResponse }
        let questionCount = Int(read16(bytes, 4))
        let answerCount = Int(read16(bytes, 6))
        var offset = 12
        for _ in 0..<questionCount {
            try skipName(bytes, offset: &offset)
            guard offset + 4 <= bytes.count else { throw SOCKSDNSError.truncated }
            offset += 4
        }
        var result: [SOCKSAddress] = []
        var minimumTTL = UInt32.max
        for _ in 0..<answerCount {
            try skipName(bytes, offset: &offset)
            guard offset + 10 <= bytes.count else { throw SOCKSDNSError.truncated }
            let recordType = read16(bytes, offset)
            let recordClass = read16(bytes, offset + 2)
            let ttl = read32(bytes, offset + 4)
            let length = Int(read16(bytes, offset + 8))
            offset += 10
            guard offset + length <= bytes.count else { throw SOCKSDNSError.truncated }
            if recordClass == 1, recordType == type.rawValue {
                if type == .a, length == 4 {
                    result.append(.ipv4(Array(bytes[offset..<(offset + 4)])))
                    minimumTTL = min(minimumTTL, ttl)
                } else if type == .aaaa, length == 16 {
                    result.append(.ipv6(Array(bytes[offset..<(offset + 16)])))
                    minimumTTL = min(minimumTTL, ttl)
                }
            }
            offset += length
        }
        guard !result.isEmpty else { throw SOCKSDNSError.noAddresses }
        return SOCKSDecodedDNSResponse(
            addresses: result,
            minimumTTL: minimumTTL == .max ? 0 : minimumTTL
        )
    }

    private static func skipName(_ bytes: [UInt8], offset: inout Int) throws {
        var cursor = offset
        var consumed = 0
        var jumps = 0
        while true {
            guard cursor < bytes.count else { throw SOCKSDNSError.truncated }
            let length = Int(bytes[cursor])
            if length & 0xc0 == 0xc0 {
                guard cursor + 1 < bytes.count else { throw SOCKSDNSError.truncated }
                let pointer = ((length & 0x3f) << 8) | Int(bytes[cursor + 1])
                guard pointer < bytes.count, jumps < 32 else { throw SOCKSDNSError.invalidResponse }
                if consumed == 0 { offset = cursor + 2 }
                consumed += 2
                cursor = pointer
                jumps += 1
            } else if length == 0 {
                if consumed == 0 { offset = cursor + 1 }
                return
            } else {
                guard length <= 63, cursor + 1 + length <= bytes.count else {
                    throw SOCKSDNSError.truncated
                }
                cursor += 1 + length
                if consumed == 0 { offset = cursor }
            }
        }
    }

    private static func read16(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
        UInt16(bytes[offset]) << 8 | UInt16(bytes[offset + 1])
    }

    private static func read32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        UInt32(bytes[offset]) << 24 |
            UInt32(bytes[offset + 1]) << 16 |
            UInt32(bytes[offset + 2]) << 8 |
            UInt32(bytes[offset + 3])
    }
}

final class SOCKSDNSCache: @unchecked Sendable {
    struct Key: Hashable {
        let domain: String
        let type: SOCKSDNSRecordType
        let bsdName: String
    }

    private struct Entry {
        let addresses: [SOCKSAddress]
        let expiresAt: Date
    }

    static let shared = SOCKSDNSCache()
    private let lock = NSLock()
    private var entries: [Key: Entry] = [:]
    private let maximumEntries = 512

    func addresses(
        domain: String,
        type: SOCKSDNSRecordType,
        bsdName: String,
        now: Date = Date()
    ) -> [SOCKSAddress]? {
        let key = makeKey(domain: domain, type: type, bsdName: bsdName)
        lock.lock()
        defer { lock.unlock() }
        guard let entry = entries[key] else { return nil }
        guard entry.expiresAt > now else {
            entries[key] = nil
            return nil
        }
        return entry.addresses
    }

    func insert(
        _ addresses: [SOCKSAddress],
        domain: String,
        type: SOCKSDNSRecordType,
        bsdName: String,
        ttl: UInt32,
        now: Date = Date()
    ) {
        guard !addresses.isEmpty else { return }
        // Avoid caching a zero-TTL response, and cap stale cellular/CDN answers.
        let lifetime = min(TimeInterval(ttl), 300)
        guard lifetime > 0 else { return }
        let key = makeKey(domain: domain, type: type, bsdName: bsdName)
        lock.lock()
        if entries.count >= maximumEntries {
            entries = entries.filter { $0.value.expiresAt > now }
            if entries.count >= maximumEntries, let oldest = entries.min(by: {
                $0.value.expiresAt < $1.value.expiresAt
            })?.key {
                entries[oldest] = nil
            }
        }
        entries[key] = Entry(
            addresses: addresses,
            expiresAt: now.addingTimeInterval(lifetime)
        )
        lock.unlock()
    }

    private func makeKey(
        domain: String,
        type: SOCKSDNSRecordType,
        bsdName: String
    ) -> Key {
        Key(
            domain: domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")),
            type: type,
            bsdName: bsdName
        )
    }
}

private final class SOCKSAddressPair: @unchecked Sendable {
    private let lock = NSLock()
    private var ipv4: [SOCKSAddress] = []
    private var ipv6: [SOCKSAddress] = []

    func set(_ addresses: [SOCKSAddress], for type: SOCKSDNSRecordType) {
        lock.lock()
        if type == .a { ipv4 = addresses } else { ipv6 = addresses }
        lock.unlock()
    }

    func combined() -> [SOCKSAddress] {
        lock.lock()
        defer { lock.unlock() }
        return ipv4 + ipv6
    }
}

final class SOCKSDNSResolver {
    /// Some QDC507 firmware revisions advertise the ECM gateway as a DNS
    /// server even when its port 53 service is not running. Keep DHCP servers
    /// first, then fall back to public resolvers. Every query still goes through
    /// `BoundSocket`, so fallback DNS cannot escape through Wi-Fi or another
    /// modem.
    static let fallbackServers = ["8.8.8.8", "8.8.4.4"]

    static func serverCandidates(advertised: [String]) -> [String] {
        var seen: Set<String> = []
        return (advertised + fallbackServers).filter { seen.insert($0).inserted }
    }

    private let timeoutSeconds: Int
    private let attempts: Int

    init(timeoutSeconds: Int = 3, attempts: Int = 2) {
        self.timeoutSeconds = timeoutSeconds
        self.attempts = attempts
    }

    /// A and AAAA are independent wire exchanges. Running them together removes
    /// one full DNS round trip from every uncached domain while keeping IPv4
    /// first in the returned connection order.
    func resolveAddresses(
        domain: String,
        dnsServers: [String],
        bsdName: String
    ) -> [SOCKSAddress] {
        let pair = SOCKSAddressPair()
        DispatchQueue.concurrentPerform(iterations: 2) { index in
            let type: SOCKSDNSRecordType = index == 0 ? .a : .aaaa
            let addresses = (try? self.resolve(
                domain: domain,
                type: type,
                dnsServers: dnsServers,
                bsdName: bsdName
            )) ?? []
            pair.set(addresses, for: type)
        }
        return pair.combined()
    }

    func resolve(
        domain: String,
        type: SOCKSDNSRecordType,
        dnsServers: [String],
        bsdName: String
    ) throws -> [SOCKSAddress] {
        if let cached = SOCKSDNSCache.shared.addresses(
            domain: domain, type: type, bsdName: bsdName
        ) {
            return cached
        }
        let servers = Self.serverCandidates(advertised: dnsServers)
        guard !servers.isEmpty else { throw SOCKSDNSError.noNameServer }
        var lastError: Error = SOCKSDNSError.timedOut
        for attempt in 0..<attempts {
            let identifier = UInt16.random(in: .min ... .max)
            let query = try SOCKSDNSCodec.encodeQuery(name: domain, type: type, id: identifier)
            for server in servers {
                do {
                    let (family, address) = try numericAddress(server)
                    let socket = try BoundSocket(family: family, kind: .udp, bsdName: bsdName)
                    try socket.setTimeout(seconds: timeoutSeconds)
                    try socket.connect(to: address, port: 53)
                    try socket.sendAll(query)
                    let response = try socket.receive(maximumBytes: 4096)
                    let decoded = try SOCKSDNSCodec.decodeResponseWithTTL(
                        response,
                        expectedID: identifier,
                        type: type
                    )
                    SOCKSDNSCache.shared.insert(
                        decoded.addresses,
                        domain: domain,
                        type: type,
                        bsdName: bsdName,
                        ttl: decoded.minimumTTL
                    )
                    return decoded.addresses
                } catch {
                    lastError = error
                }
            }
            if attempt + 1 < attempts { continue }
        }
        throw lastError
    }

    private func numericAddress(_ value: String) throws -> (BoundSocketFamily, SOCKSAddress) {
        var ipv4 = in_addr()
        if value.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
            return (.ipv4, .ipv4(withUnsafeBytes(of: ipv4) { Array($0) }))
        }
        var ipv6 = in6_addr()
        if value.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
            return (.ipv6, .ipv6(withUnsafeBytes(of: ipv6) { Array($0) }))
        }
        throw SOCKSDNSError.invalidResponse
    }
}
