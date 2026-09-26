import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";

/** Guide pages, read at build time from content/guide (synced from docs/guide). Server only. */
export type GuideDoc = { slug: string; file: string; order: number; title: string; description: string; html: string; toc: { id: string; text: string }[] };

const DIR = join(process.cwd(), "content", "guide");
const slugOf = (file: string) => file.replace(/^\d+-/, "").replace(/\.md$/, "");
const idOf = (text: string) => text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function parse(file: string): GuideDoc {
  const raw = readFileSync(join(DIR, file), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m ? raw.slice(m[0].length) : raw;
  const toc: GuideDoc["toc"] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = idOf(text);
        if (depth === 2) toc.push({ id, text: text.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        // links between guide pages: 02-calibration.md -> /guide/calibration/
        const local = href.match(/^(\d+-[\w-]+)\.md(#.*)?$/);
        if (local) return `<a href="/guide/${slugOf(local[1] + ".md")}/${local[2] ?? ""}">${text}</a>`;
        const ext = /^https?:/.test(href);
        return `<a href="${href}"${ext ? ' rel="noopener" target="_blank"' : ""}>${text}</a>`;
      },
      table(token) {
        const head = token.header.map((c) => `<th scope="col">${this.parser.parseInline(c.tokens)}</th>`).join("");
        const rows = token.rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${this.parser.parseInline(c.tokens)}</th>` : `<td>${this.parser.parseInline(c.tokens)}</td>`)).join("")}</tr>`).join("");
        return `<div class="table-wrap" data-lenis-prevent><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
      },
    },
  });
  const html = marked.parse(body) as string;
  return { slug: slugOf(file), file, order: Number(meta.order ?? 99), title: meta.title ?? slugOf(file), description: meta.description ?? "", html, toc };
}

let cache: GuideDoc[] | null = null;
export function guideDocs(): GuideDoc[] {
  if (!cache) cache = readdirSync(DIR).filter((f) => f.endsWith(".md")).map(parse).sort((a, b) => a.order - b.order);
  return cache;
}

/** Question and answer pairs from the guide's FAQ page (bold question line, answer paragraph). */
export function faqItems(): { q: string; a: string }[] {
  const raw = readFileSync(join(DIR, "12-faq.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const inline = new Marked({
    renderer: {
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        const local = href.match(/^(\d+-[\w-]+)\.md(#.*)?$/);
        return `<a href="${local ? `/guide/${slugOf(local[1] + ".md")}/${local[2] ?? ""}` : href}">${text}</a>`;
      },
    },
  });
  const items: { q: string; a: string }[] = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const m = block.trim().match(/^\*\*(.+?)\*\*\s*\n([\s\S]+)$/);
    if (!m) continue;
    let a = inline.parseInline(m[2].trim()) as string;
    if (/paid tier|license/i.test(m[1])) a = 'Free forever for the basics, Pro is a one-time purchase. See <a href="/pricing/">pricing</a>.';
    items.push({ q: m[1], a });
  }
  return items;
}
