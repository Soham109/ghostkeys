"use client";

import * as THREE from "three";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import type { TapField } from "./taps";
import type { LaptopState } from "./Laptop";

type LineLike = { geometry: { setPositions: (a: Float32Array) => void }; material: THREE.Material };

export const SENSOR_POS = new THREE.Vector3(0.42, -0.021, -0.42);

const Y0 = -0.034;

function boardTexture() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 400;
  const g = c.getContext("2d")!;
  g.fillStyle = "#08090a";
  g.fillRect(0, 0, 1024, 400);
  g.strokeStyle = "rgba(190,192,198,0.2)";
  g.lineWidth = 1.2;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    let x = rnd() * 1024;
    let y = rnd() * 400;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      if (rnd() > 0.5) x += (rnd() - 0.5) * 220;
      else y += (rnd() - 0.5) * 120;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.fillStyle = "rgba(200,200,205,0.25)";
  for (let i = 0; i < 500; i++) g.fillRect(rnd() * 1024, rnd() * 400, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 29 curved fan blades as one instanced draw. */
function FanBlades() {
  const ref = useRef<THREE.InstancedMesh>(null!);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    for (let b = 0; b < 29; b++) {
      const a = (b / 29) * Math.PI * 2;
      o.position.set(Math.cos(a) * 0.15, 0, -Math.sin(a) * 0.15);
      o.rotation.set(0, a, 0.35);
      o.updateMatrix();
      ref.current.setMatrixAt(b, o.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  }, []);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 29]}>
      <boxGeometry args={[0.2, 0.012, 0.012]} />
      <meshStandardMaterial color="#2a2b2f" roughness={0.4} metalness={0.5} />
    </instancedMesh>
  );
}

