// The site ships as a static folder: `vercel deploy` run on out/ only reads a vercel.json that sits inside out/.
// web/vercel.json stays the source of truth (it also applies when web/ itself is the deployed root); this copies it.
import { copyFileSync, existsSync } from "node:fs";
const src = new URL("../vercel.json", import.meta.url).pathname;
const dst = new URL("../out/vercel.json", import.meta.url).pathname;
if (existsSync(src) && existsSync(new URL("../out/", import.meta.url).pathname)) {
  copyFileSync(src, dst);
  console.log("copied vercel.json into out/");
}
