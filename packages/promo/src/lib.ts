import { interpolate } from "remotion";
import { easeOut } from "./theme";

// Deterministic PRNG (mulberry32) so every render is identical.
export const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// Smooth 1D value noise.
export const noise1 = (x: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
};

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 0..1 progress between two frames with an easing (default expo-out). */
export const prog = (frame: number, start: number, dur: number, ease = easeOut) =>
  interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

/** Fade in over `inDur`, hold, fade out over `outDur` ending at `total`. */
export const inOut = (frame: number, total: number, inDur = 12, outDur = 12) =>
  Math.min(
    interpolate(frame, [0, inDur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    interpolate(frame, [total - outDur, total], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  );

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
