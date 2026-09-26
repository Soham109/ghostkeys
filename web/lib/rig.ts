/**
 * The scroll story's camera path and scene cues, as keyframes on one timeline (0..LENGTH).
 * The table is turned into a Theatre.js project state, so the path can be opened and edited in Theatre Studio;
 * ScrollTrigger scrubs `sequence.position`. If Theatre fails to load, the same table is interpolated locally.
 */

export const LENGTH = 11;

export type RigValues = {
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
  fov: number;
  /** horizontal and vertical framing shift, fraction of the viewport (desktop) */
  sx: number; sy: number;
  hood: number;
  zoneStep: number;
  heat: number;
  layer: number;
  nudge: number;
  cover: number;
  dissolve: number;
};

type Track = [number, number][];

/** Camera shots in timeline units. */
const SHOTS: [number, Partial<RigValues>][] = [
  [0.0, { px: 3.8, py: 2.75, pz: 6.5, tx: 0.0, ty: 0.55, tz: -0.35, fov: 30, sx: 0.17, sy: 0.0 }],
  [0.55, { px: 3.4, py: 2.5, pz: 5.9, tx: 0.0, ty: 0.5, tz: -0.35, fov: 30, sx: 0.15, sy: 0.0 }],
  [1.35, { px: 1.25, py: 0.95, pz: 0.75, tx: 0.42, ty: 0.08, tz: -0.42, fov: 36, sx: 0.14, sy: 0.04 }],
  [2.15, { px: 1.0, py: 0.8, pz: 0.6, tx: 0.42, ty: 0.1, tz: -0.42, fov: 36, sx: 0.14, sy: 0.04 }],
  [2.9, { px: 0.0, py: 5.6, pz: 1.7, tx: 0.0, ty: 0.0, tz: 0.28, fov: 30, sx: 0.08, sy: 0.08 }],
  [3.55, { px: 2.3, py: 0.95, pz: 0.45, tx: 1.36, ty: 0.0, tz: -0.42, fov: 32, sx: 0.08, sy: 0.02 }],
  [4.15, { px: 4.8, py: 0.34, pz: 1.2, tx: 0.0, ty: 0.05, tz: 0.08, fov: 26, sx: 0.04, sy: 0.08 }],
  [4.8, { px: -2.6, py: 2.2, pz: -4.7, tx: 0.0, ty: 0.9, tz: -1.1, fov: 32, sx: 0.1, sy: 0.02 }],
  [5.05, { px: -2.4, py: 2.3, pz: -4.5, tx: 0.0, ty: 0.9, tz: -1.1, fov: 32, sx: 0.1, sy: 0.02 }],
  [5.6, { px: 0.0, py: 6.3, pz: 0.45, tx: 0.0, ty: 0.0, tz: 0.05, fov: 30, sx: 0.12, sy: 0.04 }],
  [6.55, { px: 0.0, py: 6.1, pz: 0.4, tx: 0.0, ty: 0.0, tz: 0.05, fov: 30, sx: 0.12, sy: 0.04 }],
  [7.15, { px: 0.3, py: 2.7, pz: 4.8, tx: 0.0, ty: 0.55, tz: -0.35, fov: 32, sx: 0.15, sy: 0.0 }],
  [8.35, { px: -0.3, py: 2.8, pz: 4.7, tx: 0.0, ty: 0.55, tz: -0.35, fov: 32, sx: 0.15, sy: 0.0 }],
  [9.0, { px: 1.9, py: 2.6, pz: 3.6, tx: 0.1, ty: 1.35, tz: -1.4, fov: 30, sx: 0.16, sy: 0.02 }],
  [9.95, { px: 1.3, py: 2.5, pz: 2.9, tx: 0.1, ty: 1.55, tz: -1.5, fov: 28, sx: 0.16, sy: 0.02 }],
  [11.0, { px: 0.9, py: 2.9, pz: 5.2, tx: 0.0, ty: 0.5, tz: -0.4, fov: 30, sx: 0.0, sy: 0.0 }],
];

const SCALARS: Record<"hood" | "zoneStep" | "heat" | "layer" | "nudge" | "cover" | "dissolve", Track> = {
  hood: [[0.55, 0], [1.25, 1], [2.2, 1], [2.75, 0]],
  zoneStep: [[2.55, 0], [2.95, 1], [3.5, 2], [4.1, 3], [4.7, 4], [5.1, 4], [5.45, 0], [6.9, 0], [7.2, 2], [8.6, 2], [8.9, 0]],
  heat: [[5.45, 0], [6.45, 1], [6.8, 1], [7.05, 0]],
  layer: [[7.15, 0], [8.45, 3.999]],
  nudge: [[9.05, 0], [9.22, 1], [9.4, 0]],
  cover: [[9.5, 0], [9.72, 1], [10.05, 1], [10.2, 0]],
  dissolve: [[10.3, 0], [11.0, 1]],
};

