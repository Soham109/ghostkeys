import React, { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { rng } from "../lib";

export const CHIP: [number, number, number] = [2.2, -0.42, -6.2];

/** Inside the chassis, visible only in the x-ray: board, cells, and the motion sensor chip streaming data. */
export const Internals: React.FC<{ xray: number; t: number; pulse: number }> = ({ xray, t, pulse }) => {
  const mats = useMemo(() => {
    const board = new THREE.MeshStandardMaterial({ color: "#1c1d21", roughness: 0.6, metalness: 0.3, transparent: true });
    const cell = new THREE.MeshStandardMaterial({ color: "#2a2b30", roughness: 0.35, metalness: 0.6, transparent: true });
    const line = new THREE.LineBasicMaterial({ color: "#8A8A90", transparent: true });
    const chip = new THREE.MeshStandardMaterial({ color: "#111113", emissive: new THREE.Color("#EDEDEF"), emissiveIntensity: 1, transparent: true });
    const chipRing = new THREE.MeshBasicMaterial({ color: "#FF5B1F", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    return { board, cell, line, chip, chipRing };
  }, []);

  const traces = useMemo(() => {
    // PCB traces fanning out of the chip, as hairlines
    const R = rng(9);
    const pts: number[] = [];
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      let x = CHIP[0], z = CHIP[2];
      const len = 1.5 + R() * 5;
      const nx = x + Math.cos(a) * len * 0.5, nz = z + Math.sin(a) * len * 0.5;
      pts.push(x, -0.33, z, nx, -0.33, nz);
      const tx = nx + (Math.abs(Math.cos(a)) > 0.5 ? Math.sign(Math.cos(a)) * len : 0);
      const tz = nz + (Math.abs(Math.cos(a)) <= 0.5 ? Math.sign(Math.sin(a)) * len * 0.6 : 0);
      pts.push(nx, -0.33, nz, tx, -0.33, tz);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);

  const stream = useMemo(() => {
    const n = 9000;
    const R = rng(77);
    const a = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) a.set([R(), R(), R(), R()], i * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(a, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 }, uAmt: { value: 0 }, uPulse: { value: 0 }, uChip: { value: new THREE.Vector3(...CHIP) } },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed; uniform float uT, uAmt, uPulse; uniform vec3 uChip;
        varying float vA; varying float vHot;
        void main(){
          float speed = 0.25 + aSeed.y * 0.35;
          float ph = fract(aSeed.x + uT * speed);
          float ang = aSeed.w * 6.2831 + ph * (2.0 + aSeed.z * 3.0);
          float r = 0.3 + ph * (3.0 + aSeed.z * 10.0);
          vec3 p = uChip + vec3(cos(ang) * r, 0.15 + pow(ph, 2.2) * (1.0 + aSeed.y * 5.0), sin(ang) * r * 0.75);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.8 + aSeed.z * 1.2) * 44.0 / max(0.1, -mv.z);
          vA = sin(ph * 3.14159) * uAmt * 0.45;
          vHot = step(aSeed.w, 0.18) * uPulse;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying float vHot;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d) * vA;
          if (a < 0.003) discard;
          vec3 c = mix(vec3(0.93), vec3(1.0, 0.36, 0.12) * 2.0, vHot);
          gl_FragColor = vec4(c, a);
        }`,
    });
    return { g, m };
  }, []);

  useLayoutEffect(() => {
    mats.board.opacity = xray * 0.9;
    mats.cell.opacity = xray * 0.8;
    mats.line.opacity = xray * 0.7;
    mats.chip.opacity = xray;
    mats.chip.emissive.set(pulse > 0.05 ? "#FF7A45" : "#EDEDEF");
    mats.chip.emissiveIntensity = xray * (1.4 + pulse * 5);
    mats.chipRing.opacity = pulse * xray;
    stream.m.uniforms.uT.value = t;
    stream.m.uniforms.uAmt.value = xray;
    stream.m.uniforms.uPulse.value = pulse;
  });

  if (xray < 0.002) return null;
  return (
    <group>
      <mesh material={mats.board} position={[0, -0.55, -5.6]}>
        <boxGeometry args={[16, 0.08, 7.2]} />
      </mesh>
      {[-1, 1].map((s) =>
        [0, 1, 2].map((k) => (
          <mesh key={`${s}${k}`} material={mats.cell} position={[s * 7.4, -0.62, 1.2 + k * 3.1]}>
            <boxGeometry args={[6.8, 0.5, 2.8]} />
          </mesh>
        ))
      )}
      <lineSegments geometry={traces} material={mats.line} />
      <mesh material={mats.chip} position={CHIP}>
        <boxGeometry args={[0.9, 0.14, 0.9]} />
      </mesh>
      <mesh material={mats.chipRing} position={[CHIP[0], CHIP[1] + 0.09, CHIP[2]]} rotation={[-Math.PI / 2, 0, 0]} scale={1 + pulse * 0.0 + (1 - pulse) * 3}>
        <ringGeometry args={[0.7, 0.78, 48]} />
      </mesh>
      <pointLight position={[CHIP[0], CHIP[1] + 1.2, CHIP[2]]} intensity={xray * (30 + pulse * 120)} distance={16} color={pulse > 0.05 ? "#FF7A45" : "#EDEDEF"} />
      <points geometry={stream.g} material={stream.m} frustumCulled={false} />
    </group>
  );
};
