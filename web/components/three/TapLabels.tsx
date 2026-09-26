"use client";

import { useEffect, useState } from "react";
import { Html } from "@react-three/drei";
import type { TapField, TapLabel } from "./taps";

/** The HUD pill that floats up from where a tap landed: signal dot, zone, action. */
export function TapLabels({ taps, max = 3 }: { taps: TapField; max?: number }) {
  const [items, setItems] = useState<TapLabel[]>([]);
  useEffect(
    () =>
      taps.onLabel((l) => {
        setItems((prev) => [...prev.slice(-(max - 1)), l]);
        window.setTimeout(() => setItems((prev) => prev.filter((p) => p.id !== l.id)), 1750);
      }),
    [taps, max],
  );
  return (
    <>
      {items.map((l) => (
        <Html key={l.id} position={[l.x, l.y, l.z]} zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
          <div className="tap-label" style={{ position: "absolute", left: 0, bottom: 0 }}>
            <div className="hud-pill">
              <span className="hud-dot" />
              <span style={{ color: "var(--ink-2)" }}>{l.zone}</span>
              <span aria-hidden style={{ color: "var(--ink-3)" }}>·</span>
              <span>{l.action}</span>
            </div>
          </div>
        </Html>
      ))}
    </>
  );
}
