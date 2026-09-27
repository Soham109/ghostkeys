import type { MetadataRoute } from "next";
import { guideDocs } from "@/lib/guide";
import { SITE_ORIGIN } from "@/lib/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ["/", "/pricing/", "/faq/", "/guide/", "/compatibility/", "/privacy/", ...guideDocs().map((d) => `/guide/${d.slug}/`)];
  return pages.map((p) => ({ url: SITE_ORIGIN + p, priority: p === "/" ? 1 : p.startsWith("/guide/") && p !== "/guide/" ? 0.5 : 0.8 }));
}
