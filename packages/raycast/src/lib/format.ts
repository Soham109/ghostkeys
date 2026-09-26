import type { Action, Binding, GestureKind, Modifier } from "@ghostkeys/sdk";

/**
 * What actually comes over the wire: a known Action, or a shape the daemon
 * added after this file was written. Kept separate from Action so switch
 * statements over Action['kind'] stay exhaustive and narrow properly (a
 * `kind: string` catch-all member in the union would defeat discriminated
 * narrowing).
 */
type AnyAction = Action | { kind: string; [key: string]: unknown };

const GESTURE_LABELS: Record<GestureKind, string> = {
  tap: "Tap",
  double: "Double tap",
  triple: "Triple tap",
  sequence: "Sequence",
  rhythm: "Rhythm",
  lid_nudge: "Lid nudge",
  cover: "Cover",
  cover_hold: "Cover & hold",
  tilt_left: "Tilt left",
  tilt_right: "Tilt right",
};

export function gestureLabel(gesture: string): string {
  return GESTURE_LABELS[gesture as GestureKind] ?? gesture;
}

const MODIFIER_SYMBOLS: Record<Modifier, string> = {
  shift: "⇧",
  control: "⌃",
  option: "⌥",
  command: "⌘",
  fn: "fn",
};

export function modifiersLabel(modifiers: Modifier[] | undefined | null): string {
  if (!modifiers || modifiers.length === 0) return "";
  return modifiers.map((m) => MODIFIER_SYMBOLS[m] ?? m).join("");
}

export function zoneLabel(binding: Pick<Binding, "zone" | "zones">): string {
  if (binding.zones && binding.zones.length > 0) return binding.zones.join(" → ");
  if (binding.zone) return binding.zone;
  return "any zone";
}

export function appLabel(app: string | undefined | null): string {
  if (!app || app === "*") return "Any app";
  return app;
}

/** One-line human summary of what an action does, for list subtitles and dry-run previews. */
export function actionSummary(action: AnyAction): string {
  // Narrow against the strict, known-kind union so the switch below stays
  // exhaustive and discriminates properly. `action.kind` (from the loose
  // AnyAction) is still what the default branch reports for anything outside
  // that union, so unrecognized kinds degrade gracefully instead of throwing.
  const known = action as Action;
  switch (known.kind) {
    case "keystroke":
      return `Press ${modifiersLabel(known.modifiers)}${known.key}`;
    case "volume":
      return `Volume ${known.step >= 0 ? "+" : ""}${known.step}%`;
    case "mute":
      return "Toggle mute";
    case "media":
      return `Media: ${known.command}`;
    case "brightness":
      return `Brightness ${known.step >= 0 ? "+" : ""}${known.step}%`;
    case "open":
      return `Open ${known.target}`;
    case "shell":
      return `Run: ${known.command}`;
    case "applescript":
      return "Run AppleScript";
    case "shortcut":
      return `Shortcut: ${known.name}`;
    case "text":
      return `Type text (${known.text.length} chars)`;
    case "macro":
      return `Macro (${known.steps.length} steps)`;
    case "clipboard":
      return "Copy to clipboard";
    case "window":
      return `Window: ${known.op}`;
    case "app":
      return `App: ${known.op}`;
    case "integration":
      return `${known.app}: ${known.command}`;
    case "system":
      return `System: ${known.op}`;
    default:
      return action.kind;
  }
}

/** Actions that would do something destructive/irreversible if actually run. */
export function isDestructiveAction(action: AnyAction): boolean {
  return (action.kind === "app" && action.op === "quit") || action.kind === "shell" || action.kind === "applescript";
}
