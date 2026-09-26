import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, FONT, easeOut } from "../theme";
import { Grain } from "../components/Atmos";
import { LogoMark } from "../components/Logo";

type Feat = { tag: string; line: Array<{ t: string; i?: boolean }>; hit: string; cap: string };

const FEATS: Feat[] = [
  { tag: "Gestures", line: [{ t: "Tap, double, rhythm, tilt," }, { t: "cover.", i: true }], hit: "8", cap: "Gestures, plus modifiers" },
  { tag: "Macros", line: [{ t: "One tap runs a whole" }, { t: "sequence.", i: true }], hit: "1 tap", cap: "Any number of steps" },
  { tag: "Presets", line: [{ t: "Ready on first launch, per" }, { t: "app.", i: true }], hit: "200+", cap: "Presets" },
  { tag: "AI composer", line: [{ t: "Say it plainly. It gets" }, { t: "bound.", i: true }], hit: "__typed__", cap: "AI composer" },
  { tag: "On-device", line: [{ t: "Loopback only. No account, no" }, { t: "telemetry.", i: true }], hit: "0", cap: "Bytes sent anywhere" },
  { tag: "No hardware", line: [{ t: "The sensors are already" }, { t: "inside.", i: true }], hit: "0", cap: "Things to buy" },
];

const PROMPT = "double tap left palm to mute";

/**
 * Editorial feature montage: numbered rows split by full-width hairlines (no cards),
 * with a huge numeral hit on the left that hard-cuts on every other beat.
 */
export const Features: React.FC<{ start: number; each?: number; end: number }> = ({ start, each = 30, end }) => {
  const f = useCurrentFrame();
  const k = Math.min(FEATS.length - 1, Math.floor((f - start) / each));
  const lf = f - (start + k * each);
  const closing = f >= start + FEATS.length * each;
  const out = interpolate(f, [end - 10, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const inn = interpolate(f, [start, start + 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (f < start || f >= end) return null;
  const hitP = interpolate(lf, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  const feat = FEATS[k];
  const closeP = interpolate(f, [start + FEATS.length * each, start + FEATS.length * each + 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });

  let hit: React.ReactNode;
  if (closing) {
    hit = (
      <div style={{ transform: `translateY(${(1 - closeP) * 30}px)`, opacity: closeP }}>
        <LogoMark size={200} dotColor={C.signal} />
        <div style={{ fontFamily: FONT.sans, fontWeight: 500, fontSize: 72, letterSpacing: "-0.035em", color: C.ink, marginTop: 40, lineHeight: 1 }}>
          All of it, from{" "}
          <span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontWeight: 400, fontSize: 78 }}>one</span> sensor.
        </div>
      </div>
    );
  } else if (feat.hit === "__typed__") {
    const n = Math.floor(interpolate(lf, [2, 22], [0, PROMPT.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    hit = (
      <div>
        <div style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 96, color: C.ink, lineHeight: 1.02, width: 640 }}>
          “{PROMPT.slice(0, n)}
          <span style={{ opacity: lf % 10 < 5 ? 1 : 0.2 }}>|</span>”
        </div>
        <div style={{ fontFamily: FONT.mono, fontSize: 22, letterSpacing: "0.08em", textTransform: "uppercase", color: lf > 22 ? C.ink : C.ink3, marginTop: 32 }}>
          {lf > 22 ? "→ Left palm · Double tap · Mute" : "Composing…"}
        </div>
      </div>
    );
  } else {
    hit = (
      <div style={{ overflow: "hidden", paddingBottom: 10 }}>
        <div
          style={{
            fontFamily: FONT.sans,
            fontWeight: 500,
            fontSize: feat.hit.length > 3 ? 250 : 330,
            letterSpacing: "-0.055em",
            lineHeight: 0.9,
            color: C.ink,
            fontVariantNumeric: "tabular-nums",
            transform: `translateY(${(1 - hitP) * 100}%)`,
          }}
        >
          {feat.hit}
        </div>
      </div>
    );
  }

  return (
    <AbsoluteFill style={{ background: C.bg, opacity: out * inn }}>
      <AbsoluteFill style={{ background: "radial-gradient(900px 700px at 22% 50%, rgba(237,237,239,0.045), rgba(237,237,239,0) 70%)" }} />
      <div style={{ position: "absolute", left: 128, top: 110, fontFamily: FONT.mono, fontSize: 18, letterSpacing: "0.1em", textTransform: "uppercase", color: C.ink3 }}>
        What ships
      </div>
      <div style={{ position: "absolute", left: 128, top: 300, width: 700 }}>
        {hit}
        {!closing && feat.hit !== "__typed__" && (
          <div style={{ fontFamily: FONT.mono, fontSize: 22, letterSpacing: "0.1em", textTransform: "uppercase", color: C.ink2, marginTop: 26, opacity: hitP }}>{feat.cap}</div>
        )}
      </div>

      <div style={{ position: "absolute", left: 900, right: 96, top: 250 }}>
        {FEATS.map((ft, i) => {
          const s = start + i * each;
          const d = interpolate(f, [s, s + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
          const t = interpolate(f, [s + 3, s + 17], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
          const active = !closing && i === k;
          const col = active ? C.ink : closing ? C.ink : C.ink2;
          return (
            <div key={ft.tag} style={{ position: "relative", height: 100 }}>
              <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1, background: active ? "#3a3a40" : C.hairline, transform: `scaleX(${d})`, transformOrigin: "left" }} />
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, right: 0, overflow: "hidden", display: "flex", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "baseline", width: "100%", transform: `translateY(${(1 - t) * 100}px)` }}>
                  <span style={{ fontFamily: FONT.mono, fontSize: 18, letterSpacing: "0.1em", color: active ? C.ink : C.ink3, width: 70 }}>{String(i + 1).padStart(2, "0")}</span>
                  <span style={{ fontFamily: FONT.sans, fontSize: 40, fontWeight: 400, letterSpacing: "-0.02em", color: col, flex: 1 }}>
                    {ft.line.map((w, j) =>
                      w.i ? (
                        <span key={j} style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: 44 }}>
                          {" "}
                          {w.t}
                        </span>
                      ) : (
                        <span key={j}>{w.t}</span>
                      )
                    )}
                  </span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 16, letterSpacing: "0.1em", textTransform: "uppercase", color: C.ink3 }}>{ft.tag}</span>
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ height: 1, background: C.hairline, transform: `scaleX(${interpolate(f, [start + 5 * each, start + 5 * each + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })})`, transformOrigin: "left" }} />
      </div>
      <Grain />
    </AbsoluteFill>
  );
};
