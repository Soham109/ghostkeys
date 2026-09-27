import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { SplitHeadline, words } from "../components/Type";
import { C } from "../theme";

/** A headline block placed on the editorial grid (column 2 or 3), with its own in/out timing. */
export const HeadlineAt: React.FC<{
  lines: string[];
  start: number;
  exitAt: number;
  left?: number;
  top?: number;
  bottom?: number;
  size?: number;
  kicker?: string;
  kickerAt?: number;
}> = ({ lines, start, exitAt, left = 128, top, bottom, size = 128, kicker, kickerAt }) => {
  const f = useCurrentFrame();
  if (f < start - 2 || f > exitAt + 40) return null;
  const k = kicker
    ? interpolate(f, [kickerAt ?? start, (kickerAt ?? start) + 12, exitAt, exitAt + 10], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 0;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left, top, bottom }}>
        {kicker && (
          <div
            style={{
              fontFamily: "'Fragment Mono'",
              fontSize: 18,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: C.ink3,
              marginBottom: 28,
              opacity: k,
            }}
          >
            {kicker}
          </div>
        )}
        <SplitHeadline lines={lines.map(words)} start={start} size={size} exitAt={exitAt} />
      </div>
    </AbsoluteFill>
  );
};

/** Soft light (not a panel) to protect type over the 3D scene. */
export const TypeLight: React.FC<{ from: number; to: number; x?: string; y?: string }> = ({ from, to, x = "18%", y = "50%" }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [from, from + 10, to - 10, to], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (o <= 0) return null;
  return (
    <AbsoluteFill
      style={{ opacity: o, background: `radial-gradient(1100px 800px at ${x} ${y}, rgba(10,10,11,0.82) 0%, rgba(10,10,11,0.5) 45%, rgba(10,10,11,0) 75%)` }}
    />
  );
};

/** One-frame lift on hard cuts: sells the beat without a transition effect. */
export const CutFlash: React.FC<{ cuts: number[] }> = ({ cuts }) => {
  const f = useCurrentFrame();
  const hit = cuts.find((c) => f >= c && f < c + 3);
  if (hit === undefined) return null;
  const o = [0.09, 0.04, 0.015][f - hit];
  return <AbsoluteFill style={{ background: "#EDEDEF", opacity: o, mixBlendMode: "screen" }} />;
};
