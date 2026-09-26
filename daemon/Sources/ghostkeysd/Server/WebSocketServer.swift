import Foundation
import Network

/// Loopback-only, authenticated WebSocket server. All callbacks run on `queue` (the daemon's core queue).
///
/// Security (SAFETY_AUDIT C1, M6; PROTOCOL.md "Authentication"):
/// - Handshakes carrying an `Origin` header are rejected: browsers always send one, the app never does.
/// - Handshakes must carry `X-Ghostkeys-Token` matching the per-launch token.
/// - At most `maxClients` clients; at most `maxMessagesPerSecond` messages per client (client dropped above that).
/// - Bounded send queues: stream frames are skipped for a client that is behind; a client that falls far behind is
///   dropped.
final class WebSocketServer {
    final class Client {
        let id: Int
        let connection: NWConnection
        var streams: Set<String> = []
        var ready = false
        var pendingBytes = 0
        var windowStart = 0.0
        var windowCount = 0
        var testActionTimes: [Double] = []
        /// Handshake verdict recorded for this connection: nil = none seen yet, true = token ok and no Origin.
        var authorized: Bool?
        init(id: Int, connection: NWConnection) { self.id = id; self.connection = connection }
    }

    static let maxClients = 8
    /// Connections still in the handshake. Rejected handshakes are cancelled after `handshakeTimeout`.
    static let maxPending = 16
    static let handshakeTimeout = 2.0
    static let maxMessagesPerSecond = 200
    static let maxMessageBytes = 1 << 20
    /// Unsent bytes above which stream frames (imu, light, lid, taps) are skipped for that client.
    static let streamBacklogBytes = 64 * 1024
    /// Unsent bytes above which the client is dropped.
    static let maxBacklogBytes = 1 << 20

    let port: UInt16
    private let queue: DispatchQueue
    private let token: SessionToken
    private var listener: NWListener?
    private(set) var clients: [Int: Client] = [:]
    private var nextID = 1

    var onConnect: (Client) -> Void = { _ in }
    var onMessage: (Client, [String: Any]) -> Void = { _, _ in }
    var onDisconnect: (Client) -> Void = { _ in }

    init(port: UInt16, queue: DispatchQueue, token: SessionToken) {
        self.port = port
        self.queue = queue
        self.token = token
    }

