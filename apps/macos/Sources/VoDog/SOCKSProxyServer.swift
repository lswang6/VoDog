import Foundation
import Network
import OSLog

private let socksServerLogger = Logger(
    subsystem: "org.vodog.macos",
    category: "SOCKSProxy"
)

final class SOCKSProxyServer {
    let configuration: SOCKSProxyConfiguration
    var onConnectionCountChanged: ((Int) -> Void)?
    var onFailure: ((Error) -> Void)?
    var onReady: ((UInt16) -> Void)?

    private let password: String?
    private let udpUpstreamProxy: VoWiFiUpstreamProxySnapshot?
    /// Overrides `listenScope` with a single local address. VoWiFi relays use
    /// it to stay reachable only from the module's ECM link instead of every
    /// network the Mac has joined.
    private let localBindAddress: String?
    /// Accept queue only. Each session owns its own serial queue so a stalled
    /// upstream cannot block the other sessions of this proxy.
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var listener: NWListener?
    private var sessions: [UUID: SOCKSProxySession] = [:]
    private var binding: SOCKSModuleNetworkBindingSnapshot?

    init(
        configuration: SOCKSProxyConfiguration,
        password: String?,
        udpUpstreamProxy: VoWiFiUpstreamProxySnapshot? = nil,
        localBindAddress: String? = nil
    ) {
        self.configuration = configuration
        self.password = password
        self.udpUpstreamProxy = udpUpstreamProxy
        self.localBindAddress = localBindAddress
        queue = DispatchQueue(label: "org.vodog.socks.\(configuration.id.uuidString)")
    }

    /// Pushed from the controller whenever the module's live network identity
    /// changes. Sessions read it without hopping to the main thread, which keeps
    /// the main actor off the connection path.
    func updateBinding(_ snapshot: SOCKSModuleNetworkBindingSnapshot?) {
        lock.lock()
        binding = snapshot
        lock.unlock()
    }

    private func currentBinding() -> SOCKSModuleNetworkBindingSnapshot? {
        lock.lock()
        defer { lock.unlock() }
        return binding
    }

    func start() throws {
        guard let port = NWEndpoint.Port(rawValue: configuration.port) else { return }
        lock.lock()
        let alreadyRunning = listener != nil
        lock.unlock()
        guard !alreadyRunning else { return }

        // Passing both requiredLocalEndpoint and `on:` makes NWListener fail
        // with EINVAL, which silently broke every loopback proxy. The endpoint
        // already carries the port, so only one of the two may be supplied.
        let listener: NWListener
        if let localBindAddress {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(
                host: NWEndpoint.Host(localBindAddress),
                port: port
            )
            listener = try NWListener(using: parameters)
        } else {
            switch configuration.listenScope {
            case .loopback:
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
                listener = try NWListener(using: parameters)
            case .lan:
                listener = try NWListener(using: .tcp, on: port)
            }
        }

        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .ready = state, let port = listener.port?.rawValue {
                self.onReady?(port)
            } else if case let .failed(error) = state {
                self.onFailure?(error)
                self.stop()
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        lock.lock()
        self.listener = listener
        lock.unlock()
        socksServerLogger.notice(
            """
            Starting listener proxy=\(self.configuration.name, privacy: .public) \
            scope=\(self.configuration.listenScope.rawValue, privacy: .public) \
            port=\(self.configuration.port)
            """
        )
        listener.start(queue: queue)
    }

    func stop() {
        lock.lock()
        let cancelled = listener
        listener = nil
        let active = Array(sessions.values)
        sessions.removeAll()
        lock.unlock()
        cancelled?.cancel()
        active.forEach {
            $0.onClose = nil
            $0.stop()
        }
    }

    private func accept(_ connection: NWConnection) {
        guard let binding = currentBinding() else {
            // Fail closed: without a live binding there is no interface to pin
            // the upstream to, and an unpinned socket would leak out of the
            // default route.
            socksServerLogger.error(
                "Refusing connection: no live module binding proxy=\(self.configuration.name, privacy: .public)"
            )
            connection.cancel()
            return
        }
        let id = UUID()
        let session = SOCKSProxySession(
            connection: connection,
            authentication: configuration.authentication,
            password: password,
            binding: binding,
            udpUpstreamProxy: udpUpstreamProxy,
            udpListenAddress: localBindAddress,
            queue: DispatchQueue(label: "org.vodog.socks.session.\(id.uuidString)")
        )
        session.onClose = { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.sessions[id] = nil
            let count = self.sessions.count
            self.lock.unlock()
            self.onConnectionCountChanged?(count)
        }
        lock.lock()
        sessions[id] = session
        let count = sessions.count
        lock.unlock()
        onConnectionCountChanged?(count)
        session.start()
    }
}

private final class SOCKSProxySession {
    private static let queueKey = DispatchSpecificKey<UUID>()

