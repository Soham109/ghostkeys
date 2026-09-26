"use client";

import "@/lib/three-console";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { SplitText } from "gsap/SplitText";
import { useTier } from "@/lib/device";
import { bus } from "@/lib/stage";
import { AIR_SOUND_SPLIT, AIR_STEPS, CHAPTER_SCREENS, LAYER_STEPS, SOUND_STEPS, ZONE_STEPS, stepAt, type ChapterId } from "@/lib/chapters";
import { DOWNLOAD_URL } from "@/lib/site";
import { PRICING } from "@/lib/pricing";
import { TryPanel } from "./TryPanel";
import { LogoMark } from "./Logo";
import { Toggles } from "./Toggles";
import { FooterLinks } from "./FooterLinks";

const StageCanvas = dynamic(() => import("../three/StageCanvas"), { ssr: false });
const StillStage = dynamic(() => import("../three/Stills"), { ssr: false });

/** Legacy rig position for each chapter's progress, so the current scene keeps its choreography. */
const LEGACY_MAP: Record<ChapterId, [number, number]> = {
  intro: [0, 0.5],
  zones: [2.8, 5.3],
  air: [7.12, 7.12],
  layers: [7.15, 8.75],
  try: [7.12, 7.12],
  finale: [7.12, 7.12],
};

type Beat = {
  line: ReactNode;
  /** small mono line under the headline */
  tag?: string;
  /** step captions shown bottom right, spread across the beat */
  steps?: readonly string[];
  /** portion of the chapter this beat owns */
  from: number;
  to: number;
};

type ChapterDef = { id: ChapterId; anchor?: string; place: "tl" | "bl"; beats: Beat[] };

const CHAPTERS: ChapterDef[] = [
  {
    id: "zones",
    anchor: "how",
    place: "tl",
    beats: [{ line: <>Every blank surface is a <em>key.</em></>, steps: ZONE_STEPS, from: 0, to: 1 }],
  },
  {
    id: "air",
    place: "tl",
    beats: [
      { line: <>Gesture in the <em>air.</em></>, tag: "Camera add-on / M4 and M5 / Beta", steps: AIR_STEPS.map((s) => s.caption), from: 0, to: AIR_SOUND_SPLIT },
      { line: <>Listen <em>closer.</em></>, tag: "Sound mode / Opt-in / On-device", steps: SOUND_STEPS.map((s) => s.caption), from: AIR_SOUND_SPLIT, to: 1 },
    ],
  },
  {
    id: "layers",
    place: "bl",
    beats: [{ line: <>Your apps, your <em>layers.</em></>, steps: LAYER_STEPS.map((s) => s.caption), from: 0, to: 1 }],
  },
];

export function Experience() {
  const tier = useTier();
  const [active, setActive] = useState(true);
  const webgl = tier.ready && tier.tier > 0 && !tier.reducedMotion;
  const stills = tier.ready && !webgl;

  useEffect(() => {
    const onVis = () => {
      bus.active = document.visibilityState === "visible";
      setActive(bus.active);
    };
    document.addEventListener("visibilitychange", onVis);
    const onPointer = (e: PointerEvent) => {
      bus.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      bus.pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onPointer);
    };
  }, []);

  // publish smoothed chapter progress, page progress and velocity; derive the legacy rig position
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>("[data-chapter]").forEach((el) => {
        const id = el.dataset.chapter as ChapterId;
        const proxy = { p: 0 };
        bus.chapters[id] = 0;
        gsap.to(proxy, {
          p: 1,
          ease: "none",
          scrollTrigger: {
            trigger: el,
            start: "top top",
            end: "bottom bottom",
            scrub: 1,
            onToggle: (self) => {
              if (self.isActive) bus.chapter = id;
            },
          },
          onUpdate: () => {
            bus.chapters[id] = proxy.p;
            if (bus.chapter === id) {
              const [a, b] = LEGACY_MAP[id];
              bus.pos = a + (b - a) * proxy.p;
            }
          },
        });
      });
      const page = { p: 0 };
      gsap.to(page, {
        p: 1,
        ease: "none",
        scrollTrigger: {
          start: 0,
          end: "max",
          scrub: 1,
          onUpdate: (self) => {
            const v = self.getVelocity() / window.innerHeight;
            bus.velocity += (v - bus.velocity) * 0.2;
          },
        },
        onUpdate: () => void (bus.page = page.p),
      });
    });
    const settle = () => void (bus.velocity *= 0.92);
    gsap.ticker.add(settle);
    return () => {
      gsap.ticker.remove(settle);
      ctx.revert();
    };
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-0" aria-hidden>
        {webgl && <StageCanvas tier={tier} active={active} />}
        {stills && <StillStage />}
      </div>
      <FadingToggles />
      <main className="relative z-10">
        <Intro />
        {CHAPTERS.map((c, i) => (
          <Chapter key={c.id} def={c} index={i + 2} />
        ))}
        <TryPanel />
        <Finale />
      </main>
    </>
  );
}

