import React from "react";
import { C } from "../theme";

/** The mark from docs/design/logo.svg, with the touch dot optionally in --signal. */
export const LogoMark: React.FC<{ size?: number; color?: string; dotColor?: string; ghostOpacity?: number }> = ({
  size = 128,
  color = C.ink,
  dotColor,
  ghostOpacity = 0.35,
}) => (
  <svg viewBox="0 0 128 128" width={size} height={size} fill="none" stroke={color} strokeWidth={6} strokeLinejoin="round">
    <rect x={36} y={28} width={64} height={64} rx={16} opacity={ghostOpacity} />
    <rect x={28} y={36} width={64} height={64} rx={16} />
    <circle cx={60} cy={68} r={7} fill={dotColor ?? color} stroke="none" />
  </svg>
);
