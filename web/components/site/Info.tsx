"use client";

import * as Accordion from "@radix-ui/react-accordion";
import { PRICING_COPY } from "@/lib/pricing-copy";
import { SOURCE_URL } from "@/lib/site";
import { Waitlist } from "./Waitlist";

const PRIVACY = [
  { t: "Everything happens on your Mac.", d: "Detection, calibration and every action run on the laptop in front of you." },
  { t: "No network, no telemetry, no account.", d: "Ghostkeys never talks to a server while you use it. Activating Pro makes at most one request, or none if you drop in the license file." },
  { t: "No microphone or camera unless you ask.", d: "Sound mode and the camera add-on are off by default. Turn them on and they still process on your Mac. Nothing is recorded." },
  { t: "It never reads what you type.", d: "It asks one question of the sensor: did a tap on the case just happen?" },
  { t: "The detection core is open source.", d: "Read the code that decides what counts as a tap and what gets ignored." },
  { t: "It leaves your Mac as it found it.", d: "No kernel extension, no admin password, no changes to System Settings. Sensor settings it adjusts are put back when it quits." },
];

const COMPAT: { mac: string; note: string; cells: [string, string, string, string] }[] = [
  { mac: "M1 Pro, M1 Max, and M2 or newer", note: "MacBook Pro and MacBook Air", cells: ["Yes", "Yes", "Yes", "No"] },
  { mac: "M4 and M5", note: "Everything above, plus the camera", cells: ["Yes", "Yes", "Yes", "Optional, beta"] },
  { mac: "Base M1, and Intel", note: "Light sensor gestures only", cells: ["No", "No", "Yes", "No"] },
  { mac: "Windows laptops", note: "Same license when it ships", cells: ["Later", "Later", "Later", "Later"] },
];

const FAQ = [
  { q: "Will typing set it off?", a: "No. Calibration learns what your typing and trackpad use feel like, and those never fire a binding. Neither do bumps, like setting down a mug." },
  { q: "Does it work on my lap?", a: "Taps travel differently through a desk than through a lap. Calibrate where you use it most, and recalibrate from the menu bar whenever you move." },
  { q: "What permissions does it need?", a: "Accessibility, so it can press keys for you. Nothing else, unless you turn on sound mode (microphone) or the camera add-on (camera)." },
  { q: "Is it safe for my Mac?", a: "It installs no kernel extension, never asks for your admin password and never changes System Settings. The sensor settings it adjusts are restored when it quits, and reset on restart anyway." },
  { q: "Can I pause it?", a: "Yes. One click in the menu bar pauses everything, and nothing fires while it is paused." },
  { q: "Is the detection code open source?", a: "Yes. The part that turns sensor readings into taps is open, so you can check what it reads and what it ignores." },
  { q: "When is Windows coming?", a: "Later. Your license covers it when it ships. The compatibility page has a waitlist." },
];

export function Head({ id, label, title }: { id: string; label: string; title: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-28 grid grid-cols-1 gap-y-6 md:grid-cols-12 md:gap-x-[var(--gutter)]">
      <span className="label md:col-span-3 md:pt-4">{label}</span>
      <h2 className="display md:col-span-9 text-[length:var(--t-big)] text-ink">{title}</h2>
    </div>
  );
}

export function PrivacyList() {
  return (
    <ol className="mt-14 md:ml-[25%]">
      {PRIVACY.map((p, i) => (
        <li key={p.t} className="grid grid-cols-[3rem_1fr] gap-y-2 border-t hairline py-7 md:grid-cols-[4rem_1fr_1fr]">
          <span className="label !text-ink pt-1 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
          <h3 className="text-[19px] font-normal leading-[1.3] text-ink md:pr-10">{p.t}</h3>
          <p className="col-start-2 max-w-[46ch] text-[15px] font-light text-ink-2 md:col-start-3">
            {p.d}
            {i === 4 && (
              <>
                {" "}
                <a href={SOURCE_URL} className="quiet-link text-ink">
                  View the source
                </a>
              </>
            )}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function CompatTable() {
  return (
    <div className="mt-14 overflow-x-auto md:ml-[25%]" data-lenis-prevent>
      <table className="w-full min-w-[620px] text-left">
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
      <p className="mt-5 text-[13px] text-ink-3">Apple menu, then About This Mac, shows your chip. macOS 14 or later.</p>
    </div>
  );
}

export function FaqList() {
  return (
    <Accordion.Root type="multiple" className="mt-14 md:ml-[25%]">
      {FAQ.map((f, i) => (
        <Accordion.Item key={f.q} value={`q${i}`} className="border-t hairline last:border-b">
          <Accordion.Header>
            <Accordion.Trigger className="group flex w-full items-baseline gap-6 py-6 text-left">
              <span className="label w-8 shrink-0 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <span className="flex-1 text-[19px] leading-[1.3] text-ink">{f.q}</span>
              <span aria-hidden className="label text-[16px] transition-transform duration-300 group-data-[state=open]:rotate-45">
                +
              </span>
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content className="overflow-hidden data-[state=closed]:animate-[acc-up_280ms_var(--ease-snap)] data-[state=open]:animate-[acc-down_280ms_var(--ease-snap)]">
            <p className="max-w-[60ch] pb-7 pl-14 text-[16px] font-light leading-[1.55] text-ink-2">{f.a}</p>
          </Accordion.Content>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}

export function PayingFaq() {
  return (
    <dl className="mt-14 grid grid-cols-1 gap-x-10 md:ml-[25%] md:grid-cols-2">
      {PRICING_COPY.faq.map((f) => (
        <div key={f.q} className="border-t hairline py-6">
          <dt className="text-[17px] text-ink">{f.q}</dt>
          <dd className="mt-2 max-w-[44ch] text-[15px] font-light text-ink-2">{f.a}</dd>
        </div>
      ))}
    </dl>
  );
}

export function WindowsWaitlist() {
  return (
    <div className="mt-14 md:ml-[25%]">
      <Waitlist />
    </div>
  );
}
