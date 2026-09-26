import * as THREE from "three";

// Procedural MacBook dimensions (cm-ish units). Deck top is y = 0.
export const BODY = { w: 30.4, h: 1.1, d: 21.2, r: 0.45 };
export const LID = { w: 30.4, t: 0.42, d: 21.0 };
export const KB = { x0: -12.6, x1: 12.6, z0: -9.0, z1: 0.2 };
export const PAD = { w: 13.2, d: 8.3, z: 5.95 };
export const GRILLE = { cols: 5, rows: 34, pitch: 0.27, x: 13.75, z0: -8.9, z1: 0.1 };

type KeyRect = { x: number; z: number; w: number; d: number };

// Keyboard rows (relative widths), normalised to the keyboard width.
const ROWS: Array<{ widths: number[]; h: number }> = [
  { widths: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], h: 0.55 },
  { widths: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5], h: 1 },
  { widths: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], h: 1 },
  { widths: [1.8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.7], h: 1 },
  { widths: [2.3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.3], h: 1 },
  { widths: [1, 1, 1, 1.25, 5.2, 1.25, 1, 1, 1, 1], h: 1 },
];

export const keyRects = (): KeyRect[] => {
  const gap = 0.24;
  const W = KB.x1 - KB.x0;
  const totalH = ROWS.reduce((a, r) => a + r.h, 0);
  const unitD = (KB.z1 - KB.z0 - gap * (ROWS.length - 1)) / totalH;
  const out: KeyRect[] = [];
  let z = KB.z0;
  for (const row of ROWS) {
    const sum = row.widths.reduce((a, b) => a + b, 0);
    const unitW = (W - gap * (row.widths.length - 1)) / sum;
    let x = KB.x0;
    const d = row.h * unitD;
    row.widths.forEach((wu, i) => {
      const w = wu * unitW;
      // arrow cluster: last three keys of bottom row are half height; keep simple
      out.push({ x: x + w / 2, z: z + d / 2, w, d });
      x += w + gap;
      void i;
    });
    z += d + gap;
  }
  return out;
};

export const grilleHoles = (): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (const side of [-1, 1]) {
    for (let r = 0; r < GRILLE.rows; r++) {
      for (let c = 0; c < GRILLE.cols; c++) {
        const x = side * GRILLE.x + (c - (GRILLE.cols - 1) / 2) * GRILLE.pitch + (r % 2 ? GRILLE.pitch / 2 : 0) * 0;
        const z = GRILLE.z0 + (r / (GRILLE.rows - 1)) * (GRILLE.z1 - GRILLE.z0);
        out.push([x, z]);
      }
    }
  }
  return out;
};

export const roundedRectShape = (w: number, h: number, r: number) => {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
};
