// Voiceover: ElevenLabs when a key is available (ELEVENLABS_API_KEY or .env), cached by input hash;
// otherwise the best local macOS voice (Premium/Enhanced English if installed, else Samantha).
// Each line is processed (high-pass, gentle compression, subtle room), placed on the beat grid,
// Outputs: public/vo-film.wav (the placed voice stem) and public/vo-lines.json. scripts/mix.ts does the mix.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadKey, tts, totalUsage } from "./elevenlabs.ts";
import { VO_LINES, VO_MODEL, VO_SETTINGS, VO_VOICE } from "../src/voScript.ts";
import { FILM_LEN, FPS } from "../src/timeline.ts";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const tmp = path.join(root, "voice/work");
fs.mkdirSync(tmp, { recursive: true });
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...a]);
const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

const pickSayVoice = () => {
  const list = execFileSync("say", ["-v", "?"]).toString().split("\n");
  const en = list.filter((l) => /\sen_(US|GB|AU|IE)\s/.test(l)).map((l) => l.split(/\s{2,}/)[0].trim());
  const pref = ["Zoe (Premium)", "Ava (Premium)", "Evan (Premium)", "Nathan (Premium)", "Zoe (Enhanced)", "Ava (Enhanced)", "Evan (Enhanced)"];
  return pref.find((p) => en.includes(p)) ?? en.find((n) => /Premium|Enhanced/.test(n)) ?? (en.includes("Samantha") ? "Samantha" : en[0]);
};

const key = loadKey();
const useEleven = !!key;
const sayVoice = useEleven ? null : pickSayVoice();
const engine = useEleven ? `ElevenLabs ${VO_VOICE.name} / ${VO_MODEL}` : `macOS say: ${sayVoice}`;

const placed: Array<{ f: number; text: string; file: string; seconds: number }> = [];
for (const [i, line] of VO_LINES.entries()) {
  const raw = path.join(tmp, `raw-${i}.wav`);
  if (useEleven) {
    const r = await tts(key, VO_VOICE.id, VO_MODEL, line.text, VO_SETTINGS);
    ff("-i", r.file, "-ar", "48000", "-ac", "1", raw);
  } else {
    const aiff = path.join(tmp, `say-${i}.aiff`);
    execFileSync("say", ["-v", sayVoice!, "-r", "168", "-o", aiff, line.text]);
    ff("-i", aiff, "-ar", "48000", "-ac", "1", raw);
  }
  // trim edge silence, high-pass, gentle compression, a touch of presence, subtle small-room reflections
  const proc = path.join(tmp, `line-${i}.wav`);
  ff(
    "-i", raw, "-af",
    [
      "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02",
      "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08,areverse",
      "highpass=f=85",
      "equalizer=f=220:t=q:w=1.2:g=-1.5",
      "equalizer=f=4200:t=q:w=1.5:g=1.2",
      "acompressor=threshold=-20dB:ratio=2.5:attack=8:release=160:makeup=2",
      "aecho=0.9:0.5:18|31:0.12|0.07",
      "loudnorm=I=-18:TP=-2:LRA=7",
    ].join(","),
    "-ar", "48000", "-ac", "1", proc
  );
  placed.push({ f: line.f, text: line.text, file: proc, seconds: dur(proc) });
}

// check no line runs into the next
placed.forEach((p, i) => {
  const next = placed[i + 1];
  const end = p.f / FPS + p.seconds;
  if (next && end > next.f / FPS - 0.15) console.warn(`warning: line ${i + 1} ends at ${end.toFixed(2)} s, next starts ${(next.f / FPS).toFixed(2)} s`);
});

// place lines on the timeline
const total = FILM_LEN / FPS;
const vo = path.join(root, "public/vo-film.wav");
const inputs = placed.flatMap((p) => ["-i", p.file]);
const delays = placed.map((p, i) => `[${i}:a]adelay=${Math.round((p.f / FPS) * 1000)}:all=1[v${i}]`).join(";");
const mixIn = placed.map((_, i) => `[v${i}]`).join("");
ff(...inputs, "-filter_complex", `${delays};${mixIn}amix=inputs=${placed.length}:normalize=0,apad,atrim=0:${total},pan=stereo|c0=c0|c1=c0[out]`, "-map", "[out]", "-ar", "44100", vo);

fs.writeFileSync(
  path.join(root, "public/vo-lines.json"),
  JSON.stringify({ engine, lines: placed.map((p) => ({ f: p.f, text: p.text, seconds: +p.seconds.toFixed(2) })) }, null, 2)
);
console.log(`voice: ${engine}`);
for (const p of placed) console.log(`  ${String(p.f).padStart(4)}  ${p.seconds.toFixed(2)}s  ${p.text}`);
console.log("elevenlabs usage so far", JSON.stringify(totalUsage()));
