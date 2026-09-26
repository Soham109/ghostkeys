import { GRILLE, KB, PAD, toNormX, toNormY } from "./dims";

export type Surface = "base" | "lid" | "edge-left" | "edge-right";

export type Zone = {
  id: string;
  name: string;
  surface: Surface;
  /** Normalized rect, same convention as docs/PROTOCOL.md. */
  rect: { x: number; y: number; w: number; h: number };
  color: string;
};

const nx = toNormX;
const ny = toNormY;

const palmY = ny(PAD.z0) + 0.005;
const palmH = 0.975 - palmY;
const grY = ny(GRILLE.z0);
const grH = ny(GRILLE.z1) - grY;

export const ZONES: Zone[] = [
  { id: "left-palm", name: "Left palm rest", surface: "base", rect: { x: 0.03, y: palmY, w: nx(PAD.x0) - 0.045, h: palmH }, color: "#7C5CFF" },
  { id: "right-palm", name: "Right palm rest", surface: "base", rect: { x: nx(PAD.x1) + 0.015, y: palmY, w: 0.97 - nx(PAD.x1) - 0.015, h: palmH }, color: "#4FD6FF" },
  { id: "left-grille", name: "Left speaker grille", surface: "base", rect: { x: nx(-GRILLE.outer) - 0.004, y: grY, w: nx(-GRILLE.inner) - nx(-GRILLE.outer) + 0.008, h: grH }, color: "#FF6FB5" },
  { id: "right-grille", name: "Right speaker grille", surface: "base", rect: { x: nx(GRILLE.inner) - 0.004, y: grY, w: nx(GRILLE.outer) - nx(GRILLE.inner) + 0.008, h: grH }, color: "#FF6FB5" },
  { id: "top-strip", name: "Strip above the keys", surface: "base", rect: { x: nx(KB.x0) + 0.02, y: 0.012, w: nx(KB.x1) - nx(KB.x0) - 0.04, h: ny(KB.z0) - 0.022 }, color: "#FFB547" },
  { id: "left-edge", name: "Left edge", surface: "edge-left", rect: { x: 0, y: 0.08, w: 1, h: 0.84 }, color: "#5CF2B8" },
  { id: "right-edge", name: "Right edge", surface: "edge-right", rect: { x: 0, y: 0.08, w: 1, h: 0.84 }, color: "#5CF2B8" },
  { id: "lid", name: "Back of the lid", surface: "lid", rect: { x: 0.12, y: 0.12, w: 0.76, h: 0.76 }, color: "#FFB547" },
];

export const zoneById = (id: string) => ZONES.find((z) => z.id === id)!;

export function zoneCenter(z: Zone) {
  return { x: z.rect.x + z.rect.w / 2, y: z.rect.y + z.rect.h / 2 };
}
