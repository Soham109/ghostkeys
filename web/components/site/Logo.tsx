/** The mark from docs/design/logo.svg: a keycap, its ghost, and the touch point. */
export function LogoMark({ size = 22, signalDot = true, className }: { size?: number; signalDot?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 128 128" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={7} strokeLinejoin="round" className={className} aria-hidden>
      <rect x="36" y="28" width="64" height="64" rx="16" opacity="0.35" />
      <rect x="28" y="36" width="64" height="64" rx="16" />
      <circle cx="60" cy="68" r="8" fill={signalDot ? "var(--signal)" : "currentColor"} stroke="none" />
    </svg>
  );
}
