import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { C, FONT, easeOut } from "../theme";

export const Mono: React.FC<{
  children: React.ReactNode;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}> = ({ children, size = 22, color = C.ink3, style }) => (
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
 * SplitText-style reveal: each line is a mask, each word slides up from 110%
 * with expo-out, staggered ~0.08s. The italic serif word also de-blurs, 120ms late.
 */
export const SplitHeadline: React.FC<{
  lines: Word[][];
  start?: number;
  size?: number;
  stagger?: number;
  exitAt?: number;
  align?: "left" | "center";
  color?: string;
}> = ({ lines, start = 0, size = 120, stagger = 2.4, exitAt, align = "left", color = C.ink }) => {
  const frame = useCurrentFrame();
  let idx = 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "center" ? "center" : "flex-start" }}>
      {lines.map((line, li) => (
        <div
          key={li}
          style={{
            overflow: "hidden",
            display: "flex",
            gap: `0 ${size * 0.26}px`,
            paddingBottom: size * 0.1,
            marginBottom: -size * 0.1,
            lineHeight: 0.98,
          }}
        >
          {line.map((w, wi) => {
            const i = idx++;
            const s = start + i * stagger + li * 3;
            const p = interpolate(frame, [s, s + 27], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: easeOut,
            });
            let y = (1 - p) * 110;
            if (exitAt !== undefined) {
              const e = interpolate(frame, [exitAt + i * 1.2, exitAt + i * 1.2 + 16], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: easeOut,
              });
              y -= e * 110;
            }
            const blur = w.italic
              ? interpolate(frame, [s + 4, s + 4 + 22], [8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
              : 0;
            return (
              <span
                key={wi}
                style={{
                  display: "inline-block",
                  transform: `translateY(${y}%)`,
                  filter: blur > 0.05 ? `blur(${blur}px)` : undefined,
                  fontFamily: w.italic ? FONT.serif : FONT.sans,
                  fontStyle: w.italic ? "italic" : "normal",
                  fontWeight: w.italic ? 400 : 500,
                  fontSize: w.italic ? size * 1.06 : size,
                  letterSpacing: w.italic ? "-0.01em" : "-0.035em",
                  color: w.signal ? C.signal : color,
                }}
              >
                {w.t}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/** Helper: "Your laptop has *more* buttons" -> Word[] (asterisks mark the serif word). */
export const words = (s: string): Word[] =>
  s.split(" ").map((t) => (t.startsWith("*") ? { t: t.replace(/\*/g, ""), italic: true } : { t }));
