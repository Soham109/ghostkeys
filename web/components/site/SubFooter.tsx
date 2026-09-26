"use client";

import { DOWNLOAD_URL } from "@/lib/site";
import { LogoMark } from "./Logo";
import { Toggles } from "./Toggles";
import { FooterLinks } from "./FooterLinks";

export function SubFooter() {
  return (
    <footer className="page-x pb-8">
      <div className="flex flex-col gap-6 border-t hairline pt-6 md:flex-row md:items-center md:justify-between">
        <a href="/" className="flex items-center gap-2.5 text-ink">
          <LogoMark size={16} />
          <span className="text-[14px] font-medium tracking-[-0.02em]">ghostkeys</span>
        </a>
        <FooterLinks />
        <div className="flex items-center gap-8">
          <Toggles inline />
          <a href={DOWNLOAD_URL} className="btn-ink h-9 px-4 text-[13px]">
            Download
          </a>
        </div>
      </div>
      <p className="label mt-4 !text-ink-3">© 2026 Ghostkeys. Mac and MacBook are trademarks of Apple Inc. Ghostkeys is not affiliated with Apple.</p>
    </footer>
  );
}
