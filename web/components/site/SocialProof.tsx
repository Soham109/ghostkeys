"use client";

import { useEffect, useState } from "react";

/**
 * TODO(launch): real social proof only. Add quotes with a name and a source link once they exist.
 * No fake testimonials and no invented numbers. While the list is empty, nothing renders in production;
 * with ?todo in the URL a dashed placeholder shows where the block will sit.
 */
const QUOTES: { quote: string; name: string; source: string; href?: string }[] = [];

export function SocialProof() {
  const [showTodo, setShowTodo] = useState(false);
  useEffect(() => setShowTodo(new URLSearchParams(location.search).has("todo")), []);
  if (QUOTES.length === 0) {
    if (!showTodo) return null;
    return (
      <div className="mt-16 border border-dashed hairline p-8">
        <span className="label">TODO: social proof (real quotes only)</span>
      </div>
    );
  }
  return (
    <ul className="mt-16 grid grid-cols-1 border-t hairline md:grid-cols-3">
      {QUOTES.map((q) => (
        <li key={q.name} className="py-8 md:pr-8">
          <blockquote className="display text-[28px] leading-[1.2] text-ink">{q.quote}</blockquote>
          <p className="label mt-4">
            {q.href ? <a href={q.href}>{q.name}, {q.source}</a> : `${q.name}, ${q.source}`}
          </p>
        </li>
      ))}
    </ul>
  );
}
