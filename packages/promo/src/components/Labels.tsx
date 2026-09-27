import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, easeOut } from "../theme";
import { project } from "../camera";
import type { Cam } from "../three/World";
import { Tap, ZONES } from "../timeline";

/** One annotation: hairline leader from the tapped point to a Geist Mono action label. */
export const PointLabel: React.FC<{
  x: number;
  y: number;
  age: number;
  life: number;
  top: string;
  main: string;
  flip?: boolean;
  scale?: number;
}> = ({ x, y, age, life, top, main, flip, scale = 1 }) => {
  const draw = interpolate(age, [0, 9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  const txt = interpolate(age, [4, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  const out = interpolate(age, [life - 6, life], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const dx = 70 * scale, dy = -90 * scale, run = 250 * scale;
  const s = flip ? -1 : 1;
  const ex = x + dx * s, ey = y + dy;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: out }}>
      <svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
        <polyline
          points={`${x},${y} ${x + (ex - x) * Math.min(1, draw * 2)},${y + (ey - y) * Math.min(1, draw * 2)} ${
            ex + run * s * Math.max(0, draw * 2 - 1)
          },${ey}`}
          fill="none"
          stroke={C.ink}
          strokeOpacity={0.55}
          strokeWidth={1.25}
        />
        <circle cx={x} cy={y} r={4 * scale} fill={C.signal} opacity={draw} />
      </svg>
      <div
        style={{
          position: "absolute",
          left: flip ? undefined : ex + 2,
          right: flip ? `calc(100% - ${ex - 2}px)` : undefined,
          top: ey - 74 * scale,
          overflow: "hidden",
          textAlign: flip ? "right" : "left",
        }}
      >
        <div style={{ transform: `translateY(${(1 - txt) * 100}%)`, textShadow: "0 0 18px rgba(10,10,11,0.85), 0 0 4px rgba(10,10,11,0.6)" }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 17 * scale, letterSpacing: "0.1em", color: C.ink2, textTransform: "uppercase" }}>{top}</div>
          <div style={{ fontFamily: FONT.mono, fontSize: 34 * scale, letterSpacing: "0.06em", color: C.ink, textTransform: "uppercase", marginTop: 6 * scale, fontWeight: 400 }}>
            {main}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Labels for every visible (non-quiet) tap, positioned with the 3D camera. */
export const TapLabels: React.FC<{ taps: Tap[]; cam: (f: number) => Cam; from: number; to: number; offset?: number; scale?: number }> = ({
  taps,
  cam,
  from,
  to,
  offset = 0,
  scale = 1,
}) => {
  const frame = useCurrentFrame() + offset;
  const { width, height } = useVideoConfig();
  const list = taps.filter((t) => !t.quiet && t.f >= from && t.f < to);
  const c = cam(frame);
  return (
    <>
      {list.map((t, i) => {
        const next = list[i + 1];
        const life = Math.min(next ? next.f - t.f : 50, 50);
        const age = frame - t.f;
        if (age < 0 || age > life) return null;
        const p = project(c, width, height, ZONES[t.zone].p);
        if (!p.visible) return null;
        const flip = p.x > width * 0.62;
        return (
          <PointLabel
            key={t.f}
            x={p.x}
            y={p.y}
            age={age}
            life={life}
            flip={flip}
            scale={scale}
            top={`${ZONES[t.zone].name} · ${t.gesture ?? "Tap"}`}
            main={t.action}
          />
        );
      })}
    </>
  );
};
