"use client";

import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { GPUComputationRenderer, type Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { D, GRILLE, HINGE_Z, KB, LID_T, PAD, PLAN_R, W } from "@/lib/dims";
import { CURL_GLSL } from "./glsl";
import { buildKeys } from "./geometry";
import type { LaptopParts } from "./Laptop";

/** Lid angle the particle laptop forms at; the solid lid then opens from here. */
export const PARTICLE_LID = 72;

/**
 * Velocity: spring toward the target, curl-noise flow on top, and during the hand-over a swirl around a vertical
 * axis between the mark and the laptop, so the points travel on long curved paths instead of straight lines.
 */
const velocityShader = /* glsl */ `
${CURL_GLSL}
uniform float uTime;
uniform float uK;
uniform float uNoise;
uniform float uMix;
uniform float uSwirl;
uniform float uDt;
uniform vec3 uAxis;
uniform sampler2D uTargetA;
uniform sampler2D uTargetB;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(texturePosition, uv);
  vec4 v = texture2D(textureVelocity, uv);
  vec4 ta = texture2D(uTargetA, uv);
  vec4 tb = texture2D(uTargetB, uv);
  // staggered departure: each point leaves the mark at its own moment
  float m = smoothstep(0.0, 1.0, clamp(uMix * 1.7 - p.w * 0.7, 0.0, 1.0));
  vec3 target = mix(ta.xyz, tb.xyz, m);
  float group = ta.w;
  // the touch point settles last
  float late = (group > 1.5 && uMix < 0.5) ? 0.45 : 1.0;
  float k = uK * (0.6 + p.w * 0.8) * late;
  vec3 acc = (target - p.xyz) * k;
  acc += curlNoise(p.xyz * 0.85 + uTime * 0.12) * uNoise * 0.0045;
  // swirl: in flight only (m between 0 and 1), strongest mid-journey
  float flight = m * (1.0 - m) * 4.0;
  vec3 r = p.xyz - uAxis;
  acc += vec3(-r.z, 0.0, r.x) * uSwirl * flight * 0.0035 + vec3(0.0, 0.0012, 0.0) * uSwirl * flight;
  v.xyz = (v.xyz + acc * uDt) * pow(0.905, uDt);
  gl_FragColor = v;
}
`;

const positionShader = /* glsl */ `
uniform float uDt;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(texturePosition, uv);
  vec4 v = texture2D(textureVelocity, uv);
  p.xyz += v.xyz * uDt;
  gl_FragColor = p;
}
`;

const renderVert = /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uTargetA;
uniform float uPixelRatio;
uniform float uMix;
uniform float uOpacity;
uniform float uFlash;
uniform float uDensity;
uniform vec3 uInk;
uniform vec3 uSignal;
attribute vec2 aRef;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 p = texture2D(uPos, aRef);
  float speed = length(texture2D(uVel, aRef).xyz);
  float group = texture2D(uTargetA, aRef).w;
  vec4 mv = modelViewMatrix * vec4(p.xyz, 1.0);
  gl_Position = projectionMatrix * mv;
  float rnd = fract(p.w * 7.13);
  float size = mix(0.9, 1.9, rnd * rnd);
  gl_PointSize = size * uPixelRatio * clamp(5.5 / -mv.z, 0.45, 2.2);
  // ghost keycap at 35%, as in the mark; the touch point dimmer until it flashes
  float ghost = (group > 0.5 && group < 1.5) ? mix(0.38, 1.0, uMix) : 1.0;
  // points in flight are fainter and slightly warmer-white streaks of light
  float fly = clamp(speed * 30.0, 0.0, 1.0);
  vAlpha = ghost * uOpacity * uDensity * mix(1.0, 0.55, fly) * (0.55 + 0.45 * rnd);
  bool dot = group > 1.5 && group < 2.5;
  vColor = dot ? mix(uInk, uSignal * 2.4, uFlash * (1.0 - uMix)) : uInk;
  if (dot) vAlpha *= mix(0.55, 1.0, uFlash);
}
`;

const renderFrag = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0) discard;
  float a = vAlpha * (1.0 - d) * (1.0 - d);
  gl_FragColor = vec4(vColor, a);
}
`;

export type ParticleControl = {
  k: number;
  noise: number;
  mix: number;
  opacity: number;
  flash: number;
  /** 0..1 curved-path swirl during the hand-over */
  swirl: number;
  done: boolean;
};

