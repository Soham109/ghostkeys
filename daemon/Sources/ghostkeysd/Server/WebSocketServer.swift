import Foundation
import Network

/// Loopback-only WebSocket server. All callbacks run on `queue` (the daemon's core queue).
final class WebSocketServer {
    final class Client {
        let id: Int
        let connection: NWConnection
        var streams: Set<String> = []
        var lastIMUSent: Double = 0
        var ready = false
        init(id: Int, connection: NWConnection) { self.id = id; self.connection = connection }
    }

    let port: UInt16
    private let queue: DispatchQueue
    private var listener: NWListener?
    private(set) var clients: [Int: Client] = [:]
    private var nextID = 1

    var onConnect: (Client) -> Void = { _ in }
    var onMessage: (Client, [String: Any]) -> Void = { _, _ in }
    var onDisconnect: (Client) -> Void = { _ in }

    init(port: UInt16, queue: DispatchQueue) {
        self.port = port
        self.queue = queue
    }

    func start() throws {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 4 * 1024 * 1024
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
            case .ready: Log.info("listening on ws://127.0.0.1:\(self.port)/")
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

    private func accept(_ conn: NWConnection) {
        let client = Client(id: nextID, connection: conn)
        nextID += 1
        clients[client.id] = client
        conn.stateUpdateHandler = { [weak self, weak client] state in
            guard let self, let client else { return }
            switch state {
            case .ready:
                client.ready = true
                Log.debug("client \(client.id) connected")
                self.onConnect(client)
                self.receive(client)
            case .failed, .cancelled:
                self.drop(client)
            default: break
            }
        }
        conn.start(queue: queue)
    }

    private func drop(_ client: Client) {
        guard clients.removeValue(forKey: client.id) != nil else { return }
        Log.debug("client \(client.id) disconnected")
        client.connection.cancel()
        onDisconnect(client)
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
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.onMessage(client, obj)
                } else {
                    self.send(["type": "error", "message": "invalid JSON"], to: client)
                }
            }
            if self.clients[client.id] != nil { self.receive(client) }
        }
    }

    // MARK: Sending

    func send(_ message: [String: Any], to client: Client) {
        guard client.ready, let data = Self.encode(message) else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "msg", metadata: [meta])
        client.connection.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { [weak self, weak client] err in
            if err != nil, let self, let client { self.drop(client) }
        })
    }

    /// Sends to every client, or only to those subscribed to `stream`.
    func broadcast(_ message: [String: Any], stream: String? = nil) {
        guard !clients.isEmpty, let data = Self.encode(message) else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        for client in clients.values where client.ready && (stream == nil || client.streams.contains(stream!)) {
            let ctx = NWConnection.ContentContext(identifier: "msg", metadata: [meta])
            client.connection.send(content: data, contentContext: ctx, isComplete: true, completion: .idempotent)
        }
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
