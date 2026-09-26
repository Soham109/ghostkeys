"use client";

import { useId, useState } from "react";
import { PRICING, type Cell, type Tier } from "@/lib/pricing";
import { PRICING_COPY } from "@/lib/pricing-copy";
import { BUY_URL, DOWNLOAD_URL, SALES_URL } from "@/lib/site";
import { SocialProof } from "./SocialProof";
import { FaqAccordion } from "./FaqAccordion";

const money = (n: number) => `$${n}`;

function billing(t: Tier) {
  if (t.billing === "free") return "Free, forever";
  if (t.billing === "one-time") return `Once. ${t.updatesMonths ?? 12} months of updates.`;
  if (t.billing === "per-seat-yearly") return `Per seat, per year. From ${t.minSeats ?? 1} seats.`;
  return t.billing;
}

/** The money page. Renders from content/features.json (synced from docs/pricing on every build). */
export function Pricing() {
  const [open, setOpen] = useState(false);
  const matrixId = useId();
  const tiers = PRICING.tiers;
  const pro = tiers.find((t) => t.id === "pro")!;
  const teams = tiers.find((t) => t.id === "teams")!;
  return (
    <main className="page-x pt-[24svh] pb-[10svh]">
      <span className="label">Pricing</span>
      <h1 className="display mt-8 text-[length:var(--t-line)] text-ink">
        Pay once.
        <br />
        <em>Keep it.</em>
      </h1>
      {pro.launchPrice && (
        <p className="lede mt-10 max-w-[56ch]">
          <span className="label mr-3 !text-ink">Launch</span>
          Pro is {money(pro.launchPrice)} for the first {pro.launchDays} days, and the first {pro.foundingSeats?.toLocaleString("en-US")} buyers also get{" "}
          {pro.foundingPerk?.replace(/^Lifetime/, "lifetime").replace(/, name/, ", their name").replace(/, a vote/, " and a vote")}.
        </p>
      )}

      {/* three tiers, set like an editorial comparison; Pro carries an ink rule and the only solid button */}
      <div id="tiers" className="mt-[16svh] grid scroll-mt-28 grid-cols-1 gap-y-16 md:grid-cols-3 md:gap-x-[var(--gutter)]">
        {tiers.map((t) => {
          const isPro = t.id === "pro";
          const bullets = (PRICING_COPY.bullets[t.id] ?? []).slice(0, isPro ? 5 : 3);
          return (
            <section key={t.id} aria-label={t.name} className={`flex flex-col border-t pt-7 ${isPro ? "border-ink" : "hairline"}`}>
              <h2 className="label !text-ink">{t.name}</h2>
              <p className="numeral mt-10 text-[length:var(--t-price)] text-ink">
                {money(t.price)}
                {isPro && <em className="ml-3 align-top text-[0.28em] tracking-normal text-ink-2">once</em>}
              </p>
              <p className="mt-5 text-[14px] text-ink-2">
                {billing(t)}
                {isPro && t.studentPrice && <> Students {money(t.studentPrice)}.</>}
              </p>
              <p className="display mt-10 max-w-[18ch] text-[26px] leading-[1.2] text-ink">{t.tagline}</p>
              <ul className="mt-8 flex-1 space-y-2.5">
                {bullets.map((b) => (
                  <li key={b} className="text-[14px] font-light leading-[1.5] text-ink-2">
                    {b}
                  </li>
                ))}
              </ul>
              <div className="mt-10">
                {t.id === "free" && (
                  <a href={DOWNLOAD_URL} className="quiet-link text-[15px]">
                    Download free
                  </a>
                )}
                {isPro && (
                  <a href={BUY_URL} className="btn-ink h-12 px-7 text-[15px]">
                    Buy Pro{t.launchPrice ? `, ${money(t.launchPrice)} at launch` : ""}
                  </a>
                )}
                {t.id === "teams" && (
                  <a href={SALES_URL} className="quiet-link text-[15px]">
                    Talk to us
                  </a>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <p className="label mt-20 max-w-[120ch] leading-[1.9]">
        Refunds within 30 days / After a year, keep your version or renew updates for {money(pro.renewalPrice ?? 15)} / Lifetime updates{" "}
        {money(pro.lifetimeUpdatesPrice ?? 59)} at checkout / Teams {teams.volumeDiscount?.percentOff ?? 20} percent off from{" "}
        {teams.volumeDiscount?.fromSeats ?? 25} seats
      </p>

      <SocialProof />

      <div className="mt-[14svh]">
        <button aria-expanded={open} aria-controls={matrixId} onClick={() => setOpen((o) => !o)} className="group flex w-full items-baseline justify-between border-y hairline py-7 text-left">
          <span className="display text-[length:var(--t-big)] text-ink">{open ? "Close the comparison" : <>Every feature, <em>side by side.</em></>}</span>
          <span aria-hidden className="label text-[16px] transition-transform duration-300 group-aria-expanded:rotate-45">
            +
          </span>
        </button>
        <div id={matrixId} hidden={!open}>
          <Matrix />
        </div>
      </div>

      <section id="paying" aria-labelledby="paying-h" className="mt-[14svh] grid scroll-mt-28 grid-cols-1 gap-y-10 md:grid-cols-12 md:gap-x-[var(--gutter)]">
        <h2 id="paying-h" className="display text-[length:var(--t-big)] text-ink md:col-span-4">
          About <em>paying.</em>
        </h2>
        <div className="md:col-span-7 md:col-start-6">
          <FaqAccordion items={PRICING_COPY.faq} />
        </div>
      </section>
    </main>
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