type Props = {
  size: number;
  parts: LaptopParts | null;
  control: ParticleControl;
  /** logo placement: center and orientation (camera-facing basis) */
  logoCenter: THREE.Vector3;
  logoQuat: THREE.Quaternion;
  ink: string;
  signal: string;
  dark: boolean;
};

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** A point on the outline of a rounded rectangle, u in 0..1 along the perimeter. */
function onRoundedRect(cx: number, cy: number, w: number, h: number, r: number, u: number): [number, number] {
  const sw = w - 2 * r, sh = h - 2 * r, arc = (Math.PI * r) / 2;
  const lens = [sw, arc, sh, arc, sw, arc, sh, arc];
  let d = u * lens.reduce((a, b) => a + b, 0);
  const x = cx - w / 2, y = cy - h / 2;
  const segs: ((k: number) => [number, number])[] = [
    (k) => [x + r + k, y],
    (k) => { const a = -Math.PI / 2 + k / r; return [x + w - r + Math.cos(a) * r, y + r + Math.sin(a) * r]; },
    (k) => [x + w, y + r + k],
    (k) => { const a = k / r; return [x + w - r + Math.cos(a) * r, y + h - r + Math.sin(a) * r]; },
    (k) => [x + w - r - k, y + h],
    (k) => { const a = Math.PI / 2 + k / r; return [x + r + Math.cos(a) * r, y + h - r + Math.sin(a) * r]; },
    (k) => [x, y + h - r - k],
    (k) => { const a = Math.PI + k / r; return [x + r + Math.cos(a) * r, y + r + Math.sin(a) * r]; },
  ];
  for (let i = 0; i < 8; i++) {
    if (d <= lens[i]) return segs[i](d);
    d -= lens[i];
  }
  return [x + r, y];
}

async function logoTargets(n: number, center: THREE.Vector3, quat: THREE.Quaternion) {
  const txt = await fetch("/logo.svg").then((r) => r.text());
  const data = new SVGLoader().parse(txt);
  const rnd = rng(42);
  const out = new Float32Array(n * 4);
  // paths in document order: ghost keycap, front keycap, touch point
  const [ghost, front, dot] = data.paths;
  const counts = [Math.floor(n * 0.6), Math.floor(n * 0.33)];
  counts.push(n - counts[0] - counts[1]);
  const scale = 1.6 / 72;
  const tmp = new THREE.Vector3();
  let i = 0;
  const put = (x: number, y: number, group: number, depth = 0.06) => {
    tmp.set((x - 64) * scale, -(y - 64) * scale, (rnd() - 0.5) * depth).applyQuaternion(quat).add(center);
    out[i * 4] = tmp.x;
    out[i * 4 + 1] = tmp.y;
    out[i * 4 + 2] = tmp.z;
    out[i * 4 + 3] = group;
    i++;
  };
  const strokeSample = (path: (typeof data.paths)[number], count: number, group: number) => {
    const pts = path.subPaths.flatMap((sp) => sp.getSpacedPoints(Math.max(256, Math.floor(count / 4))));
    for (let k = 0; k < count; k++) {
      const a = pts[Math.floor(rnd() * pts.length)];
      // across the 6-unit stroke: dense core, soft shoulders (so it reads as a line of light, not a tube)
      const ang = rnd() * Math.PI * 2;
      const r = rnd() < 0.88 ? rnd() * rnd() * 1.9 : rnd() * 3.4;
      put(a.x + Math.cos(ang) * r, a.y + Math.sin(ang) * r, group);
    }
  };
  strokeSample(front, counts[0], 0);
  strokeSample(ghost, counts[1], 1);
  // the touch point: a filled disc
  const pts = dot.subPaths.flatMap((sp) => sp.getPoints(64));
  const c = pts.reduce((acc, p) => acc.add(p), new THREE.Vector2()).multiplyScalar(1 / pts.length);
  for (let k = 0; k < counts[2]; k++) {
    const ang = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 6.6;
    put(c.x + Math.cos(ang) * r, c.y + Math.sin(ang) * r, 2, 0.02);
  }
  return out;
}

/**
 * Laptop targets, weighted toward the lines that define it (rims, key outlines, trackpad, grille, screen edge),
 * so the particle laptop reads as a drawing in light rather than a fog of points.
 */
