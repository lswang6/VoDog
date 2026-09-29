import Foundation

enum SOCKSProtocolError: Error, Equatable {
    case incomplete
    case invalidVersion(UInt8)
    case invalidReservedByte(UInt8)
    case invalidAddressType(UInt8)
    case invalidUTF8
    case invalidLength
    case fragmentedUDPDatagram(UInt8)
}

enum SOCKSAuthenticationMethod: UInt8, Equatable, Sendable {
    case none = 0x00
    case usernamePassword = 0x02
    case noAcceptableMethods = 0xFF
}

enum SOCKSCommand: UInt8, Equatable, Sendable {
    case connect = 0x01
    case bind = 0x02
    case udpAssociate = 0x03
}

enum SOCKSReply: UInt8, Equatable, Sendable {
    case succeeded = 0x00
    case generalFailure = 0x01
    case connectionNotAllowed = 0x02
    case networkUnreachable = 0x03
    case hostUnreachable = 0x04
    case connectionRefused = 0x05
    case ttlExpired = 0x06
    case commandNotSupported = 0x07
    case addressTypeNotSupported = 0x08
}

enum SOCKSAddress: Hashable, Sendable {
    case ipv4([UInt8])
    case domain(String)
    case ipv6([UInt8])
}

struct SOCKSMethodSelection: Equatable, Sendable {
    let methods: [UInt8]
    let consumedByteCount: Int
}

struct SOCKSUsernamePasswordCredentials: Equatable, Sendable {
    let username: String
    let password: String
    let consumedByteCount: Int
}

struct SOCKSRequest: Equatable, Sendable {
    let command: UInt8
    let address: SOCKSAddress
    let port: UInt16
    let consumedByteCount: Int
}

struct SOCKSUDPDatagram: Equatable, Sendable {
    let address: SOCKSAddress
    let port: UInt16
    let payload: Data
}

/// RFC 1928 and RFC 1929 wire-format codec. The decoders accept a prefix of a
/// stream and return the number of consumed bytes so callers can retain any
/// bytes belonging to the next protocol phase.
enum SOCKSProtocol {
    static func decodeMethodSelection(_ data: Data) throws -> SOCKSMethodSelection {
        // Offsets are resolved against startIndex because a caller's buffer is
        // a Data slice after the previous phase was consumed: Data.removeFirst
        // advances startIndex instead of reindexing, so absolute subscripts
        // would read past the end and trap.
        let base = data.startIndex
        guard data.count >= 2 else { throw SOCKSProtocolError.incomplete }
        guard data[base] == 0x05 else {
            throw SOCKSProtocolError.invalidVersion(data[base])
        }

        let methodCount = Int(data[base + 1])
        guard methodCount > 0 else { throw SOCKSProtocolError.invalidLength }
        let end = 2 + methodCount
        guard data.count >= end else { throw SOCKSProtocolError.incomplete }
        return SOCKSMethodSelection(
            methods: Array(data[(base + 2)..<(base + end)]),
            consumedByteCount: end
        )
    }

    static func encodeMethodSelectionResponse(_ method: SOCKSAuthenticationMethod) -> Data {
        Data([0x05, method.rawValue])
    }

    static func decodeUsernamePassword(
        _ data: Data
    ) throws -> SOCKSUsernamePasswordCredentials {
        let base = data.startIndex
        guard data.count >= 2 else { throw SOCKSProtocolError.incomplete }
        guard data[base] == 0x01 else {
            throw SOCKSProtocolError.invalidVersion(data[base])
        }

        let usernameLength = Int(data[base + 1])
        guard usernameLength > 0 else { throw SOCKSProtocolError.invalidLength }
        let passwordLengthOffset = 2 + usernameLength
        guard data.count > passwordLengthOffset else { throw SOCKSProtocolError.incomplete }

        let passwordLength = Int(data[base + passwordLengthOffset])
        guard passwordLength > 0 else { throw SOCKSProtocolError.invalidLength }
        let end = passwordLengthOffset + 1 + passwordLength
        guard data.count >= end else { throw SOCKSProtocolError.incomplete }

        guard
            let username = String(
                data: data[(base + 2)..<(base + passwordLengthOffset)],
                encoding: .utf8
            ),
            let password = String(
                data: data[(base + passwordLengthOffset + 1)..<(base + end)],
                encoding: .utf8
            )
        else {
            throw SOCKSProtocolError.invalidUTF8
        }
        return SOCKSUsernamePasswordCredentials(
            username: username,
            password: password,
            consumedByteCount: end
        )
    }

