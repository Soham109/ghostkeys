import { SIGNAL, FONT, MONO, ink, roundRect, dim, caption, chip } from "./kit";

/** What the screen shows while sound mode listens. Written by SoundScene each frame. */
export type SoundUI = {
  id: string;
  weight: number;
  /** last classified hit */
  kind: "knuckle" | "fingertip";
  /** real time of the last hit, seconds (now()) */
  hitT: number;
  /** rub energy 0..1 */
  energy: number;
  /** hand wave: lateral velocity (units per second) and nearness 0..1 */
  vel: number;
  near: number;
};

export const makeSoundUI = (): SoundUI => ({ id: "", weight: 0, kind: "knuckle", hitT: -10, energy: 0, vel: 0, near: 0 });

function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string) {
  g.fillStyle = "#1b1b1e";
  roundRect(g, x, y, w, h, 10);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.08)";
  g.lineWidth = 1;
  g.stroke();
  g.font = `500 9px ${MONO}`;
  g.fillStyle = ink(0.4);
  g.fillText(title, x + 18, y + 24);
}

function hits(g: CanvasRenderingContext2D, w: number, h: number, u: SoundUI, now: number) {
  const x = 120, y = 92, pw = w - 240, ph = h - 200;
  panel(g, x, y, pw, ph, "MICROPHONE  ON-DEVICE");
  const age = now - u.hitT;
  const k = u.kind === "knuckle";
  // waveform: noise floor, then the last hit's shape frozen where it landed
  const wx = x + 24, ww = pw * 0.62, wy = y + ph / 2 + 8;
  g.strokeStyle = ink(0.8);
  g.lineWidth = 1.2;
  g.beginPath();
  const amp = age < 3 ? Math.max(0.35, Math.exp(-age * 0.8)) : 0;
  for (let i = 0; i <= 240; i++) {
    const s = i / 240;
    const tt = s * 240 - 60;
    let v = Math.sin(i * 1.7 + now * 30) * 0.02 + Math.sin(i * 0.53 + now * 11) * 0.015;
    if (tt > 0) {
      v += k
        ? Math.sin(tt * 1.25) * Math.exp(-tt / 16) * 0.9 * amp
        : Math.sin(tt * 0.32) * Math.exp(-tt / 55) * 0.55 * amp * Math.min(1, tt / 6);
    }
    const px = wx + s * ww, py = wy - v * (ph * 0.36);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
  // spectrum: knuckle rings high, fingertip thumps low
  const sx = x + pw * 0.7, sw = pw * 0.25, bars = 22;
  for (let i = 0; i < bars; i++) {
    const f = i / (bars - 1);
    const shape = k ? Math.exp(-Math.pow((f - 0.72) / 0.22, 2)) : Math.exp(-Math.pow((f - 0.18) / 0.2, 2));
    const hh = 6 + shape * 90 * amp + Math.abs(Math.sin(i * 3.1 + now * 9)) * 5;
    g.fillStyle = ink(0.25 + shape * 0.55 * amp);
    g.fillRect(sx + i * (sw / bars), wy + 40 - hh, sw / bars - 3, hh);
  }
  g.font = `500 9px ${MONO}`;
  g.fillStyle = ink(0.35);
  g.fillText("LOW", sx, wy + 58);
  g.textAlign = "right";
  g.fillText("HIGH", sx + sw, wy + 58);
  g.textAlign = "left";
  // verdict
  g.font = `400 30px ${FONT}`;
  g.fillStyle = ink(age < 3 ? 0.95 : 0.3);
  g.fillText(k ? "Knuckle" : "Fingertip", x + 24, y + 64);
  if (age >= 0 && age < 0.9) {
    g.globalAlpha *= 1 - age / 0.9;
    g.fillStyle = SIGNAL;
    g.beginPath();
    g.arc(x + 24 + g.measureText(k ? "Knuckle" : "Fingertip").width + 14, y + 54, 4, 0, Math.PI * 2);
    g.fill();
  }
}

function rub(g: CanvasRenderingContext2D, w: number, h: number, u: SoundUI, now: number) {
  const x = 120, y = 92, pw = w - 240, ph = h - 200;
  panel(g, x, y, pw, ph, "MICROPHONE  ON-DEVICE");
  g.font = `400 30px ${FONT}`;
  g.fillStyle = ink(0.95);
  g.fillText("Rub", x + 24, y + 64);
  const bars = 64, bx = x + 24, bw = pw - 48, base = y + ph - 40;
  for (let i = 0; i < bars; i++) {
    const harm = i % 7 === 3 ? 1 / (1 + Math.floor(i / 7) * 0.35) : 0.08;
    const hh = 3 + harm * 150 * u.energy * (0.85 + 0.15 * Math.sin(now * 23 + i)) + Math.abs(Math.sin(i * 2.3 + now * 7)) * 3;
    g.fillStyle = ink(harm > 0.2 ? 0.85 : 0.25);
    g.fillRect(bx + i * (bw / bars), base - hh, bw / bars - 3, hh);
  }
  g.font = `500 9px ${MONO}`;
  g.fillStyle = ink(0.35);
  g.fillText("EVENLY SPACED HARMONICS", bx, base + 18);
}

function wave(g: CanvasRenderingContext2D, w: number, h: number, u: SoundUI, now: number) {
  const x = 120, y = 92, pw = w - 240, ph = h - 200;
  panel(g, x, y, pw, ph, "SPEAKER 20 KHZ  MICROPHONE ECHO");
  g.font = `400 30px ${FONT}`;
  g.fillStyle = ink(0.95);
  g.fillText("Hand wave", x + 24, y + 64);
  const bx = x + 24, bw = pw - 48, base = y + ph - 44;
  const shift = Math.max(-1, Math.min(1, u.vel * 0.8));
  g.strokeStyle = ink(0.85);
  g.lineWidth = 1.3;
  g.beginPath();
  for (let i = 0; i <= 300; i++) {
    const f = i / 300;
    const carrier = Math.exp(-Math.pow((f - 0.5) / 0.008, 2));
    const side = Math.exp(-Math.pow((f - 0.5 - shift * 0.12) / 0.03, 2)) * u.near * 0.45;
    const v = carrier * 0.95 + side + Math.abs(Math.sin(i * 7.7 + now * 13)) * 0.015;
    const px = bx + f * bw, py = base - v * (ph - 130);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
  g.font = `500 9px ${MONO}`;
  g.fillStyle = ink(0.35);
  g.fillText("18 KHZ", bx, base + 18);
  g.textAlign = "center";
  g.fillText("20 KHZ", bx + bw / 2, base + 18);
  g.textAlign = "right";
  g.fillText("22 KHZ", bx + bw, base + 18);
  g.textAlign = "left";
}

const CAPTION: Record<string, [string, string]> = {
  knuckle: ["SOUND MODE", "KNUCKLE OR FINGERTIP"],
  fingertip: ["SOUND MODE", "KNUCKLE OR FINGERTIP"],
  rub: ["SOUND MODE", "RUB THE GRILLE"],
  wave: ["SOUND MODE", "WAVE A HAND"],
};

export function soundOverlay(u: SoundUI) {
  return (g: CanvasRenderingContext2D, w: number, h: number, now: number) => {
    if (u.weight <= 0.001) return;
    g.globalAlpha = u.weight;
    dim(g, w, h, 1);
    if (u.id === "rub") rub(g, w, h, u, now);
    else if (u.id === "wave") wave(g, w, h, u, now);
    else hits(g, w, h, u, now);
    g.globalAlpha = u.weight;
    chip(g, w, "MIC  ON-DEVICE");
    const [l, r] = CAPTION[u.id] ?? CAPTION.knuckle;
    const age = now - u.hitT;
    caption(g, w, h, l, r, u.id === "knuckle" || u.id === "fingertip" ? Math.max(0, 1 - age / 0.9) : 0);
    g.globalAlpha = 1;
  };
}