function laptopTargets(n: number) {
  const rnd = rng(7);
  const out = new Float32Array(n * 4);
  const tmp = new THREE.Vector3();
  const lidM = new THREE.Matrix4()
    .makeTranslation(0, 0, HINGE_Z)
    .multiply(new THREE.Matrix4().makeRotationX(-THREE.MathUtils.degToRad(PARTICLE_LID)))
    .multiply(new THREE.Matrix4().makeTranslation(0, 0, D / 2 - 0.03));
  const keys = buildKeys();
  let i = 0;
  const put = (x: number, y: number, z: number, m?: THREE.Matrix4) => {
    tmp.set(x, y, z);
    if (m) tmp.applyMatrix4(m);
    out[i * 4] = tmp.x;
    out[i * 4 + 1] = tmp.y;
    out[i * 4 + 2] = tmp.z;
    out[i * 4 + 3] = 3;
    i++;
  };
  const j = (s: number) => (rnd() - 0.5) * s;
  const quota = [0.2, 0.22, 0.07, 0.06, 0.13, 0.15, 0.1, 0.03, 0.04];
  const counts = quota.map((q) => Math.floor(q * n));
  counts[counts.length - 1] += n - counts.reduce((a, b) => a + b, 0);
  const lidZ = (D - 0.04) / 2;
  const scrZ = 1.1375 - (D / 2 - 0.03);
  // 0: base rims, top and bottom edges of the chassis
  for (let k = 0; k < counts[0]; k++) {
    const [x, z] = onRoundedRect(0, 0, W, D, PLAN_R, rnd());
    const y = rnd() < 0.6 ? j(0.004) : rnd() < 0.5 ? -0.095 + j(0.004) : -rnd() * 0.095;
    put(x + j(0.004), y, z + j(0.004));
  }
  // 1: keycap outlines
  for (let k = 0; k < counts[1]; k++) {
    const key = keys[Math.floor(rnd() * keys.length)];
    const [x, z] = onRoundedRect(key.x, key.z, key.w, key.d, Math.min(0.012, key.d * 0.18), rnd());
    put(x, 0.0086, z);
  }
  // 2: trackpad outline
  for (let k = 0; k < counts[2]; k++) {
    const [x, z] = onRoundedRect(0, (PAD.z0 + PAD.z1) / 2, PAD.x1 - PAD.x0, PAD.z1 - PAD.z0, 0.045, rnd());
    put(x, 0.001, z);
  }
  // 3: grille holes
  for (let k = 0; k < counts[3]; k++) {
    const side = rnd() < 0.5 ? -1 : 1;
    const cols = 10;
    const colW = (GRILLE.outer - GRILLE.inner - 0.016) / (cols - 1);
    const x = GRILLE.inner + 0.008 + Math.floor(rnd() * cols) * colW;
    const z = GRILLE.z0 + 0.005 + rnd() * (GRILLE.z1 - GRILLE.z0 - 0.01);
    put(side * x + j(0.006), 0.0008, z);
  }
  // 4: deck surface, denser on the palm rests (where the taps go)
  for (let k = 0; k < counts[4]; k++) {
    let x: number, z: number;
    if (rnd() < 0.65) {
      const side = rnd() < 0.5 ? -1 : 1;
      x = side * (PAD.x1 + 0.04 + rnd() * (W / 2 - PAD.x1 - 0.1));
      z = PAD.z0 - 0.05 + rnd() * (D / 2 - PAD.z0 - 0.02);
    } else {
      x = j(W - 0.1);
      z = j(D - 0.1);
      if (x > KB.x0 && x < KB.x1 && z > KB.z0 && z < KB.z1) z = KB.z0 - 0.02 - rnd() * 0.08;
    }
    put(x, 0.0005, z);
  }
  // 5: lid rims (both faces)
  for (let k = 0; k < counts[5]; k++) {
    const [x, z] = onRoundedRect(0, lidZ - (D / 2 - 0.03), W, D - 0.04, PLAN_R - 0.01, rnd());
    put(x + j(0.004), rnd() < 0.5 ? 0 : LID_T, z + j(0.004), lidM);
  }
  // 6: screen edge
  for (let k = 0; k < counts[6]; k++) {
    const [x, z] = onRoundedRect(0, scrZ, 2.98, 1.935, 0.02, rnd());
    put(x, -0.002, z, lidM);
  }
  // 7: back of the lid (a faint surface)
  for (let k = 0; k < counts[7]; k++) put(j(W - 0.08), LID_T + 0.001, lidZ - (D / 2 - 0.03) + j(D - 0.12), lidM);
  // 8: the display, faint fill
  for (let k = 0; k < counts[8]; k++) put(j(2.98), -0.002, scrZ + j(1.935), lidM);
  return out;
}

