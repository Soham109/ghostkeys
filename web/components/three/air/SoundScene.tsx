"use client";

import * as THREE from "three";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { GRILLE, KB, W } from "@/lib/dims";
import { bus } from "@/lib/stage";
import { GhostHandMesh } from "./GhostHand";
import { J, JOINTS, POSES, copyPose, makePose, mixPose, placeHand, ramp, track, type Anchor, type HandPose } from "./handPose";
import { HandDriver, MonoLabel, fadeLineMaterial, setBlend } from "./kit";
import { makeSoundUI, soundOverlay } from "./soundScreen";
import type { ScreenPainter } from "../screen";
import type { TapField } from "../taps";
import { now } from "../taps";
import type { SceneSource } from "./AirGestureScene";

type Props = {
  source: SceneSource;
  screen: ScreenPainter;
  taps: TapField;
  ink: string;
  signal: string;
  dark: boolean;
};

/** Right palm rest, where the knocks land. */
const PALM = new THREE.Vector3(1.1, 0.014, 0.6);
const GRILLE_X = (GRILLE.inner + GRILLE.outer) / 2;
const GRILLE_Z = (GRILLE.z0 + GRILLE.z1) / 2;
const KNUCKLE_AT = [0.18, 0.27];
const TIP_AT = [0.74, 0.82];
/** knuckle height over the palm rest through the step: two knocks, a long rest in contact (the beat centre), two fingertip taps */
const KNOCK_H: [number, number][] = [[0, 0.3], [0.12, 0.3], [0.16, 0.11], [0.18, 0], [0.215, 0.1], [0.245, 0.1], [0.27, 0], [0.58, 0], [0.64, 0.24], [0.7, 0.2], [0.74, 0], [0.775, 0.11], [0.8, 0.11], [0.82, 0], [0.88, 0.24], [1, 0.3]];
const REST0 = 0.31, REST1 = 0.56, AUTO = 1.9, AUTO_HIT = 0.34;
const CONTACTS = [...KNUCKLE_AT, ...TIP_AT];
const HOT_KNUCKLE = [J.I_PIP, J.M_PIP, J.R_PIP];
const HOT_TIP = [J.I_TIP];
const HOT_NONE: number[] = [];

const SHELLS = 12;
const COMB = 15;
const FIELD_LINES = 28;
const FIELD_PTS = 140;

type Frame = { pose: HandPose; rot: { pitch: number; yaw: number; roll: number }; anchor: Anchor; at: THREE.Vector3; env: number };
const makeFrame = (): Frame => ({ pose: makePose(), rot: { pitch: 0, yaw: 0, roll: 0 }, anchor: "lowest", at: new THREE.Vector3(), env: 1 });

