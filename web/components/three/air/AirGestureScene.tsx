"use client";

import * as THREE from "three";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { GhostHandMesh } from "./GhostHand";
import { J, JOINTS, POSES, copyPose, makePose, mixPose, placeHand, ramp, track, expoInOut, type Anchor, type HandPose } from "./handPose";
import { HandDriver, MonoLabel, fadeLineMaterial, setBlend } from "./kit";
import { airOverlay, makeAirUI } from "./airScreen";
import type { ScreenPainter } from "../screen";
import type { TapField } from "../taps";
import { now } from "../taps";
import { W } from "@/lib/dims";

export type SceneSource = () => { id: string; progress: number; weight: number };

type Props = {
  source: SceneSource;
  screen: ScreenPainter;
  taps: TapField;
  ink: string;
  signal: string;
  dark: boolean;
};

/** The built-in camera, in the notch, with the lid open at about 108 degrees (base-local). */
export const NOTCH_CAM = new THREE.Vector3(0, 1.98, -1.7);

/** Where the pinch hangs at rest: over the keys, well inside the camera's view. */
const A0 = new THREE.Vector3(0.32, 1.08, -0.3);
/** Hand raised in front of the screen, palm toward the notch camera, back of the hand toward the viewer. */
const NEUTRAL_ROT = { pitch: 0.68, yaw: 0.1, roll: 1.7 };
/**
 * The single hand is a LEFT hand (the right hand mirrored): from the three-quarter camera at the front right,
 * its thumb and index sit on the near side, so the pinch is seen in profile instead of hidden behind the palm.
 * Rotations are given as for a right hand; the mirror flips yaw and roll.
 */
const MAIN_MIRROR = true;

type Frame = { pose: HandPose; rot: { pitch: number; yaw: number; roll: number }; anchor: Anchor; at: THREE.Vector3; env: number };
const makeFrame = (): Frame => ({ pose: makePose(), rot: { ...NEUTRAL_ROT }, anchor: "pinch", at: new THREE.Vector3(), env: 1 });

/**
 * Camera add-on gestures performed by a ghost hand above the keyboard, with the laptop screen answering.
 * Mount inside the laptop root group (base-local coordinates). Everything is a pure function of
 * `source().progress` plus a little idle time, so scrubbing back and forth is safe.
 *
 * Ids: pinch, tap, drag, drag-left, drag-right, drag-up, drag-down, swipe, dial, zoom, circle, point.
 */
