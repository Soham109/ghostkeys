"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { scroller, scrollToHash } from "@/lib/scroll";

gsap.registerPlugin(ScrollTrigger, SplitText);

/** One RAF loop for everything: Lenis is driven from gsap.ticker, and ScrollTrigger updates from Lenis. */
export function SmoothScroll() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || new URLSearchParams(location.search).has("reduced");
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href")!;
      // same-page anchors, written either as "#id" or "/#id" while on the home page
      const hash = href.startsWith("#") ? href : href.startsWith("/#") && location.pathname === "/" ? href.slice(1) : null;
      if (!hash || hash.length < 2) return;
      e.preventDefault();
      scrollToHash(hash);
      history.replaceState(null, "", hash);
    };
    document.addEventListener("click", onClick);
    // test hook for the screenshot and performance scripts
    (window as unknown as { __gkScroll: (y: number) => void }).__gkScroll = (y: number) => {
      if (scroller.lenis) scroller.lenis.scrollTo(y, { immediate: true, force: true });
      else window.scrollTo(0, y);
    };
    if (reduced) return () => document.removeEventListener("click", onClick);
    const lenis = new Lenis({ lerp: 0.08, smoothWheel: true, syncTouch: false, autoRaf: false });
    scroller.lenis = lenis;
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    // an initial hash (for example /#pricing from the details page) lands after layout settles
    if (location.hash.length > 1) {
      const h = location.hash;
      window.setTimeout(() => scrollToHash(h), 400);
    }
    return () => {
      document.removeEventListener("click", onClick);
      gsap.ticker.remove(tick);
      lenis.destroy();
      scroller.lenis = null;
    };
  }, []);
  return null;
}
