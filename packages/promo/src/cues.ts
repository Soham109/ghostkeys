// The audio-visual cue sheet: every sound and the exact frame of the visual event it belongs to.
// Pure data derived from the timeline, shared by the mixer (scripts/mix.ts) and the sync check (scripts/verify-sync.ts).
import { FILM_TAPS, S, BEAT, CALIB_START, FILM_LEN } from "./timeline.ts";

export type CueKind = "thump" | "knock" | "tick" | "impact" | "whoosh" | "riser" | "air";
export type Cue = { f: number; kind: CueKind; gain: number; pan: number; label: string; verify: boolean };

const K_OPEN = S.matter / 165;
export const DOT_TAP = Math.round(30 * K_OPEN); // lone dot pressed (cold open)
export const LOGO_FLASH = Math.ceil(122 * K_OPEN); // first frame at full flash
export const END_DOT = S.end + 42; // end card touch dot lands

const pan = (zone: string) => (zone.endsWith("L") ? -0.45 : zone.endsWith("R") ? 0.45 : 0);

export const buildCues = (): Cue[] => {
  const c: Cue[] = [];
  c.push({ f: DOT_TAP, kind: "thump", gain: 0.9, pan: 0, label: "dot tap", verify: true });
  c.push({ f: LOGO_FLASH, kind: "impact", gain: 0.7, pan: 0, label: "logo flash", verify: true });
  c.push({ f: LOGO_FLASH, kind: "riser", gain: 0.3, pan: 0, label: "riser into flash", verify: false });
  c.push({ f: S.matter, kind: "whoosh", gain: 0.4, pan: 0, label: "shatter", verify: true });
  for (const cut of [S.macro, S.split, S.grille, S.xray, S.calib, S.cover, S.lid, S.air, S.sonar, S.app, S.appCut + 30, S.type, S.typeCut, S.hero, S.end])
    c.push({ f: cut, kind: "whoosh", gain: 0.22, pan: 0, label: `cut ${cut}`, verify: true });
  for (const t of FILM_TAPS) {
    const label = `${t.zone} ${t.gesture ?? "tap"}`;
    if (t.zone === "air" || t.zone === "sonar") c.push({ f: t.f, kind: "air", gain: 0.5, pan: 0.2, label, verify: true });
    else if (t.gesture === "Slide") c.push({ f: t.f, kind: "tick", gain: t.quiet ? 0.12 : 0.22, pan: 0.45, label, verify: !t.quiet });
    else if (t.gesture === "Knuckle") c.push({ f: t.f, kind: "knock", gain: 0.85, pan: pan(t.zone), label, verify: true });
    else c.push({ f: t.f, kind: "thump", gain: t.quiet ? 0.6 : 0.8, pan: pan(t.zone), label, verify: true });
  }
  for (let f = CALIB_START; f < S.cover - 4; f += 5) c.push({ f, kind: "tick", gain: 0.05, pan: 0, label: "calibration sample", verify: false });
  for (let f = S.type; f < S.hero; f += BEAT) c.push({ f, kind: "tick", gain: 0.08, pan: 0, label: "type beat", verify: false });
  c.push({ f: END_DOT, kind: "thump", gain: 0.85, pan: 0, label: "end card dot", verify: true });
  return c.filter((x) => x.f >= 0 && x.f < FILM_LEN).sort((a, b) => a.f - b.f);
};
