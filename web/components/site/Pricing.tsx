"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PRICING, type Cell, type Tier } from "@/lib/pricing";
import { PRICING_COPY } from "@/lib/pricing-copy";
import { BUY_URL, DOWNLOAD_URL, SALES_URL } from "@/lib/site";
import { SocialProof } from "./SocialProof";

const money = (n: number) => `$${n}`;

function billing(t: Tier) {
  if (t.billing === "free") return "Free forever";
  if (t.billing === "one-time") return `Once, with ${t.updatesMonths ?? 12} months of updates`;
  if (t.billing === "per-seat-yearly") return `Per seat, per year. ${t.minSeats ?? 1} seat minimum`;
  return t.billing;
}

/** Pricing renders from content/features.json (synced from docs/pricing). Opaque, so the canvas rests behind it. */
export function Pricing() {
  const [open, setOpen] = useState(false);
  const matrixId = useId();
  const tiers = PRICING.tiers;
  const pro = tiers.find((t) => t.id === "pro")!;
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="relative bg-bg pt-[24svh] pb-[12svh]">
      <div className="page-x grid grid-cols-1 gap-y-16 md:grid-cols-12 md:gap-x-[var(--gutter)]">
        <div className="md:col-span-7">
          <span className="label">Pricing</span>
          <h1 id="pricing-title" className="display mt-8 text-[length:var(--t-line)] text-ink">
            Pay once.
            <br />
            <em>Keep it.</em>
          </h1>
          {pro.launchPrice && (
            <p className="mt-10 max-w-[44ch] text-[length:var(--t-20)] font-light leading-[1.5] text-ink-2">
              <span className="text-ink">
                Launch offer: Pro is {money(pro.launchPrice)} for the first {pro.launchDays} days.
              </span>{" "}
              The first {pro.foundingSeats?.toLocaleString("en-US")} buyers also get {pro.foundingPerk?.toLowerCase()}.
            </p>
          )}
        </div>
        <Teaser />
      </div>

      {/* tiers: columns split by hairlines; Pro sits on a quiet raised ground so its value reads first */}
      <div className="page-x mt-24">
        <div className="grid grid-cols-1 border-t hairline md:grid-cols-3">
          {tiers.map((t, i) => (
            <div
              key={t.id}
              className={`flex flex-col pt-8 pb-10 md:px-8 ${i > 0 ? "border-t md:border-t-0 md:border-l hairline" : "md:pl-0"} ${t.id === "pro" ? "md:bg-bg-raised" : ""}`}
            >
              <div className="flex items-baseline justify-between">
                <h3 className="label !text-ink">{t.name}</h3>
                {t.id === "pro" && t.launchPrice && <span className="label">{money(t.launchPrice)} at launch</span>}
              </div>
              <div className="numeral mt-10 text-[length:var(--t-price)] text-ink">{money(t.price)}</div>
              <p className="mt-4 text-[14px] text-ink-2">{billing(t)}</p>
              <p className="mt-8 max-w-[28ch] text-[17px] font-light leading-[1.45] text-ink">{t.tagline}</p>
              <ul className="mt-8 flex-1 border-t hairline">
                {(PRICING_COPY.bullets[t.id] ?? []).map((b) => (
                  <li key={b} className="border-b hairline py-3 text-[14px] leading-[1.45] text-ink-2">
                    {b}
                  </li>
                ))}
              </ul>
              <div className="mt-10">
                {t.id === "free" && (
                  <a href={DOWNLOAD_URL} className="btn-ink h-12 px-7 text-[15px]">
                    Download free
                  </a>
                )}
                {t.id === "pro" && (
                  <a href={BUY_URL} className="quiet-link text-[15px]">
                    Buy Pro for {money(t.launchPrice ?? t.price)}
                  </a>
                )}
                {t.id === "teams" && (
                  <a href={SALES_URL} className="quiet-link text-[15px]">
                    Talk to us
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-6 border-t hairline pt-6 md:grid-cols-4">
          {[
            ["Students", `Pro for ${money(pro.studentPrice ?? 15)} with a school email`],
            ["Updates", `After a year, keep your version, or renew for ${money(pro.renewalPrice ?? 15)}`],
            ["Lifetime updates", `${money(pro.lifetimeUpdatesPrice ?? 59)} once, at checkout`],
            ["Refunds", "Within 30 days, no questions"],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="label">{k}</dt>
              <dd className="mt-2 max-w-[30ch] text-[14px] text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>

        <SocialProof />

        <button
          aria-expanded={open}
          aria-controls={matrixId}
          onClick={() => setOpen((o) => !o)}
          className="mt-20 flex w-full items-baseline justify-between border-y hairline py-6 text-left"
        >
          <span className="display text-[length:var(--t-big)] text-ink">{open ? "Close the comparison" : "Compare every feature"}</span>
          <span className="label">{open ? "Close" : "Open"}</span>
        </button>
        <div id={matrixId} hidden={!open}>
          <Matrix />
        </div>
        <p className="mt-10 text-[14px] text-ink-2">
          Questions about paying?{" "}
          <a href="#paying" className="quiet-link text-ink">
            Read the answers
          </a>
        </p>
      </div>
    </section>
  );
}

/** Ten seconds of the product, muted and looping, loaded only when it comes into view. */
function Teaser() {
  const ref = useRef<HTMLVideoElement>(null!);
  useEffect(() => {
    const v = ref.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !reduced) {
        if (!v.getAttribute("src")) v.src = "/video/teaser-540.mp4";
        v.play().catch(() => {});
      } else v.pause();
    });
    io.observe(v);
    return () => io.disconnect();
  }, []);
  return (
    <figure className="md:col-span-3 md:col-start-10 md:justify-self-end">
      <video
        ref={ref}
        muted
        loop
        playsInline
        preload="none"
        poster="/video/teaser-poster.jpg"
        className="aspect-[9/16] w-[200px] rounded-[6px] bg-bg-raised object-cover md:w-[220px]"
        aria-label="Ten second product teaser, no sound"
      />
      <figcaption className="label mt-3">Ten seconds, no sound</figcaption>
    </figure>
  );
}

function CellView({ v }: { v: Cell }) {
  if (v === true)
    return (
      <span className="inline-flex items-center">
        <span aria-hidden className="inline-block size-[6px] rounded-full bg-ink" />
        <span className="sr-only">Included</span>
      </span>
    );
  if (v === false || v === "") return <span className="sr-only">Not included</span>;
  return <span className="text-ink">{v}</span>;
}

function Matrix() {
  return (
    <div className="overflow-x-auto" data-lenis-prevent>
      <table className="w-full min-w-[640px] border-collapse text-left">
        <caption className="sr-only">Every feature by plan</caption>
        <thead className="sticky top-[76px] z-10 bg-bg">
          <tr className="border-b hairline">
            <th scope="col" className="label w-[55%] py-4 font-normal">
              Feature
            </th>
            {PRICING.tiers.map((t) => (
              <th key={t.id} scope="col" className={`w-[15%] py-4 pl-3 font-normal ${t.id === "pro" ? "bg-bg-raised" : ""}`}>
                <span className="label !text-ink">{t.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        {PRICING.groups.map((g) => (
          <tbody key={g.name}>
            <tr>
              <th colSpan={4} scope="colgroup" className="label pt-10 pb-3 text-left font-normal !text-ink">
                {g.name}
              </th>
            </tr>
            {g.features.map((f) => (
              <tr key={f.id} className="border-t hairline align-top">
                <th scope="row" className="py-4 pr-6 font-normal">
                  <span className="text-[15px] text-ink">{f.title}</span>
                  {f.badge && <span className="label ml-2">{f.badge === "beta" ? "Beta" : "Soon"}</span>}
                  <span className="mt-1 block max-w-[52ch] text-[13px] leading-[1.45] text-ink-3">{f.description}</span>
                </th>
                <td className="py-4 pl-3 text-[14px]">
                  <CellView v={f.free} />
                </td>
                <td className="bg-bg-raised py-4 pl-3 text-[14px]">
                  <CellView v={f.pro} />
                </td>
                <td className="py-4 pl-3 text-[14px]">
                  <CellView v={f.teams} />
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
