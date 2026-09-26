import * as THREE from "three";
import { ZONES } from "@/lib/zones";

export type ScreenMode = "map" | "sheet" | "design" | "music" | "code" | "composer";

/** The real app's Live screen, used as the display picture in "map" mode (sharp, mipmapped, loaded once). */
export const LIVE_URL = "/textures/live.webp";
/** Where the laptop drawing sits inside that screenshot (fractions of the image): taps are marked there. */
const LIVE_MAP = { x: 0.2345, y: 0.3775, w: 0.4665, h: 0.5105 };

let liveTex: THREE.Texture | null = null;
let livePromise: Promise<THREE.Texture> | null = null;
/** Shared loader so the intro can wait on it before it starts. */
export function loadLiveTexture(): Promise<THREE.Texture> {
  if (liveTex) return Promise.resolve(liveTex);
  livePromise ??= new THREE.TextureLoader().loadAsync(LIVE_URL).then((t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    liveTex = t;
    return t;
  });
  return livePromise;
}

const CW = 1024;
const CH = 666;
const SIGNAL = "#ff5b1f";
const FONT = `-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, monospace`;

/**
 * Paints the laptop display into a canvas: a quiet graphite desktop, the Ghostkeys zone map or a generic app,
 * and the HUD pill the real app shows when a gesture fires.
 */
