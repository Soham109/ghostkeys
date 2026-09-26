"use client";

import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { D, HINGE_Z, W } from "@/lib/dims";
import { zoneById, type Zone } from "@/lib/zones";
import { ZONE_SHORT, bus } from "@/lib/stage";
import { PALETTE, useTheme, type Theme } from "@/lib/theme";
import type { Tier } from "@/lib/device";
import { Laptop, makeLaptopState, type LaptopState } from "./Laptop";
import { ZoneLayer, makeZoneRuntime, type ZoneRuntime } from "./Zones";
import { TapLabels } from "./TapLabels";
import { BackLight, Floor, StudioLight } from "./Studio";
import { Effects } from "./Effects";
import { TapField, now } from "./taps";
import { WaterSim } from "./water";
import { ScreenPainter } from "./screen";

export type Gesture = "tap" | "double" | "triple" | "rhythm";

export type Extras = {
  /** time a sonar pulse started (sound gestures) */
  sonar: number;
  /** air gesture: visibility, pinch 0..1, fingertip position */
  air: { on: number; pinch: number; x: number; z: number };
};

export type MiniCtx = {
  t: number;
  dt: number;
  taps: TapField;
  state: LaptopState;
  zrt: ZoneRuntime;
  screen: ScreenPainter;
  cam: { pos: THREE.Vector3; tgt: THREE.Vector3; fov: number };
  extras: Extras;
  fire: (zone: string, gesture: Gesture, action: string, label?: string) => void;
};

export type Director = (ctx: MiniCtx) => void;

type Props = {
  tier: Tier;
  active: boolean;
  zones: Zone[];
  director: Director;
  initialCam: { pos: [number, number, number]; tgt: [number, number, number]; fov: number };
  onDeckDown?: (x: number, z: number, ctx: MiniCtx) => void;
  onEdgeDown?: (side: "left" | "right", z: number, ctx: MiniCtx) => void;
  onLidDown?: (ctx: MiniCtx) => void;
  hoverZones?: boolean;
};

export function zonePoint(z: Zone, jitter = 0.2) {
  const u = z.rect.x + z.rect.w * (0.5 + (Math.random() - 0.5) * jitter);
  const v = z.rect.y + z.rect.h * (0.5 + (Math.random() - 0.5) * jitter);
  return { x: (u - 0.5) * W, z: (v - 0.5) * D, u, v };
}

export default function MiniStage(props: Props) {
  const theme = useTheme();
  const high = props.tier.tier >= 2 && !props.tier.mobile;
  const [dpr, setDpr] = useState(high ? 1.5 : 1.25);
  return (
    <Canvas
      frameloop={props.active ? "always" : "never"}
      dpr={dpr}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: "high-performance" }}
      camera={{ fov: props.initialCam.fov, near: 0.05, far: 100, position: props.initialCam.pos }}
      onCreated={({ gl }) => void (gl.toneMapping = THREE.NoToneMapping)}
    >
      <PerformanceMonitor onDecline={() => setDpr((d) => Math.max(1, d - 0.25))} onIncline={() => setDpr((d) => Math.min(high ? 1.75 : 1.5, d + 0.25))} flipflops={4}>
        <MiniScene {...props} theme={theme} quality={high ? "high" : "low"} />
      </PerformanceMonitor>
    </Canvas>
  );
}