const shellVert = /* glsl */ `
varying float vRim;
varying float vH;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  vH = position.y;
  gl_Position = projectionMatrix * mv;
}`;
const shellFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uA;
uniform float uK;
varying float vRim;
varying float vH;
void main() {
  float a = pow(vRim, uK) * uA * smoothstep(0.0, 0.12, vH);
  gl_FragColor = vec4(uColor, a);
}`;

/**
 * Sound mode, seen: knuckle versus fingertip knocks as two kinds of sound wave, a fingertip rubbing the grille
 * as a comb of harmonics, and a hand wave bending an inaudible 20 kHz field over the keys.
 * Mount inside the laptop root group. Ids: knuckle (also fingertip), rub, wave.
 */
export function SoundScene({ source, screen, taps, ink, signal, dark }: Props) {
  const hand = useMemo(() => new GhostHandMesh(ink, signal, dark), []); // eslint-disable-line react-hooks/exhaustive-deps
  const drv = useMemo(() => new HandDriver(), []);
  const ui = useMemo(makeSoundUI, []);
  const overlay = useMemo(() => soundOverlay(ui), [ui]);
  const group = useRef<THREE.Group>(null!);
  const labelAnchor = useRef<THREE.Group>(null!);
  const label = useMemo(() => new MonoLabel("Sound mode · on-device", "rgba(237,237,239,0.6)"), []);

  const S = useMemo(
    () => ({
      f: makeFrame(),
      n: makeFrame(),
      a: new Float32Array(JOINTS * 3),
      b: new Float32Array(JOINTS * 3),
      prevP: -1,
      prevId: "",
      prevPhase: 0,
      hitT: -10,
      hitKind: "knuckle" as "knuckle" | "fingertip",
      overlayOn: false,
      energy: 0,
      prevZ: 0,
      prevX: 0,
      vel: 0,
      shell: 0,
      viewH: new THREE.Vector2(),
    }),
    [],
  );

  // acoustic shells: a pool of hemispheres, rim lit
  const shells = useMemo(() => {
    const geo = new THREE.SphereGeometry(1, 56, 18, 0, Math.PI * 2, 0, Math.PI / 2);
    const list = Array.from({ length: SHELLS }, () => {
      const m = new THREE.ShaderMaterial({
        vertexShader: shellVert,
        fragmentShader: shellFrag,
        uniforms: { uColor: { value: new THREE.Color(ink) }, uA: { value: 0 }, uK: { value: 4 } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, m);
      mesh.visible = false;
      mesh.renderOrder = 11;
      mesh.raycast = () => null;
      return { mesh, m, born: -10, kind: 0, x: 0, z: 0 };
    });
    return { geo, list };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // comb and field: one hairline geometry each
  const comb = useMemo(() => {
    const n = (COMB + 1) * 2;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const al = new Float32Array(n);
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(al, 1).setUsage(THREE.DynamicDrawUsage));
    const m = fadeLineMaterial();
    const obj = new THREE.LineSegments(g, m);
    obj.frustumCulled = false;
    obj.renderOrder = 11;
    return { g, m, obj, pos, al };
  }, []);
  const field = useMemo(() => {
    const n = FIELD_LINES * (FIELD_PTS - 1) * 2;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const al = new Float32Array(n);
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(al, 1).setUsage(THREE.DynamicDrawUsage));
    const m = fadeLineMaterial();
    const obj = new THREE.LineSegments(g, m);
    obj.frustumCulled = false;
    obj.renderOrder = 11;
    const ys = new Float32Array(FIELD_LINES * FIELD_PTS);
    return { g, m, obj, pos, al, ys };
  }, []);

  useEffect(() => {
    hand.setLook(ink, signal, dark);
    label.draw(dark ? "rgba(237,237,239,0.6)" : "rgba(11,11,12,0.6)");
    for (const s of shells.list) {
      (s.m.uniforms.uColor.value as THREE.Color).set(ink);
      setBlend(s.m, dark);
    }
    for (const o of [comb.m, field.m]) {
      (o.uniforms.uColor.value as THREE.Color).set(ink);
      setBlend(o, dark);
    }
  }, [hand, shells, comb, field, ink, signal, dark]);

  useEffect(
    () => () => {
      if (screen.overlay === overlay) screen.setOverlay(null);
      label.dispose();
      hand.dispose();
      shells.geo.dispose();
      shells.list.forEach((s) => s.m.dispose());
      comb.g.dispose();
      comb.m.dispose();
      field.g.dispose();
      field.m.dispose();
    },
    [screen, hand, shells, comb, field],
  );

  const hover = (f: Frame) => {
    copyPose(POSES.relaxed, f.pose);
    f.rot.pitch = -0.25;
    f.rot.yaw = -0.9;
    f.rot.roll = -0.2;
    f.anchor = "lowest";
    f.at.set(PALM.x, 0.36, PALM.z);
    f.env = 1;
  };

  const spawn = (kind: "knuckle" | "fingertip", x: number, z: number, t: number) => {
    const delays = kind === "knuckle" ? [0, 0.045, 0.09, 0.135] : [0, 0.16];
    for (const d of delays) {
      const s = shells.list[S.shell++ % SHELLS];
      s.born = t + d;
      s.kind = kind === "knuckle" ? 0 : 1;
      s.x = x;
      s.z = z;
    }
  };

  useFrame((state, dt) => {
    const src = source();
    const w = THREE.MathUtils.clamp(src.weight, 0, 1);
    const on = w > 0.002;
    group.current.visible = on;
    if (!on) {
      if (S.overlayOn) {
        // only clear the screen if it is still ours (the other scene may have taken it during a cross-fade)
        if (screen.overlay === overlay) screen.setOverlay(null);
        S.overlayOn = false;
      }
      drv.sleep();
      S.prevP = -1;
      label.opacity = 0;
      return;
    }
    // claim the screen when it is free; during a cross-fade the scene that was there first keeps it until it fades out
    if (screen.overlay === null) screen.setOverlay(overlay);
    S.overlayOn = true;
    const t = now();
    const p = THREE.MathUtils.clamp(src.progress, 0, 1);
    const id = src.id === "fingertip" ? "knuckle" : src.id;
    if (id !== S.prevId) S.prevP = -1;
    S.prevId = id;
    const f = S.f;
    hover(f);
    let hotJoints = HOT_NONE;
    let rubAmt = 0, waveAmt = 0;

    if (id === "knuckle") {
      const b = ramp(p, 0.6, 0.68);
      mixPose(POSES.knuckle, POSES.fingertip, b, f.pose);
      // seen side on from the three-quarter camera: the forearm crosses the frame, the fist in profile
      f.rot.pitch = THREE.MathUtils.lerp(0.1, -0.42, b);
      f.rot.yaw = -0.9;
      f.rot.roll = THREE.MathUtils.lerp(-0.3, -0.25, b);
      let h = track(KNOCK_H, p);
      // parked on the beat centre: keep knocking in real time, so the moment never goes still
      const parked = p > REST0 && p < REST1;
      const ph = t % AUTO;
      if (parked) {
        if (ph < AUTO_HIT) h += 0.09 * Math.sin((Math.PI * ph) / AUTO_HIT);
        if (S.prevPhase < AUTO_HIT && ph >= AUTO_HIT && S.prevP > REST0 && S.prevP < REST1) {
          taps.tap(PALM.x, PALM.z, 0.9);
          spawn("knuckle", PALM.x, PALM.z, t);
          S.hitT = t;
          S.hitKind = "knuckle";
          bus.cue("tap");
        }
      }
      S.prevPhase = ph;
      f.at.set(PALM.x, PALM.y + h, PALM.z);
      f.env = ramp(p, 0, 0.1) * (1 - ramp(p, 0.92, 1));
      // contact: a real tap on the deck and a sound wave in the air
      if (S.prevP >= 0 && p - S.prevP < 0.3) {
        for (const tc of CONTACTS) {
          if (S.prevP < tc && p >= tc) {
            const kind = tc < 0.5 ? "knuckle" : "fingertip";
            const x = PALM.x + (tc === KNUCKLE_AT[1] || tc === TIP_AT[1] ? 0.06 : -0.03);
            const first = tc === KNUCKLE_AT[0] || tc === TIP_AT[0];
            taps.tap(x, PALM.z, kind === "knuckle" ? 1 : 0.55, first ? { zone: "Right palm", action: kind === "knuckle" ? "Knuckle" : "Fingertip" } : undefined);
            spawn(kind, x, PALM.z, t);
            S.hitT = t;
            S.hitKind = kind;
            bus.cue("tap");
          }
        }
      }
      hotJoints = S.hitKind === "knuckle" ? HOT_KNUCKLE : HOT_TIP;
    } else if (id === "rub") {
      copyPose(POSES.fingertip, f.pose);
      f.rot.pitch = -0.5;
      f.rot.yaw = -0.9;
      f.rot.roll = -0.25;
      const env = ramp(p, 0.04, 0.18) * (1 - ramp(p, 0.84, 0.96));
      const ph = Math.PI * 2 * (2.2 * p) + t * 4.4;
      const z = GRILLE_Z - 0.18 + Math.sin(ph) * 0.28 * env;
      f.at.set(GRILLE_X, 0.012 + 0.26 * (1 - env), z);
      f.env = ramp(p, 0, 0.1) * (1 - ramp(p, 0.9, 1));
      const v = Math.abs(z - S.prevZ) / Math.max(dt, 1e-3);
      S.prevZ = z;
      S.energy = THREE.MathUtils.damp(S.energy, Math.min(1, v / 1.1) * env, 8, dt);
      rubAmt = env;
      if (env > 0.6) taps.stir(GRILLE_X, z, 0.8);
      hotJoints = HOT_TIP;
    } else if (id === "wave") {
      copyPose(POSES.open, f.pose);
      f.pose.spread = 1.4;
      const env = ramp(p, 0.04, 0.2) * (1 - ramp(p, 0.82, 0.96));
      const ph = Math.PI * 2 * (1.6 * p) + t * 2.1;
      const x = Math.sin(ph) * 0.8 * env;
      f.rot.pitch = -0.08;
      f.rot.yaw = 0.05;
      f.rot.roll = -0.12 - Math.cos(ph) * 0.35 * env;
      f.anchor = "palm";
      f.at.set(0.1 + x, 0.62 - 0.1 * env, -0.25);
      f.env = ramp(p, 0, 0.12) * (1 - ramp(p, 0.9, 1));
      S.vel = THREE.MathUtils.damp(S.vel, (x - S.prevX) / Math.max(dt, 1e-3), 6, dt);
      S.prevX = x;
      waveAmt = env;
    }
    S.prevP = p;

    const breath = Math.sin(t * 1.3) * 0.006;
    f.at.x += Math.sin(t * 6.3) * 0.002;
    f.at.y += id === "knuckle" || id === "rub" ? 0 : Math.sin(t * 1.3 + 0.4) * 0.01;
    placeHand(f.pose, f.rot, f.anchor, f.at, S.a, false, breath);
    if (f.env < 0.999) {
      hover(S.n);
      S.n.at.y += Math.sin(t * 1.3 + 0.4) * 0.01;
      placeHand(S.n.pose, S.n.rot, S.n.anchor, S.n.at, S.b, false, breath);
      for (let i = 0; i < S.a.length; i++) drv.target[i] = S.b[i] + (S.a[i] - S.b[i]) * f.env;
    } else drv.target.set(S.a);
    const flash = Math.exp(-Math.max(0, t - S.hitT) * 4);
    drv.hot.fill(0);
    for (const j of hotJoints) drv.hot[j] = id === "knuckle" ? flash : rubAmt * 0.35;
    drv.opacity = w;
    drv.step(hand, dt, id === "knuckle" ? 22 : 12);
    state.gl.getDrawingBufferSize(S.viewH);
    hand.update(S.viewH.y, THREE.MathUtils.degToRad((state.camera as THREE.PerspectiveCamera).fov ?? 30));

    // shells
    for (const s of shells.list) {
      const age = t - s.born;
      const life = s.kind === 0 ? 0.6 : 1.3;
      const live = age >= 0 && age < life;
      s.mesh.visible = live;
      if (!live) continue;
      const k = age / life;
      const r = s.kind === 0 ? 0.04 + age * 2.2 : 0.06 + age * 0.95;
      s.mesh.position.set(s.x, 0.002, s.z);
      s.mesh.scale.set(r, r * (s.kind === 0 ? 0.85 : 0.7), r);
      s.m.uniforms.uK.value = s.kind === 0 ? 9 : 2.4;
      s.m.uniforms.uA.value = (1 - k) * (1 - k) * (s.kind === 0 ? 0.9 : 0.42) * w;
    }

    // comb of harmonics rising from the grille
    const cp = comb.pos, ca = comb.al;
    let v = 0;
    const cput = (x: number, y: number, z: number, a: number) => {
      cp[v * 3] = x;
      cp[v * 3 + 1] = y;
      cp[v * 3 + 2] = z;
      ca[v] = a;
      v++;
    };
    const E = S.energy;
    for (let i = 0; i < COMB; i++) {
      const z = GRILLE.z0 + ((i + 0.5) / COMB) * (GRILLE.z1 - GRILLE.z0);
      const hgt = (E * 0.75) / (1 + i * 0.14) * (0.86 + 0.14 * Math.sin(t * 27 + i * 1.9)) + 0.004;
      cput(GRILLE_X, 0.006, z, 0.9 * rubAmt);
      cput(GRILLE_X, 0.006 + hgt, z, 0.25 * rubAmt);
    }
    cput(GRILLE_X, 0.006, GRILLE.z0, 0.3 * rubAmt);
    cput(GRILLE_X, 0.006, GRILLE.z1, 0.3 * rubAmt);
    comb.g.attributes.position.needsUpdate = true;
    comb.g.attributes.aAlpha.needsUpdate = true;
    comb.m.uniforms.uOpacity.value = w;
    comb.obj.visible = rubAmt > 0.01;

    // the 20 kHz field over the keys, bent by the palm
    field.obj.visible = waveAmt > 0.01;
    if (field.obj.visible) {
      const hx = (hand.joints[0] + hand.joints[J.M_MCP * 3]) / 2;
      const hy = (hand.joints[1] + hand.joints[J.M_MCP * 3 + 1]) / 2;
      const hz = (hand.joints[2] + hand.joints[J.M_MCP * 3 + 2]) / 2;
      const near = THREE.MathUtils.clamp(1.2 - hy, 0, 1) * waveAmt;
      const fp = field.pos, fa = field.al, ys = field.ys;
      const x0 = KB.x0 - 0.12, x1 = KB.x1 + 0.12;
      for (let l = 0; l < FIELD_LINES; l++) {
        const z = KB.z0 + (l / (FIELD_LINES - 1)) * (KB.z1 - KB.z0);
        for (let i = 0; i < FIELD_PTS; i++) {
          const x = x0 + (i / (FIELD_PTS - 1)) * (x1 - x0);
          const d = ((x - hx) * (x - hx)) / 0.32 + ((z - hz) * (z - hz)) / 0.6;
          ys[l * FIELD_PTS + i] = 0.12 + 0.2 * Math.exp(-d) * near + 0.0012 * Math.sin(x * 110 - t * 38 + l * 1.7);
        }
        for (let i = 0; i < FIELD_PTS - 1; i++) {
          const k = (l * (FIELD_PTS - 1) + i) * 2;
          const xa = x0 + (i / (FIELD_PTS - 1)) * (x1 - x0);
          const xb = x0 + ((i + 1) / (FIELD_PTS - 1)) * (x1 - x0);
          fp[k * 3] = xa;
          fp[k * 3 + 1] = ys[l * FIELD_PTS + i];
          fp[k * 3 + 2] = z;
          fp[k * 3 + 3] = xb;
          fp[k * 3 + 4] = ys[l * FIELD_PTS + i + 1];
          fp[k * 3 + 5] = z;
          const ea = Math.sin((i / (FIELD_PTS - 1)) * Math.PI);
          const eb = Math.sin(((i + 1) / (FIELD_PTS - 1)) * Math.PI);
          const lift = Math.min(1, (ys[l * FIELD_PTS + i] - 0.12) * 8);
          fa[k] = (0.07 + 0.2 * lift) * ea * waveAmt;
          fa[k + 1] = (0.07 + 0.2 * lift) * eb * waveAmt;
        }
      }
      field.g.attributes.position.needsUpdate = true;
      field.g.attributes.aAlpha.needsUpdate = true;
      field.m.uniforms.uOpacity.value = w;
      ui.near = near;
    }

    ui.id = id;
    ui.weight = w;
    ui.kind = S.hitKind;
    ui.hitT = S.hitT;
    ui.energy = S.energy;
    ui.vel = S.vel;

    const jj = hand.joints;
    // in the air just above the keys, to the left of the hand: over dark keys, never over the screen
    labelAnchor.current.position.set(THREE.MathUtils.clamp(jj[J.I_TIP * 3] - 1.0, -1.25, 0.2), 0.14, 0.12);
    label.opacity = Math.min(1, w * 1.2);
    label.fit(S.viewH.y, THREE.MathUtils.degToRad((state.camera as THREE.PerspectiveCamera).fov ?? 30), state.viewport.dpr);
  });

  return (
    <group ref={group} visible={false}>
      <primitive object={hand} />
      {shells.list.map((s, i) => (
        <primitive key={i} object={s.mesh} />
      ))}
      <primitive object={comb.obj} />
      <primitive object={field.obj} />
      <group ref={labelAnchor}>
        <primitive object={label} />
      </group>
    </group>
  );
}
