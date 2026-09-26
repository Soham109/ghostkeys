import type { Metadata } from "next";
import { Nav } from "@/components/site/Nav";
import { SmoothScroll } from "@/components/site/SmoothScroll";
import { Pricing } from "@/components/site/Pricing";
import { Head, PayingFaq } from "@/components/site/Info";
import { SubFooter } from "@/components/site/SubFooter";

export const metadata: Metadata = {
  title: "Pricing | Ghostkeys",
  description: "Free forever for the basics. Pro is a one-time purchase. Teams is per seat, per year.",
};

export default function PricingPage() {
  return (
    <>
      <SmoothScroll />
      <Nav />
      <main>
        <Pricing />
        <section className="page-x pb-[14svh]" aria-labelledby="paying-h">
          <Head id="paying" label="Paying" title={<span id="paying-h">Questions about paying.</span>} />
          <PayingFaq />
        </section>
      </main>
      <SubFooter />
    </>
  );
}
