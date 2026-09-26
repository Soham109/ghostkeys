"use client";

import { Waitlist } from "./Waitlist";


const COMPAT: { mac: string; note: string; cells: [string, string, string, string] }[] = [
  { mac: "M1 Pro, M1 Max, M2 and later", note: "MacBook Pro and MacBook Air. Every zone, every gesture.", cells: ["Yes", "Yes", "Yes", "No"] },
  { mac: "M4 and M5", note: "Everything above, plus the camera", cells: ["Yes", "Yes", "Yes", "Optional, in development"] },
  { mac: "Base M1", note: "2020 Air and 13-inch Pro. No motion sensor for taps.", cells: ["No", "No", "Yes", "No"] },
  { mac: "Intel MacBooks", note: "No streaming motion sensor", cells: ["No", "No", "No", "No"] },
  { mac: "Windows laptops", note: "Planned", cells: ["Later", "Later", "Later", "Later"] },
];


export function Head({ id, label, title }: { id: string; label: string; title: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-28 grid grid-cols-1 gap-y-6 md:grid-cols-12 md:gap-x-[var(--gutter)]">
      <span className="label md:col-span-3 md:pt-4">{label}</span>
      <h2 className="display md:col-span-9 text-[length:var(--t-big)] text-ink">{title}</h2>
    </div>
  );
}

export function CompatTable() {
  return (
    <div className="mt-14 md:ml-[25%]">
      {/* phones: one block per Mac */}
      <ul className="md:hidden">
        {COMPAT.map((r) => (
          <li key={r.mac} className="border-t hairline py-5">
            <p className="text-[17px] text-ink">{r.mac}</p>
            <p className="mt-1 text-[13px] text-ink-3">{r.note}</p>
            <dl className="mt-4 grid grid-cols-2 gap-y-2">
              {["Taps and zones", "Lid and tilt", "Light sensor", "Camera add-on"].map((c, i) => (
                <div key={c} className="contents">
                  <dt className="label">{c}</dt>
                  <dd className={`text-[14px] ${r.cells[i] === "No" ? "text-ink-3" : "text-ink"}`}>{r.cells[i]}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <table className="hidden w-full text-left md:table">
        <caption className="sr-only">Supported MacBooks and what works on each</caption>
        <thead>
          <tr className="border-b hairline">
            <th scope="col" className="label w-[34%] py-3 font-normal">
              Chip
            </th>
            {["Taps and zones", "Lid and tilt", "Light sensor", "Camera add-on"].map((c) => (
              <th key={c} scope="col" className="label py-3 font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPAT.map((r) => (
            <tr key={r.mac} className="border-b hairline">
              <th scope="row" className="py-5 pr-6 align-top font-normal">
                <span className="block text-[17px] text-ink">{r.mac}</span>
                <span className="mt-1 block text-[13px] text-ink-3">{r.note}</span>
              </th>
              {r.cells.map((c, i) => (
                <td key={i} className={`py-5 pr-4 align-top text-[15px] ${c === "No" ? "text-ink-3" : "text-ink"}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-5 border-t hairline pt-5 text-[13px] text-ink-3 md:border-0 md:pt-0">Apple menu, then About This Mac, shows your chip. macOS 14 or later.</p>
    </div>
  );
}

export function WindowsWaitlist() {
  return (
    <div className="mt-14 md:ml-[25%]">
      <Waitlist />
    </div>
  );
}
