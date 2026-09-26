/**
 * 14-inch MacBook Pro, in scene units (1 unit = 100 mm).
 * Base: 312.6 x 221.2 mm. The deck (top surface of the base) sits at y = 0.
 * x runs left to right, z runs from the hinge (negative) to the front lip (positive).
 */
export const W = 3.126;
export const D = 2.212;
export const BASE_H = 0.095;
export const LID_T = 0.052;
export const PLAN_R = 0.12;

export const HINGE_Z = -D / 2 + 0.03;

export const KB = { x0: -1.34, x1: 1.34, z0: -0.985, z1: 0.085 };
export const PAD = { x0: -0.76, x1: 0.76, z0: 0.175, z1: 1.03 };
export const GRILLE = { inner: 1.372, outer: 1.5, z0: -0.985, z1: 0.085 };

/** Protocol coordinates: x 0..1 left to right, y 0..1 hinge to front lip. */
export const toWorldX = (x: number) => x * W - W / 2;
export const toWorldZ = (y: number) => y * D - D / 2;
export const toNormX = (x: number) => (x + W / 2) / W;
export const toNormY = (z: number) => (z + D / 2) / D;
