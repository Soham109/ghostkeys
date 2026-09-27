import type { Metadata } from "next";
import { SubPage } from "@/components/site/SubPage";
import { FaqAccordion } from "@/components/site/FaqAccordion";
import { faqItems } from "@/lib/guide";

export const metadata: Metadata = {
  title: "FAQ | Ghostkeys",
  description: "Typing, the internet, battery, calls, sleep, permissions and more.",
  alternates: { canonical: "/faq/" },
};

export default function FaqPage() {
  return (
    <SubPage label="FAQ" title={<>Asked <em>often.</em></>}>
      <div className="mt-[12svh] md:ml-[25%]">
        <FaqAccordion items={faqItems()} />
      </div>
    </SubPage>
  );
}
