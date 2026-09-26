"use client";

import * as THREE from "three";
import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { HAND_SCALE, J, JOINTS } from "./handPose";

/* ------------------------------------------------------------------------------------------------
 * The ghost hand is a light sculpture: one set of tapered capsules (palm slab, forearm stub, thenar
 * pad, 15 phalanges) drawn as a single translucent volume with a crisp rim. Two draw calls:
 * a depth-only pass so only the hand's outer surface is lit (no inner seams), then the rim pass.
 * A faint joint skeleton sits inside. Every frame only instance matrices and shapes are rewritten.
 * ---------------------------------------------------------------------------------------------- */

type Seg = {
  a: number;
  b: number;
  r0: number;
  r1: number;
  /** z radius as a fraction of x radius (fingers are a little flatter than round) */
  flat: number;
  /** cap length as a fraction of the radius (1 = round end) */
  cap: number;
  /** fade toward the a end (forearm) */
  fade: number;
  /** shorten the b end by this fraction of r1, so a fingertip ends at the tip joint */
  trim: number;
  kind: "palm" | "arm" | "bone";
};

const S = HAND_SCALE;
const bone = (a: number, b: number, r0: number, r1: number, trim = 0, flat = 0.86): Seg => ({ a, b, r0: r0 * S, r1: r1 * S, flat, cap: 1, fade: 0, trim, kind: "bone" });

const SEGS: Seg[] = [
  { a: 0, b: 0, r0: 0.3 * S, r1: 0.43 * S, flat: 0.34, cap: 0.36, fade: 0, trim: 0, kind: "palm" },
  { a: 0, b: 0, r0: 0.24 * S, r1: 0.26 * S, flat: 0.68, cap: 0.6, fade: 1, trim: 0, kind: "arm" },
  bone(J.T_CMC, J.T_MCP, 0.155, 0.108, 0, 0.78),
  bone(J.T_MCP, J.T_IP, 0.1, 0.092),
  bone(J.T_IP, J.T_TIP, 0.09, 0.078, 1),
  bone(J.I_MCP, J.I_PIP, 0.09, 0.083),
  bone(J.I_PIP, J.I_DIP, 0.08, 0.074),
  bone(J.I_DIP, J.I_TIP, 0.072, 0.064, 1),
  bone(J.M_MCP, J.M_PIP, 0.094, 0.087),
  bone(J.M_PIP, J.M_DIP, 0.084, 0.077),
  bone(J.M_DIP, J.M_TIP, 0.075, 0.066, 1),
  bone(J.R_MCP, J.R_PIP, 0.088, 0.081),
  bone(J.R_PIP, J.R_DIP, 0.078, 0.072),
  bone(J.R_DIP, J.R_TIP, 0.07, 0.062, 1),
  bone(J.L_MCP, J.L_PIP, 0.078, 0.072),
  bone(J.L_PIP, J.L_DIP, 0.068, 0.062),
  bone(J.L_DIP, J.L_TIP, 0.06, 0.053, 1),
];
const N = SEGS.length;
const MCPS = [J.I_MCP, J.M_MCP, J.R_MCP, J.L_MCP];

