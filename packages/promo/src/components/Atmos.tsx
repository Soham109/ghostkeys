import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C } from "../theme";

/** Film grain: SVG turbulence reseeded per frame, very low opacity (brief: 0.035). */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.05 }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen", opacity }}>
      <svg width="100%" height="100%">
        <filter id={`g${frame % 6}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={frame % 6} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#g${frame % 6})`} />
      </svg>
    </AbsoluteFill>
  );
};

/** Gradient used only as light: a soft ink falloff, never a fill. */
export const Light: React.FC<{ x?: string; y?: string; size?: number; strength?: number }> = ({
  x = "50%",
  y = "50%",
  size = 900,
  strength = 0.06,
}) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(${size}px ${size * 0.72}px at ${x} ${y}, rgba(237,237,239,${strength}) 0%, rgba(237,237,239,${
        strength * 0.35
      }) 38%, rgba(237,237,239,0) 72%)`,
    }}
  />
);

export const Bg: React.FC = () => <AbsoluteFill style={{ background: C.bg }} />;

/** Dark vignette so edges fall to pure void. */
export const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background: "radial-gradient(ellipse 75% 70% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)",
    }}
  />
);
