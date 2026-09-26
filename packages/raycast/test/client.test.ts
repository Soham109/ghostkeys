import { test } from "node:test";
import assert from "node:assert/strict";
import { createGhostkeysClient, GhostkeysTimeoutError, withGhostkeysClient } from "../src/lib/client";
import { FakeGhostkeysDaemon } from "./fake-daemon";
import type { Config, GestureMsg } from "@ghostkeys/sdk";

test("connects and receives hello, with status/config following right after", async () => {
  const daemon = await FakeGhostkeysDaemon.start();
  const client = createGhostkeysClient({ url: daemon.url, reconnect: false });
  try {
    // Registered before connect() so we can't miss the greet burst
    // (hello, then status, then config) the fake daemon sends on connection.
    const statusArrived = new Promise((resolve) => client.once("status", resolve));

    const hello = await client.connect();
    assert.equal(hello.type, "hello");
    assert.equal(hello.device.chip, "Apple M5 Pro");

    const status = await statusArrived;
    assert.equal((status as { type: string }).type, "status");
    assert.equal(client.lastStatus?.paused, false);
    assert.equal(client.lastHello?.type, "hello");
  } finally {
    client.disconnect();
    await daemon.close();
  }
});

test("getConfig round-trips the daemon's config", async () => {
  const daemon = await FakeGhostkeysDaemon.start();
  try {
    const { config } = await withGhostkeysClient((client) => client.getConfig(), { url: daemon.url });
    assert.equal(config.version, 1);
    assert.equal(config.bindings.length, 1);
    assert.equal(config.bindings[0].label, "Volume up");
  } finally {
    await daemon.close();
  }
});

test("setConfig sends the new config and returns the daemon's ack", async () => {
  const daemon = await FakeGhostkeysDaemon.start();
  try {
    const { config, revision } = await withGhostkeysClient((client) => client.getConfig(), { url: daemon.url });
    const updated: Config = {
      ...config,
      bindings: config.bindings.map((b) => ({ ...b, enabled: false })),
    };

    const saved = await withGhostkeysClient((client) => client.setConfig(updated, { ifRevision: revision }), {
      url: daemon.url,
    });
    assert.equal(saved.config.bindings[0].enabled, false);

    // Confirm it actually persisted on the daemon, not just echoed back once.
    const reread = await withGhostkeysClient((client) => client.getConfig(), { url: daemon.url });
    assert.equal(reread.config.bindings[0].enabled, false);
  } finally {
    await daemon.close();
  }
});

test("pause and resume resolve once the daemon acks with an updated status", async () => {
  const daemon = await FakeGhostkeysDaemon.start({ initialPaused: false });
  const client = createGhostkeysClient({ url: daemon.url, reconnect: false });
  try {
    await client.connect();

    const pausedStatus = await client.pause();
    assert.equal(pausedStatus.paused, true);

    const resumedStatus = await client.resume();
    assert.equal(resumedStatus.paused, false);
  } finally {
    client.disconnect();
    await daemon.close();
  }
});

test("connect() rejects with GhostkeysTimeoutError if the socket opens but no hello arrives", async () => {
  // The socket opening successfully (unlike a refused TCP connection) is
  // the scenario the SDK's helloTimeoutMs is actually meant to guard: the
  // daemon accepted the connection but never said hello in time.
  const daemon = await FakeGhostkeysDaemon.start({ greetOnConnect: false });
  const client = createGhostkeysClient({ url: daemon.url, reconnect: false, helloTimeoutMs: 200 });
  try {
    await assert.rejects(() => client.connect(), GhostkeysTimeoutError);
  } finally {
    client.disconnect();
    await daemon.close();
  }
});

// Note: we don't have a test here for connecting to a refused/closed port
// (e.g. nothing listening at all). @ghostkeys/sdk's GhostkeysClient has a
// bug in that path: openSocket() creates its hello-wait promise (with its
// own setTimeout) before awaiting the "did the socket open" gate, and if
// that gate rejects first (ws 'error'/'close' before 'open'), the function
// throws without ever awaiting or cancelling the hello-wait promise. Its
// timer still fires later and rejects an orphaned promise, surfacing as an
// unhandledRejection well after connect() already rejected. Worth flagging
// upstream in packages/sdk; not something to route around by adding
// process-level unhandledRejection suppression here.

test("subscribing to a stream does not crash the fake daemon and is a no-op ack-wise", async () => {
  const daemon = await FakeGhostkeysDaemon.start();
  const client = createGhostkeysClient({ url: daemon.url, reconnect: false });
  try {
    await client.connect();
    // getConfig()'s awaitEvent('config', () => true, ...) matches ANY config
    // message, not specifically the reply to the config_get it's about to
    // send. The fake daemon's greet() (mirroring the real daemon) already
    // pushed one unsolicited "config" right after hello, as part of the same
    // burst that made connect() resolve; if that frame is still in flight
    // client-side, getConfig() below can resolve against it instead of a
    // real round trip, before this test's own "subscribe" has even reached
    // the daemon. Letting the greet burst fully settle first (same pattern
    // the SDK's own test suite uses) avoids racing that.
    await new Promise((resolve) => setTimeout(resolve, 30));

    client.subscribe(["taps"]);
    // Prove the connection is still alive and responsive after subscribing.
    const { config } = await client.getConfig();
    assert.ok(config);
    assert.ok(daemon.received.some((m) => m.type === "subscribe"));
  } finally {
    client.disconnect();
    await daemon.close();
  }
});

test("emitted gesture/tap frames reach typed listeners", async () => {
  const daemon = await FakeGhostkeysDaemon.start();
  const client = createGhostkeysClient({ url: daemon.url, reconnect: false });
  try {
    await client.connect();
    client.subscribe(["taps"]);

    const gesturePromise = new Promise<GestureMsg>((resolve) => client.once("gesture", resolve));

    daemon.emit({
      type: "gesture",
      t: 123.4,
      gesture: "double",
      zone: "right-grille",
      zones: null,
      modifiers: [],
      confidence: 0.91,
      app: "com.apple.finder",
    });

    const gesture = await gesturePromise;
    assert.equal(gesture.gesture, "double");
    assert.equal(gesture.zone, "right-grille");
  } finally {
    client.disconnect();
    await daemon.close();
  }
});
