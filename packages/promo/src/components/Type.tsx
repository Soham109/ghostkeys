import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { C, FONT, easeOut } from "../theme";

/** Fragment Mono caption: uppercase, +0.08em, the only small type in the film. */
export const Mono: React.FC<{ children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties }> = ({
  children,
  size = 19,
  color = C.ink3,
  style,
}) => (
  <span
    style={{
      fontFamily: FONT.mono,
      fontSize: size,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color,
      fontVariantNumeric: "tabular-nums",
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {children}
  </span>
);

export type Word = { t: string; italic?: boolean; signal?: boolean };

/**
 * Line-mask reveal in Switzer 200: each line rises out of its own mask (expo-out, 0.9 s),
 * lines stagger by `stagger` frames, the one italic word per line de-blurs 120 ms late.
 */
export const SplitHeadline: React.FC<{
  lines: Word[][];
  start?: number;
  size?: number;
  stagger?: number;
  exitAt?: number;
  align?: "left" | "center" | "right";
  color?: string;
  weight?: number;
}> = ({ lines, start = 0, size = 120, stagger = 4, exitAt, align = "left", color = C.ink, weight = 200 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start" }}>
      {lines.map((line, li) => {
        const s = start + li * stagger;
        const p = interpolate(frame, [s, s + 27], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
        let y = (1 - p) * 105;
        if (exitAt !== undefined) {
          const e = interpolate(frame, [exitAt + li * 2, exitAt + li * 2 + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
          y -= e * 105;
        }
        const blur = interpolate(frame, [s + 4, s + 26], [8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div key={li} style={{ overflow: "hidden", paddingBottom: size * 0.14, marginBottom: -size * 0.14 + size * -0.02, lineHeight: 0.98 }}>
            <div style={{ transform: `translateY(${y}%)`, whiteSpace: "nowrap" }}>
              {line.map((w, wi) => (
                <span
                  key={wi}
                  style={{
                    fontFamily: FONT.display,
                    fontStyle: w.italic ? "italic" : "normal",
                    fontWeight: w.italic ? 300 : weight,
                    fontSize: size,
                    letterSpacing: w.italic ? "-0.035em" : "-0.04em",
                    color: w.signal ? C.signal : color,
                    filter: w.italic && blur > 0.05 ? `blur(${blur}px)` : undefined,
                    display: "inline-block",
                    marginRight: wi < line.length - 1 ? "0.24em" : 0,
                  }}
                >
                  {w.t}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** "Your laptop has *more* buttons" -> Word[] (asterisks mark the italic word). */
export const words = (s: string): Word[] =>
  s.split(" ").map((t) => (t.startsWith("*") ? { t: t.replace(/\*/g, ""), italic: true } : { t }));
