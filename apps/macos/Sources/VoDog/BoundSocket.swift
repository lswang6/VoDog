import Darwin
import Foundation

enum SOCKSSignalSafety {
    /// Network peers are allowed to disappear between readiness notification
    /// and a write. Convert that race into EPIPE instead of letting the default
    /// SIGPIPE disposition terminate the entire app. Per-socket SO_NOSIGPIPE is
    /// still set below as defense in depth for every BSD upstream descriptor.
    static func install() {
        _ = installation
    }

    private static let installation: Void = {
        Darwin.signal(SIGPIPE, SIG_IGN)
    }()
}

enum BoundSocketError: LocalizedError, Equatable {
    case interfaceNotFound(String)
    case addressFamilyMismatch
    case domainRequiresResolution
    case invalidAddressLength
    case systemCall(operation: String, code: Int32)

    var errorDescription: String? {
        switch self {
        case let .interfaceNotFound(name):
            return L10n.tr("找不到网络接口 %@。", name)
        case .addressFamilyMismatch:
            return L10n.tr("代理返回的地址类型与套接字不匹配。")
        case .domainRequiresResolution:
            return L10n.tr("代理主机名尚未解析为网络地址。")
        case .invalidAddressLength:
            return L10n.tr("代理返回的网络地址长度无效。")
        case let .systemCall(operation, code):
            let reason = String(cString: strerror(code))
            return L10n.tr("%@ 失败：%@（错误 %lld）。", operation, reason, Int64(code))
        }
    }
}

enum BoundSocketFamily: Equatable, Sendable {
    case ipv4
    case ipv6

    fileprivate var domain: Int32 {
        switch self {
        case .ipv4: return AF_INET
        case .ipv6: return AF_INET6
        }
    }

    fileprivate var boundInterfaceOption: (level: Int32, name: Int32) {
        switch self {
        case .ipv4: return (IPPROTO_IP, IP_BOUND_IF)
        case .ipv6: return (IPPROTO_IPV6, IPV6_BOUND_IF)
        }
    }
}

enum BoundSocketReadResult: Equatable {
    case data(Data)
    /// Nothing available right now; wait for readability and retry.
    case wouldBlock
    /// The peer closed its side.
    case endOfStream
}

enum BoundSocketKind: Equatable, Sendable {
    case tcp
    case udp

    fileprivate var socketType: Int32 {
        switch self {
        case .tcp: return SOCK_STREAM
        case .udp: return SOCK_DGRAM
        }
    }

    fileprivate var socketProtocol: Int32 {
        switch self {
        case .tcp: return IPPROTO_TCP
        case .udp: return IPPROTO_UDP
        }
    }
}

/// The only supported constructor for SOCKS upstream sockets. Interface
/// binding happens before the descriptor is returned; any failure closes it
/// rather than allowing traffic to fall back to the default route.
final class BoundSocket {
    let family: BoundSocketFamily
    let kind: BoundSocketKind
    let bsdName: String
    let interfaceIndex: UInt32

    private(set) var fileDescriptor: Int32

    init(family: BoundSocketFamily, kind: BoundSocketKind, bsdName: String) throws {
        errno = 0
        let resolvedIndex = if_nametoindex(bsdName)
        guard resolvedIndex != 0 else {
            throw BoundSocketError.interfaceNotFound(bsdName)
        }

        let descriptor = Darwin.socket(family.domain, kind.socketType, kind.socketProtocol)
        guard descriptor >= 0 else {
            throw BoundSocketError.systemCall(operation: "socket", code: errno)
        }

        do {
            var index = resolvedIndex
            let option = family.boundInterfaceOption
            guard setsockopt(
                descriptor,
                option.level,
                option.name,
                &index,
                socklen_t(MemoryLayout<UInt32>.size)
            ) == 0 else {
                throw BoundSocketError.systemCall(
                    operation: family == .ipv4 ? "IP_BOUND_IF" : "IPV6_BOUND_IF",
                    code: errno
                )
            }

            if kind == .tcp {
                var enabled: Int32 = 1
                guard setsockopt(
                    descriptor,
                    SOL_SOCKET,
                    SO_NOSIGPIPE,
                    &enabled,
                    socklen_t(MemoryLayout<Int32>.size)
                ) == 0 else {
                    throw BoundSocketError.systemCall(operation: "SO_NOSIGPIPE", code: errno)
                }
            }
        } catch {
            Darwin.close(descriptor)
            throw error
        }

        self.family = family
        self.kind = kind
        self.bsdName = bsdName
        interfaceIndex = resolvedIndex
        fileDescriptor = descriptor
    }

