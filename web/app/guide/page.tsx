import type { Metadata } from "next";
import { SubPage } from "@/components/site/SubPage";
import { guideDocs } from "@/lib/guide";

export const metadata: Metadata = {
  title: "Guide | Ghostkeys",
  description: "How Ghostkeys works: calibration, zones, gestures, actions, sound mode, the camera add-on, privacy and troubleshooting.",
  alternates: { canonical: "/guide/" },
};

export default function GuideIndex() {
  const docs = guideDocs();
  return (
    <SubPage label="Guide" title={<>How it <em>works.</em></>}>
      <ol className="mt-[14svh] md:ml-[25%]">
        {docs.map((d, i) => (
          <li key={d.slug} className="border-t hairline last:border-b">
            <a href={`/guide/${d.slug}/`} className="group grid grid-cols-[3rem_1fr] items-baseline gap-y-1 py-5 md:grid-cols-[4rem_1fr_1.2fr]">
              <span className="label tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-[19px] text-ink transition-transform duration-500 ease-[var(--ease-out)] group-hover:translate-x-1.5">{d.title}</span>
              <span className="col-start-2 text-[14px] font-light text-ink-2 md:col-start-3">{d.description}</span>
            </a>
          </li>
        ))}
      </ol>
    </SubPage>
  );
}
