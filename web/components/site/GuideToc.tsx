"use client";

import { useEffect, useRef } from "react";

/** Sticky mini contents for a guide page. The current section is marked by toggling a data attribute, not React state. */
export function GuideToc({ items }: { items: { id: string; text: string }[] }) {
  const list = useRef<HTMLOListElement>(null!);
  useEffect(() => {
    let raf = 0;
    if (!items.length) return;
    const update = () => {
      if (!list.current) return;
      const line = window.innerHeight * 0.3;
      let current = items[0]?.id;
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (el && el.getBoundingClientRect().top <= line) current = it.id;
      }
      list.current.querySelectorAll("a").forEach((a) => a.toggleAttribute("data-on", a.getAttribute("href") === `#${current}`));
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, [items]);
  if (!items.length) return null;
  return (
    <ol ref={list} className="mt-8 hidden flex-col gap-3 border-l hairline md:flex" aria-label="On this page">
      {items.map((it) => (
        <li key={it.id}>
          <a
            href={`#${it.id}`}
            className="-ml-px block border-l border-transparent pl-4 text-[13px] leading-[1.4] text-ink-3 transition-colors duration-200 hover:text-ink data-[on]:border-ink data-[on]:text-ink"
          >
            {it.text}
          </a>
        </li>
      ))}
    </ol>
  );
}
