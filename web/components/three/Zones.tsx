"use client";

import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { hitsCopy, project, safeArea } from "./safeArea";
import { Html } from "@react-three/drei";
import { BASE_H, D, W } from "@/lib/dims";
import type { Surface, Zone } from "@/lib/zones";
import type { TapField } from "./taps";

export type ZoneRuntime = {
  /** 0..1 visibility per zone id */
  levels: Record<string, number>;
  /** time of the last flash per zone id */
  flashes: Record<string, number>;
  /** label text per zone id; empty hides the label */
  labels: Record<string, string>;
  /** zone under the pointer, if any */
  hover: string | null;
};

export const makeZoneRuntime = (): ZoneRuntime => ({ levels: {}, flashes: {}, labels: {}, hover: null });

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const frag = /* glsl */ `
uniform vec2 uSize;
uniform float uLevel;
uniform float uFlash;
uniform float uHover;
uniform vec3 uInk;
uniform vec3 uSignal;
varying vec2 vUv;
float sdRoundRect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  float r = min(0.03, min(uSize.x, uSize.y) * 0.3);
  float sd = sdRoundRect(p, uSize * 0.5 - 0.006, r);
  float px = fwidth(sd);
  float edge = 1.0 - smoothstep(0.0, px * 1.5, abs(sd));
  // registration-mark corners: the edge is strong only near the corners
  vec2 c = uSize * 0.5 - abs(p);
  float corner = step(min(c.x, c.y), 0.06) * step(max(c.x, c.y), max(0.06, min(uSize.x, uSize.y) * 0.22) + 0.06);
  float inside = 1.0 - smoothstep(-px, px, sd);
  vec2 g = fract(p * 42.0) - 0.5;
  float dotGrid = (1.0 - smoothstep(0.08, 0.14, length(g))) * inside;
  float a = edge * mix(0.28, 1.0, corner) * uLevel + dotGrid * (0.14 * uLevel + uFlash * 0.9) + inside * 0.05 * uHover;
  vec3 col = uInk;
  // a flash brightens the outline in ink; the orange ring at the touch point says the rest
  a += edge * uFlash + inside * uFlash * 0.04;
  gl_FragColor = vec4(col * (1.0 + uFlash * 1.5), clamp(a, 0.0, 1.0));
}
`;

function placement(z: Zone): { pos: [number, number, number]; rot: [number, number, number]; size: [number, number]; label: [number, number, number] } {
  const { x, y, w, h } = z.rect;
  if (z.surface === "base") {
    const cx = (x + w / 2 - 0.5) * W;
    const cz = (y + h / 2 - 0.5) * D;
    return { pos: [cx, 0.0026, cz], rot: [-Math.PI / 2, 0, 0], size: [w * W, h * D], label: [cx, 0.05, cz] };
  }
  if (z.surface === "lid") {
    const cx = (x + w / 2 - 0.5) * W;
    const cz = (y + h / 2 - 0.5) * D;
    return { pos: [cx, 0.0535, cz], rot: [-Math.PI / 2, 0, 0], size: [w * W, h * D], label: [cx, 0.09, cz] };
  }
  const side = z.surface === "edge-left" ? -1 : 1;
  const cz = (y + h / 2 - 0.5) * D;
  return {
    pos: [side * (W / 2 + 0.0015), -BASE_H / 2 - 0.002, cz],
    rot: [0, side * Math.PI / 2, 0],
    size: [h * D, BASE_H - 0.03],
    label: [side * (W / 2 + 0.12), -BASE_H / 2, cz],
  };
}

/** Renders every zone on one surface as a hairline outline with registration corners. */
export function ZoneLayer({
  zones,
  surface,
  rt,
  taps,
  ink,
  signal,
  dark,
  showLabels = true,
}: {
  zones: Zone[];
  surface: Surface | "edges";
  rt: ZoneRuntime;
  taps: TapField;
  ink: string;
  signal: string;
  dark: boolean;
  showLabels?: boolean;
}) {
  const list = zones.filter((z) => (surface === "edges" ? z.surface === "edge-left" || z.surface === "edge-right" : z.surface === surface));
  return (
    <>
      {list.map((z) => (
        <ZonePlane key={z.id} zone={z} rt={rt} taps={taps} ink={ink} signal={signal} dark={dark} showLabel={showLabels} />
      ))}
    </>
  );
}

function ZonePlane({ zone, rt, taps, ink, signal, dark, showLabel }: { zone: Zone; rt: ZoneRuntime; taps: TapField; ink: string; signal: string; dark: boolean; showLabel: boolean }) {
  const p = useMemo(() => placement(zone), [zone]);
  const mat = useRef<THREE.ShaderMaterial>(null!);
  const labelEl = useRef<HTMLDivElement>(null!);
  const textEl = useRef<HTMLSpanElement>(null!);
  const lastText = useRef("");
  const uniforms = useMemo(
    () => ({
      uSize: { value: new THREE.Vector2(p.size[0], p.size[1]) },
      uLevel: { value: 0 },
      uFlash: { value: 0 },
      uHover: { value: 0 },
      uInk: { value: new THREE.Color(ink) },
      uSignal: { value: new THREE.Color(signal) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p],
  );
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  const anchor = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const u = mat.current.uniforms;
    u.uInk.value.set(ink);
    u.uSignal.value.set(signal);
    const target = rt.levels[zone.id] ?? 0;
    u.uLevel.value = THREE.MathUtils.damp(u.uLevel.value, target, 8, dt);
    const age = taps.time - (rt.flashes[zone.id] ?? -100);
    u.uFlash.value = age >= 0 ? Math.exp(-age * 2.6) : 0;
    u.uHover.value = THREE.MathUtils.damp(u.uHover.value, rt.hover === zone.id ? 1 : 0, 12, dt);
    if (labelEl.current) {
      const text = rt.labels[zone.id] ?? "";
      if (text !== lastText.current && textEl.current) {
        textEl.current.textContent = text;
        lastText.current = text;
      }
      // a label only shows where its zone is on screen and clear of the copy; it never gets pushed off its zone
      let inside = false;
      if (text && anchor.current) {
        const s = safeArea(size.width, size.height);
        const q = project(anchor.current, camera, size.width, size.height);
        const half = text.length * 4 + 12;
        inside = !!q && !s.narrow && q[0] - half > s.x0 && q[0] + half < s.x1 && q[1] > s.y0 && q[1] < s.y1 && !hitsCopy(q[0] - half, q[1] - 10, q[0] + half, q[1] + 10);
      }
      labelEl.current.style.opacity = String(inside ? Math.min(1, u.uLevel.value * 1.2) : 0);
    }
  });
  return (
    <>
      <mesh position={p.pos} rotation={p.rot} renderOrder={6} raycast={() => null}>
        <planeGeometry args={[p.size[0], p.size[1]]} />
        <shaderMaterial
          ref={mat}
          vertexShader={vert}
          fragmentShader={frag}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={dark ? THREE.AdditiveBlending : THREE.NormalBlending}
          toneMapped={false}
          polygonOffset
          polygonOffsetFactor={-2}
        />
      </mesh>
      <group ref={anchor} position={p.label} />
      {showLabel && (
        <Html position={p.label} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
          <div ref={labelEl} style={{ opacity: 0, transition: "opacity 240ms var(--ease-snap)" }}>
            <span ref={textEl} className="label" style={{ color: "var(--ink)", whiteSpace: "nowrap", textShadow: "0 0 12px var(--bg), 0 0 4px var(--bg)" }} />
          </div>
        </Html>
      )}
    </>
  );
}