export class ScreenPainter {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mode: ScreenMode = "map";
  private hud: { text: string; t: number } | null = null;
  private taps: { x: number; y: number; t: number }[] = [];
  private dirty = true;
  /** composer typing progress 0..1 */
  composer = 0;
  /** static picture under the canvas (map mode only); the canvas is then drawn with transparency over it */
  base: THREE.Texture | null = null;
  private lastComposer = -1;
  private wallpaper: HTMLCanvasElement;
  /**
   * Optional per-frame layer drawn over the current window and under the HUD (air and sound chapters use it to
   * make the screen answer a gesture). While set, the screen repaints every frame. Draw in canvas pixels: (g, w, h, now).
   */
  overlay: ((g: CanvasRenderingContext2D, w: number, h: number, now: number) => void) | null = null;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.wallpaper = this.makeWallpaper();
    loadLiveTexture()
      .then((t) => {
        this.live = t;
        this.dirty = true;
      })
      .catch(() => {});
  }
  private live: THREE.Texture | null = null;

  private makeWallpaper() {
    const c = document.createElement("canvas");
    c.width = CW;
    c.height = CH;
    const g = c.getContext("2d")!;
    g.fillStyle = "#131316";
    g.fillRect(0, 0, CW, CH);
    // a single soft light falling from the top left, like light across a desk
    const rg = g.createRadialGradient(CW * 0.28, -CH * 0.1, 10, CW * 0.28, -CH * 0.1, CW * 0.95);
    rg.addColorStop(0, "rgba(237,237,239,0.24)");
    rg.addColorStop(0.5, "rgba(237,237,239,0.05)");
    rg.addColorStop(1, "rgba(237,237,239,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, CW, CH);
    // dither
    const img = g.getImageData(0, 0, CW, CH);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 6;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  setOverlay(fn: ScreenPainter["overlay"]) {
    if (fn !== this.overlay) {
      this.overlay = fn;
      this.dirty = true;
    }
  }

  setMode(m: ScreenMode) {
    if (m !== this.mode) {
      this.mode = m;
      this.dirty = true;
    }
  }

  showHud(text: string, now: number) {
    this.hud = { text, t: now };
    this.dirty = true;
  }

  /** x, y in protocol coordinates (0..1) */
  markTap(x: number, y: number, now: number) {
    this.taps.push({ x, y, t: now });
    if (this.taps.length > 12) this.taps.shift();
    this.dirty = true;
  }

  /** Redraws only when something changed or an animation is running. Returns true if it painted. */
  paint(now: number) {
    const animating = !!this.overlay || (this.hud && now - this.hud.t < 1.8) || this.taps.some((t) => now - t.t < 0.8) || (this.mode === "composer" && this.composer !== this.lastComposer);
    this.lastComposer = this.composer;
    if (!this.dirty && !animating) return false;
    this.dirty = false;
    const g = this.ctx;
    this.base = this.mode === "map" && this.live ? this.live : null;
    if (this.base) {
      // the Live screenshot is the picture; this canvas only carries what moves on top of it
      g.clearRect(0, 0, CW, CH);
      this.liveTaps(g, now);
    } else {
      g.drawImage(this.wallpaper, 0, 0);
      this.menuBar(g);
    }
    if (this.base) {
      /* drawn above */
    } else if (this.mode === "map") this.mapWindow(g, now);
    else if (this.mode === "composer") this.composerWindow(g, now);
    else this.appWindow(g, this.mode);
    if (this.overlay) {
      g.save();
      this.overlay(g, CW, CH, now);
      g.restore();
    }
    this.drawHud(g, now);
    this.texture.needsUpdate = true;
    return true;
  }

  private menuBar(g: CanvasRenderingContext2D) {
    g.fillStyle = "rgba(20,20,22,0.72)";
    g.fillRect(0, 0, CW, 22);
    g.font = `600 11px ${FONT}`;
    g.fillStyle = "rgba(237,237,239,0.9)";
    const names: Record<ScreenMode, string> = { map: "Ghostkeys", sheet: "Sheets", design: "Canvas", music: "Music", code: "Editor", composer: "Ghostkeys" };
    g.fillText(names[this.mode], 40, 15);
    g.font = `400 11px ${FONT}`;
    g.fillStyle = "rgba(237,237,239,0.6)";
    ["File", "Edit", "View", "Window"].forEach((s, i) => g.fillText(s, 118 + i * 46, 15));
    // the menu bar ghost: the logo mark, tiny
    const x = CW - 150;
    g.strokeStyle = "rgba(237,237,239,0.9)";
    g.lineWidth = 1.2;
    roundRect(g, x + 2, 5, 9, 9, 2.4);
    g.stroke();
    g.globalAlpha = 0.4;
    roundRect(g, x + 4, 3, 9, 9, 2.4);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = SIGNAL;
    g.beginPath();
    g.arc(x + 6, 10, 1.3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(237,237,239,0.8)";
    g.fillText("Fri 9:41", CW - 60, 15);
  }

  /** Tap rings on the Live screen's laptop drawing, like the real app draws them. */
  private liveTaps(g: CanvasRenderingContext2D, now: number) {
    const mx = LIVE_MAP.x * CW, my = LIVE_MAP.y * CH, mw = LIVE_MAP.w * CW, mh = LIVE_MAP.h * CH;
    for (const t of this.taps) {
      const age = now - t.t;
      if (age > 0.9 || age < 0) continue;
      const k = age / 0.9;
      const e = 1 - Math.pow(1 - k, 3);
      const x = mx + t.x * mw, y = my + t.y * mh;
      g.globalAlpha = 1 - k;
      g.strokeStyle = SIGNAL;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, 4 + e * 22, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = Math.max(0, 1 - k * 1.6);
      g.fillStyle = SIGNAL;
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
  }

  private windowFrame(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string) {
    g.fillStyle = "#1b1b1e";
    roundRect(g, x, y, w, h, 10);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.lineWidth = 1;
    g.stroke();
    ["#3a3a3e", "#3a3a3e", "#3a3a3e"].forEach((c, i) => {
      g.fillStyle = c;
      g.beginPath();
      g.arc(x + 16 + i * 16, y + 15, 5, 0, Math.PI * 2);
      g.fill();
    });
    g.font = `500 11px ${FONT}`;
    g.fillStyle = "rgba(237,237,239,0.55)";
    g.textAlign = "center";
    g.fillText(title, x + w / 2, y + 19);
    g.textAlign = "left";
    g.fillStyle = "rgba(255,255,255,0.06)";
    g.fillRect(x, y + 30, w, 1);
  }

  private mapWindow(g: CanvasRenderingContext2D, now: number) {
    const x = 150, y = 70, w = 724, h = 520;
    this.windowFrame(g, x, y, w, h, "Ghostkeys");
    // sidebar
    g.fillStyle = "rgba(255,255,255,0.025)";
    g.fillRect(x, y + 31, 170, h - 31);
    g.font = `500 9px ${MONO}`;
    g.fillStyle = "rgba(237,237,239,0.35)";
    g.fillText("ZONES", x + 16, y + 56);
    ZONES.slice(0, 6).forEach((z, i) => {
      g.font = `400 11px ${FONT}`;
      g.fillStyle = "rgba(237,237,239,0.78)";
      g.fillText(z.name.replace("Strip above the keys", "Top strip"), x + 16, y + 80 + i * 26);
      g.fillStyle = "rgba(255,255,255,0.05)";
      g.fillRect(x + 16, y + 88 + i * 26, 138, 1);
    });
    // top-down line drawing of the laptop base
    const mx = x + 210, my = y + 70, mw = 480, mh = mw * (2.212 / 3.126);
    g.strokeStyle = "rgba(237,237,239,0.4)";
    g.lineWidth = 1;
    roundRect(g, mx, my, mw, mh, 16);
    g.stroke();
    // keyboard + trackpad hints
    g.strokeStyle = "rgba(237,237,239,0.14)";
    roundRect(g, mx + mw * 0.07, my + mh * 0.055, mw * 0.86, mh * 0.48, 4);
    g.stroke();
    roundRect(g, mx + mw * 0.257, my + mh * 0.58, mw * 0.486, mh * 0.39, 6);
    g.stroke();
    for (const z of ZONES) {
      if (z.surface !== "base") continue;
      g.strokeStyle = "rgba(237,237,239,0.7)";
      g.setLineDash([3, 3]);
      g.strokeRect(mx + z.rect.x * mw, my + z.rect.y * mh, z.rect.w * mw, z.rect.h * mh);
      g.setLineDash([]);
    }
    for (const t of this.taps) {
      const age = now - t.t;
      if (age > 0.8 || age < 0) continue;
      const k = age / 0.8;
      const e = 1 - Math.pow(1 - k, 3);
      g.strokeStyle = SIGNAL;
      g.globalAlpha = 1 - k;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(mx + t.x * mw, my + t.y * mh, 6 + e * 26, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = SIGNAL;
      g.beginPath();
      g.arc(mx + t.x * mw, my + t.y * mh, 3.5, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
    g.font = `500 9px ${MONO}`;
    g.fillStyle = "rgba(237,237,239,0.35)";
    g.fillText("IMU 800 HZ   CALIBRATED   8 ZONES", mx, my + mh + 30);
  }

  private appWindow(g: CanvasRenderingContext2D, mode: ScreenMode) {
    const x = 90, y = 60, w = 844, h = 548;
    this.windowFrame(g, x, y, w, h, { sheet: "Budget.sheet", design: "Poster.canvas", music: "Now playing", code: "main.swift", map: "", composer: "" }[mode]);
    const cx = x + 1, cy = y + 31, cw = w - 2, chh = h - 32;
    if (mode === "sheet") {
      g.font = `400 11px ${MONO}`;
      for (let r = 0; r < 20; r++) {
        g.fillStyle = r === 0 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.0)";
        g.fillRect(cx, cy + r * 25, cw, 25);
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(cx, cy + r * 25, cw, 1);
        for (let c = 0; c < 8; c++) {
          g.fillStyle = "rgba(255,255,255,0.06)";
          g.fillRect(cx + 40 + c * 100, cy, 1, chh);
          if (r > 0 && c < 7) {
            g.fillStyle = r === 7 && c === 2 ? SIGNAL : "rgba(237,237,239,0.62)";
            const v = ((Math.sin(r * 7.1 + c * 3.3) + 1) * 4231).toFixed(2);
            g.fillText(v, cx + 52 + c * 100, cy + r * 25 + 16);
          }
        }
        g.fillStyle = "rgba(237,237,239,0.3)";
        g.fillText(String(r + 1), cx + 12, cy + r * 25 + 16);
      }
      g.strokeStyle = SIGNAL;
      g.lineWidth = 1.5;
      g.strokeRect(cx + 240, cy + 175, 100, 25);
    } else if (mode === "design") {
      g.fillStyle = "rgba(255,255,255,0.03)";
      g.fillRect(cx, cy, 170, chh);
      g.fillRect(cx + cw - 190, cy, 190, chh);
      g.fillStyle = "#e9e7e2";
      g.fillRect(cx + 290, cy + 50, 300, 420);
      g.fillStyle = "#0b0b0c";
      g.beginPath();
      g.arc(cx + 440, cy + 210, 90, 0, Math.PI * 2);
      g.fill();
      g.fillRect(cx + 320, cy + 360, 180, 14);
      g.fillRect(cx + 320, cy + 384, 120, 8);
      g.strokeStyle = SIGNAL;
      g.lineWidth = 1.5;
      g.strokeRect(cx + 350, cy + 120, 180, 180);
      for (let i = 0; i < 10; i++) {
        g.fillStyle = "rgba(237,237,239,0.35)";
        g.fillRect(cx + 16, cy + 24 + i * 26, 60 + ((i * 37) % 70), 7);
      }
    } else if (mode === "music") {
      const grd = g.createLinearGradient(cx + 60, cy + 60, cx + 360, cy + 360);
      grd.addColorStop(0, "#3a3a3e");
      grd.addColorStop(1, "#1c1c1f");
      g.fillStyle = grd;
      g.fillRect(cx + 60, cy + 60, 300, 300);
      g.font = `500 26px ${FONT}`;
      g.fillStyle = "rgba(237,237,239,0.92)";
      g.fillText("Blank Space Suite", cx + 400, cy + 120);
      g.font = `400 16px ${FONT}`;
      g.fillStyle = "rgba(237,237,239,0.5)";
      g.fillText("The Quiet Keys", cx + 400, cy + 150);
      for (let i = 0; i < 90; i++) {
        const hh = 8 + Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)) * 60;
        g.fillStyle = i < 38 ? SIGNAL : "rgba(237,237,239,0.25)";
        g.fillRect(cx + 400 + i * 4.4, cy + 260 - hh / 2, 2.4, hh);
      }
      g.font = `400 11px ${MONO}`;
      g.fillStyle = "rgba(237,237,239,0.45)";
      g.fillText("1:42", cx + 400, cy + 330);
      g.fillText("4:07", cx + 780, cy + 330);
    } else if (mode === "code") {
      g.fillStyle = "rgba(255,255,255,0.025)";
      g.fillRect(cx, cy, 180, chh);
      g.font = `400 12px ${MONO}`;
      const lines = [
        [2, "import Foundation"], [0, ""], [2, "struct Tap {"], [4, "let zone: String"], [4, "let strength: Double"], [2, "}"], [0, ""],
        [2, "func classify(_ window: [Double]) -> Tap? {"], [4, "let energy = window.reduce(0) { $0 + $1 * $1 }"], [4, "guard energy > threshold else { return nil }"],
        [4, "return model.predict(window)"], [2, "}"], [0, ""], [2, "// 800 samples a second, on device"], [2, "sensor.stream { sample in"], [4, "buffer.append(sample)"], [2, "}"],
      ] as const;
      lines.forEach(([ind, t], i) => {
        g.fillStyle = "rgba(237,237,239,0.28)";
        g.fillText(String(i + 1).padStart(2, " "), cx + 196, cy + 26 + i * 22);
        g.fillStyle = t.startsWith("//") ? "rgba(237,237,239,0.35)" : i === 9 ? SIGNAL : "rgba(237,237,239,0.78)";
        g.fillText(t, cx + 230 + ind * 8, cy + 26 + i * 22);
      });
      for (let i = 0; i < 9; i++) {
        g.fillStyle = "rgba(237,237,239,0.35)";
        g.fillRect(cx + 18, cy + 22 + i * 24, 70 + ((i * 29) % 60), 7);
      }
    }
  }

  private composerWindow(g: CanvasRenderingContext2D, now: number) {
    const x = 170, y = 90, w = 684, h = 470;
    this.windowFrame(g, x, y, w, h, "Composer");
    const prompt = "When I double tap the left grille during a call, mute Zoom and pause the music.";
    const p = Math.min(1, this.composer / 0.55);
    const shown = prompt.slice(0, Math.floor(prompt.length * p));
    g.font = `500 9px ${MONO}`;
    g.fillStyle = "rgba(237,237,239,0.4)";
    g.fillText("DESCRIBE IT", x + 32, y + 70);
    g.strokeStyle = "rgba(255,255,255,0.12)";
    roundRect(g, x + 32, y + 84, w - 64, 92, 6);
    g.stroke();
    g.font = `400 17px ${FONT}`;
    g.fillStyle = "rgba(237,237,239,0.92)";
    wrap(g, shown + (p < 1 && Math.floor(now * 2) % 2 ? "|" : ""), x + 48, y + 116, w - 96, 24);
    const r = (this.composer - 0.62) / 0.3;
    if (r > 0) {
      const rows: [string, string][] = [
        ["WHEN", "Double tap, left grille"],
        ["ONLY IN", "Zoom"],
        ["DO", "Zoom: toggle mute"],
        ["THEN", "Music: pause"],
      ];
      g.font = `500 9px ${MONO}`;
      g.fillStyle = "rgba(237,237,239,0.4)";
      g.fillText("BINDING, CHECKED", x + 32, y + 222);
      rows.forEach(([k, v], i) => {
        const a = Math.max(0, Math.min(1, r * 4 - i));
        g.globalAlpha = a;
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(x + 32, y + 236 + i * 44, w - 64, 1);
        g.font = `500 10px ${MONO}`;
        g.fillStyle = "rgba(237,237,239,0.45)";
        g.fillText(k, x + 32, y + 264 + i * 44);
        g.font = `400 15px ${FONT}`;
        g.fillStyle = "rgba(237,237,239,0.9)";
        g.fillText(v, x + 150, y + 265 + i * 44);
        g.globalAlpha = 1;
      });
      if (r > 1) {
        g.fillStyle = SIGNAL;
        g.beginPath();
        g.arc(x + 38, y + 430, 3.5, 0, Math.PI * 2);
        g.fill();
        g.font = `400 13px ${FONT}`;
        g.fillStyle = "rgba(237,237,239,0.85)";
        g.fillText("Saved. Try it: double tap the left grille.", x + 50, y + 434);
      }
    }
  }

  private drawHud(g: CanvasRenderingContext2D, now: number) {
    if (!this.hud) return;
    const age = now - this.hud.t;
    if (age > 1.8 || age < 0) return;
    const a = age < 0.2 ? age / 0.2 : age > 1.55 ? 1 - (age - 1.55) / 0.25 : 1;
    const dy = age < 0.2 ? (1 - age / 0.2) * -8 : 0;
    g.font = `500 13px ${FONT}`;
    const tw = g.measureText(this.hud.text).width;
    const w = tw + 44, h = 32;
    const x = CW / 2 - w / 2, y = 38 + dy;
    g.globalAlpha = Math.max(0, a);
    g.fillStyle = "rgba(28,28,30,0.92)";
    roundRect(g, x, y, w, h, 16);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.1)";
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = SIGNAL;
    g.beginPath();
    g.arc(x + 17, y + 16, 3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(237,237,239,0.95)";
    g.fillText(this.hud.text, x + 28, y + 20.5);
    g.globalAlpha = 1;
  }

  dispose() {
    this.texture.dispose();
  }
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
  const words = text.split(" ");
  let line = "";
  let yy = y;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (g.measureText(t).width > maxW && line) {
      g.fillText(line, x, yy);
      line = w;
      yy += lh;
    } else line = t;
  }
  g.fillText(line, x, yy);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