const volumeVert = /* glsl */ `
attribute vec4 aShape;   // r0, r1, length, flatZ
attribute vec3 aShape2;  // cap, fade, hot (at the b end)
varying vec3 vN;
varying vec3 vV;
varying float vT;
varying float vFade;
varying float vHot;
void main() {
  float r0 = aShape.x, r1 = aShape.y, L = aShape.z, fz = aShape.w, cap = aShape2.x;
  vec3 p = position;
  vec3 q;
  vec3 n = normal;
  if (p.y > 0.5) {
    q = vec3(p.x * r1, L * 0.5 + (p.y - 0.5) * r1 * cap, p.z * r1 * fz);
    n = vec3(normal.x, normal.y / max(cap, 0.05), normal.z / fz);
  } else if (p.y < -0.5) {
    q = vec3(p.x * r0, -L * 0.5 + (p.y + 0.5) * r0 * cap, p.z * r0 * fz);
    n = vec3(normal.x, normal.y / max(cap, 0.05), normal.z / fz);
  } else {
    float r = mix(r0, r1, p.y + 0.5);
    q = vec3(p.x * r, p.y * L, p.z * r * fz);
    n = vec3(normal.x, (r0 - r1) / max(L, 1e-3), normal.z / fz);
  }
  vT = clamp(q.y / max(L, 1e-3) + 0.5, 0.0, 1.0);
  vFade = aShape2.y;
  vHot = aShape2.z;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(q, 1.0);
  vN = normalize(normalMatrix * (mat3(instanceMatrix) * n));
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const volumeFrag = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uSignal;
uniform float uOpacity;
uniform float uDark;
varying vec3 vN;
varying vec3 vV;
varying float vT;
varying float vFade;
varying float vHot;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float ndv = abs(dot(n, v));
  // crisp rim at the silhouette, nearly clear where the surface faces the camera
  float rim = pow(1.0 - ndv, 3.0);
  // a soft key from above left gives the volume its form, like light caught in glass
  float key = pow(max(dot(n, normalize(vec3(-0.35, 0.75, 0.55))), 0.0), 2.0);
  float a = rim * 0.95 + key * 0.06 + 0.014;
  a *= mix(1.0, smoothstep(0.05, 0.95, vT), vFade);
  float hot = vHot * smoothstep(0.45, 1.0, vT);
  vec3 col = mix(uInk, uSignal * (uDark > 0.5 ? 1.8 : 1.0), clamp(hot, 0.0, 1.0));
  a += hot * 0.45;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uOpacity);
}
`;

const pointVert = /* glsl */ `
uniform float uScale;
uniform float uOpacity;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(0.014 * uScale / max(0.05, -mv.z), 1.0, 12.0);
}
`;
const pointFrag = /* glsl */ `
uniform vec3 uInk;
uniform float uOpacity;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  if (d2 > 1.0) discard;
  gl_FragColor = vec4(uInk, exp(-d2 * 4.0) * 0.32 * uOpacity);
}
`;

const TRAIL = 30;
const TRAIL_TIPS = [J.T_TIP, J.I_TIP];

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

const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vMid = new THREE.Vector3();
const ax = new THREE.Vector3();
const ay = new THREE.Vector3();
const az = new THREE.Vector3();
const side = new THREE.Vector3();
const fwd = new THREE.Vector3();
const knuck = new THREE.Vector3();
const wrist = new THREE.Vector3();
const M = new THREE.Matrix4();

export class GhostHandMesh extends THREE.Group {
  /** joint positions in the parent's space, 21 x 3; write these, then call update */
  readonly joints = new Float32Array(JOINTS * 3);
  /** 0..1 signal heat per joint (a touch is felt) */
  readonly hot = new Float32Array(JOINTS);
  opacity = 1;
  private geo: THREE.CapsuleGeometry;
  private depth: THREE.InstancedMesh;
  private shell: THREE.InstancedMesh;
  private depthMat: THREE.ShaderMaterial;
  private shellMat: THREE.ShaderMaterial;
  private shape: Float32Array;
  private shape2: Float32Array;
  private pts: THREE.Points;
  private pMat: THREE.ShaderMaterial;
  private trails: THREE.LineSegments;
  private tMat: THREE.ShaderMaterial;
  private tPos: Float32Array;
  private hist: Float32Array;
  private histN = 0;

