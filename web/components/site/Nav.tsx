"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { LogoMark } from "./Logo";
import { DOWNLOAD_URL } from "@/lib/site";
import { play } from "@/lib/sound";
import { setThemePref, useThemePref, type ThemePref } from "@/lib/theme";

const LINKS = [
  { href: "/guide/", label: "Guide" },
  { href: "/pricing/", label: "Pricing" },
  { href: "/faq/", label: "FAQ" },
];

/**
 * Floating, detached pill. As the page scrolls it converges: narrower, shorter, tighter, and the wordmark
 * folds into the mark. It hides on a fast scroll down and returns on any scroll up.
 * Everything is driven by GSAP on refs; no React state changes while scrolling.
 */
export function Nav() {
  const pill = useRef<HTMLDivElement>(null!);
  const word = useRef<HTMLSpanElement>(null!);
  const wrap = useRef<HTMLDivElement>(null!);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context(() => {
      // convergence, scrubbed over the first 420px with smoothing so it never snaps
      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: { start: 0, end: 420, scrub: reduced ? true : 0.8 },
      });
      tl.to(pill.current, { "--pad-x": "6px", "--pad-y": "5px", "--gap": "18px", duration: 1 }, 0)
        .to(word.current, { width: 0, opacity: 0, marginLeft: 0, duration: 0.6 }, 0);

      // hide on fast scroll down, return on scroll up
      const show = gsap.quickTo(wrap.current, "yPercent", { duration: 0.5, ease: "expo.out" });
      let hidden = false;
      ScrollTrigger.create({
        start: 0,
        end: "max",
        onUpdate: (self) => {
          const v = self.getVelocity();
          if (self.scroll() < 200) {
            if (hidden) show(0);
            hidden = false;
            return;
          }
          if (!hidden && self.direction === 1 && v > 2600) {
            hidden = true;
            show(-160);
          } else if (hidden && self.direction === -1) {
            hidden = false;
            show(0);
          }
        },
      });
    });
    return () => ctx.revert();
  }, []);

  return (
    <>
      <div ref={wrap} className="fixed inset-x-0 top-4 z-50 flex justify-center pointer-events-none md:top-5">
        <nav
          ref={pill}
          aria-label="Primary"
          className="nav-pill pointer-events-auto flex items-center"
          style={{ ["--pad-x" as string]: "10px", ["--pad-y" as string]: "8px", ["--gap" as string]: "28px", padding: "var(--pad-y) var(--pad-x)", gap: "var(--gap)" }}
        >
          <a href="/#top" className="flex items-center pl-1.5 text-ink" aria-label="Ghostkeys home">
            <LogoMark size={20} />
            <span ref={word} className="ml-2 inline-block overflow-hidden whitespace-nowrap text-[15px] font-medium tracking-[-0.02em]" style={{ width: 78 }}>
              ghostkeys
            </span>
          </a>
          <div className="hidden items-center gap-[inherit] sm:flex" style={{ gap: "var(--gap)" }}>
            {LINKS.map((l) => (
              <a key={l.href} href={l.href} className="text-[13px] text-ink-2 transition-colors duration-200 hover:text-ink" onMouseEnter={() => play("tick")}>
                {l.label}
              </a>
            ))}
          </div>
          <ThemeCycle />
          <a href={DOWNLOAD_URL} className="btn-ink h-8 px-4 text-[13px]">
            Download
          </a>
        </nav>
      </div>
    </>
  );
}

/** Phones and tablets: one tap cycles Auto, Light, Dark. Desktop has the full control in the corner and footer. */
function ThemeCycle() {
  const pref = useThemePref();
  const next: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };
  const name = pref === "system" ? "Auto" : pref === "light" ? "Light" : "Dark";
  return (
    <button
      onClick={() => setThemePref(next[pref])}
      className="label inline-flex items-center gap-1.5 hover:!text-ink lg:hidden"
      aria-label={`Theme: ${name}. Change theme`}
    >
      {/* a half-filled disc, so the word reads as a switch and not a caption */}
      <svg aria-hidden width="9" height="9" viewBox="0 0 10 10" className="shrink-0">
        <circle cx="5" cy="5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M5 0.75a4.25 4.25 0 0 1 0 8.5z" fill="currentColor" />
      </svg>
      {name}
    </button>
  );
}
