import { SIGNAL, FONT, MONO, ink, roundRect, dim, windowFrame, bodyLines, caption, chip } from "./kit";

/** What the laptop screen shows in answer to the air gesture. Written by AirGestureScene each frame. */
export type AirUI = {
  id: string;
  weight: number;
  /** 0..1 pinch closure */
  pinch: number;
  /** 0..1 flash at the moment the pinch closes */
  flash: number;
  /** drag offset in -1..1 (x right, y up) */
  dx: number;
  dy: number;
  /** desktops scrolled, 0..1 */
  swipe: number;
  /** dial value 0..1 */
  dial: number;
  /** zoom factor, 1 = rest */
  zoom: number;
  /** circle knob turns so far */
  turns: number;
  /** pointer in 0..1 screen space */
  px: number;
  py: number;
  dir: string;
};

export const makeAirUI = (): AirUI => ({ id: "", weight: 0, pinch: 0, flash: 0, dx: 0, dy: 0, swipe: 0, dial: 0.4, zoom: 1, turns: 0, px: 0.5, py: 0.5, dir: "" });

function grabCursor(g: CanvasRenderingContext2D, x: number, y: number, pinch: number, flash: number) {
  g.strokeStyle = ink(0.9);
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(x, y, 11 - pinch * 5, 0, Math.PI * 2);
  g.stroke();
  if (pinch > 0.9) {
    g.fillStyle = flash > 0.05 ? SIGNAL : ink(0.9);
    g.beginPath();
    g.arc(x, y, 3.2, 0, Math.PI * 2);
    g.fill();
  }
  if (flash > 0.02) {
    g.globalAlpha *= flash;
    g.strokeStyle = SIGNAL;
    g.beginPath();
    g.arc(x, y, 12 + (1 - flash) * 22, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
  }
}

function pinchDrag(g: CanvasRenderingContext2D, w: number, h: number, u: AirUI) {
  const ww = 440, wh = 280;
  const x = w / 2 - ww / 2 + u.dx * 250;
  const y = h / 2 - wh / 2 + 14 - u.dy * 150;
  if (Math.abs(u.dx) + Math.abs(u.dy) > 0.02) {
    g.setLineDash([4, 4]);
    g.strokeStyle = ink(0.16);
    roundRect(g, w / 2 - ww / 2, h / 2 - wh / 2 + 14, ww, wh, 10);
    g.stroke();
    g.setLineDash([]);
  }
  const lift = u.pinch;
  const s = 1 + lift * 0.025;
  g.save();
  g.translate(x + ww / 2, y + wh / 2);
  g.scale(s, s);
  g.translate(-(x + ww / 2), -(y + wh / 2));
  windowFrame(g, x, y, ww, wh, "Notes", lift);
  bodyLines(g, x + 28, y + 56, ww - 56, 9, 3);
  g.restore();
  grabCursor(g, x + ww / 2, y + 15, u.pinch, u.flash);
}

function swipe(g: CanvasRenderingContext2D, w: number, h: number, u: AirUI) {
  const pw = w * 0.78, gap = w * 0.08;
  const off = -u.swipe * (pw + gap);
  const titles = ["Desktop 1", "Desktop 2", "Desktop 3"];
  for (let i = 0; i < 3; i++) {
    const x = w / 2 - pw / 2 + off + i * (pw + gap);
    if (x > w || x + pw < 0) continue;
    const y = 70;
    const ph = h - 150;
    g.fillStyle = "rgba(255,255,255,0.025)";
    roundRect(g, x, y, pw, ph, 12);
    g.fill();
    g.strokeStyle = ink(0.1);
    g.stroke();
    windowFrame(g, x + 40 + i * 30, y + 40, pw * 0.55, ph * 0.62, titles[i]);
    bodyLines(g, x + 64 + i * 30, y + 96, pw * 0.45, 6, i + 2);
    g.font = `500 10px ${MONO}`;
    g.fillStyle = ink(0.35);
    g.fillText(titles[i].toUpperCase(), x + 20, y + ph - 18);
  }
  const active = Math.round(u.swipe);
  for (let i = 0; i < 3; i++) {
    g.fillStyle = i === active ? ink(0.9) : ink(0.22);
    g.beginPath();
    g.arc(w / 2 - 14 + i * 14, h - 62, 3, 0, Math.PI * 2);
    g.fill();
  }
}

function dial(g: CanvasRenderingContext2D, w: number, h: number, u: AirUI) {
  const cx = w / 2, cy = h / 2 + 4, r = 128;
  const a0 = Math.PI * 0.75, span = Math.PI * 1.5;
  for (let i = 0; i <= 30; i++) {
    const a = a0 + (span * i) / 30;
    const on = i / 30 <= u.dial;
    g.strokeStyle = on ? ink(0.8) : ink(0.16);
    g.lineWidth = i % 5 === 0 ? 2 : 1;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (r + 12), cy + Math.sin(a) * (r + 12));
    g.lineTo(cx + Math.cos(a) * (r + (i % 5 === 0 ? 26 : 20)), cy + Math.sin(a) * (r + (i % 5 === 0 ? 26 : 20)));
    g.stroke();
  }
  g.lineWidth = 2;
  g.strokeStyle = ink(0.12);
  g.beginPath();
  g.arc(cx, cy, r, a0, a0 + span);
  g.stroke();
  g.strokeStyle = ink(0.9);
  g.lineWidth = 3;
  g.beginPath();
  g.arc(cx, cy, r, a0, a0 + span * u.dial);
  g.stroke();
  const a = a0 + span * u.dial;
  g.fillStyle = u.pinch > 0.9 ? SIGNAL : ink(0.9);
  g.beginPath();
  g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 6, 0, Math.PI * 2);
  g.fill();
  g.textAlign = "center";
  g.font = `400 64px ${FONT}`;
  g.fillStyle = ink(0.95);
  g.fillText(String(Math.round(u.dial * 100)), cx, cy + 20);
  g.font = `500 10px ${MONO}`;
  g.fillStyle = ink(0.45);
  g.fillText("VOLUME", cx, cy + 48);
  g.textAlign = "left";
}

