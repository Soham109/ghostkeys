import { useEffect, useState } from "react";
import { Action, ActionPanel, Alert, confirmAlert, Detail, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import type { Config } from "@ghostkeys/sdk";
import { describeError, withGhostkeysClient } from "./lib/client";
import { diffZones, loadLayouts, type Layout } from "./lib/layouts";

export default function ApplyLayout() {
  const layouts = loadLayouts();

  if (layouts.length === 0) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.AppWindowGrid3x3}
          title="No layouts found"
          description={"Add a *.json file to presets/layouts/ with { \"name\": ..., \"zones\": [...] } to use this command."}
        />
      </List>
    );
  }

  return (
    <List navigationTitle="Apply Layout" searchBarPlaceholder="Search layouts...">
      {layouts.map((layout) => (
        <List.Item
          key={layout.id}
          icon={Icon.AppWindowGrid3x3}
          title={layout.name}
          subtitle={layout.description}
          accessories={[{ text: `${layout.zones.length} zone${layout.zones.length === 1 ? "" : "s"}` }]}
          actions={
            <ActionPanel>
              <Action.Push title="Preview Diff" icon={Icon.ArrowRight} target={<DiffView layout={layout} />} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function DiffView({ layout }: { layout: Layout }) {
  const { pop } = useNavigation();
  const [config, setConfig] = useState<Config | undefined>();
  const [revision, setRevision] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { config: cfg, revision: rev } = await withGhostkeysClient((client) => client.getConfig());
        setConfig(cfg);
        setRevision(rev);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  if (error) {
    return <Detail markdown={`# Ghostkeys isn't reachable\n\n${error}\n\nMake sure Ghostkeys.app (or ghostkeysd) is running.`} />;
  }

  if (isLoading || !config) {
    return <Detail isLoading markdown="Loading current zones from the daemon..." />;
  }

  const diff = diffZones(config.zones, layout.zones);
  const removedIds = new Set(diff.removed.map((z) => z.id));
  const orphanedBindings = config.bindings.filter(
    (b) => (b.zone && removedIds.has(b.zone)) || (b.zones ?? []).some((z) => removedIds.has(z)),
  );

  const markdown = buildDiffMarkdown(layout, diff, orphanedBindings.length);

  async function apply() {
    if (!config) return;
    const confirmed = await confirmAlert({
      title: `Apply “${layout.name}”?`,
      message: `${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed.${
        orphanedBindings.length > 0 ? ` ${orphanedBindings.length} existing binding(s) reference a removed zone.` : ""
      }`,
      primaryAction: { title: "Apply Layout", style: Alert.ActionStyle.Default },
    });
    if (!confirmed) return;

    setIsApplying(true);
    try {
      const nextConfig: Config = { ...config, zones: layout.zones };
      await withGhostkeysClient((client) => client.setConfig(nextConfig, { ifRevision: revision }));
      await showToast({ style: Toast.Style.Success, title: "Layout applied", message: layout.name });
      pop();
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not apply layout",
        message: describeError(err),
      });
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <Detail
      isLoading={isApplying}
      markdown={markdown}
      navigationTitle={`Diff · ${layout.name}`}
      actions={
        <ActionPanel>
          <Action title="Apply Layout" icon={Icon.Checkmark} onAction={apply} />
        </ActionPanel>
      }
    />
  );
}

function buildDiffMarkdown(
  layout: Layout,
  diff: ReturnType<typeof diffZones>,
  orphanedCount: number,
): string {
  const lines: string[] = [`# Apply “${layout.name}”`];
  if (layout.description) lines.push("", layout.description);
  lines.push("", `${diff.added.length} added · ${diff.changed.length} changed · ${diff.removed.length} removed · ${diff.unchanged.length} unchanged`);

  if (diff.added.length > 0) {
    lines.push("", "## Added", "", "| Zone | Surface | Color |", "| --- | --- | --- |");
    for (const z of diff.added) lines.push(`| ${z.name} (\`${z.id}\`) | ${z.surface} | ${z.color} |`);
  }

  if (diff.changed.length > 0) {
    lines.push("", "## Changed", "", "| Zone | Before | After |", "| --- | --- | --- |");
    for (const { before, after } of diff.changed) {
      lines.push(
        `| \`${after.id}\` | ${before.surface}, ${rectStr(before.rect)}, ${before.color} | ${after.surface}, ${rectStr(after.rect)}, ${after.color} |`,
      );
    }
  }

  if (diff.removed.length > 0) {
    lines.push("", "## Removed", "", "| Zone | Surface |", "| --- | --- |");
    for (const z of diff.removed) lines.push(`| ${z.name} (\`${z.id}\`) | ${z.surface} |`);
  }

  if (orphanedCount > 0) {
    lines.push(
      "",
      "## Warning",
      "",
      `${orphanedCount} existing binding(s) target a zone this layout removes. They won't be deleted, but they'll stop matching until re-pointed at a zone in the new layout.`,
    );
  }

  if (diff.unchanged.length > 0) {
    lines.push("", `_${diff.unchanged.length} zone(s) unchanged._`);
  }

  return lines.join("\n");
}

function rectStr(rect: { x: number; y: number; w: number; h: number }): string {
  return `${rect.x.toFixed(2)},${rect.y.toFixed(2)} ${rect.w.toFixed(2)}×${rect.h.toFixed(2)}`;
}
