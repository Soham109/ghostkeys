// Shared by the video and scripts/make-audio.ts. Pure data, no imports.
// 120 BPM at 30 fps: one beat = 15 frames, one bar = 60 frames. Cuts land on beats.
export const FPS = 30;
export const BPM = 120;
export const BEAT = 15;
export const BAR = 60;

export type V3 = [number, number, number];
export type ZoneId = "palmL" | "palmR" | "grilleL" | "grilleR" | "top" | "edgeL" | "edgeR" | "lid" | "sensor";

// Laptop coordinates: deck top at y=0, hinge at z=-10.6, front edge at z=+10.6, width 30.4.
export const LID_ANGLE = 1.86; // radians open (about 107 degrees)
const lidPoint = (x: number, y: number, z: number): V3 => {
  // lid local: hinge at origin, closed along +z; rotation about x by -LID_ANGLE
  const a = -LID_ANGLE;
  return [x, 0.1 + y * Math.cos(a) - z * Math.sin(a), -10.6 + y * Math.sin(a) + z * Math.cos(a)];
};

export const ZONES: Record<ZoneId, { p: V3; name: string; deck?: [number, number] }> = {
  palmL: { p: [-9.6, 0, 6.2], name: "Left palm", deck: [-9.6, 6.2] },
  palmR: { p: [9.6, 0, 6.2], name: "Right palm", deck: [9.6, 6.2] },
  grilleL: { p: [-13.75, 0, -4.4], name: "Left grille", deck: [-13.75, -4.4] },
  grilleR: { p: [13.75, 0, -4.4], name: "Right grille", deck: [13.75, -4.4] },
  top: { p: [0, 0, -9.8], name: "Top strip", deck: [0, -9.8] },
  edgeL: { p: [-15.2, -0.5, 2.5], name: "Left edge", deck: [-14.6, 2.5] },
  edgeR: { p: [15.2, -0.5, 2.5], name: "Right edge", deck: [14.6, 2.5] },
  lid: { p: lidPoint(0, 0.5, 19.0), name: "Lid" },
  sensor: { p: lidPoint(1.6, -0.02, 20.35), name: "Light sensor" },
};
export const lidPointWorld = lidPoint;

// Deck rectangles used by the zone glow + heat map (cx, cz, halfW, halfD).
export const ZONE_RECTS: Array<{ id: ZoneId; r: [number, number, number, number] }> = [
  { id: "palmL", r: [-10.9, 6.0, 4.0, 3.9] },
  { id: "palmR", r: [10.9, 6.0, 4.0, 3.9] },
  { id: "grilleL", r: [-13.75, -4.4, 0.75, 4.8] },
  { id: "grilleR", r: [13.75, -4.4, 0.75, 4.8] },
  { id: "top", r: [0, -9.8, 12.6, 0.55] },
  { id: "edgeL", r: [-14.55, 6.0, 0.35, 3.9] },
  { id: "edgeR", r: [14.55, 6.0, 0.35, 3.9] },
];

export type Tap = { f: number; zone: ZoneId; action: string; gesture?: string; quiet?: boolean };

// ---- The 70 s film -------------------------------------------------------
export const FILM_LEN = 2100;
export const S = {
  open: 0, // cold open: dot, tap, particles -> logo -> laptop
  headline: 240,
  macro: 360, // tap montage
  heroType: 780,
  xray: 900,
  zones: 1200,
  features: 1560,
  hero: 1860,
  end: 1950,
};

