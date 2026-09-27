import * as THREE from "three";
import { J, JOINTS, POSES, makePose, mixPose, copyPose, placeHand, type HandPose } from "./handPose";
import { UNIT, HAND_TRAIL } from "./GlassHand";
import { LID_ANGLE, ZONES, V3 } from "../../timeline";

/** One solved hand for one frame, in laptop units. */
export type Solved = { joints: Float32Array; hot: Float32Array; opacity: number };
export type HandFrame = Solved & { trails: Float32Array[] };

type Rot = { pitch: number; yaw: number; roll: number };
type Place =
  | { contact: "y-" | "x-" | "x+"; at: V3; pad?: number } // surface contact: the extreme joint (plus its skin) lands on `at`
  | { anchor: "index" | "palm" | "pinch" | "wrist"; at: V3 };

const ORIGIN = new THREE.Vector3();
const tmp = new Float32Array(JOINTS * 3);
const pose = makePose();

/** Keyframed value over absolute frames, smooth (sine in-out) between keys. */
export const k = (f: number, keys: Array<[number, number]>) => {
  if (f <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [a, va] = keys[i];
    const [b, vb] = keys[i + 1];
    if (f <= b) {
      const t = (f - a) / Math.max(1e-6, b - a);
      return va + (vb - va) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
  }
  return keys[keys.length - 1][1];
};

const jointAt = (j: Float32Array, i: number): V3 => [j[i * 3], j[i * 3 + 1], j[i * 3 + 2]];

/** Pose, rotate, scale to laptop units, then place by an anchor or a surface contact. */
export const placeLaptop = (h: HandPose, rot: Rot, place: Place, mirror = false, breath = 0): Float32Array => {
  placeHand(h, rot, "wrist", ORIGIN, tmp, mirror, breath);
  const out = new Float32Array(JOINTS * 3);
  for (let i = 0; i < out.length; i++) out[i] = tmp[i] * UNIT;
  let a: V3;
  let target: V3 = place.at;
  if ("contact" in place) {
    const axis = place.contact === "y-" ? 1 : 0;
    const sign = place.contact === "x+" ? 1 : -1;
    let best = 0;
    for (let j = 1; j < JOINTS; j++) if (sign * out[j * 3 + axis] > sign * out[best * 3 + axis]) best = j;
    a = jointAt(out, best);
    const pad = place.pad ?? 0.5; // skin radius beyond the joint centre
    target = [...place.at] as V3;
    target[axis] -= sign * pad;
  } else if (place.anchor === "index") a = jointAt(out, J.I_TIP);
  else if (place.anchor === "wrist") a = jointAt(out, J.WRIST);
  else if (place.anchor === "pinch") {
    const i = jointAt(out, J.I_TIP), t = jointAt(out, J.T_TIP);
    a = [(i[0] + t[0]) / 2, (i[1] + t[1]) / 2, (i[2] + t[2]) / 2];
  } else {
    const w = jointAt(out, J.WRIST), m = jointAt(out, J.M_MCP);
    a = [(w[0] + m[0]) / 2, (w[1] + m[1]) / 2, (w[2] + m[2]) / 2];
  }
  for (let j = 0; j < JOINTS; j++) {
    out[j * 3] += target[0] - a[0];
    out[j * 3 + 1] += target[1] - a[1];
    out[j * 3 + 2] += target[2] - a[2];
  }
  return out;
};

const hotAt = (joints: number[], v: number) => {
  const h = new Float32Array(JOINTS);
  for (const j of joints) h[j] = v;
  return h;
};
const pulse = (f: number, at: number, decay = 7) => (f >= at ? Math.exp(-(f - at) / decay) : 0);

// screen/lid geometry for the cover and nudge gestures
const N_SCREEN: V3 = [0, 0.285, 0.958];
const lidPoint = (x: number, y: number, z: number, delta: number): V3 => {
  const a = -(LID_ANGLE + delta);
  return [x, 0.1 + y * Math.cos(a) - z * Math.sin(a), -10.6 + y * Math.sin(a) + z * Math.cos(a)];
};
export const lidDeltaAt = (f: number) => k(f, [[930, 0], [946, 0], [953, 0.075], [966, 0.075], [980, 0]]);

const TIP_ROT: Rot = { pitch: -0.5, yaw: -0.9, roll: -0.25 };

/** The film's hand, a function of the absolute frame. null when no hand is on screen. */
export const filmHand = (f: number): Solved | null => {
  const b = Math.sin(f * 0.21) * 0.015; // breath

  // 03 fingertip taps the left palm rest (left hand)
  if (f >= 270 && f < 390) {
    copyPose(POSES.fingertip, pose);
    const h = k(f, [[270, 7], [290, 2.4], [306, 2.4], [312, 0], [318, 0], [330, 2.4], [352, 2.4], [376, 7]]);
    const j = placeLaptop(pose, TIP_ROT, { contact: "y-", at: [-9.6, h, 6.4] }, true, b);
    return { joints: j, hot: hotAt([J.I_TIP, J.I_DIP], pulse(f, 312)), opacity: k(f, [[270, 0], [282, 1], [368, 1], [386, 0]]) };
  }
  // 04 knuckles knock the right speaker grille
  if (f >= 390 && f < 510) {
    copyPose(POSES.knuckle, pose);
    const d = k(f, [[390, 9], [405, 2.4], [414, 2.4], [419, 0], [423, 0], [433, 2.4], [455, 2.4], [463, 0], [467, 0], [478, 2.6], [498, 8]]);
    const j = placeLaptop(pose, { pitch: 0.1, yaw: -0.9, roll: -0.3 }, { contact: "y-", at: [13.75, d, -4.4] }, false, b);
    return { joints: j, hot: hotAt([J.I_PIP, J.M_PIP, J.R_PIP], Math.max(pulse(f, 419), pulse(f, 463))), opacity: k(f, [[390, 0], [400, 1], [492, 1], [508, 0]]) };
  }
  // 05 double tap on the right grille, then a fingertip slides along it
  if (f >= 510 && f < 630) {
    copyPose(POSES.fingertip, pose);
    const h = k(f, [[510, 6], [517, 2.2], [523, 2.2], [527, 0], [529, 0], [532, 1.1], [535, 0], [537, 0], [546, 2.2], [562, 2.2], [572, 0.05], [616, 0.05], [628, 3]]);
    const z = k(f, [[510, -4.4], [562, -4.4], [572, -8.2], [577, -8.2], [613, -0.8], [630, -0.8]]);
    const j = placeLaptop(pose, { ...TIP_ROT, pitch: -0.55 }, { contact: "y-", at: [13.75, h, z] }, false, b);
    const hot = Math.max(pulse(f, 527), pulse(f, 535), f >= 572 && f < 616 ? 0.8 : 0);
    return { joints: j, hot: hotAt([J.I_TIP], hot), opacity: k(f, [[510, 0], [516, 1], [620, 1], [630, 0]]) };
  }
  // 07b an open palm covers the light sensor
  if (f >= 870 && f < 930) {
    copyPose(POSES.open, pose);
    pose.spread = 1.1;
    const s = ZONES.sensor.p;
    const d = k(f, [[870, 10], [884, 1.3], [906, 1.3], [922, 9]]);
    const x = k(f, [[870, 7], [884, 0.4], [906, 0.4], [922, 6]]);
    const j = placeLaptop(pose, { pitch: 1.282, yaw: 0, roll: 0 }, { anchor: "palm", at: [s[0] + x, s[1] + N_SCREEN[1] * d - 1.2, s[2] + N_SCREEN[2] * d] }, false, b);
    return { joints: j, hot: hotAt([J.M_MCP, J.R_MCP, J.I_MCP], k(f, [[884, 0], [890, 0.7], [906, 0.7], [914, 0]])), opacity: k(f, [[870, 0], [878, 1], [916, 1], [928, 0]]) };
  }
  // 07c a fingertip nudges the lid back
  if (f >= 930 && f < 990) {
    copyPose(POSES.point, pose);
    const delta = lidDeltaAt(f);
    const c = lidPoint(0.8, -0.05, 20.9, delta);
    const gap = k(f, [[930, 7], [944, 1.4], [948, 0.4], [966, 0.4], [974, 2.2], [988, 7]]);
    const j = placeLaptop(pose, { pitch: 0.55, yaw: -0.25, roll: -0.2 }, { anchor: "index", at: [c[0] + 0.2, c[1] + N_SCREEN[1] * gap - 0.2, c[2] + N_SCREEN[2] * gap] }, false, b);
    return { joints: j, hot: hotAt([J.I_TIP], k(f, [[946, 0], [952, 1], [966, 1], [972, 0]])), opacity: k(f, [[930, 0], [938, 1], [980, 1], [989, 0]]) };
  }
  // 08 air: pinch and dial, release, then an open palm swipes left
  if (f >= 990 && f < 1140) {
    const pinch = k(f, [[990, 0], [1024, 0], [1032, 1], [1060, 1], [1068, 0]]);
    const swipe = k(f, [[990, 0], [1068, 0], [1076, 1], [1112, 1], [1126, 0]]);
    mixPose(POSES.relaxed, POSES.ready, k(f, [[990, 0], [1010, 1]]), pose);
    if (pinch > 0) mixPose(pose, POSES.pinch, pinch, pose);
    if (swipe > 0) mixPose(pose, POSES.open, swipe, pose);
    const dial = k(f, [[1036, 0], [1054, 1]]) * pinch;
    const enter = k(f, [[990, 1], [1012, 0]]);
    const sx = k(f, [[1076, 4], [1086, 4], [1100, -8], [1140, -9]]);
    const x = 1.5 + enter * 13 + swipe * (sx - 1.5);
    const y = 7.5 - 0.3 * pinch + 2.5 * k(f, [[1120, 0], [1140, 1]]);
    const rot: Rot = { pitch: -0.05 + swipe * 0.5, yaw: 0.3 - swipe * 0.45, roll: -1.1 + dial * 0.9 + swipe * (1.1 - dial * 0.9) };
    const j = placeLaptop(pose, rot, { anchor: swipe > 0.5 ? "palm" : "pinch", at: [x, y, -3.8] }, false, b);
    return { joints: j, hot: hotAt([J.I_TIP, J.T_TIP], pinch > 0.95 ? Math.max(0.5, pulse(f, 1032, 9)) : 0), opacity: k(f, [[990, 0], [1000, 1], [1128, 1], [1140, 0]]) };
  }
  // 09 a palm hovers over the right speaker: height is volume
  if (f >= 1140 && f < 1260) {
    copyPose(POSES.open, pose);
    mixPose(pose, POSES.relaxed, 0.3, pose);
    const h = volumeHeight(f);
    const j = placeLaptop(pose, { pitch: 0.05, yaw: 0.1, roll: 0.12 }, { anchor: "palm", at: [12.2, h, -4.4] }, false, b);
    return { joints: j, hot: new Float32Array(JOINTS), opacity: k(f, [[1140, 0], [1150, 1], [1248, 1], [1259, 0]]) };
  }
  // 12 one last tap on the right palm rest
  if (f >= 1640 && f < 1790) {
    copyPose(POSES.fingertip, pose);
    const h = k(f, [[1640, 8], [1664, 2.4], [1684, 2.4], [1692, 0], [1698, 0], [1712, 2.4], [1745, 2.4], [1772, 8]]);
    const j = placeLaptop(pose, TIP_ROT, { contact: "y-", at: [9.8, h, 6.2] }, false, b);
    return { joints: j, hot: hotAt([J.I_TIP, J.I_DIP], pulse(f, 1692)), opacity: k(f, [[1640, 0], [1654, 1], [1762, 1], [1780, 0]]) };
  }
  return null;
};

/** Palm height over the speaker, and the volume it maps to. */
export const volumeHeight = (f: number) => k(f, [[1140, 12], [1152, 7.5], [1168, 7.5], [1184, 4.4], [1204, 4.4], [1222, 8.8], [1242, 8.8], [1259, 12]]);
export const volumeAt = (f: number) => Math.round(Math.max(0, Math.min(100, ((9.5 - volumeHeight(f)) / 5.5) * 80 + 15)));

/** A hand frame with fingertip trails re-solved at earlier frames (half-frame steps). */
export const handFrame = (solve: (f: number) => Solved | null, f: number): HandFrame | null => {
  const now = solve(f);
  if (!now) return null;
  const trails: Float32Array[] = [now.joints];
  for (let i = 1; i < HAND_TRAIL; i++) trails.push(solve(f - i * 0.5)?.joints ?? trails[i - 1]);
  return { ...now, trails };
};

export const pinchPoint = (j: Float32Array): V3 => {
  const a = J.I_TIP * 3, b = J.T_TIP * 3;
  return [(j[a] + j[b]) / 2, (j[a + 1] + j[b + 1]) / 2, (j[a + 2] + j[b + 2]) / 2];
};
export const palmPoint = (j: Float32Array): V3 => {
  const b = J.M_MCP * 3;
  return [(j[0] + j[b]) / 2, (j[1] + j[b + 1]) / 2, (j[2] + j[b + 2]) / 2];
};
