import { Tap, ZONES } from "../timeline";
import { appImage, AppImage } from "./images";

export type ScreenCanvas = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

export const makeScreenCanvas = (): ScreenCanvas => {
  const canvas = document.createElement("canvas");
  canvas.width = 1400;
  canvas.height = 900;
  return { canvas, ctx: canvas.getContext("2d")! };
};

/** The laptop's own screen: near-black desktop and the Ghostkeys HUD pill on each tap. */
export const drawScreen = (s: ScreenCanvas, frame: number, fps: number, taps: Tap[], on: number, image?: AppImage | null) => {
  const { ctx, canvas } = s;
  const W = canvas.width;
  const H = canvas.height;
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (on <= 0) return;
  // faint desktop light
  const g = ctx.createRadialGradient(W * 0.5, H * 0.62, 20, W * 0.5, H * 0.62, W * 0.7);
  g.addColorStop(0, `rgba(60,60,66,${0.55 * on})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const img = image ? appImage(image) : undefined;
  if (img && img.complete && img.naturalWidth) {
    ctx.globalAlpha = on;
    ctx.drawImage(img, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  // notch (drawn in the canvas so it lines up with the bezel)
  ctx.fillStyle = "#000";
  ctx.fillRect(W / 2 - 110, 0, 220, 34);

  const live = [...taps].reverse().find((t) => !t.quiet && frame >= t.f && frame - t.f < fps * 1.5);
  if (!live) return;
  const age = frame - live.f;
  const enter = Math.min(1, age / 6);
  const exit = Math.max(0, Math.min(1, (age - fps * 1.2) / 7));
  const a = enter * (1 - exit) * on;
  const text = `${ZONES[live.zone].name}  ·  ${live.action}`;
  ctx.font = "400 44px Switzer, system-ui";
  const tw = ctx.measureText(text).width;
  const pw = tw + 130;
  const ph = 84;
  const x = W / 2 - pw / 2;
  const y = 90 - (1 - enter) * 16;
  ctx.globalAlpha = a;
  ctx.fillStyle = "rgba(38,38,42,0.92)";
  ctx.beginPath();
  ctx.roundRect(x, y, pw, ph, ph / 2);
  ctx.fill();
  ctx.fillStyle = "#FF5B1F";
  ctx.beginPath();
  ctx.arc(x + 48, y + ph / 2, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#EDEDEF";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 80, y + ph / 2 + 2);
  ctx.globalAlpha = 1;
};
