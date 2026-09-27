import { interpolate, Easing } from "remotion";
import type { Cam, WorldState } from "./three/World";
import type { LaptopState } from "./three/Laptop";
import { orbitShot, shot, orbit } from "./camera";
import { logoToWorld } from "./three/Particles";
import { CHIP } from "./three/Internals";
import { FILM_TAPS, TEASER_TAPS, ZONES, ZONE_RECTS, S, V3, Tap, CALIB_START, lidPointWorld } from "./timeline";
import { prog } from "./lib";
import { filmHand, lidDeltaAt } from "./three/hand/scenes";
import { easeOut, easeInOut } from "./theme";

const FPS = 30;
const whip = Easing.bezier(0.8, 0, 0.2, 1); // speed ramp: crawl, whip, crawl
const clampI = (f: number, a: number[], b: number[], e?: (x: number) => number) =>
  interpolate(f, a, b, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });

export const DOT_WORLD = logoToWorld(60, 68);
const HERO_T: V3 = [0, 4, -3];

const pulseFrom = (taps: Tap[], f: number, decay = 7) =>
  taps.reduce((m, t) => (f >= t.f ? Math.max(m, Math.exp(-(f - t.f) / decay)) : m), 0);

const baseLaptop = (): LaptopState => ({
  opacity: 1,
  xray: 0,
  zoneGlow: new Array(7).fill(0),
  zoneHot: new Array(7).fill(0),
  heat: 0,
  screenOn: 1,
  chipPulse: 0,
});

/** Cold open camera + particles, shared by film and teaser (time-scaled). */
const coldOpen = (f: number, k: number, vertical: boolean): Pick<WorldState, "cam" | "particles" | "laptop" | "bloom"> => {
  // k: time compression (1 = film, <1 = faster)
  const F = (x: number) => x * k;
  const heroR = vertical ? 84 : 60;
  const z0 = vertical ? 64 : 46;
  const z1 = vertical ? 56 : 38;
  let cam: Cam;
  if (f < F(165)) {
    cam = shot(f, 0, F(165), { pos: [0, 7, z0], target: [0, 7, 0], fov: 30, bokeh: 0 }, { pos: [0, 7.4, z1], target: [0, 7, 0], fov: 30, bokeh: 0 }, easeInOut);
  } else {
    const a: Cam = { pos: [0, 7.4, z1], target: [0, 7, 0], fov: 30, bokeh: 0 };
    const bT: V3 = vertical ? [0, 6, -3] : HERO_T;
    const b: Cam = { pos: orbit(bT, heroR, 32, 22), target: bT, fov: 30, bokeh: 0 };
    cam = shot(f, F(165), F(240), a, b, whip);
  }
  const flash = f >= F(122) ? Math.exp(-(f - F(122)) / 5) : f >= F(116) ? (f - F(116)) / (6) : 0;
  const particles = {
    t: Math.max(0, (f - F(34)) / 30),
    burst: prog(f, F(34), F(50)),
    logo: clampI(f, [F(60), F(128)], [0, 1.12]),
    flash,
    shatter: prog(f, F(165), F(40)),
    lap: clampI(f, [F(172), F(232)], [0, 1]),
    alpha: 1 - prog(f, F(222), F(20), easeInOut),
    dot: DOT_WORLD,
    pixelScale: 64,
  };
  const lapOp = prog(f, F(212), F(30), easeInOut);
  const laptop = lapOp > 0 ? { ...baseLaptop(), opacity: lapOp, screenOn: lapOp } : null;
  return { cam, particles: f >= F(34) ? particles : null, laptop, bloom: 0.55 + flash * 0.6 };
};

const K_OPEN = S.matter / 165; // v1 cold open compressed so the shatter lands on the beat at S.matter
const HERO_END = orbit(HERO_T, 60, 32, 22);
const SCREEN_C = lidPointWorld(0, -0.02, 10.8);
const SCREEN_N: V3 = [0, 0.285, 0.958];
void 0;
const alongN = (d: number, dy = 0): V3 => [SCREEN_C[0], SCREEN_C[1] + SCREEN_N[1] * d + dy, SCREEN_C[2] + SCREEN_N[2] * d];

