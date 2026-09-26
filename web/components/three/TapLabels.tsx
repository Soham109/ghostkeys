"use client";

import * as THREE from "three";
import { useEffect, useState } from "react";
import { Html } from "@react-three/drei";
import type { TapField, TapLabel } from "./taps";
import { hitsCopy, project, safeArea } from "./safeArea";

/** Pill size used for clamping (the pill grows up and right from its anchor). */
const PILL_W = 250;
const PILL_H = 34;

/**
 * Keeps the pill inside the safe area: never off-screen, never over the site's copy column or caption row.
 * The anchor is the tap point; when the tap is outside the safe area the pill slides to its nearest edge.
 */
function clampPosition(el: THREE.Object3D, camera: THREE.Camera, size: { width: number; height: number }) {
  const s = safeArea(size.width, size.height);
  const p = project(el, camera, size.width, size.height) ?? [-9999, -9999];
  const x = Math.min(Math.max(p[0], s.x0), s.x1 - PILL_W);
  const y = Math.min(Math.max(p[1], s.y0 + PILL_H), s.y1);
  // never on a headline: park it out of view instead (it is short-lived; the screen HUD repeats it)
  if (hitsCopy(x, y - PILL_H, x + PILL_W, y)) return [-9999, -9999];
  return [x, y];
}

/** The HUD pill that floats up from where a tap landed: signal dot, zone, action. One at a time; none on phones. */
export function TapLabels({ taps, max = 1 }: { taps: TapField; max?: number }) {
  const [items, setItems] = useState<TapLabel[]>([]);
  useEffect(
    () =>
      taps.onLabel((l) => {
        if (safeArea(window.innerWidth, window.innerHeight).narrow) return;
        setItems((prev) => [...prev.slice(-(max - 1) || prev.length), l].slice(-max));
        window.setTimeout(() => setItems((prev) => prev.filter((p) => p.id !== l.id)), 1750);
      }),
    [taps, max],
  );
  return (
    <>
      {items.map((l) => (
        <Html key={l.id} position={[l.x, l.y, l.z]} zIndexRange={[30, 0]} style={{ pointerEvents: "none" }} calculatePosition={clampPosition}>
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