function zoom(g: CanvasRenderingContext2D, w: number, h: number, u: AirUI) {
  const x0 = 110, y0 = 64, ww = w - 220, wh = h - 150;
  windowFrame(g, x0, y0, ww, wh, "Photos");
  g.save();
  g.beginPath();
  g.rect(x0 + 1, y0 + 31, ww - 2, wh - 32);
  g.clip();
  const cx = x0 + ww / 2, cy = y0 + 31 + (wh - 32) / 2;
  g.translate(cx, cy);
  g.scale(u.zoom, u.zoom);
  const cols = 5, rows = 3, tw = 118, th = 86, gp = 10;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = (c - cols / 2) * (tw + gp) + gp / 2;
      const y = (r - rows / 2) * (th + gp) + gp / 2;
      const v = 0.07 + (((r * 5 + c) * 29) % 13) / 100;
      const grd = g.createLinearGradient(x, y, x + tw, y + th);
      grd.addColorStop(0, `rgba(237,237,239,${v + 0.05})`);
      grd.addColorStop(1, `rgba(237,237,239,${v * 0.4})`);
      g.fillStyle = grd;
      g.fillRect(x, y, tw, th);
    }
  g.restore();
  // the two pinch points
  const sep = 90 * u.zoom;
  for (const s of [-1, 1]) grabCursor(g, cx + s * sep, cy, u.pinch, u.flash);
  if (u.pinch > 0.5) {
    g.strokeStyle = ink(0.35 * u.pinch);
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(cx - sep + 12, cy);
    g.lineTo(cx + sep - 12, cy);
    g.stroke();
    g.setLineDash([]);
  }
}

