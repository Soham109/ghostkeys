import type { ChapterId } from "./chapters";
import type { Zone } from "./zones";

/**
 * Shared mutable bus between the DOM (scroll, pointer, UI) and the WebGL scene.
 * Written by components/site, read by components/three inside useFrame. Never read it during React render.
 */

export type FiredGesture = { zone: string; zoneName: string; gesture: "tap" | "double" | "triple"; count: number; action: string | null };

type Listener<T> = (v: T) => void;

export const bus = {
  /**
   * Legacy story timeline position (0..11) for the current StageScene rig.
   * Derived from chapter progress in Experience.tsx; see LEGACY_MAP there.
   */
  pos: 0,
  /** smoothed scroll progress per chapter, 0 before it, 1 after it */
  chapters: {} as Partial<Record<ChapterId, number>>,
  /** the chapter that currently fills most of the viewport */
  chapter: "intro" as ChapterId,
  /** whole-page smoothed progress 0..1 */
  page: 0,
  /** scroll velocity in screens per second (signed), smoothed */
  velocity: 0,
  /** true once particles have handed over to the solid laptop and the lid is open */
  introDone: false,
  /** 0..1 fraction of the particle intro's preload that is done (the scene sets it) */
  loaded: 0,
  /** pointer in -1..1 */
  pointer: { x: 0, y: 0 },
  /** canvas should render (tab visible, not fully covered by DOM) */
  active: true,
  /** sound hook: the scene calls it; lib/sound.ts assigns it */
  cue: (_name: "tap" | "swell" | "tick") => {},

  /** the interactive "try" chapter */
  demo: {
    /** zones the visitor drew in the mini map (base surface, protocol coordinates) */
    customZones: [] as Zone[],
    /** bindings per zone id and gesture */
    bindings: {} as Record<string, Partial<Record<"tap" | "double" | "triple", string>>>,
  },

  _fired: new Set<Listener<FiredGesture>>(),
  /** the scene calls this when a click gesture resolves in the try chapter */
  fire(g: FiredGesture) {
    this._fired.forEach((l) => l(g));
  },
  onFire(l: Listener<FiredGesture>) {
    this._fired.add(l);
    return () => void this._fired.delete(l);
  },
};

export const ZONE_SHORT: Record<string, string> = {
  "left-palm": "Left palm",
  "right-palm": "Right palm",
  "left-grille": "Left grille",
  "right-grille": "Right grille",
  "top-strip": "Top strip",
  "left-edge": "Left edge",
  "right-edge": "Right edge",
  lid: "Lid",
};

export const DEFAULT_BINDINGS: Record<string, Partial<Record<"tap" | "double" | "triple", string>>> = {
  "left-palm": { tap: "Play or pause", double: "Next track", triple: "Previous track" },
  "right-palm": { tap: "Paste", double: "Paste values", triple: "Undo" },
  "left-grille": { tap: "Volume down", double: "Mute" },
  "right-grille": { tap: "Volume up", double: "Mute" },
  "top-strip": { tap: "Mission Control", double: "Show desktop" },
  "left-edge": { tap: "Previous desktop" },
  "right-edge": { tap: "Next desktop" },
  lid: { tap: "Lock screen", double: "Do not disturb" },
};
bus.demo.bindings = { ...DEFAULT_BINDINGS };
