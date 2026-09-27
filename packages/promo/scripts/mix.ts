// v3 film audio: sound design from the cue sheet, an original score on the 120 BPM grid,
// VO-priority ducking, collision checks, stems and loudness. Run after make-voice.ts.
// Outputs: public/mix-film-vo.wav, public/mix-film-novo.wav, out/stems/{vo,music,sfx}.wav, out/cue-sheet.csv
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildCues, type Cue } from "../src/cues.ts";
import { FILM_LEN, FPS, S } from "../src/timeline.ts";

const SR = 44100;
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const LEN = Math.ceil((FILM_LEN / FPS) * SR);
const T = (f: number) => f / FPS;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

type Stereo = { L: Float32Array; R: Float32Array };
const stereo = (): Stereo => ({ L: new Float32Array(LEN), R: new Float32Array(LEN) });
const addMono = (dst: Stereo, t0: number, buf: Float32Array, gain: number, pan = 0) => {
  const s0 = Math.round(t0 * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  for (let i = 0; i < buf.length; i++) {
    const j = s0 + i;
    if (j < 0 || j >= LEN) continue;
    dst.L[j] += buf[i] * gl;
    dst.R[j] += buf[i] * gr;
  }
};

// ---------- sound design voices (every voice has its transient at sample 0 unless noted) ----------
const thump = (pitch = 1) => {
  const n = Math.floor(SR * 0.45), b = new Float32Array(n);
  let ph = 0, ph2 = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (58 + 70 * Math.exp(-t * 38)) * pitch) / SR;
    ph2 += (2 * Math.PI * 190 * pitch) / SR;
    const nz = rnd();
    lp += (nz - lp) * 0.25;
    b[i] = Math.tanh((Math.sin(ph) * Math.exp(-t * 9) + 0.35 * Math.sin(ph2) * Math.exp(-t * 30) + (nz - lp) * Math.exp(-t * 420) * 0.9) * 1.4) * 0.9;
  }
  return b;
};
const knock = () => {
  // a knuckle on metal: woody body at two modes plus a dry click
  const n = Math.floor(SR * 0.3), b = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const nz = rnd();
    lp += (nz - lp) * 0.35;
    b[i] = Math.tanh(1.3 * (0.8 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 26) + 0.45 * Math.sin(2 * Math.PI * 410 * t) * Math.exp(-t * 40) + 0.3 * Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t * 14) + (nz - lp) * Math.exp(-t * 300)));
  }
  return b;
};
const tick = (bright = 1) => {
  const n = Math.floor(SR * 0.06), b = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, nz = rnd();
    b[i] = (nz - prev) * 0.6 * Math.exp(-t * 180) + Math.sin(2 * Math.PI * 3400 * bright * t) * 0.25 * Math.exp(-t * 90);
    prev = nz;
  }
  return b;
};
const air = () => {
  // glassy mid-air confirmation: two soft partials, instant attack
  const n = Math.floor(SR * 0.6), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    b[i] = (0.5 * Math.sin(2 * Math.PI * 1760 * t) + 0.3 * Math.sin(2 * Math.PI * 2637 * t) + 0.2 * Math.sin(2 * Math.PI * 880 * t)) * Math.exp(-t * 9);
  }
  return b;
};
/** whoosh whose PEAK lands `peak` s into the buffer (placed so the peak is on the cut frame) */
const whoosh = (len = 0.75, peak = 0.55) => {
  const n = Math.floor(SR * len), b = new Float32Array(n);
  let l1 = 0, l2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < peak ? Math.pow(t / peak, 2.4) : Math.exp(-(t - peak) * 16);
    const cut = 0.01 + 0.25 * Math.pow(Math.min(1, t / peak), 2);
    const nz = rnd();
    l1 += (nz - l1) * cut;
    l2 += (l1 - l2) * cut;
    b[i] = l2 * env * 3.2;
  }
  return b;
};
const riser = (len: number) => {
  const n = Math.floor(SR * len), b = new Float32Array(n);
  let p1 = 0, p2 = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    p1 += (2 * Math.PI * (110 + 330 * u * u)) / SR;
    p2 += (2 * Math.PI * (110 + 330 * u * u) * 1.498) / SR;
    const nz = rnd();
    lp += (nz - lp) * (0.02 + 0.3 * u * u);
    b[i] = (0.22 * Math.sin(p1) + 0.14 * Math.sin(p2) + lp * 1.4) * Math.pow(u, 2.2);
  }
  return b;
};
const impact = () => {
  const n = Math.floor(SR * 2.4), b = new Float32Array(n);
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

// ---------- VO windows ----------
const vo = JSON.parse(fs.readFileSync(path.join(root, "public/vo-lines.json"), "utf8")) as { engine: string; lines: Array<{ f: number; text: string; seconds: number }> };
const voWin = vo.lines.map((l) => ({ a: T(l.f), b: T(l.f) + l.seconds, text: l.text }));
const inVO = (t: number, pad = 0.1) => voWin.some((w) => t >= w.a - pad && t <= w.b + pad);

// ---------- cue sheet, thinning and collision checks ----------
const cues = buildCues();
const kept: Cue[] = [];
const report: string[] = [];
for (const c of cues) {
  const t = T(c.f);
  if (inVO(t) && !c.verify) continue; // thin out decorative sounds under speech
  const loud = c.kind === "thump" || c.kind === "knock" || c.kind === "impact";
  if (loud && inVO(t, 0.15)) report.push(`VIOLATION loud ${c.kind} "${c.label}" at frame ${c.f} overlaps a VO line`);
  kept.push(c);
}
const impacts = kept.filter((c) => ["thump", "knock", "impact", "air"].includes(c.kind));
for (let i = 1; i < impacts.length; i++) {
  const gap = T(impacts[i].f) - T(impacts[i - 1].f);
  if (gap > 0 && gap < 0.12) report.push(`VIOLATION impacts ${impacts[i - 1].label} (${impacts[i - 1].f}) and ${impacts[i].label} (${impacts[i].f}) only ${(gap * 1000).toFixed(0)} ms apart`);
}
voWin.forEach((w, i) => {
  if (i && w.a < voWin[i - 1].b + 0.15) report.push(`VIOLATION VO lines ${i} and ${i + 1} overlap or touch`);
});
vo.lines.forEach((l) => l.f % 15 !== 0 && report.push(`VIOLATION VO "${l.text}" starts off-beat at frame ${l.f}`));

// ---------- render SFX stem ----------
const sfx = stereo();
const cache: Record<string, Float32Array> = {};
const voice = (k: string, make: () => Float32Array) => (cache[k] ??= make());
for (const c of kept) {
  const t = T(c.f);
  if (c.kind === "thump") addMono(sfx, t, voice(`th${c.gain < 0.7 ? "q" : ""}`, () => thump(c.gain < 0.7 ? 1.25 : 1)), c.gain, c.pan);
  else if (c.kind === "knock") addMono(sfx, t, voice("kn", knock), c.gain, c.pan);
  else if (c.kind === "tick") addMono(sfx, t, voice(`tk${c.label}`, () => tick(c.label.includes("calibration") ? 1.6 : c.label.includes("type") ? 1.3 : 1.8)), c.gain, c.pan);
  else if (c.kind === "air") addMono(sfx, t, voice("air", air), c.gain, c.pan);
  else if (c.kind === "impact") addMono(sfx, t, voice("im", impact), c.gain, 0);
  else if (c.kind === "whoosh") addMono(sfx, t - 0.53, voice("wh", () => whoosh(0.75, 0.55)), c.gain, 0);
  else if (c.kind === "riser") addMono(sfx, t - 3.0, voice("ri", () => riser(3.0)), c.gain, 0);
}

// ---------- original score (120 BPM, beat 0 = frame 0) ----------
const BEAT_S = 0.5;
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
// D dorian colour: Dm9, Bbmaj9, Fmaj9/A, Cadd9; one chord per 2 bars (4 s)
const CHORDS = [
  { root: 38, notes: [53, 57, 60, 64] },
  { root: 34, notes: [50, 53, 57, 60] },
  { root: 41, notes: [57, 60, 64, 67] },
  { root: 36, notes: [52, 55, 62, 67] },
];
const RESOLVE = { root: 41, notes: [53, 57, 60, 64, 67] }; // Fmaj9 at the end card
const chordAt = (t: number) => (t >= T(S.end) ? RESOLVE : CHORDS[Math.floor(t / 4) % 4]);
const sec = (f: number) => T(f);
// section intensities (0..1) as smooth curves over time
const ramp = (t: number, a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const padLevel = (t: number) => 0.25 + 0.75 * ramp(t, 1.0, sec(111)) - 0.35 * ramp(t, sec(S.xray), sec(S.xray) + 1) * (1 - ramp(t, sec(S.calib) - 1, sec(S.calib)));
const cutoffAt = (t: number) => {
  let c = 500 + 1600 * ramp(t, 1, sec(111));
  if (t > sec(S.xray) && t < sec(S.calib)) c *= 0.55;
  if (t > sec(S.air) && t < sec(S.app)) c *= 1.35;
  if (t > sec(S.hero) && t < sec(S.end)) c *= 1 + 1.6 * ramp(t, sec(S.hero), sec(S.end));
  return c;
};
const arpRate = (t: number) => {
  if (t < sec(S.macro) || (t >= sec(S.type) && t < sec(S.hero)) || t >= sec(S.end)) return 0; // no arp
  if (t >= sec(S.xray) && t < sec(S.calib)) return 1; // quarters
  if (t >= sec(S.hero)) return t > sec(S.hero) + 3 ? 4 : 2; // 16ths into the build
  return 2; // eighths
};

const music = stereo();
// pads: 3 detuned saws per note, 2-pole low-pass, per-chord crossfade, gentle pump on the beat
{
  const phases: number[] = new Array(64).fill(0).map(() => Math.random() * 0 + 0);
  let l1L = 0, l2L = 0, l1R = 0, l2R = 0;
  const detune = [-0.07, 0, 0.08];
  for (let i = 0; i < LEN; i++) {
    const t = i / SR;
    const ch = chordAt(t);
    const chPrev = chordAt(Math.max(0, t - 0.9));
    const xf = t >= T(S.end) ? Math.min(1, (t - T(S.end)) / 0.9) : Math.min(1, (t % 4) / 0.9);
    let sL = 0, sR = 0, p = 0;
    for (const [set, w] of [[ch, xf], [chPrev, 1 - xf]] as const) {
      if (w <= 0.001) { p += set.notes.length * 3; continue; }
      set.notes.forEach((m, ni) => {
        detune.forEach((d, di) => {
          const idx = (p++) % 64;
          phases[idx] = (phases[idx] + mtof(m + d) / SR) % 1;
          const v = (phases[idx] * 2 - 1) * w;
          if (di === 0) sL += v; else if (di === 2) sR += v; else { sL += v * 0.7; sR += v * 0.7; }
          void ni;
        });
      });
    }
    const beatPh = (t % BEAT_S) / BEAT_S;
    const pump = t > sec(S.matter) && t < sec(S.end) ? 1 - 0.28 * Math.exp(-beatPh * 6) : 1;
    const fc = cutoffAt(t);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
    l1L += (sL - l1L) * a; l2L += (l1L - l2L) * a;
    l1R += (sR - l1R) * a; l2R += (l1R - l2R) * a;
    let lvl = padLevel(t) * pump * 0.035;
    if (t >= T(S.end)) lvl *= Math.max(0, 1 - Math.max(0, t - (T(FILM_LEN) - 3)) / 3); // fade out the tail
    music.L[i] += l2L * lvl;
    music.R[i] += l2R * lvl;
  }
}
// sub pulse on every beat (half time in the type breakdown), root of the chord, stops at the end card
for (let b = 0; b * BEAT_S < T(FILM_LEN); b++) {
  const t = b * BEAT_S;
  if (t < sec(S.matter) || t >= sec(S.end)) continue;
  if (t >= sec(S.type) && t < sec(S.hero) && b % 2) continue;
  const f0 = mtof(chordAt(t).root - 12);
  const n = Math.floor(SR * 0.42), buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.sin(2 * Math.PI * f0 * (i / SR)) * Math.exp(-(i / SR) * 7) * Math.min(1, i / 60);
  addMono(music, t, buf, 0.32 * (t > sec(S.hero) ? 1.15 : 1), 0);
}
// soft pluck arpeggio with a ping-pong dotted-eighth delay
const arpDry = stereo();
{
  let step = 0;
  for (let t = sec(S.macro); t < T(FILM_LEN); ) {
    const rate = arpRate(t);
    const dt = rate ? BEAT_S / rate : BEAT_S;
    if (rate) {
      const ch = chordAt(t);
      const pool = [...ch.notes, ...ch.notes.map((m) => m + 12)];
      const lift = t > sec(S.air) && t < sec(S.app) ? 12 : 0;
      const m = pool[[0, 2, 4, 1, 3, 5, 7, 6][step % 8] % pool.length] + lift;
      const fr = mtof(m);
      const n = Math.floor(SR * 0.5), buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const tt = i / SR;
        buf[i] = (Math.sin(2 * Math.PI * fr * tt) + 0.25 * Math.sin(4 * Math.PI * fr * tt) * Math.exp(-tt * 20)) * Math.exp(-tt * 7) * Math.min(1, i / 40);
      }
      const acc = step % 4 === 0 ? 1 : 0.7;
      const build = t > sec(S.hero) ? 1 + ramp(t, sec(S.hero), sec(S.end)) * 0.4 : 1;
      addMono(arpDry, t, buf, 0.05 * acc * build, step % 2 ? 0.25 : -0.25);
      step++;
    }
    t = Math.round((t + dt) * 1e6) / 1e6;
  }
  const D = Math.round(SR * 0.375);
  const dl = new Float32Array(LEN), dr = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const inL = arpDry.L[i], inR = arpDry.R[i];
    dl[i] = inR + (i >= D ? dr[i - D] * 0.38 : 0);
    dr[i] = inL + (i >= D ? dl[i - D] * 0.38 : 0);
    music.L[i] += inL + (i >= D ? dl[i - D] * 0.32 : 0);
    music.R[i] += inR + (i >= D ? dr[i - D] * 0.32 : 0);
  }
}
// hats: very soft 16ths through the middle, plus the build
for (let b16 = 0; b16 * 0.125 < T(FILM_LEN); b16++) {
  const t = b16 * 0.125;
  const on = (t > sec(S.grille) && t < sec(S.xray)) || (t > sec(S.air) && t < sec(S.type)) || (t > sec(S.hero) && t < sec(S.end));
  if (!on) continue;
  addMono(music, t, voice("hat", () => tick(2.2)), (b16 % 4 === 2 ? 0.035 : 0.018) * (t > sec(S.hero) ? 1 + ramp(t, sec(S.hero), sec(S.end)) : 1), b16 % 2 ? 0.3 : -0.3);
}
// build riser into the end card, then a soft bell chord on the resolve
addMono(music, T(S.end) - 5, riser(5), 0.12, 0);
{
  const n = Math.floor(SR * 6), buf = new Float32Array(n);
  for (const m of RESOLVE.notes.map((x) => x + 12)) for (let i = 0; i < n; i++) buf[i] += Math.sin(2 * Math.PI * mtof(m) * (i / SR)) * Math.exp(-(i / SR) * 0.8) * 0.2;
  addMono(music, T(S.end), buf, 0.12, 0);
}
// simple stereo room on the music bus (4 combs + 2 allpasses per side)
{
  const combs = [1116, 1188, 1277, 1356], ap = [556, 441];
  const verb = (x: Float32Array, spread: number) => {
    const out = new Float32Array(LEN);
    for (const c of combs) {
      const d = c + spread, buf = new Float32Array(d);
      let k = 0, lp = 0;
      for (let i = 0; i < LEN; i++) {
        const y = buf[k];
        lp = y * 0.6 + lp * 0.4;
        buf[k] = x[i] + lp * 0.8;
        out[i] += y * 0.25;
        k = (k + 1) % d;
      }
    }
    for (const a of ap) {
      const d = a + spread, buf = new Float32Array(d);
      let k = 0;
      for (let i = 0; i < LEN; i++) {
        const b = buf[k], y = -out[i] + b;
        buf[k] = out[i] + b * 0.5;
        out[i] = y;
        k = (k + 1) % d;
      }
    }
    return out;
  };
  const wl = verb(music.L, 0), wr = verb(music.R, 23);
  for (let i = 0; i < LEN; i++) {
    music.L[i] += wl[i] * 0.22;
    music.R[i] += wr[i] * 0.22;
  }
}

