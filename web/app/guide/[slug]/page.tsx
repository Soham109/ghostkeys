import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Nav } from "@/components/site/Nav";
import { SmoothScroll } from "@/components/site/SmoothScroll";
import { SubFooter } from "@/components/site/SubFooter";
import { GuideToc } from "@/components/site/GuideToc";
import { guideDocs } from "@/lib/guide";

export function generateStaticParams() {
  return guideDocs().map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const d = guideDocs().find((x) => x.slug === slug);
  return d ? { title: `${d.title} | Ghostkeys guide`, description: d.description } : {};
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const docs = guideDocs();
  const i = docs.findIndex((d) => d.slug === slug);
  if (i < 0) notFound();
  const d = docs[i];
  const prev = docs[i - 1];
  const next = docs[i + 1];
  return (
    <>
      <SmoothScroll />
      <Nav />
      <main className="page-x pt-[22svh] pb-[12svh]">
        <div className="grid grid-cols-1 gap-y-10 md:grid-cols-12 md:gap-x-[var(--gutter)]">
          <aside className="md:col-span-3">
            <div className="md:sticky md:top-28">
              <a href="/guide/" className="label hover:!text-ink">
                Guide / {String(i + 1).padStart(2, "0")}
              </a>
              <GuideToc items={d.toc} />
            </div>
          </aside>
          <article className="md:col-span-7 md:col-start-5">
            <h1 className="display text-[length:var(--t-big)] text-ink">{d.title}</h1>
            <p className="lede mt-6 max-w-[48ch]">{d.description}</p>
            <div className="prose-gk mt-14" dangerouslySetInnerHTML={{ __html: d.html }} />
            <nav aria-label="Guide pages" className="mt-24 grid grid-cols-2 gap-6 border-t hairline pt-6">
              {prev ? (
                <a href={`/guide/${prev.slug}/`} className="group">
                  <span className="label">Previous</span>
                  <span className="mt-2 block text-[17px] text-ink">{prev.title}</span>
                </a>
              ) : (
                <span />
              )}
              {next && (
                <a href={`/guide/${next.slug}/`} className="group text-right">
                  <span className="label">Next</span>
                  <span className="mt-2 block text-[17px] text-ink">{next.title}</span>
                </a>
              )}
            </nav>
          </article>
        </div>
      </main>
      <SubFooter />
    </>
  );
}
