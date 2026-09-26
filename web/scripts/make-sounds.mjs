// Synthesizes the UI sound sprite (tick, thump, swell) and encodes it with ffmpeg. Output: public/audio/ui.{webm,mp3}
import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SR = 44100;
const seg = (sec) => new Float32Array(Math.round(sec * SR));
const tick = seg(0.06);
for (let i = 0; i < tick.length; i++) {
  const t = i / SR;
  tick[i] = (Math.sin(2 * Math.PI * 3200 * t) * 0.5 + (Math.random() - 0.5) * 0.4) * Math.exp(-t * 140);
}
const thump = seg(0.32);
for (let i = 0; i < thump.length; i++) {
  const t = i / SR;
  const f = 70 + 90 * Math.exp(-t * 30);
  thump[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 16) * 0.9 + (Math.random() - 0.5) * 0.25 * Math.exp(-t * 90);
}
const swell = seg(1.9);
let lp = 0;
for (let i = 0; i < swell.length; i++) {
  const t = i / SR;
  const env = Math.sin(Math.PI * Math.min(1, t / 1.9)) ** 2;
  lp += 0.02 * ((Math.random() - 0.5) - lp);
  swell[i] = (lp * 3.5 + Math.sin(2 * Math.PI * 220 * t) * 0.05 + Math.sin(2 * Math.PI * 330.5 * t) * 0.03) * env * 0.8;
}
const gap = seg(0.2);
const parts = [tick, gap, thump, gap, swell];
const total = parts.reduce((a, p) => a + p.length, 0);
const pcm = Buffer.alloc(44 + total * 2);
pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + total * 2, 4); pcm.write("WAVE", 8); pcm.write("fmt ", 12);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(SR, 24);
pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(total * 2, 40);
let o = 44;
const offsets = {};
let ms = 0;
const names = ["tick", null, "thump", null, "swell"];
parts.forEach((p, k) => {
  if (names[k]) offsets[names[k]] = [Math.round(ms), Math.round((p.length / SR) * 1000)];
  ms += (p.length / SR) * 1000;
  for (const s of p) { pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), o); o += 2; }
});
const dir = mkdtempSync(join(tmpdir(), "gk-"));
const wav = join(dir, "ui.wav");
writeFileSync(wav, pcm);
const out = new URL("../public/audio/", import.meta.url).pathname;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "48k", out + "ui.webm"]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libmp3lame", "-b:a", "64k", out + "ui.mp3"]);
writeFileSync(out + "sprite.json", JSON.stringify(offsets));
console.log(offsets);
