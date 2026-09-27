import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { AppMessage, Config, DaemonMessage } from "@ghostkeys/sdk";

const DEFAULT_CONFIG: Config = {
  version: 1,
  zones: [
    { id: "left-palm", name: "Left palm", surface: "base", rect: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 }, color: "#7C5CFF" },
    { id: "right-grille", name: "Right grille", surface: "base", rect: { x: 0.88, y: 0.08, w: 0.1, h: 0.45 }, color: "#FF5C7C" },
  ],
  bindings: [
    {
      id: "b1",
      enabled: true,
      gesture: "double",
      zone: "right-grille",
      zones: null,
      modifiers: [],
      app: "*",
      action: { kind: "volume", step: 6 },
      label: "Volume up",
    },
  ],
  settings: {
    sensitivity: 0.5,
    typingGateMs: 450,
    doubleWindowMs: 350,
    minConfidence: 0.8,
    hud: true,
    haptics: false,
    sound: { enabled: false, sessionSeconds: 30, autoApps: [] },
    camera: { enabled: false, sessionSeconds: 30, autoApps: [], deskMode: false },
  },
};

export interface FakeDaemonOptions {
  /** Send hello+status+config immediately on connect, mirroring the real daemon's `greet()`. */
  greetOnConnect?: boolean;
  initialConfig?: Config;
  initialPaused?: boolean;
}

/**
 * A minimal stand-in for ghostkeysd that speaks just enough of
 * docs/PROTOCOL.md (and @ghostkeys/sdk's protocol/types.ts, which documents
 * a few details PROTOCOL.md's prose glosses over) for the Raycast
 * extension's tests. Never touches the user's real config; everything lives
 * in memory for the life of the test.
 */
export class FakeGhostkeysDaemon {
  private wss: WebSocketServer;
  private config: Config;
  private paused: boolean;
  readonly received: AppMessage[] = [];
  private clients = new Set<WebSocket>();
  /** Resolves once the server has actually bound its (ephemeral) port. */
  readonly ready: Promise<void>;

  constructor(private readonly options: FakeDaemonOptions = {}) {
    this.config = structuredClone(options.initialConfig ?? DEFAULT_CONFIG);
    this.paused = options.initialPaused ?? false;
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    // net.Server#address() returns null until 'listening' fires (this is
    // documented Node behavior for ephemeral port 0), so `url` isn't safe to
    // read until this resolves. Use FakeGhostkeysDaemon.start(...) in tests.
    this.ready = new Promise((resolve) => this.wss.once("listening", () => resolve()));
  }

  /** Preferred constructor: creates the daemon and waits until it's actually listening. */
  static async start(options?: FakeDaemonOptions): Promise<FakeGhostkeysDaemon> {
    const daemon = new FakeGhostkeysDaemon(options);
    await daemon.ready;
    return daemon;
  }

  get url(): string {
    const address = this.wss.address() as AddressInfo | null;
    if (!address) {
      throw new Error("FakeGhostkeysDaemon isn't listening yet; await `.ready` or use FakeGhostkeysDaemon.start().");
    }
    return `ws://127.0.0.1:${address.port}/`;
  }

  private handleConnection(socket: WebSocket) {
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));

    if (this.options.greetOnConnect ?? true) {
      this.sendTo(socket, {
        type: "hello",
        version: "0.1.0-fake",
        device: { model: "Mac17,8", chip: "Apple M5 Pro", family: "macbook-pro-14" },
        sensors: { imu: true, gyro: true, lid: true, light: true, sound: false, camera: false },
        permissions: { accessibility: true, microphone: "not_determined", camera: "not_determined" },
      });
      this.sendTo(socket, this.statusMessage());
      this.sendTo(socket, { type: "config", config: this.config });
    }

    socket.on("message", (data) => {
      let msg: AppMessage;
      try {
        msg = JSON.parse(data.toString()) as AppMessage;
      } catch {
        return;
      }
      this.received.push(msg);
      this.handleMessage(socket, msg);
    });
  }

  private statusMessage(): DaemonMessage {
    return {
      type: "status",
      paused: this.paused,
      pausedReason: this.paused ? "user" : null,
      calibrated: true,
      zones: this.config.zones.map((z) => z.id),
      imuHz: 797,
      detector: { noiseFloorMg: 1.2, thresholdMg: 17.5, level: 3.1 },
    };
  }

  private handleMessage(socket: WebSocket, msg: AppMessage) {
    switch (msg.type) {
      case "pause":
        this.paused = true;
        this.broadcast(this.statusMessage());
        break;
      case "resume":
        this.paused = false;
        this.broadcast(this.statusMessage());
        break;
      case "config_get":
        this.sendTo(socket, { type: "config", config: this.config });
        break;
      case "config_set":
        this.config = msg.config;
        // Real daemon broadcasts config_set's result to every connected client, not just the sender.
        this.broadcast({ type: "config", config: this.config });
        break;
      case "test_action":
        this.broadcast({
          type: "action",
          t: Date.now(),
          bindingId: null,
          label: "label" in msg.action && typeof msg.action.label === "string" ? msg.action.label : "test_action",
          ok: true,
          error: null,
        });
        break;
      case "subscribe":
      case "unsubscribe":
      case "calibration_start":
      case "calibration_zone":
      case "calibration_negatives":
      case "calibration_finish":
      case "calibration_cancel":
      case "request_permission":
        // No-op for the fake: nothing in the extension's tests asserts on
        // these beyond "the daemon received a well-formed message."
        break;
    }
  }

  /** Test helper: push an arbitrary daemon->app frame to every connected client, as if it happened live. */
  emit(message: DaemonMessage) {
    this.broadcast(message);
  }

  private sendTo(socket: WebSocket, message: DaemonMessage) {
    socket.send(JSON.stringify(message));
  }

  private broadcast(message: DaemonMessage) {
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
