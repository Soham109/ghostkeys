import * as THREE from "three";
import { KB } from "@/lib/dims";

export function roundedRectShape(w: number, h: number, r: number) {
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
}

/**
 * A slab whose plan outline is a rounded rectangle, lying in the xz plane, occupying y in [y0, y0 + h].
 * Bevel softens the top and bottom edges like a machined chassis.
 */
export function slab(w: number, d: number, r: number, h: number, bevel: number, y0: number, curveSegments = 18) {
  const shape = roundedRectShape(w - bevel * 2, d - bevel * 2, Math.max(0.001, r - bevel));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.0005, h - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments,
  });
  // extrusion runs along +z; turn it so it runs along +y
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0 + bevel, 0);
  g.computeVertexNormals();
  return g;
}

/** A frame (outline with a hole), for the chassis walls seen when the top case lifts. */
export function frame(w: number, d: number, r: number, wall: number, h: number, y0: number) {
  const outer = roundedRectShape(w, d, r);
  const inner = roundedRectShape(w - wall * 2, d - wall * 2, Math.max(0.001, r - wall));
  outer.holes.push(inner as unknown as THREE.Path);
  const g = new THREE.ExtrudeGeometry(outer, { depth: h, bevelEnabled: false, curveSegments: 18 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/** Flat rounded rect in the xz plane, facing +y. */
export function flatRoundedRect(w: number, d: number, r: number, y: number) {
  const g = new THREE.ShapeGeometry(roundedRectShape(w, d, r), 12);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

export type KeySpec = { x: number; z: number; w: number; d: number; label: string; kind: "char" | "mod" | "fn" | "arrow" | "blank" };

/** ANSI Mac layout, six rows, laid into the keyboard rectangle. */
export function buildKeys(): KeySpec[] {
  const rows: { units: number[]; labels: string[]; kinds?: KeySpec["kind"][]; hScale: number }[] = [
    {
      units: [1.5, ...Array(12).fill(1), 1],
      labels: ["esc", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", ""],
      kinds: ["mod", ...Array(12).fill("fn"), "blank"],
      hScale: 0.72,
    },
    { units: [...Array(13).fill(1), 1.5], labels: ["~", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "delete"], hScale: 1 },
    { units: [1.5, ...Array(12).fill(1), 1.5], labels: ["tab", "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "[", "]", "\\"], hScale: 1 },
    { units: [1.75, ...Array(11).fill(1), 1.75], labels: ["caps lock", "A", "S", "D", "F", "G", "H", "J", "K", "L", ";", "'", "return"], hScale: 1 },
    { units: [2.25, ...Array(10).fill(1), 2.25], labels: ["shift", "Z", "X", "C", "V", "B", "N", "M", ",", ".", "/", "shift"], hScale: 1 },
    { units: [1, 1, 1.2, 1.3, 5.05, 1.3, 1.15, 1, 1, 1], labels: ["fn", "control", "option", "command", "", "command", "option", "◀", "▲▼", "▶"], hScale: 1 },
  ];
  const width = KB.x1 - KB.x0;
  const depth = KB.z1 - KB.z0;
  const totalH = rows.reduce((a, r) => a + r.hScale, 0);
  const pitchZ = depth / totalH;
  const gap = 0.024;
  const keys: KeySpec[] = [];
  let z = KB.z0;
  for (const row of rows) {
    const sum = row.units.reduce((a, b) => a + b, 0);
    const pitchX = width / sum;
    const rowD = row.hScale * pitchZ;
    let x = KB.x0;
    row.units.forEach((u, i) => {
      const label = row.labels[i] ?? "";
      const kw = u * pitchX;
      const kind: KeySpec["kind"] =
        row.kinds?.[i] ?? (label.length === 1 ? "char" : label === "" ? "blank" : /[◀▶▲]/.test(label) ? "arrow" : "mod");
      if (label === "▲▼") {
        const hd = (rowD - gap) / 2 - 0.004;
        keys.push({ x: x + kw / 2, z: z + gap / 2 + hd / 2, w: kw - gap, d: hd, label: "▲", kind: "arrow" });
        keys.push({ x: x + kw / 2, z: z + rowD - gap / 2 - hd / 2, w: kw - gap, d: hd, label: "▼", kind: "arrow" });
      } else if (kind === "arrow") {
        const hd = (rowD - gap) / 2 - 0.004;
        keys.push({ x: x + kw / 2, z: z + rowD - gap / 2 - hd / 2, w: kw - gap, d: hd, label, kind });
      } else {
        keys.push({ x: x + kw / 2, z: z + rowD / 2, w: kw - gap, d: rowD - gap, label, kind });
      }
      x += kw;
    });
    z += rowD;
  }
  return keys;
}

/** Key legends painted into one texture that spans the keyboard rectangle. */
export function legendTexture(keys: KeySpec[]) {
  const W = 2048;
  const H = Math.round((W * (KB.z1 - KB.z0)) / (KB.x1 - KB.x0));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#fff";
  const sx = W / (KB.x1 - KB.x0);
  const sz = H / (KB.z1 - KB.z0);
  const font = `-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif`;
  for (const k of keys) {
    const cx = (k.x - KB.x0) * sx;
    const cy = (k.z - KB.z0) * sz;
    const kw = k.w * sx;
    const kd = k.d * sz;
    if (k.kind === "char") {
      g.font = `400 ${Math.round(kd * 0.3)}px ${font}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(k.label, cx, cy + 1);
    } else if (k.kind === "fn" || k.kind === "arrow") {
      g.font = `400 ${Math.round(Math.min(kd * 0.36, 17))}px ${font}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(k.label, cx, cy + 1);
    } else if (k.kind === "mod") {
      g.font = `400 15px ${font}`;
      g.textBaseline = "alphabetic";
      const right = k.x > 0 && k.label !== "fn";
      g.textAlign = right ? "right" : "left";
      g.fillText(k.label, right ? cx + kw / 2 - 12 : cx - kw / 2 + 12, cy + kd / 2 - 12);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Fine, isotropic grain for aluminum roughness so highlights do not look plastic. */
export function grainTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = 172 + Math.floor(Math.random() * 30);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  // mipmapped and filtered: an unfiltered grain map sparkles when the laptop is small on screen
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
