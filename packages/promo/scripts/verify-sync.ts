// Sync check. For every verified cue: (1) the frame the picture makes contact (solved from the hand choreography
// and the director), (2) the frame the sound's transient actually lands in an audio file. Reports offsets in frames.
// usage: node scripts/verify-sync.mjs [audio.wav]   (built with esbuild, see package.json "verify")
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildCues, DOT_TAP, LOGO_FLASH, END_DOT } from "../src/cues";
import { filmHand, lidDeltaAt } from "../src/three/hand/scenes";
import { J } from "../src/three/hand/handPose";
import { ZONES, FPS } from "../src/timeline";
import { VO_LINES } from "../src/voScript";

const SR = 44100;
const file = process.argv[2] ?? "out/stems/sfx.wav";
const voFile = process.argv[3] ?? "out/stems/vo.wav";
const toMono = (f: string, hp = 0) => {
  const tmp = `voice/work/verify-${Math.abs(f.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))}.raw`;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", f, "-ac", "1", "-ar", String(SR), ...(hp ? ["-af", `highpass=f=${hp}`] : []), "-f", "f32le", tmp]);
  const b = fs.readFileSync(tmp);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};
const x = toMono(file, file.endsWith(".mp4") ? 120 : 0);

// 1 ms RMS envelope (exact millisecond boundaries, so there is no cumulative drift)
const env = new Float32Array(Math.floor((x.length / SR) * 1000));
for (let i = 0; i < env.length; i++) {
  const a = Math.floor((i * SR) / 1000), b = Math.floor(((i + 1) * SR) / 1000);
  let s = 0;
  for (let k = a; k < b; k++) s += x[k] ** 2;
  env[i] = Math.sqrt(s / (b - a));
}
// high-passed envelope for the noise whooshes (keeps low thump tails out of the measurement)
const xh = toMono(file, 2500);
const envH = new Float32Array(env.length);
for (let i = 0; i < envH.length; i++) {
  const a = Math.floor((i * SR) / 1000), b = Math.floor(((i + 1) * SR) / 1000);
  let s = 0;
  for (let k = a; k < b; k++) s += xh[k] ** 2;
  envH[i] = Math.sqrt(s / (b - a));
}
const ms = (f: number) => Math.round((f / FPS) * 1000);
/** transient onset: first ms in the window where the envelope rises past 30 % of the window peak */
const onsetMs = (f: number, before = 2, after = 5) => {
  const a = ms(f - before), b = ms(f + after);
  let peak = 0;
  for (let i = a; i <= b && i < env.length; i++) peak = Math.max(peak, env[i]);
  for (let i = a; i <= b; i++) if (env[i] >= 0.3 * peak) return i;
  return NaN;
};
const peakMs = (f: number, w = 4) => {
  let best = -1, at = NaN;
  for (let i = ms(f - w); i <= ms(f + w); i++) if (envH[i] > best) { best = envH[i]; at = i; }
  return at;
};

// visual event frames from the choreography
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const jt = (j: Float32Array, i: number) => [j[i * 3], j[i * 3 + 1], j[i * 3 + 2]];
const firstMin = (f: number, m: (g: number) => number, w = 10) => {
  let lo = Infinity;
  for (let g = f - w; g <= f + w; g++) lo = Math.min(lo, m(g));
  for (let g = f - w; g <= f + w; g++) if (m(g) <= lo + 0.02) return g;
  return NaN;
};
const visual = (label: string, f: number): number | string => {
  const h = (g: number) => filmHand(g)?.joints;
  if (/^(palm|grille|top)/.test(label) && h(f)) {
    return firstMin(f, (g) => { const j = h(g); if (!j) return 99; let lo = 99; for (let i = 0; i < 21; i++) lo = Math.min(lo, j[i * 3 + 1]); return lo; }, 3);
  }
  if (!h(f) && /^(palm|grille|top)/.test(label)) return "ripple at cue (inside view)";
  if (label.startsWith("sensor")) return firstMin(f, (g) => { const j = h(g); return j ? dist([(j[0] + j[J.M_MCP * 3]) / 2, (j[1] + j[J.M_MCP * 3 + 1]) / 2, (j[2] + j[J.M_MCP * 3 + 2]) / 2], ZONES.sensor.p) : 99; }, 14);
  if (label.startsWith("lid")) { for (let g = f - 10; g <= f + 10; g++) if (lidDeltaAt(g + 1) > 1e-6) return g; return NaN; }
  if (label.includes("Pinch")) return firstMin(f, (g) => { const j = h(g); return j ? dist(jt(j, J.I_TIP), jt(j, J.T_TIP)) : 99; }, 12);
  if (label.includes("Swipe")) { let best = 0, at = NaN; for (let g = f - 12; g <= f + 12; g++) { const a = h(g), b = h(g + 1); if (a && b) { const v = Math.abs(b[0] - a[0]); if (v > best) { best = v; at = g; } } } return at; }
  if (label.startsWith("sonar")) return firstMin(f, (g) => { const j = h(g); return j ? (j[1] + j[J.M_MCP * 3 + 1]) / 2 : 99; }, 14);
  if (label === "dot tap") return DOT_TAP;
  if (label === "logo flash") return LOGO_FLASH;
  if (label === "end card dot") return END_DOT;
  if (label.startsWith("cut") || label === "shatter") return f;
  return "n/a";
};

let worstAudio = 0, worstVisual = 0;
const rows: string[] = [];
for (const c of buildCues().filter((c) => c.verify)) {
  const aMs = c.kind === "whoosh" ? peakMs(c.f) : c.kind === "impact" ? onsetMs(c.f, 2, 3) : onsetMs(c.f);
  const aOff = aMs / 1000 * FPS - c.f;
  const v = visual(c.label, c.f);
  const vOff = typeof v === "number" ? v - c.f : typeof v === "string" && v.startsWith("ripple") ? 0 : NaN;
  if (Number.isFinite(aOff)) worstAudio = Math.max(worstAudio, Math.abs(aOff));
  if (Number.isFinite(vOff)) worstVisual = Math.max(worstVisual, Math.abs(vOff));
  rows.push(`${String(c.f).padStart(5)}  ${c.kind.padEnd(6)} ${c.label.padEnd(26)} audio ${Number.isFinite(aOff) ? (aOff >= 0 ? "+" : "") + aOff.toFixed(2) : "  n/a"} fr   picture ${typeof v === "number" ? (vOff >= 0 ? "+" : "") + vOff : v}`);
}
console.log(rows.join("\n"));
console.log(`\nmax |audio - cue| = ${worstAudio.toFixed(2)} frames (${(worstAudio / FPS * 1000).toFixed(1)} ms); max |picture contact - cue| = ${worstVisual} frames`);

// VO: speech onset vs its beat
if (fs.existsSync(voFile) && !file.endsWith(".mp4")) {
  const v = toMono(voFile);
  let worst = 0;
  for (const l of VO_LINES) {
    const a = Math.round((l.f / FPS) * SR);
    let i = a - SR * 0.2;
    while (i < a + SR * 0.5 && Math.abs(v[i]) < 0.01) i++;
    const off = ((i - a) / SR) * FPS;
    worst = Math.max(worst, Math.abs(off));
  }
  console.log(`VO lines: max |speech onset - beat| = ${worst.toFixed(2)} frames`);
}
