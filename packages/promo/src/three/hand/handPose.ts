import * as THREE from "three";

/**
 * A 21 joint hand, in the same order as Apple Vision's hand pose:
 * wrist, thumb (CMC, MCP, IP, tip), then index, middle, ring, little (MCP, PIP, DIP, tip).
 *
 * Scene units: 1 unit = 100 mm, so wrist to middle fingertip is about 1.85.
 * Palm frame (right hand): palm faces down (-y), fingers point to -z, thumb sits on the -x side.
 * A left hand is the same hand mirrored in x.
 */
export const JOINTS = 21;
export const J = {
  WRIST: 0,
  T_CMC: 1, T_MCP: 2, T_IP: 3, T_TIP: 4,
  I_MCP: 5, I_PIP: 6, I_DIP: 7, I_TIP: 8,
  M_MCP: 9, M_PIP: 10, M_DIP: 11, M_TIP: 12,
  R_MCP: 13, R_PIP: 14, R_DIP: 15, R_TIP: 16,
  L_MCP: 17, L_PIP: 18, L_DIP: 19, L_TIP: 20,
} as const;
export const TIPS = [J.T_TIP, J.I_TIP, J.M_TIP, J.R_TIP, J.L_TIP];

/** Bones as joint index pairs: finger chains, wrist to each knuckle, and the knuckle line across the palm. */
export const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

type Finger = { mcp: [number, number, number]; len: [number, number, number]; spread: number };
const FINGERS: Finger[] = [
  { mcp: [-0.33, 0.0, -0.86], len: [0.4, 0.235, 0.195], spread: 0.1 },
  { mcp: [-0.105, 0.015, -0.92], len: [0.45, 0.275, 0.205], spread: 0.0 },
  { mcp: [0.125, 0.0, -0.88], len: [0.42, 0.26, 0.2], spread: -0.085 },
  { mcp: [0.335, -0.03, -0.78], len: [0.335, 0.2, 0.18], spread: -0.2 },
];
const THUMB_CMC = new THREE.Vector3(-0.25, -0.07, -0.2);
const THUMB_LEN = 0.86;

export type HandPose = {
  /** flexion per finger (index, middle, ring, little), 0 straight to 1 fist */
  curl: [number, number, number, number];
  /** how far the fingers fan out, 1 = natural */
  spread: number;
  /** thumb tip target in the palm frame */
  thumb: THREE.Vector3;
  /** 0..1: thumb tip travels to the index tip (pinch) */
  pinch: number;
};

const pose = (curl: [number, number, number, number], spread: number, thumb: [number, number, number], pinch = 0): HandPose => ({
  curl,
  spread,
  thumb: new THREE.Vector3(...thumb),
  pinch,
});

export const POSES = {
  relaxed: pose([0.12, 0.15, 0.19, 0.24], 1.0, [-0.52, -0.2, -0.8]),
  open: pose([0.02, 0.02, 0.03, 0.05], 2.1, [-0.78, -0.02, -0.52]),
  pinch: pose([0.33, 0.32, 0.38, 0.44], 0.85, [-0.5, -0.22, -0.84], 1),
  /** pinch shape with the thumb still apart: the moment before a pinch */
  ready: pose([0.2, 0.24, 0.3, 0.36], 0.9, [-0.5, -0.22, -0.84]),
  point: pose([0.02, 0.95, 0.98, 1.0], 0.7, [-0.16, -0.24, -0.66]),
  knuckle: pose([1.0, 1.0, 1.0, 1.0], 0.35, [-0.1, -0.3, -0.62]),
  fingertip: pose([0.34, 0.8, 0.86, 0.9], 0.8, [-0.28, -0.26, -0.6]),
} as const;
export type PoseName = keyof typeof POSES;

export const makePose = (): HandPose => pose([0, 0, 0, 0], 1, [0, 0, 0]);

export function copyPose(src: HandPose, out: HandPose) {
  for (let i = 0; i < 4; i++) out.curl[i] = src.curl[i];
  out.spread = src.spread;
  out.thumb.copy(src.thumb);
  out.pinch = src.pinch;
  return out;
}

/** Blend two poses. Finger angles are linear in curl, so this is a per joint slerp of each hinge. */
export function mixPose(a: HandPose, b: HandPose, t: number, out: HandPose) {
  for (let i = 0; i < 4; i++) out.curl[i] = a.curl[i] + (b.curl[i] - a.curl[i]) * t;
  out.spread = a.spread + (b.spread - a.spread) * t;
  out.thumb.lerpVectors(a.thumb, b.thumb, t);
  out.pinch = a.pinch + (b.pinch - a.pinch) * t;
  return out;
}

const d0 = new THREE.Vector3();
const dir = new THREE.Vector3();
const p = new THREE.Vector3();
const tgt = new THREE.Vector3();
const mid = new THREE.Vector3();
const chord = new THREE.Vector3();
const out3 = new THREE.Vector3();
const ctrl = new THREE.Vector3();
const OUTWARD = new THREE.Vector3(-1, -0.55, 0.25).normalize();

function put(out: Float32Array, j: number, v: THREE.Vector3, mirror: boolean) {
  out[j * 3] = mirror ? -v.x : v.x;
  out[j * 3 + 1] = v.y;
  out[j * 3 + 2] = v.z;
}

/**
 * Forward kinematics into `out` (21 x 3 floats), palm frame. `breath` (tiny, radians) adds life to the curls.
 */
