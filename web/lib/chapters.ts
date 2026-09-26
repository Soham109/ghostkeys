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
  zones: 2.6,
  air: 2.6,
  layers: 2.2,
  try: 1.3,
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
] as const;

/** Sound beat: what the microphone learns to tell apart. */
export const SOUND_STEPS = [
  { id: "knuckle", caption: "Knuckle or fingertip" },
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

/**
 * Scroll positions (in pixels) where each beat sits at rest, for snapping: the middle of every step of every chapter.
 * Reads the DOM, so call it after layout.
 */
export function beatPositions(steps: Partial<Record<ChapterId, { from: number; to: number; n: number }[]>>) {
  const out: number[] = [0];
  const vh = window.innerHeight;
  for (const id of CHAPTER_ORDER) {
    const el = document.querySelector<HTMLElement>(`[data-chapter="${id}"]`);
    if (!el || id === "intro") continue;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const pin = Math.max(0, el.offsetHeight - vh);
    const beats = steps[id] ?? [{ from: 0, to: 1, n: 1 }];
    for (const b of beats) for (let i = 0; i < b.n; i++) out.push(Math.round(top + pin * (b.from + (b.to - b.from) * ((i + 0.55) / b.n))));
  }
  out.push(document.documentElement.scrollHeight - vh);
  return out;
}
