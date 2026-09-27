import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, FONT, easeOut, easeInOut } from "../theme";
import { TapRing } from "../components/Ring";

// live.png is 2480 x 1600. The laptop map sits roughly in x 470..1840, y 190..1430 of the original.
const LIVE_W = 2480, LIVE_H = 1600;

/** Split screen, right half: the app's live map, with the right edge answering each knock. */
export const LivePanel: React.FC<{ x: number; w: number; h: number; taps: number[]; start: number }> = ({ x, w, h, taps, start }) => {
  const f = useCurrentFrame();
  const inP = interpolate(f, [start, start + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  // crop: fit the map region (470..1840 wide) into the panel, slow drift
  const cropW = 1500, cx = 1150, cy = 800;
  const scale = (w / cropW) * interpolate(f, [start, start + 120], [1, 1.06], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const imgX = w / 2 - cx * scale;
  const imgY = h / 2 - cy * scale;
  const edge = { x: 1720, y: 930 }; // right edge zone, original pixels
  const ex = imgX + edge.x * scale, ey = imgY + edge.y * scale;
  const hot = taps.reduce((m, t) => (f >= t ? Math.max(m, Math.exp(-(f - t) / 8)) : m), 0);
  return (
    <div style={{ position: "absolute", left: x, top: 0, width: w, height: h, overflow: "hidden", background: "#0b0b0c", opacity: inP }}>
      <Img src={staticFile("app/live.png")} style={{ position: "absolute", left: imgX, top: imgY, width: LIVE_W * scale, height: LIVE_H * scale }} />
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        <rect x={ex - 14 * scale} y={ey - 240 * scale} width={28 * scale} height={480 * scale} rx={12 * scale} fill="none" stroke={C.signal} strokeWidth={2} opacity={hot} />
        {taps.map((t) => (
          <TapRing key={t} frame={f} at={t} x={ex} y={ey} r={70} dur={18} />
        ))}
      </svg>
    </div>
  );
};

/** Split divider: a single hairline that draws top to bottom. */
export const SplitRule: React.FC<{ x: number; start: number; end: number }> = ({ x, start, end }) => {
  const f = useCurrentFrame();
  const d = interpolate(f, [start, start + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  const o = interpolate(f, [end - 8, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <div style={{ position: "absolute", left: x, top: 0, width: 1, height: `${d * 100}%`, background: "#2a2a2f", opacity: o }} />;
};

/**
 * Flat UI after the push-in: first the live view exactly where the screen left it (match cut),
 * then a hard cut on the beat to a macro pan across the gesture guide.
 */
export const AppFlat: React.FC<{ start: number; cut: number; end: number }> = ({ start, cut, end }) => {
  const f = useCurrentFrame();
  if (f < start || f >= end) return null;
  const W = 1920, H = 1080;
  if (f < cut) {
    // cover-fit with a continuing slow push, so the move carries through the cut
    const base = Math.max(W / LIVE_W, H / LIVE_H) * 1.02;
    const s = base * interpolate(f, [start, cut], [1, 1.08], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <AbsoluteFill style={{ background: "#0b0b0c", overflow: "hidden" }}>
        <Img src={staticFile("app/live.png")} style={{ position: "absolute", left: W / 2 - (LIVE_W * s) / 2, top: H / 2 - (LIVE_H * s) / 2, width: LIVE_W * s, height: LIVE_H * s }} />
      </AbsoluteFill>
    );
  }
  // macro pan: 1.9x over the first gesture card, drifting down to the second
  const p = interpolate(f, [cut, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
  const s = 1.55 + p * 0.12;
  const fx = 1250 + p * 60, fy = 500 + p * 360; // focus point in original pixels
  const o = interpolate(f, [end - 8, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#0b0b0c", overflow: "hidden", opacity: o }}>
      <Img src={staticFile("app/guide.png")} style={{ position: "absolute", left: W / 2 - fx * s, top: H / 2 - fy * s, width: LIVE_W * s, height: LIVE_H * s }} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 70% 70% at 50% 50%, rgba(10,10,11,0) 55%, rgba(10,10,11,0.75) 100%)" }} />
    </AbsoluteFill>
  );
};