// ---------- VO stem ----------
const readWav = (file: string): Stereo => {
  const b = fs.readFileSync(file);
  let o = 12, dataOff = 0, ch = 2, bits = 16;
  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "fmt ") { ch = b.readUInt16LE(o + 10); bits = b.readUInt16LE(o + 22); }
    if (id === "data") { dataOff = o + 8; break; }
    o += 8 + sz;
  }
  if (bits !== 16) throw new Error("expected 16-bit wav");
  const out = stereo();
  const frames = Math.min(LEN, Math.floor((b.length - dataOff) / (2 * ch)));
  for (let i = 0; i < frames; i++) {
    out.L[i] = b.readInt16LE(dataOff + i * 2 * ch) / 32768;
    out.R[i] = ch > 1 ? b.readInt16LE(dataOff + i * 2 * ch + 2) / 32768 : out.L[i];
  }
  return out;
};
const voTmp = path.join(root, "voice/work/vo16.wav");
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", path.join(root, "public/vo-film.wav"), "-ac", "2", "-ar", String(SR), "-c:a", "pcm_s16le", voTmp]);
const voS = readWav(voTmp);

// ---------- ducking: VO has priority. 80 ms attack (reached at speech onset), 300 ms release ----------
const env = new Float32Array(LEN);
for (const w of voWin) {
  const a0 = Math.round((w.a - 0.08) * SR), a1 = Math.round(w.a * SR), b0 = Math.round(w.b * SR), b1 = Math.round((w.b + 0.3) * SR);
  for (let i = Math.max(0, a0); i < Math.min(LEN, b1); i++) {
    let v = 1;
    if (i < a1) v = 0.5 - 0.5 * Math.cos((Math.PI * (i - a0)) / (a1 - a0));
    else if (i > b0) v = 0.5 + 0.5 * Math.cos((Math.PI * (i - b0)) / (b1 - b0));
    env[i] = Math.max(env[i], v);
  }
}
const db = (x: number) => Math.pow(10, x / 20);
const MUSIC_DUCK = db(-9), SFX_DUCK = db(-6);

