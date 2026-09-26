/**
 * The film, as keyframes on one page-long axis.
 *
 * `g` is the sum of every chapter's scroll progress in CHAPTER_ORDER (chapter k spans [k, k + 1]), so a key is
 * authored as (chapter id, local progress). Keys for chapters that no longer exist are dropped, so the site can add,
 * remove or reorder chapters without breaking the camera.
 *
 * Every channel is interpolated with a monotone cubic (Fritsch-Carlson): velocity is continuous through each key
 * (no stop-and-go at keyframes), holds stay perfectly still, and nothing overshoots.
 */
import { CHAPTER_ORDER, type ChapterId } from "@/lib/chapters";

export type Channels = {
  /** camera position and look-at target */
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
  fov: number;
  /** framing shift, fraction of the viewport (positive x moves the subject right, positive y moves it up) */
  sx: number; sy: number;
  /** 0..1 depth of field shallowness */
  bokeh: number;
  /** 0..1 x-ray of the shell */
  xray: number;
  /** lid angle in degrees */
  lid: number;
  /** roll of the laptop, degrees */
  tilt: number;
  /** 0..1 everything goes quiet (glows fade, the frame darkens) */
  hush: number;
  /** display brightness 0..1 */
  screen: number;
  /** keyboard backlight 0..1 */
  backlight: number;
  /** 0..1 all zones outlined (the try chapter) */
  zonesAll: number;
  /** 0..1 camera distance multiplier offset (1 = authored) */
  dolly: number;
};

type Key = [ChapterId | string, number, Partial<Channels>];

const HERO = { px: 3.55, py: 2.45, pz: 6.1, tx: -0.05, ty: 0.42, tz: -0.35, fov: 30, sx: 0.16, sy: 0.12 };

/** The whole landing. Local progress runs 0..1 inside each chapter. */
const KEYS: Key[] = [
  // intro: hero three-quarter, text bottom left so the laptop sits upper right; a slow push as the hook scrolls away
  ["intro", 0, { ...HERO, bokeh: 0.15, xray: 0, lid: 108, tilt: 0, hush: 0, screen: 1, backlight: 0.9, zonesAll: 0, dolly: 1 }],
  ["intro", 1, { px: 3.0, py: 2.6, pz: 5.0, tx: 0.0, ty: 0.3, tz: -0.25, fov: 30, sx: 0.1, sy: 0.02 }],

  // zones, step 1 (palm rests): steep three-quarter over the deck, the shell turns to glass so the tap can be seen
  // travelling to the motion sensor under the keyboard
  ["zones", 0.1, { px: 1.15, py: 4.6, pz: 3.3, tx: 0.1, ty: -0.05, tz: 0.05, fov: 32, sx: 0.12, sy: -0.06, bokeh: 0.35 }],
  ["zones", 0.05, { xray: 0 }],
  ["zones", 0.1, { xray: 1 }],
  ["zones", 0.19, { px: 0.85, py: 4.3, pz: 3.0, tx: 0.1, ty: -0.05, tz: 0.0, xray: 1 }],
  ["zones", 0.24, { xray: 0 }],
  // step 2 (speaker grilles): low and close along the right grille
  ["zones", 0.3, { px: 2.35, py: 0.9, pz: 0.75, tx: 1.3, ty: 0.0, tz: -0.42, fov: 34, sx: 0.06, sy: -0.08, bokeh: 0.6 }],
  ["zones", 0.38, { px: 2.2, py: 0.95, pz: 0.35, tx: 1.32, ty: 0.0, tz: -0.5 }],
  // step 3 (top strip): over the keyboard looking back toward the hinge
  ["zones", 0.5, { px: -0.35, py: 1.85, pz: 1.35, tx: 0.0, ty: 0.02, tz: -0.9, fov: 32, sx: 0.04, sy: -0.1, bokeh: 0.55 }],
  ["zones", 0.58, { px: 0.25, py: 1.8, pz: 1.3, tx: 0.05, ty: 0.02, tz: -0.9 }],
  // step 4 (edges): a machined profile, almost level with the deck
  ["zones", 0.7, { px: 4.6, py: 0.3, pz: 1.35, tx: 0.2, ty: 0.02, tz: 0.1, fov: 26, sx: 0.02, sy: -0.12, bokeh: 0.5, tilt: 0 }],
  ["zones", 0.78, { px: 4.5, py: 0.34, pz: 0.9, tx: 0.2, ty: 0.02, tz: 0.05 }],
  // step 5 (lid): from behind and above, the lid's back is the key; a small nudge on the lid
  ["zones", 0.9, { px: -2.7, py: 2.4, pz: -4.3, tx: 0.0, ty: 0.85, tz: -1.05, fov: 32, sx: 0.08, sy: -0.06, bokeh: 0.3, lid: 108 }],
  ["zones", 0.94, { lid: 101 }],
  ["zones", 0.97, { lid: 108 }],
  ["zones", 1.0, { px: -2.2, py: 2.6, pz: -3.6, tx: 0.0, ty: 0.8, tz: -1.0 }],

  // air: the hand works above the keys in front of the notch camera; frame from the front, a little high
  ["air", 0.08, { px: 0.9, py: 2.05, pz: 4.4, tx: 0.0, ty: 0.62, tz: -0.4, fov: 30, sx: 0.12, sy: -0.1, bokeh: 0.2 }],
  ["air", 0.52, { px: 0.45, py: 1.95, pz: 4.1, tx: 0.0, ty: 0.6, tz: -0.45, fov: 30 }],
  // sound: low across the deck so the air waves read against the dark
  ["air", 0.66, { px: 2.9, py: 1.05, pz: 3.0, tx: 0.15, ty: 0.22, tz: -0.25, fov: 32, sx: 0.08, sy: -0.1, bokeh: 0.3 }],
  ["air", 0.98, { px: 2.5, py: 1.1, pz: 3.1, tx: 0.1, ty: 0.22, tz: -0.3 }],

  // layers: the screen is the subject; text bottom left, laptop up and right
  ["layers", 0.12, { px: 0.55, py: 2.5, pz: 4.7, tx: 0.0, ty: 0.75, tz: -0.6, fov: 29, sx: 0.12, sy: 0.12, bokeh: 0.25 }],
  ["layers", 0.9, { px: -0.35, py: 2.6, pz: 4.5, tx: 0.0, ty: 0.75, tz: -0.6 }],

  // try: a high, clear view of every zone so they are easy to click
  ["try", 0.15, { px: 0.0, py: 4.1, pz: 3.9, tx: 0.0, ty: -0.05, tz: 0.12, fov: 31, sx: 0.12, sy: -0.04, bokeh: 0.0, zonesAll: 1 }],
  ["try", 0.85, { px: 0.1, py: 4.1, pz: 3.85, zonesAll: 1 }],

  // finale: low and close from the front; the lid closes, the screen's light fades with it, everything hushes
  ["finale", 0.0, { zonesAll: 0 }],
  ["finale", 0.15, { px: 2.3, py: 1.25, pz: 4.4, tx: 0.0, ty: 0.3, tz: -0.25, fov: 30, sx: 0.1, sy: 0.08, lid: 108, screen: 1, hush: 0, bokeh: 0.3 }],
  ["finale", 0.85, { px: 1.7, py: 0.95, pz: 3.6, tx: 0.0, ty: 0.12, tz: -0.1, lid: 0, screen: 0, hush: 0.55, backlight: 0.15 }],
  ["finale", 1.0, { px: 1.6, py: 0.9, pz: 3.45 }],
];

