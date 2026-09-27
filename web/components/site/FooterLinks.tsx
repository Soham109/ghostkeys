import { LogoMark } from "./Logo";

/** One quiet row: mark on the left, three links, a single low-contrast legal line. */
export function FooterRow() {
  return (
    <div className="flex flex-col gap-4 border-t hairline pt-5 md:flex-row md:items-center md:justify-between">
      <a href="/" className="flex items-center gap-2.5 text-ink" aria-label="Ghostkeys home">
        <LogoMark size={16} />
        <span className="text-[14px] font-medium tracking-[-0.02em]">ghostkeys</span>
      </a>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3">
          {[
            ["/guide/", "Guide"],
            ["/pricing/", "Pricing"],
            ["/compatibility/", "Compatibility"],
            ["/privacy/", "Privacy"],
          ].map(([href, label]) => (
            <a key={href} href={href} className="label transition-colors hover:!text-ink">
              {label}
            </a>
          ))}
        </nav>
        <p className="label !text-ink-3 opacity-70">Not affiliated with Apple.</p>
      </div>
    </div>
  );
}
