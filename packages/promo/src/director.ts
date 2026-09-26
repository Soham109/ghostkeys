import { interpolate, Easing } from "remotion";
import type { Cam, WorldState } from "./three/World";
import { orbitShot, shot, orbit } from "./camera";
import { logoToWorld } from "./three/Particles";
import { CHIP } from "./three/Internals";
import { FILM_TAPS, TEASER_TAPS, ZONES, ZONE_RECTS, S, LAYER_START, LAYER_EACH, LAYERS, V3, Tap } from "./timeline";
import { prog } from "./lib";
import { easeOut, easeInOut } from "./theme";

const FPS = 30;
const whip = Easing.bezier(0.8, 0, 0.2, 1); // speed ramp: crawl, whip, crawl
const clampI = (f: number, a: number[], b: number[], e?: (x: number) => number) =>
  interpolate(f, a, b, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });

export const DOT_WORLD = logoToWorld(60, 68);
const HERO_T: V3 = [0, 4, -3];

const pulseFrom = (taps: Tap[], f: number, decay = 7) =>
  taps.reduce((m, t) => (f >= t.f ? Math.max(m, Math.exp(-(f - t.f) / decay)) : m), 0);

const baseLaptop = () => ({
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
  return { cam, particles: f >= F(34) ? particles : null, laptop, bloom: 0.55 + flash * 1.1 };
};

export const filmState = (f: number): WorldState => {
  const base: WorldState = {
    cam: { pos: orbit(HERO_T, 50, 30, 20), target: HERO_T, fov: 30, bokeh: 0 },
    particles: null,
    laptop: baseLaptop(),
    bloom: 0.55,
    lightScale: 1,
    t: f / FPS,
    chipPulse: 0,
    rings: true,
  };

  if (f < S.headline) {
    return { ...base, ...coldOpen(f, 1, false), rings: false };
  }

  if (f < S.macro) {
    // B: headline over a soft-focus hero; rack focus onto the laptop before the cut
    const T: V3 = [-8.5, 4.5, -3];
    const cam = orbitShot(f, S.headline, S.macro, { target: T, r: 62, az: 32, el: 21, fov: 30, bokeh: 5 }, { target: T, r: 56, az: 22, el: 18, fov: 30, bokeh: 5 }, Easing.linear);
    const rack = clampI(f, [325, 350], [0, 1], easeInOut);
    const near: V3 = orbit(T, 30, 22, 18);
    cam.focus = [near[0] + (0 - near[0]) * rack, near[1] + (4 - near[1]) * rack, near[2] + (-3 - near[2]) * rack];
    return { ...base, cam, lightScale: 0.8 };
  }

  if (f < S.heroType) {
    let cam: Cam;
    const palm = ZONES.palmL.p, gr = ZONES.grilleR.p, top = ZONES.top.p, eL = ZONES.edgeL.p, sen = ZONES.sensor.p;
    if (f < 420) {
      cam = shot(f, 360, 420, { pos: [-0.5, 2.7, 15.5], target: [-9.2, 0, 6.4], fov: 28, focus: palm, bokeh: 7 }, { pos: [-6.2, 2.1, 14.8], target: [-10.4, 0, 5.8], fov: 26, focus: palm, bokeh: 7 }, Easing.bezier(0.3, 0, 0.2, 1));
    } else if (f < 480) {
      cam = shot(f, 420, 480, { pos: [19.5, 6.6, 1.8], target: [13.4, 0, -3.8], fov: 30, focus: gr, bokeh: 6 }, { pos: [18, 5.2, -2.8], target: [13.75, 0, -4.8], fov: 28, focus: gr, bokeh: 6 }, Easing.linear);
    } else if (f < 540) {
      cam = shot(f, 480, 540, { pos: [-7, 3.6, 0.8], target: [-0.5, 0.6, -9.8], fov: 32, focus: top, bokeh: 6 }, { pos: [5.5, 3.1, 0.2], target: [1.5, 0.6, -9.8], fov: 30, focus: top, bokeh: 6 }, Easing.linear);
    } else if (f < 600) {
      cam = shot(f, 540, 600, { pos: [-26, 4.2, 12], target: [-13.5, -0.2, 3.4], fov: 28, focus: eL, bokeh: 6 }, { pos: [-24.5, 3.4, 7.5], target: [-13.5, -0.2, 2.2], fov: 26, focus: eL, bokeh: 6 }, Easing.linear);
    } else if (f < 660) {
      const n: V3 = [0, 0.285, 0.958];
      const d = 17;
      cam = shot(
        f, 600, 660,
        { pos: [sen[0] + 5, sen[1] + n[1] * d - 1.5, sen[2] + n[2] * d], target: [sen[0] - 1.5, sen[1] - 2.2, sen[2]], fov: 30, focus: sen, bokeh: 6 },
        { pos: [sen[0] + 1, sen[1] + n[1] * d - 1, sen[2] + n[2] * (d - 2)], target: [sen[0] - 0.5, sen[1] - 1.8, sen[2]], fov: 28, focus: sen, bokeh: 6 },
        Easing.linear
      );
    } else {
      // speed-ramped orbit, one tap per beat
      cam = orbitShot(f, 660, 780, { target: [0, 1.5, -1.5], r: 50, az: -62, el: 44, fov: 30, bokeh: 1.5 }, { target: [0, 1.5, -1.5], r: 46, az: 74, el: 36, fov: 30, bokeh: 1.5 }, whip);
    }
    return { ...base, cam };
  }

  if (f < S.xray) {
    // hero with type; slow push; this framing is the match-cut into the x-ray
    const T: V3 = [-9, 5, -3];
    const cam = orbitShot(f, S.heroType, S.xray + 180, { target: T, r: 54, az: -14, el: 16, fov: 30, bokeh: 2, focus: HERO_T }, { target: [CHIP[0] - 7, CHIP[1], CHIP[2]], r: 21, az: 22, el: 44, fov: 30, bokeh: 3, focus: CHIP }, easeInOut);
    return { ...base, cam };
  }

  if (f < S.zones) {
    const T: V3 = [-9, 5, -3];
    const cam = orbitShot(f, S.heroType, S.xray + 180, { target: T, r: 54, az: -14, el: 16, fov: 30, bokeh: 2, focus: HERO_T }, { target: [CHIP[0] - 7, CHIP[1], CHIP[2]], r: 21, az: 22, el: 44, fov: 30, bokeh: 3, focus: CHIP }, easeInOut);
    if (f >= S.xray + 180) {
      const c2 = orbitShot(f, S.xray + 180, S.zones, { target: [CHIP[0] - 7, CHIP[1], CHIP[2]], r: 21, az: 22, el: 44, fov: 30, bokeh: 3, focus: CHIP }, { target: [CHIP[0] - 7, CHIP[1], CHIP[2]], r: 18.5, az: 30, el: 46, fov: 30, bokeh: 3, focus: CHIP }, Easing.linear);
      Object.assign(cam, c2);
    }
    const xr = prog(f, S.xray + 6, 36, easeInOut) * (1 - prog(f, S.zones - 16, 16, easeInOut));
    const xTaps = FILM_TAPS.filter((t) => t.f >= S.xray && t.f < S.zones);
    return { ...base, cam, laptop: { ...baseLaptop(), xray: xr }, chipPulse: pulseFrom(xTaps, f, 8), lightScale: 1 - xr * 0.45, bloom: 0.6 + xr * 0.4, rings: true };
  }

  if (f < S.features) {
    // E: top-down instrument view. zones light, calibration heat, app layers
    const T: V3 = [-8.5, 0, 0.8];
    const cam = shot(f, S.zones, S.features, { pos: [T[0], 60, T[2] + 9], target: T, fov: 30, bokeh: 0 }, { pos: [T[0], 56, T[2] + 7], target: T, fov: 30, bokeh: 0 }, Easing.linear);
    const lap = baseLaptop();
    ZONE_RECTS.forEach((z, i) => {
      const tf = 1215 + i * 15;
      lap.zoneGlow[i] = prog(f, tf, 12) * (f < LAYER_START ? (f > 1318 ? 0.45 : 1) : 0.8);
      lap.zoneHot[i] = f >= tf ? Math.exp(-(f - tf) / 9) : 0;
    });
    lap.heat = prog(f, 1318, 12) * (1 - prog(f, LAYER_START - 6, 14));
    if (f >= LAYER_START) {
      const k = Math.floor((f - LAYER_START) / LAYER_EACH);
      const lf = f - (LAYER_START + k * LAYER_EACH);
      const hotZones = LAYERS[k % LAYERS.length];
      void hotZones;
      ZONE_RECTS.forEach((_, i) => (lap.zoneHot[i] = Math.max(lap.zoneHot[i], Math.exp(-lf / 6) * 0.55)));
    }
    return { ...base, cam, laptop: lap, lightScale: 0.5, rings: false };
  }

  // G: hero shot before the end card (features section has no 3D)
  const cam = orbitShot(f, S.hero, S.end, { target: [0, 5.5, -3], r: 56, az: -34, el: 10, fov: 28, bokeh: 2.5, focus: ZONES.palmR.p }, { target: [0, 5.5, -3], r: 50, az: -22, el: 15, fov: 28, bokeh: 2.5, focus: ZONES.palmR.p }, Easing.linear);
  return { ...base, cam };
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
