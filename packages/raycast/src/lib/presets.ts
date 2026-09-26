import type { Action, GestureKind, Modifier } from "@ghostkeys/sdk";
import { presetsLibraryPath, readJsonIfExists } from "./paths";

export interface Preset {
  id: string;
  name: string;
  description?: string;
  action: Action;
  suggestedGesture?: GestureKind;
  suggestedZone?: string;
  modifiers?: Modifier[];
}

/**
 * Small built-in fallback so "Bind a Preset" is still useful before
 * presets/library.json exists in the repo. Replaced entirely by the file's
 * contents once it shows up.
 */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: "builtin.volume-up",
    name: "Volume up",
    description: "Raise system volume by 6%.",
    action: { kind: "volume", step: 6 },
  },
  {
    id: "builtin.volume-down",
    name: "Volume down",
    description: "Lower system volume by 6%.",
    action: { kind: "volume", step: -6 },
  },
  {
    id: "builtin.mute",
    name: "Toggle mute",
    description: "Mute or unmute system audio.",
    action: { kind: "mute" },
  },
  {
    id: "builtin.media-playpause",
    name: "Play / pause media",
    description: "Toggle playback of whatever's playing.",
    action: { kind: "media", command: "playpause" },
  },
  {
    id: "builtin.media-next",
    name: "Next track",
    action: { kind: "media", command: "next" },
  },
  {
    id: "builtin.brightness-up",
    name: "Brightness up",
    action: { kind: "brightness", step: 8 },
  },
  {
    id: "builtin.lock-screen",
    name: "Lock screen",
    description: "Lock the Mac immediately.",
    action: { kind: "system", op: "lock" },
  },
  {
    id: "builtin.mission-control",
    name: "Mission Control",
    action: { kind: "system", op: "mission-control" },
  },
  {
    id: "builtin.screenshot",
    name: "Screenshot",
    action: { kind: "system", op: "screenshot" },
  },
  {
    id: "builtin.window-maximize",
    name: "Maximize window",
    action: { kind: "window", op: "maximize" },
  },
];

interface RawLibraryFile {
  presets?: unknown;
}

function isActionSpec(value: unknown): value is Action {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

function normalizePreset(raw: unknown, index: number): Preset | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!isActionSpec(obj.action)) return undefined;
  const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : undefined;
  if (!name) return undefined;
  const id = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : `library.${index}`;
  return {
    id,
    name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    action: obj.action,
    suggestedGesture: typeof obj.suggestedGesture === "string" ? (obj.suggestedGesture as GestureKind) : undefined,
    suggestedZone: typeof obj.suggestedZone === "string" ? obj.suggestedZone : undefined,
    modifiers: Array.isArray(obj.modifiers) ? (obj.modifiers as Modifier[]) : undefined,
  };
}

export interface PresetLibraryResult {
  presets: Preset[];
  source: "library" | "builtin";
  path: string;
}

/** Loads presets/library.json from the repo root if present, else the built-in list. */
export function loadPresetLibrary(startDir?: string): PresetLibraryResult {
  const path = presetsLibraryPath(startDir);
  const raw = readJsonIfExists<RawLibraryFile | unknown[]>(path);

  if (raw !== undefined) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.presets) ? raw.presets : undefined;
    if (list) {
      const presets = list.map(normalizePreset).filter((p): p is Preset => p !== undefined);
      if (presets.length > 0) {
        return { presets, source: "library", path };
      }
    }
  }

  return { presets: BUILTIN_PRESETS, source: "builtin", path };
}
