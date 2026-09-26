import React, { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, easeOut } from "../theme";
import { noise1 } from "../lib";
import { project } from "../camera";
import type { Cam } from "../three/World";
import { CHIP } from "../three/Internals";
import { PointLabel } from "../components/Labels";
import { SplitHeadline, words } from "../components/Type";

const AX = ["Accel X", "Accel Y", "Accel Z", "Gyro"];

/** Deterministic 800 Hz trace: idle hum plus a ringing spike after each tap. */
const sample = (t: number, axis: number, tapsS: number[]) => {
  let v = 0.22 * Math.sin(2 * Math.PI * (0.9 + axis * 0.37) * t + axis * 1.7) + (noise1(t * 90 + axis * 31.7) - 0.5) * 0.45 + (noise1(t * 700 + axis * 9) - 0.5) * 0.16;
  let hot = 0;
  for (const T of tapsS) {
    const d = t - T;
    if (d >= 0 && d < 0.25) {
      const a = [1, 0.7, 1.25, 0.55][axis] * Math.exp(-d * 26);
      v += a * Math.sin(2 * Math.PI * (140 + axis * 23) * d + axis);
      hot = Math.max(hot, Math.exp(-d * 18));
    }
  }
  return { v, hot };
};

export const XrayOverlay: React.FC<{ cam: (f: number) => Cam; start: number; end: number; tapFrames: number[] }> = ({ cam, start, end, tapFrames }) => {
  const f = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const ref = useRef<HTMLCanvasElement>(null);
  const W = 600, H = 250;
  const vis = interpolate(f, [start + 30, start + 50, end - 14, end], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const tapsS = tapFrames.map((x) => x / fps);

  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    const now = f / fps;
    const N = 480; // 0.6 s at 800 Hz
    const rowH = H / 4;
    for (let a = 0; a < 4; a++) {
      const y0 = rowH * a + rowH / 2;
      ctx.strokeStyle = "rgba(237,237,239,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(W, y0);
      ctx.stroke();
      let prevHot = -1;
      let px = 0, py = y0;
      for (let i = 0; i < N; i++) {
        const t = now - (N - 1 - i) / 800;
        const { v, hot } = sample(t, a, tapsS);
        const x = (i / (N - 1)) * W;
        const y = y0 - v * rowH * 0.42;
        const h = hot > 0.15 ? 1 : 0;
        if (i > 0) {
          if (h !== prevHot) {
            ctx.strokeStyle = h ? "#FF5B1F" : "rgba(237,237,239,0.78)";
            ctx.lineWidth = h ? 2 : 1.25;
          }
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        prevHot = h;
        px = x;
        py = y;
      }
    }
  }, [f, fps]);

  if (vis <= 0) return null;
  const chip = project(cam(f), width, height, CHIP);
  const count = Math.floor(((f - start) / fps) * 800);
  const lastTap = [...tapFrames].reverse().find((t) => f >= t && f - t < 24);
  const big = interpolate(f, [start + 34, start + 64], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  return (
    <AbsoluteFill style={{ opacity: vis, pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 128, top: 96 }}>
        <div style={{ overflow: "hidden", height: 250 }}>
          <div
            style={{
              fontFamily: FONT.sans,
              fontWeight: 500,
              fontSize: 260,
              lineHeight: 0.92,
              letterSpacing: "-0.05em",
              color: C.ink,
              fontVariantNumeric: "tabular-nums",
              transform: `translateY(${(1 - big) * 105}%)`,
            }}
          >
            800
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <SplitHeadline lines={[words("readings per *second.*")]} start={start + 46} size={60} />
        </div>
        <div style={{ marginTop: 26, fontFamily: FONT.mono, fontSize: 17, letterSpacing: "0.1em", color: C.ink3, textTransform: "uppercase", opacity: big }}>
          Accelerometer + gyroscope. Already inside.
        </div>
        <div style={{ marginTop: 56, display: "flex", gap: 22, opacity: big }}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-around", height: H, width: 96 }}>
            {AX.map((a) => (
              <div key={a} style={{ fontFamily: FONT.mono, fontSize: 14, letterSpacing: "0.1em", color: C.ink3, textTransform: "uppercase" }}>
                {a}
              </div>
            ))}
          </div>
          <canvas ref={ref} width={W} height={H} style={{ display: "block" }} />
        </div>
        <div style={{ marginTop: 34, display: "flex", gap: 56, fontFamily: FONT.mono, fontSize: 17, letterSpacing: "0.1em", textTransform: "uppercase", opacity: big }}>
          <div>
            <div style={{ color: C.ink3 }}>Samples</div>
            <div style={{ color: C.ink, fontSize: 28, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>{String(Math.max(0, count)).padStart(6, "0")}</div>
          </div>
          <div>
            <div style={{ color: C.ink3 }}>Classifier</div>
            <div style={{ color: lastTap !== undefined ? C.signal : C.ink, fontSize: 28, marginTop: 8 }}>{lastTap !== undefined ? "Tap · accepted" : "Listening"}</div>
          </div>
        </div>
      </div>
      {chip.visible && <PointLabel x={chip.x} y={chip.y} age={f - start - 40} life={9999} top="Motion sensor" main="Accel + gyro" />}
    </AbsoluteFill>
  );
};
