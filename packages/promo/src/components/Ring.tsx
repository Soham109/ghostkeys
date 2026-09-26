import React from "react";
import { interpolate } from "remotion";
import { C, easeOut } from "../theme";

/** 2D touch ring: scale 0.4 -> 1.6, opacity 1 -> 0 over ~520ms (brief, app HUD spec). */
export const TapRing: React.FC<{ frame: number; at: number; x: number; y: number; r?: number; dur?: number; width?: number }> = ({
  frame,
  at,
  x,
  y,
  r = 60,
  dur = 16,
  width = 2,
}) => {
  const t = frame - at;
  if (t < 0 || t > dur + 8) return null;
  const rings = [0, 5];
  return (
    <>
      {rings.map((d) => {
        const p = interpolate(t - d, [0, dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
        if (t - d < 0) return null;
        const s = 0.4 + 1.2 * p;
        return (
          <circle
            key={d}
            cx={x}
            cy={y}
            r={r * s}
            fill="none"
            stroke={C.signal}
            strokeWidth={width * (d ? 0.6 : 1)}
            opacity={(1 - p) * (d ? 0.5 : 1)}
          />
        );
      })}
    </>
  );
};
