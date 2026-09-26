import type { Metadata } from "next";
import { SubPage } from "@/components/site/SubPage";
import { CompatTable, Head, WindowsWaitlist } from "@/components/site/Info";

export const metadata: Metadata = {
  title: "Compatibility | Ghostkeys",
  description: "Which MacBooks Ghostkeys supports, what works on each, and the Windows waitlist.",
};

export default function CompatibilityPage() {
  return (
    <SubPage label="Compatibility" title={<>Which MacBooks feel a <em>tap.</em></>}>
      <CompatTable />
      <section className="mt-[16svh]" aria-labelledby="windows-h">
        <Head id="windows" label="Windows" title={<span id="windows-h">Windows is next.</span>} />
        <WindowsWaitlist />
      </section>
    </SubPage>
  );
}
