"use client";

import { useEffect, useId, useRef, useState } from "react";
import { scroller } from "@/lib/scroll";
import { DOWNLOAD_URL } from "@/lib/site";

/**
 * "Buy Pro" (links to #get-pro) opens this sheet instead of a checkout that does not exist yet.
 * Everything is free during the beta, so the sheet says that plainly and hands over the real download.
 */
export function GetSheet() {
  const dialog = useRef<HTMLDialogElement>(null!);
  const id = useId();
  const [kind, setKind] = useState<"mac" | "pro">("mac");

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a[href^="#get-"]') as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      setKind(a.getAttribute("href") === "#get-pro" ? "pro" : "mac");
      dialog.current.showModal();
      // the page must not scroll behind the sheet: Lenis would keep taking wheel input
      scroller.lenis?.stop();
    };
    const d = dialog.current;
    const onClose = () => scroller.lenis?.start();
    d.addEventListener("close", onClose);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      d.removeEventListener("close", onClose);
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-t`}
      className="get-sheet m-auto w-[min(520px,calc(100vw-32px))] rounded-[14px] border border-[var(--glass-line)] bg-bg p-0 text-ink backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      onClick={(e) => e.target === dialog.current && dialog.current.close()}
    >
      <div className="p-8 md:p-10">
        <div className="flex items-start justify-between gap-6">
          <span className="label">{kind === "pro" ? "Ghostkeys Pro" : "Ghostkeys for Mac"}</span>
          <button onClick={() => dialog.current.close()} className="label -mt-1 hover:!text-ink" aria-label="Close">
            Close
          </button>
        </div>
        <h2 id={`${id}-t`} className="display mt-8 text-[44px] leading-[1.02] text-ink">
          Free during <em>the beta.</em>
        </h2>
        <p className="lede mt-5 max-w-[40ch] !text-[16px]">Everything, Pro included. Prices apply at launch.</p>
        <a href={DOWNLOAD_URL} target="_blank" rel="noopener" className="btn-ink mt-8 inline-flex h-10 px-5 text-[14px]">
          Download
        </a>
        <p className="mt-4 text-[13px] font-light text-ink-3">macOS 14 or later, Apple silicon.</p>
      </div>
    </dialog>
  );
}
