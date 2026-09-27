// Shared by the video and scripts/make-audio.ts. Pure data, no imports.
// 120 BPM at 30 fps: one beat = 15 frames, one bar = 60 frames. Cuts land on beats.
export const FPS = 30;
export const BPM = 120;
export const BEAT = 15;
export const BAR = 60;

export type V3 = [number, number, number];
export type ZoneId = "palmL" | "palmR" | "grilleL" | "grilleR" | "top" | "edgeL" | "edgeR" | "lid" | "sensor" | "air" | "sonar";

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
  lid: { p: lidPoint(0.8, -0.03, 20.7), name: "Lid" },
  sensor: { p: lidPoint(1.6, -0.02, 20.35), name: "Light sensor" },
  air: { p: [1.5, 7.5, -3.5], name: "Air" },
  sonar: { p: [0, 5, -4], name: "Sonar" },
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

/** x, z: optional deck position overriding the zone centre; s: ripple strength. */
export type Tap = { f: number; zone: ZoneId; action: string; gesture?: string; quiet?: boolean; x?: number; z?: number; s?: number };

// ---- The 70 s film (v2) --------------------------------------------------
// Every section starts on a beat (multiples of 15 frames) and is a different visual idea.
export const FILM_LEN = 2100;
export const S = {
  open: 0, // dot, tap, particles into the logo
  matter: 150, // logo shatters into a point-cloud laptop, then metal; "Hidden keys."
  macro: 270, // macro lens: a fingertip taps the palm rest
  split: 390, // split screen: a knuckle knocks the edge | the live app answers
  grille: 510, // double tap on the grille, then a finger slides along it
  xray: 630, // chassis turns to glass, the motion chip
  calib: 780, // top-down: calibration heat map, numbered zones
  cover: 870, // a palm covers the light sensor
  lid: 930, // a finger nudges the lid
  air: 990, // air: pinch and dial, then a palm swipe
  sonar: 1140, // a palm hovers over the speaker as a volume slider; the field bends under it
  app: 1260, // push into the screen (live view) ...
  appCut: 1350, // ... match cut to the flat UI, macro pan over the gesture guide
  type: 1440, // the bold typographic moment
  typeCut: 1545,
  hero: 1620, // final hero shot, one last tap
  end: 1800, // end card
};

const slide = (f0: number, n: number): Tap[] =>
  Array.from({ length: n }, (_, i) => ({ f: f0 + i * 5, zone: "grilleR" as ZoneId, action: "Brightness", gesture: "Slide", quiet: i > 0, x: 13.75, z: -8.2 + (i / (n - 1)) * 7.4, s: 0.35 }));

export const FILM_TAPS: Tap[] = [
  { f: 315, zone: "palmL", action: "Volume +6", gesture: "Tap" },
  { f: 420, zone: "edgeR", action: "Snap right", gesture: "Knuckle" },
  { f: 465, zone: "edgeR", action: "Snap right", gesture: "Knuckle", quiet: true },
  { f: 528, zone: "grilleR", action: "Next track", gesture: "Double tap" },
  { f: 536, zone: "grilleR", action: "Next track", gesture: "Double tap", quiet: true },
  ...slide(577, 8),
  // seen from inside
  { f: 680, zone: "palmL", action: "Volume +6" },
  { f: 720, zone: "grilleR", action: "Next track" },
  { f: 750, zone: "top", action: "Paste values" },
  { f: 896, zone: "sensor", action: "Do not disturb", gesture: "Cover" },
  { f: 955, zone: "lid", action: "Show desktop", gesture: "Nudge" },
  { f: 1032, zone: "air", action: "Volume", gesture: "Pinch and dial" },
  { f: 1098, zone: "air", action: "Next desktop", gesture: "Swipe" },
  { f: 1170, zone: "sonar", action: "Volume", gesture: "Hover" },
  { f: 1695, zone: "palmR", action: "Ready", gesture: "Tap" },
];

export const CALIB_START = 790;

// Calibration taps for the heat map (deterministic pseudo-random), starting at `start`.
export const calibrationHits = (start = CALIB_START) => {
  const out: Array<{ f: number; x: number; z: number; zone: ZoneId }> = [];
  let s = 12345;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  ZONE_RECTS.forEach((z, zi) => {
    for (let k = 0; k < 9; k++) {
      const [cx, cz, hw, hd] = z.r;
      out.push({
        f: start + zi * 6 + k * 5 + Math.floor(r() * 4),
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