    var onClose: (() -> Void)?

    private enum Phase { case methods, authentication, request, relaying, udpRelaying, closed }
    private let connection: NWConnection
    private let authentication: SOCKSProxyConfiguration.Authentication
    private let password: String?
    private let binding: SOCKSModuleNetworkBindingSnapshot
    private let udpUpstreamProxy: VoWiFiUpstreamProxySnapshot?
    private let udpListenAddress: String?
    private let queue: DispatchQueue
    private let queueID = UUID()
    private var phase: Phase = .methods
    private var buffer = Data()
    private var upstream: BoundSocket?
    private var udpRelay: SOCKSUDPRelay?
    private var readSource: DispatchSourceRead?
    private var writeSource: DispatchSourceWrite?
    private var isReadSourceSuspended = false
    /// Dispatch sources start suspended; the write source is only armed while a
    /// backlog exists.
    private var isWriteSourceSuspended = true
    private var activeSourceCount = 0
    private var pendingUpstream = Data()
    private var isClientReadPaused = false

    init(
        connection: NWConnection,
        authentication: SOCKSProxyConfiguration.Authentication,
        password: String?,
        binding: SOCKSModuleNetworkBindingSnapshot,
        udpUpstreamProxy: VoWiFiUpstreamProxySnapshot?,
        udpListenAddress: String? = nil,
        queue: DispatchQueue
    ) {
        self.connection = connection
        self.authentication = authentication
        self.password = password
        self.binding = binding
        self.udpUpstreamProxy = udpUpstreamProxy
        self.udpListenAddress = udpListenAddress
        self.queue = queue
        queue.setSpecific(key: Self.queueKey, value: queueID)
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.readHandshake()
            case .failed, .cancelled: self?.finish()
            default: break
            }
        }
        connection.start(queue: queue)
    }

    func stop() {
        // Complete source cleanup before the server releases its final strong
        // reference to this session. Avoid sync-to-self if stop() is ever called
        // from a callback already running on the session queue.
        if DispatchQueue.getSpecific(key: Self.queueKey) == queueID {
            finish()
        } else {
            queue.sync { finish() }
        }
    }

    private func readHandshake() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) {
            [weak self] data, _, complete, error in
            guard let self, self.phase != .closed else { return }
            if let data { self.buffer.append(data) }
            if error != nil || complete { self.finish(); return }
            do {
                if try self.consumeHandshake() { return }
                self.readHandshake()
            } catch SOCKSProtocolError.incomplete {
                self.readHandshake()
            } catch {
                socksServerLogger.error(
                    "SOCKS handshake rejected error=\(String(describing: error), privacy: .public)"
                )
                self.finish()
            }
        }
    }

    /// Returns true when processing became asynchronous or relay started.
    private func consumeHandshake() throws -> Bool {
        switch phase {
        case .methods:
            let selection = try SOCKSProtocol.decodeMethodSelection(buffer)
            consume(selection.consumedByteCount)
            let required: SOCKSAuthenticationMethod
            switch authentication {
            case .none: required = .none
            case .usernamePassword: required = .usernamePassword
            }
            guard selection.methods.contains(required.rawValue) else {
                send(SOCKSProtocol.encodeMethodSelectionResponse(.noAcceptableMethods)) {
                    self.finish()
                }
                return true
            }
            phase = required == .none ? .request : .authentication
            send(SOCKSProtocol.encodeMethodSelectionResponse(required)) {
                do {
                    if try !self.consumeHandshake() { self.readHandshake() }
                } catch SOCKSProtocolError.incomplete {
                    self.readHandshake()
                } catch { self.finish() }
            }
            return true
        case .authentication:
            let credentials = try SOCKSProtocol.decodeUsernamePassword(buffer)
            consume(credentials.consumedByteCount)
            guard case let .usernamePassword(expectedUsername) = authentication else {
                finish(); return true
            }
            let accepted = credentials.username == expectedUsername && credentials.password == password
            if !accepted {
                socksServerLogger.error("SOCKS authentication rejected")
            }
            send(SOCKSProtocol.encodeUsernamePasswordResponse(succeeded: accepted)) {
                guard accepted else { self.finish(); return }
                self.phase = .request
                do {
                    if try !self.consumeHandshake() { self.readHandshake() }
                } catch SOCKSProtocolError.incomplete {
                    self.readHandshake()
                } catch { self.finish() }
            }
            return true
        case .request:
            let request = try SOCKSProtocol.decodeRequest(buffer)
            consume(request.consumedByteCount)
            if request.command == SOCKSCommand.connect.rawValue {
                openUpstream(for: request)
                return true
            }
            if request.command == SOCKSCommand.udpAssociate.rawValue {
                openUDPAssociation()
                return true
            }
            sendReply(.commandNotSupported) { self.finish() }
            return true
        case .relaying, .udpRelaying, .closed:
            return true
        }
    }

    private func openUDPAssociation() {
        let expectedHost: NWEndpoint.Host? = if case let .hostPort(host, _) = connection.endpoint {
            host
        } else {
            nil
        }
        let relay = SOCKSUDPRelay(
            bsdName: binding.bsdName,
            dnsServers: binding.dnsServers,
            expectedClientHost: expectedHost,
            upstreamProxy: udpUpstreamProxy,
            listenAddress: udpListenAddress,
            queue: queue
        )
        udpRelay = relay
        relay.onFailure = { [weak self] _ in self?.finish() }
        relay.start { [weak self] result in
            guard let self, self.phase != .closed else { return }
            switch result {
            case let .success(port):
                self.phase = .udpRelaying
                let reply = (try? SOCKSProtocol.encodeReply(
                    .succeeded,
                    boundAddress: .ipv4([0, 0, 0, 0]),
                    boundPort: port
                )) ?? Data()
                self.send(reply) { self.readUDPControlConnection() }
            case .failure:
                self.sendReply(.generalFailure) { self.finish() }
            }
        }
    }

    private func readUDPControlConnection() {
        guard phase == .udpRelaying else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1) {
            [weak self] _, _, complete, error in
            guard let self, self.phase == .udpRelaying else { return }
            if complete || error != nil {
                self.finish()
            } else {
                self.readUDPControlConnection()
            }
        }
    }

    /// Drops consumed bytes and rebases the buffer. Data.removeFirst only
    /// advances startIndex, so reusing the value directly would leave every
    /// later decode reading at the wrong offset.
    private func consume(_ byteCount: Int) {
        buffer = Data(buffer.dropFirst(byteCount))
    }

    private func openUpstream(for request: SOCKSRequest) {
        let binding = self.binding
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let addresses: [SOCKSAddress]
                switch request.address {
                case let .domain(domain):
                    let resolver = SOCKSDNSResolver()
                    addresses = resolver.resolveAddresses(
                        domain: domain,
                        dnsServers: binding.dnsServers,
                        bsdName: binding.bsdName
                    )
                    guard !addresses.isEmpty else { throw SOCKSDNSError.noAddresses }
                default:
                    addresses = [request.address]
                }
                var connected: BoundSocket?
                var lastError: Error = SOCKSDNSError.noAddresses
                for address in addresses {
                    do {
                        let family: BoundSocketFamily
                        switch address {
                        case .ipv4: family = .ipv4
                        case .ipv6: family = .ipv6
                        case .domain: continue
                        }
                        let socket = try BoundSocket(
                            family: family, kind: .tcp, bsdName: binding.bsdName
                        )
                        // The timeout bounds the connect attempt only. Leaving it
                        // on the relay socket tore down every connection that sat
                        // idle for ten seconds, which broke SSH, WebSocket and
                        // HTTP keep-alive.
                        try socket.setTimeout(seconds: 10)
                        try socket.connect(to: address, port: request.port)
                        try socket.clearTimeouts()
                        try socket.setNonBlocking()
                        connected = socket
                        break
                    } catch { lastError = error }
                }
                guard let connected else { throw lastError }
                self.queue.async {
                    guard self.phase != .closed else { connected.close(); return }
                    self.upstream = connected
                    self.phase = .relaying
                    self.sendReply(.succeeded) {
                        if !self.buffer.isEmpty {
                            self.pendingUpstream.append(self.buffer)
                            self.buffer.removeAll()
                        }
                        self.startRelay()
                    }
                }
            } catch {
                socksServerLogger.error(
                    """
                    Upstream connect failed interface=\(binding.bsdName, privacy: .public) \
                    destination=\(String(describing: request.address), privacy: .private) \
                    port=\(request.port) error=\(String(describing: error), privacy: .public)
                    """
                )
                self.queue.async { self.sendReply(self.reply(for: error)) { self.finish() } }
            }
        }
    }

    /// Both directions are event driven. The previous implementation parked a
    /// blocking `recv` on a global-queue thread for every session, which capped
    /// concurrency at the dispatch thread pool and let one stalled upstream
    /// stall unrelated work.
    private func startRelay() {
        guard let upstream else { finish(); return }
        let descriptor = upstream.fileDescriptor

        let readSource = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        readSource.setEventHandler { [weak self] in self?.drainUpstream() }
        readSource.setCancelHandler { [weak self] in self?.releaseUpstreamIfIdle() }
        self.readSource = readSource
        activeSourceCount += 1

        let writeSource = DispatchSource.makeWriteSource(fileDescriptor: descriptor, queue: queue)
        writeSource.setEventHandler { [weak self] in self?.flushToUpstream() }
        writeSource.setCancelHandler { [weak self] in self?.releaseUpstreamIfIdle() }
        self.writeSource = writeSource
        activeSourceCount += 1

        // Activate both sources immediately. Keeping the write source inactive
        // until backpressure appears leaves a legal path where session teardown
        // releases an inactive source, which libdispatch treats as a fatal bug.
        readSource.activate()
        writeSource.activate()
        isWriteSourceSuspended = false
        suspendWriteSource()
        readClientForRelay()
        flushToUpstream()
    }

    private func drainUpstream() {
        guard phase == .relaying, let upstream else { return }
        do {
            switch try upstream.read(maximumBytes: 64 * 1024) {
            case .wouldBlock:
                return
            case .endOfStream:
                finish()
            case let .data(data):
                // Hold off further upstream reads until the client has taken
                // these bytes, so a slow client cannot make us buffer without
                // bound.
                suspendReadSource()
                connection.send(content: data, completion: .contentProcessed {
                    [weak self] error in
                    guard let self else { return }
                    guard error == nil, self.phase == .relaying else {
                        self.finish()
                        return
                    }
                    self.resumeReadSource()
                })
            }
        } catch {
            finish()
        }
    }

    private func readClientForRelay() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, complete, error in
            guard let self, self.phase == .relaying else { return }
            if let data, !data.isEmpty {
                self.pendingUpstream.append(data)
                self.flushToUpstream()
            }
            if complete || error != nil {
                self.finish()
            } else if !self.isClientReadPaused {
                self.readClientForRelay()
            }
        }
    }

    /// Drains the pending buffer into the upstream socket. The write source is
    /// armed only while the socket is full, and client reads pause while a
    /// backlog exists so a fast client cannot grow the buffer without bound.
    private func flushToUpstream() {
        guard phase == .relaying, let upstream else { return }
        while !pendingUpstream.isEmpty {
            do {
                let written = try upstream.write(pendingUpstream)
                guard written > 0 else { break }
                // Rebase rather than removeFirst: the latter only advances
                // startIndex, so the consumed prefix would stay resident for the
                // life of the connection. Partial writes only occur under
                // backpressure, so the copy is rare.
                pendingUpstream = written == pendingUpstream.count
                    ? Data()
                    : Data(pendingUpstream.dropFirst(written))
            } catch {
                finish()
                return
            }
        }
        if pendingUpstream.isEmpty {
            suspendWriteSource()
            if isClientReadPaused {
                isClientReadPaused = false
                readClientForRelay()
            }
        } else {
            isClientReadPaused = true
            resumeWriteSource()
        }
    }

    private func suspendReadSource() {
        guard let readSource, !isReadSourceSuspended else { return }
        isReadSourceSuspended = true
        readSource.suspend()
    }

    private func resumeReadSource() {
        guard let readSource, isReadSourceSuspended else { return }
        isReadSourceSuspended = false
        readSource.resume()
    }

    private func suspendWriteSource() {
        guard let writeSource, !isWriteSourceSuspended else { return }
        isWriteSourceSuspended = true
        writeSource.suspend()
    }

    private func resumeWriteSource() {
        guard let writeSource, isWriteSourceSuspended else { return }
        isWriteSourceSuspended = false
        writeSource.resume()
    }

    private func sendReply(_ reply: SOCKSReply, completion: @escaping () -> Void) {
        send((try? SOCKSProtocol.encodeReply(reply)) ?? Data(), completion: completion)
    }

    private func send(_ data: Data, completion: @escaping () -> Void) {
        connection.send(content: data, completion: .contentProcessed { _ in completion() })
    }

    private func reply(for error: Error) -> SOCKSReply {
        if let error = error as? BoundSocketError,
           case let .systemCall(_, code) = error {
            if code == ECONNREFUSED { return .connectionRefused }
            if code == ENETUNREACH || code == EHOSTUNREACH { return .networkUnreachable }
        }
        return .hostUnreachable
    }

    /// The descriptor stays open until both dispatch sources have finished
    /// cancelling, otherwise a source could fire on a reused descriptor.
    private func releaseUpstreamIfIdle() {
        activeSourceCount -= 1
        guard activeSourceCount <= 0 else { return }
        upstream?.close()
        upstream = nil
    }

    private func finish() {
        guard phase != .closed else { return }
        phase = .closed
        pendingUpstream.removeAll()
        udpRelay?.onFailure = nil
        udpRelay?.stop()
        udpRelay = nil

        // A suspended dispatch source must be resumed before release, and both
        // sources must be cancelled before the descriptor is closed.
        if let readSource {
            readSource.setEventHandler(handler: nil)
            readSource.cancel()
            resumeReadSource()
            self.readSource = nil
        }
        if let writeSource {
            writeSource.setEventHandler(handler: nil)
            writeSource.cancel()
            resumeWriteSource()
            self.writeSource = nil
        }
        if activeSourceCount <= 0 {
            upstream?.close()
            upstream = nil
        }

        connection.cancel()
        let callback = onClose
        onClose = nil
        callback?()
    }
}
