"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { bus } from "@/lib/stage";
import { AIR_SOUND_SPLIT } from "@/lib/chapters";
import { useTheme } from "@/lib/theme";

/**
 * Fallback for reduced motion, GPU tier 0 or no WebGL2: pre-rendered stills of the same film (public/stills/*.avif,
 * rendered from this scene), cross-faded by chapter. DOM only, no WebGL. Mount it where StageCanvas would go.
 */
const STILL: Record<string, string> = { intro: "intro", zones: "zones", layers: "layers", try: "try", finale: "intro" };
const NAMES = ["intro", "zones", "grille", "air", "sound", "layers", "try"];

export const STILL_ALT: Record<string, string> = {
  intro: "A silver MacBook, lid open, a ring of orange light spreading across the left palm rest where a finger tapped.",
  zones: "The laptop seen from above with its shell turned to glass: a tap on the palm rest travels to the motion sensor under the keyboard.",
  grille: "Close-up of the right speaker grille, outlined as a zone.",
  air: "A hand drawn in points of light pinches above the keyboard; the screen shows a window being grabbed.",
  sound: "A knuckle knock and a fingertip tap on the palm rest, and their different sound shapes on screen.",
  layers: "The laptop showing a spreadsheet, each zone labelled with a spreadsheet action.",
  try: "Top view of the laptop with every zone outlined, ready to be tapped.",
};

export default function StillStage({ className = "" }: { className?: string }) {
  const theme = useTheme();
  const refs = useRef<Record<string, HTMLImageElement | null>>({});
  useEffect(() => {
    let current = "";
    const tick = () => {
      const ch = bus.chapter as string;
      const name = ch === "air" ? ((bus.chapters.air ?? 0) < AIR_SOUND_SPLIT ? "air" : "sound") : STILL[ch] ?? "intro";
      if (name === current) return;
      current = name;
      for (const n of NAMES) {
        const el = refs.current[n];
        if (el) el.style.opacity = n === name ? "1" : "0";
      }
    };
    tick();
    gsap.ticker.add(tick);
    return () => gsap.ticker.remove(tick);
  }, []);
  return (
    <div className={className} style={{ position: "absolute", inset: 0, overflow: "hidden" }} aria-hidden={false}>
      {NAMES.map((n) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={n}
          ref={(el) => void (refs.current[n] = el)}
          src={`/stills/${n}-${theme}.avif`}
          alt={STILL_ALT[n]}
          loading={n === "intro" ? "eager" : "lazy"}
          decoding="async"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: n === "intro" ? 1 : 0, transition: "opacity 280ms cubic-bezier(0.2, 0, 0, 1)" }}
        />
      ))}
    </div>
  );
}
