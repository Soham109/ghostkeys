"use client";

import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { GPUComputationRenderer, type Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import { D, GRILLE, HINGE_Z, KB, PAD, W } from "@/lib/dims";
import { CURL_GLSL } from "./glsl";
import type { LaptopParts } from "./Laptop";

/** Lid angle the particle laptop forms at; the solid lid then opens from here. */
export const PARTICLE_LID = 72;

const velocityShader = /* glsl */ `
${CURL_GLSL}
uniform float uTime;
uniform float uK;
uniform float uNoise;
uniform float uMix;
uniform float uDt;
uniform sampler2D uTargetA;
uniform sampler2D uTargetB;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 p = texture2D(texturePosition, uv);
  vec4 v = texture2D(textureVelocity, uv);
  vec4 ta = texture2D(uTargetA, uv);
  vec4 tb = texture2D(uTargetB, uv);
  vec3 target = mix(ta.xyz, tb.xyz, smoothstep(0.0, 1.0, clamp(uMix * 1.6 - p.w * 0.6, 0.0, 1.0)));
  float group = ta.w;
  // the touch point settles last
  float late = (group > 1.5 && uMix < 0.5) ? 0.4 : 1.0;
  float k = uK * (0.55 + p.w * 0.9) * late;
  vec3 acc = (target - p.xyz) * k + curlNoise(p.xyz * 0.9 + uTime * 0.15) * uNoise * 0.004;
  v.xyz = (v.xyz + acc * uDt) * pow(0.9, uDt);
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
  float group = texture2D(uTargetA, aRef).w;
  vec4 mv = modelViewMatrix * vec4(p.xyz, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = mix(1.2, 2.2, fract(p.w * 7.13));
  gl_PointSize = size * uPixelRatio * clamp(6.0 / -mv.z, 0.4, 3.0);
  float ghost = (group > 0.5 && group < 1.5) ? mix(0.3, 1.0, uMix) : (group > 1.5 && group < 2.5) ? mix(0.4, 1.0, uMix) : 1.0;
  vAlpha = ghost * uOpacity * uDensity;
  vColor = (group > 1.5 && group < 2.5) ? mix(uInk, uSignal * 1.3, uFlash * (1.0 - uMix)) : uInk;
}
`;

const renderFrag = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, vAlpha * (1.0 - smoothstep(0.25, 0.5, d)));
}
`;

export type ParticleControl = {
  k: number;
  noise: number;
  mix: number;
  opacity: number;
  flash: number;
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

async function logoTargets(n: number, center: THREE.Vector3, quat: THREE.Quaternion) {
  const txt = await fetch("/logo.svg").then((r) => r.text());
  const data = new SVGLoader().parse(txt);
  const rnd = rng(42);
  const out = new Float32Array(n * 4);
  // paths in document order: ghost keycap, front keycap, touch point
  const [ghost, front, dot] = data.paths;
  const counts = [Math.floor(n * 0.55), Math.floor(n * 0.3)];
  counts.push(n - counts[0] - counts[1]);
  const scale = 1.75 / 72;
  const tmp = new THREE.Vector3();
  let i = 0;
  const put = (x: number, y: number, group: number) => {
    tmp.set((x - 64) * scale, -(y - 64) * scale, (rnd() - 0.5) * 0.1).applyQuaternion(quat).add(center);
    out[i * 4] = tmp.x;
    out[i * 4 + 1] = tmp.y;
    out[i * 4 + 2] = tmp.z;
    out[i * 4 + 3] = group;
    i++;
  };
  const strokeSample = (path: (typeof data.paths)[number], count: number, group: number) => {
    const pts = path.subPaths.flatMap((sp) => sp.getSpacedPoints(Math.max(64, Math.floor(count / 8))));
    for (let k = 0; k < count; k++) {
      const a = pts[Math.floor(rnd() * pts.length)];
      const ang = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 2.4 + (rnd() - 0.5) * 0.6;
      put(a.x + Math.cos(ang) * r, a.y + Math.sin(ang) * r, group);
    }
  };
  strokeSample(front, counts[0], 0);
  strokeSample(ghost, counts[1], 1);
  // the dot is filled
  const pts = dot.subPaths.flatMap((sp) => sp.getPoints(64));
  const c = pts.reduce((acc, p) => acc.add(p), new THREE.Vector2()).multiplyScalar(1 / pts.length);
  for (let k = 0; k < counts[2]; k++) {
    const ang = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 7;
    put(c.x + Math.cos(ang) * r, c.y + Math.sin(ang) * r, 2);
  }
  return out;
}

function laptopTargets(n: number, parts: LaptopParts) {
  const rnd = rng(7);
  const out = new Float32Array(n * 4);
  const tmp = new THREE.Vector3();
  const lidM = new THREE.Matrix4()
    .makeTranslation(0, 0, HINGE_Z)
    .multiply(new THREE.Matrix4().makeRotationX(-THREE.MathUtils.degToRad(PARTICLE_LID)))
    .multiply(new THREE.Matrix4().makeTranslation(0, 0, D / 2 - 0.03));
  const deckS = new MeshSurfaceSampler(parts.deck).build();
  const chassisS = new MeshSurfaceSampler(parts.chassis).build();
  const lidS = new MeshSurfaceSampler(parts.lidShell).build();
  let i = 0;
  const put = (v: THREE.Vector3) => {
    out[i * 4] = v.x;
    out[i * 4 + 1] = v.y;
    out[i * 4 + 2] = v.z;
    out[i * 4 + 3] = 3;
    i++;
  };
  const nDeck = Math.floor(n * 0.36);
  const nChassis = Math.floor(n * 0.12);
  const nLid = Math.floor(n * 0.16);
  const nScreen = Math.floor(n * 0.22);
  const nKeys = n - nDeck - nChassis - nLid - nScreen;
  const inZone = (x: number, z: number) =>
    (Math.abs(x) > GRILLE.inner - 0.01 && z < GRILLE.z1 && z > GRILLE.z0) || (z > PAD.z0 && (x < PAD.x0 - 0.02 || x > PAD.x1 + 0.02));
  for (let k = 0; k < nDeck; ) {
    deckS.sample(tmp);
    if (tmp.y < -0.002) continue;
    // weight toward palm rests and grilles
    if (!inZone(tmp.x, tmp.z) && rnd() > 0.45) continue;
    put(tmp);
    k++;
  }
  for (let k = 0; k < nChassis; k++) {
    chassisS.sample(tmp);
    put(tmp);
  }
  for (let k = 0; k < nLid; k++) {
    lidS.sample(tmp);
    tmp.applyMatrix4(lidM);
    put(tmp);
  }
  for (let k = 0; k < nScreen; k++) {
    tmp.set((rnd() - 0.5) * 2.98, -0.002, 1.1375 - (D / 2 - 0.03) + (rnd() - 0.5) * 1.935).applyMatrix4(lidM);
    put(tmp);
  }
  for (let k = 0; k < nKeys; k++) {
    tmp.set(KB.x0 + rnd() * (KB.x1 - KB.x0), 0.009, KB.z0 + rnd() * (KB.z1 - KB.z0));
    put(tmp);
  }
  void W;
  return out;
}

function dataTex(arr: Float32Array, size: number) {
  const t = new THREE.DataTexture(arr, size, size, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
}

/** GPGPU particles: dust condenses into the Ghostkeys mark, then reforms as the laptop. */
export function Particles({ size, parts, control, logoCenter, logoQuat, ink, signal, dark }: Props) {
  const gl = useThree((s) => s.gl);
  const n = size * size;
  const [targets, setTargets] = useState<{ a: THREE.DataTexture; b: THREE.DataTexture } | null>(null);

  useEffect(() => {
    if (!parts) return;
    let alive = true;
    logoTargets(n, logoCenter, logoQuat).then((logo) => {
      if (!alive) return;
      const lap = laptopTargets(n, parts);
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
      // a loose cloud of dust around the mark
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r = 1.2 + Math.cbrt(rnd()) * 3.2;
      const s = Math.sqrt(1 - u * u);
      pd[i * 4] = logoCenter.x + r * s * Math.cos(th);
      pd[i * 4 + 1] = logoCenter.y + r * u * 0.7;
      pd[i * 4 + 2] = logoCenter.z + r * s * Math.sin(th);
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
    vu.uDt = { value: 1 };
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
    time.current += dt;
    const vu = sim.velVar.material.uniforms;
    vu.uTime.value = time.current;
    vu.uK.value = control.k;
    vu.uNoise.value = control.noise;
    vu.uMix.value = control.mix;
    vu.uDt.value = d;
    sim.posVar.material.uniforms.uDt.value = d;
    sim.gpu.compute();
    const u = material.uniforms;
    u.uPos.value = sim.gpu.getCurrentRenderTarget(sim.posVar).texture;
    u.uTargetA.value = targets!.a;
    u.uPixelRatio.value = state.gl.getPixelRatio();
    u.uMix.value = control.mix;
    u.uOpacity.value = control.opacity;
    u.uFlash.value = control.flash;
    u.uDensity.value = size >= 512 ? 0.42 : size >= 256 ? 0.75 : 1;
    u.uInk.value.set(ink);
    u.uSignal.value.set(signal);
    material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  });

  if (!sim) return null;
  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} renderOrder={10} />;
}
