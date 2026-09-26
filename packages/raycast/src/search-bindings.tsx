import { useEffect, useRef, useState } from "react";
import { Action, ActionPanel, Color, Detail, Icon, List, showToast, Toast } from "@raycast/api";
import type { Binding, Config } from "@ghostkeys/sdk";
import { createGhostkeysClient, describeError, type GhostkeysClient } from "./lib/client";
import { actionSummary, appLabel, gestureLabel, modifiersLabel, zoneLabel } from "./lib/format";

export default function SearchBindings() {
  const [config, setConfig] = useState<Config | undefined>();
  const [revision, setRevision] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | undefined>();
  const clientRef = useRef<GhostkeysClient | null>(null);

  async function load() {
    setIsLoading(true);
    setError(undefined);
    const client = clientRef.current ?? createGhostkeysClient();
    clientRef.current = client;
    try {
      if (!client.connected) await client.connect();
      const { config: cfg, revision: rev } = await client.getConfig();
      setConfig(cfg);
      setRevision(rev);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleEnabled(binding: Binding) {
    if (!config || !clientRef.current) return;
    setBusyId(binding.id);
    const nextConfig: Config = {
      ...config,
      bindings: config.bindings.map((b) => (b.id === binding.id ? { ...b, enabled: !b.enabled } : b)),
    };
    try {
      const { config: saved, revision: rev } = await clientRef.current.setConfig(nextConfig, { ifRevision: revision });
      setConfig(saved);
      setRevision(rev);
      await showToast({
        style: Toast.Style.Success,
        title: binding.enabled ? "Binding disabled" : "Binding enabled",
        message: binding.label ?? undefined,
      });
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: "Could not update binding", message: describeError(err) });
      // The config may have changed elsewhere since we last read it (that's
      // what ConfigConflictError means); re-fetch so the list reflects reality.
      await load();
    } finally {
      setBusyId(undefined);
    }
  }

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

  const bindings = config?.bindings ?? [];

  return (
    <List isLoading={isLoading} navigationTitle="Search Bindings" searchBarPlaceholder="Search by gesture, zone, app, or action...">
      {bindings.length === 0 && !isLoading ? (
        <List.EmptyView icon={Icon.Dot} title="No bindings yet" description="Use “Bind a Preset” to add one." />
      ) : (
        bindings.map((binding) => (
          <List.Item
            key={binding.id}
            icon={binding.enabled ? Icon.CheckCircle : Icon.Circle}
            title={binding.label || actionSummary(binding.action)}
            subtitle={`${gestureLabel(binding.gesture)}${modifiersLabel(binding.modifiers) ? " " + modifiersLabel(binding.modifiers) : ""} · ${zoneLabel(binding)}`}
            keywords={[binding.gesture, zoneLabel(binding), binding.app, binding.action.kind, binding.label ?? ""]}
            accessories={[
              { tag: appLabel(binding.app) },
              {
                tag: {
                  value: busyId === binding.id ? "Updating..." : binding.enabled ? "Enabled" : "Disabled",
                  color: binding.enabled ? Color.Green : Color.SecondaryText,
                },
              },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={binding.enabled ? "Disable" : "Enable"}
                  icon={binding.enabled ? Icon.XMarkCircle : Icon.CheckCircle}
                  onAction={() => toggleEnabled(binding)}
                />
                <Action.Push
                  title="Test Action (Dry)"
                  icon={Icon.Eye}
                  target={<DryTestPreview binding={binding} />}
                />
                <Action.CopyToClipboard
                  title="Copy JSON"
                  icon={Icon.Clipboard}
                  content={JSON.stringify(binding, null, 2)}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
                <Action
                  title="Reload"
                  icon={Icon.RotateClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={load}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

function DryTestPreview({ binding }: { binding: Binding }) {
  const markdown = [
    `# ${binding.label || "Untitled binding"}`,
    "",
    "**This is a dry run.** Nothing was sent to the Ghostkeys daemon and no action ran.",
    "",
    `**Would do:** ${actionSummary(binding.action)}`,
    "",
    "```json",
    JSON.stringify(binding.action, null, 2),
    "```",
  ].join("\n");

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`Dry run · ${binding.label ?? "binding"}`}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Action JSON" content={JSON.stringify(binding.action, null, 2)} />
        </ActionPanel>
      }
    />
  );
}