const streamVert = /* glsl */ `
attribute vec4 aSeed;
uniform float uT;
uniform float uAmt;
uniform float uFlare;
varying float vA;
varying float vHot;
void main() {
  float speed = 0.22 + aSeed.y * 0.3;
  float ph = fract(aSeed.x + uT * speed);
  float ang = aSeed.w * 6.2831 + ph * (1.6 + aSeed.z * 2.4);
  float r = 0.012 + pow(ph, 1.4) * (0.1 + aSeed.z * 0.28);
  vec3 p = vec3(cos(ang) * r, 0.01 + pow(ph, 1.7) * (0.25 + aSeed.y * 0.5), sin(ang) * r * 0.8);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.0 + aSeed.z * 1.6) * 2.2 / max(0.2, -mv.z);
  vA = sin(ph * 3.14159) * uAmt * (0.25 + 0.75 * step(0.5, aSeed.y));
  vHot = step(aSeed.w, 0.2) * uFlare;
}
`;
const streamFrag = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uSignal;
varying float vA;
varying float vHot;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uInk * (0.9 + vHot * 1.2), a);
}
`;

/** Samples leaving the motion sensor: a slow spiral of points, flaring signal when a tap lands. */
function DataStream({ taps, state, ink, signal }: { taps: TapField; state: LaptopState; ink: string; signal: string }) {
  const { geometry, material } = useMemo(() => {
    const n = 2600;
    let seed = 77;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const a = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) a[i] = rnd();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(a, 4));
    const m = new THREE.ShaderMaterial({
      vertexShader: streamVert,
      fragmentShader: streamFrag,
      uniforms: { uT: { value: 0 }, uAmt: { value: 0 }, uFlare: { value: 0 }, uInk: { value: new THREE.Color(ink) }, uSignal: { value: new THREE.Color(signal) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    return { geometry: g, material: m };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  const last = useRef({ t: -10, s: 0 });
  useEffect(() => taps.onTap((_x, _z, s) => (last.current = { t: taps.time, s })), [taps]);
  const ref = useRef<THREE.Points>(null!);
  useFrame(() => {
    const u = material.uniforms;
    u.uT.value = taps.time;
    u.uAmt.value = state.xray;
    const age = taps.time - last.current.t;
    u.uFlare.value = age >= 0 ? Math.exp(-age * 4) * last.current.s : 0;
    u.uInk.value.set(ink);
    u.uSignal.value.set(signal);
    ref.current.visible = state.xray > 0.01;
  });
  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} renderOrder={9} raycast={() => null} />;
}

/** Inside the chassis: logic board, SoC, fans, battery, speakers and the motion sensor with its live trace. */
export function Internals({ taps, state, signal, ink }: { taps: TapField; state: LaptopState; signal: string; ink: string }) {
  const tex = useMemo(boardTexture, []);
  useEffect(() => () => tex.dispose(), [tex]);
  const fanL = useRef<THREE.Group>(null!);
  const fanR = useRef<THREE.Group>(null!);
  const chipMat = useRef<THREE.MeshBasicMaterial>(null!);
  const haloMat = useRef<THREE.ShaderMaterial>(null!);
  const parts = useRef<THREE.InstancedMesh>(null!);
  const lines = [useRef<LineLike>(null!), useRef<LineLike>(null!), useRef<LineLike>(null!)];
  const labelRef = useRef<HTMLDivElement>(null!);

  const N = 220;
  const buffers = useMemo(() => [0, 1, 2].map(() => new Float32Array(N)), []);
  const pts = useMemo(() => Array.from({ length: N }, (_, i) => new THREE.Vector3(i / (N - 1), 0, 0)), []);
  const spike = useRef({ t: -10, s: 0, x: 0, z: 0 });

  useEffect(() => taps.onTap((x, z, s) => (spike.current = { t: taps.time, s, x, z })), [taps]);

  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 180; i++) {
      let x = 0, z = 0;
      do {
        x = -0.92 + rnd() * 1.84;
        z = -0.98 + rnd() * 0.7;
      } while ((Math.abs(x + 0.2) < 0.26 && Math.abs(z + 0.62) < 0.22) || (Math.abs(x - 0.42) < 0.08 && Math.abs(z + 0.42) < 0.08));
      const s = 0.012 + rnd() * 0.03;
      m.compose(new THREE.Vector3(x, Y0 + 0.017, z), new THREE.Quaternion(), new THREE.Vector3(s, 0.006 + rnd() * 0.01, s * (0.5 + rnd())));
      parts.current.setMatrixAt(i, m);
    }
    parts.current.instanceMatrix.needsUpdate = true;
  }, []);

  const ampRef = useRef(0);
  const root = useRef<THREE.Group>(null!);
  // the internals only render during the x-ray (their parent group is hidden otherwise); skip all work then
  const innerVisible = () => {
    let o: THREE.Object3D | null = root.current;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  };

  useFrame((_, dt) => {
    const t = taps.time;
    if (!innerVisible()) return;
    fanL.current.rotation.y += dt * 9;
    fanR.current.rotation.y -= dt * 9;
    const age = t - spike.current.t;
    // chip glow: always faintly alive, flares on each tap
    const flare = age >= 0 ? Math.exp(-age * 5) * spike.current.s : 0;
    chipMat.current.color.set(ink).multiplyScalar(1.2 + flare * 3 + Math.sin(t * 3) * 0.2);
    haloMat.current.uniforms.uFlare.value = flare;
    haloMat.current.uniforms.uTime.value = t;
    // three accelerometer axes, 800 Hz squeezed into a scrolling trace
    ampRef.current = THREE.MathUtils.damp(ampRef.current, 0, 4, dt);
    const shift = 3;
    for (let a = 0; a < 3; a++) {
      const b = buffers[a];
      b.copyWithin(0, shift);
      for (let k = N - shift; k < N; k++) {
        const tt = t + (k - N) * 0.002 + a * 1.3;
        const noise = (Math.sin(tt * 91.1) * 0.5 + Math.sin(tt * 57.3 + a) * 0.3 + (Math.random() - 0.5) * 0.5) * 0.006;
        let hit = 0;
        if (age >= 0 && age < 0.45) {
          const w = [1, 0.55, 0.8][a];
          hit = Math.sin(age * 90 + a) * Math.exp(-age * 11) * 0.075 * w * spike.current.s;
        }
        b[k] = noise + hit;
      }
      for (let i = 0; i < N; i++) pts[i].set(i / (N - 1), b[i], 0);
      const line = lines[a].current;
      if (line && innerVisible()) {
        // write the segments in place: LineGeometry.setPositions allocates new GPU buffers on every call
        const data = (line.geometry as unknown as { attributes: { instanceStart: THREE.InterleavedBufferAttribute } }).attributes.instanceStart.data;
        const arr = data.array as Float32Array;
        for (let i = 0; i < N - 1; i++) {
          const o = i * 6;
          arr[o] = pts[i].x * 1.1;
          arr[o + 1] = pts[i].y;
          arr[o + 2] = 0;
          arr[o + 3] = pts[i + 1].x * 1.1;
          arr[o + 4] = pts[i + 1].y;
          arr[o + 5] = 0;
        }
        data.needsUpdate = true;
        // the trace stays ink: orange is reserved for the ring where a touch lands
        (line.material as THREE.Material & { color: THREE.Color }).color.set(ink);
      }
    }
    const open = Math.max(state.hood, state.xray);
    if (labelRef.current) labelRef.current.style.opacity = String(open > 0.6 ? (open - 0.6) / 0.4 : 0);
  });

  const init = useMemo(() => Array.from({ length: N }, (_, i) => [i / (N - 1), 0, 0] as [number, number, number]), []);

  return (
    <group ref={root}>
      {/* logic board */}
      <mesh position={[0, Y0 + 0.006, -0.62]}>
        <boxGeometry args={[1.9, 0.01, 0.76]} />
        <meshStandardMaterial map={tex} roughness={0.55} metalness={0.3} />
      </mesh>
      {/* SoC with a polished lid, memory beside it */}
      <mesh position={[-0.2, Y0 + 0.02, -0.62]}>
        <boxGeometry args={[0.36, 0.018, 0.32]} />
        <meshStandardMaterial color="#4a4c50" roughness={0.32} metalness={1} />
      </mesh>
      {[-0.43, 0.03].map((x) => (
        <mesh key={x} position={[x, Y0 + 0.018, -0.62]}>
          <boxGeometry args={[0.08, 0.012, 0.22]} />
          <meshStandardMaterial color="#141416" roughness={0.4} metalness={0.4} />
        </mesh>
      ))}
      <instancedMesh ref={parts} args={[undefined, undefined, 180]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#26272b" roughness={0.5} metalness={0.6} />
      </instancedMesh>
      {/* fans */}
      {[-1.05, 1.05].map((x, i) => (
        <group key={x} position={[x, Y0 + 0.012, -0.62]}>
          <mesh>
            <cylinderGeometry args={[0.27, 0.27, 0.02, 48, 1, true]} />
            <meshStandardMaterial color="#1a1a1d" roughness={0.6} metalness={0.5} side={THREE.DoubleSide} />
          </mesh>
          <group ref={i === 0 ? fanL : fanR}>
            <FanBlades />
            <mesh>
              <cylinderGeometry args={[0.055, 0.055, 0.022, 32]} />
              <meshStandardMaterial color="#9a9ca2" roughness={0.25} metalness={1} />
            </mesh>
          </group>
        </group>
      ))}
      {/* battery cells under the palm rests and trackpad */}
      {[
        [-0.98, 0.48, 0.92],
        [0, 0.52, 0.9],
        [0.98, 0.48, 0.92],
      ].map(([x, z, s]) => (
        <mesh key={x} position={[x, Y0 + 0.01, z]}>
          <boxGeometry args={[s, 0.018, 0.9]} />
          <meshStandardMaterial color="#1c1d21" roughness={0.35} metalness={0.7} />
        </mesh>
      ))}
      {/* speakers under the grilles */}
      {[-1.43, 1.43].map((x) => (
        <mesh key={x} position={[x, Y0 + 0.012, -0.45]}>
          <boxGeometry args={[0.1, 0.022, 1.04]} />
          <meshStandardMaterial color="#17171a" roughness={0.7} metalness={0.3} />
        </mesh>
      ))}

      {/* the motion sensor */}
      <group position={SENSOR_POS}>
        <mesh>
          <boxGeometry args={[0.08, 0.012, 0.08]} />
          <meshStandardMaterial color="#0b0b0c" roughness={0.3} metalness={0.2} />
        </mesh>
        {/* pins */}
        {Array.from({ length: 16 }, (_, k) => {
          const side = Math.floor(k / 4);
          const o = ((k % 4) - 1.5) * 0.016;
          const pos: [number, number, number] = side === 0 ? [o, -0.003, 0.043] : side === 1 ? [o, -0.003, -0.043] : side === 2 ? [0.043, -0.003, o] : [-0.043, -0.003, o];
          return (
            <mesh key={k} position={pos}>
              <boxGeometry args={[0.007, 0.004, 0.007]} />
              <meshStandardMaterial color="#b9bbc0" metalness={1} roughness={0.3} />
            </mesh>
          );
        })}
        <mesh position={[0, 0.0065, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.034, 0.034]} />
          <meshBasicMaterial ref={chipMat} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={8}>
          <planeGeometry args={[1.2, 1.2]} />
          <shaderMaterial
            ref={haloMat}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
            uniforms={{ uFlare: { value: 0 }, uTime: { value: 0 }, uSignal: { value: new THREE.Color(signal) }, uInk: { value: new THREE.Color(ink) } }}
            vertexShader={`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`}
            fragmentShader={`
              uniform float uFlare; uniform float uTime; uniform vec3 uSignal; uniform vec3 uInk; varying vec2 vUv;
              void main(){
                float d = length(vUv - 0.5) * 2.0;
                float core = exp(-d * d * 60.0);
                float ring = exp(-pow((d - fract(uTime * 0.6) * 0.9) / 0.02, 2.0)) * (1.0 - fract(uTime * 0.6));
                float soft = exp(-d * 9.0) * (1.0 - exp(-d * d * 400.0));
                vec3 c = uInk * (soft * 0.12 + ring * 0.22 + uFlare * (soft * 0.9 + exp(-d * 5.0) * 0.2));
                gl_FragColor = vec4(c, 1.0);
              }`}
          />
        </mesh>
        <DataStream taps={taps} state={state} ink={ink} signal={signal} />
        {/* hairline leader from chip up to the trace */}
        <Line points={[[0, 0.006, 0], [0, 0.2, 0]]} color={ink} lineWidth={1} transparent opacity={0.5} />
        <group position={[-0.55, 0.26, 0]}>
          {[0, 1, 2].map((a) => (
            <Line key={a} ref={lines[a] as never} points={init} color={ink} lineWidth={1.4} position={[0, a * 0.085, 0]} toneMapped={false} />
          ))}
          <Html position={[1.14, 0.19, 0]} style={{ pointerEvents: "none" }}>
            <div ref={labelRef} className="label" style={{ whiteSpace: "nowrap", opacity: 0, transition: "opacity 200ms", color: "var(--ink-2)" }}>
              x y z &nbsp; 800 Hz
            </div>
          </Html>
        </group>
      </group>
    </group>
  );
}