    static func encodeUsernamePasswordResponse(succeeded: Bool) -> Data {
        Data([0x01, succeeded ? 0x00 : 0x01])
    }

    static func decodeRequest(_ data: Data) throws -> SOCKSRequest {
        let base = data.startIndex
        guard data.count >= 4 else { throw SOCKSProtocolError.incomplete }
        guard data[base] == 0x05 else {
            throw SOCKSProtocolError.invalidVersion(data[base])
        }
        guard data[base + 2] == 0x00 else {
            throw SOCKSProtocolError.invalidReservedByte(data[base + 2])
        }

        let address: SOCKSAddress
        let portOffset: Int
        switch data[base + 3] {
        case 0x01:
            portOffset = 8
            guard data.count >= portOffset else { throw SOCKSProtocolError.incomplete }
            address = .ipv4(Array(data[(base + 4)..<(base + 8)]))
        case 0x03:
            guard data.count >= 5 else { throw SOCKSProtocolError.incomplete }
            let length = Int(data[base + 4])
            guard length > 0 else { throw SOCKSProtocolError.invalidLength }
            portOffset = 5 + length
            guard data.count >= portOffset else { throw SOCKSProtocolError.incomplete }
            guard let domain = String(
                data: data[(base + 5)..<(base + portOffset)],
                encoding: .utf8
            ) else {
                throw SOCKSProtocolError.invalidUTF8
            }
            address = .domain(domain)
        case 0x04:
            portOffset = 20
            guard data.count >= portOffset else { throw SOCKSProtocolError.incomplete }
            address = .ipv6(Array(data[(base + 4)..<(base + 20)]))
        default:
            throw SOCKSProtocolError.invalidAddressType(data[base + 3])
        }

        guard data.count >= portOffset + 2 else { throw SOCKSProtocolError.incomplete }
        let port = UInt16(data[base + portOffset]) << 8 | UInt16(data[base + portOffset + 1])
        return SOCKSRequest(
            command: data[base + 1],
            address: address,
            port: port,
            consumedByteCount: portOffset + 2
        )
    }

    static func encodeReply(
        _ reply: SOCKSReply,
        boundAddress: SOCKSAddress = .ipv4([0, 0, 0, 0]),
        boundPort: UInt16 = 0
    ) throws -> Data {
        var bytes: [UInt8] = [0x05, reply.rawValue, 0x00]
        switch boundAddress {
        case let .ipv4(address):
            guard address.count == 4 else { throw SOCKSProtocolError.invalidLength }
            bytes.append(0x01)
            bytes.append(contentsOf: address)
        case let .domain(domain):
            let encoded = Array(domain.utf8)
            guard !encoded.isEmpty, encoded.count <= 255 else {
                throw SOCKSProtocolError.invalidLength
            }
            bytes.append(0x03)
            bytes.append(UInt8(encoded.count))
            bytes.append(contentsOf: encoded)
        case let .ipv6(address):
            guard address.count == 16 else { throw SOCKSProtocolError.invalidLength }
            bytes.append(0x04)
            bytes.append(contentsOf: address)
        }
        bytes.append(UInt8(boundPort >> 8))
        bytes.append(UInt8(boundPort & 0xFF))
        return Data(bytes)
    }