function circle(g: CanvasRenderingContext2D, w: number, h: number, u: AirUI) {
  const x0 = 120, y0 = 110, ww = w - 240, wh = 300;
  windowFrame(g, x0, y0, ww, wh, "Final cut.mov");
  // waveform timeline
  const tx = x0 + 150, ty = y0 + 190, tw = ww - 190;
  const head = ((u.turns % 1) + 1) % 1;
  const frac = Math.min(1, u.turns / 1.5);
  for (let i = 0; i < 110; i++) {
    const x = tx + (i / 110) * tw;
    const hh = 6 + Math.abs(Math.sin(i * 0.61) * Math.cos(i * 0.17)) * 46;
    g.fillStyle = i / 110 < frac ? ink(0.75) : ink(0.2);
    g.fillRect(x, ty - hh / 2, 2, hh);
  }
  const px = tx + frac * tw;
  g.fillStyle = ink(0.95);
  g.fillRect(px - 1, ty - 44, 2, 88);
  // the knob
  const kx = x0 + 78, ky = ty, kr = 38;
  g.strokeStyle = ink(0.3);
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(kx, ky, kr, 0, Math.PI * 2);
  g.stroke();
  const a = -Math.PI / 2 + head * Math.PI * 2;
  g.fillStyle = ink(0.95);
  g.beginPath();
  g.arc(kx + Math.cos(a) * (kr - 9), ky + Math.sin(a) * (kr - 9), 4, 0, Math.PI * 2);
  g.fill();
  const secs = Math.floor(frac * 247);
  g.font = `500 11px ${MONO}`;
  g.fillStyle = ink(0.6);
  g.fillText(`${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`, px + 8, ty - 48);
  bodyLines(g, x0 + 150, y0 + 60, tw, 3, 5);
}

function point(g: CanvasRenderingContext2D, w: number, h: number, u: AirUI) {
  const x0 = 200, y0 = 80, ww = w - 400, wh = h - 170;
  windowFrame(g, x0, y0, ww, wh, "Menu");
  const items = ["Play", "Next track", "Previous track", "Mute", "Share", "Settings"];
  const px = x0 + 20 + u.px * (ww - 40);
  const py = y0 + 50 + u.py * (wh - 80);
  items.forEach((t, i) => {
    const iy = y0 + 50 + i * 44;
    const hover = py > iy && py < iy + 40 && px > x0 + 20 && px < x0 + ww - 20;
    if (hover) {
      g.fillStyle = "rgba(255,255,255,0.07)";
      roundRect(g, x0 + 16, iy, ww - 32, 40, 6);
      g.fill();
    }
    g.font = `400 15px ${FONT}`;
    g.fillStyle = ink(hover ? 0.95 : 0.6);
    g.fillText(t, x0 + 34, iy + 26);
  });
  // pointer
  g.fillStyle = ink(0.95);
  g.beginPath();
  g.moveTo(px, py);
  g.lineTo(px + 4, py + 17);
  g.lineTo(px + 8, py + 11);
  g.lineTo(px + 15, py + 10);
  g.closePath();
  g.fill();
}

const CAPTION: Record<string, [string, string]> = {
  pinch: ["AIR TAP", "GRAB WINDOW"],
  tap: ["AIR TAP", "CLICK"],
  drag: ["PINCH AND DRAG", "MOVE WINDOW"],
  swipe: ["PALM SWIPE", "NEXT DESKTOP"],
  dial: ["PINCH AND TURN", "VOLUME"],
  zoom: ["TWO HAND PINCH", "ZOOM"],
  circle: ["CIRCLE", "SCRUB"],
  point: ["POINT", "MOVE POINTER"],
};

/** One overlay function for the air chapter; it reads `u` each paint. */
export function airOverlay(u: AirUI) {
  return (g: CanvasRenderingContext2D, w: number, h: number) => {
    if (u.weight <= 0.001) return;
    g.globalAlpha = u.weight;
    dim(g, w, h, 1);
    const id = u.id.startsWith("drag") ? "drag" : u.id;
    if (id === "pinch" || id === "tap" || id === "drag") pinchDrag(g, w, h, u);
    else if (id === "swipe") swipe(g, w, h, u);
    else if (id === "dial") dial(g, w, h, u);
    else if (id === "zoom") zoom(g, w, h, u);
    else if (id === "circle") circle(g, w, h, u);
    else if (id === "point") point(g, w, h, u);
    g.globalAlpha = u.weight;
    chip(g, w, id === "zoom" ? "CAMERA  2 HANDS" : "CAMERA  1 HAND");
    const [l, r] = CAPTION[id] ?? ["", ""];
    caption(g, w, h, u.dir ? `${l}  ${u.dir}` : l, r, u.flash);
    g.globalAlpha = 1;
  };
}