export function solveHand(h: HandPose, out: Float32Array, mirror = false, breath = 0) {
  p.set(0, 0, 0);
  put(out, J.WRIST, p, mirror);
  let ix = 0, iy = 0, iz = 0;
  for (let f = 0; f < 4; f++) {
    const F = FINGERS[f];
    const c = THREE.MathUtils.clamp(h.curl[f] + breath * (0.6 + f * 0.25), -0.08, 1.05);
    const s = F.spread * h.spread + (f === 0 ? 0.02 : 0);
    d0.set(-Math.sin(s), 0, -Math.cos(s));
    const base = 5 + f * 4;
    p.set(F.mcp[0], F.mcp[1], F.mcp[2]);
    put(out, base, p, mirror);
    // cumulative flexion toward the palm (-y); DIP follows PIP as in a real finger
    const a = [c * 1.3, c * 1.55, c * 0.95];
    let th = 0;
    for (let k = 0; k < 3; k++) {
      th += a[k];
      dir.copy(d0).multiplyScalar(Math.cos(th));
      dir.y -= Math.sin(th);
      p.addScaledVector(dir, F.len[k]);
      put(out, base + k + 1, p, mirror);
    }
    if (f === 0) [ix, iy, iz] = [p.x, p.y, p.z];
  }
  // thumb: a bent chain from the CMC to its target, bulging outward so its length stays plausible
  tgt.copy(h.thumb);
  if (h.pinch > 0) {
    // touch the index pad, a little below and to the thumb side of the tip
    out3.set(ix - 0.015, iy - 0.035, iz + 0.02);
    tgt.lerp(out3, h.pinch);
  }
  p.copy(THUMB_CMC);
  put(out, J.T_CMC, p, mirror);
  chord.subVectors(tgt, THUMB_CMC);
  const d = chord.length();
  mid.addVectors(tgt, THUMB_CMC).multiplyScalar(0.5);
  const hgt = Math.sqrt(Math.max(0, (THUMB_LEN / 2) ** 2 - (d / 2) ** 2));
  const n = chord.normalize();
  out3.copy(OUTWARD).addScaledVector(n, -OUTWARD.dot(n)).normalize();
  ctrl.copy(mid).addScaledVector(out3, hgt * 1.3);
  const bez = (t: number, v: THREE.Vector3) => {
    const u = 1 - t;
    v.set(0, 0, 0).addScaledVector(THUMB_CMC, u * u).addScaledVector(ctrl, 2 * u * t).addScaledVector(tgt, t * t);
    return v;
  };
  put(out, J.T_MCP, bez(0.42, p), mirror);
  put(out, J.T_IP, bez(0.73, p), mirror);
  put(out, J.T_TIP, bez(1, p), mirror);
  return out;
}

/* ---------- easing and keyframe tracks ---------- */

export const sineInOut = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
export const expoInOut = (t: number) =>
  t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
export const expoOut = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
/** 0..1 ramp of p between a and b, eased */
export const ramp = (p: number, a: number, b: number, ease = sineInOut) => ease(clamp01((p - a) / (b - a)));

/** Piecewise track through [position, value] keys with eased segments. Pure function of p. */
export function track(keys: readonly (readonly [number, number])[], p: number, ease = sineInOut) {
  if (p <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i];
    const [t1, v1] = keys[i + 1];
    if (p <= t1) return v0 + (v1 - v0) * ease((p - t0) / (t1 - t0 || 1));
  }
  return keys[keys.length - 1][1];
}

/* ---------- placing a posed hand in the world ---------- */

/** Global size of the ghost hand relative to a real adult hand (the laptop is to scale). */
export const HAND_SCALE = 0.8;

export type Anchor = "wrist" | "pinch" | "index" | "palm" | "lowest";

const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();

/**
 * Pose, rotate (pitch x, yaw y, roll z, radians, palm frame) and place the hand so that `anchor` lands on `at`.
 * For "lowest" the lowest joint sits at at.y, with its x and z moved to at.x and at.z.
 */
export function placeHand(
  h: HandPose,
  rot: { pitch: number; yaw: number; roll: number },
  anchor: Anchor,
  at: THREE.Vector3,
  out: Float32Array,
  mirror = false,
  breath = 0,
) {
  solveHand(h, out, mirror, breath);
  for (let i = 0; i < out.length; i++) out[i] *= HAND_SCALE;
  e.set(rot.pitch, mirror ? -rot.yaw : rot.yaw, mirror ? -rot.roll : rot.roll, "YXZ");
  q.setFromEuler(e);
  let ax = 0, ay = 0, az = 0;
  let low = Infinity, lowJ = 0;
  for (let j = 0; j < JOINTS; j++) {
    v.set(out[j * 3], out[j * 3 + 1], out[j * 3 + 2]).applyQuaternion(q);
    out[j * 3] = v.x;
    out[j * 3 + 1] = v.y;
    out[j * 3 + 2] = v.z;
    if (v.y < low) {
      low = v.y;
      lowJ = j;
    }
  }
  const J3 = (j: number) => [out[j * 3], out[j * 3 + 1], out[j * 3 + 2]] as const;
  if (anchor === "wrist") [ax, ay, az] = J3(0);
  else if (anchor === "index") [ax, ay, az] = J3(J.I_TIP);
  else if (anchor === "pinch") {
    const a = J3(J.I_TIP), b = J3(J.T_TIP);
    ax = (a[0] + b[0]) / 2; ay = (a[1] + b[1]) / 2; az = (a[2] + b[2]) / 2;
  } else if (anchor === "palm") {
    const a = J3(0), b = J3(J.M_MCP);
    ax = (a[0] + b[0]) / 2; ay = (a[1] + b[1]) / 2; az = (a[2] + b[2]) / 2;
  } else [ax, ay, az] = J3(lowJ);
  const dx = at.x - ax, dy = at.y - ay, dz = at.z - az;
  for (let j = 0; j < JOINTS; j++) {
    out[j * 3] += dx;
    out[j * 3 + 1] += dy;
    out[j * 3 + 2] += dz;
  }
  return out;
}
