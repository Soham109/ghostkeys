"use client";

import { useEffect, useId, useState } from "react";

const KEY = "gk-waitlist";

/**
 * Windows waitlist. There is no backend yet: the address is kept in this browser's localStorage only,
 * and the copy says so.
 */
export function Waitlist({ compact = false }: { compact?: boolean }) {
  const id = useId();
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
  }, []);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setStatus("invalid");
      return;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify({ email: email.trim(), at: new Date().toISOString() }));
    } catch {}
    setStatus("saved");
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" noValidate aria-describedby={`${id}-msg`}>
      <label htmlFor={`${id}-email`} className="label">
        {compact ? "Windows waitlist" : "Your email"}
      </label>
      <div className="flex gap-2">
        <input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status !== "idle") setStatus("idle");
          }}
          className="input-line w-full max-w-[300px]"
          aria-invalid={status === "invalid"}
        />
        <button type="submit" className="btn-ink h-10 shrink-0 px-5 text-[14px]">
          Join the waitlist
        </button>
      </div>
      <p id={`${id}-msg`} role="status" className="min-h-[20px] text-[13px] font-light" style={{ color: status === "invalid" ? "var(--signal)" : "var(--ink-3)" }}>
        {status === "saved" && "Saved in this browser only. Nothing was sent."}
        {status === "invalid" && "Enter a full email address, like you@example.com."}
        {status === "idle" && (compact ? "" : "Stored only in this browser until signups open.")}
      </p>
    </form>
  );
}
