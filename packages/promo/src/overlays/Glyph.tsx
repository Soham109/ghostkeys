import React from "react";

/** Neutral app glyphs (no trademarks): grid, wave, brackets, globe. */
export const Glyph: React.FC<{ kind: "grid" | "wave" | "brackets" | "globe"; size?: number; color: string }> = ({ kind, size = 36, color }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    {kind === "grid" && (
      <>
        <rect x={4} y={4} width={24} height={24} rx={3} />
        <path d="M4 12h24M4 20h24M13 4v24M21 4v24" />
      </>
    )}
    {kind === "wave" && <path d="M3 16c3-9 5-9 7 0s4 9 6 0 4-9 6 0 4 9 7 0" />}
    {kind === "brackets" && <path d="M11 6l-7 10 7 10M21 6l7 10-7 10M18 5l-4 22" />}
    {kind === "globe" && (
      <>
        <circle cx={16} cy={16} r={12} />
        <ellipse cx={16} cy={16} rx={5} ry={12} />
        <path d="M4 16h24" />
      </>
    )}
  </svg>
);
