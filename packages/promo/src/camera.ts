import * as THREE from "three";
import { interpolate } from "remotion";
import type { Cam } from "./three/World";
import type { V3 } from "./timeline";
import { easeInOut } from "./theme";

export const orbit = (target: V3, r: number, azDeg: number, elDeg: number): V3 => {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return [target[0] + r * Math.sin(az) * Math.cos(el), target[1] + r * Math.sin(el), target[2] + r * Math.cos(az) * Math.cos(el)];
};

const l = (a: number, b: number, t: number) => a + (b - a) * t;
const l3 = (a: V3, b: V3, t: number): V3 => [l(a[0], b[0], t), l(a[1], b[1], t), l(a[2], b[2], t)];

export const mixCam = (a: Cam, b: Cam, t: number): Cam => ({
  pos: l3(a.pos, b.pos, t),
  target: l3(a.target, b.target, t),
  fov: l(a.fov, b.fov, t),
  focus: a.focus && b.focus ? l3(a.focus, b.focus, t) : b.focus ?? a.focus,
  bokeh: l(a.bokeh, b.bokeh, t),
  roll: l(a.roll ?? 0, b.roll ?? 0, t),
});

/** A shot: camera moves from `a` to `b` across [start, end) with an easing. */
export const shot = (frame: number, start: number, end: number, a: Cam, b: Cam, ease = easeInOut) =>
  mixCam(a, b, interpolate(frame, [start, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }));

/** Orbit shot with interpolated spherical params (keeps a true arc, not a straight line). */
export const orbitShot = (
  frame: number,
  start: number,
  end: number,
  a: { target: V3; r: number; az: number; el: number; fov: number; bokeh?: number; focus?: V3 },
  b: { target: V3; r: number; az: number; el: number; fov: number; bokeh?: number; focus?: V3 },
  ease = easeInOut
): Cam => {
  const t = interpolate(frame, [start, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const target = l3(a.target, b.target, t);
  return {
    pos: orbit(target, l(a.r, b.r, t), l(a.az, b.az, t), l(a.el, b.el, t)),
    target,
    fov: l(a.fov, b.fov, t),
    bokeh: l(a.bokeh ?? 0, b.bokeh ?? 0, t),
    focus: a.focus && b.focus ? l3(a.focus, b.focus, t) : b.focus ?? a.focus ?? target,
  };
};

/** Project a world point with the same camera the 3D scene uses, for 2D labels. */
const _cam = new THREE.PerspectiveCamera();
const _v = new THREE.Vector3();
export const project = (cam: Cam, width: number, height: number, p: V3) => {
  _cam.fov = cam.fov;
  _cam.aspect = width / height;
  _cam.near = 0.5;
  _cam.far = 400;
  _cam.position.set(...cam.pos);
  _cam.up.set(0, 1, 0);
  _cam.lookAt(...cam.target);
  if (cam.roll) _cam.rotateZ(cam.roll);
  _cam.updateProjectionMatrix();
  _cam.updateMatrixWorld();
  _v.set(...p).project(_cam);
  return { x: ((_v.x + 1) / 2) * width, y: ((1 - _v.y) / 2) * height, visible: _v.z < 1 && _v.z > -1 };
};
