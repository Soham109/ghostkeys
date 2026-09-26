"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { SplitText } from "gsap/SplitText";
import { bus, type FiredGesture } from "@/lib/stage";
import { CHAPTER_SCREENS } from "@/lib/chapters";
import { D, KB, PAD, W, toNormX, toNormY } from "@/lib/dims";
import type { Zone } from "@/lib/zones";
import { play } from "@/lib/sound";

const kbN = { x0: toNormX(KB.x0), x1: toNormX(KB.x1), y0: toNormY(KB.z0), y1: toNormY(KB.z1) };
const padN = { x0: toNormX(PAD.x0), x1: toNormX(PAD.x1), y0: toNormY(PAD.z0), y1: toNormY(PAD.z1) };
const G_LABEL = { tap: "Tap", double: "Double tap", triple: "Triple tap" } as const;

/**
 * The interactive chapter: the visitor taps the laptop in the persistent scene.
 * The scene resolves clicks into gestures and reports them through bus.fire; this panel only shows the result
 * and lets the visitor draw a zone on a tiny map.
 */
export function TryPanel() {
  const ref = useRef<HTMLElement>(null!);
  const readout = useRef<HTMLParagraphElement>(null!);

  useEffect(
    () =>
      bus.onFire((g: FiredGesture) => {
        const el = readout.current;
        if (!el) return;
        if (g.zone === "keyboard") el.textContent = "That is the keyboard. Try the metal.";
        else if (g.zone === "trackpad") el.textContent = "That is the trackpad. Try beside it.";
        else el.textContent = `${g.zoneName} / ${G_LABEL[g.gesture]} / ${g.action ?? "Nothing bound"}`;
        gsap.fromTo(el, { opacity: 0.2, y: 4 }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" });
      }),
    [],
  );

  useEffect(() => {
    const el = ref.current;
    let split: SplitText | null = null;
    let ctx: gsap.Context | null = null;
    let alive = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.fonts.ready.then(() => {
      if (!alive || reduced) return;
      ctx = gsap.context(() => {
        const line = el.querySelector("[data-line]") as HTMLElement;
        split = SplitText.create(line, { type: "lines", mask: "lines", linesClass: "split-line" });
        const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: { trigger: el, start: "top top", end: "bottom bottom", scrub: 1 } });
        tl.fromTo(split.lines, { yPercent: 115 }, { yPercent: 0, stagger: 0.05, duration: 0.15, ease: "power3.out" }, 0.02)
          .fromTo(el.querySelectorAll("[data-fade]"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.1 }, 0.1)
          .to(split.lines, { yPercent: -115, duration: 0.12, ease: "power2.in" }, 0.88)
          .to(el.querySelectorAll("[data-fade]"), { autoAlpha: 0, duration: 0.08 }, 0.88)
          .set({}, {}, 1);
      }, el);
    });
    return () => {
      alive = false;
      ctx?.revert();
      split?.revert();
    };
  }, []);

  return (
    <section ref={ref} id="try" data-chapter="try" aria-label="Try it" style={{ height: `calc(100svh * ${CHAPTER_SCREENS.try})` }} className="relative">
      <div className="sticky top-0 h-[100svh] pointer-events-none">
        <div className="page-x absolute inset-x-0 top-[17svh]">
          <div className="scrim" aria-hidden />
          <h2 data-line className="display max-w-[10ch] text-[length:var(--t-line)] text-ink">
            Go on. Tap <em>it.</em>
          </h2>
          <div data-fade className="mt-12 hidden md:block">
            <ZoneMap />
          </div>
        </div>
        <div data-fade className="page-x absolute inset-x-0 bottom-8 flex items-end justify-between gap-8">
          <span className="label tabular-nums">05</span>
          <p ref={readout} aria-live="polite" className="label !text-ink max-w-[46ch] text-right">
            Click a palm rest. Twice, quickly.
          </p>
        </div>
      </div>
    </section>
  );
}

function ZoneMap() {
  const svg = useRef<SVGSVGElement>(null!);
  const [zones, setZones] = useState<Zone[]>([]);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [msg, setMsg] = useState("Draw a zone");
  const VW = 1000;
  const VH = Math.round((1000 * D) / W);
  const toN = (e: React.PointerEvent) => {
    const r = svg.current.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const commit = (next: Zone[]) => {
    setZones(next);
    bus.demo.customZones = next;
  };
  const finish = () => {
    if (!drag) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    if (w < 0.05 || h < 0.05) return setMsg("Drag a larger area");
    const hits = (a: { x0: number; x1: number; y0: number; y1: number }) => x < a.x1 && x + w > a.x0 && y < a.y1 && y + h > a.y0;
    if (hits(kbN) || hits(padN)) return setMsg("Blank metal only");
    const n = zones.length >= 3 ? 1 : zones.length + 1;
    const z: Zone = { id: `custom-${Date.now()}`, name: `Zone ${n}`, surface: "base", rect: { x, y, w, h }, color: "#ffffff" };
    bus.demo.bindings[z.id] = { tap: "Screenshot", double: "Show desktop" };
    commit([...zones.slice(zones.length >= 3 ? 1 : 0), z]);
    setMsg(`Zone ${n} added. Tap it.`);
    play("tick");
  };
  return (
    <div className="pointer-events-auto flex w-[220px] shrink-0 flex-col gap-2">
      <svg
        ref={svg}
        viewBox={`0 0 ${VW} ${VH}`}
        className="w-full cursor-crosshair touch-none select-none"
        role="img"
        aria-label="Top view of the laptop. Drag to draw a zone."
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const p = toN(e);
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onPointerMove={(e) => drag && setDrag({ ...drag, x1: toN(e).x, y1: toN(e).y })}
        onPointerUp={finish}
      >
        <rect x="2" y="2" width={VW - 4} height={VH - 4} rx="44" fill="none" stroke="var(--ink-2)" strokeWidth="7" />
        <rect x={kbN.x0 * VW} y={kbN.y0 * VH} width={(kbN.x1 - kbN.x0) * VW} height={(kbN.y1 - kbN.y0) * VH} rx="10" fill="var(--hairline)" stroke="none" />
        <rect x={padN.x0 * VW} y={padN.y0 * VH} width={(padN.x1 - padN.x0) * VW} height={(padN.y1 - padN.y0) * VH} rx="16" fill="none" stroke="var(--ink-3)" strokeWidth="6" />
        {zones.map((z) => (
          <rect key={z.id} x={z.rect.x * VW} y={z.rect.y * VH} width={z.rect.w * VW} height={z.rect.h * VH} rx="8" fill="color-mix(in oklab, var(--signal) 22%, transparent)" stroke="var(--signal)" strokeWidth="7" />
        ))}
        {drag && (
          <rect
            x={Math.min(drag.x0, drag.x1) * VW}
            y={Math.min(drag.y0, drag.y1) * VH}
            width={Math.abs(drag.x1 - drag.x0) * VW}
            height={Math.abs(drag.y1 - drag.y0) * VH}
            fill="none"
            stroke="var(--ink)"
            strokeWidth="6"
            strokeDasharray="18 12"
          />
        )}
      </svg>
      <div className="flex w-full items-center justify-between">
        <span className="label" role="status">
          {msg}
        </span>
        {zones.length > 0 && (
          <button
            className="label hover:!text-ink"
            onClick={() => {
              commit([]);
              setMsg("Draw a zone");
            }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