export const FILM_TAPS: Tap[] = [
  { f: 375, zone: "palmL", action: "Volume +6", gesture: "Tap" },
  { f: 435, zone: "grilleR", action: "Next track", gesture: "Double tap" },
  { f: 442, zone: "grilleR", action: "Next track", gesture: "Double tap", quiet: true },
  { f: 495, zone: "top", action: "Paste values", gesture: "Tap" },
  { f: 555, zone: "edgeL", action: "Snap left", gesture: "Knock" },
  { f: 615, zone: "sensor", action: "Do not disturb", gesture: "Cover" },
  // speed-ramped orbit: one tap per beat
  { f: 675, zone: "palmR", action: "Play / pause", gesture: "Tap" },
  { f: 690, zone: "grilleL", action: "Mute", gesture: "Tap" },
  { f: 705, zone: "top", action: "Mission control", gesture: "Tap" },
  { f: 720, zone: "edgeR", action: "Snap right", gesture: "Knock" },
  { f: 735, zone: "palmL", action: "Undo", gesture: "Tap" },
  { f: 750, zone: "grilleR", action: "Brightness +", gesture: "Tap" },
  { f: 765, zone: "palmR", action: "Screenshot", gesture: "Triple" },
  { f: 840, zone: "palmR", action: "Next tab", gesture: "Tap" },
  // x-ray: taps seen from inside
  { f: 1005, zone: "palmL", action: "Volume +6", quiet: false },
  { f: 1065, zone: "grilleR", action: "Next track" },
  { f: 1095, zone: "top", action: "Paste values" },
  { f: 1125, zone: "palmR", action: "Play / pause" },
  // zones light up (top-down)
  { f: 1215, zone: "palmL", action: "Zone 01" , quiet: true },
  { f: 1230, zone: "palmR", action: "Zone 02", quiet: true },
  { f: 1245, zone: "grilleL", action: "Zone 03", quiet: true },
  { f: 1260, zone: "grilleR", action: "Zone 04", quiet: true },
  { f: 1275, zone: "top", action: "Zone 05", quiet: true },
  { f: 1290, zone: "edgeL", action: "Zone 06", quiet: true },
  { f: 1305, zone: "edgeR", action: "Zone 07", quiet: true },
  // hero
  { f: 1905, zone: "palmR", action: "Ready", gesture: "Tap" },
];

// Per-app layers (neutral glyphs, no product names or logos).
export const LAYERS: Array<{ name: string; glyph: "grid" | "wave" | "brackets" | "globe"; map: Partial<Record<ZoneId, string>> }> = [
  { name: "Spreadsheet", glyph: "grid", map: { palmL: "Paste values", palmR: "Sum column", top: "Freeze row", grilleL: "Prev sheet", grilleR: "Next sheet", edgeL: "Undo", edgeR: "Redo" } },
  { name: "Music", glyph: "wave", map: { palmL: "Volume −", palmR: "Volume +", top: "Play / pause", grilleL: "Prev track", grilleR: "Next track", edgeL: "Like", edgeR: "Shuffle" } },
  { name: "Code editor", glyph: "brackets", map: { palmL: "Run tests", palmR: "Go to def", top: "Command bar", grilleL: "Prev error", grilleR: "Next error", edgeL: "Fold", edgeR: "Format" } },
  { name: "Browser", glyph: "globe", map: { palmL: "Back", palmR: "Forward", top: "New tab", grilleL: "Prev tab", grilleR: "Next tab", edgeL: "Snap left", edgeR: "Snap right" } },
];
export const LAYER_START = 1410;
export const LAYER_EACH = 30; // one layer per two beats... cut on every other beat

// Calibration taps for the heat map (deterministic pseudo-random).
export const calibrationHits = () => {
  const out: Array<{ f: number; x: number; z: number; zone: ZoneId }> = [];
  let s = 12345;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  ZONE_RECTS.forEach((z, zi) => {
    for (let k = 0; k < 11; k++) {
      const [cx, cz, hw, hd] = z.r;
      out.push({
        f: 1320 + zi * 11 + k * 7 + Math.floor(r() * 5),
        x: cx + (r() - 0.5) * hw * 1.1,
        z: cz + (r() - 0.5) * hd * 1.1,
        zone: z.id,
      });
    }
  });
  return out.sort((a, b) => a.f - b.f);
};

// ---- 10 s vertical teaser ------------------------------------------------
export const TEASER_LEN = 300;
export const TEASER_TAPS: Tap[] = [
  { f: 150, zone: "palmL", action: "Volume +6", gesture: "Tap" },
  { f: 172, zone: "grilleR", action: "Next track", gesture: "Double tap" },
  { f: 179, zone: "grilleR", action: "Next track", quiet: true },
  { f: 205, zone: "top", action: "Paste values", gesture: "Tap" },
  { f: 232, zone: "edgeR", action: "Snap right", gesture: "Knock" },
];
export const TEASER_END = 245;
