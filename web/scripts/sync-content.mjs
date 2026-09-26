// Copies sources of truth into web/content so the site builds standalone:
// docs/pricing/features.json -> content/features.json, docs/guide/*.md -> content/guide/.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
const root = new URL("../../docs/", import.meta.url).pathname;
const out = new URL("../content/", import.meta.url).pathname;
if (existsSync(root + "pricing/features.json")) {
  copyFileSync(root + "pricing/features.json", out + "features.json");
  console.log("synced docs/pricing/features.json");
}
if (existsSync(root + "guide")) {
  rmSync(out + "guide", { recursive: true, force: true });
  mkdirSync(out + "guide", { recursive: true });
  const files = readdirSync(root + "guide").filter((f) => f.endsWith(".md"));
  for (const f of files) copyFileSync(root + "guide/" + f, out + "guide/" + f);
  console.log(`synced ${files.length} guide pages`);
}
