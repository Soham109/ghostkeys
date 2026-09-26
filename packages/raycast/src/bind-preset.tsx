import { randomUUID } from "node:crypto";
import { useEffect, useState } from "react";
import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Form,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { GESTURES, MODIFIERS, type Config, type Modifier } from "@ghostkeys/sdk";
import { describeError, withGhostkeysClient } from "./lib/client";
import { actionSummary, gestureLabel } from "./lib/format";
import { loadPresetLibrary, type Preset } from "./lib/presets";

export default function BindPreset() {
  const { presets, source, path } = loadPresetLibrary();

  return (
    <List navigationTitle="Bind a Preset" searchBarPlaceholder="Search presets...">
      <List.Section
        title={source === "library" ? "Presets" : "Built-in presets"}
        subtitle={source === "library" ? path : `No presets/library.json found — showing built-ins`}
      >
        {presets.map((preset) => (
          <List.Item
            key={preset.id}
            icon={Icon.Wand}
            title={preset.name}
            subtitle={preset.description ?? actionSummary(preset.action)}
            keywords={[preset.action.kind]}
            actions={
              <ActionPanel>
                <Action.Push title="Choose Zone & Gesture" icon={Icon.ArrowRight} target={<BindForm preset={preset} />} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

function BindForm({ preset }: { preset: Preset }) {
  const { pop } = useNavigation();
  const [config, setConfig] = useState<Config | undefined>();
  const [revision, setRevision] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  async function handleSubmit(values: {
    zone: string;
    gesture: string;
    modifiers: string[];
    app: string;
    label: string;
  }) {
    if (!config) return;
    const zone = values.zone === "__any__" ? null : values.zone;
    const confirmed = await confirmAlert({
      title: "Add this binding?",
      message: `${values.label}\n${gestureLabel(values.gesture)} on ${zone ?? "any zone"}${
        values.app && values.app !== "*" ? ` in ${values.app}` : ""
      }`,
      primaryAction: { title: "Add Binding", style: Alert.ActionStyle.Default },
    });
    if (!confirmed) return;

    setIsSubmitting(true);
    try {
      const nextConfig: Config = {
        ...config,
        bindings: [
          ...config.bindings,
          {
            id: randomUUID(),
            enabled: true,
            gesture: values.gesture as Config["bindings"][number]["gesture"],
            zone,
            zones: null,
            modifiers: values.modifiers as Modifier[],
            app: values.app || "*",
            action: preset.action,
            label: values.label || preset.name,
          },
        ],
      };
      await withGhostkeysClient((client) => client.setConfig(nextConfig, { ifRevision: revision }));
      await showToast({ style: Toast.Style.Success, title: "Binding added", message: values.label });
      pop();
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not save binding",
        message: describeError(err),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  if (error) {
    return (
      <Form>
        <Form.Description title="Ghostkeys isn't reachable" text={`${error}\n\nMake sure Ghostkeys.app (or ghostkeysd) is running, then try again.`} />
      </Form>
    );
  }

  const zones = config?.zones ?? [];

  return (
    <Form
      isLoading={isLoading || isSubmitting}
      navigationTitle={`Bind: ${preset.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Binding" icon={Icon.Plus} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description title="Preset" text={`${preset.name}\n${preset.description ?? actionSummary(preset.action)}`} />
      <Form.Dropdown id="zone" title="Zone" defaultValue={preset.suggestedZone ?? "__any__"}>
        <Form.Dropdown.Item value="__any__" title="Any zone" icon={Icon.Circle} />
        {zones.map((zone) => (
          <Form.Dropdown.Item key={zone.id} value={zone.id} title={zone.name} icon={{ source: Icon.Dot, tintColor: zone.color }} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="gesture" title="Gesture" defaultValue={preset.suggestedGesture ?? "tap"}>
        {GESTURES.map((gesture) => (
          <Form.Dropdown.Item key={gesture} value={gesture} title={gestureLabel(gesture)} />
        ))}
      </Form.Dropdown>
      <Form.TagPicker id="modifiers" title="Modifiers" defaultValue={preset.modifiers ?? []}>
        {MODIFIERS.map((modifier) => (
          <Form.TagPicker.Item key={modifier} value={modifier} title={modifier} />
        ))}
      </Form.TagPicker>
      <Form.TextField id="app" title="App" placeholder="* (any app) or a bundle id" defaultValue="*" />
      <Form.TextField id="label" title="Label" defaultValue={preset.name} />
    </Form>
  );
}
