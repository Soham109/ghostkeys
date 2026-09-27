// Offline sound design (no music): felt thumps on taps, ticks on the beat grid,
// whooshes into cuts, a riser + impact for the logo flash, a low bed under the x-ray.
// Deterministic. Writes public/sfx-film.wav and public/sfx-teaser.wav (44.1 kHz stereo 16-bit).
// Run: node scripts/make-audio.ts
import fs from "node:fs";
import path from "node:path";
import { FILM_TAPS, FILM_LEN, TEASER_TAPS, TEASER_LEN, TEASER_END, FPS, BEAT, S, CALIB_START } from "../src/timeline.ts";

const SR = 44100;
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

class Mix {
  L: Float32Array;
  R: Float32Array;
  constructor(seconds: number) {
    this.L = new Float32Array(Math.ceil(seconds * SR));
    this.R = new Float32Array(Math.ceil(seconds * SR));
  }
  add(t0: number, buf: Float32Array, gain: number, pan = 0) {
    const s0 = Math.round(t0 * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    for (let i = 0; i < buf.length; i++) {
      const j = s0 + i;
      if (j < 0 || j >= this.L.length) continue;
      this.L[j] += buf[i] * gl;
      this.R[j] += buf[i] * gr;
    }
  }
}

const f2s = (f: number) => f / FPS;

// ---- voices
const thump = (pitch = 1) => {
  const n = Math.floor(SR * 0.45);
  const b = new Float32Array(n);
  let ph = 0, ph2 = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = (58 + 70 * Math.exp(-t * 38)) * pitch;
    ph += (2 * Math.PI * f) / SR;
    ph2 += (2 * Math.PI * 190 * pitch) / SR;
    const body = Math.sin(ph) * Math.exp(-t * 9) + 0.35 * Math.sin(ph2) * Math.exp(-t * 30);
    const nz = rnd();
    lp += (nz - lp) * 0.25;
    const click = (nz - lp) * Math.exp(-t * 420) * 0.9;
    b[i] = Math.tanh((body + click) * 1.4) * 0.9;
  }
  return b;
};

const tick = (bright = 1) => {
  const n = Math.floor(SR * 0.06);
  const b = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const nz = rnd();
    const hp = nz - prev;
    prev = nz;
    b[i] = (hp * 0.6 * Math.exp(-t * 180) + Math.sin(2 * Math.PI * 3400 * bright * t) * 0.25 * Math.exp(-t * 90));
  }
  return b;
};

// filtered-noise swell that peaks at `peak` seconds into the buffer
const whoosh = (len = 0.7, peak = 0.6, up = true) => {
  const n = Math.floor(SR * len);
  const b = new Float32Array(n);
  let lp1 = 0, lp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < peak ? Math.pow(t / peak, 2.4) : Math.exp(-(t - peak) * 16);
    const cut = up ? 0.01 + 0.25 * Math.pow(Math.min(1, t / peak), 2) : 0.2 * (1 - Math.min(1, t / len)) + 0.01;
    const nz = rnd();
    lp1 += (nz - lp1) * cut;
    lp2 += (lp1 - lp2) * cut;
    b[i] = lp2 * env * 3.2;
  }
  return b;
};

const riser = (len: number) => {
  const n = Math.floor(SR * len);
  const b = new Float32Array(n);
  let ph1 = 0, ph2 = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = t / len;
    ph1 += (2 * Math.PI * (110 + 330 * u * u)) / SR;
    ph2 += (2 * Math.PI * (110 + 330 * u * u) * 1.498) / SR;
    const nz = rnd();
    lp += (nz - lp) * (0.02 + 0.3 * u * u);
    b[i] = (0.22 * Math.sin(ph1) + 0.14 * Math.sin(ph2) + lp * 1.4) * Math.pow(u, 2.2);
  }
  return b;
};

const impact = () => {
  const n = Math.floor(SR * 2.4);
  const b = new Float32Array(n);
  let ph = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (38 + 60 * Math.exp(-t * 10))) / SR;
    const nz = rnd();
    lp += (nz - lp) * 0.08;
    b[i] = Math.tanh(1.6 * (Math.sin(ph) * Math.exp(-t * 2.2) + lp * 2.5 * Math.exp(-t * 7))) * 0.9;
  }
  return b;
};

