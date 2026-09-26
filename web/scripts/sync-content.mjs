// Copies the pricing source of truth (docs/pricing/features.json) into web/content so the site builds standalone.
import { copyFileSync, existsSync } from "node:fs";
const src = new URL("../../docs/pricing/features.json", import.meta.url).pathname;
const dst = new URL("../content/features.json", import.meta.url).pathname;
if (existsSync(src)) {
  copyFileSync(src, dst);
  console.log("synced docs/pricing/features.json -> web/content/features.json");
} else console.log("docs/pricing/features.json not found; keeping web/content/features.json");
