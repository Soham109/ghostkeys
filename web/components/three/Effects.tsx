"use client";

import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, ChromaticAberration, DepthOfField, EffectComposer, Noise, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing";
import { BlendFunction, Effect, ToneMappingMode, type DepthOfFieldEffect } from "postprocessing";
import { NOISE_GLSL } from "./glsl";
import type { Theme } from "@/lib/theme";

const dissolveFrag = /* glsl */ `
${NOISE_GLSL}
uniform float uProgress;
uniform vec3 uBg;
uniform float uAspect;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uProgress <= 0.0) { outputColor = inputColor; return; }
  float n = fbm(uv * vec2(uAspect, 1.0) * 3.2);
  float t = uProgress * 1.2 - 0.1;
  float keep = smoothstep(t - 0.08, t + 0.08, n);
  outputColor = vec4(mix(uBg, inputColor.rgb, keep), inputColor.a);
}
`;

/** Noise-threshold dissolve from the scene into the page background, scrubbed by scroll. */
export class DissolveEffect extends Effect {
  constructor() {
    super("DissolveEffect", dissolveFrag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ["uProgress", new THREE.Uniform(0)],
        ["uBg", new THREE.Uniform(new THREE.Color("#0a0a0b"))],
        ["uAspect", new THREE.Uniform(1)],
      ]),
    });
  }
}

export type FxControl = {
  dissolve: number;
  aberration: number;
  /** world point the lens focuses on (depth of field racks to it); null keeps everything sharp */
  focus?: THREE.Vector3 | null;
  /** 0..1 how shallow the depth of field is */
  bokeh?: number;
  /** 0..1 extra vignette for quiet chapters */
  hush?: number;
};

/**
 * Post chain, in order: depth of field (high tier) -> bloom that only catches values above 1 (the signal accent is
 * the only thing authored that bright) -> ACES filmic tone mapping (see tone.ts for the background match) -> dissolve -> SMAA on the display-referred image ->
 * grain -> vignette.
 */
export function Effects({ theme, quality, fx }: { theme: Theme; quality: "high" | "low"; fx: FxControl }) {
  const dissolve = useMemo(() => new DissolveEffect(), []);
  const offset = useMemo(() => new THREE.Vector2(0.0, 0.0), []);
  const dof = useRef<DepthOfFieldEffect>(null);
  const camera = useThree((s) => s.camera);
  const focusTarget = useMemo(() => new THREE.Vector3(), []);
  const dark = theme === "dark";
  useFrame((s, dt) => {
    dissolve.uniforms.get("uProgress")!.value = fx.dissolve;
    (dissolve.uniforms.get("uBg")!.value as THREE.Color).set(dark ? "#0a0a0b" : "#f4f4f1");
    dissolve.uniforms.get("uAspect")!.value = s.size.width / s.size.height;
    const a = fx.aberration * 0.0012;
    offset.set(a, a * 0.6);
    const d = dof.current;
    if (d) {
      const k = 1 - Math.exp(-dt * 6);
      if (fx.focus) {
        focusTarget.lerp(fx.focus, k);
        d.target = focusTarget;
      }
      const dist = camera.position.distanceTo(focusTarget);
      const b = fx.bokeh ?? 0;
      // range scales with distance so a macro shot is shallow and a wide shot stays crisp
      d.cocMaterial.focusRange = THREE.MathUtils.lerp(dist * 0.9, dist * 0.22, b);
      d.bokehScale = THREE.MathUtils.lerp(d.bokehScale, 1.2 + b * 2.4, k);
      // additive light (particles, rings, the hand) writes no depth, so the lens would treat it as far background and
      // smear it; the lens is only engaged in shots where the subject fills the frame
      const op = d.blendMode.opacity;
      op.value = THREE.MathUtils.lerp(op.value, b > 0.05 ? 1 : 0, k);
    }
  });
  if (quality === "low") {
    return (
      // phones and low tiers: real multisampling on the scene buffer, SMAA after tone mapping for what is left
      <EffectComposer multisampling={4} stencilBuffer={false}>
        <Bloom mipmapBlur intensity={dark ? 0.9 : 0.4} luminanceThreshold={dark ? 1.0 : 6} luminanceSmoothing={0.25} radius={0.62} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <primitive object={dissolve} />
        <SMAA />
        <Noise opacity={dark ? 0.03 : 0.022} premultiply blendFunction={BlendFunction.SCREEN} />
      </EffectComposer>
    );
  }
  return (
    <EffectComposer multisampling={0} stencilBuffer={false}>
      <DepthOfField ref={dof} focusDistance={6} focusRange={4} bokehScale={1.2} resolutionScale={0.5} />
      <Bloom mipmapBlur intensity={dark ? 1.0 : 0.45} luminanceThreshold={dark ? 1.0 : 6} luminanceSmoothing={0.25} radius={0.66} levels={7} />
      <ChromaticAberration offset={offset} radialModulation modulationOffset={0.4} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <primitive object={dissolve} />
      <SMAA />
      <Noise opacity={dark ? 0.035 : 0.025} premultiply blendFunction={BlendFunction.SCREEN} />
      <Vignette offset={0.38} darkness={dark ? 0.42 : 0.16} />
    </EffectComposer>
  );
}
