"use client";
import type Lenis from "lenis";

/** The page's Lenis instance, if smooth scroll is on. */
export const scroller: { lenis: Lenis | null } = { lenis: null };

export function scrollToHash(hash: string) {
  const el = document.querySelector(hash) as HTMLElement | null;
  if (!el) return;
  if (scroller.lenis) scroller.lenis.scrollTo(el, { offset: 0, duration: 1.6 });
  else el.scrollIntoView({ behavior: "smooth" });
}