export const filmState = (f: number): WorldState => {
  const base: WorldState = {
    cam: { pos: HERO_END, target: HERO_T, fov: 30, bokeh: 0 },
    particles: null,
    laptop: baseLaptop(),
    bloom: 0.55,
    lightScale: 1,
    t: f / FPS,
    chipPulse: 0,
    rings: true,
    air: null,
    sonar: null,
  };

  // 01 + 02: dot, tap, particles into the logo, shatter into the laptop
  if (f < S.macro) {
    const co = coldOpen(f, K_OPEN, false);
    if (f >= 218) {
      co.cam = orbitShot(f, 218, S.macro, { target: HERO_T, r: 60, az: 32, el: 22, fov: 30, bokeh: 0 }, { target: [-7, 5, -3], r: 58, az: 22, el: 17, fov: 30, bokeh: 2.5, focus: HERO_T }, easeInOut);
    }
    return { ...base, ...co, rings: false };
  }

  const hand = { f, solve: filmHand };

  // 03: macro lens across the palm rest; a fingertip taps, focus racks onto it
  if (f < S.split) {
    const palm = ZONES.palmL.p;
    const cam = shot(f, S.macro, S.split, { pos: [-28, 12, 22], target: [-9.4, 1.6, 6.2], fov: 30, focus: [-14, 0, 10], bokeh: 4 }, { pos: [-25, 10, 19.5], target: [-9.6, 1.6, 6], fov: 28, focus: palm, bokeh: 4 }, Easing.bezier(0.3, 0, 0.15, 1));
    const rack = clampI(f, [286, 306], [0, 1], easeInOut);
    cam.focus = [-14 + (palm[0] + 14) * rack, 1, 10 + (palm[2] - 10) * rack];
    return { ...base, cam, hand, lightScale: 0.65 };
  }

  // 04: split screen, left half: knuckles knock the right edge
  if (f < S.grille) {
    const eR = ZONES.edgeR.p;
    const cam = shot(f, S.split, S.grille, { pos: [24, 8, 22], target: [15, 0.2, 2.6], fov: 34, focus: eR, bokeh: 4 }, { pos: [22.5, 6.5, 19], target: [15, 0.2, 2.6], fov: 32, focus: eR, bokeh: 4 }, Easing.linear);
    return { ...base, cam, lightScale: 0.6, hand };
  }

  // 05: the grille: double tap, then a slow slide along it (speed ramp into the slide)
  if (f < S.xray) {
    const g = ZONES.grilleR.p;
    const cam = shot(f, S.grille, S.xray, { pos: [22, 10, 5], target: [13.2, 0.5, -4], fov: 34, focus: g, bokeh: 5 }, { pos: [20.5, 8, -3], target: [13.4, 0.5, -5.5], fov: 32, focus: [13.75, 0, -4.5], bokeh: 5 }, whip);
    return { ...base, cam, hand };
  }

  // 06: x-ray, starting from the grille shot's end framing
  if (f < S.calib) {
    const from = { target: [13.4, 0.5, -5.5] as V3, r: 10.6, az: 70.6, el: 45, fov: 32, bokeh: 5 };
    const chipT: V3 = [CHIP[0] - 6.5, CHIP[1], CHIP[2]];
    let cam = orbitShot(f, S.xray, S.xray + 120, from, { target: chipT, r: 21, az: 22, el: 44, fov: 30, bokeh: 3, focus: CHIP }, easeInOut);
    if (f >= S.xray + 120) cam = orbitShot(f, S.xray + 120, S.calib, { target: chipT, r: 21, az: 22, el: 44, fov: 30, bokeh: 3, focus: CHIP }, { target: chipT, r: 19.5, az: 27, el: 46, fov: 30, bokeh: 3, focus: CHIP }, Easing.linear);
    const xr = prog(f, S.xray + 6, 30, easeInOut) * (1 - prog(f, S.calib - 14, 14, easeInOut));
    const xTaps = FILM_TAPS.filter((t) => t.f >= S.xray && t.f < S.calib);
    return { ...base, cam, laptop: { ...baseLaptop(), xray: xr }, chipPulse: pulseFrom(xTaps, f, 8), lightScale: 1 - xr * 0.45, bloom: 0.6 + xr * 0.4 };
  }

  // 07: top-down, calibration heat map over monochrome numbered zones
  if (f < S.cover) {
    const T: V3 = [-3.5, 0, 0.8];
    const cam = shot(f, S.calib, S.cover, { pos: [T[0], 60, T[2] + 8], target: T, fov: 30, bokeh: 0 }, { pos: [T[0], 54, T[2] + 6], target: T, fov: 30, bokeh: 0 }, Easing.linear);
    const lap = baseLaptop();
    ZONE_RECTS.forEach((_, i) => (lap.zoneGlow[i] = prog(f, S.calib + 4 + i * 2, 12) * 0.55));
    lap.heat = prog(f, CALIB_START - 4, 10);
    lap.heatFrame = f;
    return { ...base, cam, laptop: lap, lightScale: 0.5, rings: false };
  }

  // 07b: a palm covers the light sensor (seen from in front of the screen)
  if (f < S.lid) {
    const sp = ZONES.sensor.p;
    const cam = shot(f, S.cover, S.lid, { pos: [sp[0] + 14, sp[1] + SCREEN_N[1] * 36 - 9, sp[2] + SCREEN_N[2] * 36], target: [sp[0] + 1.5, sp[1] + 1, sp[2]], fov: 32, focus: sp, bokeh: 2.5 }, { pos: [sp[0] + 11, sp[1] + SCREEN_N[1] * 33 - 8, sp[2] + SCREEN_N[2] * 33], target: [sp[0] + 1, sp[1] + 1, sp[2]], fov: 30, focus: sp, bokeh: 2.5 }, Easing.linear);
    return { ...base, cam, laptop: { ...baseLaptop(), screenOn: 0.6 }, lightScale: 0.6, hand };
  }

  // 07c: a finger nudges the lid back (side view, so the lid visibly moves)
  if (f < S.air) {
    const cam = shot(f, S.lid, S.air, { pos: [27, 16, 2], target: [1, 12, -13], fov: 32, focus: [0.8, 19, -16], bokeh: 2.5 }, { pos: [25, 15, -1], target: [1, 12.5, -13], fov: 32, focus: [0.8, 19, -16], bokeh: 2.5 }, Easing.linear);
    return { ...base, cam, laptop: { ...baseLaptop(), lidDelta: lidDeltaAt(f) }, lightScale: 0.7, hand };
  }

  // 08: air gestures: pinch and dial, then a palm swipe
  if (f < S.sonar) {
    const cam = orbitShot(f, S.air, S.sonar, { target: [3, 7, -4.5], r: 30, az: 58, el: 14, fov: 30, bokeh: 3, focus: [1.5, 7.5, -4] }, { target: [0, 7, -4.5], r: 29, az: 40, el: 11, fov: 30, bokeh: 3, focus: [0, 7.5, -4] }, Easing.linear);
    const dial = clampI(f, [1036, 1054], [0, 1], easeInOut) * (1 - clampI(f, [1060, 1066], [0, 1]));
    return { ...base, cam, laptop: { ...baseLaptop(), screenOn: 0.25 }, lightScale: 0.22, bloom: 0.8, hand, air: { pinchAge: f - 1032, dial } };
  }

  // 09: a palm over the right speaker is a volume slider; the field bends under it
  if (f < S.app) {
    const cam = orbitShot(f, S.sonar, S.app, { target: [10, 3.5, -4.5], r: 30, az: -24, el: 12, fov: 32, bokeh: 2.5, focus: [12, 3, -4.5] }, { target: [10, 3.5, -4.5], r: 27, az: -10, el: 15, fov: 32, bokeh: 2.5, focus: [12, 3, -4.5] }, Easing.linear);
    const amount = prog(f, S.sonar, 14) * (1 - prog(f, S.app - 14, 14));
    return { ...base, cam, laptop: { ...baseLaptop(), screenOn: 0.2 }, lightScale: 0.2, bloom: 0.8, hand, sonar: { amount } };
  }

  // 10: push into the screen showing the live view (ends framed for the match cut to the flat UI)
  if (f < S.type) {
    const d = interpolate(f, [S.app, S.appCut], [72, 29.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.7, 0, 0.3, 1) });
    const side = interpolate(f, [S.app, S.appCut], [9, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
    const pos = alongN(d);
    pos[0] += side;
    const cam: Cam = { pos, target: SCREEN_C, fov: 30, bokeh: 0 };
    return { ...base, cam, laptop: { ...baseLaptop(), screenImage: "live" }, lightScale: 0.28, bloom: 0.35, rings: false };
  }

  // 12: hero
  const cam = orbitShot(f, S.hero, S.end, { target: [0, 5.5, -3], r: 56, az: -34, el: 10, fov: 28, bokeh: 2.5, focus: ZONES.palmR.p }, { target: [0, 5.5, -3], r: 50, az: -22, el: 15, fov: 28, bokeh: 2.5, focus: ZONES.palmR.p }, Easing.linear);
  return { ...base, cam, lightScale: 0.68, hand: { f, solve: filmHand } };
};

// ---- vertical teaser ----------------------------------------------------
export const TEASER_K = 0.5; // cold open at double speed: 0-120
export const teaserState = (f: number): WorldState => {
  const base: WorldState = {
    cam: { pos: orbit([0, 6, -3], 78, 30, 20), target: [0, 6, -3], fov: 30, bokeh: 0 },
    particles: null,
    laptop: baseLaptop(),
    bloom: 0.55,
    lightScale: 1,
    t: f / FPS,
    chipPulse: 0,
    rings: true,
  };
  if (f < 120) return { ...base, ...coldOpen(f, TEASER_K, true), rings: false };
  let cam: Cam;
  if (f < 160) {
    cam = orbitShot(f, 120, 160, { target: [0, 17, -3], r: 86, az: 22, el: 22, fov: 30, bokeh: 1, focus: [0, 4, -3] }, { target: [0, 17, -3], r: 80, az: 10, el: 26, fov: 30, bokeh: 1, focus: [0, 4, -3] }, Easing.linear);
  } else if (f < 190) {
    const gr = ZONES.grilleR.p;
    cam = shot(f, 160, 190, { pos: [21, 12, 7], target: [12.5, 0, -4.4], fov: 40, focus: gr, bokeh: 6 }, { pos: [19.5, 11, 4], target: [13.2, 0, -4.8], fov: 38, focus: gr, bokeh: 6 }, Easing.linear);
  } else if (f < 220) {
    const top = ZONES.top.p;
    cam = shot(f, 190, 220, { pos: [-5, 6.5, 4], target: [0, 1.2, -9.8], fov: 44, focus: top, bokeh: 6 }, { pos: [4, 6, 3.5], target: [1, 1.2, -9.8], fov: 42, focus: top, bokeh: 6 }, Easing.linear);
  } else {
    cam = orbitShot(f, 220, 245, { target: [0, 5, -2], r: 70, az: 70, el: 30, fov: 32, bokeh: 1.5, focus: [0, 3, -2] }, { target: [0, 5, -2], r: 74, az: 40, el: 26, fov: 32, bokeh: 1.5, focus: [0, 3, -2] }, whip);
  }
  return { ...base, cam };
};

export const TEASER_TAPS_ALL = TEASER_TAPS;
export { FILM_TAPS };