  constructor(ink: string, signal: string, dark: boolean) {
    super();
    this.geo = new THREE.CapsuleGeometry(1, 1, 10, 22, 1);
    this.shape = new Float32Array(N * 4);
    this.shape2 = new Float32Array(N * 3);
    const shapeAttr = new THREE.InstancedBufferAttribute(this.shape, 4).setUsage(THREE.DynamicDrawUsage);
    const shape2Attr = new THREE.InstancedBufferAttribute(this.shape2, 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aShape", shapeAttr);
    this.geo.setAttribute("aShape2", shape2Attr);
    const uniforms = {
      uInk: { value: new THREE.Color(ink) },
      uSignal: { value: new THREE.Color(signal) },
      uOpacity: { value: 1 },
      uDark: { value: dark ? 1 : 0 },
    };
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: volumeVert,
      fragmentShader: "void main() { gl_FragColor = vec4(0.0); }",
      colorWrite: false,
      depthWrite: true,
      transparent: true,
    });
    this.shellMat = new THREE.ShaderMaterial({
      vertexShader: volumeVert,
      fragmentShader: volumeFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      toneMapped: false,
    });
    this.depth = new THREE.InstancedMesh(this.geo, this.depthMat, N);
    this.shell = new THREE.InstancedMesh(this.geo, this.shellMat, N);
    this.shell.instanceMatrix = this.depth.instanceMatrix;
    this.depth.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (const m of [this.depth, this.shell]) {
      m.frustumCulled = false;
      m.raycast = () => {};
    }
    this.depth.renderOrder = 13;
    this.shell.renderOrder = 14;

