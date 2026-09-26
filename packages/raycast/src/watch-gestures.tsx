import { useEffect, useRef, useState } from "react";
import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import type { ActionMsg, GestureMsg, RejectedMsg, TapMsg } from "@ghostkeys/sdk";
import { createGhostkeysClient, describeError } from "./lib/client";
import { gestureLabel, modifiersLabel } from "./lib/format";

type Entry =
  | { id: string; kind: "gesture"; msg: GestureMsg }
  | { id: string; kind: "tap"; msg: TapMsg }
  | { id: string; kind: "rejected"; msg: RejectedMsg }
  | { id: string; kind: "action"; msg: ActionMsg };

const MAX_ENTRIES = 300;

export default function WatchGestures() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const counterRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const client = createGhostkeysClient();

    function push(entry: Omit<Entry, "id">) {
      if (cancelled || pausedRef.current) return;
      counterRef.current += 1;
      setEntries((prev) => [{ ...entry, id: `${counterRef.current}` } as Entry, ...prev].slice(0, MAX_ENTRIES));
    }

    const offGesture = client.on("gesture", (msg) => push({ kind: "gesture", msg }));
    const offTap = client.on("tap", (msg) => push({ kind: "tap", msg }));
    const offRejected = client.on("rejected", (msg) => push({ kind: "rejected", msg }));
    const offAction = client.on("action", (msg) => push({ kind: "action", msg }));

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
      offGesture();
      offTap();
      offRejected();
      offAction();
      if (client.connected) {
        try {
          client.unsubscribe(["taps"]);
        } catch {
          // socket already going away; nothing to clean up
        }
      }
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
    <List
      isLoading={isLoading}
      navigationTitle={`Watch Gestures${paused ? " (paused)" : ""}`}
      searchBarPlaceholder="Filter by zone, gesture, or reason..."
    >
      {entries.length === 0 ? (
        <List.EmptyView
          icon={Icon.Eye}
          title={paused ? "Watching paused" : "Listening..."}
          description="Tap, gesture, or trigger a rejection on the laptop to see it appear here live."
        />
      ) : (
        entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} paused={paused} onTogglePause={() => setPaused((p) => !p)} />
        ))
      )}
    </List>
  );
}

function EntryRow({ entry, paused, onTogglePause }: { entry: Entry; paused: boolean; onTogglePause: () => void }) {
  const actions = (
    <ActionPanel>
      <Action title={paused ? "Resume Watching" : "Pause Watching"} icon={paused ? Icon.Play : Icon.Pause} onAction={onTogglePause} />
      <Action.CopyToClipboard title="Copy JSON" icon={Icon.Clipboard} content={JSON.stringify(entry.msg, null, 2)} />
    </ActionPanel>
  );

  const time = safeTime(entry.msg.t);

  if (entry.kind === "gesture") {
    const g = entry.msg;
    return (
      <List.Item
        icon={{ source: Icon.Fingerprint, tintColor: Color.Purple }}
        title={gestureLabel(g.gesture)}
        subtitle={`${g.zone ?? g.zones?.join(" → ") ?? "any zone"}${modifiersLabel(g.modifiers) ? " " + modifiersLabel(g.modifiers) : ""}`}
        keywords={[g.gesture, g.zone ?? "", g.app ?? ""]}
        accessories={[{ text: g.app ?? "any app" }, { text: `${Math.round(g.confidence * 100)}%` }, { text: time }]}
        actions={actions}
      />
    );
  }
  if (entry.kind === "tap") {
    const t = entry.msg;
    return (
      <List.Item
        icon={{ source: Icon.Circle, tintColor: Color.Blue }}
        title="Tap"
        subtitle={t.zone}
        keywords={[t.zone, "tap"]}
        accessories={[{ text: `${Math.round(t.confidence * 100)}%` }, { text: time }]}
        actions={actions}
      />
    );
  }
  if (entry.kind === "action") {
    const a = entry.msg;
    return (
      <List.Item
        icon={{ source: a.ok ? Icon.CheckCircle : Icon.XMarkCircle, tintColor: a.ok ? Color.Green : Color.Red }}
        title={a.label}
        subtitle={a.ok ? "Ran" : a.error ?? "Failed"}
        keywords={["action", a.label]}
        accessories={[{ text: time }]}
        actions={actions}
      />
    );
  }
  const r = entry.msg;
  return (
    <List.Item
      icon={{ source: Icon.MinusCircle, tintColor: Color.SecondaryText }}
      title="Rejected"
      subtitle={r.reason}
      keywords={["rejected", r.reason]}
      accessories={[{ text: time }]}
      actions={actions}
    />
  );
}

function safeTime(t: number): string {
  try {
    return new Date(t).toLocaleTimeString();
  } catch {
    return `${t}`;
  }
}
