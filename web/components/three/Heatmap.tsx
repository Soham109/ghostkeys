"use client";

import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { D, W } from "@/lib/dims";
import { ZONES } from "@/lib/zones";
import type { TapField } from "./taps";

const TX = 192;
const TY = Math.round((TX * D) / W);

export const CAL_ZONES = ["left-palm", "right-palm", "left-grille", "right-grille", "top-strip"];
export const TAPS_PER_ZONE = 20;

/** Calibration taps, zone by zone, scattered the way real fingers land. */
export function calibrationPoints() {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-6)) * Math.cos(2 * Math.PI * rnd());
  const pts: { u: number; v: number; zone: string }[] = [];
  for (const id of CAL_ZONES) {
    const z = ZONES.find((q) => q.id === id)!;
    const cx = z.rect.x + z.rect.w / 2;
    const cy = z.rect.y + z.rect.h / 2;
    for (let i = 0; i < TAPS_PER_ZONE; i++) {
      const u = THREE.MathUtils.clamp(cx + gauss() * z.rect.w * 0.2, z.rect.x, z.rect.x + z.rect.w);
      const v = THREE.MathUtils.clamp(cy + gauss() * z.rect.h * 0.2, z.rect.y, z.rect.y + z.rect.h);
      pts.push({ u, v, zone: id });
    }
  }
  return pts;
}

const frag = /* glsl */ `
uniform sampler2D uHeat;
uniform float uLevel;
uniform vec3 uInk;
uniform vec3 uSignal;
uniform float uDark;
varying vec2 vUv;
void main() {
  float t = clamp(texture2D(uHeat, vUv).r, 0.0, 1.0);
  // topographic contours, like an instrument plot
  float bands = t * 4.0;
  float fw = fwidth(bands);
  float line = 1.0 - smoothstep(0.0, fw * 1.4, abs(fract(bands) - 0.5) - 0.5 + fw);
  line *= step(0.08, t);
  float core = smoothstep(0.55, 0.95, t);
  vec3 col = mix(uInk, uSignal, core);
  float a = line * 0.45 * (1.0 - core) + smoothstep(0.1, 0.9, t) * 0.05 + core * 0.55;
  gl_FragColor = vec4(col, a * uLevel);
}
`;

/** Heat map that builds as calibration taps arrive. `progress` 0..1 maps to how many taps have landed. */
export function Heatmap({ progress, taps, ink, signal, dark }: { progress: () => number; taps: TapField; ink: string; signal: string; dark: boolean }) {
  const pts = useMemo(calibrationPoints, []);
  const data = useMemo(() => new Float32Array(TX * TY), []);
  const tex = useMemo(() => {
    const t = new THREE.DataTexture(data, TX, TY, THREE.RedFormat, THREE.FloatType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }, [data]);
  useEffect(() => () => tex.dispose(), [tex]);
  const count = useRef(0);
  const mat = useRef<THREE.ShaderMaterial>(null!);
  const [uniforms] = useState(() => ({
    uHeat: { value: tex },
    uLevel: { value: 0 },
    uInk: { value: new THREE.Color(ink) },
    uSignal: { value: new THREE.Color(signal) },
    uDark: { value: dark ? 1 : 0 },
  }));

  const splat = (u: number, v: number, sign: number) => {
    const cx = u * TX;
    const cy = v * TY;
    const r = 7;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(TY, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(TX, Math.ceil(cx + r)); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        data[y * TX + x] += sign * Math.exp(-d2 / 9) * 0.26;
      }
  };

  useFrame(() => {
    const p = progress();
    const n = Math.round(THREE.MathUtils.clamp(p, 0, 1) * pts.length);
    if (n !== count.current) {
      if (n > count.current) {
        for (let i = count.current; i < n; i++) {
          splat(pts[i].u, pts[i].v, 1);
          if (n - count.current < 4) taps.tap((pts[i].u - 0.5) * W, (pts[i].v - 0.5) * D, 0.35);
        }
      } else {
        for (let i = n; i < count.current; i++) splat(pts[i].u, pts[i].v, -1);
      }
      count.current = n;
      tex.needsUpdate = true;
    }
    const u = mat.current.uniforms;
    u.uLevel.value = THREE.MathUtils.clamp(p * 8, 0, 1);
    u.uInk.value.set(ink);
    u.uSignal.value.set(signal);
    u.uDark.value = dark ? 1 : 0;
    mat.current.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  });

  return (
    <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={7} raycast={() => null}>
      <planeGeometry args={[W, D]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={`varying vec2 vUv; void main(){ vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`}
        fragmentShader={frag}
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