// ---------- write, measure, normalise ----------
const writeWav = (file: string, s: Stereo, gain = 1) => {
  const buf = Buffer.alloc(44 + LEN * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + LEN * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(LEN * 4, 40);
  for (let i = 0; i < LEN; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s.L[i] * gain)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s.R[i] * gain)) * 32767), 46 + i * 4);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
};
/** 32-bit float WAV for stems: no clipping, and they sum back to the mix before the limiter. */
const writeWavF = (file: string, s: Stereo, gain = 1) => {
  const buf = Buffer.alloc(58 + LEN * 8);
  buf.write("RIFF", 0); buf.writeUInt32LE(50 + LEN * 8, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(18, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34); buf.writeUInt16LE(0, 36);
  buf.write("data", 38); buf.writeUInt32LE(LEN * 8, 42);
  for (let i = 0; i < LEN; i++) {
    buf.writeFloatLE(s.L[i] * gain, 46 + i * 8);
    buf.writeFloatLE(s.R[i] * gain, 50 + i * 8);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf.subarray(0, 46 + LEN * 8));
};
const measure = (file: string) => {
  const o = execFileSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  return o;
};
const lufs = (file: string) => {
  const r = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i "${file}" -af ebur128=peak=true -f null - 2>&1 | tail -24`]).toString();
  const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(r)?.[1]);
  const TP = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(r)?.[1]);
  return { I, TP };
};
void measure;

/** Build a bus, normalise to -16 LUFS, then a look-ahead peak limiter to keep true peak under -1 dBTP. */
const master = (parts: Array<{ s: Stereo; g: (i: number) => number }>, name: string, ceilDb = -1.8) => {
  const out = stereo();
  for (const p of parts) for (let i = 0; i < LEN; i++) { const g = p.g(i); out.L[i] += p.s.L[i] * g; out.R[i] += p.s.R[i] * g; }
  const tmp = path.join(root, `voice/work/${name}-pre.wav`);
  // pre-scale so nothing clips in the 16-bit temp
  let pk = 0; for (let i = 0; i < LEN; i++) pk = Math.max(pk, Math.abs(out.L[i]), Math.abs(out.R[i]));
  const pre = 0.5 / pk;
  writeWav(tmp, out, pre);
  const m = lufs(tmp);
  const gain = pre * db(-16 - m.I);
  for (let i = 0; i < LEN; i++) { out.L[i] *= gain; out.R[i] *= gain; }
  // limiter: 1.5 ms look-ahead, ceiling -1.5 dBFS sample peak (true peak lands just under -1)
  const ceil = db(ceilDb), look = Math.round(0.0015 * SR), rel = Math.exp(-1 / (0.08 * SR));
  let gr = 1;
  const need = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) { const a = Math.max(Math.abs(out.L[i]), Math.abs(out.R[i])); need[i] = a > ceil ? ceil / a : 1; }
  for (let i = 0; i < LEN; i++) {
    let target = 1;
    for (let k = 0; k <= look && i + k < LEN; k++) target = Math.min(target, need[i + k]);
    gr = target < gr ? target : 1 - (1 - gr) * rel;
    out.L[i] *= gr; out.R[i] *= gr;
  }
  return { out, gain };
};

// VO cut: VO + ducked music + ducked SFX
const levels = { vo: 1.0, music: 0.9, sfx: 0.7 };
/** Master, then re-limit with a lower ceiling until the measured true peak is under -1.2 dBTP. */
const masterTP = (parts: Array<{ s: Stereo; g: (i: number) => number }>, name: string, file: string) => {
  let ceilDb = -1.8, r = master(parts, name, ceilDb);
  for (let it = 0; it < 4; it++) {
    writeWav(file, r.out);
    const m = lufs(file);
    if (m.TP <= -1.2) break;
    ceilDb -= m.TP + 1.4;
    r = master(parts, name, ceilDb);
  }
  return r;
};
const mVO = masterTP([
  { s: voS, g: () => levels.vo },
  { s: music, g: (i) => levels.music * (1 - env[i] * (1 - MUSIC_DUCK)) },
  { s: sfx, g: (i) => levels.sfx * (1 - env[i] * (1 - SFX_DUCK)) },
], "vo", path.join(root, "public/mix-film-vo.wav"));
// stems at the same gain as the VO mix (they sum to it before limiting)
writeWavF(path.join(root, "out/stems/vo.wav"), { L: voS.L.map((x) => x * levels.vo), R: voS.R.map((x) => x * levels.vo) }, mVO.gain);
writeWavF(path.join(root, "out/stems/music.wav"), { L: music.L.map((x, i) => x * levels.music * (1 - env[i] * (1 - MUSIC_DUCK))), R: music.R.map((x, i) => x * levels.music * (1 - env[i] * (1 - MUSIC_DUCK))) }, mVO.gain);
writeWavF(path.join(root, "out/stems/sfx.wav"), { L: sfx.L.map((x, i) => x * levels.sfx * (1 - env[i] * (1 - SFX_DUCK))), R: sfx.R.map((x, i) => x * levels.sfx * (1 - env[i] * (1 - SFX_DUCK))) }, mVO.gain);
// no-VO cut: music + SFX, no ducking
masterTP([{ s: music, g: () => levels.music }, { s: sfx, g: () => levels.sfx }], "novo", path.join(root, "public/mix-film-novo.wav"));

// cue sheet
const lines = ["frame,time_s,kind,label,gain,in_mix"];
for (const c of cues) lines.push(`${c.f},${T(c.f).toFixed(3)},${c.kind},${c.label},${c.gain},${kept.includes(c) ? "yes" : "thinned (under VO)"}`);
for (const l of vo.lines) lines.push(`${l.f},${T(l.f).toFixed(3)},vo,"${l.text}",,${l.seconds}s`);
fs.writeFileSync(path.join(root, "out/cue-sheet.csv"), lines.join("\n") + "\n");

const a = lufs(path.join(root, "public/mix-film-vo.wav")), b = lufs(path.join(root, "public/mix-film-novo.wav"));
console.log(`VO mix:    ${a.I} LUFS, true peak ${a.TP} dBTP`);
console.log(`no-VO mix: ${b.I} LUFS, true peak ${b.TP} dBTP`);
console.log(`cues: ${cues.length} (${cues.length - kept.length} thinned under VO); ${report.length ? report.join("\n") : "no collisions or overlaps"}`);
