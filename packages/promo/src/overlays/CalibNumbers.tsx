import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, easeOut } from "../theme";
import { project } from "../camera";
import type { Cam } from "../three/World";
import { ZONE_RECTS } from "../timeline";

/** The app's numbering, in its own style: a small mono index in the top-left corner of each zone. */
export const CalibNumbers: React.FC<{ cam: (f: number) => Cam; start: number; end: number }> = ({ cam, start, end }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (f < start || f >= end) return null;
  const c = cam(f);
  const out = interpolate(f, [end - 10, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: out }}>
      {ZONE_RECTS.map((z, i) => {
        const [cx, cz, hw, hd] = z.r;
        const p = project(c, width, height, [cx - hw, 0, cz - hd]);
        const q = interpolate(f, [start + 6 + i * 3, start + 18 + i * 3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
        const side = z.id.startsWith("edge") || z.id.startsWith("grille");
        return (
          <div key={z.id} style={{ position: "absolute", left: p.x + (side ? -34 : 10), top: p.y + (side ? -30 : 8), overflow: "hidden" }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 18, letterSpacing: "0.08em", color: C.ink2, transform: `translateY(${(1 - q) * 100}%)`, textShadow: "0 0 12px rgba(10,10,11,0.9)" }}>
              {String(i + 1).padStart(2, "0")}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
