/**
 * The landing page is one short film (about eight viewports) over a single fixed WebGL canvas:
 * hook, reveal, air (with a sound beat), apps, try, finale.
 *
 * Each chapter is a tall DOM section with sticky content; its smoothed scroll progress (0..1) is published on
 * `bus.chapters[id]` by components/site/Experience.tsx. The scene reads those values and never reads the DOM.
 * `screens` is the section height in viewport heights; the pinned stretch of a chapter is `screens - 1`.
 */
export type ChapterId = "intro" | "zones" | "air" | "layers" | "try" | "finale";

export const CHAPTER_ORDER: ChapterId[] = ["intro", "zones", "air", "layers", "try", "finale"];

export const CHAPTER_SCREENS: Record<ChapterId, number> = {
  intro: 1.25,
  zones: 2.0,
  air: 2.1,
  layers: 1.6,
  try: 1.2,
  finale: 1.1,
};

/** Air chapter: progress below this is the camera add-on (ghost hand); above it is the sound-mode beat. */
export const AIR_SOUND_SPLIT = 0.6;

/** Zones chapter: the order surfaces light up. */
export const ZONE_STEPS = ["Palm rests", "Speaker grilles", "Top strip", "Edges", "Lid"] as const;

/** Air beat (camera add-on): gestures the ghost hand performs, in order. */
export const AIR_STEPS = [
  { id: "pinch", caption: "Pinch to grab" },
  { id: "drag", caption: "Pinch and drag" },
  { id: "swipe", caption: "Palm swipe" },
  { id: "dial", caption: "Turn a dial" },
] as const;

/** Sound beat: what the microphone learns to tell apart. */
export const SOUND_STEPS = [
  { id: "knuckle", caption: "Knuckle or fingertip" },
  { id: "rub", caption: "Rub the grille" },
  { id: "wave", caption: "Wave a hand" },
] as const;

/** Apps chapter: per-app layers, then the Pro tools. */
export const LAYER_STEPS = [
  { id: "layers", caption: "Per-app layers" },
  { id: "excel", caption: "Excel formula tools" },
  { id: "macros", caption: "Macros, up to 50 steps" },
  { id: "composer", caption: "AI composer" },
] as const;

/** Which step of a list a progress value maps to. */
export const stepAt = (progress: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(progress * n)));