    func start() throws {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = Self.maxMessageBytes
        // Runs on `queue`. Network.framework does not say which connection a handshake belongs to, and a rejected
        // handshake still reaches `.ready` on the server side. So handshakes are serialized (see `admitNext`): exactly
        // one connection is ever mid-handshake, the verdict is recorded against it, and `.ready` admits only a
        // connection with a recorded "accept".
        nonisolated(unsafe) weak var weakSelf = self
        let token = self.token
        ws.setClientRequestHandler(queue) { _, headers in
            let verdict = Self.authorize(headers: headers, token: token)
            guard let server = weakSelf, let client = server.handshaking, client.authorized == nil else {
                // Cannot happen with serialized admissions; refuse rather than guess.
                Log.error("handshake with no connection in flight; refusing")
                return NWProtocolWebSocket.Response(status: .reject, subprotocol: nil, additionalHeaders: nil)
            }
            client.authorized = verdict.status == .accept
            return verdict
        }
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.allowLocalEndpointReuse = true
        // Bind to loopback only, never to all interfaces.
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
        params.acceptLocalOnly = true

        let listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready: Log.info("listening on ws://127.0.0.1:\(self.port)/ (token in \(self.token.url.path))")
            case .failed(let err):
                Log.error("WebSocket listener failed: \(err)")
                exit(3)   // most likely the port is in use; the app will see the process exit
            default: break
            }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    static func authorize(headers: [(name: String, value: String)], token: SessionToken) -> NWProtocolWebSocket.Response {
        let reject = NWProtocolWebSocket.Response(status: .reject, subprotocol: nil, additionalHeaders: nil)
        if headers.contains(where: { $0.name.caseInsensitiveCompare("Origin") == .orderedSame }) {
            Log.info("rejected a WebSocket handshake with an Origin header (a browser page?)")
            return reject
        }
        let presented = headers.first { $0.name.caseInsensitiveCompare("X-Ghostkeys-Token") == .orderedSame }?.value
        guard token.accepts(presented) else {
            Log.info("rejected a WebSocket handshake without a valid X-Ghostkeys-Token")
            return reject
        }
        return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil, additionalHeaders: nil)
    }

    func stop() {
        listener?.cancel()
        admissions.forEach { $0.cancel() }
        admissions.removeAll()
        for c in clients.values { c.connection.cancel() }
        clients.removeAll()
    }

    private var readyCount: Int { clients.values.filter(\.ready).count }

    /// Connections waiting their turn to handshake (not started yet), and the one handshaking now.
    private var admissions: [NWConnection] = []
    private var handshaking: Client?

    private func accept(_ conn: NWConnection) {
        // Only authenticated (ready) clients count toward maxClients, so failed handshakes cannot lock the app out.
        guard admissions.count + (handshaking == nil ? 0 : 1) < Self.maxPending else {
            Log.info("refusing a connection: too many handshakes in progress")
            conn.cancel()
            return
        }
        admissions.append(conn)
        admitNext()
    }

    /// Starts the next queued connection once no other handshake is in flight. Simultaneous connections therefore
    /// just wait their turn (each handshake takes a few milliseconds; a stalled one is cut off after 2 s).
    private func admitNext() {
        guard handshaking == nil, !admissions.isEmpty else { return }
        let conn = admissions.removeFirst()
        let client = Client(id: nextID, connection: conn)
        nextID += 1
        clients[client.id] = client
        handshaking = client
        // A rejected (or stalled) handshake never becomes ready: close it instead of leaving the peer hanging.
        queue.asyncAfter(deadline: .now() + Self.handshakeTimeout) { [weak self, weak client] in
            guard let self, let client, !client.ready else { return }
            Log.debug("closing connection \(client.id): handshake not completed")
            self.drop(client)
        }
        conn.stateUpdateHandler = { [weak self, weak client] state in
            guard let self, let client else { return }
            Log.debug("connection \(client.id) state: \(state)")
            switch state {
            case .ready:
                self.handshakeFinished(client)
                guard client.authorized == true else {
                    Log.debug("closing connection \(client.id): not authorized")
                    self.drop(client)
                    return
                }
                guard self.readyCount < Self.maxClients else {
                    Log.info("refusing a connection: already \(Self.maxClients) clients")
                    self.drop(client)
                    return
                }
                client.ready = true
                Log.debug("client \(client.id) connected")
                self.onConnect(client)
                self.receive(client)
            case .failed, .cancelled, .waiting:
                self.drop(client)
            default: break
            }
        }
        conn.start(queue: queue)
    }

    private func handshakeFinished(_ client: Client) {
        guard handshaking === client else { return }
        handshaking = nil
        queue.async { [weak self] in self?.admitNext() }
    }

    func drop(_ client: Client) {
        handshakeFinished(client)
        guard clients.removeValue(forKey: client.id) != nil else { return }
        Log.debug("client \(client.id) disconnected")
        client.connection.cancel()
        if client.ready { onDisconnect(client) }
    }

    private func receive(_ client: Client) {
        client.connection.receiveMessage { [weak self, weak client] data, context, _, error in
            guard let self, let client else { return }
            if let error {
                Log.debug("client \(client.id) receive error: \(error)")
                self.drop(client); return
            }
            let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if meta?.opcode == .close { self.drop(client); return }
            if let data, !data.isEmpty, meta?.opcode == .text || meta?.opcode == .binary {
                guard self.withinRate(client) else {
                    Log.info("client \(client.id) exceeded \(Self.maxMessagesPerSecond) messages/s; disconnecting")
                    self.send(["type": "error", "message": "rate limit exceeded; disconnecting"], to: client)
                    // Let the error go out, then close.
                    self.queue.asyncAfter(deadline: .now() + 0.05) { self.drop(client) }
                    return
                }
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.onMessage(client, obj)
                } else {
                    self.send(["type": "error", "message": "invalid JSON"], to: client)
                }
            }
            if self.clients[client.id] != nil { self.receive(client) }
        }
    }

    private func withinRate(_ c: Client) -> Bool {
        let now = Clock.now()
        if now - c.windowStart >= 1 { c.windowStart = now; c.windowCount = 0 }
        c.windowCount += 1
        return c.windowCount <= Self.maxMessagesPerSecond
    }

    // MARK: Sending

    func send(_ message: [String: Any], to client: Client) {
        guard let data = Self.encode(message) else { return }
        enqueue(data, to: client, droppable: false)
    }

    /// Sends to every client, or only to those subscribed to `stream`. Stream frames are skipped for slow clients.
    func broadcast(_ message: [String: Any], stream: String? = nil) {
        guard !clients.isEmpty else { return }
        let targets = clients.values.filter { $0.ready && (stream == nil || $0.streams.contains(stream!)) }
        guard !targets.isEmpty, let data = Self.encode(message) else { return }
        for client in targets { enqueue(data, to: client, droppable: stream != nil) }
    }

    private func enqueue(_ data: Data, to client: Client, droppable: Bool) {
        guard client.ready, clients[client.id] != nil else { return }
        if droppable && client.pendingBytes > Self.streamBacklogBytes { return }
        if client.pendingBytes + data.count > Self.maxBacklogBytes {
            Log.info("client \(client.id) is not reading; disconnecting")
            drop(client)
            return
        }
        client.pendingBytes += data.count
        let size = data.count
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "msg", metadata: [meta])
        client.connection.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { [weak self, weak client] err in
            guard let self, let client else { return }
            client.pendingBytes -= size
            if err != nil { self.drop(client) }
        })
    }

    func hasSubscribers(_ stream: String) -> Bool {
        clients.values.contains { $0.streams.contains(stream) }
    }

    static func encode(_ message: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(message) else {
            Log.error("dropping message that is not valid JSON: \(message["type"] ?? "?")")
            return nil
        }
        return try? JSONSerialization.data(withJSONObject: message)
    }
}
