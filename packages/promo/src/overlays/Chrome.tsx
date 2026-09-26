import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT } from "../theme";
import { Tap } from "../timeline";

const CHAPTERS: Array<[number, string]> = [
  [0, "Signal"],
  [240, "Premise"],
  [360, "Surfaces"],
  [900, "Sensor"],
  [1200, "Zones"],
  [1560, "System"],
  [1860, "Ghostkeys"],
];

/** Instrument chrome: chapter counter bottom-left, live sensor readout bottom-right. */
export const Chrome: React.FC<{ taps: Tap[]; hideBefore: number; hideAfter: number }> = ({ taps, hideBefore, hideAfter }) => {
  const f = useCurrentFrame();
  const { width } = useVideoConfig();
  const vis = Math.min(
    interpolate(f, [hideBefore, hideBefore + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    interpolate(f, [hideAfter - 10, hideAfter], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  );
  if (vis <= 0) return null;
  let ci = 0;
  CHAPTERS.forEach(([s], i) => f >= s && (ci = i));
  const hot = taps.some((t) => f >= t.f && f - t.f < 6);
  const samples = Math.floor((f / 30) * 800);
  const mono: React.CSSProperties = { fontFamily: FONT.mono, fontSize: 18, letterSpacing: "0.1em", textTransform: "uppercase", fontVariantNumeric: "tabular-nums" };
  const pad = width > 1200 ? 64 : 48;
  return (
    <AbsoluteFill style={{ opacity: vis, pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: pad, bottom: 52, display: "flex", gap: 20, alignItems: "baseline", ...mono }}>
        <span style={{ color: C.ink }}>{String(ci + 1).padStart(2, "0")}</span>
        <span style={{ color: C.ink3 }}>/ 07</span>
        <span style={{ color: C.ink2, marginLeft: 14 }}>{CHAPTERS[ci][1]}</span>
      </div>
      <div style={{ position: "absolute", right: pad, bottom: 52, display: "flex", gap: 14, alignItems: "center", ...mono }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: hot ? C.signal : C.ink3 }} />
        <span style={{ color: C.ink2 }}>800 Hz</span>
        <span style={{ color: C.ink3 }}>{String(samples).padStart(6, "0")}</span>
      </div>
    </AbsoluteFill>
  );
};
