import React, { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { GhostHandMesh } from "./hand/GlassHand";
import { handFrame, pinchPoint, palmPoint, type Solved } from "./hand/scenes";
import { KB } from "./laptopGeo";

/** The glass light-sculpture hand (ported from the site), fed a solved pose each frame. */
export const HandLayer: React.FC<{ solve: (f: number) => Solved | null; f: number; viewH: number; fov: number; children?: (joints: Float32Array) => React.ReactNode }> = ({
  solve,
  f,
  viewH,
  fov,
  children,
}) => {
  const hand = useMemo(() => new GhostHandMesh("#EDEDEF", "#FF5B1F", true), []);
  const hf = handFrame(solve, f);
  useLayoutEffect(() => {
    if (!hf) {
      hand.visible = false;
      return;
    }
    hand.joints.set(hf.joints);
    hand.hot.set(hf.hot);
    hand.opacity = hf.opacity;
    hand.trailFrames = hf.trails;
    hand.update(viewH, (fov * Math.PI) / 180);
  });
  return (
    <>
      <primitive object={hand} />
      {hf && children?.(hf.joints)}
    </>
  );
};

const ringGeo = new THREE.RingGeometry(0.93, 1, 128);

/** Air: a ring in mid-air when the pinch closes, then a hairline dial arc while it turns. */
export const AirFx: React.FC<{ joints: Float32Array; camPos: [number, number, number]; pinchAge: number; dial: number }> = ({ joints, camPos, pinchAge, dial }) => {
  const pp = pinchPoint(joints);
  const o = useMemo(() => {
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#FF5B1F").multiplyScalar(2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    const arcMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#EDEDEF"), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const arc = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.36, 96, 1, 0, 0.01), arcMat);
    const track = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.33, 128), new THREE.MeshBasicMaterial({ color: "#EDEDEF", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    return { ring, ringMat, arc, arcMat, track };
  }, []);
  useLayoutEffect(() => {
    const a = pinchAge;
    const kk = a < 0 ? 0 : 1 - Math.pow(1 - Math.min(1, a / 18), 3);
    o.ring.position.set(...pp);
    o.ring.lookAt(...camPos);
    o.ring.scale.setScalar(0.2 + kk * 2.2);
    o.ringMat.opacity = a < 0 || a > 24 ? 0 : 1 - kk;
    for (const m of [o.arc, o.track]) {
      m.position.set(...pp);
      m.lookAt(...camPos);
    }
    o.arc.geometry.dispose();
    o.arc.geometry = new THREE.RingGeometry(2.3, 2.38, 96, 1, Math.PI / 2, -Math.max(0.01, dial) * Math.PI * 1.2);
    o.arcMat.opacity = a > 2 && dial > 0.01 ? 0.9 : 0;
    (o.track.material as THREE.MeshBasicMaterial).opacity = a > 2 && dial > 0.01 ? 0.18 : 0;
  });
  return (
    <>
      <primitive object={o.ring} />
      <primitive object={o.track} />
      <primitive object={o.arc} />
    </>
  );
};

const LINES = 24;
const PTS = 130;

/** Sonar: an inaudible field over the right half of the keys, hairlines lifting under a hovering palm. */
export const SonarField: React.FC<{ joints: Float32Array; t: number; amount: number }> = ({ joints, t, amount }) => {
  const palm = palmPoint(joints);
  const f = useMemo(() => {
    const n = LINES * (PTS - 1) * 2;
    const pos = new Float32Array(n * 3);
    const al = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(al, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uInk: { value: new THREE.Color("#EDEDEF") } },
      vertexShader: `attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uInk; varying float vA; void main(){ gl_FragColor = vec4(uInk, vA); }`,
    });
    const obj = new THREE.LineSegments(g, m);
    obj.frustumCulled = false;
    return { pos, al, g, obj };
  }, []);
  useLayoutEffect(() => {
    const x0 = 2, x1 = 15.6;
    const ys = new Float32Array(PTS);
    const near = new Float32Array(PTS);
    let kk = 0;
    for (let l = 0; l < LINES; l++) {
      const z = KB.z0 - 0.4 + (l / (LINES - 1)) * (KB.z1 - KB.z0 + 0.8);
      for (let i = 0; i < PTS; i++) {
        const x = x0 + (i / (PTS - 1)) * (x1 - x0);
        const d2 = (x - palm[0]) ** 2 + (z - palm[2]) ** 2;
        const d = Math.sqrt(d2);
        const pull = Math.max(0, palm[1] - 1.2) * 0.55 * Math.exp(-d2 / 10);
        const ripple = 0.14 * Math.sin(d * 1.6 - t * 9) * Math.exp(-d / 5);
        ys[i] = 0.8 + pull + ripple + 0.02 * Math.sin(x * 9 - t * 30 + l * 1.7);
        near[i] = Math.exp(-d2 / 26);
      }
      for (let i = 0; i < PTS - 1; i++) {
        const xa = x0 + (i / (PTS - 1)) * (x1 - x0);
        const xb = x0 + ((i + 1) / (PTS - 1)) * (x1 - x0);
        f.pos.set([xa, ys[i], z, xb, ys[i + 1], z], kk * 3);
        const ea = Math.sin((i / (PTS - 1)) * Math.PI), eb = Math.sin(((i + 1) / (PTS - 1)) * Math.PI);
        f.al[kk] = (0.14 + 0.7 * near[i]) * ea * amount;
        f.al[kk + 1] = (0.14 + 0.7 * near[i + 1]) * eb * amount;
        kk += 2;
      }
    }
    for (const a of Object.values(f.g.attributes)) (a as THREE.BufferAttribute).needsUpdate = true;
  });
  return <primitive object={f.obj} />;
};
