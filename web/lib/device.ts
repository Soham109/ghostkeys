"use client";
import { useEffect, useState } from "react";
import { getGPUTier } from "detect-gpu";

export type Tier = {
  /** 0 = no usable WebGL, 1 = light scene, 2 = full scene, 3 = full scene + dense particles */
  tier: 0 | 1 | 2 | 3;
  mobile: boolean;
  reducedMotion: boolean;
  ready: boolean;
};

let cached: Tier | null = null;

function hasWebGL2() {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

export function useReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setR(mq.matches || new URLSearchParams(location.search).has("reduced"));
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return r;
}

export function useTier(): Tier {
  const [t, setT] = useState<Tier>(cached ?? { tier: 2, mobile: false, reducedMotion: false, ready: false });
  useEffect(() => {
    if (cached) return;
    let alive = true;
    (async () => {
      const params = new URLSearchParams(location.search);
      const reducedMotion =
        window.matchMedia("(prefers-reduced-motion: reduce)").matches || params.has("reduced");
      const narrow = window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;
      let tier: Tier["tier"] = 2;
      let mobile = narrow;
      if (!hasWebGL2()) tier = 0;
      else {
        try {
          // Benchmarks are self-hosted in /public so nothing leaves the page.
          const g = await getGPUTier({ benchmarksURL: "/gpu-benchmarks" });
          mobile = mobile || !!g.isMobile;
          tier = (Math.max(1, g.tier) as Tier["tier"]);
          if (g.type === "BLOCKLISTED" || g.type === "WEBGL_UNSUPPORTED") tier = 0;
        } catch {
          tier = 2;
        }
      }
      const forced = params.get("tier");
      if (forced) tier = Number(forced) as Tier["tier"];
      if (mobile && tier > 1) tier = 1;
      cached = { tier, mobile, reducedMotion, ready: true };
      if (alive) setT(cached);
    })();
    return () => {
      alive = false;
    };
  }, []);
  return t;
}
