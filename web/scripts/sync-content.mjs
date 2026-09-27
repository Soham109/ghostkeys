// Copies sources of truth into web/content so the site builds standalone:
// docs/pricing/features.json -> content/features.json, docs/guide/*.md -> content/guide/.
// Never deletes, and never overwrites a web copy that is newer than the docs copy (web/content has been edited
// ahead of docs/ before). Finder or iCloud conflict copies ("name 2.md", "name 3.md") are skipped here and
// rejected by lib/guide.ts, so they can never become pages.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
const root = new URL("../../docs/", import.meta.url).pathname;
const out = new URL("../content/", import.meta.url).pathname;
const CONFLICT = / \d+\.[a-z]+$/i;
const newer = (src, dst) => !existsSync(dst) || statSync(src).mtimeMs > statSync(dst).mtimeMs;
if (existsSync(root + "pricing/features.json") && newer(root + "pricing/features.json", out + "features.json")) {
  copyFileSync(root + "pricing/features.json", out + "features.json");
  console.log("synced docs/pricing/features.json");
}
if (existsSync(root + "guide")) {
  mkdirSync(out + "guide", { recursive: true });
  const files = readdirSync(root + "guide").filter((f) => f.endsWith(".md") && !CONFLICT.test(f));
  let n = 0;
  for (const f of files) {
    if (!newer(root + "guide/" + f, out + "guide/" + f)) continue;
    copyFileSync(root + "guide/" + f, out + "guide/" + f);
    n++;
  }
  console.log(`synced ${n} of ${files.length} guide pages (web copies newer than docs are kept)`);
}
