"use client";

import { useEffect, useId, useRef, useState } from "react";
import { scroller } from "@/lib/scroll";

const KEY = "gk-mac-waitlist";

/**
 * Until the notarized .dmg and checkout exist, "Download for Mac" and "Buy Pro" (links to #get-mac / #get-pro)
 * open this sheet instead of looping to /pricing/. There is no backend: the address stays in this browser only,
 * so the copy promises nothing (no "we'll email you", no "you're on the list").
 */
export function GetSheet() {
  const dialog = useRef<HTMLDialogElement>(null!);
  const id = useId();
  const [kind, setKind] = useState<"mac" | "pro">("mac");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "saved" | "invalid">("idle");

  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v) {
        setEmail(JSON.parse(v).email ?? "");
        setStatus("saved");
      }
    } catch {}
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setStatus("invalid");
    try {
      localStorage.setItem(KEY, JSON.stringify({ email: email.trim(), want: kind, at: new Date().toISOString() }));
    } catch {}
    setStatus("saved");
  };

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
          Almost <em>ready.</em>
        </h2>
        <p className="lede mt-5 max-w-[40ch] !text-[16px]">
          The Mac download is not out yet.{kind === "pro" ? " Pro opens with it, at $19 for the first 14 days." : ""}
        </p>
        <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-3 sm:flex-row">
          <label htmlFor={`${id}-e`} className="sr-only">
            Email
          </label>
          <input
            id={`${id}-e`}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (status !== "idle") setStatus("idle");
            }}
            aria-invalid={status === "invalid"}
            className="input-line flex-1"
          />
          <button type="submit" className="btn-ink h-10 px-5 text-[14px]">
            Save
          </button>
        </form>
        <p role="status" className="mt-4 min-h-[20px] text-[13px] font-light" style={{ color: status === "invalid" ? "var(--signal)" : "var(--ink-3)" }}>
          {status === "saved" && "Saved in this browser only. Nothing was sent."}
          {status === "invalid" && "Enter a full email address, like you@example.com."}
          {status === "idle" && "Kept in this browser only. Nothing is sent."}
        </p>
      </div>
    </dialog>
  );
}