/** Sound and theme sit in the top corners during the hook, then step aside for the film. */
function FadingToggles() {
  const ref = useRef<HTMLDivElement>(null!);
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.to(ref.current, { autoAlpha: 0, ease: "none", scrollTrigger: { start: 0, end: () => window.innerHeight * 0.3, scrub: true } });
    });
    return () => ctx.revert();
  }, []);
  return (
    <div ref={ref} className="pointer-events-none fixed inset-x-0 top-0 z-40 hidden px-[var(--page-x)] pt-8 lg:block">
      <Toggles />
    </div>
  );
}

function useSplitLines(el: HTMLElement | null, cb: (lines: HTMLElement[], line: HTMLElement) => void, deps: unknown[] = []) {
  useEffect(() => {
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || new URLSearchParams(location.search).has("reduced");
    let alive = true;
    let ctx: gsap.Context | null = null;
    const splits: SplitText[] = [];
    document.fonts.ready.then(() => {
      if (!alive || reduced) return;
      ctx = gsap.context(() => {
        el.querySelectorAll<HTMLElement>("[data-line]").forEach((line) => {
          const s = SplitText.create(line, { type: "lines", mask: "lines", linesClass: "split-line" });
          splits.push(s);
          cb(s.lines as HTMLElement[], line);
        });
      }, el);
    });
    return () => {
      alive = false;
      ctx?.revert();
      splits.forEach((s) => s.revert());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, ...deps]);
}

function Intro() {
  const ref = useRef<HTMLElement>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(ref.current), []);
  useEffect(() => {
    if (!el) return;
    document.fonts.ready.then(() => gsap.set(el.querySelectorAll("[data-intro]"), { visibility: "visible" }));
  }, [el]);
  useSplitLines(el, (lines, line) => {
    const tl = gsap.timeline({ delay: 0.35 });
    tl.from(lines, { yPercent: 118, duration: 1.5, stagger: 0.1, ease: "expo.out" })
      .from(line.querySelectorAll("em"), { filter: "blur(10px)", duration: 1.3, ease: "expo.out" }, 0.15)
      .from(el!.querySelectorAll("[data-fade]"), { autoAlpha: 0, y: 10, duration: 1.2, stagger: 0.1, ease: "expo.out" }, 0.7);
    gsap.to(lines, { yPercent: -118, stagger: 0.04, ease: "power2.in", scrollTrigger: { trigger: el, start: "top top", end: "70% top", scrub: 1 } });
    gsap.to(el!.querySelectorAll("[data-fade]"), { autoAlpha: 0, ease: "none", scrollTrigger: { trigger: el, start: "5% top", end: "40% top", scrub: 1 } });
  });
  return (
    <section id="top" ref={ref} data-chapter="intro" aria-label="Ghostkeys" style={{ height: `calc(100svh * ${CHAPTER_SCREENS.intro})` }} className="relative">
      <div className="pointer-events-none sticky top-0 h-[100svh]">
        <div className="page-x absolute inset-x-0 bottom-[13svh]">
          <div className="scrim invisible" data-intro data-fade aria-hidden />
          <h1 data-line data-intro className="display invisible max-w-[9ch] text-[length:var(--t-hero)] text-ink">
            Your laptop has <em>more</em> buttons.
          </h1>
          <div data-intro data-fade className="invisible pointer-events-auto mt-10 flex items-center gap-8">
            <a href={DOWNLOAD_URL} className="btn-ink h-11 px-6 text-[14px]">
              Download for Mac
            </a>
            <span className="label">Free to start</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Chapter({ def, index }: { def: ChapterDef; index: number }) {
  const ref = useRef<HTMLElement>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const capRef = useRef<HTMLSpanElement>(null);
  const tagRef = useRef<HTMLParagraphElement>(null);
  const reducedRef = useRef(false);
  useEffect(() => {
    setEl(ref.current);
    reducedRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches || new URLSearchParams(location.search).has("reduced");
  }, []);

  // each beat's lines rise out of their masks inside the chapter's scrubbed range, then rise away
  useSplitLines(el, (lines, line) => {
    const b = def.beats[Number(line.dataset.beat)];
    const span = b.to - b.from;
    const enter = b.from + Math.min(0.04, span * 0.06);
    const exit = b.to === 1 ? 0.86 : b.to - span * 0.14;
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: { trigger: el, start: "top top", end: "bottom bottom", scrub: 1 } });
    tl.fromTo(lines, { yPercent: 118 }, { yPercent: 0, stagger: 0.03, duration: Math.min(0.16, span * 0.25), ease: "power3.out" }, enter)
      .to(lines, { yPercent: -118, stagger: 0.02, duration: Math.min(0.12, span * 0.18), ease: "power2.in" }, exit)
      .set({}, {}, 1);
    const em = line.querySelectorAll("em");
    if (em.length) tl.fromTo(em, { filter: "blur(8px)" }, { filter: "blur(0px)", duration: Math.min(0.14, span * 0.2) }, enter + 0.03);
  });

  // captions and tags follow progress, written straight to the DOM (no React state while scrolling)
  useEffect(() => {
    let lastKey = "";
    const tick = () => {
      const p = bus.chapters[def.id] ?? 0;
      const beat = def.beats.find((b) => p >= b.from && p < b.to) ?? def.beats[def.beats.length - 1];
      const local = (p - beat.from) / (beat.to - beat.from);
      const steps = beat.steps ?? [];
      const i = steps.length ? stepAt(local, steps.length) : 0;
      const key = `${def.beats.indexOf(beat)}:${i}`;
      if (key !== lastKey) {
        lastKey = key;
        if (capRef.current) capRef.current.textContent = steps.length ? `${String(i + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}   ${steps[i]}` : "";
        if (tagRef.current) tagRef.current.textContent = beat.tag ?? "";
      }
      if (reducedRef.current)
        el?.querySelectorAll<HTMLElement>("[data-beat]").forEach((h) => (h.style.opacity = Number(h.dataset.beat) === def.beats.indexOf(beat) ? "1" : "0"));
      const o = String(Math.max(0, Math.min(1, Math.min(p * 12 - 0.3, (1 - p) * 10))));
      el?.querySelectorAll<HTMLElement>("[data-chrome]").forEach((c) => (c.style.opacity = o));
    };
    gsap.ticker.add(tick);
    return () => gsap.ticker.remove(tick);
  }, [def, el]);

  const pos = def.place === "tl" ? "top-[17svh]" : "bottom-[15svh]";
  return (
    <section ref={ref} id={def.anchor} data-chapter={def.id} style={{ height: `calc(100svh * ${CHAPTER_SCREENS[def.id]})` }} className="relative">
      <div className="pointer-events-none sticky top-0 h-[100svh]">
        <div className={`page-x absolute inset-x-0 ${pos}`}>
          <div className="scrim" data-chrome aria-hidden style={{ opacity: 0 }} />
          <div className="grid">
            {def.beats.map((b, k) => (
              <h2 key={k} data-line data-beat={k} className="display col-start-1 row-start-1 max-w-[9.5ch] text-[length:var(--t-line)] text-ink">
                {b.line}
              </h2>
            ))}
          </div>
          <p ref={tagRef} data-chrome className="label mt-8 opacity-0" />
        </div>
        <div data-chrome className="page-x absolute inset-x-0 bottom-8 flex items-end justify-between opacity-0">
          <span className="label tabular-nums">{String(index).padStart(2, "0")}</span>
          <span ref={capRef} className="label whitespace-pre text-right !text-ink" />
        </div>
      </div>
    </section>
  );
}

