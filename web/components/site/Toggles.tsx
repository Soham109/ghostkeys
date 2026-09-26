"use client";

import { setThemePref, useThemePref, type ThemePref } from "@/lib/theme";
import { setSound, useSound } from "@/lib/sound";

/** Sound (off by default) and theme (Auto, Light, Dark) as small mono text. */
export function Toggles({ inline = false }: { inline?: boolean }) {
  const on = useSound();
  const pref = useThemePref();
  const opts: ThemePref[] = ["system", "light", "dark"];
  return (
    <div className={inline ? "flex items-center gap-8" : "flex items-start justify-between"}>
      <button onClick={() => setSound(!on)} aria-pressed={on} className="label pointer-events-auto inline-flex items-center gap-2 transition-colors hover:!text-ink">
        <span aria-hidden className="inline-block size-[5px] rounded-full" style={{ background: on ? "var(--signal)" : "var(--ink-3)" }} />
        Sound {on ? "on" : "off"}
      </button>
      <div role="radiogroup" aria-label="Color theme" className="pointer-events-auto flex gap-4">
        {opts.map((o) => (
          <button key={o} role="radio" aria-checked={pref === o} onClick={() => setThemePref(o)} className={`label transition-colors ${pref === o ? "!text-ink" : "hover:!text-ink"}`}>
            {o === "system" ? "Auto" : o}
          </button>
        ))}
      </div>
    </div>
  );
}