type Track = { g: Float64Array; v: Float64Array; m: Float64Array };

function monotone(g: number[], v: number[]): Track {
  const n = g.length;
  const d = new Float64Array(Math.max(1, n - 1));
  for (let i = 0; i < n - 1; i++) d[i] = (v[i + 1] - v[i]) / Math.max(1e-6, g[i + 1] - g[i]);
  const m = new Float64Array(n);
  if (n > 1) {
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
    // ease out of the first key and into the last one
    m[0] = 0;
    m[n - 1] = 0;
  }
  return { g: Float64Array.from(g), v: Float64Array.from(v), m };
}

function evalTrack(t: Track, x: number) {
  const { g, v, m } = t;
  const n = g.length;
  if (x <= g[0]) return v[0];
  if (x >= g[n - 1]) return v[n - 1];
  let i = 0;
  while (i < n - 2 && x > g[i + 1]) i++;
  const h = g[i + 1] - g[i];
  const s = (x - g[i]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v[i] + (s3 - 2 * s2 + s) * h * m[i] + (-2 * s3 + 3 * s2) * v[i + 1] + (s3 - s2) * h * m[i + 1];
}

const DEFAULTS: Channels = {
  ...HERO,
  bokeh: 0,
  xray: 0,
  lid: 108,
  tilt: 0,
  hush: 0,
  screen: 1,
  backlight: 0.9,
  zonesAll: 0,
  dolly: 1,
};

export function buildFilm(order: readonly string[] = CHAPTER_ORDER) {
  const index = new Map(order.map((id, i) => [id, i]));
  const byChannel = new Map<keyof Channels, [number, number][]>();
  for (const [id, p, vals] of KEYS) {
    const k = index.get(id);
    if (k === undefined) continue;
    for (const [ch, val] of Object.entries(vals) as [keyof Channels, number][]) {
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch)!.push([k + p, val]);
    }
  }
  const tracks = new Map<keyof Channels, Track>();
  for (const [ch, pts] of byChannel) {
    pts.sort((a, b) => a[0] - b[0]);
    // identical positions: the later key wins
    const dedup: [number, number][] = [];
    for (const p of pts) {
      if (dedup.length && Math.abs(dedup[dedup.length - 1][0] - p[0]) < 1e-6) dedup[dedup.length - 1] = p;
      else dedup.push(p);
    }
    tracks.set(ch, monotone(dedup.map((p) => p[0]), dedup.map((p) => p[1])));
  }
  return {
    order,
    index,
    sample(g: number, out: Channels = { ...DEFAULTS }): Channels {
      for (const key of Object.keys(DEFAULTS) as (keyof Channels)[]) {
        const t = tracks.get(key);
        out[key] = t ? evalTrack(t, g) : DEFAULTS[key];
      }
      return out;
    },
    /** page position from per-chapter progress */
    position(chapters: Partial<Record<string, number>>) {
      let g = 0;
      for (const id of order) g += Math.min(1, Math.max(0, chapters[id] ?? 0));
      return g;
    },
  };
}

export type Film = ReturnType<typeof buildFilm>;
export const makeChannels = (): Channels => ({ ...DEFAULTS });
