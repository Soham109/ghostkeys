import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Zone } from "@ghostkeys/sdk";
import { layoutsDirPath, readJsonIfExists } from "./paths";

export interface Layout {
  id: string;
  name: string;
  description?: string;
  zones: Zone[];
  path: string;
}

function isZone(value: unknown): value is Zone {
  if (typeof value !== "object" || value === null) return false;
  const z = value as Record<string, unknown>;
  return (
    typeof z.id === "string" &&
    typeof z.name === "string" &&
    typeof z.surface === "string" &&
    typeof z.rect === "object" &&
    z.rect !== null
  );
}

function normalizeLayout(raw: unknown, fileName: string, path: string): Layout | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const zones = Array.isArray(obj.zones) ? obj.zones.filter(isZone) : undefined;
  if (!zones || zones.length === 0) return undefined;
  const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : fileName.replace(/\.json$/, "");
  return {
    id: fileName,
    name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    zones,
    path,
  };
}

/** Reads every *.json file in presets/layouts/ (if the directory exists) into a Layout. */
export function loadLayouts(startDir?: string): Layout[] {
  const dir = layoutsDirPath(startDir);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const layouts: Layout[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const raw = readJsonIfExists<unknown>(path);
    if (raw === undefined) continue;
    const layout = normalizeLayout(raw, file, path);
    if (layout) layouts.push(layout);
  }
  return layouts;
}

export interface ZoneDiff {
  added: Zone[];
  removed: Zone[];
  changed: { before: Zone; after: Zone }[];
  unchanged: Zone[];
}

function zoneBodyEqual(a: Zone, b: Zone): boolean {
  return (
    a.name === b.name &&
    a.surface === b.surface &&
    a.color === b.color &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.w === b.rect.w &&
    a.rect.h === b.rect.h
  );
}

/** Diffs the currently active zones against a layout's proposed zones, keyed by zone id. */
export function diffZones(current: Zone[], incoming: Zone[]): ZoneDiff {
  const currentById = new Map(current.map((z) => [z.id, z]));
  const incomingById = new Map(incoming.map((z) => [z.id, z]));

  const added: Zone[] = [];
  const changed: { before: Zone; after: Zone }[] = [];
  const unchanged: Zone[] = [];

  for (const [id, after] of incomingById) {
    const before = currentById.get(id);
    if (!before) {
      added.push(after);
    } else if (!zoneBodyEqual(before, after)) {
      changed.push({ before, after });
    } else {
      unchanged.push(after);
    }
  }

  const removed: Zone[] = [];
  for (const [id, before] of currentById) {
    if (!incomingById.has(id)) removed.push(before);
  }

  return { added, removed, changed, unchanged };
}
