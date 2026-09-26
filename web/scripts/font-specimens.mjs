// Renders the real landing hero and the zones headline with alternative display faces (no site change).
// Usage: node scripts/font-specimens.mjs <fontDir>   -> screenshots/fonts-v2-{A,B,C}.png (2560 wide, dark)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const dir = process.argv[2];
const OPTIONS = {
  A: {
    name: "A  General Sans 500, tight",
    faces: [["GS", "GeneralSans-500.woff2", 500, "normal"], ["GS", "GeneralSans-500i.woff2", 500, "italic"]],
    css: `.display{font-family:GS,sans-serif!important;font-weight:500!important;letter-spacing:-0.045em!important;line-height:0.95!important}.display em,.display i{font-style:normal!important;color:var(--ink-2)}`,
  },
  B: {
    name: "B  Switzer 200 display, light italic accent",
    faces: [["SWD", "Switzer-200.woff2", 200, "normal"], ["SWD", "Switzer-300i.woff2", 300, "italic"]],
    css: `.display{font-family:SWD,sans-serif!important;font-weight:200!important;letter-spacing:-0.04em!important;line-height:0.98!important}.display em,.display i{font-style:italic!important;font-weight:300!important}`,
  },
  C: {
    name: "C  Fraunces 300, SOFT 0, WONK 0, high optical size",
    faces: [["FR", "package/files/fraunces-latin-full-normal.woff2", "100 900", "normal"], ["FR", "package/files/fraunces-latin-full-italic.woff2", "100 900", "italic"]],
    css: `.display{font-family:FR,serif!important;font-weight:300!important;letter-spacing:-0.025em!important;line-height:0.98!important;font-variation-settings:"opsz" 144,"SOFT" 0,"WONK" 0!important}.display em,.display i{font-variation-settings:"opsz" 144,"SOFT" 0,"WONK" 0!important}`,
  },
};

const port = 5400 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
for (const [key, o] of Object.entries(OPTIONS)) {
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 }, colorScheme: "dark" });
  await page.route("**/__spec/**", (r) => r.fulfill({ body: readFileSync(dir + "/" + decodeURIComponent(r.request().url().split("/__spec/")[1])), contentType: "font/woff2" }));
  const faces = o.faces.map(([f, file, w, st]) => `@font-face{font-family:${f};src:url(/__spec/${encodeURIComponent(file)}) format("woff2");font-weight:${w};font-style:${st}}`).join("");
  await page.addInitScript((css) => {
    const add = () => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
    if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
  }, faces + o.css);
  await page.goto(`http://127.0.0.1:${port}/?tier=3`);
  await page.waitForTimeout(10000);
  const a = await page.screenshot();
  const y = await page.evaluate(() => { const el = document.querySelector('[data-chapter="zones"]'); return el.getBoundingClientRect().top + scrollY + (el.offsetHeight - innerHeight) * 0.3; });
  await page.evaluate((y) => window.__gkScroll(y), y);
  await page.waitForTimeout(3000);
  const b = await page.screenshot();
  const label = Buffer.from(`<svg width="2560" height="90"><rect width="100%" height="100%" fill="#0a0a0b"/><text x="80" y="58" font-family="Menlo" font-size="30" fill="#8a8a90">${o.name}</text></svg>`);
  await sharp({ create: { width: 2560, height: 2970, channels: 3, background: "#0a0a0b" } })
    .composite([{ input: label, top: 0, left: 0 }, { input: a, top: 90, left: 0 }, { input: b, top: 1530, left: 0 }])
    .png().toFile(new URL(`../screenshots/fonts-v2-${key}.png`, import.meta.url).pathname);
  console.log("saved fonts-v2-" + key);
  await page.close();
}
await browser.close();
server.kill();
