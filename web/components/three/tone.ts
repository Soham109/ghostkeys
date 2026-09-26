import * as THREE from "three";

/**
 * The scene is tone mapped with ACES filmic in post, which crushes near-black. The page behind the canvas is a flat
 * #0A0A0B (or #F4F4F1), so the 3D background has to be the value that comes OUT of the tone mapper as exactly that
 * color. This inverts three's ACESFilmicToneMapping numerically (same matrices and fit as the shader chunk).
 */
export const EXPOSURE = 1.0;

const IN = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];
const mul = (m: number[][], v: number[]) => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);

export function aces(c: number[], exposure = EXPOSURE) {
  const x = mul(IN, c.map((v) => (v * exposure) / 0.6));
  return mul(OUT, x.map(fit)).map((v) => Math.min(1, Math.max(0, v)));
}

const cache = new Map<string, THREE.Color>();

/** Linear scene color that ACES maps to the given sRGB page color. */
export function sceneBg(hex: string, exposure = EXPOSURE): THREE.Color {
  const key = `${hex}|${exposure}`;
  const hit = cache.get(key);
  if (hit) return hit.clone();
  const target = new THREE.Color(hex); // linear
  const t = [target.r, target.g, target.b];
  let c = t.map((v) => Math.max(v, 1e-4) * 4);
  for (let i = 0; i < 60; i++) {
    const o = aces(c, exposure);
    c = c.map((v, k) => Math.max(1e-5, v * Math.pow((t[k] + 1e-6) / (o[k] + 1e-6), 0.7)));
  }
  const out = new THREE.Color(c[0], c[1], c[2]);
  cache.set(key, out);
  return out.clone();
}