function tracks(): Record<keyof RigValues, Track> {
  const keys: (keyof RigValues)[] = ["px", "py", "pz", "tx", "ty", "tz", "fov", "sx", "sy"];
  const out = {} as Record<keyof RigValues, Track>;
  for (const k of keys) out[k] = SHOTS.filter(([, v]) => v[k] !== undefined).map(([t, v]) => [t, v[k] as number]);
  Object.assign(out, SCALARS);
  return out;
}

export const TRACKS = tracks();

const DEFAULTS: RigValues = Object.fromEntries(Object.entries(TRACKS).map(([k, tr]) => [k, tr[0][1]])) as RigValues;

/** Theatre.js project state built from the table: one object "Rig", one bezier track per prop. */
export function theatreState() {
  const trackData: Record<string, unknown> = {};
  const trackIdByPropPath: Record<string, string> = {};
  let id = 0;
  for (const [prop, tr] of Object.entries(TRACKS)) {
    const trackId = `t_${prop}`;
    trackIdByPropPath[JSON.stringify([prop])] = trackId;
    // camera moves ease in and out; linear for the layer counter so each app gets equal scroll
    const linear = prop === "layer";
    trackData[trackId] = {
      type: "BasicKeyframedTrack",
      __debugName: `Rig:["${prop}"]`,
      keyframes: tr.map(([position, value]) => ({
        id: `k${id++}`,
        position,
        value,
        connectedRight: true,
        handles: linear ? [0.5, 0.5, 0.5, 0.5] : [0.35, 1, 0.65, 0],
        type: "bezier",
      })),
    };
  }
  return {
    sheetsById: {
      Stage: {
        staticOverrides: { byObject: {} },
        sequence: {
          type: "PositionalSequence",
          length: LENGTH,
          subUnitsPerUnit: 30,
          tracksByObject: { Rig: { trackIdByPropPath, trackData } },
        },
      },
    },
    definitionVersion: "0.4.0",
    revisionHistory: ["ghostkeys-rig-1"],
  };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Local interpolation of the same table, used as a fallback and for reduced-motion stills. */
export function sampleLocal(pos: number, out: RigValues = { ...DEFAULTS }): RigValues {
  for (const [prop, tr] of Object.entries(TRACKS) as [keyof RigValues, Track][]) {
    let v = tr[0][1];
    if (pos >= tr[tr.length - 1][0]) v = tr[tr.length - 1][1];
    else
      for (let i = 0; i < tr.length - 1; i++) {
        const [t0, v0] = tr[i];
        const [t1, v1] = tr[i + 1];
        if (pos >= t0 && pos <= t1) {
          const k = (pos - t0) / (t1 - t0 || 1);
          v = v0 + (v1 - v0) * (prop === "layer" ? k : ease(k));
          break;
        }
      }
    out[prop] = v;
  }
  return out;
}

export type Rig = {
  /** current values, updated in place */
  values: RigValues;
  setPosition: (p: number) => void;
  position: () => number;
  source: "theatre" | "local";
};

let rigSingleton: Rig | null = null;

export async function createRig(): Promise<Rig> {
  if (rigSingleton) return rigSingleton;
  const values = sampleLocal(0);
  let pos = 0;
  try {
    const { getProject, types } = await import("@theatre/core");
    const project = getProject("Ghostkeys", { state: theatreState() as never });
    const sheet = project.sheet("Stage");
    const props = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, types.number(DEFAULTS[k as keyof RigValues])]));
    const obj = sheet.object("Rig", props);
    await project.ready;
    obj.onValuesChange((v) => Object.assign(values, v as RigValues));
    rigSingleton = {
      values,
      source: "theatre",
      position: () => pos,
      setPosition: (p) => {
        pos = p;
        sheet.sequence.position = p;
      },
    };
  } catch (e) {
    console.warn("[ghostkeys] Theatre.js unavailable, interpolating locally", e);
    rigSingleton = {
      values,
      source: "local",
      position: () => pos,
      setPosition: (p) => {
        pos = p;
        sampleLocal(p, values);
      },
    };
  }
  return rigSingleton;
}

/** Chapters as timeline ranges; copy and the progress counter read these. */
export const CHAPTERS = [
  { id: "feel", start: 0.6, end: 2.45 },
  { id: "zones", start: 2.45, end: 5.3 },
  { id: "calibrate", start: 5.3, end: 7.0 },
  { id: "layers", start: 7.0, end: 8.75 },
  { id: "beyond", start: 8.75, end: 10.4 },
] as const;
