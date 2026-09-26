// Captures the exported site with Playwright's Chromium (WebGL through ANGLE on Metal).
// Usage: pnpm build && node scripts/screenshots.mjs [--theme=light] [--only=a,b] [--w=1440 --h=900] [--prefix=x-] [--path=/details/] [--reduced]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const W = Number(args.w ?? 1440), H = Number(args.h ?? 900);
const theme = args.theme ?? "dark";
const only = args.only ? args.only.split(",") : null;
const prefix = args.prefix ?? "";
const path = args.path ?? "/";
const port = 4317 + Math.floor(Math.random() * 500);
const outDir = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const errors = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: Number(args.dpr ?? 1),
    colorScheme: theme === "light" ? "light" : "dark",
    reducedMotion: args.reduced ? "reduce" : "no-preference",
    isMobile: !!args.mobile,
    hasTouch: !!args.mobile,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}\n${(e.stack || "").split("\n").slice(0, 6).join("\n")}`));
  const url = `http://127.0.0.1:${port}${path}?tier=${args.tier ?? 3}${args.reduced ? "&reduced" : ""}${args.q ? "&" + args.q : ""}`;
  await page.goto(url, { waitUntil: "load" });
  const shot = async (name) => {
    if (only && !only.includes(name)) return;
    await page.screenshot({ path: `${outDir}${prefix}${name}.png` });
    console.log("saved", `${prefix}${name}.png`);
  };
  const scrollTo = async (y, wait = 2400) => {
    await page.evaluate((y) => window.__gkScroll(y), y);
    await page.waitForTimeout(wait);
  };

  if (path !== "/") {
    await page.waitForTimeout(1500);
    await shot("top");
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let i = 1; i * H * 0.9 < h; i++) {
      await scrollTo(i * H * 0.9, 900);
      await shot(`p${String(i).padStart(2, "0")}`);
    }
  } else if (args.reduced) {
    await page.waitForTimeout(2500);
    await shot("reduced-hero");
    await page.screenshot({ path: `${outDir}${prefix}reduced-full.png`, fullPage: true });
  } else {
    await page.waitForTimeout(Number(args.logo ?? 3300));
    await shot("01-intro-logo");
    await page.waitForTimeout(2000);
    await shot("02-intro-morph");
    await page.waitForTimeout(5000);
    await shot("03-hero");

    // chapters: [name, chapter id, fraction of the chapter's sticky range]
    const stops = [
      ["04-zones-a", "zones", 0.12], ["05-zones-b", "zones", 0.5], ["06-zones-c", "zones", 0.85],
      ["07-air", "air", 0.3], ["08-sound", "air", 0.8], ["09-layers", "layers", 0.5],
      ["10-try", "try", 0.5], ["11-finale", "finale", 1],
    ];
    const chapterY = (id, f) =>
      page.evaluate(([id, f]) => {
        const el = document.querySelector(`[data-chapter="${id}"]`);
        return el.getBoundingClientRect().top + scrollY + Math.max(0, el.offsetHeight - innerHeight) * f;
      }, [id, f]);
    for (const [name, id, f] of stops) {
      if (only && !only.includes(name)) continue;
      await scrollTo(await chapterY(id, f), 2600);
      await shot(name);
    }
    if (!only || only.includes("12b-try-click")) {
      await scrollTo(await chapterY("try", 0.5), 2500);
      const px = W * Number(args.cx ?? 0.72), py = H * Number(args.cy ?? 0.72);
      await page.mouse.move(px, py);
      await page.mouse.click(px, py);
      await page.waitForTimeout(110);
      await page.mouse.click(px, py);
      await page.waitForTimeout(800);
      await shot("12b-try-click");
    }
    const targets = [];
    for (const [name, sel, off] of targets) {
      if (only && !only.includes(name)) continue;
      const top = await page.evaluate(([sel, off]) => {
        const el = document.querySelector(sel);
        return el ? el.getBoundingClientRect().top + scrollY + off * innerHeight : null;
      }, [sel, off]);
      if (top === null) {
        console.log("missing", sel);
        continue;
      }
      await scrollTo(top, 2600);
      await shot(name);
    }
    if (false) {
      await page.evaluate(() => document.querySelector("#pricing button[aria-expanded]")?.click());
      await page.waitForTimeout(500);
      const top = await page.evaluate(() => document.querySelector("#pricing table").getBoundingClientRect().top + scrollY + 500);
      await scrollTo(top, 1500);
      await shot("22-matrix");
    }
  }
} finally {
  await browser.close();
  server.kill();
  if (errors.length) console.log("console:\n" + [...new Set(errors)].slice(0, 30).join("\n"));
}
