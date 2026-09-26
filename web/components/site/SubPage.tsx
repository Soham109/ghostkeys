import type { ReactNode } from "react";
import { Nav } from "./Nav";
import { SmoothScroll } from "./SmoothScroll";
import { SubFooter } from "./SubFooter";

/** Shared frame for the short pages: floating nav, one big title, content, quiet footer. No canvas. */
export function SubPage({ label, title, lede, children }: { label: string; title: ReactNode; lede?: string; children: ReactNode }) {
  return (
    <>
      <SmoothScroll />
      <Nav />
      <main className="page-x relative pt-[24svh] pb-[14svh]">
        <span className="label">{label}</span>
        <h1 className="display mt-8 max-w-[12ch] text-[length:var(--t-line)] text-ink">{title}</h1>
        {lede && <p className="lede mt-8 max-w-[44ch]">{lede}</p>}
        {children}
      </main>
      <SubFooter />
    </>
  );
}
