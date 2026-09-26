import { showHUD } from "@raycast/api";
import type { StatusMsg } from "@ghostkeys/sdk";
import { createGhostkeysClient, describeError } from "./lib/client";

export default async function TogglePause() {
  const client = createGhostkeysClient({ reconnect: false });
  let sawStatus: StatusMsg | undefined;
  const offStatus = client.on("status", (msg) => {
    sawStatus = msg;
  });

  try {
    await client.connect();

    // status normally arrives right after hello in the same burst
    // (docs/PROTOCOL.md, the daemon's `greet()`); give it a brief grace
    // window in case it hasn't landed yet.
    if (!sawStatus) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const paused = sawStatus?.paused ?? client.lastStatus?.paused ?? false;

    if (paused) {
      await client.resume();
      await showHUD("Ghostkeys resumed");
    } else {
      await client.pause();
      await showHUD("Ghostkeys paused");
    }
  } catch (err) {
    await showHUD(`Ghostkeys unreachable: ${describeError(err)}`);
  } finally {
    offStatus();
    client.disconnect();
  }
}
