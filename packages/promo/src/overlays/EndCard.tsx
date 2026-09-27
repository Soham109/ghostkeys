import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, easeOut, easeInOut } from "../theme";
import { SplitHeadline, words } from "../components/Type";
import { TapRing } from "../components/Ring";
import { Grain } from "../components/Atmos";

/** Mark draws itself, the touch dot lands in signal orange, wordmark + tagline + repo. */
export const EndCard: React.FC<{ start: number; vertical?: boolean; speed?: number }> = ({ start, vertical, speed = 1 }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = (f - start) * speed;
  if (t < 0) return null;
  const inn = interpolate(t, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const draw1 = interpolate(t, [4, 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
  const draw2 = interpolate(t, [10, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
  const dotAt = 42;
  const dot = interpolate(t, [dotAt, dotAt + 4, dotAt + 8], [0, 1.25, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const word = interpolate(t, [30, 52], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  const url = interpolate(t, [70, 88], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  const S = vertical ? 340 : 300;
  const per = 4 * (64 - 32) + 2 * Math.PI * 16; // rounded-rect perimeter
  const k = S / 128;
  const markX = vertical ? width / 2 - S / 2 : 176 - 28 * k;
  const markY = vertical ? 420 : 200;
  return (
    <AbsoluteFill style={{ background: C.bg, opacity: inn }}>
      <AbsoluteFill style={{ background: `radial-gradient(1000px 760px at ${vertical ? "50%" : "30%"} ${vertical ? "32%" : "40%"}, rgba(237,237,239,0.05), rgba(237,237,239,0) 70%)` }} />
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <g transform={`translate(${markX} ${markY}) scale(${k})`} fill="none" stroke={C.ink} strokeWidth={6} strokeLinejoin="round">
          <rect x={36} y={28} width={64} height={64} rx={16} opacity={0.35} strokeDasharray={per} strokeDashoffset={per * (1 - draw2)} />
          <rect x={28} y={36} width={64} height={64} rx={16} strokeDasharray={per} strokeDashoffset={per * (1 - draw1)} />
          <circle cx={60} cy={68} r={7 * dot} fill={C.signal} stroke="none" />
        </g>
        <TapRing frame={t} at={dotAt} x={markX + 60 * k} y={markY + 68 * k} r={70} dur={18} />
      </svg>
      {vertical ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: markY + 100 * k + 70, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ overflow: "hidden" }}>
            <div style={{ fontFamily: FONT.sans, fontWeight: 500, fontSize: 132, letterSpacing: "-0.03em", color: C.ink, transform: `translateY(${(1 - word) * 110}%)` }}>ghostkeys</div>
          </div>
          <div style={{ marginTop: 30 }}>
            <SplitHeadline lines={[words("Your MacBook has"), words("*hidden* keys.")]} start={start + (speed > 1 ? 14 : 44)} size={66} align="center" color={C.ink2} />
          </div>
          <div style={{ marginTop: 90, fontFamily: FONT.mono, fontSize: 30, letterSpacing: "0.06em", color: C.ink, opacity: url, transform: `translateY(${(1 - url) * 16}px)` }}>
            github.com/Soham109/ghostkeys
          </div>
        </div>
      ) : (
        <>
          <div style={{ position: "absolute", left: markX + 100 * k + 64, top: markY + 64 * k - 92, overflow: "hidden" }}>
            <div style={{ fontFamily: FONT.sans, fontWeight: 500, fontSize: 168, letterSpacing: "-0.03em", color: C.ink, lineHeight: 1.05, transform: `translateY(${(1 - word) * 110}%)` }}>
              ghostkeys
            </div>
          </div>
          <div style={{ position: "absolute", left: 172, top: 590 }}>
            <SplitHeadline lines={[words("Your MacBook has *hidden* keys.")]} start={start + 46} size={84} color={C.ink} />
          </div>
          <div style={{ position: "absolute", left: 176, right: 128, bottom: 120, height: 1, background: C.hairline, transform: `scaleX(${url})`, transformOrigin: "left" }} />
          <div style={{ position: "absolute", left: 176, bottom: 64, fontFamily: FONT.mono, fontSize: 24, letterSpacing: "0.08em", color: C.ink, opacity: url }}>
            github.com/Soham109/ghostkeys
          </div>
          <div style={{ position: "absolute", right: 128, bottom: 66, fontFamily: FONT.mono, fontSize: 18, letterSpacing: "0.1em", textTransform: "uppercase", color: C.ink3, opacity: url }}>
            Apple silicon · macOS 14+
          </div>
        </>
      )}
      <Grain />
    </AbsoluteFill>
  );
};
