import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, easeOut } from "../theme";
import { project } from "../camera";
import type { Cam } from "../three/World";
import { LAYERS, LAYER_START, LAYER_EACH, ZONES, ZONE_RECTS, ZoneId, calibrationHits } from "../timeline";
import { SplitHeadline, words } from "../components/Type";
import { Glyph } from "./Glyph";

const HITS = calibrationHits();
const mono = (size: number, color: string): React.CSSProperties => ({
  fontFamily: FONT.mono,
  fontSize: size,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color,
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
});

// where each zone's small label sits relative to the projected zone point
const OFFS: Record<string, [number, number, "l" | "r" | "c"]> = {
  palmL: [0, 64, "c"],
  palmR: [0, 64, "c"],
  grilleL: [0, -44, "c"],
  grilleR: [0, -44, "c"],
  top: [0, -40, "c"],
  edgeL: [-40, 40, "r"],
  edgeR: [40, 40, "l"],
};

const ZoneTag: React.FC<{ x: number; y: number; id: ZoneId; line1: string; line2?: string; p: number; hot?: boolean }> = ({ x, y, id, line1, line2, p, hot }) => {
  const [dx, dy, al] = OFFS[id];
  const tx = al === "c" ? "-50%" : al === "r" ? "-100%" : "0%";
  return (
    <div style={{ position: "absolute", left: x + dx, top: y + dy, transform: `translate(${tx}, -50%)`, textAlign: al === "c" ? "center" : al === "r" ? "right" : "left" }}>
      <div style={{ overflow: "hidden" }}>
        <div style={{ transform: `translateY(${(1 - p) * 100}%)`, textShadow: "0 0 16px rgba(10,10,11,0.9), 0 0 4px rgba(10,10,11,0.7)" }}>
          <div style={mono(15, hot ? C.signal : C.ink3)}>{line1}</div>
          {line2 && <div style={{ ...mono(22, C.ink), marginTop: 4, fontWeight: 500 }}>{line2}</div>}
        </div>
      </div>
    </div>
  );
};

export const ZonesOverlay: React.FC<{ cam: (f: number) => Cam; start: number; end: number }> = ({ cam, start, end }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (f < start || f >= end) return null;
  const c = cam(f);
  const pts = ZONE_RECTS.map((z) => {
    const p: [number, number, number] =
      z.id === "edgeL" ? [-15.4, 0, 6] : z.id === "edgeR" ? [15.4, 0, 6] : z.id === "top" ? [0, 0, -10.2] : z.id === "grilleL" ? [-13.75, 0, -9.4] : z.id === "grilleR" ? [13.75, 0, -9.4] : ZONES[z.id].p;
    return { id: z.id, ...project(c, width, height, p) };
  });

  // phase 1: numbering; phase 2: calibration; phase 3: layers
  const phase = f < 1320 ? 1 : f < LAYER_START ? 2 : 3;
  const accepted = HITS.filter((h) => h.f <= f).length;
  const calP = interpolate(f, [1320, 1400], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const li = Math.max(0, Math.floor((f - LAYER_START) / LAYER_EACH)) % LAYERS.length;
  const lf = f - (LAYER_START + Math.floor((f - LAYER_START) / LAYER_EACH) * LAYER_EACH);
  const layer = LAYERS[li];
  const listIn = interpolate(f, [LAYER_START - 4, LAYER_START + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 128, top: 140 }}>
        {phase === 1 && <SplitHeadline lines={[words("Seven *zones.*"), words("Zero buttons.")]} start={start + 4} exitAt={1306} size={96} />}
        {phase === 2 && <SplitHeadline lines={[words("Calibrate in"), words("*three* minutes.")]} start={1318} exitAt={LAYER_START - 16} size={104} />}
        {phase === 3 && <SplitHeadline lines={[words("A layer for"), words("every *app.*")]} start={LAYER_START} exitAt={end - 20} size={104} />}
      </div>

      {phase === 2 && (
        <div style={{ position: "absolute", left: 128, top: 470, width: 520 }}>
          <div style={{ display: "flex", justifyContent: "space-between", ...mono(16, C.ink3) }}>
            <span>Taps accepted</span>
            <span style={{ color: C.ink }}>{String(accepted).padStart(3, "0")} / {HITS.length}</span>
          </div>
          <div style={{ height: 1, background: C.hairline, marginTop: 14, position: "relative" }}>
            <div style={{ position: "absolute", left: 0, top: 0, height: 1, width: `${calP * 100}%`, background: C.ink }} />
          </div>
          <div style={{ ...mono(16, C.ink3), marginTop: 14 }}>Learning tap vs. typing</div>
        </div>
      )}

      {phase === 3 && (
        <div style={{ position: "absolute", left: 128, top: 470, opacity: listIn * interpolate(f, [end - 16, end - 4], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
          {LAYERS.map((L, i) => {
            const on = i === li;
            return (
              <div key={L.name} style={{ display: "flex", alignItems: "center", gap: 22, height: 64, borderTop: `1px solid ${C.hairline}`, width: 440 }}>
                <span style={mono(15, C.ink3)}>{String(i + 1).padStart(2, "0")}</span>
                <Glyph kind={L.glyph} size={30} color={on ? C.ink : C.ink3} />
                <span style={{ fontFamily: FONT.sans, fontSize: 28, fontWeight: on ? 500 : 400, color: on ? C.ink : C.ink3 }}>{L.name}</span>
              </div>
            );
          })}
          <div style={{ borderTop: `1px solid ${C.hairline}`, width: 440 }} />
        </div>
      )}

      {pts.map((p, i) => {
        if (!p.visible) return null;
        if (phase === 1) {
          const tf = 1215 + i * 15;
          const pp = interpolate(f, [tf, tf + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
          const out = interpolate(f, [1306, 1318], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          if (pp <= 0 || out <= 0) return null;
          return (
            <div key={p.id} style={{ opacity: out }}>
              <ZoneTag x={p.x} y={p.y} id={p.id} line1={`${String(i + 1).padStart(2, "0")}`} line2={ZONES[p.id].name} p={pp} hot={f - tf < 8} />
            </div>
          );
        }
        if (phase === 3 && !p.id.startsWith("edge")) {
          const pp = interpolate(lf, [2 + i * 1.2, 12 + i * 1.2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
          const out = interpolate(f, [end - 16, end - 4], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <div key={`${p.id}-${li}`} style={{ opacity: out }}>
              <ZoneTag x={p.x} y={p.y} id={p.id} line1={ZONES[p.id].name} line2={layer.map[p.id]} p={pp} />
            </div>
          );
        }
        return null;
      })}
    </AbsoluteFill>
  );
};
