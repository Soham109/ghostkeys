"use client";

import { useEffect, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import gsap from "gsap";
import { StageScene } from "./StageScene";
import StillStage from "./Stills";
import { EXPOSURE } from "./tone";
import { useTheme } from "@/lib/theme";
import { bus } from "@/lib/stage";
import type { Tier } from "@/lib/device";

/**
 * One render loop for the whole page: the canvas does not run its own requestAnimationFrame. gsap.ticker already
 * drives Lenis and ScrollTrigger, so the scene renders in the same tick, right after scroll values are updated.
 */
function TickerLoop({ active }: { active: boolean }) {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    if (!active) return;
    // R3F's manual advance takes the timestamp in the clock's unit; seconds keeps useFrame's delta in seconds
    const tick = () => advance(performance.now() / 1000);
    gsap.ticker.add(tick);
    return () => gsap.ticker.remove(tick);
  }, [active, advance]);
  return null;
}

export default function StageCanvas({ tier, active, onCreated }: { tier: Tier; active: boolean; onCreated?: () => void }) {
  const theme = useTheme();
  // test hook: ?debug exposes the shared bus (read-only use in Playwright checks)
  useEffect(() => {
    if (new URLSearchParams(location.search).has("debug")) (window as unknown as { __gkBus: typeof bus }).__gkBus = bus;
  }, []);
  const high = tier.tier >= 2 && !tier.mobile;
  // phones get at least 1.5x so thin metal edges do not stair-step (MSAA covers the rest, see Effects)
  const cap = high ? 1.75 : 1.5;
  const [dpr, setDpr] = useState(Math.min(cap, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
  // about 131k particles on capable GPUs, 65k on mid, 16k on low; none when motion is reduced
  const particleSize = tier.reducedMotion ? 0 : tier.tier >= 3 ? 362 : tier.tier === 2 ? 256 : 128;
  // reduced motion: no WebGL at all, the pre-rendered stills of the same film
  if (tier.reducedMotion) return <StillStage />;
  return (
    <Canvas
      frameloop="never"
      dpr={dpr}
      gl={{ antialias: false, alpha: false, stencil: false, depth: true, powerPreference: "high-performance", preserveDrawingBuffer: false }}
      camera={{ fov: 30, near: 0.05, far: 120, position: [3.55, 2.45, 6.1] }}
      onCreated={({ gl }) => {
        // tone mapping happens once, in post (ACES); the renderer writes linear HDR into the composer
        gl.toneMapping = THREE.NoToneMapping;
        gl.toneMappingExposure = EXPOSURE;
        onCreated?.();
      }}
      aria-hidden
    >
      <TickerLoop active={active} />
      {/* Resolution only ever steps down, at most twice, after sustained slowness: every change resizes the canvas,
          and a resize bouncing up and down mid-scroll reads as flicker. */}
      <PerformanceMonitor
        bounds={() => [44, 200]}
        ms={400}
        iterations={6}
        onDecline={() => setDpr((d) => Math.max(high ? 1.25 : 1.25, +(d - 0.25).toFixed(2)))}
        flipflops={2}
      >
        <StageScene theme={theme} quality={high ? "high" : "low"} particleSize={particleSize} reduced={tier.reducedMotion} />
      </PerformanceMonitor>
    </Canvas>
  );
}
