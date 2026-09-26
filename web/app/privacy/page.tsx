import type { Metadata } from "next";
import { SubPage } from "@/components/site/SubPage";

export const metadata: Metadata = {
  title: "Privacy | Ghostkeys",
  description: "What Ghostkeys reads, what it never stores, and what it never does. Everything stays on your Mac.",
};

const COLS: { h: string; lines: string[]; detail: string }[] = [
  {
    h: "What it reads",
    lines: ["The motion sensor", "The lid angle", "The ambient light", "That a key was pressed, never which", "The name of the app in front"],
    detail: "Camera and microphone stay off unless you turn on the camera add-on or sound mode.",
  },
  {
    h: "What it never stores",
    lines: ["What you type", "Audio or video", "Anything outside one folder"],
    detail: "~/Library/Application Support/Ghostkeys holds your settings, your model and your calibration taps. Nothing else.",
  },
  {
    h: "What it never does",
    lines: ["Talk to the internet", "Ask for an admin password", "Install a kernel extension", "Change System Settings"],
    detail: "Sensor settings it adjusts are put back on quit. The app and its helper talk over 127.0.0.1 only.",
  },
];

export default function PrivacyPage() {
  return (
    <SubPage label="Privacy" title={<>Nothing leaves your <em>Mac.</em></>}>
      <div className="mt-[16svh] grid grid-cols-1 gap-y-14 md:grid-cols-3 md:gap-x-[var(--gutter)]">
        {COLS.map((c) => (
          <section key={c.h} className="border-t hairline pt-6" aria-label={c.h}>
            <h2 className="label !text-ink">{c.h}</h2>
            <ul className="mt-8 space-y-3">
              {c.lines.map((l) => (
                <li key={l} className="display text-[26px] leading-[1.2] text-ink">
                  {l}
                </li>
              ))}
            </ul>
            <p className="label mt-10 max-w-[36ch] !normal-case !tracking-[0.02em]">{c.detail}</p>
          </section>
        ))}
      </div>
      <p className="label mt-[12svh]">
        The detection core is open source.{" "}
        <a href="/guide/privacy-and-safety/" className="quiet-link !text-ink">
          Read the full privacy guide
        </a>
      </p>
    </SubPage>
  );
}
