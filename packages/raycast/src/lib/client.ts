import { WebSocket as NodeWebSocket } from "ws";
import { GhostkeysClient, type GhostkeysClientOptions, type WebSocketCtor } from "@ghostkeys/sdk";

export { GhostkeysClient };
export {
  GhostkeysError,
  GhostkeysTimeoutError,
  GhostkeysProtocolError,
  ConfigConflictError,
  NotConnectedError,
} from "@ghostkeys/sdk";

// Always hand the client the `ws` package's WebSocket explicitly rather than
// relying on whatever global WebSocket (or lack of one) happens to be
// present. Node 22 exposes one, but we don't control which Node build
// Raycast bundles to run commands, so this keeps behavior deterministic —
// the same pattern the SDK's own test suite uses.
const nodeWebSocket = NodeWebSocket as unknown as WebSocketCtor;

export function createGhostkeysClient(options: GhostkeysClientOptions = {}): GhostkeysClient {
  return new GhostkeysClient({ webSocket: nodeWebSocket, ...options });
}

/**
 * Connect, run `fn`, and always disconnect afterwards. For one-shot
 * request/response flows that don't need a live view keeping the socket
 * open (unlike e.g. Watch Gestures, which manages its own client).
 */
export async function withGhostkeysClient<T>(
  fn: (client: GhostkeysClient) => Promise<T>,
  options?: GhostkeysClientOptions,
): Promise<T> {
  const client = createGhostkeysClient({ reconnect: false, ...options });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
