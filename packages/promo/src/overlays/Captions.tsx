import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, FONT, easeOut } from "../theme";
import { S, FILM_TAPS, ZONES, calibrationHits } from "../timeline";
import { volumeAt } from "../three/hand/scenes";

const HITS = calibrationHits();
const lastTap = (f: number, from: number, to: number) => [...FILM_TAPS].reverse().find((t) => !t.quiet && t.f <= f && t.f >= from && t.f < to);
const tapText = (f: number, from: number, to: number) => {
  const t = lastTap(f, from, to);
  return t ? `${ZONES[t.zone].name}  ·  ${t.gesture ?? "Tap"}  ·  ${t.action}` : "";
};

type Cap = { from: number; to: number; n: string; name: string; right: (f: number) => string };
const CAPS: Cap[] = [
  { from: S.open, to: S.matter, n: "01", name: "Signal", right: (f) => (f < 27 ? "Listening" : "Touch felt") },
  { from: S.matter, to: S.macro, n: "02", name: "Matter", right: () => "" },
  { from: S.macro, to: S.split, n: "03", name: "Palm rest", right: (f) => tapText(f, S.macro, S.split) },
  { from: S.split, to: S.grille, n: "04", name: "Knuckle", right: (f) => tapText(f, S.split, S.grille) },
  { from: S.grille, to: S.xray, n: "05", name: "Speaker grille", right: (f) => tapText(f, S.grille, S.xray) },
  { from: S.xray, to: S.calib, n: "06", name: "Motion sensor", right: () => "Accelerometer + gyroscope" },
  { from: S.calib, to: S.cover, n: "07", name: "Calibration", right: (f) => `Taps accepted  ${String(HITS.filter((h) => h.f <= f).length).padStart(2, "0")} / ${HITS.length}` },
  { from: S.cover, to: S.lid, n: "08", name: "Light sensor", right: (f) => tapText(f, S.cover, S.lid) },
  { from: S.lid, to: S.air, n: "09", name: "Lid", right: (f) => tapText(f, S.lid, S.air) },
  { from: S.air, to: S.sonar, n: "10", name: "Air", right: (f) => tapText(f, S.air, S.sonar) || "Camera add-on" },
  { from: S.sonar, to: S.app, n: "11", name: "Sonar", right: (f) => `Hover  ·  Volume  ${String(volumeAt(f)).padStart(2, "0")}%` },
  { from: S.app, to: S.type, n: "12", name: "Live", right: (f) => (f < S.appCut + 30 ? "Live view" : "Gesture guide  ·  39 gestures") },
  { from: S.type, to: S.hero, n: "13", name: "Private", right: () => "No network  ·  No telemetry  ·  No account" },
  { from: S.hero, to: S.end, n: "14", name: "Ready", right: (f) => tapText(f, S.hero, S.end) },
];

const mono: React.CSSProperties = {
  fontFamily: FONT.mono,
  fontSize: 19,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
  textShadow: "0 0 14px rgba(10,10,11,0.9), 0 0 3px rgba(10,10,11,0.8)",
};

/** A caption that rises out of a mask whenever its text changes. */
const Masked: React.FC<{ text: string; since: number; color: string; align?: "left" | "right" }> = ({ text, since, color, align = "left" }) => {
  const f = useCurrentFrame();
  const p = interpolate(f - since, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  return (
    <div style={{ overflow: "hidden", height: 26, textAlign: align }}>
      <div style={{ ...mono, color, transform: `translateY(${(1 - p) * 100}%)` }}>{text}</div>
    </div>
  );
};

/** Corner captions: section number and name bottom-left, the live detail bottom-right, marks at the top. */
export const Captions: React.FC<{ until: number; pad?: number }> = ({ until, pad = 72 }) => {
  const f = useCurrentFrame();
  if (f >= until) return null;
  const c = CAPS.find((k) => f >= k.from && f < k.to);
  if (!c) return null;
  // find when the right text last changed (scan back a little; texts change on taps and counters)
  const right = c.right(f);
  let since = f;
  const shape = (s: string) => s.replace(/\d/g, "#");
  while (since > c.from && shape(c.right(since - 1)) === shape(right)) since--;
  const fadeOut = interpolate(f, [until - 10, until], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: fadeOut }}>
      {!(f >= S.app && f < S.type) && (
        <>
          <div style={{ position: "absolute", left: pad, top: 56, ...mono, color: C.ink2 }}>Ghostkeys</div>
          <div style={{ position: "absolute", right: pad, top: 56, ...mono, color: C.ink3 }}>MacBook  ·  Apple silicon</div>
        </>
      )}
      <div style={{ position: "absolute", left: pad, bottom: 52, display: "flex", gap: 22 }}>
        <Masked text={c.n} since={c.from} color={C.ink} />
        <Masked text={c.name} since={c.from + 2} color={C.ink2} />
      </div>
      <div style={{ position: "absolute", right: pad, bottom: 52 }}>
        {right && <Masked text={right} since={since} color={right.includes("·") && c.n !== "13" ? C.ink : C.ink2} align="right" />}
      </div>
    </AbsoluteFill>
  );
};