const bed = (len: number, base = 55) => {
  const n = Math.floor(SR * len);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 1.2) * Math.min(1, (len - t) / 1.2);
    const lfo = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.5 * t);
    b[i] = env * lfo * (0.5 * Math.sin(2 * Math.PI * base * t) + 0.25 * Math.sin(2 * Math.PI * base * 1.5 * t) + 0.12 * Math.sin(2 * Math.PI * base * 4.01 * t));
  }
  return b;
};

const writeWav = (file: string, m: Mix) => {
  let peak = 0;
  for (let i = 0; i < m.L.length; i++) peak = Math.max(peak, Math.abs(m.L[i]), Math.abs(m.R[i]));
  const g = peak > 0 ? 0.89 / peak : 1;
  const n = m.L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Math.tanh(m.L[i] * g))) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Math.tanh(m.R[i] * g))) * 32767), 46 + i * 4);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`wrote ${path.relative(root, file)} (${(n / SR).toFixed(2)} s)`);
};

const panFor = (zone: string) => (zone.endsWith("L") ? -0.45 : zone.endsWith("R") ? 0.45 : 0);

// ---- film (v2 beat sheet)
{
  const m = new Mix(FILM_LEN / FPS);
  const k = S.matter / 165; // cold open timing compression (see director)
  m.add(f2s(30 * k), thump(1.15), 0.9); // the first tap
  m.add(f2s(34 * k), whoosh(1.6, 1.4, true), 0.35);
  m.add(f2s(122 * k) - 2.9, riser(3.0), 0.35);
  m.add(f2s(122 * k), impact(), 0.8);
  m.add(f2s(S.matter) - 0.35, whoosh(0.9, 0.35, false), 0.5);
  for (const c of [S.macro, S.split, S.grille, S.xray, S.calib, S.cover, S.lid, S.air, S.sonar, S.app, S.appCut + 30, S.type, S.typeCut, S.hero, S.end]) m.add(f2s(c) - 0.55, whoosh(0.75, 0.55), 0.28);
  for (let f = S.type; f < S.hero; f += BEAT) m.add(f2s(f), tick(1.3), 0.1);
  for (const t of FILM_TAPS) {
    if (t.zone === "air" || t.zone === "sonar") m.add(f2s(t.f), tick(0.7), 0.35);
    else if (t.gesture === "Slide") m.add(f2s(t.f), tick(1.8), t.quiet ? 0.1 : 0.2, 0.45);
    else m.add(f2s(t.f), thump(t.quiet ? 1.25 : 1), t.quiet ? 0.45 : 0.8, panFor(t.zone));
  }
  for (let f = CALIB_START; f < S.cover - 4; f += 5) m.add(f2s(f), tick(1.6), 0.05);
  m.add(f2s(S.xray), bed((S.calib - S.xray) / FPS, 55), 0.28);
  m.add(f2s(S.air), bed((S.app - S.air) / FPS, 73.4), 0.18);
  m.add(f2s(S.cover), bed((S.air - S.cover) / FPS, 61.7), 0.12);
  m.add(f2s(S.end), bed((FILM_LEN - S.end) / FPS, 41.2), 0.22);
  m.add(f2s(S.end + 42), thump(0.9), 0.85);
  writeWav(path.join(root, "public/sfx-film.wav"), m);
}

// ---- teaser
{
  const m = new Mix(TEASER_LEN / FPS);
  m.add(f2s(15), thump(1.15), 0.9);
  m.add(f2s(61) - 1.8, riser(1.9), 0.35);
  m.add(f2s(61), impact(), 0.8);
  m.add(f2s(82) - 0.3, whoosh(0.6, 0.3, false), 0.5);
  for (const c of [120, 160, 190, 220, TEASER_END]) m.add(f2s(c) - 0.5, whoosh(0.7, 0.5), 0.3);
  for (let f = 120; f < TEASER_END; f += BEAT) m.add(f2s(f), tick(1), 0.12);
  for (const t of TEASER_TAPS) m.add(f2s(t.f), thump(t.quiet ? 1.25 : 1), t.quiet ? 0.45 : 0.8, panFor(t.zone));
  m.add(f2s(TEASER_END + 26), thump(0.9), 0.8);
  writeWav(path.join(root, "public/sfx-teaser.wav"), m);
}