function dataTex(arr: Float32Array, size: number) {
  const t = new THREE.DataTexture(arr, size, size, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
}

/** GPGPU particles: dust condenses into the Ghostkeys mark, then flows along curved paths and settles as the laptop. */
export function Particles({ size, parts, control, logoCenter, logoQuat, ink, signal, dark }: Props) {
  const gl = useThree((s) => s.gl);
  const n = size * size;
  const [targets, setTargets] = useState<{ a: THREE.DataTexture; b: THREE.DataTexture } | null>(null);

  useEffect(() => {
    if (!parts) return;
    let alive = true;
    logoTargets(n, logoCenter, logoQuat).then((logo) => {
      if (!alive) return;
      const lap = laptopTargets(n);
      setTargets({ a: dataTex(logo, size), b: dataTex(lap, size) });
    });
    return () => {
      alive = false;
    };
  }, [parts, n, size, logoCenter, logoQuat]);

  const sim = useMemo(() => {
    if (!targets) return null;
    const gpu = new GPUComputationRenderer(size, size, gl);
    const p0 = gpu.createTexture();
    const v0 = gpu.createTexture();
    const pd = p0.image.data as Float32Array;
    const rnd = rng(99);
    for (let i = 0; i < n; i++) {
      // a wide, thin cloud of dust in the dark, mostly behind and around the mark
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r = 1.4 + Math.cbrt(rnd()) * 4.2;
      const s = Math.sqrt(1 - u * u);
      pd[i * 4] = logoCenter.x + r * s * Math.cos(th) * 1.3;
      pd[i * 4 + 1] = logoCenter.y + r * u * 0.6;
      pd[i * 4 + 2] = logoCenter.z + r * s * Math.sin(th) - 1.2;
      pd[i * 4 + 3] = rnd();
    }
    const posVar: Variable = gpu.addVariable("texturePosition", positionShader, p0);
    const velVar: Variable = gpu.addVariable("textureVelocity", velocityShader, v0);
    gpu.setVariableDependencies(posVar, [posVar, velVar]);
    gpu.setVariableDependencies(velVar, [posVar, velVar]);
    const vu = velVar.material.uniforms;
    vu.uTime = { value: 0 };
    vu.uK = { value: 0 };
    vu.uNoise = { value: 1 };
    vu.uMix = { value: 0 };
    vu.uSwirl = { value: 0 };
    vu.uDt = { value: 1 };
    vu.uAxis = { value: new THREE.Vector3(0.4, 0.3, -0.2) };
    vu.uTargetA = { value: targets.a };
    vu.uTargetB = { value: targets.b };
    posVar.material.uniforms.uDt = { value: 1 };
    const err = gpu.init();
    if (err) {
      console.warn("[ghostkeys] particles disabled:", err);
      return null;
    }
    return { gpu, posVar, velVar };
  }, [targets, gl, size, n, logoCenter]);

  useEffect(
    () => () => {
      sim?.gpu.dispose();
      targets?.a.dispose();
      targets?.b.dispose();
    },
    [sim, targets],
  );

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const refs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      refs[i * 2] = ((i % size) + 0.5) / size;
      refs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size;
    }
    g.setAttribute("aRef", new THREE.BufferAttribute(refs, 2));
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    return g;
  }, [n, size]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: renderVert,
        fragmentShader: renderFrag,
        uniforms: {
          uPos: { value: null },
          uVel: { value: null },
          uTargetA: { value: null },
          uPixelRatio: { value: 1 },
          uMix: { value: 0 },
          uOpacity: { value: 1 },
          uFlash: { value: 0 },
          uDensity: { value: 1 },
          uInk: { value: new THREE.Color(ink) },
          uSignal: { value: new THREE.Color(signal) },
        },
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  const time = useRef(0);
  const pointsRef = useRef<THREE.Points>(null);
  useFrame((state, dt) => {
    if (pointsRef.current) pointsRef.current.visible = !control.done && control.opacity > 0.002;
    if (!sim || control.done) return;
    const d = Math.min(dt, 1 / 20) * 60;
    time.current += Math.min(dt, 1 / 20);
    const vu = sim.velVar.material.uniforms;
    vu.uTime.value = time.current;
    vu.uK.value = control.k;
    vu.uNoise.value = control.noise;
    vu.uMix.value = control.mix;
    vu.uSwirl.value = control.swirl;
    vu.uDt.value = d;
    sim.posVar.material.uniforms.uDt.value = d;
    sim.gpu.compute();
    const u = material.uniforms;
    u.uPos.value = sim.gpu.getCurrentRenderTarget(sim.posVar).texture;
    u.uVel.value = sim.gpu.getCurrentRenderTarget(sim.velVar).texture;
    u.uTargetA.value = targets!.a;
    u.uPixelRatio.value = state.gl.getPixelRatio();
    u.uMix.value = control.mix;
    u.uOpacity.value = control.opacity;
    u.uFlash.value = control.flash;
    // keep total light constant across particle budgets: more points, each fainter
    u.uDensity.value = (dark ? 0.62 : 0.9) * Math.sqrt(65536 / n);
    u.uInk.value.set(ink);
    u.uSignal.value.set(signal);
    material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  });

  if (!sim) return null;
  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} renderOrder={10} />;
}
