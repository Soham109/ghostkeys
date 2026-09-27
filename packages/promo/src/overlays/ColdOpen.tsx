import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, easeOut } from "../theme";
import { project } from "../camera";
import { prog } from "../lib";
import type { Cam } from "../three/World";
import { DOT_WORLD } from "../director";
import { TapRing } from "../components/Ring";
import { Mono } from "../components/Type";

/** Lone signal dot + the tap that starts everything, flash, and the wordmark under the particle logo. */
export const ColdOpenOverlay: React.FC<{ cam: (f: number) => Cam; k?: number; vertical?: boolean }> = ({ cam, k = 1, vertical }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const F = (x: number) => x * k;
  const tapAt = F(30);
  const p = project(cam(f), width, height, DOT_WORLD);
  const dotIn = prog(f, F(6), F(16));
  const press = interpolate(f, [tapAt - 2, tapAt, tapAt + 5], [1, 0.55, 1.2], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const gone = prog(f, F(34), 5);
  const r = 10 * dotIn * press * (1 - gone);
  const flash = f >= F(118) ? Math.exp(-(f - F(120)) / 4) * (f >= F(120) ? 1 : (f - F(118)) / 2) : 0;
  const word = prog(f, F(132), 22);
  const wordOut = prog(f, F(160), 8);
  const logoBottom = project(cam(f), width, height, [0, 7 - 5.2, 0]);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <radialGradient id="dotglow">
            <stop offset="0" stopColor={C.signal} stopOpacity={0.35} />
            <stop offset="1" stopColor={C.signal} stopOpacity={0} />
          </radialGradient>
        </defs>
        {r > 0.1 && <circle cx={p.x} cy={p.y} r={r * 7} fill="url(#dotglow)" />}
        {r > 0.1 && <circle cx={p.x} cy={p.y} r={r} fill={C.signal} />}
        <TapRing frame={f} at={tapAt} x={p.x} y={p.y} r={90} dur={18} width={2} />
      </svg>
      {flash > 0.01 && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(circle at ${p.x}px ${p.y}px, rgba(255,255,255,${0.22 * flash}) 0%, rgba(255,255,255,${0.05 * flash}) 35%, rgba(255,255,255,0) 70%)`,
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: logoBottom.y + (vertical ? 40 : 34),
          display: "flex",
          justifyContent: "center",
          overflow: "hidden",
          height: 120,
          opacity: 1 - wordOut,
        }}
      >
        <span
          style={{
            fontFamily: FONT.sans,
            fontWeight: 500,
            fontSize: vertical ? 88 : 84,
            letterSpacing: "-0.02em",
            color: C.ink,
            transform: `translateY(${(1 - word) * 110}%)`,
            display: "inline-block",
          }}
        >
          ghostkeys
        </span>
      </div>
    </AbsoluteFill>
  );
};

export const FadeFromBlack: React.FC<{ at: number; dur?: number }> = ({ at, dur = 8 }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [at, at + dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  if (o <= 0) return null;
  return <AbsoluteFill style={{ background: C.bg, opacity: o }} />;
};