    static func decodeUDPDatagram(_ data: Data) throws -> SOCKSUDPDatagram {
        let base = data.startIndex
        guard data.count >= 4 else { throw SOCKSProtocolError.incomplete }
        guard data[base] == 0, data[base + 1] == 0 else {
            throw SOCKSProtocolError.invalidReservedByte(data[base])
        }
        let fragment = data[base + 2]
        guard fragment == 0 else {
            throw SOCKSProtocolError.fragmentedUDPDatagram(fragment)
        }
        let decoded = try decodeAddressPort(data, addressTypeOffset: 3)
        return SOCKSUDPDatagram(
            address: decoded.address,
            port: decoded.port,
            payload: Data(data[(base + decoded.consumedByteCount)...])
        )
    }

    static func encodeUDPDatagram(_ datagram: SOCKSUDPDatagram) throws -> Data {
        var bytes: [UInt8] = [0, 0, 0]
        try appendAddress(datagram.address, port: datagram.port, to: &bytes)
        var result = Data(bytes)
        result.append(datagram.payload)
        return result
    }

    private static func decodeAddressPort(
        _ data: Data,
        addressTypeOffset: Int
    ) throws -> (address: SOCKSAddress, port: UInt16, consumedByteCount: Int) {
        let base = data.startIndex
        guard data.count > addressTypeOffset else { throw SOCKSProtocolError.incomplete }
        let address: SOCKSAddress
        let portOffset: Int
        switch data[base + addressTypeOffset] {
        case 0x01:
            portOffset = addressTypeOffset + 5
            guard data.count >= portOffset else { throw SOCKSProtocolError.incomplete }
            address = .ipv4(Array(data[(base + addressTypeOffset + 1)..<(base + portOffset)]))
        case 0x03:
            guard data.count > addressTypeOffset + 1 else { throw SOCKSProtocolError.incomplete }
            let length = Int(data[base + addressTypeOffset + 1])
            guard length > 0 else { throw SOCKSProtocolError.invalidLength }
            portOffset = addressTypeOffset + 2 + length
            guard data.count >= portOffset else { throw SOCKSProtocolError.incomplete }
            guard let domain = String(
                data: data[(base + addressTypeOffset + 2)..<(base + portOffset)],
                encoding: .utf8
            ) else {
                throw SOCKSProtocolError.invalidUTF8
            }
            address = .domain(domain)
        case 0x04:
            portOffset = addressTypeOffset + 17
            guard data.count >= portOffset else { throw SOCKSProtocolError.incomplete }
            address = .ipv6(Array(data[(base + addressTypeOffset + 1)..<(base + portOffset)]))
        default:
            throw SOCKSProtocolError.invalidAddressType(data[base + addressTypeOffset])
        }
        guard data.count >= portOffset + 2 else { throw SOCKSProtocolError.incomplete }
        let port = UInt16(data[base + portOffset]) << 8 | UInt16(data[base + portOffset + 1])
        return (address, port, portOffset + 2)
    }

    private static func appendAddress(
        _ address: SOCKSAddress,
        port: UInt16,
        to bytes: inout [UInt8]
    ) throws {
        switch address {
        case let .ipv4(value):
            guard value.count == 4 else { throw SOCKSProtocolError.invalidLength }
            bytes.append(0x01)
            bytes.append(contentsOf: value)
        case let .domain(value):
            let encoded = Array(value.utf8)
            guard !encoded.isEmpty, encoded.count <= 255 else {
                throw SOCKSProtocolError.invalidLength
            }
            bytes.append(0x03)
            bytes.append(UInt8(encoded.count))
            bytes.append(contentsOf: encoded)
        case let .ipv6(value):
            guard value.count == 16 else { throw SOCKSProtocolError.invalidLength }
            bytes.append(0x04)
            bytes.append(contentsOf: value)
        }
        bytes.append(UInt8(port >> 8))
        bytes.append(UInt8(port & 0xFF))
    }
}
