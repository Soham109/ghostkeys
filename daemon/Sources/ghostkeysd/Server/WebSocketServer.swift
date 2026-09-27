import Foundation
import Network
import CryptoKit

/// Loopback-only, authenticated WebSocket server (RFC 6455) over a plain TCP listener. All callbacks run on `queue`
/// (the daemon's core queue).
///
/// The daemon reads each connection's HTTP upgrade request itself, so every verdict belongs to exactly one connection
/// (Network.framework's WebSocket layer cannot say which connection a handshake belongs to, and still reports
/// rejected handshakes as ready). Security (SAFETY_AUDIT C1, M6; STRESS_FINDINGS 1-2; PROTOCOL.md "Authentication"):
/// - A handshake carrying an `Origin` header is rejected (browsers always send one; the app never does).
/// - The handshake must carry `X-Ghostkeys-Token` matching the per-launch token.
/// - A connection must send its first bytes within 0.5 s and a complete request (at most 8 KB) within 2 s.
/// - Connections that have not authenticated never count against authenticated clients: at most `maxPending` may
///   wait, and when full the one that has been idle longest is closed to make room.
/// - At most `maxClients` authenticated clients; at most `maxMessagesPerSecond` messages per client.
/// - Messages are capped at 1 MB and at JSON nesting depth `maxJSONDepth` (deeper frames are refused before
///   parsing; Foundation's JSON parser recurses without a limit and overflows the stack on ~470 nested objects).
/// - Bounded send queues: stream frames are skipped for a client that is behind; one far behind is dropped.
final class WebSocketServer {
    final class Client {
        let id: Int
        let connection: NWConnection
        var streams: Set<String> = []
        /// True once the WebSocket handshake succeeded (authenticated).
        var ready = false
        var pendingBytes = 0
        var windowStart = 0.0
        var windowCount = 0
        var testActionTimes: [Double] = []
        /// Refused frames (nested too deep). Three strikes close the connection.
        var strikes = 0
        // Transport state.
        fileprivate var inbox = Data()
        fileprivate var message = Data()           // fragments of the message being received
        fileprivate var messageOpcode: UInt8 = 0
        fileprivate var lastActivity = 0.0
        fileprivate var closing = false
        init(id: Int, connection: NWConnection) { self.id = id; self.connection = connection }
    }

    static let maxClients = 8
    static let maxPending = 64
    static let firstBytesTimeout = 0.5
    static let handshakeTimeout = 2.0
    static let maxHeaderBytes = 8 * 1024
    static let maxMessagesPerSecond = 200
    static let maxMessageBytes = 1 << 20
    static let maxJSONDepth = 64
    static let maxStrikes = 3
    /// Unsent bytes above which stream frames (imu, light, lid, taps, debug, air) are skipped for that client.
    static let streamBacklogBytes = 64 * 1024
    /// Unsent bytes above which the client is dropped.
    static let maxBacklogBytes = 1 << 20
    private static let wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

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
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
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

    func stop() {
        listener?.cancel()
        for c in clients.values { c.connection.cancel() }
        clients.removeAll()
    }

    private var readyCount: Int { clients.values.filter(\.ready).count }

    // MARK: Accept and handshake

    private func accept(_ conn: NWConnection) {
        // Unauthenticated connections never block authenticated ones: when too many are waiting, the one idle the
        // longest is closed to make room for the newcomer.
        let pending = clients.values.filter { !$0.ready }
        if pending.count >= Self.maxPending, let idlest = pending.min(by: { $0.lastActivity < $1.lastActivity }) {
            Log.debug("closing connection \(idlest.id): evicted (too many connections waiting to authenticate)")
            drop(idlest)
        }
        let client = Client(id: nextID, connection: conn)
        nextID += 1
        client.lastActivity = Clock.now()
        clients[client.id] = client
        conn.stateUpdateHandler = { [weak self, weak client] state in
            guard let self, let client else { return }
            switch state {
            case .failed, .cancelled: self.drop(client)
            default: break
            }
        }
        conn.start(queue: queue)
        // First bytes within 0.5 s, full request within 2 s.
        queue.asyncAfter(deadline: .now() + Self.firstBytesTimeout) { [weak self, weak client] in
            guard let self, let client, !client.ready, client.inbox.isEmpty, self.clients[client.id] != nil else { return }
            Log.debug("closing connection \(client.id): no bytes within \(Self.firstBytesTimeout) s")
            self.drop(client)
        }
        queue.asyncAfter(deadline: .now() + Self.handshakeTimeout) { [weak self, weak client] in
            guard let self, let client, !client.ready, self.clients[client.id] != nil else { return }
            Log.debug("closing connection \(client.id): handshake not completed within \(Self.handshakeTimeout) s")
            self.reject(client, status: "408 Request Timeout", reason: "handshake timeout")
        }
        receive(client)
    }