    // faint skeleton inside: joints only
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(this.joints, 3).setUsage(THREE.DynamicDrawUsage));
    this.pMat = new THREE.ShaderMaterial({
      vertexShader: pointVert,
      fragmentShader: pointFrag,
      uniforms: { uScale: { value: 800 }, uOpacity: { value: 1 }, uInk: uniforms.uInk },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.pts = new THREE.Points(pg, this.pMat);
    this.pts.frustumCulled = false;
    this.pts.renderOrder = 12;

    // fingertip trails (thumb and index)
    const tg = new THREE.BufferGeometry();
    const segs = TRAIL_TIPS.length * (TRAIL - 1);
    this.tPos = new Float32Array(segs * 6);
    const tA = new Float32Array(segs * 2);
    let s = 0;
    for (let f = 0; f < TRAIL_TIPS.length; f++)
      for (let i = 0; i < TRAIL - 1; i++, s++) {
        const a0 = 1 - i / (TRAIL - 1), a1 = 1 - (i + 1) / (TRAIL - 1);
        tA[s * 2] = a0 * a0 * 0.3;
        tA[s * 2 + 1] = a1 * a1 * 0.3;
      }
    this.hist = new Float32Array(TRAIL_TIPS.length * TRAIL * 3);
    tg.setAttribute("position", new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute("aAlpha", new THREE.BufferAttribute(tA, 1));
    this.tMat = new THREE.ShaderMaterial({
      vertexShader: lineVert,
      fragmentShader: lineFrag,
      uniforms: { uInk: uniforms.uInk, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.trails = new THREE.LineSegments(tg, this.tMat);
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 12;

    this.add(this.trails, this.pts, this.depth, this.shell);
    this.setLook(ink, signal, dark);
  }

  setLook(ink: string, signal: string, dark: boolean) {
    const u = this.shellMat.uniforms;
    (u.uInk.value as THREE.Color).set(ink);
    (u.uSignal.value as THREE.Color).set(signal);
    u.uDark.value = dark ? 1 : 0;
    const blend = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    for (const m of [this.shellMat, this.pMat, this.tMat]) {
      if (m.blending !== blend) {
        m.blending = blend;
        m.needsUpdate = true;
      }
    }
  }

  resetTrails() {
    this.histN = 0;
  }

  private j(i: number, v: THREE.Vector3) {
    return v.set(this.joints[i * 3], this.joints[i * 3 + 1], this.joints[i * 3 + 2]);
  }

  /** Push the pose to the GPU. viewH: drawing buffer height in pixels, fovY in radians. */
  update(viewH: number, fovY: number) {
    // palm frame from the joints
    this.j(J.WRIST, wrist);
    knuck.set(0, 0, 0);
    for (const k of MCPS) knuck.add(this.j(k, vA));
    knuck.multiplyScalar(0.25);
    fwd.subVectors(knuck, wrist).normalize();
    side.subVectors(this.j(J.L_MCP, vA), this.j(J.I_MCP, vB));
    // a mirrored (left) hand has its little finger on the other side; the basis stays right handed either way
    for (let i = 0; i < N; i++) {
      const g = SEGS[i];
      if (g.kind === "palm") {
        vA.copy(wrist).addScaledVector(fwd, 0.1 * S);
        vB.copy(knuck).addScaledVector(fwd, -0.06 * S);
        // the palm sits a touch toward the thumb, where the thenar pad fills it
        vA.addScaledVector(side, -0.04);
      } else if (g.kind === "arm") {
        vA.copy(wrist).addScaledVector(fwd, -0.5 * S);
        vB.copy(wrist).addScaledVector(fwd, 0.02 * S);
      } else {
        this.j(g.a, vA);
        this.j(g.b, vB);
      }
      ay.subVectors(vB, vA);
      let L = ay.length();
      if (L < 1e-5) {
        ay.set(0, 1, 0);
        L = 1e-5;
      } else ay.divideScalar(L);
      if (g.trim > 0) {
        const cut = Math.min(L * 0.5, g.r1 * g.trim);
        vB.addScaledVector(ay, -cut);
        L -= cut;
      }
      ax.copy(side).addScaledVector(ay, -side.dot(ay));
      if (ax.lengthSq() < 1e-8) ax.set(1, 0, 0);
      ax.normalize();
      az.crossVectors(ax, ay);
      vMid.addVectors(vA, vB).multiplyScalar(0.5);
      M.makeBasis(ax, ay, az).setPosition(vMid);
      this.depth.setMatrixAt(i, M);
      this.shape[i * 4] = g.r0;
      this.shape[i * 4 + 1] = g.r1;
      this.shape[i * 4 + 2] = L;
      this.shape[i * 4 + 3] = g.flat;
      this.shape2[i * 3] = g.cap;
      this.shape2[i * 3 + 1] = g.fade;
      this.shape2[i * 3 + 2] = g.kind === "bone" ? this.hot[g.b] : 0;
    }
    this.depth.instanceMatrix.needsUpdate = true;
    (this.geo.attributes.aShape as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.geo.attributes.aShape2 as THREE.InstancedBufferAttribute).needsUpdate = true;

    // trails, newest first
    const H = this.hist;
    for (let f = 0; f < TRAIL_TIPS.length; f++) {
      const base = f * TRAIL * 3;
      const tip = TRAIL_TIPS[f];
      H.copyWithin(base + 3, base, base + (TRAIL - 1) * 3);
      if (this.histN === 0)
        for (let s = 0; s < TRAIL; s++) for (let c = 0; c < 3; c++) H[base + s * 3 + c] = this.joints[tip * 3 + c];
      for (let c = 0; c < 3; c++) H[base + c] = this.joints[tip * 3 + c];
    }
    this.histN = Math.min(TRAIL, this.histN + 1);
    let s = 0;
    for (let f = 0; f < TRAIL_TIPS.length; f++) {
      const base = f * TRAIL * 3;
      for (let i = 0; i < TRAIL - 1; i++, s++)
        for (let c = 0; c < 3; c++) {
          this.tPos[s * 6 + c] = H[base + i * 3 + c];
          this.tPos[s * 6 + 3 + c] = H[base + (i + 1) * 3 + c];
        }
    }
    (this.trails.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    this.pMat.uniforms.uScale.value = viewH / (2 * Math.tan(fovY / 2));
    this.pMat.uniforms.uOpacity.value = this.opacity;
    this.tMat.uniforms.uOpacity.value = this.opacity;
    this.shellMat.uniforms.uOpacity.value = this.opacity;
    this.visible = this.opacity > 0.002;
  }

  dispose() {
    this.geo.dispose();
    this.depthMat.dispose();
    this.shellMat.dispose();
    this.pts.geometry.dispose();
    this.pMat.dispose();
    this.trails.geometry.dispose();
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