    deinit {
        close()
    }

    func close() {
        guard fileDescriptor >= 0 else { return }
        Darwin.close(fileDescriptor)
        fileDescriptor = -1
    }

    /// Connects TCP or UDP to a numeric address. Domain names are deliberately
    /// rejected so callers cannot accidentally use the system resolver.
    func connect(to address: SOCKSAddress, port: UInt16) throws {
        guard fileDescriptor >= 0 else {
            throw BoundSocketError.systemCall(operation: "connect", code: EBADF)
        }
        switch address {
        case let .ipv4(bytes):
            guard family == .ipv4 else { throw BoundSocketError.addressFamilyMismatch }
            guard bytes.count == 4 else { throw BoundSocketError.invalidAddressLength }
            var socketAddress = sockaddr_in()
            socketAddress.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            socketAddress.sin_family = sa_family_t(AF_INET)
            socketAddress.sin_port = port.bigEndian
            withUnsafeMutableBytes(of: &socketAddress.sin_addr) { destination in
                destination.copyBytes(from: bytes)
            }
            try connectPointer(
                to: &socketAddress,
                length: socklen_t(MemoryLayout<sockaddr_in>.size)
            )
        case let .ipv6(bytes):
            guard family == .ipv6 else { throw BoundSocketError.addressFamilyMismatch }
            guard bytes.count == 16 else { throw BoundSocketError.invalidAddressLength }
            var socketAddress = sockaddr_in6()
            socketAddress.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            socketAddress.sin6_family = sa_family_t(AF_INET6)
            socketAddress.sin6_port = port.bigEndian
            withUnsafeMutableBytes(of: &socketAddress.sin6_addr) { destination in
                destination.copyBytes(from: bytes)
            }
            try connectPointer(
                to: &socketAddress,
                length: socklen_t(MemoryLayout<sockaddr_in6>.size)
            )
        case .domain:
            throw BoundSocketError.domainRequiresResolution
        }
    }

    func currentBoundInterfaceIndex() throws -> UInt32 {
        guard fileDescriptor >= 0 else {
            throw BoundSocketError.systemCall(operation: "getsockopt", code: EBADF)
        }
        var index: UInt32 = 0
        var length = socklen_t(MemoryLayout<UInt32>.size)
        let option = family.boundInterfaceOption
        guard getsockopt(
            fileDescriptor,
            option.level,
            option.name,
            &index,
            &length
        ) == 0 else {
            throw BoundSocketError.systemCall(operation: "getsockopt", code: errno)
        }
        return index
    }

    /// Relay sockets must never carry a receive timeout: an idle connection is
    /// normal for SSH, WebSocket and HTTP keep-alive, and treating the timeout
    /// as an error tore those connections down.
    func clearTimeouts() throws {
        try setTimeout(seconds: 0)
    }

