import type { Metadata } from "next";
import { Nav } from "@/components/site/Nav";
import { SmoothScroll } from "@/components/site/SmoothScroll";
import { Experience } from "@/components/site/Experience";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function Page() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-bg"
      >
        Skip to content
      </a>
      <SmoothScroll />
      <Nav />
      <Experience />
    </>
  );
}