function MiniScene({ zones, director, initialCam, onDeckDown, onEdgeDown, onLidDown, hoverZones, theme, quality, tier }: Props & { theme: Theme; quality: "high" | "low" }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const pal = PALETTE[theme];
  const dark = theme === "dark";
  const taps = useMemo(() => new TapField(), []);
  const screen = useMemo(() => new ScreenPainter(), []);
  const state = useMemo(() => makeLaptopState(), []);
  const zrt = useMemo(() => makeZoneRuntime(), []);
  const fx = useMemo(() => ({ dissolve: 0, aberration: 0 }), []);
  const extras = useMemo<Extras>(() => ({ sonar: -100, air: { on: 0, pinch: 0, x: 0, z: -0.4 } }), []);
  const cam = useMemo(
    () => ({ pos: new THREE.Vector3(...initialCam.pos), tgt: new THREE.Vector3(...initialCam.tgt), fov: initialCam.fov }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const curPos = useMemo(() => new THREE.Vector3(...initialCam.pos), [initialCam]);
  const curTgt = useMemo(() => new THREE.Vector3(...initialCam.tgt), [initialCam]);
  const goal = useMemo(() => new THREE.Vector3(), []);
  const water = useMemo(() => {
    const w = new WaterSim(gl, quality === "high" ? 192 : 128, W / D);
    return w.ok ? w : null;
  }, [gl, quality]);
  useEffect(() => {
    taps.water = water;
    return () => water?.dispose();
  }, [water, taps]);
  useEffect(() => () => screen.dispose(), [screen]);

  const ctxRef = useRef<MiniCtx | null>(null);
  const zonesRef = useRef(zones);
  zonesRef.current = zones;

  const fire: MiniCtx["fire"] = (zoneId, gesture, action, label) => {
    const z = zonesRef.current.find((q) => q.id === zoneId) ?? zoneById(zoneId);
    const name = label ?? ZONE_SHORT[zoneId] ?? z.name;
    const hit = (s: number, withLabel: boolean) => {
      zrt.flashes[zoneId] = taps.time;
      if (z.surface === "base") {
        const p = zonePoint(z, 0.15);
        taps.tap(p.x, p.z, s, withLabel ? { zone: name, action } : undefined);
        screen.markTap(p.u, p.v, taps.time);
      } else if (withLabel) {
        // edges and lid: no deck ring, the label rises from the surface instead
        const y = z.surface === "lid" ? 1.2 : 0.05;
        const x = z.surface === "edge-left" ? -W / 2 - 0.1 : z.surface === "edge-right" ? W / 2 + 0.1 : 0;
        const zz = z.surface === "lid" ? HINGE_Z - 0.4 : (z.rect.y + z.rect.h / 2 - 0.5) * D;
        taps.tap(x, zz, 0, { zone: name, action, y });
      }
      bus.cue("tap");
    };
    hit(1, true);
    screen.showHud(`${name} · ${action}`, taps.time);
    const times = gesture === "double" ? [0.17] : gesture === "triple" ? [0.16, 0.32] : gesture === "rhythm" ? [0.62, 0.79] : [];
    times.forEach((d) => window.setTimeout(() => hit(0.85, false), d * 1000));
  };

  useFrame((s, dt) => {
    const t = now();
    taps.update(t);
    const ctx: MiniCtx = (ctxRef.current ??= { t, dt, taps, state, zrt, screen, cam, extras, fire });
    ctx.t = t;
    ctx.dt = dt;
    director(ctx);
    const k = tier.reducedMotion ? 1 : 1 - Math.exp(-dt * 4);
    // narrow or portrait panels: back the camera off so the laptop still fits
    const aspect = s.size.width / s.size.height;
    const back = THREE.MathUtils.clamp(1.45 / aspect, 1, 2.1);
    goal.copy(cam.pos).sub(cam.tgt).multiplyScalar(back).add(cam.tgt);
    curPos.lerp(goal, k);
    curTgt.lerp(cam.tgt, k);
    camera.position.copy(curPos);
    camera.lookAt(curTgt);
    camera.fov = THREE.MathUtils.lerp(camera.fov, cam.fov, k);
    camera.updateProjectionMatrix();
    water?.step(1);
    screen.paint(t);
  });

  const toCtx = () => ctxRef.current!;

  return (
    <>
      <color attach="background" args={[pal.bg]} />
      <fog attach="fog" args={[pal.bg, 10, 26]} />
      <StudioLight theme={theme} />
      <ambientLight intensity={dark ? 0.15 : 0.35} />
      <BackLight theme={theme} target={curTgt} />
      <Laptop
        state={state}
        taps={taps}
        water={water}
        screen={screen}
        theme={theme}
        onDeckPointerMove={
          tier.reducedMotion
            ? undefined
            : (x, z) => {
                taps.stir(x, z, 1);
                if (hoverZones) {
                  const u = x / W + 0.5;
                  const v = z / D + 0.5;
                  const hit = [...zonesRef.current].reverse().find((q) => q.surface === "base" && u >= q.rect.x && u <= q.rect.x + q.rect.w && v >= q.rect.y && v <= q.rect.y + q.rect.h);
                  zrt.hover = hit?.id ?? null;
                  document.body.style.cursor = hit ? "pointer" : "";
                }
              }
        }
        onDeckPointerDown={onDeckDown ? (x, z) => onDeckDown(x, z, toCtx()) : undefined}
        onEdgePointerDown={onEdgeDown ? (side, z) => onEdgeDown(side, z, toCtx()) : undefined}
        onLidPointerDown={onLidDown ? () => onLidDown(toCtx()) : undefined}
        deckChildren={
          <>
            <ZoneLayer zones={zones} surface="base" rt={zrt} taps={taps} ink={pal.ink} signal={pal.signal} dark={dark} />
            <TapLabels taps={taps} />
            <Sonar extras={extras} taps={taps} ink={pal.ink} />
            <AirHands extras={extras} ink={pal.ink} signal={pal.signal} />
          </>
        }
        lidChildren={<ZoneLayer zones={zones} surface="lid" rt={zrt} taps={taps} ink={pal.ink} signal={pal.signal} dark={dark} />}
      >
        <ZoneLayer zones={zones} surface="edges" rt={zrt} taps={taps} ink={pal.ink} signal={pal.signal} dark={dark} />
      </Laptop>
      <Floor theme={theme} quality={quality} />
      <Effects theme={theme} quality={quality} fx={fx} />
    </>
  );
}

/** Sound mode: rings of sound spreading through the air above the keys. */
function Sonar({ extras, taps, ink }: { extras: Extras; taps: TapField; ink: string }) {
  const group = useRef<THREE.Group>(null!);
  const rings = useRef<THREE.Mesh[]>([]);
  useFrame(() => {
    const age = taps.time - extras.sonar;
    group.current.visible = age >= 0 && age < 1.6;
    rings.current.forEach((m, i) => {
      const a = age - i * 0.14;
      const k = THREE.MathUtils.clamp(a / 1.2, 0, 1);
      m.scale.setScalar(0.05 + k * 1.6);
      (m.material as THREE.MeshBasicMaterial).opacity = a > 0 ? (1 - k) * 0.7 : 0;
    });
  });
  return (
    <group ref={group} position={[-0.6, 0.35, -0.3]}>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(m) => void (m && (rings.current[i] = m))} rotation={[-Math.PI / 2.6, 0, 0]}>
          <torusGeometry args={[0.5, 0.0035, 6, 96]} />
          <meshBasicMaterial color={ink} transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Camera add-on: two fingertips over the keys, pinching, inside the camera's field of view. */
function AirHands({ extras, ink, signal }: { extras: Extras; ink: string; signal: string }) {
  const group = useRef<THREE.Group>(null!);
  const a = useRef<THREE.Mesh>(null!);
  const b = useRef<THREE.Mesh>(null!);
  const cone = useRef<THREE.LineSegments>(null!);
  const coneGeo = useMemo(() => {
    // the camera's view: from the notch down to the keyboard
    const top = new THREE.Vector3(0, 2.02, -1.72);
    const corners = [new THREE.Vector3(-1.3, 0.02, -0.95), new THREE.Vector3(1.3, 0.02, -0.95), new THREE.Vector3(1.3, 0.02, 0.1), new THREE.Vector3(-1.3, 0.02, 0.1)];
    const pts: THREE.Vector3[] = [];
    corners.forEach((c, i) => {
      pts.push(top, c, c, corners[(i + 1) % 4]);
    });
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);
  useFrame(() => {
    const on = extras.air.on;
    group.current.visible = on > 0.01;
    const gap = 0.09 * (1 - extras.air.pinch) + 0.012;
    a.current.position.set(extras.air.x - gap, 0.42, extras.air.z);
    b.current.position.set(extras.air.x + gap, 0.44, extras.air.z + 0.02);
    const mA = a.current.material as THREE.MeshBasicMaterial;
    const mB = b.current.material as THREE.MeshBasicMaterial;
    const c = extras.air.pinch > 0.9 ? signal : ink;
    mA.color.set(c).multiplyScalar(2);
    mB.color.set(c).multiplyScalar(2);
    mA.opacity = mB.opacity = on;
    (cone.current.material as THREE.LineBasicMaterial).opacity = on * 0.22;
  });
  return (
    <group ref={group}>
      <mesh ref={a}>
        <sphereGeometry args={[0.022, 20, 20]} />
        <meshBasicMaterial transparent toneMapped={false} />
      </mesh>
      <mesh ref={b}>
        <sphereGeometry args={[0.022, 20, 20]} />
        <meshBasicMaterial transparent toneMapped={false} />
      </mesh>
      <lineSegments ref={cone} geometry={coneGeo}>
        <lineBasicMaterial color={ink} transparent opacity={0} depthWrite={false} />
      </lineSegments>
    </group>
  );
}
