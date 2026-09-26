import * as THREE from "three";

/**
 * Where DOM labels over the canvas may sit. The site's copy lives in the left column (headlines top left or bottom
 * left) and step captions sit bottom right, so labels stay in the right part of the frame, clear of the top nav and
 * the caption row. On narrow screens the copy spans the width, so labels are not shown at all.
 */
export function safeArea(w: number, h: number) {
  const narrow = w < 768;
  return {
    narrow,
    x0: narrow ? 16 : Math.max(16, w * 0.44),
    x1: w - 16,
    y0: Math.max(88, h * 0.14),
    y1: h - Math.max(96, h * 0.16),
  };
}

const v = new THREE.Vector3();

/** Screen position of an object's origin in CSS pixels, or null when it is behind the camera. */
export function project(obj: THREE.Object3D, camera: THREE.Camera, w: number, h: number): [number, number] | null {
  v.setFromMatrixPosition(obj.matrixWorld).project(camera);
  if (v.z > 1 || v.z < -1) return null;
  return [(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h];
}

let cache: { t: number; rects: DOMRect[] } = { t: -1, rects: [] };

/** On-screen boxes of the site's headlines (cached briefly; reading layout every frame for every label is wasteful). */
export function copyRects(): DOMRect[] {
  const now = performance.now();
  if (now - cache.t < 120) return cache.rects;
  const rects: DOMRect[] = [];
  document.querySelectorAll("h1, h2, [data-caption]").forEach((el) => {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.bottom > 0 && b.top < window.innerHeight && getComputedStyle(el).visibility !== "hidden") rects.push(b);
  });
  cache = { t: now, rects };
  return rects;
}

/** True when a box (CSS pixels, with a margin) touches any headline. */
export function hitsCopy(x0: number, y0: number, x1: number, y1: number, pad = 12) {
  return copyRects().some((b) => x0 - pad < b.right && x1 + pad > b.left && y0 - pad < b.bottom && y1 + pad > b.top);
}
