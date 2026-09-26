"use client";

import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import { StageScene } from "./StageScene";
import { useTheme } from "@/lib/theme";
import type { Tier } from "@/lib/device";

export default function StageCanvas({ tier, active, onCreated }: { tier: Tier; active: boolean; onCreated?: () => void }) {
  const theme = useTheme();
  const high = tier.tier >= 2 && !tier.mobile;
  const [dpr, setDpr] = useState(high ? 1.75 : 1.25);
  const particleSize = tier.reducedMotion ? 0 : tier.tier >= 3 ? 512 : tier.tier === 2 ? 256 : 128;
  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      dpr={dpr}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: "high-performance", preserveDrawingBuffer: false }}
      camera={{ fov: 30, near: 0.05, far: 120, position: [3.1, 2.3, 5] }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.NoToneMapping;
        onCreated?.();
      }}
      aria-hidden
    >
      <PerformanceMonitor
        bounds={() => [50, 58]}
        onDecline={() => setDpr((d) => Math.max(1, +(d - 0.25).toFixed(2)))}
        onIncline={() => setDpr((d) => Math.min(high ? 1.75 : 1.5, +(d + 0.25).toFixed(2)))}
        flipflops={4}
      >
        <StageScene theme={theme} quality={high ? "high" : "low"} particleSize={particleSize} reduced={tier.reducedMotion} />
      </PerformanceMonitor>
    </Canvas>
  );
}
