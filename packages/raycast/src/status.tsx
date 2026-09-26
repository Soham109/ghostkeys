import { useEffect, useRef, useState } from "react";
import { Color, Icon, List } from "@raycast/api";
import type { GestureMsg, HelloMsg, RejectedMsg, StatusMsg, TapMsg } from "@ghostkeys/sdk";
import { createGhostkeysClient, describeError } from "./lib/client";
import { gestureLabel } from "./lib/format";

type LogEntry =
  | { kind: "gesture"; t: number; message: GestureMsg }
  | { kind: "tap"; t: number; message: TapMsg }
  | { kind: "rejected"; t: number; message: RejectedMsg };

const MAX_LOG = 12;

export default function Status() {
  const [hello, setHello] = useState<HelloMsg | undefined>();
  const [status, setStatus] = useState<StatusMsg | undefined>();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const clientRef = useRef<ReturnType<typeof createGhostkeysClient> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = createGhostkeysClient();
    clientRef.current = client;

    // Registered before connect() so we can't miss the hello/status/config
    // burst the daemon sends right on connection (see docs/PROTOCOL.md and
    // the daemon's `greet()`).
    const offHello = client.on("hello", (msg) => !cancelled && setHello(msg));
    const offStatus = client.on("status", (msg) => !cancelled && setStatus(msg));
    const offGesture = client.on("gesture", (msg) => {
      if (cancelled) return;
      setLog((prev) => [{ kind: "gesture", t: msg.t, message: msg } as LogEntry, ...prev].slice(0, MAX_LOG));
    });
    const offTap = client.on("tap", (msg) => {
      if (cancelled) return;
      setLog((prev) => [{ kind: "tap", t: msg.t, message: msg } as LogEntry, ...prev].slice(0, MAX_LOG));
    });
    const offRejected = client.on("rejected", (msg) => {
      if (cancelled) return;
      setLog((prev) => [{ kind: "rejected", t: msg.t, message: msg } as LogEntry, ...prev].slice(0, MAX_LOG));
    });

    (async () => {
      try {
        await client.connect();
        client.subscribe(["taps"]);
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      offHello();
      offStatus();
      offGesture();
      offTap();
      offRejected();
      client.disconnect();
    };
  }, []);

  if (error) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.WifiDisabled}
          title="Ghostkeys isn't reachable"
          description={`${error}\n\nMake sure Ghostkeys.app (or ghostkeysd) is running.`}
        />
      </List>
    );
  }

  return (
    <List isLoading={isLoading} navigationTitle="Ghostkeys Status">
      <List.Section title="Daemon">
        <List.Item icon={Icon.Bolt} title="Version" accessories={[{ text: hello?.version ?? "unknown" }]} />
        <List.Item
          icon={Icon.ComputerChip}
          title="Device"
          accessories={[{ text: hello ? `${hello.device.model} · ${hello.device.chip}` : "unknown" }]}
        />
        <List.Item
          icon={hello?.permissions.accessibility ? Icon.CheckCircle : Icon.ExclamationMark}
          title="Accessibility permission"
          accessories={[
            {
              tag: {
                value: hello?.permissions.accessibility ? "Granted" : "Not granted",
                color: hello?.permissions.accessibility ? Color.Green : Color.Orange,
              },
            },
          ]}
        />
      </List.Section>

      <List.Section title="Sensors">
        {(["imu", "gyro", "lid", "light"] as const).map((sensor) => (
          <List.Item
            key={sensor}
            icon={hello?.sensors[sensor] ? Icon.CheckCircle : Icon.XMarkCircle}
            title={sensor.toUpperCase()}
            accessories={[
              {
                tag: {
                  value: hello?.sensors[sensor] ? "Online" : "Unavailable",
                  color: hello?.sensors[sensor] ? Color.Green : Color.SecondaryText,
                },
              },
            ]}
          />
        ))}
      </List.Section>

      <List.Section title="State">
        <List.Item
          icon={status?.paused ? Icon.Pause : Icon.Play}
          title="Paused"
          accessories={[
            {
              tag: {
                value: status ? (status.paused ? "Paused" : "Running") : "Unknown",
                color: status?.paused ? Color.Orange : Color.Green,
              },
            },
          ]}
        />
        <List.Item
          icon={status?.calibrated ? Icon.CheckCircle : Icon.XMarkCircle}
          title="Calibrated"
          accessories={[
            {
              tag: {
                value: status ? (status.calibrated ? "Yes" : "No") : "Unknown",
                color: status?.calibrated ? Color.Green : Color.SecondaryText,
              },
            },
          ]}
        />
        <List.Item
          icon={Icon.AppWindowGrid3x3}
          title="Calibrated zones"
          subtitle={status?.zones?.join(", ") || "None"}
          accessories={[{ text: `${status?.zones?.length ?? 0}` }]}
        />
        <List.Item icon={Icon.LineChart} title="IMU rate" accessories={[{ text: status ? `${status.imuHz} Hz` : "unknown" }]} />
      </List.Section>

      <List.Section title="Last gestures" subtitle={log.length === 0 ? "Waiting for activity..." : undefined}>
        {log.length === 0 ? (
          <List.Item icon={Icon.Dot} title="No activity yet" subtitle="Tap a zone on the laptop to see it here" />
        ) : (
          log.map((entry, i) => <LogRow key={`${entry.t}-${i}`} entry={entry} />)
        )}
      </List.Section>
    </List>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const time = safeTime(entry.t);
  if (entry.kind === "gesture") {
    const g = entry.message;
    return (
      <List.Item
        icon={Icon.Fingerprint}
        title={gestureLabel(g.gesture)}
        subtitle={g.zone ?? g.zones?.join(" → ") ?? "any zone"}
        accessories={[{ text: `${Math.round(g.confidence * 100)}%` }, { date: new Date(g.t) }]}
      />
    );
  }
  if (entry.kind === "tap") {
    const t = entry.message;
    return (
      <List.Item
        icon={Icon.Circle}
        title="Tap"
        subtitle={t.zone}
        accessories={[{ text: `${Math.round(t.confidence * 100)}%` }]}
      />
    );
  }
  const r = entry.message;
  return <List.Item icon={Icon.MinusCircle} title="Rejected" subtitle={r.reason} accessories={[{ text: time }]} />;
}

function safeTime(t: number): string {
  try {
    return new Date(t).toLocaleTimeString();
  } catch {
    return `${t}`;
  }
}