export function AirGestureScene({ source, screen, ink, signal, dark }: Props) {
  const right = useMemo(() => new GhostHandMesh(ink, signal, dark), []); // eslint-disable-line react-hooks/exhaustive-deps
  const left = useMemo(() => new GhostHandMesh(ink, signal, dark), []); // eslint-disable-line react-hooks/exhaustive-deps
  const dR = useMemo(() => new HandDriver(), []);
  const dL = useMemo(() => new HandDriver(), []);
  const ui = useMemo(makeAirUI, []);
  const overlay = useMemo(() => airOverlay(ui), [ui]);
  const group = useRef<THREE.Group>(null!);
  const labelAnchor = useRef<THREE.Group>(null!);
  const label = useMemo(() => new MonoLabel("M4 and M5 · camera add-on", "rgba(237,237,239,0.6)"), []);
  const ring = useRef<THREE.Mesh>(null!);

  // scratch, allocated once
  const S = useMemo(
    () => ({
      f: makeFrame(),
      fl: makeFrame(),
      n: makeFrame(),
      tmpA: new Float32Array(JOINTS * 3),
      tmpB: new Float32Array(JOINTS * 3),
      pinchWas: 0,
      flashT: -10,
      leftOn: 0,
      overlayOn: false,
      pinchPt: new THREE.Vector3(),
      ringPt: new THREE.Vector3(),
      viewH: new THREE.Vector2(),
    }),
    [],
  );

  // dial ring, knob ring and the zoom span: one hairline geometry, rebuilt in place
  const rings = useMemo(() => {
    const segs = 96, ticks = 36;
    const n = segs * 2 + ticks * 2 + 2 * 2;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = fadeLineMaterial();
    const obj = new THREE.LineSegments(g, m);
    obj.frustumCulled = false;
    obj.renderOrder = 12;
    return { g, m, obj, pos, alpha, segs, ticks };
  }, []);

  // the camera's view: four hairlines from the notch, fading out
  const frustum = useMemo(() => {
    const far = [
      [-1.2, 0.2, 0.6],
      [1.2, 0.2, 0.6],
      [1.2, 1.2, 0.6],
      [-1.2, 1.2, 0.6],
    ];
    const pos: number[] = [];
    const al: number[] = [];
    for (const c of far) {
      pos.push(NOTCH_CAM.x, NOTCH_CAM.y, NOTCH_CAM.z, c[0], c[1], c[2]);
      al.push(0.07, 0.0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aAlpha", new THREE.Float32BufferAttribute(al, 1));
    const m = fadeLineMaterial();
    const obj = new THREE.LineSegments(g, m);
    obj.renderOrder = 11;
    return { g, m, obj };
  }, []);

  const ringMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(signal) }, uK: { value: 0 }, uA: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uK; uniform float uA; varying vec2 vUv;
          void main(){ float d = length(vUv - 0.5) * 2.0; float r = 0.18 + uK * 0.8;
            float a = exp(-((d - r) / 0.022) * ((d - r) / 0.022)) + exp(-d * d * 60.0) * (1.0 - uK) * 0.6;
            gl_FragColor = vec4(uColor * 1.6, a * uA); }`,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    right.setLook(ink, signal, dark);
    label.draw(dark ? "rgba(237,237,239,0.6)" : "rgba(11,11,12,0.6)");
    left.setLook(ink, signal, dark);
    (rings.m.uniforms.uColor.value as THREE.Color).set(ink);
    (frustum.m.uniforms.uColor.value as THREE.Color).set(ink);
    (ringMat.uniforms.uColor.value as THREE.Color).set(signal);
    setBlend(rings.m, dark);
    setBlend(frustum.m, dark);
    setBlend(ringMat, dark);
  }, [right, left, rings, frustum, ringMat, ink, signal, dark]);

  useEffect(
    () => () => {
      if (screen.overlay === overlay) screen.setOverlay(null);
      label.dispose();
      right.dispose();
      left.dispose();
      rings.g.dispose();
      rings.m.dispose();
      frustum.g.dispose();
      frustum.m.dispose();
      ringMat.dispose();
    },
    [screen, right, left, rings, frustum, ringMat],
  );

  const neutral = (f: Frame, x = A0.x) => {
    copyPose(POSES.ready, f.pose);
    f.rot.pitch = NEUTRAL_ROT.pitch;
    f.rot.yaw = NEUTRAL_ROT.yaw;
    f.rot.roll = NEUTRAL_ROT.roll;
    f.anchor = "pinch";
    f.at.set(x, A0.y, A0.z);
    f.env = 1;
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
      dR.sleep();
      dL.sleep();
      S.leftOn = 0;
      label.opacity = 0;
      return;
    }
    // claim the screen when it is free; during a cross-fade the scene that was there first keeps it until it fades out
    if (screen.overlay === null) screen.setOverlay(overlay);
    S.overlayOn = true;
    const t = now();
    const p = THREE.MathUtils.clamp(src.progress, 0, 1);
    const id = src.id;
    const f = S.f;
    neutral(f);
    ui.id = id;
    ui.weight = w;
    ui.dx = ui.dy = 0;
    ui.dir = "";
    let pinch = 0;
    let twoHands = false;
    let showDial = 0, showKnob = 0;
    let knobAngle = 0;

    // Every gesture holds its key pose from about 0.3 to 0.62 of the step: the site snaps scroll to the step's centre.
    if (id === "pinch" || id === "tap") {
      pinch = track([[0, 0], [0.1, 0], [0.26, 1], [0.62, 1], [0.76, 0]], p);
      mixPose(POSES.ready, POSES.pinch, pinch, f.pose);
      // the wrist leads: the hand drifts in a little before the fingers close, and settles back after
      const lead = ramp(p, 0, 0.22) - ramp(p, 0.7, 0.95);
      f.at.z -= 0.06 * lead;
      f.at.y -= 0.03 * pinch;
      f.rot.pitch += 0.06 * lead;
    } else if (id.startsWith("drag")) {
      const dir = id === "drag" ? "left" : id.slice(5);
      pinch = track([[0, 0], [0.06, 0], [0.16, 1], [0.64, 1], [0.74, 0]], p);
      const m = track([[0, 0], [0.14, 0], [0.32, 1], [0.66, 1], [0.94, 0]], p, expoInOut);
      const mx = dir === "left" ? -m : dir === "right" ? m : 0;
      const my = dir === "up" ? m : dir === "down" ? -m : 0;
      ui.dir = dir.toUpperCase();
      mixPose(POSES.ready, POSES.pinch, pinch, f.pose);
      f.at.x += mx * 0.6;
      f.at.y += my * 0.32;
      // the wrist turns into the move
      f.rot.yaw -= mx * 0.22;
      f.rot.pitch += my * 0.15;
      ui.dx = mx;
      ui.dy = my;
    } else if (id === "swipe") {
      const sL = ramp(p, 0.08, 0.3, expoInOut);
      const back = ramp(p, 0.66, 0.94);
      copyPose(POSES.open, f.pose);
      f.pose.spread = 1.5;
      f.rot.pitch = 0.95;
      f.rot.roll = 0.35;
      // the wrist leads the sweep, the fingers trail a little
      f.rot.yaw = -0.1 - 0.3 * Math.sin(Math.PI * sL) + 0.2 * Math.sin(Math.PI * back);
      f.anchor = "palm";
      f.at.set(0.8 - 1.5 * sL + 1.5 * back, 0.72 + 0.05 * Math.sin(Math.PI * sL), -0.05);
      f.env = ramp(p, 0, 0.08) * (1 - ramp(p, 0.94, 1));
      ui.swipe = sL - back;
      ui.dir = "LEFT";
    } else if (id === "dial") {
      pinch = track([[0, 0], [0.06, 0], [0.16, 1], [0.66, 1], [0.76, 0]], p);
      const turn = ramp(p, 0.16, 0.32) - ramp(p, 0.76, 0.94);
      mixPose(POSES.ready, POSES.pinch, pinch, f.pose);
      f.rot.roll = NEUTRAL_ROT.roll - 0.35 + turn * 0.9;
      ui.dial = 0.3 + 0.45 * ramp(p, 0.16, 0.32);
      showDial = pinch;
      knobAngle = turn * 0.9;
    } else if (id === "zoom") {
      twoHands = true;
      pinch = track([[0, 0], [0.06, 0], [0.16, 1], [0.66, 1], [0.76, 0]], p);
      const sep = track([[0, 0.42], [0.16, 0.42], [0.32, 0.82], [0.66, 0.82], [0.9, 0.46]], p);
      mixPose(POSES.ready, POSES.pinch, pinch, f.pose);
      f.rot.yaw = NEUTRAL_ROT.yaw + 0.15;
      f.at.set(-sep, A0.y, A0.z);
      ui.zoom = 1 + ((sep - 0.42) / 0.4) * 1.1;
    } else if (id === "circle") {
      const turns = 1.25 * ramp(p, 0.1, 0.9);
      const th = Math.PI / 2 - turns * Math.PI * 2;
      copyPose(POSES.point, f.pose);
      f.rot.pitch = 0.7;
      f.rot.yaw = 0.1;
      f.rot.roll = -0.4;
      f.anchor = "index";
      const C = S.ringPt.set(0.3, 1.02, -0.4);
      f.at.set(C.x + Math.cos(th) * 0.18, C.y + Math.sin(th) * 0.18, C.z);
      f.env = ramp(p, 0, 0.1) * (1 - ramp(p, 0.9, 1));
      ui.turns = turns;
      showKnob = f.env;
      knobAngle = -turns * Math.PI * 2;
    } else if (id === "point") {
      const k = ramp(p, 0.1, 0.9);
      const ox = Math.sin(k * Math.PI * 2) * 0.4;
      const oy = Math.sin(k * Math.PI * 4) * 0.12;
      copyPose(POSES.point, f.pose);
      f.rot.pitch = 0.7;
      f.rot.yaw = 0.1;
      f.rot.roll = -0.4;
      f.anchor = "index";
      f.at.set(0.3 + ox, 1.0 + oy, -0.4);
      f.env = ramp(p, 0, 0.1) * (1 - ramp(p, 0.9, 1));
      ui.px = 0.5 + ox / 0.85;
      ui.py = 0.5 - oy / 0.26;
    }
    ui.pinch = pinch;

    // the pinch closing is the one moment a touch is felt: flash in signal, in real time
    if (pinch > 0.95 && S.pinchWas <= 0.95) S.flashT = t;
    S.pinchWas = pinch;
    const flash = pinch > 0.9 ? Math.exp(-(t - S.flashT) * 3.2) : 0;
    ui.flash = flash;

    // idle life: breathing and a faint tremor
    const breath = Math.sin(t * 1.3) * 0.006;
    const idleX = Math.sin(t * 6.3) * 0.0025 + Math.sin(t * 10.7 + 1) * 0.0015;
    const idleY = Math.sin(t * 1.3 + 0.4) * 0.012;
    f.at.x += idleX;
    f.at.y += idleY;

    placeHand(f.pose, f.rot, f.anchor, f.at, S.tmpA, MAIN_MIRROR, breath);
    if (f.env < 0.999) {
      neutral(S.n);
      S.n.at.x += idleX;
      S.n.at.y += idleY;
      placeHand(S.n.pose, S.n.rot, S.n.anchor, S.n.at, S.tmpB, MAIN_MIRROR, breath);
      const e = f.env;
      for (let i = 0; i < S.tmpA.length; i++) dR.target[i] = S.tmpB[i] + (S.tmpA[i] - S.tmpB[i]) * e;
    } else dR.target.set(S.tmpA);
    dR.hot.fill(0);
    dR.hot[J.T_TIP] = dR.hot[J.I_TIP] = flash;
    dR.hot[J.T_IP] = dR.hot[J.I_DIP] = flash * 0.4;
    dR.opacity = w;
    dR.step(right, dt, 12);

    // second hand, mirrored, for the two hand zoom
    S.leftOn = THREE.MathUtils.damp(S.leftOn, twoHands ? 1 : 0, 7, dt);
    if (S.leftOn > 0.01) {
      const fl = S.fl;
      copyPose(f.pose, fl.pose);
      fl.rot.pitch = f.rot.pitch;
      fl.rot.yaw = f.rot.yaw;
      fl.rot.roll = f.rot.roll;
      fl.anchor = "pinch";
      fl.at.set(twoHands ? -f.at.x : -0.9, f.at.y + Math.sin(t * 1.1) * 0.004, f.at.z);
      placeHand(fl.pose, fl.rot, fl.anchor, fl.at, dL.target, !MAIN_MIRROR, breath * 0.8);
      dL.hot.fill(0);
      dL.hot[J.T_TIP] = dL.hot[J.I_TIP] = flash;
      dL.opacity = w * S.leftOn;
      dL.step(left, dt, 12);
    } else {
      dL.sleep();
      left.opacity = 0;
    }
    state.gl.getDrawingBufferSize(S.viewH);
    const fov = THREE.MathUtils.degToRad((state.camera as THREE.PerspectiveCamera).fov ?? 30);
    right.update(S.viewH.y, fov);
    left.update(S.viewH.y, fov);

    // air ring at the pinch: a touch felt in mid-air
    const jj = right.joints;
    S.pinchPt.set((jj[J.I_TIP * 3] + jj[J.T_TIP * 3]) / 2, (jj[J.I_TIP * 3 + 1] + jj[J.T_TIP * 3 + 1]) / 2, (jj[J.I_TIP * 3 + 2] + jj[J.T_TIP * 3 + 2]) / 2);
    ring.current.visible = flash > 0.01;
    if (flash > 0.01) {
      ring.current.position.copy(S.pinchPt);
      ring.current.quaternion.copy(state.camera.quaternion);
      if (group.current.parent) {
        // cancel the parents' rotation so the ring faces the camera
        group.current.parent.getWorldQuaternion(TMPQ);
        ring.current.quaternion.premultiply(TMPQ.invert());
      }
      ringMat.uniforms.uK.value = 1 - flash;
      ringMat.uniforms.uA.value = flash * w;
    }

    // dial ring (pinch and turn) or knob ring (circle): hairlines in the plane facing the screen
    const rp = rings.pos, ra = rings.alpha;
    let v = 0;
    const amt = Math.max(showDial, showKnob);
    const c = showKnob > 0 ? S.ringPt : A0;
    const R = showKnob > 0 ? 0.26 : 0.19;
    const put = (x: number, y: number, z: number, a: number) => {
      rp[v * 3] = x;
      rp[v * 3 + 1] = y;
      rp[v * 3 + 2] = z;
      ra[v] = a;
      v++;
    };
    for (let i = 0; i < rings.segs; i++) {
      const a0 = (i / rings.segs) * Math.PI * 2, a1 = ((i + 1) / rings.segs) * Math.PI * 2;
      put(c.x + Math.cos(a0) * R, c.y + Math.sin(a0) * R, c.z, 0.35 * amt);
      put(c.x + Math.cos(a1) * R, c.y + Math.sin(a1) * R, c.z, 0.35 * amt);
    }
    for (let i = 0; i < rings.ticks; i++) {
      const a = (i / rings.ticks) * Math.PI * 2 + knobAngle;
      const major = i % 9 === 0;
      const r1 = R + (major ? 0.07 : 0.035);
      put(c.x + Math.cos(a) * (R + 0.012), c.y + Math.sin(a) * (R + 0.012), c.z, (major ? 0.8 : 0.4) * amt);
      put(c.x + Math.cos(a) * r1, c.y + Math.sin(a) * r1, c.z, (major ? 0.8 : 0.4) * amt);
    }
    // zoom span between the two pinches
    const span = twoHands ? pinch * S.leftOn : 0;
    const lj = left.joints;
    const lx = (lj[J.I_TIP * 3] + lj[J.T_TIP * 3]) / 2, ly = (lj[J.I_TIP * 3 + 1] + lj[J.T_TIP * 3 + 1]) / 2, lz = (lj[J.I_TIP * 3 + 2] + lj[J.T_TIP * 3 + 2]) / 2;
    put(lx, ly, lz, 0.4 * span);
    put(S.pinchPt.x, S.pinchPt.y, S.pinchPt.z, 0.4 * span);
    put(lx, ly - 0.04, lz, 0.4 * span);
    put(lx, ly + 0.04, lz, 0.4 * span);
    rings.g.attributes.position.needsUpdate = true;
    rings.g.attributes.aAlpha.needsUpdate = true;
    rings.m.uniforms.uOpacity.value = w;
    frustum.m.uniforms.uOpacity.value = w;

    // label rides beside the hand
    // in the air just above the keys, to the left of the hand: over dark keys, never over the screen
    labelAnchor.current.position.set(THREE.MathUtils.clamp(jj[J.I_TIP * 3] - 1.0, -1.25, 0.2), 0.14, 0.12);
    label.opacity = Math.min(1, w * 1.2);
    label.fit(S.viewH.y, THREE.MathUtils.degToRad((state.camera as THREE.PerspectiveCamera).fov ?? 30), state.viewport.dpr);
  });

  return (
    <group ref={group} visible={false}>
      <primitive object={right} />
      <primitive object={left} />
      <primitive object={rings.obj} />
      <mesh ref={ring} material={ringMat} renderOrder={15} visible={false} raycast={() => null}>
        <planeGeometry args={[0.5, 0.5]} />
      </mesh>
      <group ref={labelAnchor}>
        <primitive object={label} />
      </group>
    </group>
  );
}

const TMPQ = new THREE.Quaternion();
