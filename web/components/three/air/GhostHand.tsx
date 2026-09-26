"use client";

import * as THREE from "three";
import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { BONES, JOINTS, TIPS } from "./handPose";

const DUST_PER_BONE = 6;
/** fine dust across the palm, so it reads as a surface: triangle fan from the wrist over the knuckles */
const PALM_TRIS: [number, number, number][] = [[0, 5, 9], [0, 9, 13], [0, 13, 17], [0, 1, 5]];
const PALM_DUST = 14;
const TRAIL = 34;

const pointVert = /* glsl */ `
attribute float aSize;
attribute float aHot;
attribute float aAlpha;
uniform float uScale;
uniform float uOpacity;
varying float vHot;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * (1.0 + aHot * 0.8) * uScale / max(0.05, -mv.z), 1.0, 48.0);
  vHot = aHot;
  vAlpha = aAlpha * uOpacity;
}
`;

const pointFrag = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uSignal;
uniform float uDark;
varying float vHot;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  if (d2 > 1.0) discard;
  // bright core, soft falloff: a point of light, not a disc
  float core = exp(-d2 * 9.0);
  float halo = exp(-d2 * 2.6) * 0.35;
  float a = (core + halo) * vAlpha;
  vec3 col = mix(uInk, uSignal * (uDark > 0.5 ? 2.4 : 1.0), clamp(vHot, 0.0, 1.0));
  gl_FragColor = vec4(col * (uDark > 0.5 ? 1.0 : 1.0), a);
}
`;

const lineVert = /* glsl */ `
attribute float aAlpha;
uniform float uOpacity;
varying float vA;
void main() {
  vA = aAlpha * uOpacity;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const lineFrag = /* glsl */ `
uniform vec3 uInk;
varying float vA;
void main() { gl_FragColor = vec4(uInk, vA); }
`;

const JOINT_SIZE: number[] = (() => {
  const s = new Array(JOINTS).fill(0.032);
  s[0] = 0.04;
  for (const t of TIPS) s[t] = 0.036;
  return s;
})();

/**
 * One hand drawn as light: soft points at the 21 joints, fine dust along the bones, hairline bones,
 * and fading fingertip trails. Not a React component: scenes own it and call `update` in their own frame loop,
 * so the hand is always drawn from the pose solved that same frame.
 */
export class GhostHandMesh extends THREE.Group {
  /** joint positions in the parent's space, 21 x 3; write these, then call update */
  readonly joints = new Float32Array(JOINTS * 3);
  /** 0..1 signal heat per joint (a touch is felt) */
  readonly hot = new Float32Array(JOINTS);
  opacity = 1;
  private pts: THREE.Points;
  private bones: THREE.LineSegments;
  private trails: THREE.LineSegments;
  private pMat: THREE.ShaderMaterial;
  private lMat: THREE.ShaderMaterial;
  private tMat: THREE.ShaderMaterial;
  private pPos: Float32Array;
  private pHot: Float32Array;
  private bPos: Float32Array;
  private tPos: Float32Array;
  private tAlpha: Float32Array;
  private hist: Float32Array;
  private histN = 0;
  private bary: Float32Array;

  constructor(ink: string, signal: string, dark: boolean) {
    super();
    const nPts = JOINTS + BONES.length * DUST_PER_BONE + PALM_TRIS.length * PALM_DUST;
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(nPts * 3);
    this.pHot = new Float32Array(nPts);
    const size = new Float32Array(nPts);
    const alpha = new Float32Array(nPts);
    for (let j = 0; j < JOINTS; j++) {
      size[j] = JOINT_SIZE[j];
      alpha[j] = 0.95;
    }
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = JOINTS; i < nPts; i++) {
      size[i] = 0.01 + rnd() * 0.012;
      alpha[i] = 0.35 + rnd() * 0.35;
    }
    this.bary = new Float32Array(PALM_TRIS.length * PALM_DUST * 2);
    for (let i = 0; i < PALM_TRIS.length * PALM_DUST; i++) {
      let a = rnd(), b = rnd();
      if (a + b > 1) [a, b] = [1 - a, 1 - b];
      this.bary[i * 2] = a;
      this.bary[i * 2 + 1] = b;
      const k = JOINTS + BONES.length * DUST_PER_BONE + i;
      size[k] = 0.008 + rnd() * 0.008;
      alpha[k] = 0.18 + rnd() * 0.22;
    }
    pg.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute("aHot", new THREE.BufferAttribute(this.pHot, 1).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    pg.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
    this.pMat = new THREE.ShaderMaterial({
      vertexShader: pointVert,
      fragmentShader: pointFrag,
      uniforms: {
        uScale: { value: 800 },
        uOpacity: { value: 1 },
        uInk: { value: new THREE.Color(ink) },
        uSignal: { value: new THREE.Color(signal) },
        uDark: { value: dark ? 1 : 0 },
      },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.pts = new THREE.Points(pg, this.pMat);
    this.pts.frustumCulled = false;
    this.pts.renderOrder = 14;

    const bg = new THREE.BufferGeometry();
    this.bPos = new Float32Array(BONES.length * 6);
    const bA = new Float32Array(BONES.length * 2).fill(0.3);
    bg.setAttribute("position", new THREE.BufferAttribute(this.bPos, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute("aAlpha", new THREE.BufferAttribute(bA, 1));
    this.lMat = new THREE.ShaderMaterial({
      vertexShader: lineVert,
      fragmentShader: lineFrag,
      uniforms: { uInk: this.pMat.uniforms.uInk, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.bones = new THREE.LineSegments(bg, this.lMat);
    this.bones.frustumCulled = false;
    this.bones.renderOrder = 13;

    const tg = new THREE.BufferGeometry();
    const segs = TIPS.length * (TRAIL - 1);
    this.tPos = new Float32Array(segs * 6);
    this.tAlpha = new Float32Array(segs * 2);
    this.hist = new Float32Array(TIPS.length * TRAIL * 3);
    tg.setAttribute("position", new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute("aAlpha", new THREE.BufferAttribute(this.tAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.tMat = new THREE.ShaderMaterial({
      vertexShader: lineVert,
      fragmentShader: lineFrag,
      uniforms: { uInk: this.pMat.uniforms.uInk, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.trails = new THREE.LineSegments(tg, this.tMat);
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 12;
    this.add(this.trails, this.bones, this.pts);
    this.setLook(ink, signal, dark);
  }

  setLook(ink: string, signal: string, dark: boolean) {
    (this.pMat.uniforms.uInk.value as THREE.Color).set(ink);
    (this.pMat.uniforms.uSignal.value as THREE.Color).set(signal);
    this.pMat.uniforms.uDark.value = dark ? 1 : 0;
    const blend = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    for (const m of [this.pMat, this.lMat, this.tMat]) {
      if (m.blending !== blend) {
        m.blending = blend;
        m.needsUpdate = true;
      }
    }
  }

  /** Forget the trail history (after a jump, so no streak is drawn across the scene). */
  resetTrails() {
    this.histN = 0;
  }

  /** Push joints to the GPU. viewH: drawing buffer height in pixels, fovY in radians (for world sized points). */
  update(viewH: number, fovY: number) {
    const J = this.joints;
    const P = this.pPos;
    P.set(J);
    for (let j = 0; j < JOINTS; j++) this.pHot[j] = this.hot[j];
    let k = JOINTS;
    for (let b = 0; b < BONES.length; b++) {
      const [a, c] = BONES[b];
      for (let i = 0; i < DUST_PER_BONE; i++) {
        const t = (i + 0.5) / DUST_PER_BONE;
        P[k * 3] = J[a * 3] + (J[c * 3] - J[a * 3]) * t;
        P[k * 3 + 1] = J[a * 3 + 1] + (J[c * 3 + 1] - J[a * 3 + 1]) * t;
        P[k * 3 + 2] = J[a * 3 + 2] + (J[c * 3 + 2] - J[a * 3 + 2]) * t;
        this.pHot[k] = Math.max(this.hot[a], this.hot[c]) * 0.5;
        k++;
      }
      for (let i = 0; i < 3; i++) {
        this.bPos[b * 6 + i] = J[a * 3 + i];
        this.bPos[b * 6 + 3 + i] = J[c * 3 + i];
      }
    }
    for (let t = 0; t < PALM_TRIS.length; t++) {
      const [a, b, c] = PALM_TRIS[t];
      for (let i = 0; i < PALM_DUST; i++) {
        const u = this.bary[(t * PALM_DUST + i) * 2], v = this.bary[(t * PALM_DUST + i) * 2 + 1];
        for (let d = 0; d < 3; d++) P[k * 3 + d] = J[a * 3 + d] + (J[b * 3 + d] - J[a * 3 + d]) * u + (J[c * 3 + d] - J[a * 3 + d]) * v;
        this.pHot[k] = 0;
        k++;
      }
    }
    // trails: newest sample at index 0
    const H = this.hist;
    for (let f = 0; f < TIPS.length; f++) {
      const base = f * TRAIL * 3;
      const tip = TIPS[f];
      H.copyWithin(base + 3, base, base + (TRAIL - 1) * 3);
      if (this.histN === 0)
        for (let s = 0; s < TRAIL; s++) {
          H[base + s * 3] = J[tip * 3];
          H[base + s * 3 + 1] = J[tip * 3 + 1];
          H[base + s * 3 + 2] = J[tip * 3 + 2];
        }
      H[base] = J[tip * 3];
      H[base + 1] = J[tip * 3 + 1];
      H[base + 2] = J[tip * 3 + 2];
    }
    this.histN = Math.min(TRAIL, this.histN + 1);
    let s = 0;
    for (let f = 0; f < TIPS.length; f++) {
      const base = f * TRAIL * 3;
      const w = f === 1 ? 0.5 : f === 0 ? 0.3 : 0.16;
      for (let i = 0; i < TRAIL - 1; i++) {
        for (let c = 0; c < 3; c++) {
          this.tPos[s * 6 + c] = H[base + i * 3 + c];
          this.tPos[s * 6 + 3 + c] = H[base + (i + 1) * 3 + c];
        }
        const a0 = 1 - i / (TRAIL - 1);
        const a1 = 1 - (i + 1) / (TRAIL - 1);
        this.tAlpha[s * 2] = a0 * a0 * w;
        this.tAlpha[s * 2 + 1] = a1 * a1 * w;
        s++;
      }
    }
    const scale = viewH / (2 * Math.tan(fovY / 2));
    this.pMat.uniforms.uScale.value = scale;
    this.pMat.uniforms.uOpacity.value = this.opacity;
    this.lMat.uniforms.uOpacity.value = this.opacity;
    this.tMat.uniforms.uOpacity.value = this.opacity;
    this.visible = this.opacity > 0.002;
    (this.pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pts.geometry.attributes.aHot as THREE.BufferAttribute).needsUpdate = true;
    (this.bones.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trails.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trails.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.pts.geometry.dispose();
    this.bones.geometry.dispose();
    this.trails.geometry.dispose();
    this.pMat.dispose();
    this.lMat.dispose();
    this.tMat.dispose();
  }
}

/**
 * React wrapper: a ghost hand whose joints come from `solve`, called at the start of each frame
 * with the hand to fill in (write `hand.joints`, `hand.hot`, `hand.opacity`).
 */
export function GhostHand({
  solve,
  ink,
  signal,
  dark,
}: {
  solve: (hand: GhostHandMesh, t: number, dt: number) => void;
  ink: string;
  signal: string;
  dark: boolean;
}) {
  const hand = useMemo(() => new GhostHandMesh(ink, signal, dark), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => hand.dispose(), [hand]);
  useEffect(() => hand.setLook(ink, signal, dark), [hand, ink, signal, dark]);
  useFrame((s, dt) => {
    solve(hand, s.clock.elapsedTime, dt);
    hand.update(s.gl.getDrawingBufferSize(TMP).y, THREE.MathUtils.degToRad((s.camera as THREE.PerspectiveCamera).fov ?? 30));
  });
  return <primitive object={hand} />;
}
const TMP = new THREE.Vector2();
