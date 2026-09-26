import React, { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { EffectComposer, Bloom, DepthOfField, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Laptop, LaptopState } from "./Laptop";
import { Particles, ParticleState } from "./Particles";
import { Internals } from "./Internals";
import { Tap, ZONES, LID_ANGLE, V3 } from "../timeline";

export type Cam = { pos: V3; target: V3; fov: number; focus?: V3; bokeh: number; roll?: number };
export type WorldState = {
  cam: Cam;
  particles: ParticleState | null;
  laptop: LaptopState | null;
  bloom: number;
  lightScale: number;
  t: number;
  chipPulse: number;
  rings: boolean;
};

let rectInit = false;

const Studio: React.FC<{ scale: number }> = ({ scale }) => {
  const { gl, scene } = useThree();
  useMemo(() => {
    if (!rectInit) {
      RectAreaLightUniformsLib.init();
      rectInit = true;
    }
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.background = null;
    return env;
  }, [gl, scene]);
  useLayoutEffect(() => {
    (scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = 0.42 * scale;
  });
  const top = useMemo(() => {
    const l = new THREE.RectAreaLight("#ffffff", 3.2 * scale, 34, 5);
    l.position.set(0, 26, 6);
    l.lookAt(0, 0, 0);
    return l;
  }, [scale]);
  top.intensity = 3.2 * scale;
  return (
    <>
      <primitive object={top} />
      <directionalLight position={[-14, 20, 18]} intensity={1.3 * scale} color="#f3f1ec" />
      <directionalLight position={[16, 7, -26]} intensity={3.2 * scale} color="#e9eef5" />
      <directionalLight position={[-22, 4, -12]} intensity={1.6 * scale} color="#ffffff" />
    </>
  );
};

const CameraRig: React.FC<{ cam: Cam }> = ({ cam }) => {
  const { camera } = useThree();
  useLayoutEffect(() => {
    const c = camera as THREE.PerspectiveCamera;
    c.position.set(...cam.pos);
    c.up.set(0, 1, 0);
    c.lookAt(...cam.target);
    if (cam.roll) c.rotateZ(cam.roll);
    c.fov = cam.fov;
    c.near = 0.5;
    c.far = 400;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  });
  return null;
};

const ringGeo = new THREE.RingGeometry(0.95, 1, 128);

/** Crisp shockwave rings in 3D, oriented to the tapped surface. */
const Rings3D: React.FC<{ taps: Tap[]; frame: number }> = ({ taps, frame }) => {
  const live = taps.filter((t) => frame >= t.f && frame - t.f < 26);
  return (
    <>
      {live.map((t, i) => {
        const age = frame - t.f;
        const z = ZONES[t.zone];
        let rot: [number, number, number] = [-Math.PI / 2, 0, 0];
        let pos: V3 = [z.p[0], z.p[1] + 0.03, z.p[2]];
        if (t.zone === "edgeL" || t.zone === "edgeR") {
          rot = [0, (t.zone === "edgeL" ? -1 : 1) * (Math.PI / 2), 0];
          pos = [z.p[0] + (t.zone === "edgeL" ? -0.03 : 0.03), z.p[1], z.p[2]];
        } else if (t.zone === "sensor" || t.zone === "lid") {
          // screen normal in world: lid-space -y rotated by -LID_ANGLE about x
          rot = [-LID_ANGLE + Math.PI / 2 + Math.PI, 0, 0];
          const n: V3 = [0, 0.285, 0.958];
          const sgn = t.zone === "sensor" ? 1 : -1;
          pos = [z.p[0] + n[0] * 0.05 * sgn, z.p[1] + n[1] * 0.05 * sgn, z.p[2] + n[2] * 0.05 * sgn];
        }
        return [0, 5].map((d) => {
          const a = age - d;
          if (a < 0) return null;
          const p = 1 - Math.pow(1 - Math.min(1, a / 20), 3);
          const s = 0.3 + p * (t.zone === "sensor" ? 1.3 : t.zone.startsWith("edge") ? 1.5 : 3.0);
          return (
            <mesh key={`${i}-${d}`} geometry={ringGeo} position={pos} rotation={rot} scale={[s, s, s]}>
              <meshBasicMaterial
                color={new THREE.Color("#FF5B1F").multiplyScalar(2.2)}
                transparent
                opacity={(1 - p) * (d ? 0.45 : 1)}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          );
        });
      })}
    </>
  );
};

const Effects: React.FC<{ st: WorldState }> = ({ st }) => {
  const dof = useRef<any>(null);
  const bloom = useRef<any>(null);
  const focusDist = st.cam.focus
    ? Math.hypot(st.cam.focus[0] - st.cam.pos[0], st.cam.focus[1] - st.cam.pos[1], st.cam.focus[2] - st.cam.pos[2])
    : 40;
  useLayoutEffect(() => {
    if (dof.current) {
      dof.current.cocMaterial.worldFocusDistance = focusDist;
      dof.current.cocMaterial.worldFocusRange = Math.max(1.5, focusDist * 0.12);
      dof.current.bokehScale = st.cam.bokeh;
    }
    if (bloom.current) bloom.current.intensity = st.bloom;
  });
  return (
    <EffectComposer multisampling={4}>
      <DepthOfField ref={dof} worldFocusDistance={40} worldFocusRange={6} bokehScale={2} />
      <Bloom ref={bloom} mipmapBlur intensity={0.6} luminanceThreshold={0.72} luminanceSmoothing={0.25} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <Vignette offset={0.28} darkness={0.72} />
    </EffectComposer>
  );
};

export const World: React.FC<{ state: (frame: number) => WorldState; taps: Tap[]; particleCount?: number }> = ({
  state,
  taps,
  particleCount = 100000,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const st = state(frame);
  return (
    <ThreeCanvas
      width={width}
      height={height}
      dpr={1}
      gl={{ antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" }}
      camera={{ fov: st.cam.fov, position: st.cam.pos, near: 0.1, far: 400 }}
      style={{ position: "absolute", inset: 0 }}
    >
      <CameraRig cam={st.cam} />
      <Studio scale={st.lightScale} />
      {st.laptop && st.laptop.opacity > 0.001 && (
        <>
          <Laptop frame={frame} fps={fps} taps={taps} st={st.laptop} />
          <Internals xray={st.laptop.xray} t={st.t} pulse={st.chipPulse} />
        </>
      )}
      {st.rings && <Rings3D taps={taps} frame={frame} />}
      {st.particles && st.particles.alpha > 0.001 && <Particles count={particleCount} st={st.particles} />}
      <Effects st={st} />
    </ThreeCanvas>
  );
};