function Finale() {
  const ref = useRef<HTMLElement>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(ref.current), []);
  useSplitLines(el, (lines) => {
    const tl = gsap.timeline({ scrollTrigger: { trigger: el, start: "top 75%", end: "top top", scrub: 1 } });
    tl.fromTo(lines, { yPercent: 118 }, { yPercent: 0, stagger: 0.08, ease: "power3.out" }).fromTo(
      el!.querySelectorAll("[data-fade]"),
      { autoAlpha: 0, y: 12 },
      { autoAlpha: 1, y: 0, stagger: 0.05 },
      0.35,
    );
  });
  const pro = PRICING.tiers.find((t) => t.id === "pro");
  return (
    <section ref={ref} data-chapter="finale" aria-label="Get Ghostkeys" style={{ height: `calc(100svh * ${CHAPTER_SCREENS.finale})` }} className="relative">
      <div className="pointer-events-none sticky top-0 flex h-[100svh] flex-col justify-between">
        <div className="page-x relative pt-[19svh]">
          <div className="scrim" data-fade aria-hidden />
          <h2 data-line className="display max-w-[9ch] text-[length:var(--t-line)] text-ink">
            The <em>blank</em> space is the interface.
          </h2>
          <div data-fade className="pointer-events-auto mt-12 flex flex-wrap items-center gap-x-8 gap-y-4">
            <a href={DOWNLOAD_URL} className="btn-ink h-12 px-7 text-[15px]">
              Download for Mac
            </a>
            {pro?.launchPrice && (
              <a href="/pricing/" className="quiet-link text-[15px]">
                Pro is ${pro.launchPrice} at launch
              </a>
            )}
          </div>
          <p data-fade className="label mt-10">
            On-device / Nothing recorded / No admin rights / Open-source core
          </p>
        </div>
        <footer data-fade className="page-x pointer-events-auto bg-bg pb-7">
          <div className="flex flex-col gap-5 border-t hairline pt-5 md:flex-row md:items-center md:justify-between">
            <span className="flex items-center gap-2.5 text-ink">
              <LogoMark size={16} />
              <span className="text-[14px] font-medium tracking-[-0.02em]">ghostkeys</span>
            </span>
            <FooterLinks />
            <Toggles inline />
          </div>
          <p className="label mt-4 !text-ink-3">Mac and MacBook are trademarks of Apple Inc. Ghostkeys is not affiliated with Apple.</p>
        </footer>
      </div>
    </section>
  );
}