    func setNonBlocking() throws {
        let flags = fcntl(fileDescriptor, F_GETFL, 0)
        guard flags >= 0 else {
            throw BoundSocketError.systemCall(operation: "F_GETFL", code: errno)
        }
        guard fcntl(fileDescriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else {
            throw BoundSocketError.systemCall(operation: "F_SETFL", code: errno)
        }
    }

    /// Non-blocking read that reports "nothing yet" and "peer closed" as states
    /// rather than folding them into an error, so a relay can tell an idle
    /// connection apart from a broken one.
    func read(maximumBytes: Int) throws -> BoundSocketReadResult {
        guard fileDescriptor >= 0 else {
            throw BoundSocketError.systemCall(operation: "recv", code: EBADF)
        }
        var bytes = [UInt8](repeating: 0, count: maximumBytes)
        while true {
            let count = bytes.withUnsafeMutableBytes { buffer in
                Darwin.recv(fileDescriptor, buffer.baseAddress, buffer.count, 0)
            }
            if count > 0 { return .data(Data(bytes.prefix(count))) }
            if count == 0 { return .endOfStream }
            switch errno {
            case EINTR: continue
            case EAGAIN, EWOULDBLOCK: return .wouldBlock
            default: throw BoundSocketError.systemCall(operation: "recv", code: errno)
            }
        }
    }

    /// Returns how many bytes were accepted. Zero means the socket is full and
    /// the caller should wait for writability.
    func write(_ data: Data) throws -> Int {
        guard fileDescriptor >= 0 else {
            throw BoundSocketError.systemCall(operation: "send", code: EBADF)
        }
        guard !data.isEmpty else { return 0 }
        return try data.withUnsafeBytes { rawBuffer -> Int in
            guard let base = rawBuffer.baseAddress else { return 0 }
            while true {
                let count = Darwin.send(fileDescriptor, base, rawBuffer.count, 0)
                if count >= 0 { return count }
                switch errno {
                case EINTR: continue
                case EAGAIN, EWOULDBLOCK: return 0
                default: throw BoundSocketError.systemCall(operation: "send", code: errno)
                }
            }
        }
    }

    func setTimeout(seconds: Int) throws {
        var timeout = timeval(tv_sec: seconds, tv_usec: 0)
        for option in [SO_RCVTIMEO, SO_SNDTIMEO] {
            guard setsockopt(
                fileDescriptor,
                SOL_SOCKET,
                option,
                &timeout,
                socklen_t(MemoryLayout<timeval>.size)
            ) == 0 else {
                throw BoundSocketError.systemCall(operation: "setsockopt timeout", code: errno)
            }
        }
    }

    func sendAll(_ data: Data) throws {
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var sent = 0
            while sent < rawBuffer.count {
                let count = Darwin.send(
                    fileDescriptor,
                    base.advanced(by: sent),
                    rawBuffer.count - sent,
                    0
                )
                if count > 0 {
                    sent += count
                    continue
                }
                guard count < 0, errno == EINTR else {
                    throw BoundSocketError.systemCall(operation: "send", code: errno)
                }
            }
        }
    }

    /// Blocking read used only by the bounded DNS exchange, which relies on
    /// SO_RCVTIMEO to bound its wait.
    func receive(maximumBytes: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: maximumBytes)
        while true {
            let count = bytes.withUnsafeMutableBytes { buffer in
                Darwin.recv(fileDescriptor, buffer.baseAddress, buffer.count, 0)
            }
            if count >= 0 { return Data(bytes.prefix(count)) }
            guard errno == EINTR else {
                throw BoundSocketError.systemCall(operation: "recv", code: errno)
            }
        }
    }

    /// Blocking stream read for protocol handshakes. A successful return always
    /// contains exactly `byteCount` bytes; EOF before that is a failed handshake.
    func receiveExactly(_ byteCount: Int) throws -> Data {
        guard byteCount >= 0 else {
            throw BoundSocketError.systemCall(operation: "recv", code: EINVAL)
        }
        var result = Data()
        result.reserveCapacity(byteCount)
        while result.count < byteCount {
            let chunk = try receive(maximumBytes: byteCount - result.count)
            guard !chunk.isEmpty else {
                throw BoundSocketError.systemCall(operation: "recv EOF", code: ECONNRESET)
            }
            result.append(chunk)
        }
        return result
    }

    private func connectPointer<T>(to address: inout T, length: socklen_t) throws {
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fileDescriptor, $0, length)
            }
        }
        guard result == 0 else {
            throw BoundSocketError.systemCall(operation: "connect", code: errno)
        }
    }
}