    private func receive(_ client: Client) {
        client.connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak client] data, _, isComplete, error in
            guard let self, let client, self.clients[client.id] != nil else { return }
            if let data, !data.isEmpty {
                client.lastActivity = Clock.now()
                client.inbox.append(data)
                if client.ready { self.processFrames(client) } else { self.processHandshake(client) }
            }
            if error != nil || isComplete { self.drop(client); return }
            if self.clients[client.id] != nil, !client.closing { self.receive(client) }
        }
    }

    private func processHandshake(_ client: Client) {
        guard let end = client.inbox.range(of: Data("\r\n\r\n".utf8)) else {
            if client.inbox.count > Self.maxHeaderBytes { reject(client, status: "431 Request Header Fields Too Large", reason: "header too large") }
            return
        }
        guard end.upperBound <= Self.maxHeaderBytes else {
            return reject(client, status: "431 Request Header Fields Too Large", reason: "header too large")
        }
        let head = String(decoding: client.inbox[..<end.lowerBound], as: UTF8.self)
        let rest = client.inbox[end.upperBound...]
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = headers[name].map { $0 + ", " + value } ?? value
        }
        guard requestLine.count >= 3, requestLine[0] == "GET", requestLine[2].hasPrefix("HTTP/1.1") else {
            return reject(client, status: "400 Bad Request", reason: "not an HTTP/1.1 GET")
        }
        if headers["origin"] != nil {
            Log.info("rejected a WebSocket handshake with an Origin header (a browser page?)")
            return reject(client, status: "400 Bad Request", reason: "origin not allowed")
        }
        guard token.accepts(headers["x-ghostkeys-token"]) else {
            Log.info("rejected a WebSocket handshake without a valid X-Ghostkeys-Token")
            return reject(client, status: "400 Bad Request", reason: "missing or wrong X-Ghostkeys-Token")
        }
        guard headers["upgrade"]?.lowercased().contains("websocket") == true,
              headers["connection"]?.lowercased().contains("upgrade") == true,
              headers["sec-websocket-version"] == "13",
              let key = headers["sec-websocket-key"], Data(base64Encoded: key)?.count == 16 else {
            return reject(client, status: "400 Bad Request", reason: "not a WebSocket upgrade")
        }
        guard readyCount < Self.maxClients else {
            Log.info("refusing a connection: already \(Self.maxClients) clients")
            return reject(client, status: "503 Service Unavailable", reason: "too many clients")
        }
        let accept = Data(Insecure.SHA1.hash(data: Data((key + Self.wsGUID).utf8))).base64EncodedString()
        let response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
        client.connection.send(content: Data(response.utf8), completion: .idempotent)
        client.inbox = Data(rest)
        client.ready = true
        Log.debug("client \(client.id) connected")
        onConnect(client)
        if !client.inbox.isEmpty { processFrames(client) }
    }

    private func reject(_ client: Client, status: String, reason: String) {
        guard clients[client.id] != nil, !client.closing else { return }
        client.closing = true
        let body = reason + "\n"
        let response = "HTTP/1.1 \(status)\r\nContent-Type: text/plain\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        client.connection.send(content: Data(response.utf8), isComplete: true, completion: .contentProcessed { [weak self, weak client] _ in
            guard let self, let client else { return }
            self.drop(client)
        })
    }

    // MARK: Frames (RFC 6455)

    private func processFrames(_ client: Client) {
        while clients[client.id] != nil, !client.closing {
            let b = client.inbox
            guard b.count >= 2 else { return }
            let i0 = b.startIndex
            let b0 = b[i0], b1 = b[i0 + 1]
            let fin = b0 & 0x80 != 0, opcode = b0 & 0x0F
            guard b0 & 0x70 == 0 else { return closeWith(client, code: 1002, "reserved bits set") }
            guard b1 & 0x80 != 0 else { return closeWith(client, code: 1002, "client frames must be masked") }
            var len = Int(b1 & 0x7F), offset = 2
            if len == 126 {
                guard b.count >= 4 else { return }
                len = Int(b[i0 + 2]) << 8 | Int(b[i0 + 3]); offset = 4
            } else if len == 127 {
                guard b.count >= 10 else { return }
                var v: UInt64 = 0
                for k in 2..<10 { v = v << 8 | UInt64(b[i0 + k]) }
                guard v <= UInt64(Self.maxMessageBytes) else { return closeWith(client, code: 1009, "message too big") }
                len = Int(v); offset = 10
            }
            guard len <= Self.maxMessageBytes else { return closeWith(client, code: 1009, "message too big") }
            guard b.count >= offset + 4 + len else { return }          // wait for the rest of the frame
            let mask = [b[i0 + offset], b[i0 + offset + 1], b[i0 + offset + 2], b[i0 + offset + 3]]
            let start = i0 + offset + 4
            var payload = Data(b[start..<(start + len)])
            payload.withUnsafeMutableBytes { raw in
                for k in 0..<raw.count { raw[k] ^= mask[k & 3] }
            }
            client.inbox = Data(b[(start + len)...])

            switch opcode {
            case 0x8:                                                  // close
                return closeWith(client, code: payload.count >= 2 ? UInt16(payload[payload.startIndex]) << 8 | UInt16(payload[payload.startIndex + 1]) : 1000, nil)
            case 0x9:                                                  // ping
                guard fin, len <= 125 else { return closeWith(client, code: 1002, "bad control frame") }
                sendFrame(client, opcode: 0xA, payload: payload)
            case 0xA:                                                  // pong
                break
            case 0x1, 0x2, 0x0:
                if opcode != 0 {
                    guard client.message.isEmpty else { return closeWith(client, code: 1002, "expected a continuation frame") }
                    client.messageOpcode = opcode
                } else if client.message.isEmpty && client.messageOpcode == 0 {
                    return closeWith(client, code: 1002, "unexpected continuation frame")
                }
                guard client.message.count + payload.count <= Self.maxMessageBytes else {
                    return closeWith(client, code: 1009, "message too big")
                }
                client.message.append(payload)
                if fin {
                    let data = client.message
                    client.message = Data()
                    client.messageOpcode = 0
                    deliver(client, data)
                }
            default:
                return closeWith(client, code: 1002, "unknown opcode")
            }
        }
    }

    private func deliver(_ client: Client, _ data: Data) {
        guard !data.isEmpty else { return }
        guard withinRate(client) else {
            Log.info("client \(client.id) exceeded \(Self.maxMessagesPerSecond) messages/s; disconnecting")
            send(["type": "error", "message": "rate limit exceeded; disconnecting"], to: client)
            queue.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.closeWith(client, code: 1008, "rate limit") }
            return
        }
        // Refuse deep nesting before the recursive JSON parser sees it.
        let depth = Self.jsonNestingDepth(data, limit: Self.maxJSONDepth)
        if depth > Self.maxJSONDepth {
            strike(client, "message nested deeper than \(Self.maxJSONDepth) levels")
            return
        }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            onMessage(client, obj)
        } else {
            send(["type": "error", "message": "invalid JSON"], to: client)   // harmless: answered, not a strike
        }
    }

    /// A refused message: tell the client, count it toward the rate limit, and close after `maxStrikes`.
    private func strike(_ client: Client, _ reason: String) {
        client.strikes += 1
        client.windowCount += 20
        Log.info("client \(client.id): refused a message (\(reason)); strike \(client.strikes) of \(Self.maxStrikes)")
        send(["type": "error", "message": reason], to: client)
        if client.strikes >= Self.maxStrikes {
            queue.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.closeWith(client, code: 1008, "too many refused messages") }
        }
    }

    /// Deepest nesting of `{` / `[` outside strings (escapes respected). Stops counting once past `limit`.
    static func jsonNestingDepth(_ data: Data, limit: Int) -> Int {
        var depth = 0, maxDepth = 0, inString = false, escaped = false
        for byte in data {
            if inString {
                if escaped { escaped = false }
                else if byte == 0x5C { escaped = true }          // backslash
                else if byte == 0x22 { inString = false }        // quote
                continue
            }
            switch byte {
            case 0x22: inString = true
            case 0x7B, 0x5B:                                     // { [
                depth += 1
                if depth > maxDepth { maxDepth = depth; if maxDepth > limit { return maxDepth } }
            case 0x7D, 0x5D: depth = max(0, depth - 1)           // } ]
            default: break
            }
        }
        return maxDepth
    }

    private func closeWith(_ client: Client, code: UInt16, _ reason: String?) {
        guard clients[client.id] != nil, !client.closing else { return }
        client.closing = true
        if let reason { Log.debug("closing client \(client.id): \(reason) (\(code))") }
        var payload = Data([UInt8(code >> 8), UInt8(code & 0xFF)])
        if let reason { payload.append(Data(reason.utf8.prefix(120))) }
        let frame = Self.frame(opcode: 0x8, payload: payload)
        client.connection.send(content: frame, isComplete: true, completion: .contentProcessed { [weak self, weak client] _ in
            guard let self, let client else { return }
            self.drop(client)
        })
    }

    func drop(_ client: Client) {
        guard clients.removeValue(forKey: client.id) != nil else { return }
        Log.debug("client \(client.id) disconnected")
        client.connection.cancel()
        if client.ready { onDisconnect(client) }
    }

    private func withinRate(_ c: Client) -> Bool {
        let now = Clock.now()
        if now - c.windowStart >= 1 { c.windowStart = now; c.windowCount = 0 }
        c.windowCount += 1
        return c.windowCount <= Self.maxMessagesPerSecond
    }

    // MARK: Sending

    static func frame(opcode: UInt8, payload: Data) -> Data {
        var f = Data([0x80 | opcode])
        let n = payload.count
        if n < 126 { f.append(UInt8(n)) }
        else if n <= 0xFFFF { f.append(126); f.append(UInt8(n >> 8)); f.append(UInt8(n & 0xFF)) }
        else { f.append(127); for k in (0..<8).reversed() { f.append(UInt8((UInt64(n) >> (8 * UInt64(k))) & 0xFF)) } }
        f.append(payload)
        return f
    }

    private func sendFrame(_ client: Client, opcode: UInt8, payload: Data) {
        client.connection.send(content: Self.frame(opcode: opcode, payload: payload), completion: .idempotent)
    }

    func send(_ message: [String: Any], to client: Client) {
        guard let data = Self.encode(message) else { return }
        enqueue(data, to: client, droppable: false)
    }

    /// Sends to every client, or only to those subscribed to `stream`. Stream frames are skipped for slow clients.
    func broadcast(_ message: [String: Any], stream: String? = nil) {
        guard !clients.isEmpty else { return }
        let targets = clients.values.filter { $0.ready && (stream == nil || $0.streams.contains(stream!)) }
        guard !targets.isEmpty, let data = Self.encode(message) else { return }
        let frame = Self.frame(opcode: 0x1, payload: data)
        for client in targets { enqueueFrame(frame, to: client, droppable: stream != nil) }
    }

    private func enqueue(_ data: Data, to client: Client, droppable: Bool) {
        enqueueFrame(Self.frame(opcode: 0x1, payload: data), to: client, droppable: droppable)
    }

    private func enqueueFrame(_ frame: Data, to client: Client, droppable: Bool) {
        guard client.ready, !client.closing, clients[client.id] != nil else { return }
        if droppable && client.pendingBytes > Self.streamBacklogBytes { return }
        if client.pendingBytes + frame.count > Self.maxBacklogBytes {
            Log.info("client \(client.id) is not reading; disconnecting")
            drop(client)
            return
        }
        client.pendingBytes += frame.count
        let size = frame.count
        client.connection.send(content: frame, completion: .contentProcessed { [weak self, weak client] err in
            guard let self, let client else { return }
            client.pendingBytes -= size
            if err != nil { self.drop(client) }
        })
    }

    func hasSubscribers(_ stream: String) -> Bool {
        clients.values.contains { $0.ready && $0.streams.contains(stream) }
    }

    static func encode(_ message: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(message) else {
            Log.error("dropping message that is not valid JSON: \(message["type"] ?? "?")")
            return nil
        }
        return try? JSONSerialization.data(withJSONObject: message)
    }
}
